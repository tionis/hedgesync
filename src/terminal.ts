/**
 * NoteTerminal: a shared shell session that lives inside a note (Node/Bun only).
 *
 * The note holds a fenced code block whose info string is the block name
 * (default `terminal`). Its last line starting with `$` is the prompt:
 *
 *     ```terminal
 *     $ ls
 *     README.md
 *     $ █
 *     ```
 *
 * A collaborator types a command after the prompt and presses Enter (which
 * leaves an empty line before the closing fence). The host runs it in one
 * long-lived POSIX shell, so `cd`, variables and functions persist, streams
 * the output into the note below the command, and adds a fresh prompt.
 * Multi-line input (heredocs, pasted scripts) is sent as a whole once it ends
 * in an empty line.
 *
 * Security: anyone whose edits are accepted can run commands as the host
 * user. `allowedUserIds` limits this to HedgeDoc account ids; input touched
 * by anyone else is refused, not run.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { killShell } from './shell.js';
import { SimpleEventEmitter } from './simple-event-emitter.js';
import { TextOperation } from './text-operation.js';
import type { ChangeEvent } from './hedgedoc-client.js';
import type { UserInfo } from './drivers/types.js';

/** The part of HedgeDocClient a terminal needs. */
export interface NoteTerminalClient {
  document: string;
  insert(position: number, text: string): void;
  replace(position: number, length: number, text: string): void;
  on(event: 'change', listener: (event: ChangeEvent) => void): unknown;
  off(event: 'change', listener: (event: ChangeEvent) => void): unknown;
}

export interface NoteTerminalOptions {
  /** Info string of the terminal's code block (default "terminal"). */
  blockName?: string;
  /** POSIX shell to run (default: bash if installed, else sh). */
  shell?: string;
  /** Working directory the shell starts in. */
  cwd?: string;
  /** Extra environment for the shell. */
  env?: Record<string, string>;
  /** Only these HedgeDoc account ids may run commands; null or omitted means anyone who can edit. */
  allowedUserIds?: string[] | null;
  /** Kill a command (and restart the shell) after this many ms; 0 = never (default). */
  timeoutMs?: number;
  /** Most output characters shown per command (default 20000). */
  maxOutput?: number;
  /** How often streamed output is written to the note (ms, default 300). */
  flushIntervalMs?: number;
  /** Delay before looking at the note after a remote edit (ms, default 150). */
  debounceMs?: number;
}

/** Emitted as 'command' when a command starts. */
export interface TerminalCommandEvent {
  command: string;
  user: UserInfo | null;
}

/** Emitted as 'done' when a command finishes. */
export interface TerminalDoneEvent {
  command: string;
  user: UserInfo | null;
  /** Exit status; null if the shell died or the command was killed. */
  code: number | null;
  durationMs: number;
  timedOut: boolean;
}

/** Emitted as 'refused' when input from someone not allowed is not run. */
export interface TerminalRefusedEvent {
  command: string;
  users: UserInfo[];
}

interface Block {
  /** Start of the first content line. */
  contentStart: number;
  /** Start of the closing fence line (document length if unclosed). */
  closeStart: number;
  closed: boolean;
  fenceChar: string;
  fenceLength: number;
}

interface Running {
  command: string;
  user: UserInfo | null;
  startedAt: number;
  /** Output region in the note. */
  outStart: number;
  outEnd: number;
  /** Text currently in the output region. */
  written: string;
  /** Raw output so far (capped). */
  raw: string;
  truncated: boolean;
  /** Unparsed tail of stdout that may be the start of the end marker. */
  pending: string;
  timer: ReturnType<typeof setTimeout> | null;
  timedOut: boolean;
}

const PROMPT = '$ ';
const CLOSED_MARK = '[terminal closed]';

/** Find the first fenced code block whose info string starts with `name`. */
export function findTerminalBlock(doc: string, name: string): Block | null {
  let offset = 0;
  let open: { char: string; length: number; contentStart: number } | null = null;
  let skip: { char: string; length: number } | null = null;
  while (offset <= doc.length) {
    const nl = doc.indexOf('\n', offset);
    const end = nl === -1 ? doc.length : nl;
    const line = doc.slice(offset, end);
    const next = nl === -1 ? doc.length + 1 : nl + 1;
    const fence = open ?? skip;
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence.char === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`);
      if (close.test(line)) {
        if (open) {
          return { contentStart: open.contentStart, closeStart: offset, closed: true, fenceChar: open.char, fenceLength: open.length };
        }
        skip = null;
      }
    } else {
      const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
        const info = m[2].trim().split(/\s+/)[0];
        const fenceInfo = { char: m[1][0], length: m[1].length };
        if (info === name) open = { ...fenceInfo, contentStart: Math.min(next, doc.length) };
        else skip = fenceInfo;
      }
    }
    offset = next;
  }
  if (open) {
    return { contentStart: open.contentStart, closeStart: doc.length, closed: false, fenceChar: open.char, fenceLength: open.length };
  }
  return null;
}

/**
 * Make raw command output safe to show inside the block: drop ANSI escapes and
 * control characters, apply carriage returns (progress bars keep their last
 * state), and defuse lines that would close the code fence.
 */
export function sanitizeTerminalOutput(raw: string, fenceChar = '`', fenceLength = 3): string {
  let text = raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (titles, hyperlinks)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI (colours, cursor movement)
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r\n/g, '\n');
  const fence = new RegExp(`^ {0,3}${fenceChar === '`' ? '`' : '~'}{${fenceLength},}`);
  text = text.split('\n').map(line => {
    if (line.includes('\r')) {
      const parts = line.split('\r').filter(p => p !== '');
      line = parts.length ? parts[parts.length - 1] : '';
    }
    line = line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    return fence.test(line) ? '​' + line : line;
  }).join('\n');
  return text;
}

function defaultShell(): string {
  return existsSync('/bin/bash') || existsSync('/usr/bin/bash') ? 'bash' : 'sh';
}

/** Single-quote a string for a POSIX shell. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Edit ranges of an operation, in the coordinates of the document it applies to.
 */
function touchedRanges(op: TextOperation): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let index = 0;
  for (const component of op.ops) {
    if (TextOperation.isRetain(component)) index += component;
    else if (TextOperation.isInsert(component)) ranges.push({ start: index, end: index });
    else {
      ranges.push({ start: index, end: index - component });
      index -= component;
    }
  }
  return ranges;
}

export class NoteTerminal extends SimpleEventEmitter {
  readonly client: NoteTerminalClient;
  readonly blockName: string;
  readonly shell: string;
  readonly allowedUserIds: Set<string> | null;

  private _options: NoteTerminalOptions;
  private _maxOutput: number;
  private _flushIntervalMs: number;
  private _debounceMs: number;
  private _timeoutMs: number;
  private _marker = `__hedgesync_${randomBytes(8).toString('hex')}__`;

  private _proc: ChildProcess | null = null;
  private _running: Running | null = null;
  private _flushTimer: ReturnType<typeof setInterval> | null = null;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _started = false;

  /** Start of the active prompt line, while idle. */
  private _promptPos: number | null = null;
  /** Start of the closing fence, while idle. */
  private _fencePos: number | null = null;
  /** Users not allowed to run commands who edited the current input. */
  private _intruders = new Map<string, UserInfo>();
  /** Last allowed user who edited the current input. */
  private _lastAuthor: UserInfo | null = null;
  private _selfEdit = false;
  private _warnedUnclosed = false;
  private _changeHandler = (event: ChangeEvent) => this._onChange(event);

  constructor(client: NoteTerminalClient, options: NoteTerminalOptions = {}) {
    super();
    this.client = client;
    this._options = options;
    this.blockName = options.blockName ?? 'terminal';
    this.shell = options.shell ?? defaultShell();
    this.allowedUserIds = options.allowedUserIds ? new Set(options.allowedUserIds) : null;
    this._maxOutput = options.maxOutput ?? 20000;
    this._flushIntervalMs = options.flushIntervalMs ?? 300;
    this._debounceMs = options.debounceMs ?? 150;
    this._timeoutMs = options.timeoutMs ?? 0;
    if (!/^[\w.+-]+$/.test(this.blockName)) throw new Error(`Invalid block name: ${this.blockName}`);
  }

  /** Whether a command is running. */
  get busy(): boolean {
    return this._running !== null;
  }

  /** Set up the block and prompt, then react to edits. */
  start(): void {
    if (this._started) return;
    this._started = true;
    this.client.on('change', this._changeHandler);
    this._setupPrompt(true);
  }

  /**
   * Stop reacting to edits, kill the shell and mark the session closed in the
   * note. Call client.flush() afterwards to make sure the server has it.
   */
  stop(): void {
    if (!this._started) return;
    this._started = false;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = null;
    this.client.off('change', this._changeHandler);
    this._finish(null, '[interrupted]');
    this._closePrompt();
    this._killShell();
  }

  // ---- note structure --------------------------------------------------------

  private _edit(fn: () => void): void {
    this._selfEdit = true;
    try {
      fn();
    } finally {
      this._selfEdit = false;
    }
  }

  private _block(): Block | null {
    return findTerminalBlock(this.client.document, this.blockName);
  }

  /** Create the block if needed and make sure it ends in a prompt. */
  private _setupPrompt(fresh: boolean): void {
    const doc = this.client.document;
    let block = this._block();
    if (!block) {
      const before = doc === '' || doc.endsWith('\n\n') ? '' : doc.endsWith('\n') ? '\n' : '\n\n';
      const text = `${before}\`\`\`${this.blockName}\n${PROMPT}\n\`\`\`\n`;
      this._edit(() => this.client.insert(doc.length, text));
      block = this._block()!;
      this._setIdle(block.contentStart, block.closeStart);
      return;
    }
    if (!block.closed) {
      if (!this._warnedUnclosed) this.emit('warning', `The ${this.blockName} block has no closing fence; waiting for it to be fixed`);
      this._warnedUnclosed = true;
      this._promptPos = this._fencePos = null;
      return;
    }
    this._warnedUnclosed = false;
    const last = this._lastPromptLine(doc, block);
    // On start, input already there is of unknown origin: leave it and start a fresh prompt.
    const reuse = last !== null && (!fresh || /^\$ ?\n*$/.test(doc.slice(last, block.closeStart)));
    if (reuse) {
      this._setIdle(last!, block.closeStart);
      return;
    }
    const at = block.closeStart;
    const needsNewline = at > block.contentStart && doc[at - 1] !== '\n';
    this._edit(() => this.client.insert(at, `${needsNewline ? '\n' : ''}${PROMPT}\n`));
    this._setIdle(at + (needsNewline ? 1 : 0), at + (needsNewline ? 1 : 0) + PROMPT.length + 1);
  }

  private _lastPromptLine(doc: string, block: Block): number | null {
    let pos: number | null = null;
    let offset = block.contentStart;
    while (offset < block.closeStart) {
      if (doc[offset] === '$') pos = offset;
      const nl = doc.indexOf('\n', offset);
      if (nl === -1) break;
      offset = nl + 1;
    }
    return pos;
  }

  private _setIdle(promptPos: number, fencePos: number): void {
    this._promptPos = promptPos;
    this._fencePos = fencePos;
    this._intruders.clear();
    this._lastAuthor = null;
  }

  private _closePrompt(): void {
    const doc = this.client.document;
    const block = this._block();
    if (!block?.closed) return;
    const prompt = this._promptPos !== null ? this._promptPos : this._lastPromptLine(doc, block);
    if (prompt === null || prompt < block.contentStart || prompt > block.closeStart) return;
    const input = doc.slice(prompt, block.closeStart);
    if (/^\$ ?\n*$/.test(input)) {
      this._edit(() => this.client.replace(prompt, input.length, `${CLOSED_MARK}\n`));
    } else {
      this._edit(() => this.client.insert(block.closeStart, `${CLOSED_MARK}\n`));
    }
    this._promptPos = this._fencePos = null;
  }

  // ---- edits -----------------------------------------------------------------

  private _isAllowed(user: UserInfo | undefined): boolean {
    if (!this.allowedUserIds) return true;
    const id = user?.userid;
    return !!id && this.allowedUserIds.has(id);
  }

  private _onChange(event: ChangeEvent): void {
    if (this._selfEdit || !event.operation) return;
    const op = event.operation;
    if (event.type === 'remote' && this._promptPos !== null && this._fencePos !== null) {
      const start = this._promptPos;
      const end = this._fencePos;
      const touches = touchedRanges(op).some(r => r.end >= start && r.start <= end);
      if (touches) {
        if (this._isAllowed(event.user)) {
          this._lastAuthor = event.user ?? null;
        } else {
          const user = event.user ?? { id: event.clientId ?? 'unknown' };
          this._intruders.set(user.id, user);
        }
      }
    }
    const tp = TextOperation.transformPosition;
    if (this._promptPos !== null) this._promptPos = tp(this._promptPos, op, false);
    if (this._fencePos !== null) this._fencePos = tp(this._fencePos, op, true);
    if (this._running) {
      this._running.outStart = tp(this._running.outStart, op, false);
      this._running.outEnd = Math.max(this._running.outStart, tp(this._running.outEnd, op, true));
    }
    if (event.type === 'remote' && !this._running) this._schedule();
  }

  private _schedule(): void {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      try {
        this._check();
      } catch (err) {
        this.emit('error', err);
      }
    }, this._debounceMs);
  }

  /** Look at the prompt and run what was submitted. */
  private _check(): void {
    if (!this._started || this._running) return;
    const doc = this.client.document;
    const block = this._block();
    const promptOk = block?.closed && this._promptPos !== null
      && this._promptPos >= block.contentStart && this._promptPos < block.closeStart
      && doc[this._promptPos] === '$' && (this._promptPos === 0 || doc[this._promptPos - 1] === '\n');
    if (!block || !promptOk) {
      // Someone restructured the block; find (or make) the prompt again.
      const intruders = new Map(this._intruders);
      const author = this._lastAuthor;
      this._setupPrompt(false);
      if (this._promptPos === null) return;
      for (const [id, user] of intruders) this._intruders.set(id, user);
      this._lastAuthor = author;
      return this._check();
    }
    const promptPos = this._promptPos!;
    this._fencePos = block.closeStart;
    const input = doc.slice(promptPos + 1, block.closeStart);
    if (!input.endsWith('\n\n')) return;

    const command = input.replace(/^ /, '').replace(/\s+$/, '');
    const region = block.closeStart - promptPos;
    if (command === '') {
      this._edit(() => this.client.replace(promptPos, region, `${PROMPT}\n`));
      this._setIdle(promptPos, promptPos + PROMPT.length + 1);
      return;
    }
    if (this._intruders.size > 0) {
      const users = [...this._intruders.values()];
      const names = users.map(u => u.name || 'anonymous').join(', ');
      const notice = `[refused: edited by ${names}, who may not run commands here]`;
      const text = `${PROMPT}${command}\n${notice}\n${PROMPT}\n`;
      this._edit(() => this.client.replace(promptPos, region, text));
      const next = promptPos + text.length - PROMPT.length - 1;
      this._setIdle(next, next + PROMPT.length + 1);
      this.emit('refused', { command, users } satisfies TerminalRefusedEvent);
      return;
    }
    this._run(promptPos, region, command);
  }

  // ---- running ---------------------------------------------------------------

  private _ensureShell(): ChildProcess {
    if (this._proc && this._proc.exitCode === null && this._proc.signalCode === null) return this._proc;
    const proc = spawn(this.shell, [], {
      cwd: this._options.cwd,
      env: {
        ...process.env,
        TERM: 'dumb',
        NO_COLOR: '1',
        PAGER: 'cat',
        GIT_PAGER: 'cat',
        ...this._options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    proc.stdout!.setEncoding('utf8');
    proc.stderr!.setEncoding('utf8');
    proc.stdout!.on('data', (d: string) => { if (this._proc === proc) this._onStdout(d); });
    proc.stderr!.on('data', (d: string) => { if (this._proc === proc) this._onStderr(d); });
    proc.stdin!.on('error', () => {});
    const onGone = () => {
      if (this._proc !== proc) return;
      this._proc = null;
      if (this._running) {
        const run = this._running;
        this._flushPending();
        const why = run.timedOut
          ? `[timed out after ${this._timeoutMs / 1000}s; started a new shell]`
          : '[shell exited; the next command starts a new one]';
        this._finish(null, why);
      }
    };
    proc.on('close', onGone);
    // After a timeout, don't wait for the pipes to close: on Windows a
    // grandchild of Git's bash (forked, so outside taskkill's reach) can
    // outlive the kill and keep them open until it finishes by itself.
    proc.on('exit', () => {
      if (this._proc !== proc || !this._running?.timedOut) return;
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      onGone();
    });
    proc.on('error', (err) => {
      this.emit('warning', `Shell ${this.shell} failed: ${err.message}`);
      onGone();
    });
    this._proc = proc;
    return proc;
  }

  private _killShell(): void {
    const proc = this._proc;
    this._proc = null;
    if (!proc) return;
    proc.stdin?.end();
    killShell(proc, 'SIGKILL');
  }

  private _run(promptPos: number, region: number, command: string): void {
    const user = this._lastAuthor;
    const header = `${PROMPT}${command}\n`;
    this._edit(() => this.client.replace(promptPos, region, header));
    const outStart = promptPos + header.length;
    this._promptPos = this._fencePos = null;
    this._running = {
      command,
      user,
      startedAt: Date.now(),
      outStart,
      outEnd: outStart,
      written: '',
      raw: '',
      truncated: false,
      pending: '',
      timer: null,
      timedOut: false,
    };
    this.emit('command', { command, user } satisfies TerminalCommandEvent);

    const proc = this._ensureShell();
    if (this._timeoutMs > 0) {
      this._running.timer = setTimeout(() => {
        if (!this._running) return;
        this._running.timedOut = true;
        if (this._proc) killShell(this._proc, 'SIGKILL');
      }, this._timeoutMs);
    }
    this._flushTimer = setInterval(() => this._flushOutput(false), this._flushIntervalMs);
    proc.stdin!.write(`command eval ${shQuote(command)} </dev/null 2>&1; printf '\\n%s:%s\\n' '${this._marker}' "$?"\n`);
  }

  private _append(text: string): void {
    const run = this._running;
    if (!run || text === '') return;
    // Keep some slack beyond maxOutput: carriage returns can shrink what is shown.
    const cap = this._maxOutput * 2;
    if (run.raw.length + text.length > cap) {
      run.raw += text.slice(0, Math.max(0, cap - run.raw.length));
      run.truncated = true;
    } else {
      run.raw += text;
    }
  }

  private _onStdout(data: string): void {
    const run = this._running;
    if (!run) return;
    run.pending += data;
    const end = new RegExp(`\\n${this._marker}:(\\d+)\\n`).exec(run.pending);
    if (end) {
      this._append(run.pending.slice(0, end.index));
      run.pending = '';
      this._finish(Number(end[1]));
      return;
    }
    // Hold back a tail that could be the start of the end marker.
    const marker = `\n${this._marker}:`;
    let keep = 0;
    for (let n = Math.min(run.pending.length, marker.length + 12); n > 0; n--) {
      const tail = run.pending.slice(-n);
      if (marker.startsWith(tail) || (tail.startsWith(marker) && /^\d*$/.test(tail.slice(marker.length)))) {
        keep = n;
        break;
      }
    }
    this._append(run.pending.slice(0, run.pending.length - keep));
    run.pending = run.pending.slice(run.pending.length - keep);
  }

  private _onStderr(data: string): void {
    // Command stderr is merged into stdout; this is the shell's own.
    if (this._running) this._append(data);
    else this.emit('warning', data.trimEnd());
  }

  private _flushPending(): void {
    if (!this._running) return;
    this._append(this._running.pending);
    this._running.pending = '';
  }

  /** Bring the output region up to date with the output so far. */
  private _flushOutput(final: boolean, trailer = ''): void {
    const run = this._running;
    if (!run) return;
    const block = this._block();
    let text = sanitizeTerminalOutput(run.raw, block?.fenceChar, block?.fenceLength);
    let truncated = run.truncated;
    if (text.length > this._maxOutput) {
      const cut = text.lastIndexOf('\n', this._maxOutput);
      text = text.slice(0, cut > 0 ? cut + 1 : this._maxOutput);
      truncated = true;
    }
    if (truncated) text += `${text.endsWith('\n') || text === '' ? '' : '\n'}[output truncated]`;
    // Always end on a line break, so a partial line never runs into the closing fence.
    if (text !== '' && !text.endsWith('\n')) text += '\n';
    if (final && trailer) text += `${trailer}\n`;
    if (text === run.written) return;
    let p = 0;
    const max = Math.min(text.length, run.written.length);
    while (p < max && text[p] === run.written[p]) p++;
    const doc = this.client.document;
    const from = run.outStart + p;
    const length = run.outEnd - from;
    if (from > doc.length || length < 0 || run.outEnd > doc.length) return;
    this._edit(() => this.client.replace(from, length, text.slice(p)));
    run.outEnd = run.outStart + text.length;
    run.written = text;
  }

  private _finish(code: number | null, note = ''): void {
    const run = this._running;
    if (!run) return;
    if (run.timer) clearTimeout(run.timer);
    if (this._flushTimer) clearInterval(this._flushTimer);
    this._flushTimer = null;
    const trailer = note || (code !== null && code !== 0 ? `[exit ${code}]` : '');
    this._flushOutput(true, trailer);
    this._running = null;

    if (this._started) {
      const at = Math.min(run.outEnd, this.client.document.length);
      this._edit(() => this.client.insert(at, `${PROMPT}\n`));
      this._setIdle(at, at + PROMPT.length + 1);
    }
    this.emit('done', {
      command: run.command,
      user: run.user,
      code,
      durationMs: Date.now() - run.startedAt,
      timedOut: run.timedOut,
    } satisfies TerminalDoneEvent);
    // Input may have arrived while the command ran.
    if (this._started) this._schedule();
  }
}
