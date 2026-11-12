import { HedgeDocClient, HedgeDocClientOptions } from '../../src/hedgedoc-client.js';
import { SimServer, tick } from '../sim/sim-server.js';

export async function connectClient(
  server: SimServer,
  options: Partial<HedgeDocClientOptions> = {},
): Promise<HedgeDocClient> {
  const client = new HedgeDocClient({
    serverUrl: 'http://sim.invalid',
    noteId: 'note',
    cookie: 'connect.sid=test',
    socketFactory: server.socketFactory,
    reconnect: { initialDelay: 1, maxDelay: 5, maxAttempts: 1000 },
    ...options,
  });
  let done = false;
  const pending = client.connect().finally(() => {
    done = true;
  });
  while (!done) {
    server.drain();
    await tick();
  }
  await pending;
  return client;
}

/** Deliver messages and let timers run until the system is quiet. */
export async function settle(server: SimServer, clients: HedgeDocClient[], maxRounds = 500): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    server.drain();
    await tick(1);
    const quiet =
      server.pendingQueues().length === 0 &&
      clients.every(c => c.ready && c.isSynchronized());
    if (quiet) return;
  }
  const states = clients.map(c => `${c.ready ? 'ready' : 'not-ready'}/${c.otClient?.stateName}`).join(', ');
  throw new Error(`system did not settle: ${states}`);
}

export function stopAll(clients: HedgeDocClient[]): void {
  for (const c of clients) c.disconnect();
}
