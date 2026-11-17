/**
 * Editing from inside change handlers: a client that answers remote edits
 * synchronously (inserting, deleting, several edits in one handler) must
 * stay in sync with the server, however the server's messages arrive.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { ChangeEvent } from '../../src/hedgedoc-client.js';
import { HedgeDocClient } from '../../src/hedgedoc-client.js';
import { SimServer } from '../sim/sim-server.js';
import { connectClient, settle, stopAll } from './helpers.js';

let clients: HedgeDocClient[] = [];
afterEach(() => {
  stopAll(clients);
  clients = [];
});

function rng(seed: number) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

async function setup(document: string) {
  const server = new SimServer({ document });
  const bot = await connectClient(server);
  const human = await connectClient(server);
  clients.push(bot, human);
  const sync = () => settle(server, [bot, human]);
  const agree = () => {
    expect(bot.getDocument()).toBe(server.document);
    expect(human.getDocument()).toBe(server.document);
  };
  return { server, bot, human, sync, agree };
}

describe('edits made inside a remote change handler', () => {
  test('one insert per remote edit', async () => {
    const { server, bot, human, sync, agree } = await setup('ab');
    bot.on('change', (e: ChangeEvent) => {
      if (e.type === 'remote') bot.insert(bot.getDocument().length, '!');
    });
    human.insert(1, 'x');
    await sync();
    expect(server.document).toBe('axb!');
    agree();
  });

  test('several edits in one handler, seeing each other', async () => {
    const { server, bot, human, sync, agree } = await setup('');
    bot.on('change', (e: ChangeEvent) => {
      if (e.type !== 'remote') return;
      bot.insert(0, '[');
      bot.insert(bot.getDocument().length, ']');
      bot.replace(1, 0, '<');
    });
    human.insert(0, 'x');
    await sync();
    expect(server.document).toBe('[<x]');
    agree();
  });

  test('remote edits arriving in a burst, while our own edits are in flight', async () => {
    const { server, bot, human, sync, agree } = await setup('');
    bot.on('change', (e: ChangeEvent) => {
      if (e.type === 'remote' && e.operation.ops.some(o => typeof o === 'string')) {
        bot.insert(bot.getDocument().length, '.');
      }
    });
    for (const ch of 'hello') {
      human.insert(human.getDocument().length, ch);
      bot.insert(0, '>');
      server.drain(); // delivers queued messages synchronously, back to back
    }
    await sync();
    agree();
    expect(server.document.replace(/[>.]/g, '')).toBe('hello');
  });

  test('a delete answering a delete', async () => {
    const { server, bot, human, sync, agree } = await setup('abcdef');
    bot.on('change', (e: ChangeEvent) => {
      const doc = bot.getDocument();
      if (e.type === 'remote' && doc.length > 0) bot.delete(0, 1);
    });
    human.delete(5, 1);
    await sync();
    expect(server.document).toBe('bcde');
    agree();
  });

  test('catching up after a lost ack, several missed edits answered on arrival', async () => {
    const server = new SimServer({ document: 'abc' });
    // History, so the catch-up request has a base > 0.
    const seeder = server.socketFactory('', {}) as any;
    server.drain();
    seeder.emit('operation', server.revision, [3, 'seed'], null);
    server.drain();
    seeder.disconnect();
    const a = await connectClient(server);
    const b = await connectClient(server);
    clients.push(a, b);
    const resyncs: string[] = [];
    a.on('resync', (e: { kind: string }) => resyncs.push(e.kind));
    a.on('change', (e: ChangeEvent) => {
      if (e.type === 'remote') a.insert(0, '+');
    });
    a.insert(0, 'X');
    const connA = server.openConnections.find(c => c.socket.id === a.socket!.id)!;
    server.deliver(connA, 'toServer');
    server.closeConnection(connA, 'transport close'); // the ack is lost
    for (const ch of 'ZYW') b.insert(b.getDocument().length, ch);
    server.drain();
    await settle(server, [a, b]);
    expect(resyncs).toEqual(['catchup']);
    expect(a.getDocument()).toBe(server.document);
    expect(b.getDocument()).toBe(server.document);
    expect(server.document.replace(/\+/g, '')).toBe('XabcseedZYW');
    expect(server.document).toContain('+');
  });

  test('a server restart with pending edits, answered on arrival', async () => {
    const { server, bot, human, sync, agree } = await setup('one two three');
    bot.on('change', (e: ChangeEvent) => {
      if (e.type === 'remote') bot.insert(bot.getDocument().length, '!');
    });
    bot.insert(0, '> ');
    human.insert(human.getDocument().length, ' four');
    server.restart();
    await sync();
    agree();
    expect(server.document).toContain('four');
  });

  test('every listener sees the remote edit before the answer to it', async () => {
    const { bot, human, sync } = await setup('ab');
    const seen: string[][] = [[], []];
    let doc = bot.getDocument();
    bot.on('change', (e: ChangeEvent) => {
      seen[0].push(e.type);
      if (e.type === 'remote') bot.insert(0, '!');
    });
    bot.on('change', (e: ChangeEvent) => {
      seen[1].push(e.type);
      // Each operation must apply to the document as this listener knows it.
      doc = e.operation.apply(doc);
    });
    human.insert(1, 'x');
    await sync();
    expect(seen).toEqual([['remote', 'local'], ['remote', 'local']]);
    expect(doc).toBe(bot.getDocument());
  });

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    test(`random edits on both sides converge (seed ${seed})`, async () => {
      const random = rng(seed);
      const { server, bot, human, sync, agree } = await setup('the quick brown fox');
      bot.on('change', (e: ChangeEvent) => {
        if (e.type !== 'remote' || random() < 0.3) return;
        const doc = bot.getDocument();
        const at = Math.floor(random() * (doc.length + 1));
        if (random() < 0.3 && doc.length > 0) bot.delete(Math.min(at, doc.length - 1), 1);
        else bot.insert(at, '*');
      });
      for (let i = 0; i < 80; i++) {
        const doc = human.getDocument();
        const at = Math.floor(random() * (doc.length + 1));
        if (random() < 0.3 && doc.length > 0) human.delete(Math.min(at, doc.length - 1), 1);
        else human.insert(at, String.fromCharCode(97 + (i % 26)));
        if (random() < 0.2) {
          const d = bot.getDocument();
          bot.insert(Math.floor(random() * (d.length + 1)), '#');
        }
        if (random() < 0.5) server.drain();
        if (i % 10 === 0) await sync();
      }
      await sync();
      agree();
    });
  }
});
