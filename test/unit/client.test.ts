import { afterEach, describe, expect, test } from 'bun:test';
import { HedgeDocClient } from '../../src/hedgedoc-client.js';
import { SimServer, tick } from '../sim/sim-server.js';
import { connectClient, settle, stopAll } from './helpers.js';

let clients: HedgeDocClient[] = [];
async function connect(server: SimServer, options = {}) {
  const c = await connectClient(server, options);
  clients.push(c);
  return c;
}
afterEach(() => {
  stopAll(clients);
  clients = [];
});

/** Give the server some history so recovery requests have base > 0. */
function seedHistory(server: SimServer, text = 'seed') {
  const conn = server.socketFactory('', {}) as any;
  server.drain();
  conn.emit('operation', server.revision, [server.document.length, text].filter(x => x !== 0), null);
  server.drain();
  conn.disconnect();
}

describe('editing', () => {
  test('concurrent edits from two clients converge', async () => {
    const server = new SimServer({ document: 'hello world' });
    const a = await connect(server);
    const b = await connect(server);
    a.insert(0, 'A');
    a.insert(a.document.length, '!');
    b.replace(6, 5, 'there');
    b.insert(0, 'B');
    await settle(server, [a, b]);
    expect(a.document).toBe(server.document);
    expect(b.document).toBe(server.document);
    expect(server.document).toContain('there');
  });

  test('replaceRegex applies every match as one operation', async () => {
    const server = new SimServer({ document: 'a a a a a' });
    const a = await connect(server);
    expect(a.replaceRegex(/a/g, 'bb')).toBe(5);
    await settle(server, [a]);
    expect(server.document).toBe('bb bb bb bb bb');
    expect(server.revision).toBe(1);
  });

  test('replaceRegex supports String.replace templates', async () => {
    const server = new SimServer({ document: 'x=1, y=2' });
    const a = await connect(server);
    a.replaceRegex(/(?<k>\w)=(\d)/g, '$<k>:$2[$&]$$');
    expect(a.document).toBe('x:1[x=1]$, y:2[y=2]$');
  });

  test('replaceRegex with an empty-matching pattern terminates', async () => {
    const server = new SimServer({ document: 'abc' });
    const a = await connect(server);
    expect(a.replaceRegex(/x*/g, '-')).toBe(4);
    expect(a.document).toBe('-a-b-c-');
  });

  test('replaceRegex does not mutate the caller regex', async () => {
    const server = new SimServer({ document: 'aaa' });
    const a = await connect(server);
    const re = /a/g;
    re.lastIndex = 2;
    a.replaceRegex(re, 'b');
    expect(a.document).toBe('bbb');
    expect(re.lastIndex).toBe(2);
  });

  test('batch composes dependent edits and sends one operation', async () => {
    const server = new SimServer({ document: 'hello' });
    const a = await connect(server);
    const op = a.batch(() => {
      a.insert(0, 'x');
      a.insert(0, 'y');
      a.setLine(0, a.getLine(0)! + '!');
    });
    expect(op).not.toBeNull();
    expect(a.document).toBe('yxhello!');
    await settle(server, [a]);
    expect(server.document).toBe('yxhello!');
    expect(server.revision).toBe(1);
  });

  test('batch rolls back when the callback throws', async () => {
    const server = new SimServer({ document: 'hello' });
    const a = await connect(server);
    expect(() => a.batch(() => {
      a.insert(0, 'x');
      throw new Error('boom');
    })).toThrow('boom');
    expect(a.document).toBe('hello');
    expect(a.isSynchronized()).toBe(true);
  });

  test('updateContent keeps concurrent edits in unchanged regions', async () => {
    const server = new SimServer({ document: 'one\ntwo\nthree\n' });
    const a = await connect(server);
    const b = await connect(server);
    b.insert(0, '# title\n');            // concurrent edit at the top
    a.updateContent('one\nTWO\nthree\n'); // edit in the middle
    await settle(server, [a, b]);
    expect(server.document).toBe('# title\none\nTWO\nthree\n');
  });
});

describe('undo', () => {
  test('local, remote, local edit inside the grouping window', async () => {
    const server = new SimServer({ document: 'hello' });
    const a = await connect(server);
    const b = await connect(server);
    a.insert(5, '!');
    await settle(server, [a, b]);
    b.insert(b.document.length, ' world');
    await settle(server, [a, b]);
    a.insert(0, '>'); // used to throw in _pushUndo and leave the edit unsent
    await settle(server, [a, b]);
    expect(server.document).toBe('>hello! world');
  });

  test('undo keeps remote edits made since', async () => {
    const server = new SimServer({ document: 'hello' });
    const a = await connect(server, { undoGroupInterval: 0 });
    const b = await connect(server);
    a.insert(0, 'X');
    await settle(server, [a, b]);
    b.insert(b.document.length, ' world');
    await settle(server, [a, b]);
    expect(a.undo()).toBe(true);
    await settle(server, [a, b]);
    expect(server.document).toBe('hello world');
    expect(a.redo()).toBe(true);
    await settle(server, [a, b]);
    expect(server.document).toBe('Xhello world');
  });

  test('edits within the grouping window undo together', async () => {
    const server = new SimServer({ document: '' });
    const a = await connect(server, { undoGroupInterval: 10_000 });
    a.insert(0, 'a');
    a.insert(1, 'b');
    a.undo();
    expect(a.document).toBe('');
  });
});

describe('acknowledgement', () => {
  test('flush resolves once the server acknowledged', async () => {
    const server = new SimServer({ document: '' });
    const a = await connect(server);
    a.insert(0, 'x');
    expect(a.isSynchronized()).toBe(false);
    const flushed = a.flush(1000);
    server.drain();
    await flushed;
    expect(a.isSynchronized()).toBe(true);
  });

  test('flush rejects when the server silently ignores edits', async () => {
    const server = new SimServer({ document: '', mayWrite: () => false });
    const a = await connect(server);
    a.insert(0, 'x');
    server.drain();
    await expect(a.flush(50)).rejects.toThrow(/not acknowledged/);
  });

  test('canEdit is false for non-owners of owner-only notes once identity is known', async () => {
    const server = new SimServer({ document: '', permission: 'locked', owner: 'owner-id' });
    const a = await connect(server);
    expect(a.canEdit()).toBe(true); // identity unknown yet: benefit of the doubt
    a.users.set(a.socket!.id!, { id: a.socket!.id!, userid: 'someone-else' });
    expect(a.canEdit()).toBe(false);
    a.users.set(a.socket!.id!, { id: a.socket!.id!, userid: 'owner-id' });
    expect(a.canEdit()).toBe(true);
  });
});

describe('recovery', () => {
  test('stale ack: missed broadcast is fetched and our op is not applied twice', async () => {
    const server = new SimServer({ document: 'abc' });
    seedHistory(server);
    const a = await connect(server);
    const b = await connect(server);
    const [connA] = server.openConnections.filter(c => c.socket.id === a.socket!.id);
    const [connB] = server.openConnections.filter(c => c.socket.id === b.socket!.id);

    a.insert(a.document.length, 'X');
    b.insert(0, 'Y');
    server.deliver(connB, 'toServer'); // B's op reaches the server first
    connA.toClient.length = 0;          // ...and its broadcast to A is lost
    server.deliver(connA, 'toServer'); // A's op is acked with a revision gap
    await settle(server, [a, b]);

    expect(server.document).toBe('YabcseedX');
    expect(a.document).toBe(server.document);
    expect(b.document).toBe(server.document);
    a.insert(0, '#');
    await settle(server, [a, b]);
    expect(server.document).toBe('#YabcseedX');
  });

  test('missed broadcast without pending edits triggers a resync', async () => {
    const server = new SimServer({ document: 'abc' });
    const a = await connect(server);
    const b = await connect(server);
    const errors: unknown[] = [];
    a.on('ot-error', (e: unknown) => errors.push(e));
    const connA = server.openConnections.find(c => c.socket.id === a.socket!.id)!;
    const connB = server.openConnections.find(c => c.socket.id === b.socket!.id)!;
    b.insert(0, '1');
    server.deliver(connB, 'toServer');
    connA.toClient.length = 0; // A misses revision n+1
    b.insert(0, '2');           // A will see n+2 and detect the gap
    await settle(server, [a, b]);
    expect(errors.length).toBe(1);
    expect(a.document).toBe(server.document);
    expect(server.document).toBe('21abc');
  });

  test('pending edit survives a dropped connection', async () => {
    const server = new SimServer({ document: 'abc' });
    const a = await connect(server);
    a.insert(3, 'X');                  // still queued to the server
    const conn = server.openConnections[0];
    server.closeConnection(conn, 'transport close');
    await settle(server, [a]);
    expect(server.document).toBe('abcX');
    expect(a.document).toBe('abcX');
  });

  test('lost ack is detected on reconnect, no duplicate', async () => {
    const server = new SimServer({ document: 'abc' });
    const resyncs: string[] = [];
    const a = await connect(server);
    a.on('resync', (e: { kind: string }) => resyncs.push(e.kind));
    a.insert(3, 'X');
    const conn = server.openConnections[0];
    server.deliver(conn, 'toServer');  // server applies it and queues the ack
    server.closeConnection(conn, 'transport close'); // ack lost
    await settle(server, [a]);
    expect(server.document).toBe('abcX');
    expect(a.document).toBe('abcX');
    expect(resyncs).toEqual(['acked']);
  });

  test('lost ack plus later edits by others: verified catch-up, no duplicate', async () => {
    const server = new SimServer({ document: 'abc' });
    seedHistory(server);
    const a = await connect(server);
    const b = await connect(server);
    const resyncs: string[] = [];
    a.on('resync', (e: { kind: string }) => resyncs.push(e.kind));
    a.insert(0, 'X');
    const connA = server.openConnections.find(c => c.socket.id === a.socket!.id)!;
    server.deliver(connA, 'toServer');                 // applied first...
    server.closeConnection(connA, 'transport close');  // ...ack lost
    b.insert(b.document.length, 'Z');                  // others keep editing (b applies X first via drain below)
    server.drain();
    await settle(server, [a, b]);
    expect(server.document).toBe('XabcseedZ');
    expect(a.document).toBe(server.document);
    expect(resyncs).toEqual(['catchup']);
  });

  test('server restart: pending edits are rebased onto the reloaded note', async () => {
    const server = new SimServer({ document: 'one two three' });
    seedHistory(server, '');
    const a = await connect(server);
    const resyncs: string[] = [];
    a.on('resync', (e: { kind: string }) => resyncs.push(e.kind));
    a.insert(0, 'A ');
    server.restart();
    server.document = 'one 2 three';      // someone else edited while we were away
    await settle(server, [a]);
    expect(server.document).toBe('A one 2 three');
    expect(a.document).toBe(server.document);
    expect(resyncs).toEqual(['rebased']);
  });

  test('forced doc discards pending edits loudly', async () => {
    const server = new SimServer({ document: 'abc' });
    const a = await connect(server);
    const events: any[] = [];
    a.on('resync', (e: unknown) => events.push(e));
    a.insert(0, 'X');
    const conn = server.openConnections[0];
    conn.toServer.length = 0; // op never arrives
    conn.sendToClient('doc', { str: 'server', revision: 7, clients: {}, force: true });
    await settle(server, [a]);
    expect(a.document).toBe('server');
    expect(events[0].kind).toBe('discarded');
  });
});

describe('connect', () => {
  test('rejects on 403 without scheduling reconnects', async () => {
    const server = new SimServer();
    const client = new HedgeDocClient({
      serverUrl: 'http://sim.invalid',
      noteId: 'n',
      cookie: 'connect.sid=x',
      socketFactory: (url, opts) => {
        const s = server.socketFactory(url, opts) as any;
        s.conn.toServer.length = 0;
        s.conn.toClient.push({ event: 'info', args: [{ code: 403 }] });
        return s;
      },
    });
    let error: Error | null = null;
    const p = client.connect().catch((e: Error) => { error = e; });
    while (!error) {
      server.drain();
      await tick();
    }
    await p;
    expect(error!.message).toBe('Access forbidden');
    await tick(5);
    expect(client.getReconnectConfig().scheduled).toBe(false);
  });

  test('resolves after permissions are known', async () => {
    const server = new SimServer({ permission: 'editable' });
    const a = await connect(server);
    expect(a.noteInfo.permission).toBe('editable');
    expect(a.canEdit()).toBe(true);
  });
});

describe('drivers', () => {
  test('protocol hedgedoc2 is refused clearly; a custom driver can be plugged in', () => {
    expect(() => new HedgeDocClient({ serverUrl: 'http://x', noteId: 'n', protocol: 'hedgedoc2' })).toThrow('not supported yet');
    const client = new HedgeDocClient({
      serverUrl: 'http://x',
      noteId: 'n',
      driver: (host) => ({
        protocol: 'hedgedoc2', connected: true, ready: true, revision: 0,
        noteInfo: { title: '', permission: 'freely', owner: null, authors: {}, createtime: null, updatetime: null },
        users: new Map(),
        reconnectPolicy: undefined as any,
        connect: async () => host.loadDocument('hello'),
        disconnect: () => {},
        submit: (op) => sent.push(op.toJSON()),
        isSynchronized: () => true,
        syncState: () => 'synced',
        permissionError: () => null,
        refresh: () => {}, requestOnlineUsers: () => {}, requestVersion: () => {},
      }),
    });
    const sent: unknown[] = [];
    return client.connect().then(() => {
      client.insert(5, ' world');
      expect(client.getDocument()).toBe('hello world');
      expect(sent).toEqual([[5, ' world']]);
      expect(client.protocol).toBe('hedgedoc2');
      expect(client.socket).toBeNull();
    });
  });
});
