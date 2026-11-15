/**
 * HedgeDoc 1.x driver: Socket.IO transport and ot.js-compatible OT.
 *
 * Protocol summary (server side: lib/realtime/*.js in hedgedoc 1.x):
 * - The socket is authenticated by the express session cookie; without one
 *   the driver first fetches /config to get an anonymous session.
 * - The server sends `doc` {str, revision, clients, force}; the client asks
 *   for `refresh` (title, permission, owner, authorship, ...).
 * - Edits: client `operation`(revision, op, selection) -> server `ack`(revision)
 *   to the author and `operation`(clientId, revision, op, selection) to others.
 *   `get_operations`(base, head) recovers missed broadcasts via `operations`.
 * - Presence: `online users`, `user status`, `client_left`, `cursor *`.
 */

import { io } from 'socket.io-client';
import type { ManagerOptions, SocketOptions } from 'socket.io-client';
import { TextOperation, type OperationJSON } from '../text-operation.js';
import { OTClient, OTDesyncError } from '../ot-client.js';
import { parseSetCookie } from '../cookie.js';
import { getHeader } from '../http.js';
import { ReconnectPolicy } from './reconnect.js';
import {
  HedgeDocError,
  emptyNoteInfo,
  type AuthorProfile,
  type DriverHost,
  type DriverOptions,
  type NoteDriver,
  type NoteInfo,
  type UserInfo,
} from './types.js';

/** Socket.IO transport modes. */
export type SocketTransport = 'polling' | 'websocket';

/** The subset of a Socket.IO client socket that the driver uses. */
export interface SocketLike {
  id?: string;
  on(event: string, listener: (...args: any[]) => void): unknown;
  emit(event: string, ...args: any[]): unknown;
  disconnect(): unknown;
  removeAllListeners(): unknown;
}

/** Options passed to a socket factory. */
export type SocketFactoryOptions = Partial<ManagerOptions & SocketOptions>;

/** Creates the realtime socket. Defaults to socket.io-client's `io`. */
export type SocketFactory = (url: string, options: SocketFactoryOptions) => SocketLike;

/** Permission values HedgeDoc 1 accepts (lib/permissions.js). */
export const HEDGEDOC1_PERMISSIONS = ['freely', 'editable', 'limited', 'locked', 'protected', 'private'] as const;

export interface HedgeDoc1DriverOptions extends DriverOptions {
  /** Socket.IO transports. Default: polling with websocket upgrade, websocket-only in Bun. */
  socketTransports?: SocketTransport[];
  socketFactory?: SocketFactory;
  /**
   * Extra Socket.IO / engine.io options, e.g. TLS settings for Node
   * (`ca`, `rejectUnauthorized`, `agent`). The connection's own settings
   * (path, query, transports, headers) take precedence.
   */
  socketOptions?: SocketFactoryOptions;
}

interface DocData {
  str?: string;
  revision?: number;
  clients?: Record<string, UserInfo>;
  force?: boolean;
}

interface RefreshData {
  title?: string;
  permission?: string;
  owner?: string | null;
  ownerprofile?: AuthorProfile | null;
  lastchangeuser?: string | null;
  lastchangeuserprofile?: AuthorProfile | null;
  authors?: Record<string, AuthorProfile>;
  authorship?: Array<[string | null, number, number, number | null, number | null]>;
  createtime?: number | null;
  updatetime?: number | null;
  docmaxlength?: number | null;
}

interface InfoData {
  code?: number;
  message?: string;
}

export class HedgeDoc1Driver implements NoteDriver {
  readonly protocol = 'hedgedoc1' as const;
  connected = false;
  ready = false;
  socket: SocketLike | null = null;
  otClient: HedgeDoc1OTClient | null = null;
  noteInfo: NoteInfo = emptyNoteInfo();
  users = new Map<string, UserInfo>();
  readonly reconnectPolicy: ReconnectPolicy;

  private readonly serverUrl: string;
  private readonly isLoggedIn: boolean;
  private readonly socketTransports: SocketTransport[] | null;
  private readonly socketFactory: SocketFactory;
  private intentionalDisconnect = false;
  private everReady = false;
  /** Set after an unexpected OT failure: local OT state cannot be trusted. */
  private discardPendingOnNextDoc = false;
  /** Client id of the remote operation being applied, if known. */
  remoteOrigin: string | null = null;
  private readonly permissionWaiters = new Set<(permission: string) => void>();
  private readonly deleteWaiters = new Set<() => void>();
  private readonly usersWaiters = new Set<() => void>();

  constructor(readonly host: DriverHost, private readonly options: HedgeDoc1DriverOptions) {
    this.serverUrl = options.serverUrl.replace(/\/$/, '');
    this.isLoggedIn = !!options.cookie;
    this.socketTransports = options.socketTransports ? [...options.socketTransports] : null;
    this.socketFactory = options.socketFactory ?? ((url, opts) => io(url, opts) as unknown as SocketLike);
    this.reconnectPolicy = new ReconnectPolicy(options.reconnect, (event, data) => host.emit(event, data));
  }

  get revision(): number {
    return this.otClient?.revision ?? 0;
  }

  // ------------------------------------------------------------------
  // Permissions
  // ------------------------------------------------------------------

  /** Account id of this connection, once the server has told us. */
  private selfUserId(): string | null {
    const id = this.socket?.id;
    if (!id) return null;
    return this.users.get(id)?.userid ?? null;
  }

  /**
   * For owner-only notes edit rights are only certain once the online-user
   * list has told us our own account id; until then signed-in users get the
   * benefit of the doubt and `flush()` reports a silent server-side rejection.
   */
  permissionError(): string | null {
    const permission = this.noteInfo.permission;
    switch (permission) {
      case 'freely':
        return null;
      case 'editable':
      case 'limited':
        return this.isLoggedIn ? null
          : `This note requires login to edit (permission: ${permission}). Please provide an authenticated session cookie.`;
      case 'locked':
      case 'private':
      case 'protected': {
        const self = this.selfUserId();
        const owner = this.noteInfo.owner;
        if (this.isLoggedIn && (!self || !owner || self === owner)) return null;
        return `This note can only be edited by its owner (permission: ${permission}).`;
      }
      default:
        return `Cannot edit this note (permission: ${permission || 'unknown'}).`;
    }
  }

  // ------------------------------------------------------------------
  // Connection
  // ------------------------------------------------------------------

  private isBrowserRuntime(): boolean {
    if (this.options.runtime === 'browser') return true;
    if (this.options.runtime === 'node') return false;
    return typeof (globalThis as { window?: unknown }).window !== 'undefined';
  }

  private async sessionCookie(): Promise<string> {
    if (this.options.cookie) return this.options.cookie;

    // Any route behind HedgeDoc's session middleware (saveUninitialized) hands
    // out an anonymous session. Not the note page itself: GET /<noteId>
    // creates the note when it does not exist and free URLs are enabled.
    // (/status is excluded from the session middleware; /config is not.)
    const response = await this.options.request({
      url: `${this.serverUrl}/config`,
      method: 'GET',
      redirect: 'manual',
      credentials: 'include',
      headers: this.options.headers,
    });
    const cookies = parseSetCookie(getHeader(response.headers, 'set-cookie') ?? '');
    if (cookies.size > 0) return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');

    // Browsers do not expose Set-Cookie to JavaScript, but the cookie jar can
    // still be populated and sent by Socket.IO when withCredentials is enabled.
    if (this.isBrowserRuntime()) return '';
    throw new Error('Failed to obtain session cookie from server');
  }

  connect(): Promise<void> {
    this.intentionalDisconnect = false;
    this.reconnectPolicy.attempts = 0;
    this.reconnectPolicy.cancel();
    return this.openSocket();
  }

  disconnect(intentional: boolean): void {
    this.intentionalDisconnect = intentional;
    this.reconnectPolicy.cancel();
    this.teardownSocket();
  }

  private teardownSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.ready = false;
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
    }
  }

  private readonly reopen = (): Promise<void> => this.openSocket();
  private readonly shouldRetry = (): boolean => !this.intentionalDisconnect;

  private async openSocket(): Promise<void> {
    const cookie = await this.sessionCookie();
    const isBrowser = this.isBrowserRuntime();
    const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

    // Socket.IO treats a URL path as a namespace, so connect to the origin and
    // pass a subpath deployment's prefix through the `path` option instead.
    let socketPath = '/socket.io/';
    let socketUrl = this.serverUrl;
    try {
      const urlObj = new URL(this.serverUrl);
      if (urlObj.pathname && urlObj.pathname !== '/') {
        socketPath = urlObj.pathname.replace(/\/$/, '') + '/socket.io/';
        socketUrl = urlObj.origin;
      }
    } catch {
      // Keep defaults
    }

    const socketOptions: SocketFactoryOptions = {
      ...this.options.socketOptions,
      path: socketPath,
      query: { noteId: this.options.noteId },
      // Bun has issues with XHR polling, so use websocket-only in Bun.
      transports: this.socketTransports ?? (isBun ? ['websocket'] : ['polling', 'websocket']),
      withCredentials: true,
      reconnection: false,
    };

    if (!isBrowser) {
      // The key must be lower-case `cookie`: with withCredentials engine.io's
      // Node websocket transport sets headers.cookie to its (empty) cookie
      // jar, and ws would send that instead of a differently cased Cookie.
      const extraHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries(this.options.headers)) {
        extraHeaders[name.toLowerCase() === 'cookie' ? 'cookie' : name] = value;
      }
      if (cookie) extraHeaders.cookie = extraHeaders.cookie ? `${extraHeaders.cookie}; ${cookie}` : cookie;
      socketOptions.extraHeaders = extraHeaders;
    } else if (Object.keys(this.options.headers).length > 0) {
      console.warn('HedgeDocClient: custom socket headers are not supported in browser runtimes.');
    }

    this.teardownSocket();
    const socket = this.socketFactory(socketUrl, socketOptions);
    this.socket = socket;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let refreshFallback: ReturnType<typeof setTimeout> | null = null;
      const connectTimer = setTimeout(() => {
        fail(new HedgeDocError(`Timed out after ${this.options.connectTimeout}ms waiting for the document`, 408));
      }, this.options.connectTimeout);

      const settle = () => {
        settled = true;
        clearTimeout(connectTimer);
        if (refreshFallback) clearTimeout(refreshFallback);
      };
      const succeed = () => {
        if (settled) return;
        settle();
        resolve();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settle();
        if (this.socket === socket) this.teardownSocket();
        reject(error);
      };

      this.attachSocketHandlers(socket, {
        onDocLoaded: () => {
          // Permissions arrive with 'refresh'; give it a moment before resolving anyway.
          refreshFallback = setTimeout(succeed, 3000);
        },
        onRefresh: succeed,
        fail,
      });
    });
  }

  private attachSocketHandlers(
    socket: SocketLike,
    lifecycle: { onDocLoaded: () => void; onRefresh: () => void; fail: (error: Error) => void },
  ): void {
    const host = this.host;
    // Ignore events from sockets that have been replaced.
    const on = (event: string, handler: (...args: any[]) => void) => {
      socket.on(event, (...args: any[]) => {
        if (this.socket === socket) handler(...args);
      });
    };
    // OT messages are only meaningful after this socket delivered its document.
    let docLoaded = false;
    const onOT = (event: string, handler: (...args: any[]) => void) => {
      on(event, (...args: any[]) => {
        if (docLoaded) handler(...args);
      });
    };

    on('connect', () => {
      this.connected = true;
      this.reconnectPolicy.attempts = 0;
      host.emit('connect');
    });

    on('disconnect', (reason: string) => {
      this.connected = false;
      this.ready = false;
      host.emit('disconnect', reason);
      lifecycle.fail(new HedgeDocError(`Disconnected before the document loaded (${reason})`));
      if (!this.intentionalDisconnect && this.reconnectPolicy.config.enabled && this.everReady) {
        this.reconnectPolicy.schedule(this.reopen, this.shouldRetry);
      }
    });

    on('connect_error', (raw: Error) => {
      const error = explainConnectError(raw, this.serverUrl);
      host.emit('error', error);
      lifecycle.fail(error);
    });

    on('doc', (data: DocData) => {
      docLoaded = true;
      this.handleDoc(data);
      socket.emit('refresh');
      lifecycle.onDocLoaded();
    });

    on('info', (data: InfoData) => {
      if (data.code === 403 || data.code === 404) {
        const error = new HedgeDocError(data.code === 403 ? 'Access forbidden' : 'Note not found', data.code);
        host.emit('error', error);
        lifecycle.fail(error);
      } else {
        host.emit('info', data);
      }
    });

    on('refresh', (data: RefreshData) => {
      this.handleRefresh(data);
      lifecycle.onRefresh();
    });

    onOT('ack', (revision: number) => {
      this.otStep({ type: 'ack', revision }, () => this.otClient!.serverAck(revision));
    });

    onOT('operation', (clientId: string, revision: number, operation: OperationJSON) => {
      this.otStep({ type: 'operation', clientId, revision, operation }, () => {
        const op = TextOperation.fromJSON(operation);
        this.remoteOrigin = clientId;
        try {
          this.otClient!.applyServer(revision, op);
        } finally {
          this.remoteOrigin = null;
        }
      });
    });

    onOT('operations', (head: number, operations: OperationJSON[]) => {
      this.otStep({ type: 'operations', head }, () => this.otClient!.applyOperations(head, operations));
    });

    on('online users', (data: { users?: UserInfo[] }) => {
      this.users.clear();
      for (const user of data.users ?? []) this.users.set(user.id, user);
      host.emit('users', Array.from(this.users.values()));
      for (const waiter of [...this.usersWaiters]) waiter();
    });

    on('user status', (user: UserInfo) => {
      if (user && user.id) {
        this.users.set(user.id, user);
        host.emit('user:status', user);
      }
    });

    on('cursor focus', (user: unknown) => host.emit('cursor:focus', user));
    on('cursor activity', (user: unknown) => host.emit('cursor:activity', user));
    on('cursor blur', (data: unknown) => host.emit('cursor:blur', data));

    on('client_left', (clientId: string) => {
      this.users.delete(clientId);
      host.emit('user:left', clientId);
    });

    on('permission', (data: { permission: string }) => {
      this.noteInfo.permission = data.permission;
      host.emit('permission', data.permission);
      for (const waiter of [...this.permissionWaiters]) waiter(data.permission);
    });

    on('delete', () => {
      for (const waiter of [...this.deleteWaiters]) waiter();
      host.emit('delete');
      this.disconnect(true);
    });

    on('version', (data: unknown) => host.emit('version', data));
  }

  /**
   * Drop the socket and load a fresh document from the server. Pending local
   * edits are re-sent or rebased unless `discardPending` is set.
   */
  resync(discardPending: boolean): void {
    if (discardPending) this.discardPendingOnNextDoc = true;
    if (this.intentionalDisconnect) return;
    this.teardownSocket();
    this.openSocket().catch(error => this.reconnectPolicy.failed(error, this.reopen, this.shouldRetry));
  }

  // ------------------------------------------------------------------
  // Server messages
  // ------------------------------------------------------------------

  private handleDoc(data: DocData): void {
    const str = data.str || '';
    const revision = data.revision || 0;

    for (const [id, user] of Object.entries(data.clients ?? {})) {
      this.users.set(id, { ...user, id });
    }

    if (!this.otClient) {
      this.otClient = new HedgeDoc1OTClient(this, revision, str);
      this.ready = true;
      this.everReady = true;
      this.host.loadDocument(str);
    } else {
      // Mark ready first so a resend can go out on this socket.
      this.ready = true;
      const outcome = this.otClient.serverReconnect(revision, str, !!data.force || this.discardPendingOnNextDoc);
      this.discardPendingOnNextDoc = false;
      this.host.emit('resync', outcome);
    }

    this.host.emit('ready', { document: this.host.document, revision: this.revision });
  }

  private handleRefresh(data: RefreshData): void {
    this.noteInfo = {
      title: data.title || '',
      permission: data.permission || '',
      owner: data.owner || null,
      ownerprofile: data.ownerprofile || null,
      lastchangeuser: data.lastchangeuser || null,
      lastchangeuserprofile: data.lastchangeuserprofile || null,
      authors: data.authors || {},
      authorship: data.authorship || [],
      createtime: data.createtime || null,
      updatetime: data.updatetime || null,
      docmaxlength: data.docmaxlength || null,
    };
    this.host.emit('refresh', this.noteInfo);
  }

  /** Run an OT step; on failure report it and reload from the server. */
  private otStep(details: Record<string, unknown>, step: () => void): void {
    if (!this.otClient) return;
    try {
      step();
    } catch (error) {
      this.host.emit('ot-error', { ...details, error });
      // A desync error is raised before any state changes, so pending edits
      // are still valid and can be re-sent. Anything else means the local OT
      // state is suspect.
      this.resync(!(error instanceof OTDesyncError));
    }
  }

  // ------------------------------------------------------------------
  // Local edits and requests
  // ------------------------------------------------------------------

  submit(operation: TextOperation): void {
    if (!this.otClient) throw new Error('Client not ready. Wait for connection to complete.');
    this.otClient.applyClient(operation);
  }

  isSynchronized(): boolean {
    return this.otClient ? this.otClient.isSynchronized() : true;
  }

  syncState(): string {
    return this.otClient?.stateName ?? 'none';
  }

  private emitIfConnected(event: string): void {
    if (this.socket && this.connected) this.socket.emit(event);
  }

  refresh(): void {
    this.emitIfConnected('refresh');
  }

  requestOnlineUsers(): void {
    this.emitIfConnected('online users');
  }

  requestVersion(): void {
    this.emitIfConnected('version');
  }

  // ------------------------------------------------------------------
  // Owner actions. HedgeDoc ignores them silently unless the session's
  // account owns the note, so check what we can first and then wait for
  // the server's broadcast as confirmation.
  // ------------------------------------------------------------------

  /**
   * Our account id comes from the online-user list, which may not have
   * arrived yet right after connect(); ask for it and wait briefly.
   */
  private async knownSelfUserId(timeoutMs = 2000): Promise<string | null> {
    const self = this.selfUserId();
    if (self || !this.socket) return self;
    await this.awaitConfirmation(this.usersWaiters, () => this.selfUserId() !== null,
      () => this.socket?.emit('online users'), timeoutMs, '').catch(() => undefined);
    return this.selfUserId();
  }

  private async assertOwner(action: string): Promise<SocketLike> {
    if (!this.socket || !this.ready) throw new HedgeDocError('Client not ready. Wait for connection to complete.');
    if (!this.isLoggedIn) throw new HedgeDocError(`Only the note's owner can ${action}; log in first`, 401);
    const owner = this.noteInfo.owner;
    if (!owner) throw new HedgeDocError(`This note has no owner (it was created anonymously), so nobody can ${action}`, 403);
    const self = await this.knownSelfUserId();
    if (self && self !== owner) throw new HedgeDocError(`Only the note's owner can ${action}`, 403);
    if (!this.socket) throw new HedgeDocError('Disconnected');
    return this.socket;
  }

  async setPermission(permission: string, timeoutMs: number): Promise<void> {
    if (!(HEDGEDOC1_PERMISSIONS as readonly string[]).includes(permission)) {
      throw new HedgeDocError(`Invalid permission '${permission}' (one of: ${HEDGEDOC1_PERMISSIONS.join(', ')})`, 400);
    }
    const socket = await this.assertOwner('change its permission');
    if (this.noteInfo.permission === permission) return;
    await this.awaitConfirmation(this.permissionWaiters, (p: string) => p === permission, () => socket.emit('permission', permission),
      timeoutMs, `The server did not confirm the permission change within ${timeoutMs}ms. ` +
      (permission === 'freely' ? 'This server may not allow anonymous editing. ' : '') +
      'Only the owner can change permissions.');
  }

  async deleteNote(timeoutMs: number): Promise<void> {
    const socket = await this.assertOwner('delete it');
    await this.awaitConfirmation(this.deleteWaiters, () => true, () => socket.emit('delete'),
      timeoutMs, `The server did not confirm the deletion within ${timeoutMs}ms. Only the owner can delete a note.`);
  }

  private awaitConfirmation<T extends unknown[]>(
    waiters: Set<(...args: T) => void>,
    matches: (...args: T) => boolean,
    send: () => void,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter = (...args: T) => {
        if (!matches(...args)) return;
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new HedgeDocError(timeoutMessage, 408));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        waiters.delete(waiter);
      };
      waiters.add(waiter);
      send();
    });
  }
}

/** Binds the OT state machine to the driver's socket and the host's document. */
class HedgeDoc1OTClient extends OTClient {
  constructor(private readonly driver: HedgeDoc1Driver, revision: number, document: string) {
    super(revision, document);
  }

  sendOperation(revision: number, operation: TextOperation): void {
    // While disconnected the op stays outstanding and is re-sent on reconnect.
    if (this.driver.socket && this.driver.ready) {
      this.driver.socket.emit('operation', revision, operation.toJSON(), null);
    }
  }

  applyOperation(operation: TextOperation): void {
    const clientId = this.driver.remoteOrigin ?? undefined;
    const user = clientId ? this.driver.users.get(clientId) : undefined;
    this.driver.host.applyRemoteChange(operation, { clientId, user });
  }

  resetDocument(document: string): void {
    this.driver.host.replaceDocument(document);
  }

  getOperations(base: number, head: number): void {
    // The server ignores requests with base 0 (`if (!base) return`), so
    // recover through a fresh document instead.
    if (base === 0) {
      queueMicrotask(() => this.driver.resync(false));
      return;
    }
    if (this.driver.socket && this.driver.ready) {
      this.driver.socket.emit('get_operations', base, head);
    }
  }

  onSynchronized(): void {
    this.driver.host.emit('synchronized');
  }
}

export function createHedgeDoc1Driver(host: DriverHost, options: HedgeDoc1DriverOptions): HedgeDoc1Driver {
  return new HedgeDoc1Driver(host, options);
}

/**
 * Turn socket.io-client's connect errors into actionable messages. The raw
 * error stays available as `cause`.
 */
export function explainConnectError(error: Error, serverUrl: string): Error {
  const message = error?.message ?? String(error);
  let explained: string | null = null;
  if (/Socket\.IO server in v2\.x/i.test(message)) {
    explained = `${serverUrl} runs HedgeDoc 1.10.3 or older (Socket.IO 2), which hedgesync cannot talk to. HedgeDoc 1.10.4 or newer is required.`;
  } else if (/AUTH failed/i.test(message)) {
    explained = `The server did not accept the session (${message}). Log in again or check the session cookie.`;
  } else if (/certificate|self[- ]signed|UNABLE_TO_VERIFY|CERT_/i.test(message + ' ' + describeCause(error))) {
    explained = `TLS certificate of ${serverUrl} is not trusted (${describeCause(error) || message}).`;
  }
  if (!explained) return error;
  const wrapped = new HedgeDocError(explained);
  (wrapped as Error & { cause?: unknown }).cause = error;
  return wrapped;
}

function describeCause(error: unknown): string {
  // engine.io wraps transport errors: TransportError.description is the underlying error/event.
  const description = (error as { description?: unknown })?.description;
  const inner = (description as { error?: unknown })?.error ?? description;
  if (inner instanceof Error) return `${(inner as Error & { code?: string }).code ?? ''} ${inner.message}`.trim();
  return '';
}
