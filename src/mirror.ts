/**
 * Keep two HedgeDoc notes in sync.
 *
 * One-way mode makes the target follow the source (optionally through a text
 * transform). Bidirectional mode merges edits from both sides with a
 * three-way merge: both notes' changes since the last common content are
 * expressed as operations and combined with OT, so concurrent edits in
 * different places (or even the same place) are all kept.
 */

import { EventEmitter } from 'events';
import { TextOperation } from './text-operation.js';
import { diffToOperation } from './diff.js';
import type { ChangeEvent } from './hedgedoc-client.js';

/** The part of HedgeDocClient the mirror needs. */
export interface MirrorClient {
  getDocument(): string;
  updateContent(content: string): void;
  on(event: 'change', listener: (event: ChangeEvent) => void): unknown;
  off(event: 'change', listener: (event: ChangeEvent) => void): unknown;
  flush(timeoutMs?: number): Promise<void>;
}

export interface MirrorOptions {
  /** Also copy target edits back to the source (default false). */
  bidirectional?: boolean;
  /**
   * Transform applied to source content before it is written to the target.
   * Cannot be inverted, so it is only allowed in one-way mode.
   */
  transform?: (content: string) => string;
  /** Wait this long after the last remote edit before syncing (default 150ms). */
  debounceMs?: number;
}

export type MirrorDirection = 'source→target' | 'target→source' | 'both';

export interface MirrorSyncEvent {
  direction: MirrorDirection;
  /** True when both notes had changed and their edits were merged. */
  merged: boolean;
  length: number;
}

/**
 * Events: 'sync' (MirrorSyncEvent), 'error' (Error).
 */
export class NoteMirror extends EventEmitter {
  readonly bidirectional: boolean;
  private readonly transform: (content: string) => string;
  private readonly debounceMs: number;
  /** Last content both notes agreed on (source space). */
  private base = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;
  private rerun = false;
  private started = false;

  constructor(
    readonly source: MirrorClient,
    readonly target: MirrorClient,
    options: MirrorOptions = {},
  ) {
    super();
    if (options.bidirectional && options.transform) {
      throw new Error('A transform cannot be inverted, so it only works with one-way mirroring');
    }
    this.bidirectional = options.bidirectional ?? false;
    this.transform = options.transform ?? (s => s);
    this.debounceMs = options.debounceMs ?? 150;
  }

  /** Copy the source to the target, then follow remote edits. */
  start(): MirrorSyncEvent | null {
    if (this.started) return null;
    this.started = true;
    const content = this.source.getDocument();
    const desired = this.transform(content);
    let event: MirrorSyncEvent | null = null;
    if (this.target.getDocument() !== desired) {
      this.target.updateContent(desired);
      event = { direction: 'source→target', merged: false, length: desired.length };
    }
    this.base = content;
    this.source.on('change', this.onSourceChange);
    this.target.on('change', this.onTargetChange);
    return event;
  }

  /** Stop following edits (pending syncs are dropped). */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.source.off('change', this.onSourceChange);
    this.target.off('change', this.onTargetChange);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Run any pending sync now and wait until both notes are acknowledged. */
  async flush(timeoutMs?: number): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.runSync();
    }
    await Promise.all([this.source.flush(timeoutMs), this.target.flush(timeoutMs)]);
  }

  private onSourceChange = (event: ChangeEvent) => {
    if (event.type === 'remote') this.schedule();
  };

  private onTargetChange = (event: ChangeEvent) => {
    // Our own writes arrive as local changes; only collaborators' edits count.
    if (event.type === 'remote') this.schedule();
  };

  private schedule(): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runSync();
    }, this.debounceMs);
  }

  private runSync(): void {
    if (this.syncing) {
      this.rerun = true; // a 'sync' listener edited a note; go again afterwards
      return;
    }
    this.syncing = true;
    try {
      do {
        this.rerun = false;
        try {
          const event = this.syncOnce();
          if (event) this.emit('sync', event);
        } catch (err) {
          if (this.listenerCount('error') > 0) this.emit('error', err instanceof Error ? err : new Error(String(err)));
        }
      } while (this.rerun && this.started);
    } finally {
      this.syncing = false;
    }
  }

  /** Bring the notes together; returns what was done, or null if nothing. */
  syncOnce(): MirrorSyncEvent | null {
    const source = this.source.getDocument();
    const target = this.target.getDocument();

    if (!this.bidirectional) {
      const desired = this.transform(source);
      this.base = source;
      if (target === desired) return null;
      this.target.updateContent(desired);
      return { direction: 'source→target', merged: false, length: desired.length };
    }

    const base = this.base;
    if (source === target) {
      this.base = source;
      return null;
    }
    if (target === base) {
      this.target.updateContent(source);
      this.base = source;
      return { direction: 'source→target', merged: false, length: source.length };
    }
    if (source === base) {
      this.source.updateContent(target);
      this.base = target;
      return { direction: 'target→source', merged: false, length: target.length };
    }

    const merged = mergeText(base, source, target);
    this.source.updateContent(merged);
    this.target.updateContent(merged);
    this.base = merged;
    return { direction: 'both', merged: true, length: merged.length };
  }
}

/**
 * Three-way merge: apply both `ours` and `theirs` changes (relative to
 * `base`). Where both insert at the same spot, `ours` comes first.
 */
export function mergeText(base: string, ours: string, theirs: string): string {
  const a = diffToOperation(base, ours);
  const b = diffToOperation(base, theirs);
  const [, bPrime] = TextOperation.transform(a, b);
  return bPrime.apply(ours);
}

/** Options for {@link createMirrorTransform}. */
export interface MirrorTransformOptions {
  /** Shift heading levels by this much (positive demotes, negative promotes). */
  headingShift?: number;
  /** Text added before / after every plain paragraph line. */
  wrapPrefix?: string;
  wrapSuffix?: string;
  /** Text added at the start / end of the document. */
  prepend?: string;
  append?: string;
}

/** Build a source→target transform from simple options, or undefined if none apply. */
export function createMirrorTransform(options: MirrorTransformOptions): ((content: string) => string) | undefined {
  const { headingShift = 0, wrapPrefix = '', wrapSuffix = '', prepend = '', append = '' } = options;
  if (!headingShift && !wrapPrefix && !wrapSuffix && !prepend && !append) return undefined;
  return (content: string) => {
    let result = content;
    if (headingShift) {
      result = result.replace(/^(#{1,6})(?=\s)/gm, (_m, hashes: string) =>
        '#'.repeat(Math.min(6, Math.max(1, hashes.length + headingShift))));
    }
    if (wrapPrefix || wrapSuffix) {
      result = result.split('\n').map(line =>
        !line.trim() || /^[#\-*+>|`]/.test(line) || /^[0-9]+\./.test(line)
          ? line
          : wrapPrefix + line + wrapSuffix,
      ).join('\n');
    }
    return prepend + result + append;
  };
}
