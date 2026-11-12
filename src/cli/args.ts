/**
 * Command-line parsing driven by per-command option specs.
 *
 * Knowing each option's type is what lets `get --json <url>` work: a flag
 * never consumes the next argument, and a value option always does (even if
 * the value starts with '-').
 */

import { CliError } from './ui.js';

export type OptionType = 'flag' | 'value' | 'multi';

export interface OptionSpec {
  /** Long name, used as the canonical key (`--name`). */
  name: string;
  type: OptionType;
  /** Single-letter alias (`-x`). */
  short?: string;
  /** Other long names accepted for compatibility. */
  aliases?: string[];
  /** Placeholder for help output, e.g. "<file>". */
  arg?: string;
  description?: string;
}

export type OptionValue = string | string[] | boolean;

export interface ParsedArgs {
  command: string | null;
  positional: string[];
  /**
   * Option values keyed by long name. Each value is also stored under the
   * option's short and alias names, so `options.quiet` and `options.q` agree.
   */
  options: Record<string, OptionValue>;
  /** Arguments after a literal `--`. */
  rest: string[];
}

/** Split argv into the command name and the remaining arguments. */
export function splitCommand(argv: string[], globalSpecs: OptionSpec[]): { command: string | null; rest: string[] } {
  // The command is the first argument that is not a (global) option or its value.
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') break;
    if (!arg.startsWith('-') || arg === '-') {
      return { command: arg, rest: [...argv.slice(0, i), ...argv.slice(i + 1)] };
    }
    const spec = findSpec(globalSpecs, arg);
    if (spec && spec.type !== 'flag' && !arg.includes('=')) i++;
  }
  return { command: null, rest: argv };
}

function findSpec(specs: OptionSpec[], arg: string): OptionSpec | undefined {
  if (arg.startsWith('--')) {
    const name = arg.slice(2).split('=')[0];
    return specs.find(s => s.name === name || s.aliases?.includes(name));
  }
  return specs.find(s => s.short === arg.slice(1, 2));
}

/** Parse arguments (without the command name) against a set of option specs. */
export function parseArgs(command: string | null, argv: string[], specs: OptionSpec[]): ParsedArgs {
  const parsed: ParsedArgs = { command, positional: [], options: {}, rest: [] };

  const set = (spec: OptionSpec, value: string | true) => {
    const keys = [spec.name, ...(spec.short ? [spec.short] : []), ...(spec.aliases ?? [])];
    if (spec.type === 'multi') {
      const list = (parsed.options[spec.name] as string[] | undefined) ?? [];
      list.push(value as string);
      for (const k of keys) parsed.options[k] = list;
    } else {
      for (const k of keys) parsed.options[k] = value;
    }
  };

  const takeValue = (spec: OptionSpec, display: string, inline: string | undefined, i: number): [string, number] => {
    if (inline !== undefined) return [inline, i];
    if (i + 1 >= argv.length) throw new CliError(`Option ${display} needs a value`);
    return [argv[i + 1], i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--') {
      parsed.rest = argv.slice(i + 1);
      break;
    }

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = arg.slice(2, eq === -1 ? undefined : eq);
      const inline = eq === -1 ? undefined : arg.slice(eq + 1);
      const spec = specs.find(s => s.name === name || s.aliases?.includes(name));
      if (!spec) {
        throw new CliError(`Unknown option --${name}`, command ? `See: hedgesync help ${command}` : undefined);
      }
      if (spec.type === 'flag') {
        if (inline !== undefined) throw new CliError(`Option --${name} does not take a value`);
        set(spec, true);
      } else {
        const [value, next] = takeValue(spec, `--${name}`, inline, i);
        set(spec, value);
        i = next;
      }
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1 && !/^-\d/.test(arg)) {
      // One or more short options: -qj, -o file, -ofile
      for (let j = 1; j < arg.length; j++) {
        const letter = arg[j];
        const spec = specs.find(s => s.short === letter);
        if (!spec) {
          throw new CliError(`Unknown option -${letter}`, command ? `See: hedgesync help ${command}` : undefined);
        }
        if (spec.type === 'flag') {
          set(spec, true);
          continue;
        }
        const inline = j + 1 < arg.length ? arg.slice(j + 1) : undefined;
        const [value, next] = takeValue(spec, `-${letter}`, inline, i);
        set(spec, value);
        i = next;
        break;
      }
      continue;
    }

    parsed.positional.push(arg);
  }

  return parsed;
}

/** Read a string option (undefined if absent). */
export function str(args: ParsedArgs, name: string): string | undefined {
  const v = args.options[name];
  return typeof v === 'string' ? v : undefined;
}

/** Read a flag option. */
export function flag(args: ParsedArgs, name: string): boolean {
  return args.options[name] === true;
}

/** Read a multi-value option. */
export function list(args: ParsedArgs, name: string): string[] {
  const v = args.options[name];
  return Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
}
