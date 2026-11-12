/**
 * Terminal output helpers: colours, errors and result printing.
 */

/** An error to show the user (no stack trace), with an optional hint. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    /** Extra fields for --json error output. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'CliError';
  }
}

const codes = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
} as const;

export type Color = Exclude<keyof typeof codes, 'reset'>;

let colorEnabled = detectColor();

function detectColor(): boolean {
  const env = typeof process !== 'undefined' ? process.env : {};
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  if (env.TERM === 'dumb') return false;
  return Boolean(process.stdout?.isTTY && process.stderr?.isTTY);
}

/** Turn colours off (--no-color) or back to auto-detection. */
export function setColor(enabled: boolean | 'auto'): void {
  colorEnabled = enabled === 'auto' ? detectColor() : enabled;
}

/** Wrap text in an ANSI colour, if colours are enabled. */
export function c(color: Color, text: string): string {
  return colorEnabled ? `${codes[color]}${text}${codes.reset}` : text;
}

/** Print a line to stderr. */
export function eprint(text = ''): void {
  process.stderr.write(text + '\n');
}

/** Print a line to stdout. */
export function print(text = ''): void {
  process.stdout.write(text + '\n');
}

export function printJson(value: unknown): void {
  print(JSON.stringify(value, null, 2));
}

/** One-line JSON (for streams such as watch --ndjson). */
export function printJsonLine(value: unknown): void {
  print(JSON.stringify(value));
}
