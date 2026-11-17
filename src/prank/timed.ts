/**
 * Pranks that play out over time: they keep positions and operations around
 * (anchors, tracked operations) and act from timers.
 */

import { TextOperation } from '../text-operation.js';
import type { Anchor, Prank, PrankApi, PrankUser, TrackedOperation } from './engine.js';

const between = (api: PrankApi, [min, max]: [number, number]) => min + api.random() * (max - min);
const userKey = (u?: PrankUser) => u?.id ?? u?.userid ?? u?.name ?? '';

/** Start and end offsets of the line containing `index`. */
export function lineAt(doc: string, index: number): { start: number; end: number } {
  const start = doc.lastIndexOf('\n', index - 1) + 1;
  const nl = doc.indexOf('\n', index);
  return { start, end: nl === -1 ? doc.length : nl };
}

// ---- haunted undo -----------------------------------------------------------

export interface HauntedUndoOptions {
  /** Chance (0..1) that a burst of typing is haunted. */
  probability: number;
  /** A pause this long ends a burst (default 1500 ms). */
  burstGapMs?: number;
  /** How long after the burst it disappears (default 3 to 10 s). */
  delayMs?: [number, number];
}

/** Now and then, a few seconds after someone stops typing, what they typed quietly disappears. */
export function hauntedUndo(options: HauntedUndoOptions): Prank {
  const { probability, burstGapMs = 1500, delayMs = [3000, 10000] } = options;
  const bursts = new Map<string, { haunted: boolean; undo: TrackedOperation[]; cancel?: () => void }>();
  let api: PrankApi;
  return {
    name: 'haunted-undo',
    start(a) { api = a; },
    stop() { bursts.clear(); },
    react(_pieces, ctx) {
      const who = userKey(ctx.user);
      let burst = bursts.get(who);
      if (!burst) {
        burst = { haunted: ctx.random() < probability, undo: [] };
        bursts.set(who, burst);
      }
      burst.cancel?.();
      if (burst.haunted && ctx.previous !== undefined) {
        // The inverse is based on the document right after this edit, which is the current one.
        burst.undo.push(api.track(ctx.operation.invert(ctx.previous)));
      }
      const current = burst;
      current.cancel = api.later(() => {
        bursts.delete(who);
        if (!current.haunted || current.undo.length === 0) return;
        api.later(() => {
          // Newest first; each undo moves the ones still waiting.
          let changed = 0;
          for (const t of current.undo.reverse()) {
            const op = t.op;
            t.release();
            if (!op.isNoop() && api.apply(op)) changed++;
          }
          if (changed) api.report({ prank: 'haunted-undo', user: ctx.user, message: `undid ${changed} edit(s)` });
        }, between(api, delayMs));
      }, burstGapMs);
      return [];
    },
  };
}

// ---- ghost typist -----------------------------------------------------------

export const GHOST_MESSAGES = [
  'are you sure about this?',
  'hmm',
  'no.',
  '👀',
  'I disagree',
  'this is wrong',
  'who wrote this',
  '...',
  'interesting choice',
  'source?',
];

export interface GhostTypistOptions {
  /** Average seconds between appearances (default 60). */
  everySeconds?: number;
  messages?: string[];
  /** Only haunt while a victim typed within this long (default 120 s). */
  activeWithinMs?: number;
  /** Milliseconds per keystroke (default 90 to 220). */
  keystrokeMs?: [number, number];
  /** How long the remark stays before it is erased (default 1500 to 3500 ms). */
  pauseMs?: [number, number];
}

/**
 * Our cursor appears next to a victim, types a remark on a new line,
 * thinks better of it and deletes it again.
 */
export function ghostTypist(options: GhostTypistOptions = {}): Prank {
  const {
    everySeconds = 60, messages = GHOST_MESSAGES, activeWithinMs = 120_000, keystrokeMs = [90, 220],
    pauseMs = [1500, 3500],
  } = options;
  let api: PrankApi;
  let busy = false;

  const schedule = () => {
    // Spread evenly around the average.
    api.later(haunt, everySeconds * (0.5 + api.random()) * 1000);
  };

  const haunt = () => {
    schedule();
    const at = api.victimPosition();
    if (busy || at === undefined || Date.now() - api.lastVictimActivity() > activeWithinMs) return;
    const doc = api.document();
    const line = lineAt(doc, Math.min(at, doc.length));
    // On a new line below theirs, so their cursor doesn't move; above it if theirs is the last.
    const below = line.end < doc.length;
    const pos = below ? line.end + 1 : line.start;
    if (!api.apply(new TextOperation().retain(pos).insert('\n').retain(doc.length - pos))) return;
    busy = true;
    // The ghost's text lives in [start, end) on its own line.
    const ghost = api.anchor(pos, pos);
    const message = Array.from(messages[Math.floor(api.random() * messages.length)] ?? '...');
    let typed = 0;

    const done = () => {
      api.setCursor(null);
      api.release(ghost);
      busy = false;
    };
    const step = (fn: () => void, ms = between(api, keystrokeMs)) => api.later(fn, ms);

    const type = () => {
      if (!ghost.alive) return done();
      if (typed === message.length) return step(erase, between(api, pauseMs));
      const ch = message[typed++];
      const len = api.document().length;
      const { start, end } = ghost;
      if (!api.apply(new TextOperation().retain(end).insert(ch).retain(len - end))) return done();
      ghost.start = start;
      ghost.end = end + ch.length;
      api.setCursor(ghost.end);
      step(type);
    };
    const erase = () => {
      const doc = api.document();
      if (ghost.end > ghost.start) {
        const last = Array.from(doc.slice(ghost.start, ghost.end)).pop()!;
        if (!api.apply(new TextOperation().retain(ghost.end - last.length).delete(last.length).retain(doc.length - ghost.end))) return done();
        api.setCursor(ghost.end);
        return step(erase, between(api, keystrokeMs) / 2);
      }
      // Finally the line break we added, which follows the ghost's text.
      const nl = ghost.start;
      if (doc[nl] === '\n') api.apply(new TextOperation().retain(nl).delete(1).retain(doc.length - nl - 1));
      api.report({ prank: 'ghost', message: `typed and erased "${message.join('')}"` });
      done();
    };
    api.report({ prank: 'ghost', message: 'appears' });
    api.setCursor(ghost.start);
    step(type, between(api, keystrokeMs) * 3);
  };

  return {
    name: 'ghost',
    start(a) {
      api = a;
      busy = false;
      schedule();
    },
  };
}

// ---- bombs ------------------------------------------------------------------

export interface BombOptions {
  /** Chance (0..1) per victim edit that a bomb is planted. */
  probability: number;
  /** Seconds to defuse it (default 15, at most 99). */
  fuseSeconds?: number;
  /**
   * Crater radius in characters, left and right of the bomb (default 10).
   * It reaches a third as many lines up and down (at least one), since a
   * line is taller than a character is wide.
   */
  radius?: number;
  /** Lines above and below the victim's that may get a bomb (default 2). */
  spreadLines?: number;
  /** At most this many bombs at once (default 3). */
  maxBombs?: number;
}

export const BOMB = '💣';
export const BLAST = '💥';
/** Rubble from the crater's centre outwards. */
export const RUBBLE = ['▓', '▒', '░'] as const;

/**
 * The crater left by a bomb at [start, end): 💥 in an ellipse of rubble,
 * `radius` characters wide each way and a third as many lines high. Line
 * breaks survive; lines too short to reach into the crater are padded with
 * spaces so it keeps its shape. Returns the range to replace and its new text.
 */
export function crater(doc: string, start: number, end: number, radius: number): { from: number; to: number; text: string } {
  const rx = Math.max(1, radius);
  const ry = Math.max(1, Math.round(rx / 3));
  const lines = doc.split('\n');
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  // The bomb's line, and its column there (in characters, not UTF-16 units).
  let row = lines.length - 1;
  while (row > 0 && offsets[row] > start) row--;
  const cx = Array.from(doc.slice(offsets[row], start)).length;
  const first = Math.max(0, row - ry);
  const last = Math.min(lines.length - 1, row + ry);

  const out: string[] = [];
  for (let r = first; r <= last; r++) {
    const text = r === row
      ? doc.slice(offsets[r], start) + BLAST + doc.slice(end, offsets[r] + lines[r].length)
      : lines[r];
    const chars = Array.from(text);
    const dy = (r - row) / (ry + 0.5);
    const half = rx * Math.sqrt(Math.max(0, 1 - dy * dy));
    const left = Math.max(0, Math.ceil(cx - half));
    const right = Math.floor(cx + half);
    for (let col = left; col <= right; col++) {
      if (r === row && col === cx) continue; // the 💥 itself
      const dx = (col - cx) / (rx + 0.5);
      const d = Math.sqrt(dx * dx + dy * dy);
      const rubble = RUBBLE[d < 0.4 ? 0 : d < 0.7 ? 1 : 2];
      while (chars.length < col) chars.push(' ');
      chars[col] = rubble;
    }
    // 💥 is two columns wide on screen: drop the rubble right after it, so
    // the crater's right half lines up with the lines above and below.
    if (r === row && (RUBBLE as readonly string[]).includes(chars[cx + 1])) chars.splice(cx + 1, 1);
    out.push(chars.join(''));
  }
  const from = offsets[first];
  const to = offsets[last] + lines[last].length;
  return { from, to, text: out.join('\n') };
}

const bombText = (seconds: number) => `${BOMB}${String(Math.max(0, seconds)).padStart(2, '0')}`;

/**
 * Bombs with a countdown appear near where a victim is typing. Delete one
 * (or any part of it) to defuse it; otherwise it explodes and leaves a crater.
 */
export function bombs(options: BombOptions): Prank {
  const { probability, radius = 10, spreadLines = 2, maxBombs = 3 } = options;
  const fuse = Math.min(99, Math.max(1, Math.round(options.fuseSeconds ?? 15)));
  let api: PrankApi;
  const live = new Set<Anchor>();

  /** A spot between words on a line near `at`, away from the victim's own line if possible. */
  const pickSpot = (doc: string, at: number): number => {
    const lines: { start: number; end: number }[] = [];
    let start = 0;
    for (const text of doc.split('\n')) {
      lines.push({ start, end: start + text.length });
      start += text.length + 1;
    }
    const mine = lines.findIndex(l => at >= l.start && at <= l.end);
    const near = lines
      .map((l, i) => ({ l, i }))
      .filter(({ i }) => Math.abs(i - mine) <= spreadLines && (i !== mine || lines.length === 1));
    const { l } = near[Math.floor(api.random() * near.length)] ?? { l: lines[mine] };
    const text = doc.slice(l.start, l.end);
    const gaps = [l.end];
    for (let i = 0; i < text.length; i++) if (text[i] === ' ') gaps.push(l.start + i);
    return gaps[Math.floor(api.random() * gaps.length)];
  };

  const plant = (user?: PrankUser) => {
    const at = api.victimPosition();
    if (at === undefined) return;
    const doc = api.document();
    const pos = pickSpot(doc, Math.min(at, doc.length));
    const before = doc[pos - 1];
    const text = (before && before !== ' ' && before !== '\n' ? ' ' : '') + bombText(fuse);
    if (!api.apply(new TextOperation().retain(pos).insert(text).retain(doc.length - pos))) return;
    // The anchor covers just the bomb, not the space before it.
    const start = pos + text.length - bombText(fuse).length;
    const bomb = api.anchor(start, pos + text.length);
    live.add(bomb);
    api.report({ prank: 'bombs', user, message: `planted, ${fuse}s fuse` });
    tick(bomb, fuse, user);
  };

  const tick = (bomb: Anchor, left: number, user?: PrankUser) => {
    api.later(() => {
      const doc = api.document();
      if (doc.slice(bomb.start, bomb.end) !== bombText(left)) {
        live.delete(bomb);
        api.release(bomb);
        api.report({ prank: 'bombs', user, message: 'defused' });
        return;
      }
      const next = left - 1;
      if (next > 0) {
        const op = new TextOperation().retain(bomb.start).delete(bomb.end - bomb.start)
          .insert(bombText(next)).retain(doc.length - bomb.end);
        const start = bomb.start;
        if (api.apply(op)) {
          bomb.start = start;
          bomb.end = start + bombText(next).length;
          tick(bomb, next, user);
        } else {
          live.delete(bomb);
          api.release(bomb);
        }
        return;
      }
      live.delete(bomb);
      api.release(bomb);
      explode(doc, bomb.start, bomb.end);
      api.report({ prank: 'bombs', user, message: 'exploded' });
    }, 1000);
  };

  const explode = (doc: string, start: number, end: number) => {
    const { from, to, text } = crater(doc, start, end, radius);
    api.apply(new TextOperation().retain(from).delete(to - from).insert(text).retain(doc.length - to));
  };

  return {
    name: 'bombs',
    start(a) {
      api = a;
      live.clear();
    },
    stop() { live.clear(); },
    react(_pieces, ctx) {
      if (live.size < maxBombs && ctx.random() < probability) {
        // After this edit has gone through, so the bomb lands where they are now.
        api.later(() => plant(ctx.user), 0);
      }
      return [];
    },
  };
}
