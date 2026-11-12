import { TextOperation } from './text-operation.js';

/**
 * Upper bound on (middle length × edit distance) work before falling back to
 * a single coarse replace. Keeps worst-case runtime around a few hundred ms.
 */
const MAX_WORK = 50_000_000;
const MAX_EDIT_DISTANCE = 2000;

type Edit = 0 | 1 | 2; // 0 = equal, 1 = delete (from a), 2 = insert (from b)

/**
 * Build a TextOperation that transforms `a` into `b`.
 *
 * Uses the common prefix/suffix plus a Myers diff on the middle, so unchanged
 * regions are retained. That matters for OT: concurrent edits by other users
 * inside retained regions survive, while a coarse "replace everything" would
 * delete them. Falls back to a single replace of the middle when the edit
 * distance is too large to compute cheaply.
 */
export function diffToOperation(a: string, b: string): TextOperation {
  const op = new TextOperation();
  if (a === b) {
    return op.retain(a.length);
  }

  let prefix = 0;
  const minLen = Math.min(a.length, b.length);
  while (prefix < minLen && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)
  ) suffix++;

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  op.retain(prefix);

  const edits = midA.length > 0 && midB.length > 0 ? myers(midA, midB) : null;
  if (edits) {
    let ia = 0;
    let ib = 0;
    for (const e of edits) {
      if (e === 0) {
        op.retain(1);
        ia++;
        ib++;
      } else if (e === 1) {
        op.delete(1);
        ia++;
      } else {
        op.insert(midB[ib]);
        ib++;
      }
    }
  } else {
    op.delete(midA.length);
    op.insert(midB);
  }

  op.retain(suffix);
  return op;
}

/**
 * Myers O((N+M)·D) diff. Returns the edit script in forward order, or null if
 * the edit distance exceeds the work budget.
 */
function myers(a: string, b: string): Edit[] | null {
  const n = a.length;
  const m = b.length;
  const maxD = Math.min(n + m, MAX_EDIT_DISTANCE, Math.floor(MAX_WORK / (n + m)));
  if (maxD < 1) return null;

  const offset = maxD + 1;
  const v = new Int32Array(2 * maxD + 3);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= maxD; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a.charCodeAt(x) === b.charCodeAt(y)) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, offset, n, m, d);
      }
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], offset: number, n: number, m: number, dEnd: number): Edit[] {
  const edits: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = dEnd; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = v[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      edits.push(0);
      x--;
      y--;
    }
    if (d > 0) {
      edits.push(x === prevX ? 2 : 1);
    }
    x = prevX;
    y = prevY;
  }
  return edits.reverse();
}
