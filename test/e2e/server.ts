/**
 * A small HedgeDoc 1.x stand-in for end-to-end CLI tests: the realtime
 * protocol over real socket.io, plus the few HTTP routes the CLI uses.
 * Notes are created on first access.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Server } from 'socket.io';
import { TextOperation } from '../../src/text-operation.js';

interface Note {
  document: string;
  operations: TextOperation[];
  permission: string;
}

export interface TestServer {
  url: string;
  notes: Map<string, Note>;
  note(id: string): Note;
  close(): Promise<void>;
}

export async function startTestServer(initial: Record<string, string | { document: string; permission: string }> = {}): Promise<TestServer> {
  const notes = new Map<string, Note>();
  const note = (id: string): Note => {
    let n = notes.get(id);
    if (!n) {
      n = { document: '', operations: [], permission: 'freely' };
      notes.set(id, n);
    }
    return n;
  };
  for (const [id, value] of Object.entries(initial)) {
    const n = note(id);
    if (typeof value === 'string') n.document = value;
    else Object.assign(n, value);
  }

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, body: string, type = 'text/plain') => {
      // Like HedgeDoc (saveUninitialized), every response carries a session cookie.
      res.writeHead(status, { 'content-type': type, 'set-cookie': 'connect.sid=anon; Path=/; HttpOnly' });
      res.end(body);
    };
    const download = /^\/([^/]+)\/download$/.exec(url.pathname);
    if (download) return send(200, note(decodeURIComponent(download[1])).document, 'text/markdown');
    if (url.pathname === '/me') {
      const loggedIn = (req.headers.cookie ?? '').includes('connect.sid=good');
      return send(200, JSON.stringify(loggedIn ? { status: 'ok', id: 'u1', name: 'Tester' } : { status: 'forbidden' }), 'application/json');
    }
    if (url.pathname === '/status') {
      return send(200, JSON.stringify({ onlineNotes: notes.size, onlineUsers: 0 }), 'application/json');
    }
    send(404, 'Not found');
  });

  const io = new Server(http, { path: '/socket.io/' });
  io.on('connection', (socket) => {
    const id = String(socket.handshake.query.noteId ?? '');
    const n = note(id);
    const room = `note:${id}`;
    socket.join(room);
    const info = () => ({ title: id, permission: n.permission, owner: null, authors: {}, authorship: [] });
    const users = () => [...io.sockets.adapter.rooms.get(room) ?? []].map(sid => ({ id: sid, name: `user-${sid.slice(0, 4)}`, color: '#000' }));

    socket.emit('doc', { str: n.document, revision: n.operations.length, clients: {} });
    socket.emit('refresh', info());
    io.to(room).emit('online users', { users: users() });

    socket.on('refresh', () => socket.emit('refresh', info()));
    socket.on('online users', () => socket.emit('online users', { users: users() }));
    socket.on('operation', (revision: number, json: unknown) => {
      if (n.permission === 'locked') return; // silently dropped, like HedgeDoc for read-only sessions
      let op = TextOperation.fromJSON(json as never);
      for (const other of n.operations.slice(revision)) op = TextOperation.transform(op, other)[0];
      n.document = op.apply(n.document);
      n.operations.push(op);
      socket.emit('ack', n.operations.length);
      socket.to(room).emit('operation', socket.id, n.operations.length, op.toJSON(), null);
    });
    socket.on('get_operations', (base: number, head: number) => {
      socket.emit('operations', head, n.operations.slice(base, head).map(o => o.toJSON()));
    });
    socket.on('disconnect', () => io.to(room).emit('online users', { users: users() }));
  });

  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    notes,
    note,
    close: () => new Promise<void>((resolve) => {
      io.close();
      http.close(() => resolve());
    }),
  };
}
