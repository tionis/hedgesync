/**
 * In-memory simulation of a HedgeDoc 1.x realtime server for tests.
 *
 * The OT parts mirror upstream exactly:
 *   lib/ot/server.js                 (receiveOperation)
 *   lib/ot/editor-socketio-server.js (doc / operation / ack / broadcast /
 *                                     get_operations / retry-with-doc)
 * Messages travel through per-connection FIFO queues (Socket.IO preserves
 * order per connection) that the test delivers explicitly, so interleavings
 * are under test control and reproducible.
 */
import { TextOperation, OperationJSON } from '../../src/text-operation.js';
import type { SocketLike, SocketFactory } from '../../src/hedgedoc-client.js';

type Listener = (...args: any[]) => void;
interface Message {
  event: string;
  args: any[];
}

let nextConnId = 1;

/** One client connection: a client-side socket plus two message queues. */
export class SimConnection {
  readonly id = `sock${nextConnId++}`;
  readonly toServer: Message[] = [];
  readonly toClient: Message[] = [];
  closed = false;
  /** Joined the note room (upstream: addClient joins and sends doc atomically). */
  joined = false;
  opRetries = 0;
  readonly socket: SimClientSocket;

  constructor(readonly server: SimServer) {
    this.socket = new SimClientSocket(this);
    this.toClient.push({ event: 'connect', args: [] });
    this.toServer.push({ event: '__connect', args: [] });
  }

  sendToClient(event: string, ...args: any[]): void {
    if (!this.closed) this.toClient.push({ event, args: structuredClone(args) });
  }
}

export class SimClientSocket implements SocketLike {
  private listeners = new Map<string, Listener[]>();

  constructor(readonly conn: SimConnection) {}

  get id(): string {
    return this.conn.id;
  }

  on(event: string, listener: Listener): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, ...args: any[]): this {
    if (!this.conn.closed) this.conn.toServer.push({ event, args: structuredClone(args) });
    return this;
  }

  disconnect(): this {
    this.conn.server.closeConnection(this.conn, 'io client disconnect', false);
    return this;
  }

  removeAllListeners(): this {
    this.listeners.clear();
    return this;
  }

  /** Deliver an event to the client's handlers. */
  dispatch(event: string, args: any[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }
}

export interface SimServerOptions {
  document?: string;
  permission?: string;
  owner?: string | null;
  /** Return false to silently ignore a connection's edits (like HedgeDoc's mayWrite). */
  mayWrite?: (conn: SimConnection) => boolean;
}

export class SimServer {
  document: string;
  operations: TextOperation[] = [];
  connections: SimConnection[] = [];
  permission: string;
  owner: string | null;
  mayWrite: (conn: SimConnection) => boolean;

  constructor(options: SimServerOptions = {}) {
    this.document = options.document ?? '';
    this.permission = options.permission ?? 'freely';
    this.owner = options.owner ?? null;
    this.mayWrite = options.mayWrite ?? (() => true);
  }

  get revision(): number {
    return this.operations.length;
  }

  /** Socket factory to pass to HedgeDocClient. */
  readonly socketFactory: SocketFactory = () => {
    const conn = new SimConnection(this);
    this.connections.push(conn);
    return conn.socket;
  };

  get openConnections(): SimConnection[] {
    return this.connections.filter(c => !c.closed);
  }

  /** Close a connection. `notifyClient` simulates a network drop / server kick. */
  closeConnection(conn: SimConnection, reason: string, notifyClient = true): void {
    if (conn.closed) return;
    conn.closed = true;
    conn.toServer.length = 0;
    conn.toClient.length = 0;
    for (const other of this.openConnections) {
      other.sendToClient('client_left', conn.id);
    }
    if (notifyClient) conn.socket.dispatch('disconnect', [reason]);
  }

  /** Simulate a server restart: everyone is dropped and OT history starts over. */
  restart(): void {
    for (const conn of this.openConnections) this.closeConnection(conn, 'transport close');
    this.operations = [];
  }

  /** Queues with undelivered messages. */
  pendingQueues(): { conn: SimConnection; dir: 'toServer' | 'toClient' }[] {
    const result: { conn: SimConnection; dir: 'toServer' | 'toClient' }[] = [];
    for (const conn of this.openConnections) {
      if (conn.toServer.length) result.push({ conn, dir: 'toServer' });
      if (conn.toClient.length) result.push({ conn, dir: 'toClient' });
    }
    return result;
  }

  /** Deliver the next message on one queue. */
  deliver(conn: SimConnection, dir: 'toServer' | 'toClient'): void {
    const msg = conn[dir].shift();
    if (!msg || conn.closed) return;
    if (dir === 'toClient') {
      conn.socket.dispatch(msg.event, msg.args);
    } else {
      this.handle(conn, msg);
    }
  }

  /** Deliver everything until all queues are empty. */
  drain(maxSteps = 100_000): void {
    for (let i = 0; i < maxSteps; i++) {
      const queues = this.pendingQueues();
      if (queues.length === 0) return;
      this.deliver(queues[0].conn, queues[0].dir);
    }
    throw new Error('drain did not settle');
  }

  private docOut(force = false) {
    const out: Record<string, unknown> = { str: this.document, revision: this.revision, clients: {} };
    if (force) out.force = true;
    return out;
  }

  private handle(conn: SimConnection, msg: Message): void {
    switch (msg.event) {
      case '__connect':
        conn.joined = true;
        conn.sendToClient('doc', this.docOut());
        break;
      case 'refresh':
        conn.sendToClient('refresh', {
          title: 'Sim note',
          permission: this.permission,
          owner: this.owner,
          authors: {},
          authorship: [],
          createtime: 0,
          updatetime: 0,
        });
        break;
      case 'operation': {
        const [revision, operation] = msg.args as [number, OperationJSON];
        if (!this.mayWrite(conn)) return; // upstream: logged and silently ignored
        try {
          this.onOperation(conn, revision, operation);
          conn.opRetries = 0;
        } catch {
          conn.opRetries++;
          const force = conn.opRetries >= 3;
          if (force) conn.opRetries = 0;
          conn.sendToClient('doc', this.docOut(force));
        }
        break;
      }
      case 'get_operations': {
        const [base, head] = msg.args as [number, number];
        if (!base || typeof base !== 'number') return;
        if (!head || typeof head !== 'number') return;
        const ops = this.operations.slice(base, head).map(op => op.toJSON());
        conn.sendToClient('operations', head, ops);
        break;
      }
      case 'cursor focus':
      case 'cursor activity': {
        // Upstream: the user's out-data with .cursor, to everyone else in the note.
        const user = { id: conn.id, name: `sim-${conn.id}`, color: '#123456', cursor: msg.args[0] };
        for (const other of this.openConnections) {
          if (other !== conn && other.joined) other.sendToClient(msg.event, user);
        }
        break;
      }
      case 'cursor blur':
        for (const other of this.openConnections) {
          if (other !== conn && other.joined) other.sendToClient('cursor blur', { id: conn.id });
        }
        break;
      default:
        break;
    }
  }

  private onOperation(conn: SimConnection, revision: number, json: OperationJSON): void {
    let operation = TextOperation.fromJSON(json);
    if (revision < 0 || this.operations.length < revision) {
      throw new Error('operation revision not in history');
    }
    for (const concurrent of this.operations.slice(revision)) {
      operation = TextOperation.transform(operation, concurrent)[0];
    }
    this.document = operation.apply(this.document);
    this.operations.push(operation);
    const newRevision = this.operations.length;
    conn.sendToClient('ack', newRevision);
    for (const other of this.openConnections) {
      if (other !== conn && other.joined) other.sendToClient('operation', conn.id, newRevision, operation.toJSON(), null);
    }
  }
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const tick = (ms = 0) => new Promise<void>(resolve => setTimeout(resolve, ms));
