/**
 * PrankEngine - mischief for live HedgeDoc notes.
 *
 * The engine watches remote edits and lets each registered prank answer an
 * edit with edits of its own. Pranks only ever see remote edits (optionally
 * only from chosen users), so the engine's own output never feeds back into
 * it. Answers are applied just after the change event (editing inside it would
 * corrupt the client's OT state), rebased past anything that arrived meanwhile.
 */

import { TextOperation } from './text-operation.js';

/** The subset of HedgeDocClient the engine needs. */
export interface PrankClientLike {
  getDocument(): string;
  applyOperation(operation: TextOperation): void;
  on(event: string, handler: (...args: any[]) => void): unknown;
  off(event: string, handler: (...args: any[]) => void): unknown;
}

interface PrankUser {
  userid?: string | null;
  name?: string;
}

interface ChangeEvent {
  type: 'local' | 'remote';
  operation?: TextOperation;
  user?: PrankUser;
}

/** One piece of a remote edit, in coordinates of the document after the edit. */
export type EditPiece =
  | { type: 'insert'; index: number; text: string }
  | { type: 'delete'; index: number; length: number };

/** An edit a prank wants to make, in coordinates of the document after the remote edit. */
export type PrankEdit =
  | { type: 'insert'; index: number; text: string }
  | { type: 'delete'; index: number; length: number };

export interface PrankContext {
  /** The document after the remote edit. */
  document: string;
  /** Who made the edit, if known. */
  user?: PrankUser;
  /** Random number in [0, 1); injectable for tests. */
  random: () => number;
}

export interface Prank {
  name: string;
  /** Answer one remote edit. Returned edits must not overlap. */
  react(pieces: EditPiece[], ctx: PrankContext): PrankEdit[];
}

export interface PrankEngineOptions {
  /** Only edits by these HedgeDoc account ids are pranked. */
  allowedUserIds?: string[];
  /** Only edits by users whose display name matches are pranked. */
  userFilter?: RegExp;
  random?: () => number;
}

/** A pranked edit, for logging. */
export interface PrankEvent {
  prank: string;
  user?: PrankUser;
  edits: PrankEdit[];
}

/** Split an operation into its inserts and deletes, positioned in the new document. */
export function editPieces(op: TextOperation): EditPiece[] {
  const pieces: EditPiece[] = [];
  let index = 0; // position in the new document
  for (const o of op.ops) {
    if (typeof o === 'string') {
      pieces.push({ type: 'insert', index, text: o });
      index += o.length;
    } else if (o > 0) {
      index += o;
    } else if (o < 0) {
      pieces.push({ type: 'delete', index, length: -o });
    }
  }
  return pieces;
}

export class PrankEngine {
  private readonly pranks: Prank[] = [];
  private readonly allowedUserIds?: Set<string>;
  private readonly userFilter?: RegExp;
  private readonly random: () => number;
  private readonly listeners = new Set<(event: PrankEvent) => void>();
  private readonly changeHandler = (event: ChangeEvent) => this.onChange(event);
  private running = false;
  private pending: { op: TextOperation; events: PrankEvent[] } | null = null;

  constructor(private readonly client: PrankClientLike, options: PrankEngineOptions = {}) {
    if (options.allowedUserIds?.length) this.allowedUserIds = new Set(options.allowedUserIds);
    this.userFilter = options.userFilter;
    this.random = options.random ?? Math.random;
  }

  add(prank: Prank): this {
    this.pranks.push(prank);
    return this;
  }

  list(): string[] {
    return this.pranks.map(p => p.name);
  }

  /** Called after each prank that changed the note. */
  onPrank(listener: (event: PrankEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): this {
    if (!this.running) {
      this.client.on('change', this.changeHandler);
      this.running = true;
    }
    return this;
  }

  stop(): void {
    if (this.running) {
      this.client.off('change', this.changeHandler);
      this.running = false;
    }
    this.pending = null;
  }

  private isTarget(user?: PrankUser): boolean {
    if (this.allowedUserIds && !(user?.userid && this.allowedUserIds.has(user.userid))) return false;
    if (this.userFilter && !this.userFilter.test(user?.name ?? '')) return false;
    return true;
  }

  private onChange(event: ChangeEvent): void {
    if (!event.operation) return;
    // Anything that lands before the flush (ours or anyone's) moves the pending edits.
    if (this.pending) this.pending.op = TextOperation.transform(this.pending.op, event.operation)[0];
    if (event.type !== 'remote' || !this.isTarget(event.user)) return;

    const pieces = editPieces(event.operation);
    let document = this.client.getDocument();
    let op = new TextOperation().retain(document.length);
    const fired: PrankEvent[] = [];
    for (const prank of this.pranks) {
      // Each prank sees the document as left by the previous one.
      const edits = prank.react(pieces, { document, user: event.user, random: this.random });
      if (edits.length === 0) continue;
      const step = editsToOperation(edits, document.length);
      document = step.apply(document);
      op = op.compose(step);
      shiftPieces(pieces, edits);
      fired.push({ prank: prank.name, user: event.user, edits });
    }
    if (fired.length === 0) return;

    if (this.pending) {
      // Both are based on the current document; merge them.
      const ownOp = TextOperation.transform(this.pending.op, op)[1];
      this.pending.op = this.pending.op.compose(ownOp);
      this.pending.events.push(...fired);
      return;
    }
    // The client is still inside its own handling of this remote edit; editing
    // right now would corrupt its OT state, so apply once it has finished.
    this.pending = { op, events: fired };
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending || !this.running) return;
    try {
      if (!pending.op.isNoop()) this.client.applyOperation(pending.op);
    } catch {
      return; // disconnected or read-only meanwhile: the prank just doesn't happen
    }
    for (const e of pending.events) for (const l of this.listeners) l(e);
  }
}

/** Build one operation from non-overlapping edits against a document of `length`. */
function editsToOperation(edits: PrankEdit[], length: number): TextOperation {
  const sorted = [...edits].sort((a, b) => a.index - b.index || (a.type === 'insert' ? -1 : 1));
  const op = new TextOperation();
  let at = 0;
  for (const e of sorted) {
    op.retain(e.index - at);
    at = e.index;
    if (e.type === 'insert') op.insert(e.text);
    else {
      op.delete(e.length);
      at += e.length;
    }
  }
  return op.retain(length - at);
}

function shiftPieces(pieces: EditPiece[], edits: PrankEdit[]): void {
  for (const p of pieces) {
    let shift = 0;
    for (const e of edits) {
      if (e.type === 'insert' && e.index <= p.index) shift += e.text.length;
      else if (e.type === 'delete' && e.index < p.index) shift -= Math.min(e.length, p.index - e.index);
    }
    p.index += shift;
  }
}

// ===========================================
// Pranks
// ===========================================

export interface StutterOptions {
  /** Chance (0..1) that a typed character is doubled. */
  probability: number;
  /** Also double deletions: each deleted character may take its left neighbour with it. */
  deletes?: boolean;
  /**
   * Inserts longer than this many characters count as pastes and are left
   * alone. Keystrokes typed while the server is busy reach us composed into
   * one insert, so this is more than 1. Default 10.
   */
  maxInsertLength?: number;
}

/**
 * Stutter: every typed character has a chance of appearing twice, and with
 * `deletes`, every backspace has a chance of eating one more character.
 */
export function stutter(options: StutterOptions): Prank {
  const { probability, deletes = false, maxInsertLength = 10 } = options;
  return {
    name: 'stutter',
    react(pieces, ctx) {
      const edits: PrankEdit[] = [];
      for (const p of pieces) {
        if (p.type === 'insert') {
          const chars = Array.from(p.text);
          if (chars.length > maxInsertLength) continue;
          let offset = p.index;
          for (const ch of chars) {
            offset += ch.length;
            if (ctx.random() < probability) edits.push({ type: 'insert', index: offset, text: ch });
          }
        } else if (deletes && p.index > 0) {
          if (ctx.random() >= probability) continue;
          // One more character to the left, as if backspace was pressed twice.
          // Step over a whole surrogate pair rather than splitting it.
          const prev = Array.from(ctx.document.slice(Math.max(0, p.index - 2), p.index)).pop() ?? '';
          if (prev) edits.push({ type: 'delete', index: p.index - prev.length, length: prev.length });
        }
      }
      return edits;
    },
  };
}
