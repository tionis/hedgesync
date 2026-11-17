/**
 * Pranks on single keystrokes: each looks at characters as they are typed.
 */

import type { EditPiece, Prank, PrankEdit, PrankUser } from './engine.js';

/**
 * Inserts longer than this many characters count as pastes and are left
 * alone. Keystrokes typed while the server is busy reach us composed into
 * one insert, so this is more than 1.
 */
export const DEFAULT_MAX_TYPED = 10;

interface Typed {
  /** Offset of the character in the document. */
  index: number;
  ch: string;
}

/** The typed (not pasted) characters of an edit, surrogate pairs kept whole. */
export function typedChars(pieces: EditPiece[], maxInsertLength = DEFAULT_MAX_TYPED): Typed[] {
  const out: Typed[] = [];
  for (const p of pieces) {
    if (p.type !== 'insert') continue;
    const chars = Array.from(p.text);
    if (chars.length > maxInsertLength) continue;
    let index = p.index;
    for (const ch of chars) {
      out.push({ index, ch });
      index += ch.length;
    }
  }
  return out;
}

const replaceChar = (t: Typed, text: string): PrankEdit[] => [
  { type: 'insert', index: t.index, text },
  { type: 'delete', index: t.index, length: t.ch.length },
];

const isLetter = (ch: string) => /^\p{L}$/u.test(ch);

export interface ChanceOptions {
  /** Chance (0..1) per typed character (or word, for echo). */
  probability: number;
  maxInsertLength?: number;
}

// ---- stutter ----------------------------------------------------------------

export interface StutterOptions extends ChanceOptions {
  /** Also double deletions: each backspace may take its left neighbour with it. */
  deletes?: boolean;
}

/** Every typed character has a chance of appearing twice. */
export function stutter(options: StutterOptions): Prank {
  const { probability, deletes = false, maxInsertLength } = options;
  return {
    name: 'stutter',
    react(pieces, ctx) {
      const edits: PrankEdit[] = [];
      for (const t of typedChars(pieces, maxInsertLength)) {
        if (ctx.random() < probability) edits.push({ type: 'insert', index: t.index + t.ch.length, text: t.ch });
      }
      if (deletes) {
        for (const p of pieces) {
          if (p.type !== 'delete' || p.index === 0 || ctx.random() >= probability) continue;
          // One more character to the left, as if backspace was pressed twice.
          const prev = Array.from(ctx.document.slice(Math.max(0, p.index - 2), p.index)).pop() ?? '';
          if (prev) edits.push({ type: 'delete', index: p.index - prev.length, length: prev.length });
        }
      }
      return edits;
    },
  };
}

// ---- fat fingers ------------------------------------------------------------

const LAYOUTS = {
  qwerty: ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'],
  qwertz: ['1234567890', 'qwertzuiopü', 'asdfghjklöä', 'yxcvbnm'],
} as const;
export type KeyboardLayout = keyof typeof LAYOUTS;
export const keyboardLayouts = Object.keys(LAYOUTS) as KeyboardLayout[];

/** Keys next to each key (same row and the rows above and below, staggered). */
export function keyNeighbours(layout: KeyboardLayout): Map<string, string[]> {
  const rows = LAYOUTS[layout];
  const map = new Map<string, string[]>();
  rows.forEach((row, r) => {
    [...row].forEach((key, i) => {
      const near = new Set<string>();
      const add = (rr: number, ii: number) => {
        const k = rows[rr]?.[ii];
        if (k && k !== key) near.add(k);
      };
      add(r, i - 1); add(r, i + 1);
      // Each row sits about half a key to the right of the one above.
      add(r - 1, i); add(r - 1, i + 1);
      add(r + 1, i - 1); add(r + 1, i);
      map.set(key, [...near]);
    });
  });
  return map;
}

export interface FatFingersOptions extends ChanceOptions {
  layout?: KeyboardLayout;
}

/** Typed letters and digits sometimes hit a neighbouring key instead. */
export function fatFingers(options: FatFingersOptions): Prank {
  const { probability, maxInsertLength } = options;
  const neighbours = keyNeighbours(options.layout ?? 'qwerty');
  return {
    name: 'fat-fingers',
    react(pieces, ctx) {
      const edits: PrankEdit[] = [];
      for (const t of typedChars(pieces, maxInsertLength)) {
        const lower = t.ch.toLowerCase();
        const near = neighbours.get(lower);
        if (!near?.length || ctx.random() >= probability) continue;
        const hit = near[Math.floor(ctx.random() * near.length)];
        edits.push(...replaceChar(t, t.ch === lower ? hit : hit.toUpperCase()));
      }
      return edits;
    },
  };
}

// ---- transposer -------------------------------------------------------------

/** A typed letter sometimes swaps places with the letter before it ("teh"). */
export function transposer(options: ChanceOptions): Prank {
  const { probability, maxInsertLength } = options;
  return {
    name: 'transpose',
    react(pieces, ctx) {
      const edits: PrankEdit[] = [];
      let free = 0; // edits must not overlap
      for (const t of typedChars(pieces, maxInsertLength)) {
        const prev = ctx.document[t.index - 1];
        if (t.index - 1 < free || !prev || t.ch.length !== 1 || !isLetter(t.ch) || !isLetter(prev)) continue;
        if (ctx.random() >= probability) continue;
        edits.push(
          { type: 'insert', index: t.index - 1, text: t.ch + prev },
          { type: 'delete', index: t.index - 1, length: 2 },
        );
        free = t.index + 1;
      }
      return edits;
    },
  };
}

// ---- sticky caps ------------------------------------------------------------

export interface StickyCapsOptions extends ChanceOptions {
  /** Letters per run (default 3 to 12). */
  runLength?: [number, number];
}

/** Every so often the shift key sticks: a run of CAPS or aLtErNaTiNg letters. */
export function stickyCaps(options: StickyCapsOptions): Prank {
  const { probability, maxInsertLength, runLength = [3, 12] } = options;
  const runs = new Map<string, { left: number; mode: 'caps' | 'sponge'; upper: boolean }>();
  const key = (u?: PrankUser) => u?.id ?? u?.userid ?? u?.name ?? '';
  return {
    name: 'sticky-caps',
    react(pieces, ctx) {
      const edits: PrankEdit[] = [];
      const who = key(ctx.user);
      for (const t of typedChars(pieces, maxInsertLength)) {
        if (!isLetter(t.ch)) continue;
        let run = runs.get(who);
        if (!run && ctx.random() < probability) {
          const [min, max] = runLength;
          run = { left: min + Math.floor(ctx.random() * (max - min + 1)), mode: ctx.random() < 0.5 ? 'caps' : 'sponge', upper: true };
          runs.set(who, run);
        }
        if (!run) continue;
        const want = run.mode === 'caps' || run.upper ? t.ch.toUpperCase() : t.ch.toLowerCase();
        run.upper = !run.upper;
        if (--run.left <= 0) runs.delete(who);
        if (want !== t.ch && Array.from(want).length === 1) edits.push(...replaceChar(t, want));
      }
      return edits;
    },
  };
}

// ---- echo -------------------------------------------------------------------

/** A finished word is sometimes repeated ("the the"). */
export function echo(options: ChanceOptions): Prank {
  const { probability, maxInsertLength } = options;
  return {
    name: 'echo',
    react(pieces, ctx) {
      const edits: PrankEdit[] = [];
      for (const t of typedChars(pieces, maxInsertLength)) {
        if (t.ch !== ' ') continue;
        const lineStart = ctx.document.lastIndexOf('\n', t.index - 1) + 1;
        const word = /[\p{L}\p{N}'’-]+$/u.exec(ctx.document.slice(lineStart, t.index))?.[0];
        if (!word || ctx.random() >= probability) continue;
        edits.push({ type: 'insert', index: t.index + 1, text: `${word} ` });
      }
      return edits;
    },
  };
}

// ---- homoglyphs -------------------------------------------------------------

/** Latin letters and their Cyrillic (or Greek) twins. */
export const HOMOGLYPHS: Record<string, string> = {
  a: 'а', c: 'с', e: 'е', i: 'і', j: 'ј', o: 'о', p: 'р', s: 'ѕ', x: 'х', y: 'у',
  A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', I: 'І', J: 'Ј', K: 'К', M: 'М', N: 'Ν',
  O: 'О', P: 'Р', S: 'Ѕ', T: 'Т', X: 'Х', Y: 'У', Z: 'Ζ',
};

/** Typed letters are sometimes swapped for identical-looking ones from another script. */
export function homoglyphs(options: ChanceOptions): Prank {
  const { probability, maxInsertLength } = options;
  return {
    name: 'homoglyphs',
    react(pieces, ctx) {
      const edits: PrankEdit[] = [];
      for (const t of typedChars(pieces, maxInsertLength)) {
        const twin = HOMOGLYPHS[t.ch];
        if (twin && ctx.random() < probability) edits.push(...replaceChar(t, twin));
      }
      return edits;
    },
  };
}
