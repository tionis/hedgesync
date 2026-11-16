/**
 * NoteAssistant: answers `@name ...` requests written into a note.
 *
 * Someone writes a paragraph mentioning `@claude` (or whatever the name
 * is); once typing pauses, the assistant claims the request by inserting a
 * reply quote below it, asks the agent, and streams the answer into that
 * quote, with its cursor following along:
 *
 *   @claude what changed in the plan since Monday?
 *
 *   > **claude:** The deadline moved to Friday, and ...
 *
 * A request counts as answered when the next paragraph is such a quote, so
 * the note itself is the state: restarting the assistant, or someone
 * deleting a reply to have it asked again, just works. The agent is any
 * function from a request to a stream of text (see src/agents.ts).
 */

import { EventEmitter } from 'node:events';
import { cursorFromIndex } from './cursor.js';
import type { ChangeEvent } from './hedgedoc-client.js';
import type { UserInfo } from './drivers/types.js';
import { TextOperation } from './text-operation.js';

export interface AgentRequest {
  /** The note's text when the request was taken (the reply placeholder included). */
  note: string;
  url: string;
  /** The paragraph with the mention. */
  request: string;
  /** Who wrote it, when known. */
  user?: string;
  /** The assistant's name, as mentioned. */
  name: string;
  signal: AbortSignal;
}

/** Produces the answer as it is generated. */
export type Agent = (request: AgentRequest) => AsyncIterable<string>;

export interface AssistantClient {
  getDocument(): string;
  updateContent(text: string): unknown;
  setCursor(position: { line: number; ch: number } | null): unknown;
  flush(timeoutMs?: number): Promise<unknown>;
  canEdit(): boolean;
  on(event: 'change', listener: (event: ChangeEvent) => void): unknown;
  off(event: 'change', listener: (event: ChangeEvent) => void): unknown;
}

export interface NoteAssistantOptions {
  name: string;
  agent: Agent;
  url: string;
  /** Typing must pause this long before a request is taken (default 2000 ms). */
  settleMs?: number;
  /** Who may ask; by default everyone who can edit the note. */
  allow?: (user: string | undefined) => boolean;
  /** Also answer requests already in the note at start (default: only new ones). */
  answerExisting?: boolean;
  /** How often the reply is updated while the answer streams (default 300 ms). */
  updateMs?: number;
}

export interface Request {
  text: string;
  start: number;
  end: number;
  answered: boolean;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The paragraphs of a note (code fences kept whole), with offsets. */
function blocks(doc: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  let fence: string | null = null;
  let start = -1;
  let at = 0;
  const lines = doc.split('\n');
  lines.forEach((line, i) => {
    const lineEnd = at + line.length;
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) fence = fence ? (line.trim().startsWith(fence) && /^[`~]+$/.test(line.trim()) ? null : fence) : f[1];
    const blank = !fence && !f && line.trim() === '';
    if (!blank && start < 0) start = at;
    if ((blank || i === lines.length - 1) && start >= 0) {
      const end = blank ? at - 1 : lineEnd;
      out.push({ text: doc.slice(start, Math.max(start, end)), start, end: Math.max(start, end) });
      start = -1;
    }
    at = lineEnd + 1;
  });
  return out;
}

/** The `@name` requests in a note, and whether each is answered. */
export function findRequests(doc: string, name: string): Request[] {
  const mention = new RegExp(`(^|[^\\w@])@${escape(name)}(?![\\w-])`, 'i');
  const reply = new RegExp(`^>\\s*\\*\\*${escape(name)}:\\*\\*`, 'i');
  const all = blocks(doc);
  const out: Request[] = [];
  all.forEach((b, i) => {
    if (/^\s*(`{3,}|~{3,})/.test(b.text) || reply.test(b.text) || !mention.test(b.text)) return;
    out.push({ ...b, answered: i + 1 < all.length && reply.test(all[i + 1].text) });
  });
  return out;
}

/** A reply as a quote: `> **name:** first line`, then `> ` lines. */
export function formatReply(name: string, text: string, marker = ''): string {
  const lines = (text.trimEnd() || '…').split('\n');
  return [`> **${name}:** ${marker}${lines[0]}`, ...lines.slice(1).map(l => (l ? `> ${l}` : '>'))].join('\n');
}

/** Where the quote containing `marker` is: from its first line to its last `>` line. */
function replyRange(doc: string, marker: string): { start: number; end: number } | null {
  const at = doc.indexOf(marker);
  if (at < 0) return null;
  const start = doc.lastIndexOf('\n', at) + 1;
  let end = doc.indexOf('\n', at);
  if (end < 0) return { start, end: doc.length };
  while (end < doc.length) {
    const next = doc.indexOf('\n', end + 1);
    const line = doc.slice(end + 1, next < 0 ? doc.length : next);
    if (!line.startsWith('>')) break;
    end = next < 0 ? doc.length : next;
  }
  return { start, end };
}

interface Span { start: number; end: number; user?: string }

export class NoteAssistant extends EventEmitter {
  private readonly settleMs: number;
  private readonly updateMs: number;
  private readonly ignored = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private stopped = true;
  private abort: AbortController | null = null;
  /** Recent insertions by others, kept in current coordinates, to tell who wrote a request. */
  private spans: Span[] = [];
  private seq = 0;

  constructor(private readonly client: AssistantClient, private readonly options: NoteAssistantOptions) {
    super();
    this.settleMs = options.settleMs ?? 2000;
    this.updateMs = options.updateMs ?? 300;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (!this.options.answerExisting) {
      for (const r of findRequests(this.client.getDocument(), this.options.name)) if (!r.answered) this.ignored.add(r.text);
    }
    this.client.on('change', this.onChange);
    if (this.options.answerExisting) this.schedule();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.client.off('change', this.onChange);
    this.abort?.abort();
  }

  private onChange = (event: ChangeEvent) => {
    const tp = TextOperation.transformPosition;
    this.spans = this.spans.map(s => ({ ...s, start: tp(s.start, event.operation), end: tp(s.end, event.operation) }));
    if (event.type !== 'remote') return;
    let index = 0;
    for (const op of event.operation.ops) {
      if (TextOperation.isRetain(op)) index += op;
      else if (TextOperation.isInsert(op)) {
        this.spans.push({ start: index, end: index + op.length, user: userName(event.user) });
        index += op.length;
      }
    }
    if (this.spans.length > 500) this.spans = this.spans.slice(-500);
    this.schedule();
  };

  private schedule(): void {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.check(), this.settleMs);
  }

  /** Who last typed in [start, end). */
  private authorOf(start: number, end: number): string | undefined {
    for (let i = this.spans.length - 1; i >= 0; i--) {
      const s = this.spans[i];
      if (s.end > start && s.start < end) return s.user;
    }
    return undefined;
  }

  private async check(): Promise<void> {
    if (this.busy || this.stopped || !this.client.canEdit()) return;
    const doc = this.client.getDocument();
    const request = findRequests(doc, this.options.name).find(r => !r.answered && !this.ignored.has(r.text));
    if (!request) return;
    const user = this.authorOf(request.start, request.end);
    if (this.options.allow && !this.options.allow(user)) {
      this.ignored.add(request.text);
      this.emit('refused', { request: request.text, user });
      this.schedule();
      return;
    }
    this.busy = true;
    try {
      await this.answer(request, user);
    } finally {
      this.busy = false;
      this.abort = null;
    }
    this.schedule(); // another request may be waiting
  }

  private async answer(request: Request, user: string | undefined): Promise<void> {
    const { name } = this.options;
    const marker = `<!-- hedgesync:${process.pid}:${++this.seq} --> `;
    // Claim it: a placeholder reply right below the request.
    const doc = this.client.getDocument();
    const placeholder = formatReply(name, '_…_', marker);
    const next = doc.slice(request.end);
    // A blank line before the reply, and one after it unless the note ends there.
    const rest = next.trim() === '' ? '\n' : (next.startsWith('\n\n') ? '' : next.startsWith('\n') ? '\n' : '\n\n') + next;
    this.client.updateContent(doc.slice(0, request.end) + '\n\n' + placeholder + rest);
    await this.client.flush();
    this.emit('request', { request: request.text, user });

    const write = (text: string, done: boolean): boolean => {
      const current = this.client.getDocument();
      const range = replyRange(current, marker);
      if (!range) return false; // someone deleted the reply: give up on this request
      const reply = formatReply(name, text, done ? '' : marker);
      this.client.updateContent(current.slice(0, range.start) + reply + current.slice(range.end));
      const after = this.client.getDocument();
      this.client.setCursor(cursorFromIndex(after, range.start + reply.length));
      return true;
    };

    this.abort = new AbortController();
    let text = '';
    let last = 0;
    try {
      for await (const chunk of this.options.agent({ note: this.client.getDocument(), url: this.options.url, request: request.text, user, name, signal: this.abort.signal })) {
        text += chunk;
        if (Date.now() - last >= this.updateMs) {
          last = Date.now();
          if (!write(text, false)) {
            this.abort.abort();
            this.emit('cancelled', { request: request.text });
            return;
          }
        }
      }
      if (!text.trim()) text = '_(no answer)_';
    } catch (err) {
      if (this.stopped) return;
      text = `${text}${text ? '\n\n' : ''}⚠ ${(err as Error).message}`;
      this.emit('error', err);
    }
    write(text, true);
    await this.client.flush();
    this.emit('answered', { request: request.text, user, length: text.length });
  }
}

function userName(user: UserInfo | undefined): string | undefined {
  return user?.name || undefined;
}
