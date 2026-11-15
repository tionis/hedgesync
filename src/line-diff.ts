/**
 * Line-based diff with unified output, for showing what changed between
 * note revisions. (diffToOperation in diff.ts is character-based, for edits.)
 */

export type DiffLine = { type: ' ' | '-' | '+'; text: string };

/** Above this many cells the LCS table is skipped and the middle is shown as replaced. */
const MAX_CELLS = 4_000_000;

export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split('\n');
  const y = b.split('\n');
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
    endX--;
    endY--;
  }
  const out: DiffLine[] = x.slice(0, start).map(text => ({ type: ' ', text }));
  const mx = x.slice(start, endX);
  const my = y.slice(start, endY);
  const n = mx.length;
  const m = my.length;

  if (n * m > MAX_CELLS) {
    out.push(...mx.map(text => ({ type: '-' as const, text })), ...my.map(text => ({ type: '+' as const, text })));
  } else {
    // lcs[i][j] = LCS length of mx[i..] and my[j..], stored row-major.
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = mx[i] === my[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (mx[i] === my[j]) {
        out.push({ type: ' ', text: mx[i++] });
        j++;
      } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
        out.push({ type: '-', text: mx[i++] });
      } else {
        out.push({ type: '+', text: my[j++] });
      }
    }
    while (i < n) out.push({ type: '-', text: mx[i++] });
    while (j < m) out.push({ type: '+', text: my[j++] });
  }
  out.push(...x.slice(endX).map(text => ({ type: ' ' as const, text })));
  return out;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

/** Group a diff into hunks with `context` unchanged lines around each change. */
export function hunks(diff: DiffLine[], context = 3): Hunk[] {
  const changed = diff.map((d, i) => (d.type !== ' ' ? i : -1)).filter(i => i >= 0);
  if (changed.length === 0) return [];
  const ranges: [number, number][] = [];
  for (const i of changed) {
    const from = Math.max(0, i - context);
    const to = Math.min(diff.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }
  // Line numbers (1-based) before each diff index.
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let o = 1;
  let nn = 1;
  for (const d of diff) {
    oldAt.push(o);
    newAt.push(nn);
    if (d.type !== '+') o++;
    if (d.type !== '-') nn++;
  }
  return ranges.map(([from, to]) => {
    const lines = diff.slice(from, to + 1);
    return {
      oldStart: oldAt[from],
      oldLines: lines.filter(l => l.type !== '+').length,
      newStart: newAt[from],
      newLines: lines.filter(l => l.type !== '-').length,
      lines,
    };
  });
}

/** Unified diff text (without file headers); empty when nothing changed. */
export function unifiedDiff(a: string, b: string, context = 3): string {
  return hunks(diffLines(a, b), context)
    .map(h => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n` + h.lines.map(l => l.type + l.text).join('\n'))
    .join('\n');
}

/** Count of added and removed lines. */
export function diffStat(a: string, b: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const d of diffLines(a, b)) {
    if (d.type === '+') added++;
    else if (d.type === '-') removed++;
  }
  return { added, removed };
}
