import { afterEach, describe, expect, test } from 'bun:test';
import type { HedgeDocClient } from '../../src/hedgedoc-client.js';
import { NoteMirror, createMirrorTransform, mergeText } from '../../src/mirror.js';
import { SimServer, rng, tick } from '../sim/sim-server.js';
import { connectClient, stopAll } from './helpers.js';

let clients: HedgeDocClient[] = [];
let mirrors: NoteMirror[] = [];
let mirrorErrors: Error[] = [];
afterEach(() => {
  expect(mirrorErrors).toEqual([]);
  mirrorErrors = [];
  for (const m of mirrors) m.stop();
  stopAll(clients);
  clients = [];
  mirrors = [];
});

async function setup(sourceDoc: string, targetDoc: string, options: ConstructorParameters<typeof NoteMirror>[2] = {}) {
  const srcServer = new SimServer({ document: sourceDoc });
  const tgtServer = new SimServer({ document: targetDoc });
  const [mSrc, mTgt, alice, bob] = await Promise.all([
    connectClient(srcServer), connectClient(tgtServer), connectClient(srcServer), connectClient(tgtServer),
  ]);
  clients.push(mSrc, mTgt, alice, bob);
  const mirror = new NoteMirror(mSrc, mTgt, { debounceMs: 5, ...options });
  mirrors.push(mirror);
  mirror.on('error', (e) => mirrorErrors.push(e));
  const drain = () => { srcServer.drain(); tgtServer.drain(); };
  const pump = async (until: () => boolean, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      drain();
      await tick(2);
      if (until()) return;
    }
    throw new Error(`not met: source=${JSON.stringify(srcServer.document)} target=${JSON.stringify(tgtServer.document)}`);
  };
  const settle = async (ms = 80) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { drain(); await tick(2); }
    drain();
  };
  return { srcServer, tgtServer, mirror, alice, bob, pump, settle };
}

describe('mergeText', () => {
  test('keeps edits from both sides', () => {
    expect(mergeText('one two three', 'ONE two three', 'one two THREE')).toBe('ONE two THREE');
    expect(mergeText('ab', 'aXb', 'aYb')).toBe('aXYb');
    expect(mergeText('hello world', 'hello', 'hello world!')).toBe('hello!');
  });
});

describe('createMirrorTransform', () => {
  test('shifts headings and wraps', () => {
    const t = createMirrorTransform({ headingShift: 1, prepend: '> mirror\n' })!;
    expect(t('# A\ntext\n###### F')).toBe('> mirror\n## A\ntext\n###### F');
    expect(createMirrorTransform({})).toBeUndefined();
    expect(createMirrorTransform({ headingShift: -1 })!('## A\n# B')).toBe('# A\n# B');
  });
});

describe('NoteMirror', () => {
  test('one-way: initial copy and following edits', async () => {
    const { srcServer, tgtServer, mirror, alice, bob, pump, settle } = await setup('hello', 'stale');
    mirror.start();
    await pump(() => bob.document === 'hello');
    alice.insert(5, ' world');
    await pump(() => tgtServer.document === 'hello world');
    bob.insert(0, 'target-only ');
    await settle();
    expect(srcServer.document).toBe('hello world'); // never copied back
    alice.insert(0, '>');
    await pump(() => tgtServer.document === '>hello world');
  });

  test('one-way with a transform', async () => {
    const { tgtServer, mirror, alice, pump } = await setup('# Title', '', {
      transform: createMirrorTransform({ headingShift: 1 }),
    });
    mirror.start();
    await pump(() => tgtServer.document === '## Title');
    alice.insert(alice.document.length, '\n# Next');
    await pump(() => tgtServer.document === '## Title\n## Next');
  });

  test('bidirectional: edits flow both ways without echo loops', async () => {
    const { srcServer, tgtServer, mirror, alice, bob, pump, settle } = await setup('base', '', { bidirectional: true });
    let syncs = 0;
    mirror.on('sync', () => syncs++);
    mirror.start();
    await pump(() => bob.document === 'base');
    bob.insert(4, ' from target');
    await pump(() => srcServer.document === 'base from target');
    alice.insert(0, 'src: ');
    await pump(() => tgtServer.document === 'src: base from target');
    await settle(150);
    const before = syncs;
    await settle(150);
    expect(syncs).toBe(before); // quiet once converged
  });

  test('bidirectional: concurrent edits on both sides are merged', async () => {
    const { srcServer, tgtServer, mirror, alice, bob, pump } = await setup('one two three', '', {
      bidirectional: true, debounceMs: 40,
    });
    mirror.start();
    await pump(() => bob.document === 'one two three');
    alice.replace(0, 3, 'ONE');
    bob.replace(8, 5, 'THREE');
    await pump(() => srcServer.document === 'ONE two THREE' && tgtServer.document === 'ONE two THREE');
  });

  test('bidirectional: random concurrent typing converges', async () => {
    const { srcServer, tgtServer, mirror, alice, bob, pump, settle } = await setup('', '', { bidirectional: true });
    mirror.start();
    const rand = rng(7);
    for (let i = 0; i < 40; i++) {
      const who = rand() < 0.5 ? alice : bob;
      const pos = Math.floor(rand() * (who.document.length + 1));
      who.insert(pos, String.fromCharCode(97 + Math.floor(rand() * 26)));
      if (rand() < 0.3) await settle(10);
    }
    await pump(() => srcServer.document === tgtServer.document && srcServer.document.length === 40, 5000);
  });

  test('a transform with bidirectional is rejected', async () => {
    const { mirror } = await setup('', '');
    expect(() => new NoteMirror(mirror.source, mirror.target, { bidirectional: true, transform: s => s })).toThrow();
  });
});
