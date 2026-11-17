/**
 * PrankEngine - mischief for live HedgeDoc notes.
 *
 * Pranks react to remote edits (`react`, answering with edits of their own)
 * and/or run on their own schedule (`start`, using the PrankApi). Pranks only
 * ever see remote edits (optionally only from chosen users), so the engine's
 * own output never feeds back into it.
 *
 * Editing inside the client's change event would corrupt its OT state, so
 * answers made there are applied in a microtask, rebased past anything that
 * arrived meanwhile. Positions and operations a prank keeps for later
 * (anchors, tracked operations) follow every edit to the note.
 */

import { TextOperation } from '../text-operation.js';
import { cursorFromIndex, indexFromCursor, type CursorPosition } from '../cursor.js';

export interface PrankUser {
  id?: string;
  userid?: string | null;
  name?: string;
  cursor?: CursorPosition | null;
}

/** The subset of HedgeDocClient the engine needs. */
export interface PrankClientLike {
  getDocument(): string;
  applyOperation(operation: TextOperation): void;
  setCursor?(cursor: CursorPosition | null): void;
  readonly users?: Map<string, PrankUser>;
  on(event: string, handler: (...args: any[]) => void): unknown;
  off(event: string, handler: (...args: any[]) => void): unknown;
}

interface ChangeEvent {
  type: 'local' | 'remote';
  operation?: TextOperation;
  clientId?: string;
  user?: PrankUser;
}

/** One piece of a remote edit, in coordinates of the document after the edit. */
export type EditPiece =
  | { type: 'insert'; index: number; text: string }
  /** `text` is the deleted text, when known. */
  | { type: 'delete'; index: number; length: number; text?: string };

/** An edit a prank wants to make, in coordinates of the document it was shown. */
export type PrankEdit =
  | { type: 'insert'; index: number; text: string }
  | { type: 'delete'; index: number; length: number };

export interface PrankContext {
  /** The document after the remote edit (and earlier pranks' answers to it). */
  document: string;
  /** Who made the edit, if known. */
  user?: PrankUser;
  /** The remote edit itself, based on the document before it. */
  operation: TextOperation;
  /** The document before the edit, when known. */
  previous?: string;
  random: () => number;
  api: PrankApi;
}

export interface Prank {
  name: string;
  /**
   * Whose edits this prank reacts to. When set, it replaces the engine's
   * target filter for this prank.
   */
  targets?: (user?: PrankUser) => boolean;
  /** When this prank answers an edit, later pranks leave that edit alone. Runs first. */
  exclusive?: boolean;
  /** Answer one remote edit. Returned edits must not overlap. */
  react?(pieces: EditPiece[], ctx: PrankContext): PrankEdit[];
  start?(api: PrankApi): void;
  stop?(): void;
}

/** A range of the note that follows edits. Inserts at its edges stay outside. */
export class Anchor {
  alive = true;
  constructor(public start: number, public end: number) {}

  transform(op: TextOperation): void {
    const empty = this.start === this.end;
    this.start = TextOperation.transformPosition(this.start, op, true);
    this.end = empty ? this.start : Math.max(this.start, TextOperation.transformPosition(this.end, op, false));
  }
}

/** An operation kept valid against the current note. */
export interface TrackedOperation {
  readonly op: TextOperation;
  release(): void;
}

export interface PrankApi {
  document(): string;
  random(): number;
  /** Apply an operation based on the current document. False if the note can't be edited right now. */
  apply(op: TextOperation): boolean;
  /** Apply edits against the current document. */
  edit(edits: PrankEdit[]): boolean;
  anchor(start: number, end?: number): Anchor;
  release(anchor: Anchor): void;
  /** Keep `op` (based on the current document) valid through later edits. */
  track(op: TextOperation): TrackedOperation;
  /** Show our cursor at a document offset (null hides it). */
  setCursor(index: number | null): void;
  /** Where the most recent victim is: their cursor if known, else their last edit. */
  victimPosition(): number | undefined;
  /** When a victim last edited (ms since epoch), or 0. */
  lastVictimActivity(): number;
  /** setTimeout that is cancelled when the engine stops. */
  later(fn: () => void, ms: number): () => void;
  /** Log something the prank did. */
  report(event: Omit<PrankEvent, 'prank'> & { prank?: string }): void;
}

export interface PrankEngineOptions {
  /** Only edits by these HedgeDoc account ids are pranked. */
  allowedUserIds?: string[];
  /** Only edits by users whose display name matches are pranked. */
  userFilter?: RegExp;
  random?: () => number;
}

/** Something a prank did, for logging. */
export interface PrankEvent {
  prank: string;
  user?: PrankUser;
  edits?: PrankEdit[];
  message?: string;
}

/** Split an operation into its inserts and deletes, positioned in the new document. */
export function editPieces(op: TextOperation, previous?: string): EditPiece[] {
  const pieces: EditPiece[] = [];
  let index = 0; // position in the new document
  let oldIndex = 0;
  for (const o of op.ops) {
    if (typeof o === 'string') {
      pieces.push({ type: 'insert', index, text: o });
      index += o.length;
    } else if (o > 0) {
      index += o;
      oldIndex += o;
    } else if (o < 0) {
      const piece: EditPiece = { type: 'delete', index, length: -o };
      if (previous !== undefined) piece.text = previous.slice(oldIndex, oldIndex - o);
      pieces.push(piece);
      oldIndex -= o;
    }
  }
  return pieces;
}

/** Build one operation from non-overlapping edits against a document of `length`. */
export function editsToOperation(edits: PrankEdit[], length: number): TextOperation {
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

export class PrankEngine {
  private readonly pranks: Prank[] = [];
  private readonly allowedUserIds?: Set<string>;
  private readonly userFilter?: RegExp;
  private readonly random: () => number;
  private readonly listeners = new Set<(event: PrankEvent) => void>();
  private readonly changeHandler = (event: ChangeEvent) => this.onChange(event);
  private readonly resetHandler = () => { this.shadow = this.client.getDocument(); };
  private running = false;
  private pending: { op: TextOperation; events: PrankEvent[] } | null = null;
  /** True while handling a change event: edits must wait for the microtask. */
  private inEvent = false;
  /** The document as of the last change event, to recover deleted text. */
  private shadow = '';
  private readonly anchors = new Set<Anchor>();
  private readonly tracked = new Set<{ op: TextOperation }>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private victim: { anchor: Anchor; clientId?: string; at: number } | null = null;
  readonly api: PrankApi;

  constructor(private readonly client: PrankClientLike, options: PrankEngineOptions = {}) {
    if (options.allowedUserIds?.length) this.allowedUserIds = new Set(options.allowedUserIds);
    this.userFilter = options.userFilter;
    this.random = options.random ?? Math.random;
    this.api = this.makeApi();
  }

  add(prank: Prank): this {
    this.pranks.push(prank);
    // Exclusive pranks run first.
    this.pranks.sort((a, b) => Number(!!b.exclusive) - Number(!!a.exclusive));
    if (this.running) prank.start?.(this.api);
    return this;
  }

  list(): string[] {
    return this.pranks.map(p => p.name);
  }

  /** Called for everything a prank does to the note. */
  onPrank(listener: (event: PrankEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): this {
    if (this.running) return this;
    this.running = true;
    this.shadow = this.client.getDocument();
    this.client.on('change', this.changeHandler);
    this.client.on('ready', this.resetHandler);
    for (const p of this.pranks) p.start?.(this.api);
    return this;
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.client.off('change', this.changeHandler);
    this.client.off('ready', this.resetHandler);
    for (const p of this.pranks) p.stop?.();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.anchors.clear();
    this.tracked.clear();
    this.pending = null;
    this.victim = null;
  }

  isTarget(user?: PrankUser): boolean {
    if (this.allowedUserIds && !(user?.userid && this.allowedUserIds.has(user.userid))) return false;
    if (this.userFilter && !this.userFilter.test(user?.name ?? '')) return false;
    return true;
  }

  private emit(event: PrankEvent): void {
    for (const l of this.listeners) l(event);
  }

  private onChange(event: ChangeEvent): void {
    const operation = event.operation;
    if (!operation) return;
    const previous = this.shadow.length === operation.baseLength ? this.shadow : undefined;
    this.shadow = this.client.getDocument();
    for (const a of this.anchors) a.transform(operation);
    for (const t of this.tracked) t.op = TextOperation.transform(t.op, operation)[0];
    // Anything that lands before the flush (ours or anyone's) moves the pending edits.
    if (this.pending) this.pending.op = TextOperation.transform(this.pending.op, operation)[0];
    if (event.type !== 'remote' || !this.running) return;

    this.inEvent = true;
    try {
      this.react(event, operation, previous);
    } finally {
      this.inEvent = false;
    }
  }

  private react(event: ChangeEvent, operation: TextOperation, previous: string | undefined): void {
    const pieces = editPieces(operation, previous);
    if (pieces.length === 0) return;
    if (this.isTarget(event.user)) {
      const last = pieces[pieces.length - 1];
      const at = last.index + (last.type === 'insert' ? last.text.length : 0);
      if (this.victim) this.anchors.delete(this.victim.anchor);
      this.victim = { anchor: this.api.anchor(at), clientId: event.clientId, at: Date.now() };
    }

    let document = this.client.getDocument();
    let op = new TextOperation().retain(document.length);
    const fired: PrankEvent[] = [];
    for (const prank of this.pranks) {
      if (!prank.react) continue;
      if (!(prank.targets ? prank.targets(event.user) : this.isTarget(event.user))) continue;
      // Each prank sees the document as left by the previous one.
      const edits = prank.react(pieces, {
        document, user: event.user, operation, previous, random: this.random, api: this.api,
      });
      if (edits.length === 0) continue;
      const step = editsToOperation(edits, document.length);
      document = step.apply(document);
      op = op.compose(step);
      shiftPieces(pieces, edits);
      fired.push({ prank: prank.name, user: event.user, edits });
      if (prank.exclusive) break;
    }
    if (fired.length > 0) this.submit(op, fired);
  }

  /** Apply now, or (inside a change event) right after it. */
  private submit(op: TextOperation, events: PrankEvent[]): boolean {
    if (this.inEvent || this.pending) {
      if (this.pending) {
        // Both are based on the current document; merge them.
        const ownOp = TextOperation.transform(this.pending.op, op)[1];
        this.pending.op = this.pending.op.compose(ownOp);
        this.pending.events.push(...events);
      } else {
        this.pending = { op, events };
        queueMicrotask(() => this.flush());
      }
      return true;
    }
    try {
      if (!op.isNoop()) this.client.applyOperation(op);
    } catch {
      return false; // disconnected or read-only: the prank just doesn't happen
    }
    for (const e of events) this.emit(e);
    return true;
  }

  private flush(): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending || !this.running) return;
    this.submit(pending.op, pending.events);
  }

  private makeApi(): PrankApi {
    const engine = this;
    return {
      document: () => this.client.getDocument(),
      random: () => this.random(),
      apply: (op) => this.running && this.submit(op, []),
      edit: (edits) => this.running && this.submit(editsToOperation(edits, this.client.getDocument().length), []),
      anchor: (start, end = start) => {
        const a = new Anchor(start, end);
        this.anchors.add(a);
        return a;
      },
      release: (a) => {
        a.alive = false;
        this.anchors.delete(a);
      },
      track(op) {
        const entry = { op };
        engine.tracked.add(entry);
        return {
          get op() { return entry.op; },
          release: () => { engine.tracked.delete(entry); },
        };
      },
      setCursor: (index) => {
        if (!this.client.setCursor) return;
        this.client.setCursor(index === null ? null : cursorFromIndex(this.client.getDocument(), index));
      },
      victimPosition: () => {
        if (!this.victim) return undefined;
        const cursor = this.victim.clientId ? this.client.users?.get(this.victim.clientId)?.cursor : undefined;
        if (cursor) return indexFromCursor(this.client.getDocument(), cursor);
        return this.victim.anchor.start;
      },
      lastVictimActivity: () => this.victim?.at ?? 0,
      later: (fn, ms) => {
        const t = setTimeout(() => {
          this.timers.delete(t);
          if (this.running) fn();
        }, ms);
        this.timers.add(t);
        return () => {
          clearTimeout(t);
          this.timers.delete(t);
        };
      },
      report: (event) => this.emit({ prank: '?', ...event }),
    };
  }
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
