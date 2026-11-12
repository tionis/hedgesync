/**
 * macro: expand triggers in a note, once or continuously.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MacroEngine } from '../../macro-engine.js';
import { renderShellTemplate, runShell, type ShellCommand } from '../../shell.js';
import { expandReplacement } from '../../replace.js';
import { connectionOptions, type Command, type Context } from '../context.js';
import { helpText } from '../help-text.js';
import { c, eprint, print } from '../ui.js';

export const macro: Command = {
  name: 'macro',
  summary: 'Run macros on document (expand triggers)',
  options: [
    ...connectionOptions,
    { name: 'text', short: 't', type: 'multi' },
    { name: 'regex', short: 'r', type: 'multi' },
    { name: 'exec', short: 'e', type: 'multi' },
    { name: 'block', short: 'B', type: 'multi' },
    { name: 'built-in', short: 'b', type: 'flag' },
    { name: 'config', short: 'C', type: 'value' },
    { name: 'watch', short: 'w', type: 'flag' },
    { name: 'stream', short: 's', type: 'flag' },
    { name: 'track-state', short: 'T', type: 'flag' },
    { name: 'user-filter', short: 'U', type: 'value' },
    { name: 'allow-user', type: 'multi' },
    { name: 'section-heading', type: 'value' },
    { name: 'section-lines', type: 'value' },
    { name: 'section-regex', type: 'value' },
    { name: 'timeout', type: 'value' },
  ],
  help: helpText.macro,
  run: runMacro,
};

async function runMacro(ctx: Context): Promise<void> {
  const args = ctx.args;
  const client = await ctx.connect(0);
  
  const quiet = args.options.quiet || args.options.q;
  const json = args.options.json;
  const watchMode = args.options.watch || args.options.w;
  const configFile = args.options.config || args.options.C;
  const textMacros = ([] as string[]).concat((args.options.text || args.options.t || []) as string[]);
  const regexMacros = ([] as string[]).concat((args.options.regex || args.options.r || []) as string[]);
  const execMacros = ([] as string[]).concat((args.options.exec || args.options.e || []) as string[]);
  const blockMacros = ([] as string[]).concat((args.options.block || args.options.B || []) as string[]);
  const streamOutput = args.options.stream || args.options.s;
  const trackState = args.options['track-state'] || args.options.T;
  const userFilterStr = args.options['user-filter'] || args.options.U;
  const sectionHeadingStr = args.options['section-heading'];
  const sectionLinesStr = args.options['section-lines'];
  const sectionRegexStr = args.options['section-regex'];
  
  // Parse user filter regex
  let userFilter: RegExp | undefined;
  if (userFilterStr && typeof userFilterStr === 'string') {
    try {
      userFilter = new RegExp(userFilterStr);
      if (!quiet) {
        eprint(c('cyan', `User filter: /${userFilterStr}/ (only matching users trigger macros)`));
      }
    } catch (e) {
      eprint(c('red', `Invalid user filter regex: ${userFilterStr}`));
      process.exit(1);
    }
  }
  
  // Parse section filter options
  type SectionFilter = 
    | { type: 'heading'; pattern: RegExp; untilNextHeading?: boolean; stopAtLevel?: number }
    | { type: 'lines'; start: number; end?: number }
    | { type: 'regex'; start: RegExp; end: RegExp; global?: boolean };
  
  let sectionFilter: SectionFilter | undefined;
  
  if (sectionHeadingStr && typeof sectionHeadingStr === 'string') {
    try {
      sectionFilter = { type: 'heading', pattern: new RegExp(sectionHeadingStr) };
      if (!quiet) {
        eprint(c('cyan', `Section filter: headings matching /${sectionHeadingStr}/`));
      }
    } catch (e) {
      eprint(c('red', `Invalid section-heading regex: ${sectionHeadingStr}`));
      process.exit(1);
    }
  } else if (sectionLinesStr && typeof sectionLinesStr === 'string') {
    const lineMatch = sectionLinesStr.match(/^(\d+)(?:-(\d*))?$/);
    if (!lineMatch) {
      eprint(c('red', `Invalid section-lines format: ${sectionLinesStr}`));
      eprint(c('yellow', 'Expected format: START-END (e.g., 10-50) or START- (e.g., 100-)'));
      process.exit(1);
    }
    const startLine = parseInt(lineMatch[1], 10);
    const endLine = lineMatch[2] === undefined ? startLine : (lineMatch[2] === '' ? undefined : parseInt(lineMatch[2], 10));
    sectionFilter = { type: 'lines', start: startLine, end: endLine };
    if (!quiet) {
      eprint(c('cyan', `Section filter: lines ${startLine}${endLine !== undefined ? `-${endLine}` : ' to end'}`));
    }
  } else if (sectionRegexStr && typeof sectionRegexStr === 'string') {
    // Format: 'startPattern'/'endPattern' or startPattern/endPattern
    const regexMatch = sectionRegexStr.match(/^'([^']+)'\s*\/\s*'([^']+)'$/) ||
                       sectionRegexStr.match(/^([^\/]+)\/(.+)$/);
    if (!regexMatch) {
      eprint(c('red', `Invalid section-regex format: ${sectionRegexStr}`));
      eprint(c('yellow', "Expected format: 'start'/'end' or start/end"));
      process.exit(1);
    }
    try {
      sectionFilter = {
        type: 'regex',
        start: new RegExp(regexMatch[1]),
        end: new RegExp(regexMatch[2]),
        global: true
      };
      if (!quiet) {
        eprint(c('cyan', `Section filter: regex /${regexMatch[1]}/ to /${regexMatch[2]}/`));
      }
    } catch (e) {
      eprint(c('red', `Invalid section-regex patterns: ${sectionRegexStr}`));
      process.exit(1);
    }
  }
  
  // Only edits by these account ids trigger macros (unlike names, ids cannot be spoofed)
  const allowedUserIds = ([] as string[]).concat((args.options['allow-user'] || []) as string[]);
  const timeoutStr = args.options.timeout;
  const timeoutMs = typeof timeoutStr === 'string' ? Math.round(parseFloat(timeoutStr) * 1000) : 0;
  if (typeof timeoutStr === 'string' && !(timeoutMs > 0)) {
    eprint(c('red', `Invalid --timeout (seconds): ${timeoutStr}`));
    process.exit(1);
  }
  if (allowedUserIds.length > 0 && !quiet) {
    eprint(c('cyan', `Only edits by user ids ${allowedUserIds.join(', ')} trigger macros`));
  }

  const engine = new MacroEngine(client, {
    userFilter,
    sectionFilter,
    allowedUserIds: allowedUserIds.length > 0 ? allowedUserIds : undefined,
  });

  /**
   * Run a macro command. Note content only ever reaches the shell through
   * environment variables (see renderShellTemplate), never as command text.
   * Returns stdout, or null on failure so the trigger is left in place.
   */
  const runMacroCommand = async (cmd: ShellCommand, label: string): Promise<string | null> => {
    if (!quiet) {
      eprint(c('dim', `  ${label}: ${cmd.command}`));
    }
    const result = await runShell(cmd, { timeoutMs });
    if (result.code !== 0) {
      const detail = result.stderr.trim() ? `: ${result.stderr.trim()}` : '';
      eprint(c('red', `  ${label} failed (exit ${result.code})${detail}`));
      return null;
    }
    return result.stdout;
  };

  /** Split String.replace-style handler args into groups, index and document. */
  const splitMatchArgs = (rest: unknown[]) => {
    const document = rest[rest.length - 1] as string;
    const index = rest[rest.length - 2] as number;
    const groups = rest.slice(0, -2).map(g => (g ?? '') as string);
    return { document, index, groups };
  };
  
  const builtinMacros: Record<string, () => string> = {
    '::date::': () => new Date().toISOString().split('T')[0],
    '::time::': () => new Date().toTimeString().split(' ')[0],
    '::datetime::': () => new Date().toISOString(),
    '::ts::': () => String(Date.now()),
  };

  /** Register a regex macro whose replacement is a String.replace template. */
  const registerRegexReplace = (name: string, regex: RegExp, replacement: string) => {
    engine.addRegexMacro(name, regex, (m: string, ...rest: unknown[]) => {
      const { document, index, groups } = splitMatchArgs(rest);
      return expandReplacement(replacement, m, groups, index, document, undefined);
    });
  };

  /**
   * Register an exec macro. Placeholders: {0} full match, {1}.. groups,
   * {DOC}, {BEFORE}, {AFTER}.
   */
  const registerExec = (
    regex: RegExp,
    cmdTemplate: string,
    opts: { streaming?: boolean; trackState?: boolean; lineBuffered?: boolean } = {},
  ) => {
    const name = `exec:${regex.source}`;
    const buildCommand = (fullMatch: string, rest: unknown[]): ShellCommand => {
      const { document, index, groups } = splitMatchArgs(rest);
      const values: Record<string, string> = {
        '0': fullMatch,
        DOC: document,
        BEFORE: document.slice(0, index),
        AFTER: document.slice(index + fullMatch.length),
      };
      groups.forEach((g, i) => { values[String(i + 1)] = g; });
      return renderShellTemplate(cmdTemplate, values);
    };

    if (opts.streaming) {
      engine.addStreamingExecMacro(name, regex,
        (fullMatch: string, ...rest: unknown[]) => {
          const cmd = buildCommand(fullMatch, rest);
          if (!quiet) {
            eprint(c('dim', `  Streaming: ${cmd.command}`));
          }
          return cmd;
        },
        {
          lineBuffered: opts.lineBuffered ?? true,
          trackState: !!opts.trackState,
          timeoutMs,
          onEnd: (exitCode: number) => {
            if (!quiet) {
              eprint(c('dim', `  Stream ended (exit: ${exitCode})`));
            }
          },
          onError: (err: Error) => {
            eprint(c('red', `  Stream error: ${err.message}`));
          }
        });
    } else {
      engine.addRegexMacro(name, regex, async (fullMatch: string, ...rest: unknown[]) => {
        const out = await runMacroCommand(buildCommand(fullMatch, rest), 'Executing');
        return out === null ? null : out.trim();
      });
    }
  };

  /**
   * Register a block macro. The block content is piped to stdin; placeholders
   * {CONTENT}, {DOC}, {BEFORE}, {AFTER} are also available.
   */
  const registerBlock = (blockName: string, cmdTemplate: string) => {
    engine.addBlockMacro(blockName, async (content, ctx) => {
      const cmd = renderShellTemplate(cmdTemplate, {
        CONTENT: content,
        DOC: ctx.fullDocument,
        BEFORE: ctx.beforeMatch,
        AFTER: ctx.afterMatch,
      });
      return runMacroCommand({ ...cmd, stdin: content }, `Block ${blockName}`);
    });
  };

  /** Parse "/source/flags" (or a bare source) into a global regex. */
  const parsePattern = (pattern: string): RegExp => {
    const m = pattern.match(/^\/(.+)\/([a-z]*)$/s);
    const [source, flags] = m ? [m[1], m[2]] : [pattern, ''];
    return new RegExp(source, flags.includes('g') ? flags : flags + 'g');
  };

  // Built-in macros
  if (args.options['built-in'] || args.options.b) {
    for (const [trigger, fn] of Object.entries(builtinMacros)) engine.addTextMacro(trigger, fn);
    
    if (!quiet) {
      eprint(c('cyan', 'Loaded built-in macros: ::date::, ::time::, ::datetime::, ::ts::'));
    }
  }
  
  // Load macros from config file
  if (configFile && typeof configFile === 'string') {
    try {
      const configPath = resolve(process.cwd(), configFile);
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      
      // Documented format: { "macros": [ { "type": ..., ... } ] }
      if (Array.isArray(config.macros)) {
        for (const [i, entry] of (config.macros as Record<string, unknown>[]).entries()) {
          const where = `${configFile} macros[${i}]`;
          const str = (key: string): string => {
            const v = entry[key];
            if (typeof v !== 'string') throw new Error(`${where}: "${key}" must be a string`);
            return v;
          };
          switch (entry.type) {
            case 'text':
              engine.addTextMacro(str('trigger'), str('replacement'));
              break;
            case 'regex':
              registerRegexReplace(str('pattern'), parsePattern(str('pattern')), str('replacement'));
              break;
            case 'exec':
              registerExec(parsePattern(str('pattern')), str('command'), {
                streaming: entry.streaming === true,
                trackState: entry.trackState === true,
                lineBuffered: entry.lineBuffered !== false,
              });
              break;
            case 'block':
              registerBlock(str('name'), str('command'));
              break;
            case 'builtin': {
              const trigger = `::${str('name')}::`;
              const fn = builtinMacros[trigger];
              if (!fn) throw new Error(`${where}: unknown builtin "${entry.name}"`);
              engine.addTextMacro(trigger, fn);
              break;
            }
            default:
              throw new Error(`${where}: unknown macro type ${JSON.stringify(entry.type)}`);
          }
        }
      }
      
      // Legacy format: { "text": { trigger: replacement }, "regex": { pattern: replacement } }
      // Text macros from config ("$cmd" runs a command; it receives no note content)
      if (config.text) {
        for (const [trigger, replacement] of Object.entries(config.text)) {
          if (typeof replacement === 'string' && replacement.startsWith('$')) {
            const command = replacement.slice(1);
            engine.addTextMacro(trigger, async () => {
              const out = await runMacroCommand({ command }, `Text ${trigger}`);
              return out === null ? null : out.trim();
            });
          } else {
            engine.addTextMacro(trigger, replacement as string);
          }
        }
      }
      
      // Regex macros from config ("$cmd" gets MATCH and GROUP<n> in its environment)
      if (config.regex) {
        for (const [pattern, replacement] of Object.entries(config.regex)) {
          const regex = new RegExp(pattern, 'g');
          if (typeof replacement === 'string' && replacement.startsWith('$')) {
            const command = replacement.slice(1);
            engine.addRegexMacro(pattern, regex, async (match: string, ...rest: unknown[]) => {
              const { groups } = splitMatchArgs(rest);
              const env: Record<string, string> = { MATCH: match };
              groups.forEach((g, i) => env[`GROUP${i + 1}`] = g);
              const out = await runMacroCommand({ command, env }, `Regex ${pattern}`);
              return out === null ? null : out.trim();
            });
          } else {
            registerRegexReplace(pattern, regex, replacement as string);
          }
        }
      }
      
      if (!quiet) {
        eprint(c('cyan', `Loaded macros from ${configFile}`));
      }
    } catch (err) {
      eprint(c('red', `Error loading config: ${(err as Error).message}`));
      process.exit(1);
    }
  }
  
  // Add text macros from command line
  for (const macro of textMacros) {
    // Allow empty replacement (pattern=)
    const eqIndex = macro.indexOf('=');
    if (eqIndex === -1 || eqIndex === 0) {
      eprint(c('red', `Invalid text macro format: ${macro}`));
      eprint(c('dim', 'Expected format: trigger=replacement or trigger= (for empty replacement)'));
      process.exit(1);
    }
    
    const trigger = macro.slice(0, eqIndex);
    const replacement = macro.slice(eqIndex + 1);
    if (replacement.startsWith('$(') && replacement.endsWith(')')) {
      const command = replacement.slice(2, -1);
      engine.addTextMacro(trigger, async () => {
        const out = await runMacroCommand({ command }, `Text ${trigger}`);
        return out === null ? null : out.trim();
      });
    } else {
      engine.addTextMacro(trigger, replacement);
    }
  }
  
  // Add regex macros from command line
  for (const macro of regexMacros) {
    const match = macro.match(/^\/(.+?)\/([gimsuy]*)=(.+)$/);
    if (!match) {
      eprint(c('red', `Invalid regex macro format: ${macro}`));
      process.exit(1);
    }
    
    const [, pattern, flags, replacement] = match;
    const regex = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
    
    registerRegexReplace(pattern, regex, replacement);
  }
  
  // Add exec macros from command line
  for (const macro of execMacros) {
    const execMatch = macro.match(/^\/(.+?)\/([gimsuy]*):(.+)$/);
    if (!execMatch) {
      eprint(c('red', `Invalid exec macro format: ${macro}`));
      process.exit(1);
    }
    const [, pattern, flags, cmdTemplate] = execMatch;
    const regex = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
    registerExec(regex, cmdTemplate, { streaming: !!streamOutput, trackState: !!trackState });
  }
  
  // Add block macros from command line (format: --block 'blockname:command')
  for (const macro of blockMacros) {
    const blockMatch = macro.match(/^(\w+):(.+)$/);
    if (!blockMatch) {
      eprint(c('red', `Invalid block macro format: ${macro}`));
      eprint(c('red', `  Expected: blockname:command (e.g., "sort:sort" or "upper:tr a-z A-Z")`));
      process.exit(1);
    }
    const [, blockName, cmdTemplate] = blockMatch;
    registerBlock(blockName, cmdTemplate);
    if (!quiet) {
      eprint(c('cyan', `Registered block macro: ${blockName}`));
    }
  }
  
  // Check if any macros were registered
  const macroList = engine.listMacros();
  if (macroList.length === 0) {
    eprint(c('red', 'Error: No macros defined'));
    process.exit(1);
  }
  
  if (!quiet) {
    eprint(c('cyan', `Registered ${macroList.length} macro(s)`));
  }
  
  if (watchMode) {
    if (!quiet) {
      eprint(c('cyan', '\nWatching for changes... (Ctrl+C to stop)'));
    }
    
    engine.start();
    
    process.on('SIGINT', () => {
      engine.stop();
      client.disconnect();
      process.exit(0);
    });
    
    await new Promise(() => {});
  } else {
    try {
      const results = await engine.expand();
      
      if (json) {
        print(JSON.stringify({ success: true, action: 'macro', results }, null, 2));
      } else {
        if (results.length === 0) {
          if (!quiet) eprint(c('yellow', 'No macros expanded'));
        } else {
          for (const r of results) {
            eprint(c('green', `✓ Expanded ${r.macro}: ${r.matches.length} match(es)`));
          }
        }
      }
      
      if (engine.hasActiveStreams()) {
        if (!quiet) {
          eprint(c('cyan', 'Waiting for streaming macros to complete...'));
        }
        await engine.waitForStreams();
      }
      
      await client.flush();
    } finally {
      client.disconnect();
    }
  }
}
