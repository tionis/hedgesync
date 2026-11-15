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
  /** Account id of the owner ('u1' is the account behind connect.sid=good). */
  owner: string | null;
  /** Saved revisions (HedgeDoc saves them periodically; tests add them explicitly). */
  revisions: { time: number; content: string }[];
  viewcount: number;
}

export interface HistoryItem { id: string; text: string; time: number; tags: string[]; pinned: boolean }

export interface TestServer {
  url: string;
  notes: Map<string, Note>;
  /** History of the logged-in account. */
  history: HistoryItem[];
  /** Bodies received by /uploadimage. */
  uploads: string[];
  /** Cookies sent to /logout. */
  logouts: string[];
  note(id: string): Note;
  close(): Promise<void>;
}

const PERMISSIONS = ['freely', 'editable', 'limited', 'locked', 'protected', 'private'];
const userOf = (cookie: string | undefined) => ((cookie ?? '').includes('connect.sid=good') ? 'u1' : null);

export async function startTestServer(initial: Record<string, string | { document: string; permission: string }> = {}): Promise<TestServer> {
  const notes = new Map<string, Note>();
  const history: HistoryItem[] = [];
  const uploads: string[] = [];
  const logouts: string[] = [];
  let created = 0;
  const note = (id: string): Note => {
    let n = notes.get(id);
    if (!n) {
      n = { document: '', operations: [], permission: 'freely', owner: null, revisions: [], viewcount: 0 };
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
    const action = /^\/([^/]+)\/(publish|slide|info|revision)(?:\/(\d+))?$/.exec(url.pathname);
    if (action) {
      const [, rawId, act, time] = action;
      const id = decodeURIComponent(rawId);
      const existing = notes.get(id);
      if (!existing) return send(404, 'Not found'); // findNote without create
      if (act === 'publish' || act === 'slide') {
        res.writeHead(302, { location: `http://${req.headers.host}/${act === 'publish' ? 's' : 'p'}/short-${id}` });
        return res.end();
      }
      if (act === 'info') {
        return send(200, JSON.stringify({ title: id, description: null, viewcount: existing.viewcount, createtime: '2026-01-01T00:00:00.000Z', updatetime: '2026-01-02T00:00:00.000Z' }), 'application/json');
      }
      if (time) {
        const rev = existing.revisions.find(r => r.time === Number(time));
        return rev ? send(200, JSON.stringify({ content: rev.content, patch: [], authorship: [] }), 'application/json') : send(404, 'Not found');
      }
      return send(200, JSON.stringify({ revision: existing.revisions.map(r => ({ time: r.time, length: r.content.length })) }), 'application/json');
    }
    if (url.pathname === '/logout') {
      logouts.push(req.headers.cookie ?? '');
      res.writeHead(302, { location: '/' });
      return res.end();
    }
    if (url.pathname === '/history' && req.method === 'GET') {
      if (!userOf(req.headers.cookie)) return send(403, 'Forbidden');
      return send(200, JSON.stringify({ history }), 'application/json');
    }
    if (url.pathname === '/new' && (req.method === 'POST' || req.method === 'GET')) {
      const id = `created${++created}`;
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        Object.assign(note(id), { document: body, owner: userOf(req.headers.cookie) });
        res.writeHead(302, { location: `/${id}`, 'set-cookie': 'connect.sid=anon; Path=/; HttpOnly' });
        res.end();
      });
      return;
    }
    if (url.pathname === '/uploadimage' && req.method === 'POST') {
      let body = '';
      req.setEncoding('latin1');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        if (!/name="image"; filename="[^"]+"/.test(body)) return send(400, 'no image');
        uploads.push(body);
        send(200, JSON.stringify({ link: `http://img.test/upload_${uploads.length}.png` }), 'application/json');
      });
      return;
    }
    if (url.pathname === '/config') {
      return send(200, "window.domain = 'localhost'\nwindow.urlpath = ''\nwindow.version = '1.12.2'\nwindow.userToken = 'tok'\n", 'application/javascript');
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
    const userId = userOf(socket.handshake.headers.cookie);
    (socket.data as { userId: string | null }).userId = userId;
    const info = () => ({ title: id, permission: n.permission, owner: n.owner, authors: {}, authorship: [] });
    const users = () => [...io.sockets.adapter.rooms.get(room) ?? []].map(sid => ({
      id: sid,
      userid: (io.sockets.sockets.get(sid)?.data as { userId?: string | null } | undefined)?.userId ?? null,
      name: `user-${sid.slice(0, 4)}`,
      color: '#000',
    }));

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
    // Owner actions: silently ignored unless the socket's account owns the note.
    socket.on('permission', (permission: string) => {
      if (!userId || n.owner !== userId || !PERMISSIONS.includes(permission)) return;
      n.permission = permission;
      io.to(room).emit('permission', { permission });
    });
    socket.on('delete', () => {
      if (!userId || n.owner !== userId) return;
      notes.delete(id);
      io.to(room).emit('delete');
      setTimeout(() => io.in(room).disconnectSockets(true), 0);
    });
    for (const event of ['cursor focus', 'cursor activity']) {
      socket.on(event, (cursor: unknown) => socket.to(room).emit(event, { ...users().find(u => u.id === socket.id), cursor }));
    }
    socket.on('cursor blur', () => socket.to(room).emit('cursor blur', { id: socket.id }));
    socket.on('disconnect', () => io.to(room).emit('online users', { users: users() }));
  });

  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    notes,
    history,
    uploads,
    logouts,
    note,
    close: () => new Promise<void>((resolve) => {
      io.disconnectSockets(true);
      io.close();
      http.close(() => resolve());
      // Keep-alive connections from in-process clients would hold close() open.
      http.closeAllConnections();
      // Bun's server can miss the close of a websocket that disconnected moments
      // before; don't let that hang the test run.
      setTimeout(resolve, 1000).unref();
    }),
  };
}
