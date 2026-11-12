/**
 * Randomised convergence test: several clients edit concurrently while the
 * network reorders deliveries across connections, drops broadcasts and
 * connections, and the server occasionally restarts (resetting OT history).
 * After the dust settles every client must hold exactly the server document.
 *
 * Reproduce a failure with FUZZ_SEED=<seed> bun test test/unit/fuzz.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { HedgeDocClient } from '../../src/hedgedoc-client.js';
import { SimServer, rng, tick } from '../sim/sim-server.js';
import { connectClient, settle, stopAll } from './helpers.js';

interface FaultRates {
  dropBroadcast: number;
  dropConnection: number;
  restart: number;
}

const NO_FAULTS: FaultRates = { dropBroadcast: 0, dropConnection: 0, restart: 0 };
const FAULTS: FaultRates = { dropBroadcast: 0.01, dropConnection: 0.005, restart: 0.001 };

function randomEdit(client: HedgeDocClient, r: () => number): void {
  const doc = client.document;
  const pos = Math.floor(r() * (doc.length + 1));
  const len = Math.floor(r() * Math.min(4, doc.length - pos + 1));
  const text = ['a', 'bc', '\n', 'xyz', '🙂', ''][Math.floor(r() * 6)];
  const roll = r();
  if (roll < 0.35) client.insert(pos, text || 'q');
  else if (roll < 0.5) client.delete(pos, len);
  else if (roll < 0.65) client.replace(pos, len, text);
  else if (roll < 0.72) client.replaceRegex(/b/g, 'B');
  else if (roll < 0.8) {
    client.batch(() => {
      client.insert(0, '<');
      client.insert(client.document.length, '>');
    });
  } else if (roll < 0.88) {
    const lines = doc.split('\n');
    lines.reverse();
    client.updateContent(lines.join('\n'));
  } else if (roll < 0.94) client.undo();
  else client.redo();
}

async function run(seed: number, faults: FaultRates, steps: number): Promise<void> {
  const r = rng(seed);
  const server = new SimServer({ document: 'start\n' });
  const clientCount = 2 + Math.floor(r() * 3);
  const clients: HedgeDocClient[] = [];
  try {
    const incidents: string[] = [];
    for (let i = 0; i < clientCount; i++) {
      const client = await connectClient(server, { undoGroupInterval: 0 });
      client.on('ot-error', (e: { type: string; error: Error }) => incidents.push(`ot-error ${e.type}: ${e.error.message}`));
      client.on('resync', (e: { kind: string }) => incidents.push(`resync ${e.kind}`));
      clients.push(client);
    }

    for (let step = 0; step < steps; step++) {
      const roll = r();
      if (roll < 0.3) {
        const client = clients[Math.floor(r() * clients.length)];
        if (client.ready) randomEdit(client, r);
      } else if (roll < 0.3 + faults.dropBroadcast) {
        const conns = server.openConnections.filter(c => c.toClient.some(m => m.event === 'operation'));
        if (conns.length) {
          const conn = conns[Math.floor(r() * conns.length)];
          const idx = conn.toClient.findIndex(m => m.event === 'operation');
          conn.toClient.splice(idx, 1);
        }
      } else if (roll < 0.3 + faults.dropBroadcast + faults.dropConnection) {
        const conns = server.openConnections;
        if (conns.length) server.closeConnection(conns[Math.floor(r() * conns.length)], 'transport close');
      } else if (roll < 0.3 + faults.dropBroadcast + faults.dropConnection + faults.restart) {
        server.restart();
      } else if (roll < 0.95) {
        const queues = server.pendingQueues();
        if (queues.length) {
          const q = queues[Math.floor(r() * queues.length)];
          server.deliver(q.conn, q.dir);
        }
      } else {
        await tick(1); // let reconnect timers fire
      }
    }

    await settle(server, clients, 2000);
    for (const client of clients) {
      expect(client.document).toBe(server.document);
    }
    if (faults === NO_FAULTS) {
      // Without faults nothing may ever need recovery.
      expect(incidents).toEqual([]);
    }
  } catch (error) {
    (error as Error).message = `[seed ${seed}] ${(error as Error).message}`;
    throw error;
  } finally {
    stopAll(clients);
  }
}

const fixedSeed = process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : null;
const seeds = fixedSeed !== null ? [fixedSeed] : Array.from({ length: 60 }, (_, i) => i + 1);

describe('fuzz: convergence', () => {
  test('reliable network', async () => {
    for (const seed of seeds) await run(seed, NO_FAULTS, 400);
  }, 120_000);

  test('lossy network with reconnects and restarts', async () => {
    for (const seed of seeds) await run(1000 + seed, FAULTS, 400);
  }, 120_000);
});
