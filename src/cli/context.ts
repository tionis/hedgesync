/**
 * Shared plumbing for CLI commands: option specs, connection setup, input and
 * output.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HedgeDocClient, type HedgeDocClientOptions } from '../hedgedoc-client.js';
import { detectServer } from '../server-detect.js';
import { HedgeDocAPI, HedgeDocAPIError } from '../hedgedoc-api.js';
import { parseNoteUrl, parseServerUrl } from '../url.js';
import { flag, str, list, type OptionSpec, type ParsedArgs } from './args.js';
import { getStoredSession } from './cookie-store.js';
import { CliError, c, eprint, printJson } from './ui.js';

export interface Command {
  name: string;
  /** One line for the command overview. */
  summary: string;
  /** Command-specific options (global options are added automatically). */
  options: OptionSpec[];
  /** Full help text. */
  help: () => string;
  run: (ctx: Context) => Promise<void>;
}

/** Options every command accepts. */
export const globalOptions: OptionSpec[] = [
  { name: 'help', short: 'h', type: 'flag' },
  { name: 'json', type: 'flag' },
  { name: 'quiet', short: 'q', type: 'flag' },
  { name: 'cookie', short: 'c', type: 'value' },
  { name: 'header', short: 'H', type: 'multi' },
  { name: 'no-color', type: 'flag' },
  { name: 'debug', type: 'flag' },
];

/** Options for commands that open a realtime connection to a note. */
export const connectionOptions: OptionSpec[] = [
  { name: 'no-reconnect', type: 'flag' },
];

export class Context {
  readonly json: boolean;
  readonly quiet: boolean;

  constructor(readonly args: ParsedArgs) {
    this.json = flag(args, 'json');
    this.quiet = flag(args, 'quiet');
  }

  get positional(): string[] {
    return this.args.positional;
  }

  str(name: string): string | undefined {
    return str(this.args, name);
  }

  flag(name: string): boolean {
    return flag(this.args, name);
  }

  list(name: string): string[] {
    return list(this.args, name);
  }

  /** Integer option, or `fallback` if absent. */
  int(name: string, fallback: number): number {
    const raw = this.str(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new CliError(`--${name} must be an integer, got '${raw}'`);
    return n;
  }

  /** Progress/status message on stderr (suppressed by --quiet and --json). */
  info(message: string): void {
    if (!this.quiet && !this.json) eprint(message);
  }

  /** Warning on stderr (suppressed only by --json). */
  warn(message: string): void {
    if (!this.json) eprint(c('yellow', message));
  }

  /**
   * Report a command's result: the JSON object under --json, otherwise
   * whatever `human` prints.
   */
  result(data: Record<string, unknown>, human?: () => void): void {
    if (this.json) printJson({ success: true, ...data });
    else human?.();
  }

  /** Positional argument `index`, or an error naming it. */
  need(index: number, name: string, usage?: string): string {
    const value = this.positional[index];
    if (!value) throw new CliError(`${name} required`, usage ? `Usage: ${usage}` : undefined);
    return value;
  }

  headers(): Record<string, string> {
    return parseHeaders(this.list('header'));
  }

  /**
   * Session cookie for a server: --cookie, then HEDGEDOC_COOKIE, then one
   * saved with `hedgesync login --save`.
   */
  cookieFor(serverUrl: string): string | undefined {
    return this.str('cookie') || process.env.HEDGEDOC_COOKIE || getStoredSession(serverUrl)?.cookie;
  }

  /** Like cookieFor, but fails if there is none. */
  requireCookie(serverUrl: string): string {
    const cookie = this.cookieFor(serverUrl);
    if (!cookie) {
      throw new CliError('This command needs a session cookie',
        `Use --cookie, set HEDGEDOC_COOKIE, or run: hedgesync login ${serverUrl} --from-browser firefox --save (or -u <user> for email/LDAP)`);
    }
    return cookie;
  }

  /** Parse positional `index` as a note URL. */
  note(index = 0, usage?: string): { serverUrl: string; noteId: string; url: string } {
    const url = this.need(index, 'Note URL', usage);
    try {
      return { ...parseNoteUrl(url), url };
    } catch (err) {
      throw new CliError((err as Error).message, 'Expected a note URL such as https://md.example.com/abc123');
    }
  }

  /** Parse positional `index` as a server URL. */
  server(index = 0, usage?: string): string {
    const url = this.need(index, 'Server URL', usage);
    try {
      return parseServerUrl(url);
    } catch (err) {
      throw new CliError((err as Error).message, 'Expected a server URL such as https://md.example.com');
    }
  }

  /** HTTP API client for a server. */
  api(serverUrl: string, requireAuth = false): HedgeDocAPI {
    const cookie = requireAuth ? this.requireCookie(serverUrl) : this.cookieFor(serverUrl);
    return new HedgeDocAPI({ serverUrl, cookie, headers: this.headers() });
  }

  /** Open a realtime connection to the note at positional `index`. */
  async connect(index = 0, extra: Partial<HedgeDocClientOptions> = {}): Promise<HedgeDocClient> {
    const { serverUrl, noteId } = this.note(index);
    return this.connectTo(serverUrl, noteId, extra);
  }

  async connectTo(serverUrl: string, noteId: string, extra: Partial<HedgeDocClientOptions> = {}): Promise<HedgeDocClient> {
    this.info(c('dim', `Connecting to ${serverUrl}/${noteId}...`));
    const client = new HedgeDocClient({
      serverUrl,
      noteId,
      cookie: this.cookieFor(serverUrl),
      headers: this.headers(),
      reconnect: { enabled: !this.flag('no-reconnect') },
      ...extra,
    });
    try {
      await client.connect();
    } catch (err) {
      client.disconnect();
      // A HedgeDoc 2 server never answers the Socket.IO handshake; say so instead of timing out.
      const server = await detectServer({ serverUrl, headers: this.headers(), timeout: 3000 }).catch(() => null);
      if (server?.protocol === 'hedgedoc2') {
        throw new CliError(`${serverUrl} runs HedgeDoc ${server.version ?? '2'}, which hedgesync does not support yet`,
          'Only HedgeDoc 1.x realtime editing is implemented so far.');
      }
      throw new CliError(`Could not connect: ${(err as Error).message}`,
        server && !server.protocol ? `${serverUrl} does not look like a HedgeDoc server.` : undefined);
    }
    this.info(c('green', '✓ Connected'));
    return client;
  }

  /**
   * Connect, run `fn`, and always disconnect. With `edit`, fail early if the
   * note is not editable; edits are flushed (acknowledged by the server)
   * before disconnecting.
   */
  async withClient<T>(options: { edit?: boolean; index?: number }, fn: (client: HedgeDocClient) => Promise<T> | T): Promise<T> {
    const client = await this.connect(options.index ?? 0);
    try {
      if (options.edit) assertEditable(client);
      const result = await fn(client);
      await client.flush();
      return result;
    } finally {
      client.disconnect();
    }
  }

  /**
   * Text input for a command: --file, else positional arguments from
   * `fromIndex` on (joined with spaces), else piped stdin.
   */
  async input(fromIndex: number): Promise<string> {
    const file = this.str('file');
    if (file) return readFile(file);
    if (this.positional.length > fromIndex) return this.positional.slice(fromIndex).join(' ');
    return readStdin('Pass the text as an argument, with --file, or on stdin');
  }

  /** Write to --output if given (returns true), else return false. */
  writeOutputFile(content: string | Uint8Array): boolean {
    const output = this.str('output');
    if (!output) return false;
    writeFileSync(output, content);
    this.info(c('green', `✓ Written to ${output}`));
    return true;
  }
}

export function readFile(path: string): string {
  try {
    return readFileSync(resolve(path), 'utf-8');
  } catch (err) {
    throw new CliError(`Cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
}

/**
 * Read all of stdin. Refuses to wait on an interactive terminal, where it
 * would otherwise hang silently.
 */
export async function readStdin(hint?: string): Promise<string> {
  if (process.stdin.isTTY) {
    throw new CliError('No input given (stdin is a terminal)', hint);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export function assertEditable(client: HedgeDocClient): void {
  if (client.canEdit()) return;
  const permission = client.getNoteInfo().permission;
  const hint = permission === 'editable' || permission === 'limited'
    ? 'This note requires a logged-in user; pass a session cookie.'
    : permission === 'locked' || permission === 'private' || permission === 'protected'
      ? 'Only the owner can edit this note.'
      : undefined;
  throw new CliError(`No edit permission for this note (permission: ${permission || 'unknown'})`, hint, { permission });
}

/**
 * Headers from HEDGEDOC_HEADERS (JSON object, or "K: v; K2: v2") and -H
 * arguments ("K: v" or "K=v"); arguments win.
 */
export function parseHeaders(headerArgs: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  const addPair = (pair: string) => {
    const colon = pair.indexOf(':');
    const equal = pair.indexOf('=');
    const sep = colon > 0 ? colon : equal;
    if (sep <= 0) return;
    const key = pair.slice(0, sep).trim();
    if (key) headers[key] = pair.slice(sep + 1).trim();
  };

  const env = process.env.HEDGEDOC_HEADERS;
  if (env) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env);
    } catch {
      parsed = undefined;
    }
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) headers[k] = String(v);
    } else {
      for (const part of env.split(';')) addPair(part.trim());
    }
  }
  for (const h of headerArgs) addPair(h);
  return headers;
}

/** Turn library errors into user-facing messages with hints. */
export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  if (err instanceof HedgeDocAPIError) {
    const hint = err.statusCode === 401 || err.statusCode === 403
      ? 'Make sure your session cookie is valid (hedgesync me <server> checks it).'
      : err.statusCode === 404 ? 'Check the URL and note ID.' : undefined;
    return new CliError(err.message, hint, { statusCode: err.statusCode });
  }
  return new CliError(err instanceof Error ? err.message : String(err));
}
