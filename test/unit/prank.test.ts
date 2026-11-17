import { afterEach, describe, expect, test } from 'bun:test';
import { HedgeDocClient } from '../../src/hedgedoc-client.js';
import { PrankEngine, stutter, type PrankEngineOptions, type PrankEvent } from '../../src/prank.js';
import { SimServer } from '../sim/sim-server.js';
import { connectClient, settle, stopAll } from './helpers.js';

let clients: HedgeDocClient[] = [];
let engines: PrankEngine[] = [];

afterEach(() => {
  for (const e of engines) e.stop();
  stopAll(clients);
  clients = [];
  engines = [];
});

/** A note with the prankster bot and a human victim. */
async function setup(document: string, options: PrankEngineOptions = {}) {
  const server = new SimServer({ document });
  const bot = await connectClient(server);
  const human = await connectClient(server);
  clients.push(bot, human);
  const engine = new PrankEngine(bot, options);
  engines.push(engine);
  const events: PrankEvent[] = [];
  engine.onPrank(e => events.push(e));
  const sync = () => settle(server, [bot, human]);
  return { server, bot, human, engine, events, sync };
}

describe('stutter', () => {
  test('always doubles typed characters at probability 1', async () => {
    const { server, human, engine, sync } = await setup('ab');
    engine.add(stutter({ probability: 1 })).start();
    human.insert(1, 'x');
    await sync();
    expect(server.document).toBe('axxb');
    expect(human.getDocument()).toBe('axxb');
  });

  test('never touches anything at probability 0', async () => {
    const { server, human, engine, sync } = await setup('ab');
    engine.add(stutter({ probability: 0, deletes: true })).start();
    human.insert(1, 'x');
    await sync();
    human.delete(0, 1);
    await sync();
    expect(server.document).toBe('xb');
  });

  test('leaves pastes alone by default', async () => {
    const { server, human, engine, sync } = await setup('');
    engine.add(stutter({ probability: 1 })).start();
    human.insert(0, 'a pasted sentence');
    await sync();
    expect(server.document).toBe('a pasted sentence');
  });

  test('doubles each character of longer inserts when allowed', async () => {
    const { server, human, engine, sync } = await setup('');
    engine.add(stutter({ probability: 1 })).start();
    human.insert(0, 'abc');
    await sync();
    expect(server.document).toBe('aabbcc');
  });

  test('keeps surrogate pairs intact', async () => {
    const { server, human, engine, sync } = await setup('');
    engine.add(stutter({ probability: 1 })).start();
    human.insert(0, '😀');
    await sync();
    expect(server.document).toBe('😀😀');
  });

  test('doubles a backspace by eating the character to its left', async () => {
    const { server, human, engine, sync } = await setup('hello');
    engine.add(stutter({ probability: 1, deletes: true })).start();
    human.delete(4, 1);
    await sync();
    expect(server.document).toBe('hel');
  });

  test('ignores deletes unless asked', async () => {
    const { server, human, engine, sync } = await setup('hello');
    engine.add(stutter({ probability: 1 })).start();
    human.delete(4, 1);
    await sync();
    expect(server.document).toBe('hell');
  });

  test('uses the random source per character', async () => {
    const rolls = [0.1, 0.9, 0.1];
    const { server, human, engine, sync } = await setup('', { random: () => rolls.shift() ?? 1 });
    engine.add(stutter({ probability: 0.5, maxInsertLength: 10 })).start();
    human.insert(0, 'abc');
    await sync();
    expect(server.document).toBe('aabcc');
  });

  test('stays in sync while the victim keeps typing', async () => {
    const { server, bot, human, engine, sync } = await setup('');
    engine.add(stutter({ probability: 0.5, deletes: true })).start();
    for (let i = 0; i < 60; i++) {
      const doc = human.getDocument();
      if (i % 7 === 6 && doc.length > 0) human.delete(doc.length - 1, 1);
      else human.insert(doc.length, String.fromCharCode(97 + (i % 26)));
      server.drain();
      if (i % 3 === 0) await sync();
    }
    await sync();
    expect(bot.getDocument()).toBe(server.document);
    expect(human.getDocument()).toBe(server.document);
  });

  test('ignores its own edits and the local client', async () => {
    const { server, bot, engine, events, sync } = await setup('');
    engine.add(stutter({ probability: 1 })).start();
    bot.insert(0, 'x');
    await sync();
    expect(server.document).toBe('x');
    expect(events).toHaveLength(0);
  });

  test('only pranks the targeted users', async () => {
    const { server, bot, human, engine, sync } = await setup('', { allowedUserIds: ['victim'] });
    engine.add(stutter({ probability: 1 })).start();
    human.insert(0, 'a');
    await sync();
    expect(server.document).toBe('a');
    bot.users.set(human.socket!.id!, { id: human.socket!.id!, userid: 'victim', name: 'Victim' });
    human.insert(1, 'b');
    await sync();
    expect(server.document).toBe('abb');
  });

  test('reports what it did', async () => {
    const { human, engine, events, sync } = await setup('');
    engine.add(stutter({ probability: 1 })).start();
    human.insert(0, 'q');
    await sync();
    expect(events).toEqual([{ prank: 'stutter', user: undefined, edits: [{ type: 'insert', index: 1, text: 'q' }] }]);
  });
});

describe('parsePercent', () => {
  test('accepts plain numbers and percent signs', async () => {
    const { parsePercent } = await import('../../src/cli/commands/prank.js');
    expect(parsePercent('30', '--x')).toBe(0.3);
    expect(parsePercent('2.5%', '--x')).toBe(0.025);
    expect(() => parsePercent('120', '--x')).toThrow();
    expect(() => parsePercent('lots', '--x')).toThrow();
  });
});
