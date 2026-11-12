/**
 * Commands that read or edit a note's text: get, set, append, prepend,
 * insert, replace, line.
 */

import type { HedgeDocClient } from '../../hedgedoc-client.js';
import type { OptionSpec } from '../args.js';
import { connectionOptions, readFile, type Command, type Context } from '../context.js';
import { helpText } from '../help-text.js';
import { CliError, c, eprint, type Color } from '../ui.js';

const fileOption: OptionSpec = { name: 'file', short: 'f', type: 'value' };

/** Write document text to stdout; add a final newline only for terminals. */
function writeText(text: string): void {
  process.stdout.write(text);
  if (process.stdout.isTTY && !text.endsWith('\n')) process.stdout.write('\n');
}

export const get: Command = {
  name: 'get',
  summary: 'Get document content',
  options: [...connectionOptions, { name: 'authors', short: 'A', type: 'flag' }, { name: 'output', short: 'o', type: 'value' }],
  help: helpText.get,
  async run(ctx) {
    await ctx.withClient({}, (client) => {
      if (!ctx.flag('authors')) {
        const content = client.getDocument();
        if (ctx.json) {
          const data = { content, revision: client.getRevision() };
          if (!ctx.writeOutputFile(JSON.stringify(data, null, 2))) ctx.result(data);
        } else if (!ctx.writeOutputFile(content)) {
          writeText(content);
        }
        return;
      }

      const result = client.getDocumentWithAuthorship();
      if (ctx.json) {
        const data = {
          content: result.content,
          authors: result.authors,
          authorship: result.authorship.map(s => ({
            userId: s.userId,
            author: s.author?.name || null,
            start: s.start,
            end: s.end,
            text: s.text,
            createdAt: s.createdAt?.toISOString(),
            updatedAt: s.updatedAt?.toISOString(),
          })),
        };
        if (!ctx.writeOutputFile(JSON.stringify(data, null, 2))) ctx.result(data);
        return;
      }

      // Text coloured by author, with a legend on stderr.
      const palette: Color[] = ['cyan', 'yellow', 'magenta', 'green', 'blue'];
      const colors = new Map<string, Color>();
      let text = '';
      for (const span of result.authorship) {
        const id = span.userId || 'anonymous';
        if (!colors.has(id)) colors.set(id, palette[colors.size % palette.length]);
        text += c(colors.get(id)!, span.text);
      }
      if (!ctx.quiet) {
        eprint(c('bold', '=== Authors ==='));
        for (const [id, color] of colors) eprint(c(color, `█ ${result.authors[id]?.name || 'Anonymous'}`));
        eprint();
      }
      if (!ctx.writeOutputFile(result.content)) writeText(text);
    });
  },
};

/** Shared shape of commands that write text into the note. */
function editCommand(
  name: string,
  summary: string,
  apply: (client: HedgeDocClient, text: string) => Record<string, unknown>,
  message: (data: Record<string, unknown>) => string,
): Command {
  return {
    name,
    summary,
    options: [...connectionOptions, fileOption],
    help: helpText[name],
    async run(ctx) {
      ctx.note(0, `hedgesync ${name} <url> [text]`);
      // Read input before connecting, so a slow pipe can't time out the session.
      const text = await ctx.input(1);
      const data = await ctx.withClient({ edit: true }, client => apply(client, text));
      ctx.result({ action: name, ...data }, () => ctx.info(c('green', `✓ ${message(data)}`)));
    },
  };
}

export const set = editCommand('set', 'Replace document content (from argument, file or stdin)', (client, text) => {
  const previousLength = client.getDocument().length;
  client.updateContent(text);
  return { length: text.length, previousLength };
}, () => 'Document updated');

export const append = editCommand('append', 'Append text to document', (client, text) => {
  const doc = client.getDocument();
  const inserted = (doc.length === 0 || doc.endsWith('\n') ? '' : '\n') + text;
  client.insert(doc.length, inserted);
  return { position: doc.length, length: inserted.length };
}, () => 'Content appended');

export const prepend = editCommand('prepend', 'Prepend text to document', (client, text) => {
  const inserted = text.endsWith('\n') ? text : text + '\n';
  client.insert(0, inserted);
  return { position: 0, length: inserted.length };
}, () => 'Content prepended');

export const insert: Command = {
  name: 'insert',
  summary: 'Insert text at a character position',
  options: [...connectionOptions, fileOption],
  help: helpText.insert,
  async run(ctx) {
    ctx.note(0, 'hedgesync insert <url> <position> [text]');
    const position = Number(ctx.need(1, 'Position', 'hedgesync insert <url> <position> [text]'));
    if (!Number.isInteger(position) || position < 0) throw new CliError('Position must be a non-negative integer');
    const text = await ctx.input(2);
    await ctx.withClient({ edit: true }, (client) => {
      const length = client.getDocument().length;
      if (position > length) throw new CliError(`Position ${position} is past the end of the document (length ${length})`);
      client.insert(position, text);
    });
    ctx.result({ action: 'insert', position, length: text.length },
      () => ctx.info(c('green', `✓ Inserted at position ${position}`)));
  },
};

export const replace: Command = {
  name: 'replace',
  summary: 'Search and replace in document',
  options: [
    ...connectionOptions,
    { name: 'regex', short: 'r', type: 'flag' },
    { name: 'all', short: 'a', type: 'flag', aliases: ['global'] },
    { name: 'flags', type: 'value' },
  ],
  help: helpText.replace,
  async run(ctx) {
    const usage = 'hedgesync replace <url> <search> [replacement]';
    ctx.note(0, usage);
    const search = ctx.need(1, 'Search pattern', usage);
    const replacement = ctx.positional[2] ?? '';
    let flags = ctx.str('flags') ?? '';
    if (ctx.flag('all') && !flags.includes('g')) flags += 'g';
    let pattern: RegExp;
    try {
      pattern = new RegExp(ctx.flag('regex') ? search : search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    } catch (err) {
      throw new CliError(`Invalid regular expression: ${(err as Error).message}`);
    }
    // A literal search must not interpret "$&" etc. in the replacement.
    const replacementText = ctx.flag('regex') ? replacement : replacement.replace(/\$/g, '$$$$');
    // replaceRegex always replaces every match; without the g flag only the first is wanted.
    const count = await ctx.withClient({ edit: true }, client => (pattern.global
      ? client.replaceRegex(pattern, replacementText)
      : Number(client.replaceFirst(pattern, replacementText))));
    ctx.result({ action: 'replace', pattern: search, replacement, count },
      () => ctx.info(c('green', `✓ Replaced ${count} occurrence(s)`)));
  },
};

export const line: Command = {
  name: 'line',
  summary: 'Get or set a line (0-based)',
  options: [...connectionOptions, fileOption],
  help: helpText.line,
  async run(ctx) {
    const usage = 'hedgesync line <url> <line> [new content]';
    ctx.note(0, usage);
    const lineNum = Number(ctx.need(1, 'Line number', usage));
    if (!Number.isInteger(lineNum) || lineNum < 0) throw new CliError('Line number must be a non-negative integer');
    const file = ctx.str('file');

    if (ctx.positional.length <= 2 && !file) {
      const content = await ctx.withClient({}, client => client.getLine(lineNum));
      if (content === null) throw new CliError(`Line ${lineNum} does not exist`);
      ctx.result({ action: 'get-line', line: lineNum, content }, () => writeText(content));
      return;
    }

    const content = file ? readFile(file).replace(/\n$/, '') : ctx.positional.slice(2).join(' ');
    await ctx.withClient({ edit: true }, (client) => {
      if (client.getLine(lineNum) === null) throw new CliError(`Line ${lineNum} does not exist`);
      client.setLine(lineNum, content);
    });
    ctx.result({ action: 'set-line', line: lineNum, length: content.length },
      () => ctx.info(c('green', `✓ Line ${lineNum} updated`)));
  },
};

export const documentCommands = [get, set, append, prepend, insert, replace, line];

export type { Context };
