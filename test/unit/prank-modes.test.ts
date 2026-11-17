import { afterEach, describe, expect, test } from 'bun:test';
import { HedgeDocClient } from '../../src/hedgedoc-client.js';
import type { Agent } from '../../src/note-assistant.js';
import {
  BLAST, BOMB, HOMOGLYPHS, PrankEngine, RUBBLE, bombs, cleanAnswer, deny, echo, fatFingers, ghostTypist,
  hauntedUndo, homoglyphs, keyNeighbours, paragraphAt, rulesKeeper, stickyCaps, stutter, transposer, userMatcher,
  type PrankEngineOptions,
} from '../../src/prank/index.js';
import { SimServer, tick } from '../sim/sim-server.js';
import { connectClient, settle, stopAll } from './helpers.js';

let clients: HedgeDocClient[] = [];
let engines: PrankEngine[] = [];

afterEach(() => {
  for (const e of engines) e.stop();
  stopAll(clients);
  clients = [];
  engines = [];
});

/** Always roll the same number. */
const always = (n: number) => () => n;

/** A note with the prankster bot and a human victim (and maybe a bystander). */
async function setup(document: string, options: PrankEngineOptions = {}) {
  const server = new SimServer({ document });
  const bot = await connectClient(server);
  const human = await connectClient(server);
  const other = await connectClient(server);
  clients.push(bot, human, other);
  const engine = new PrankEngine(bot, options);
  engines.push(engine);
  const messages: string[] = [];
  engine.onPrank(e => { if (e.message) messages.push(`${e.prank}: ${e.message}`); });
  const sync = () => settle(server, [bot, human, other]);
  /** Let real time pass (timers run) until `until` holds; also checks all clients agree. */
  const waitFor = async (until: (doc: string) => boolean, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      server.drain();
      await tick(2);
      if (until(server.document)) {
        await sync();
        expect(bot.getDocument()).toBe(server.document);
        expect(human.getDocument()).toBe(server.document);
        return;
      }
    }
    throw new Error(`condition not met; server doc: ${JSON.stringify(server.document)}`);
  };
  const identify = (client: HedgeDocClient, userid: string, name: string) => {
    bot.users.set(client.socket!.id!, { id: client.socket!.id!, userid, name });
  };
  return { server, bot, human, other, engine, messages, sync, waitFor, identify };
}

describe('typing pranks', () => {
  test('fat fingers hit a neighbouring key, keeping case', async () => {
    const { server, human, engine, sync } = await setup('');
    engine.add(fatFingers({ probability: 1 })).start();
    human.insert(0, 'G');
    await sync();
    expect(keyNeighbours('qwerty').get('g')!.map(k => k.toUpperCase())).toContain(server.document);
  });

  test('qwertz neighbours differ from qwerty', () => {
    expect(keyNeighbours('qwerty').get('t')).toContain('y');
    expect(keyNeighbours('qwertz').get('t')).toContain('z');
    expect(keyNeighbours('qwertz').get('a')).toContain('y');
  });

  test('fat fingers leave punctuation alone', async () => {
    const { server, human, engine, sync } = await setup('');
    engine.add(fatFingers({ probability: 1 })).start();
    human.insert(0, '.');
    await sync();
    expect(server.document).toBe('.');
  });

  test('transposer swaps a typed letter with the one before', async () => {
    const { server, human, engine, sync } = await setup('th');
    engine.add(transposer({ probability: 1 })).start();
    human.insert(2, 'e');
    await sync();
    expect(server.document).toBe('teh');
  });

  test('transposer does not swap across spaces', async () => {
    const { server, human, engine, sync } = await setup('a ');
    engine.add(transposer({ probability: 1 })).start();
    human.insert(2, 'b');
    await sync();
    expect(server.document).toBe('a b');
  });

  test('sticky caps capitalise a run of letters', async () => {
    // Rolls: start a run (0), length min (0 -> 3), caps mode (0 < 0.5).
    const { server, human, engine, sync } = await setup('', { random: always(0) });
    engine.add(stickyCaps({ probability: 1, runLength: [3, 3] })).start();
    human.insert(0, 'abcd');
    await sync();
    // The run ends after 3 letters; the 4th starts a new one.
    expect(server.document.slice(0, 3)).toBe('ABC');
  });

  test('sticky caps can go sponge case', async () => {
    const { server, human, engine, sync } = await setup('', { random: always(0.7) });
    engine.add(stickyCaps({ probability: 1, runLength: [4, 4] })).start();
    human.insert(0, 'abcd');
    await sync();
    expect(server.document).toBe('AbCd');
  });

  test('echo repeats a finished word', async () => {
    const { server, human, engine, sync } = await setup('say the');
    engine.add(echo({ probability: 1 })).start();
    human.insert(7, ' ');
    await sync();
    expect(server.document).toBe('say the the ');
  });

  test('homoglyphs swap letters for lookalikes', async () => {
    const { server, human, engine, sync } = await setup('');
    engine.add(homoglyphs({ probability: 1 })).start();
    human.insert(0, 'ape');
    await sync();
    expect(server.document).toBe(HOMOGLYPHS.a + HOMOGLYPHS.p + HOMOGLYPHS.e);
    expect(server.document).not.toBe('ape');
  });

  test('several typing pranks combine and stay in sync', async () => {
    const { server, bot, human, engine, sync } = await setup('');
    let seed = 1;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    engines.pop();
    engine.stop();
    const combined = new PrankEngine(bot, { random });
    engines.push(combined);
    combined
      .add(stutter({ probability: 0.2, deletes: true }))
      .add(fatFingers({ probability: 0.2 }))
      .add(transposer({ probability: 0.2 }))
      .add(stickyCaps({ probability: 0.1 }))
      .add(echo({ probability: 0.3 }))
      .add(homoglyphs({ probability: 0.2 }))
      .start();
    const text = 'the quick brown fox jumps over the lazy dog ';
    for (let i = 0; i < text.length; i++) {
      const doc = human.getDocument();
      if (i % 9 === 8 && doc.length > 0) human.delete(doc.length - 1, 1);
      else human.insert(doc.length, text[i]);
      server.drain();
      if (i % 4 === 0) await sync();
    }
    await sync();
    expect(bot.getDocument()).toBe(server.document);
    expect(human.getDocument()).toBe(server.document);
  });
});

describe('scoping', () => {
  test('only pranks the chosen users', async () => {
    const { server, human, other, engine, sync, identify } = await setup('', { only: ['^victim$'] });
    identify(human, 'v-id', 'Victim');
    identify(other, 'b-id', 'Bystander');
    engine.add(stutter({ probability: 1 })).start();
    human.insert(0, 'a');
    await sync();
    other.insert(0, 'b');
    await sync();
    expect(server.document).toBe('baa');
  });

  test('except spares users, by name or account id', async () => {
    const { server, human, other, engine, sync, identify } = await setup('', { except: ['b-id'] });
    identify(human, 'v-id', 'Victim');
    identify(other, 'b-id', 'Bystander');
    engine.add(stutter({ probability: 1 })).start();
    human.insert(0, 'a');
    await sync();
    other.insert(0, 'b');
    await sync();
    expect(server.document).toBe('baa');
  });

  test('except wins over only', async () => {
    const { server, human, engine, sync, identify } = await setup('', { only: ['.'], except: ['victim'] });
    identify(human, 'v-id', 'Victim');
    engine.add(stutter({ probability: 1 })).start();
    human.insert(0, 'a');
    await sync();
    expect(server.document).toBe('a');
  });

  test('except also protects from deny', async () => {
    const { server, human, engine, sync, identify } = await setup('', { except: ['^me$'] });
    identify(human, 'me-id', 'Me');
    engine.add(deny({ targets: () => true })).start();
    human.insert(0, 'mine');
    await sync();
    expect(server.document).toBe('mine');
  });

  test('unidentified users are spared by only, pranked without it', async () => {
    const a = await setup('', { only: ['anyone'] });
    a.engine.add(stutter({ probability: 1 })).start();
    a.human.insert(0, 'x');
    await a.sync();
    expect(a.server.document).toBe('x');
    const b = await setup('', { except: ['someone'] });
    b.engine.add(stutter({ probability: 1 })).start();
    b.human.insert(0, 'x');
    await b.sync();
    expect(b.server.document).toBe('xx');
  });

  test('a predicate works as a selector', async () => {
    const { server, human, engine, sync, identify } = await setup('', { only: u => u?.name?.length === 3 });
    identify(human, 'id', 'Bob');
    engine.add(stutter({ probability: 1 })).start();
    human.insert(0, 'y');
    await sync();
    expect(server.document).toBe('yy');
  });

  test('timed pranks follow only the chosen victims', async () => {
    const { server, human, other, engine, sync, identify } = await setup('one\ntwo', { only: ['victim'] });
    identify(human, 'v', 'Victim');
    identify(other, 'b', 'Bystander');
    engine.add(bombs({ probability: 1, fuseSeconds: 5 })).start();
    other.insert(0, 'x');
    await sync();
    await new Promise(r => setTimeout(r, 30));
    await sync();
    expect(server.document).not.toContain(BOMB);
  });
});

describe('deny', () => {
  test('reverts inserts and deletes of the denied user only', async () => {
    const { server, human, other, engine, sync, identify } = await setup('hello');
    identify(human, 'mallory-id', 'Mallory');
    identify(other, 'alice-id', 'Alice');
    engine.add(deny({ targets: userMatcher(['mallory']) })).start();
    human.insert(5, ' world');
    await sync();
    expect(server.document).toBe('hello');
    human.delete(0, 2);
    await sync();
    expect(server.document).toBe('hello');
    other.insert(5, '!');
    await sync();
    expect(server.document).toBe('hello!');
  });

  test('userMatcher: exact account ids, case-insensitive name regexes', () => {
    const m = userMatcher(['abc-123', '^bob$']);
    expect(m({ userid: 'abc-123', name: 'X' })).toBe(true);
    expect(m({ userid: 'abc-1234', name: 'X' })).toBe(false);
    expect(m({ name: 'Bob' })).toBe(true);
    expect(m({ name: 'Bobby' })).toBe(false);
    expect(m(undefined)).toBe(false);
  });

  test('ignores the engine filter and pre-empts other pranks', async () => {
    const { server, human, other, engine, sync, identify } = await setup('');
    identify(human, 'm', 'Mallory');
    identify(other, 'a', 'Alice');
    engine.add(stutter({ probability: 1 })).add(deny({ targets: userMatcher(['Mallory']) }));
    // The engine only pranks Alice; deny still hits Mallory.
    engines.pop();
    engine.stop();
    const filtered = new PrankEngine(clients[0], { userFilter: /Alice/ });
    engines.push(filtered);
    filtered.add(stutter({ probability: 1 })).add(deny({ targets: userMatcher(['Mallory']) })).start();
    human.insert(0, 'x');
    await sync();
    expect(server.document).toBe('');
    other.insert(0, 'y');
    await sync();
    expect(server.document).toBe('yy');
  });
});

describe('haunted undo', () => {
  test('removes a burst of typing after a while', async () => {
    const { server, human, engine, sync, waitFor, messages } = await setup('keep: ');
    engine.add(hauntedUndo({ probability: 1, burstGapMs: 30, delayMs: [30, 30] })).start();
    for (const ch of 'boo') {
      human.insert(human.getDocument().length, ch);
      await sync();
    }
    expect(server.document).toBe('keep: boo');
    await waitFor(doc => doc === 'keep: ');
    expect(messages).toContain('haunted-undo: undid 3 edit(s)');
  });

  test('the undo survives edits made meanwhile', async () => {
    const { server, human, other, engine, sync, waitFor, identify } = await setup('ab', { userFilter: /^Human$/ });
    identify(human, 'h', 'Human');
    identify(other, 'o', 'Other');
    engine.add(hauntedUndo({ probability: 1, burstGapMs: 20, delayMs: [80, 80] })).start();
    human.insert(1, 'XYZ');
    await sync();
    other.insert(0, '>> ');
    other.insert(other.getDocument().length, ' <<');
    await sync();
    await waitFor(doc => doc === '>> ab <<');
    await new Promise(r => setTimeout(r, 100));
    await sync();
    expect(server.document).toBe('>> ab <<');
  });

  test('leaves unhaunted bursts alone', async () => {
    const { server, human, engine, sync } = await setup('');
    engine.add(hauntedUndo({ probability: 0, burstGapMs: 10, delayMs: [10, 10] })).start();
    human.insert(0, 'stay');
    await sync();
    await new Promise(r => setTimeout(r, 60));
    await sync();
    expect(server.document).toBe('stay');
  });
});

describe('ghost typist', () => {
  test('types a remark on a new line next to the victim and erases it', async () => {
    const { server, human, engine, sync, waitFor, messages } = await setup('one\ntwo\nthree');
    engine.add(ghostTypist({
      everySeconds: 0.03, messages: ['boo'], keystrokeMs: [2, 2], pauseMs: [20, 20],
    })).start();
    human.insert(3, '!');
    await sync();
    await waitFor(doc => doc === 'one!\nboo\ntwo\nthree');
    await waitFor(doc => doc === 'one!\ntwo\nthree' && messages.some(m => m.includes('erased')));
  });

  test('stays away while nobody is typing', async () => {
    const { server, engine, sync } = await setup('quiet');
    engine.add(ghostTypist({ everySeconds: 0.01, keystrokeMs: [1, 1], pauseMs: [1, 1] })).start();
    await new Promise(r => setTimeout(r, 50));
    await sync();
    expect(server.document).toBe('quiet');
  });
});

describe('bombs', () => {
  test('an ignored bomb ticks down and leaves a crater', async () => {
    const doc = 'first line here\nsecond line here';
    const { human, engine, sync, waitFor, messages } = await setup(doc, { random: always(0) });
    engine.add(bombs({ probability: 1, fuseSeconds: 2, radius: 3, maxBombs: 1 })).start();
    human.insert(doc.length, '!');
    await sync();
    await waitFor(d => d.includes(`${BOMB}02`));
    await waitFor(d => d.includes(`${BOMB}01`), 2500);
    await waitFor(d => d.includes(BLAST), 2500);
    const after = clients[0].getDocument();
    expect(after).toContain(RUBBLE.repeat(3) + BLAST);
    expect(after).not.toContain(BOMB);
    expect(after.split('\n')).toHaveLength(2);
    expect(messages).toEqual(['bombs: planted, 2s fuse', 'bombs: exploded']);
  });

  test('deleting a bomb defuses it', async () => {
    const doc = 'aaa\nbbb';
    const { server, human, engine, sync, waitFor, messages } = await setup(doc, { random: always(0) });
    engine.add(bombs({ probability: 1, fuseSeconds: 2, radius: 3, maxBombs: 1 })).start();
    human.insert(doc.length, '!');
    await sync();
    await waitFor(d => d.includes(BOMB));
    const at = human.getDocument().indexOf(BOMB);
    human.delete(at, `${BOMB}02`.length);
    await sync();
    await waitFor(() => messages.includes('bombs: defused'), 2500);
    await new Promise(r => setTimeout(r, 1200));
    await sync();
    expect(server.document).not.toContain(BLAST);
    expect(server.document).not.toContain(BOMB);
  });
});

describe('rules', () => {
  test('paragraphAt finds the block between blank lines', () => {
    const doc = 'one\n\ntwo\nlines\n\nthree';
    expect(paragraphAt(doc, 0)).toEqual({ start: 0, end: 3 });
    expect(paragraphAt(doc, 7)).toEqual({ start: 5, end: 14 });
    expect(paragraphAt(doc, doc.length)).toEqual({ start: 16, end: 21 });
  });

  test('cleanAnswer strips fences and tags and keeps whitespace', () => {
    expect(cleanAnswer('```\nArr\n```', ' hi\n')).toBe(' Arr\n');
    expect(cleanAnswer('<paragraph>\nArr\n</paragraph>', 'hi')).toBe('Arr');
  });

  /** An agent that shouts the paragraph, and records prompts. */
  const shouting = (prompts: string[], delayMs = 0): Agent => async function* (req) {
    prompts.push(req.prompt ?? '');
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    yield req.request.toUpperCase();
  };

  test('rewrites the paragraph a victim touched, once they pause', async () => {
    const prompts: string[] = [];
    const { human, engine, sync, waitFor } = await setup('intro\n\nhello\n\noutro');
    engine.add(rulesKeeper({ rules: ['shout'], agent: shouting(prompts), settleMs: 20 })).start();
    human.insert(12, ' there');
    await sync();
    await waitFor(doc => doc === 'intro\n\nHELLO THERE\n\noutro');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('<paragraph>\nhello there\n</paragraph>');
  });

  test('drops a stale rewrite and retries after the next pause', async () => {
    const prompts: string[] = [];
    const { human, engine, sync, waitFor } = await setup('abc');
    engine.add(rulesKeeper({ rules: ['shout'], agent: shouting(prompts, 60), settleMs: 20 })).start();
    human.insert(3, 'd');
    await sync();
    await waitFor(() => prompts.length === 1);
    human.insert(4, 'e');
    await sync();
    await waitFor(doc => doc === 'ABCDE');
    expect(prompts.length).toBeGreaterThanOrEqual(2);
  });
});

describe('everything at once', () => {
  test('all pranks together keep every client in sync', async () => {
    const { server, bot, human, other, sync, identify } = await setup('# Notes\n\nfirst\n\nsecond\n');
    identify(human, 'v', 'Victim');
    identify(other, 'm', 'Mallory');
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const engine = new PrankEngine(bot, { random, userFilter: /Victim/ });
    engines.push(engine);
    const prompts: string[] = [];
    engine
      .add(stutter({ probability: 0.2, deletes: true }))
      .add(fatFingers({ probability: 0.1 }))
      .add(transposer({ probability: 0.1 }))
      .add(stickyCaps({ probability: 0.05 }))
      .add(echo({ probability: 0.2 }))
      .add(homoglyphs({ probability: 0.1 }))
      .add(hauntedUndo({ probability: 0.5, burstGapMs: 15, delayMs: [10, 40] }))
      .add(ghostTypist({ everySeconds: 0.05, keystrokeMs: [1, 4], pauseMs: [5, 10] }))
      .add(bombs({ probability: 0.2, fuseSeconds: 1, radius: 4 }))
      .add(deny({ targets: userMatcher(['Mallory']) }))
      .add(rulesKeeper({
        rules: ['shout'], settleMs: 10,
        agent: async function* (req) { prompts.push(req.request); yield req.request.toUpperCase(); },
      }))
      .start();
    const words = 'lorem ipsum dolor sit amet consectetur ';
    const deadline = Date.now() + 1500;
    let i = 0;
    while (Date.now() < deadline) {
      const doc = human.getDocument();
      const at = Math.floor(random() * (doc.length + 1));
      if (i % 6 === 5 && at > 0) human.delete(at - 1, 1);
      else human.insert(at, words[i % words.length]);
      if (i % 10 === 0) other.insert(0, 'm');
      server.drain();
      await tick(3);
      // Pauses now and then, so the rules get a look.
      if (i % 40 === 39) await new Promise(r => setTimeout(r, 40));
      i++;
    }
    for (const e of engines) e.stop();
    await sync();
    expect(bot.getDocument()).toBe(server.document);
    expect(human.getDocument()).toBe(server.document);
    expect(other.getDocument()).toBe(server.document);
    expect(prompts.length).toBeGreaterThan(0);
  });
});
