/**
 * Keystroke-level sync between a HedgeDocClient and an external editor
 * process (e.g. Neovim) that speaks a small line-oriented JSON protocol.
 *
 * The editor and the bridge run in different processes, so a remote edit can
 * be on its way to the editor while the user types. The bridge resolves this
 * with a second, editor-side OT link (Jupiter style, all transforming happens
 * here, the editor never transforms):
 *
 * - The editor counts the changes it sends (E) and remembers the sequence
 *   number of the last remote edit it applied (R). Each change carries
 *   `seen: R`.
 * - Every remote edit sent to the editor carries `seq` and `base`, the number
 *   of editor changes the bridge had processed when it sent it. The editor
 *   applies it only if `base === E`, i.e. it has typed nothing since, and
 *   drops it otherwise.
 * - When a change arrives, remote edits up to `seen` were applied by the
 *   editor; later ones were (or will be) dropped. The bridge transforms the
 *   change against those, then resends them, transformed past the change,
 *   with fresh sequence numbers and the new base.
 *
 * Positions on the wire are Neovim-style: zero-based rows and byte columns,
 * in a model where every line ends with a newline (as `on_bytes` reports
 * them). The note text is the buffer's lines joined with "\n", so a note
 * ending in "\n" shows as a last empty line. HedgeDoc positions are UTF-16
 * offsets; the bridge converts.
 *
 * Editor -> bridge:
 *   {t:'change', epoch, seen, sr, sc, oer, oec, text, size}
 *       one on_bytes event: start row/col, old extent (rows, and col relative
 *       to sr when oer is 0), the new text, and the buffer size in bytes
 *       afterwards (a cheap consistency check)
 *   {t:'cursor', epoch, seen, row, col} / {t:'cursor', row: null}
 *   {t:'desync'}  the editor could not apply something; ask for a reset
 * Bridge -> editor:
 *   {t:'reset', epoch, seq, text}  replace the buffer; E = 0, R = seq
 *   {t:'edit', seq, base, edits: [{sr, sc, er, ec, text}]}
 *       absolute ranges, last range first, so each applies as is
 *   {t:'cursors', cursors: [{id, name, color, row?, col?}]}  everyone else
 *       online; row/col only while their cursor is in the note
 *   {t:'ready', protocol, version, url, noteId, title, editable}
 *   {t:'status' | 'error' | 'note' ...} sent by the CLI wrapper
 */

import { TextOperation } from './text-operation.js';
import { cursorFromIndex, indexFromCursor, type CursorPosition } from './cursor.js';
import type { ChangeEvent, UserInfo } from './hedgedoc-client.js';

/**
 * Version of the editor protocol. Bump it on any incompatible change; the
 * bridge reports it in its `ready` message and `hedgesync bridge --info`, and
 * plugins refuse to run against a different one.
 */
export const BRIDGE_PROTOCOL = 1;

/** What the bridge needs from a HedgeDocClient. */
export interface BridgeClient {
  getDocument(): string;
  applyOperation(operation: TextOperation): void;
  setCursor(cursor: CursorPosition | null): void;
  readonly users: Map<string, UserInfo>;
  /** This connection (HedgeDoc 1): its own entry in `users` is skipped. */
  readonly socket?: { id?: string } | null;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
}

export interface EditorChange {
  t: 'change';
  epoch: number;
  seen: number;
  sr: number;
  sc: number;
  oer: number;
  oec: number;
  text: string;
  size: number;
}

export interface EditorCursor {
  t: 'cursor';
  epoch?: number;
  seen?: number;
  row: number | null;
  col?: number;
}

export type EditorMessage = EditorChange | EditorCursor | { t: 'desync' } | { t: string; [key: string]: unknown };

export interface WireEdit {
  sr: number;
  sc: number;
  er: number;
  ec: number;
  text: string;
}

export type BridgeMessage =
  | { t: 'reset'; epoch: number; seq: number; text: string }
  | { t: 'edit'; seq: number; base: number; edits: WireEdit[] }
  | CursorMessage;

/** Everyone else in the note; row/col (bytes) only for those with a cursor in it. */
export interface CursorMessage {
  t: 'cursors';
  cursors: Array<{ id: string; name: string; color: string; row?: number; col?: number }>;
}

export interface EditorBridgeOptions {
  /** Called when local edits cannot be submitted (e.g. no edit permission). */
  onSubmitError?: (error: Error) => void;
  /** Called when the editor's buffer is found out of step and gets reset. */
  onDesync?: (reason: string) => void;
}

interface Pending {
  seq: number;
  op: TextOperation;
}

export class EditorBridge {
  /** Text the editor has once it applied every acknowledged remote edit. */
  private editorText = '';
  /** Remote edits sent but not yet acknowledged; each based on the previous one's result, the first on editorText. */
  private pending: Pending[] = [];
  /** editorText with all pending applied: what the editor converges to. Equals the client document plus `held`. */
  private view = '';
  /** Local edits the client could not take yet (disconnected), based on the client document. */
  private held: TextOperation | null = null;
  private seq = 0;
  private epoch = 0;
  /** Editor changes processed in this epoch. */
  private editorChanges = 0;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(
    private readonly client: BridgeClient,
    private readonly send: (message: BridgeMessage) => void,
    private readonly options: EditorBridgeOptions = {},
  ) {}

  /** Push the document to the editor and start forwarding remote changes. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.client.on('change', this.onClientChange);
    this.client.on('ready', this.flushHeld);
    for (const event of ['cursor:focus', 'cursor:activity', 'cursor:blur', 'users', 'user:left']) {
      this.client.on(event, this.scheduleCursors);
    }
    this.reset();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.client.off?.('change', this.onClientChange);
    this.client.off?.('ready', this.flushHeld);
    for (const event of ['cursor:focus', 'cursor:activity', 'cursor:blur', 'users', 'user:left']) {
      this.client.off?.(event, this.scheduleCursors);
    }
    if (this.cursorTimer) clearTimeout(this.cursorTimer);
  }

  /** Whether some local edits are not yet with the client (it was disconnected). */
  hasHeldEdits(): boolean {
    return this.held !== null && !this.held.isNoop();
  }

  /** Replace the editor's buffer with the current text; changes it sent before are dropped. */
  reset(): void {
    this.epoch++;
    this.editorChanges = 0;
    this.pending = [];
    this.editorText = this.view = this.currentView();
    this.send({ t: 'reset', epoch: this.epoch, seq: ++this.seq, text: this.view });
  }

  /** Handle one message from the editor. */
  handle(message: EditorMessage): void {
    this.handleBatch([message]);
  }

  /**
   * Handle messages that arrived together. Rebased remote edits are resent
   * once at the end rather than after every change, so a burst of changes
   * (a macro, :%s) does not resend everything once per change.
   */
  handleBatch(messages: EditorMessage[]): void {
    let resend = false;
    for (const message of messages) {
      switch (message.t) {
        case 'change':
          resend = this.onEditorChange(message as EditorChange) || resend;
          break;
        case 'cursor':
          this.onEditorCursor(message as EditorCursor);
          break;
        case 'desync':
          this.desync('editor reported a failed edit');
          resend = false;
          break;
      }
    }
    this.flushHeld();
    if (resend) this.resendPending();
  }

  // ------------------------------------------------------------------
  // Editor -> HedgeDoc
  // ------------------------------------------------------------------

  /** Returns whether pending remote edits must be resent (the editor drops them now). */
  private onEditorChange(change: EditorChange): boolean {
    if (change.epoch !== this.epoch) return false; // made before a reset the editor had not seen yet
    this.acknowledge(change.seen);
    this.editorChanges++;

    const model = this.editorText + '\n';
    const start = indexFromPos(model, change.sr, change.sc);
    const endRow = change.sr + change.oer;
    const end = indexFromPos(model, endRow, change.oer === 0 ? change.sc + change.oec : change.oec);
    if (start === null || end === null || end < start) {
      this.desync(`change out of range (${change.sr}:${change.sc} +${change.oer}:${change.oec})`);
      return false;
    }
    const newModel = model.slice(0, start) + change.text + model.slice(end);
    if (!newModel.endsWith('\n') || utf8Length(newModel) !== change.size) {
      this.desync(`size mismatch (editor ${change.size} bytes, bridge ${utf8Length(newModel)})`);
      return false;
    }
    const before = this.editorText;
    const after = newModel.slice(0, -1);
    // The model's last character (the final newline) is not part of the note.
    let op = minimalOperation(before, after, start, model.length - end - 1);
    this.editorText = after;

    if (!op.isNoop()) {
      // Bring the change past the remote edits the editor has not applied.
      for (const p of this.pending) {
        const [opPrime, pPrime] = TextOperation.transform(op, p.op);
        op = opPrime;
        p.op = pPrime;
      }
      this.view = op.apply(this.view);
      this.held = this.held ? this.held.compose(op) : op;
    }
    // Even a change that altered nothing bumped the editor's count, so the
    // editor will drop what is in flight.
    return this.pending.length > 0;
  }

  /** Resend unacknowledged remote edits, rebased onto the editor's text, with the current base. */
  private resendPending(): void {
    let text = this.editorText;
    for (const p of this.pending) {
      p.seq = ++this.seq;
      this.send({ t: 'edit', seq: p.seq, base: this.editorChanges, edits: toWireEdits(text, p.op) });
      text = p.op.apply(text);
    }
  }

  private onEditorCursor(cursor: EditorCursor): void {
    if (cursor.row === null || cursor.row === undefined) {
      this.client.setCursor(null);
      return;
    }
    if (cursor.epoch !== undefined && cursor.epoch !== this.epoch) return;
    if (cursor.seen !== undefined) this.acknowledge(cursor.seen);
    let index = indexFromPos(this.editorText + '\n', cursor.row, cursor.col ?? 0);
    if (index === null) return;
    index = Math.min(index, this.editorText.length);
    for (const p of this.pending) index = TextOperation.transformPosition(index, p.op);
    if (this.held) index = invertPosition(index, this.held);
    this.client.setCursor(cursorFromIndex(this.client.getDocument(), index));
  }

  /** Remote edits up to `seen` were applied by the editor. */
  private acknowledge(seen: number): void {
    while (this.pending.length > 0 && this.pending[0].seq <= seen) {
      this.editorText = this.pending.shift()!.op.apply(this.editorText);
    }
  }

  private readonly flushHeld = (): void => {
    if (!this.held) return;
    if (this.held.isNoop()) {
      this.held = null;
      return;
    }
    try {
      this.client.applyOperation(this.held);
      this.held = null;
    } catch (err) {
      // Not connected right now: keep the edits and retry on 'ready'.
      if (!/not ready/i.test((err as Error).message)) this.options.onSubmitError?.(err as Error);
    }
  };

  private desync(reason: string): void {
    this.options.onDesync?.(reason);
    this.reset();
  }

  // ------------------------------------------------------------------
  // HedgeDoc -> editor
  // ------------------------------------------------------------------

  private readonly onClientChange = (event: ChangeEvent): void => {
    if (event.type !== 'remote') return;
    let op = event.operation;
    if (this.held) {
      const [heldPrime, opPrime] = TextOperation.transform(this.held, op);
      this.held = heldPrime;
      op = opPrime;
    }
    if (op.isNoop()) return;
    const base = this.view;
    this.view = op.apply(base);
    const seq = ++this.seq;
    this.pending.push({ seq, op });
    this.send({ t: 'edit', seq, base: this.editorChanges, edits: toWireEdits(base, op) });
    this.scheduleCursors();
  };

  private currentView(): string {
    const doc = this.client.getDocument();
    return this.held ? this.held.apply(doc) : doc;
  }

  private readonly scheduleCursors = (): void => {
    if (this.cursorTimer) return;
    this.cursorTimer = setTimeout(() => {
      this.cursorTimer = null;
      this.sendCursors();
    }, 30);
  };

  private sendCursors(): void {
    if (!this.started) return;
    const doc = this.client.getDocument();
    const lines = this.view.split('\n');
    const cursors: CursorMessage['cursors'] = [];
    // The server lists this connection too, with the cursor we sent it.
    const self = this.client.socket?.id;
    for (const user of this.client.users.values()) {
      if (user.id === self) continue;
      const who = { id: user.id, name: user.name || 'Guest', color: user.color || '#888888' };
      if (!user.cursor) {
        cursors.push(who); // online, but not in the editor right now
        continue;
      }
      // Positions are in the client document; map through held local edits.
      let index = indexFromCursor(doc, user.cursor);
      if (this.held) index = TextOperation.transformPosition(index, this.held);
      const { line, ch } = cursorFromIndex(this.view, index);
      cursors.push({
        ...who,
        row: line,
        col: utf8Length(lines[line]?.slice(0, ch) ?? ''),
      });
    }
    this.send({ t: 'cursors', cursors });
  }

  /** @internal For tests: the text the editor should end up with. */
  get expectedEditorText(): string {
    return this.view;
  }
}

// ----------------------------------------------------------------------
// Position helpers (exported for tests)
// ----------------------------------------------------------------------

export function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** UTF-16 offset of a row and byte column in `text`, or null if out of range. */
export function indexFromPos(text: string, row: number, byteCol: number): number | null {
  if (row < 0 || byteCol < 0) return null;
  let lineStart = 0;
  for (let r = 0; r < row; r++) {
    const nl = text.indexOf('\n', lineStart);
    if (nl === -1) return null;
    lineStart = nl + 1;
  }
  const nl = text.indexOf('\n', lineStart);
  const lineEnd = nl === -1 ? text.length : nl + 1; // a column may point at the newline itself
  let bytes = 0;
  let i = lineStart;
  while (bytes < byteCol) {
    if (i >= lineEnd) return null;
    const code = text.codePointAt(i)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    i += code >= 0x10000 ? 2 : 1;
  }
  return i;
}

/** Row and byte column of a UTF-16 offset in `text`. */
export function posFromIndex(text: string, index: number): { row: number; col: number } {
  let row = 0;
  let lineStart = 0;
  for (let nl = text.indexOf('\n'); nl !== -1 && nl < index; nl = text.indexOf('\n', nl + 1)) {
    row++;
    lineStart = nl + 1;
  }
  return { row, col: utf8Length(text.slice(lineStart, index)) };
}

/** A TextOperation as editor ranges on `base`, last range first. */
export function toWireEdits(base: string, op: TextOperation): WireEdit[] {
  const ranges: Array<{ start: number; end: number; text: string }> = [];
  let index = 0;
  let current: { start: number; end: number; text: string } | null = null;
  for (const part of op.ops) {
    if (TextOperation.isRetain(part)) {
      if (current) ranges.push(current);
      current = null;
      index += part;
    } else if (TextOperation.isInsert(part)) {
      current ??= { start: index, end: index, text: '' };
      current.text += part;
    } else {
      current ??= { start: index, end: index, text: '' };
      current.end += -part;
      index += -part;
    }
  }
  if (current) ranges.push(current);
  return ranges.reverse().map(({ start, end, text }) => {
    const s = posFromIndex(base, start);
    const e = posFromIndex(base, end);
    return { sr: s.row, sc: s.col, er: e.row, ec: e.col, text };
  });
}

/**
 * The operation turning `before` into `after`, given that their first
 * `prefix` and last `suffix` characters (at most) are known to match.
 */
function minimalOperation(before: string, after: string, prefix: number, suffix: number): TextOperation {
  const p = Math.min(prefix, before.length, after.length);
  const s = Math.max(0, Math.min(suffix, before.length - p, after.length - p));
  return new TextOperation()
    .retain(p)
    .delete(before.length - p - s)
    .insert(after.slice(p, after.length - s))
    .retain(s);
}

/** Map an offset in `op`'s result back to its base (clamped into deletions/insertions). */
function invertPosition(index: number, op: TextOperation): number {
  let base = 0;
  let target = 0;
  for (const part of op.ops) {
    if (TextOperation.isRetain(part)) {
      if (index <= target + part) return base + (index - target);
      base += part;
      target += part;
    } else if (TextOperation.isInsert(part)) {
      if (index <= target + part.length) return base;
      target += part.length;
    } else {
      base += -part;
    }
  }
  return base;
}
