import { describe, expect, test } from 'bun:test';
import { TextOperation } from '../../src/text-operation.js';
import { diffToOperation } from '../../src/diff.js';
import { rng } from '../sim/sim-server.js';

function randomString(r: () => number, maxLen: number, alphabet = 'ab c\nd🙂'): string {
  const len = Math.floor(r() * maxLen);
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(r() * alphabet.length)];
  return s;
}

function randomOperation(r: () => number, doc: string): TextOperation {
  const op = new TextOperation();
  let i = 0;
  while (i < doc.length) {
    const roll = r();
    const n = 1 + Math.floor(r() * Math.min(5, doc.length - i));
    if (roll < 0.2) op.insert(randomString(r, 4) || 'x');
    else if (roll < 0.4) {
      op.delete(n);
      i += n;
    } else {
      op.retain(n);
      i += n;
    }
  }
  if (r() < 0.3) op.insert(randomString(r, 4) || 'y');
  return op;
}

describe('TextOperation', () => {
  test('invert undoes apply', () => {
    const r = rng(1);
    for (let i = 0; i < 500; i++) {
      const doc = randomString(r, 30);
      const op = randomOperation(r, doc);
      const after = op.apply(doc);
      expect(op.invert(doc).apply(after)).toBe(doc);
    }
  });

  test('transform satisfies TP1', () => {
    const r = rng(2);
    for (let i = 0; i < 500; i++) {
      const doc = randomString(r, 30);
      const a = randomOperation(r, doc);
      const b = randomOperation(r, doc);
      const [aPrime, bPrime] = TextOperation.transform(a, b);
      expect(bPrime.apply(a.apply(doc))).toBe(aPrime.apply(b.apply(doc)));
    }
  });
});

describe('diffToOperation', () => {
  test('produces an operation from a to b', () => {
    const r = rng(3);
    for (let i = 0; i < 1000; i++) {
      const a = randomString(r, 60);
      const b = r() < 0.5 ? randomOperation(r, a).apply(a) : randomString(r, 60);
      expect(diffToOperation(a, b).apply(a)).toBe(b);
    }
  });

  test('retains unchanged regions', () => {
    const op = diffToOperation('hello brave world', 'hello new world');
    // Only "brave" vs "new" should be touched.
    const retained = op.ops.filter(TextOperation.isRetain).reduce((n, x) => n + (x as number), 0);
    expect(retained).toBeGreaterThanOrEqual('hello  world'.length);
  });

  test('falls back to a coarse replace for huge rewrites', () => {
    const a = 'x'.repeat(200_000);
    const b = 'y'.repeat(200_000);
    const started = Date.now();
    expect(diffToOperation(a, b).apply(a)).toBe(b);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
