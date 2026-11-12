import { io } from 'socket.io-client';
import type { ManagerOptions, SocketOptions } from 'socket.io-client';
import { TextOperation, OperationJSON } from './text-operation.js';
import { OTClient, OTDesyncError, ReconnectOutcome } from './ot-client.js';
import { diffToOperation } from './diff.js';
import { expandReplacement } from './replace.js';
import { normalizeCookie } from './cookie.js';
import { SimpleEventEmitter } from './simple-event-emitter.js';
import {
  HedgeSyncRuntime,
  HedgeSyncRequestFn,
  defaultHedgeSyncRequest,
  getHeader,
} from './http.js';

// ===========================================
// Types
// ===========================================

/** Reconnection configuration */
export interface ReconnectConfig {
  enabled?: boolean;
  maxAttempts?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffFactor?: number;
}

/** Socket.IO transport modes. */
export type SocketTransport = 'polling' | 'websocket';

/** The subset of a Socket.IO client socket that HedgeDocClient uses. */
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

/** Client options */
export interface HedgeDocClientOptions {
  serverUrl: string;
  noteId: string;
  cookie?: string | null;
  /** Force runtime mode instead of auto-detection (default: "auto"). */
  runtime?: HedgeSyncRuntime;
  /** Custom HTTP transport for bootstrap requests. Falls back to fetch. */
  request?: HedgeSyncRequestFn;
  /** Custom headers to include in all requests (for reverse proxy authentication, etc.) */
  headers?: Record<string, string>;
  /** Socket.IO transports to use. Defaults to polling with websocket upgrade, or websocket-only in Bun. */
  socketTransports?: SocketTransport[];
  /** Custom socket factory (mainly for tests). */
  socketFactory?: SocketFactory;
  /** How long connect() waits for the document (ms, default 15000). */
  connectTimeout?: number;
  /** Default timeout for flush() (ms, default 10000). */
  operationTimeout?: number;
  reconnect?: ReconnectConfig;
  undoMaxSize?: number;
  trackUndo?: boolean;
  /** Local edits closer together than this are undone as one step (ms, default 500). */
  undoGroupInterval?: number;
}

/** Author profile */
export interface AuthorProfile {
  name?: string;
  color?: string;
  photo?: string | null;
}

/** Note metadata */
export interface NoteInfo {
  title: string;
  permission: string;
  owner: string | null;
  ownerprofile?: AuthorProfile | null;
  lastchangeuser?: string | null;
  lastchangeuserprofile?: AuthorProfile | null;
  authors: Record<string, AuthorProfile>;
  authorship?: Array<[string | null, number, number, number | null, number | null]>;
  createtime: number | null;
  updatetime: number | null;
  docmaxlength?: number | null;
}

/** User info */
export interface UserInfo {
  /** Socket id of the connection. */
  id: string;
  /** Account id for signed-in users. */
  userid?: string | null;
  login?: boolean;
  name?: string;
  color?: string;
  photo?: string;
  cursor?: unknown;
}

/** Authorship span */
export interface AuthorshipSpan {
  userId: string | null;
  start: number;
  end: number;
  text: string;
  author: AuthorProfile | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/** Document with authorship info */
export interface DocumentWithAuthorship {
  content: string;
  authors: Record<string, AuthorProfile>;
  authorship: AuthorshipSpan[];
  getTextByAuthor: (authorId: string) => string;
  getAuthorAtPosition: (position: number) => AuthorProfile | null;
}

/** Author entry */
export interface AuthorEntry {
  userId: string;
  name: string;
  color: string;
  photo: string | null;
}

/** Change event */
export interface ChangeEvent {
  type: 'local' | 'remote';
  operation: TextOperation;
  /** Client ID of the user who made the change (only for remote changes, when known) */
  clientId?: string;
  /** User info of who made the change (only for remote changes, if available) */
  user?: UserInfo;
}

/** Emitted as 'resync' whenever a fresh document from the server replaced or rebased local state. */
export type ResyncEvent = ReconnectOutcome;

/** Doc event data */
interface DocData {
  str?: string;
  revision?: number;
  clients?: Record<string, UserInfo>;
  force?: boolean;
}

/** Refresh event data */
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

/** Info event data */
interface InfoData {
  code?: number;
  message?: string;
}

type ReplacementFn = (match: string, ...args: any[]) => string;

// ===========================================
// Error Types
// ===========================================

export class HedgeDocError extends Error {
  code?: number;

  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
    this.name = 'HedgeDocError';
  }
}

function splitSetCookieHeader(headerValue: string): string[] {
  if (!headerValue) {
    return [];
  }

  if (headerValue.includes('\n')) {
    return headerValue
      .split('\n')
      .map(cookie => cookie.trim())
      .filter(Boolean);
  }

  // Split combined Set-Cookie headers while preserving Expires dates.
  return headerValue
    .split(/,(?=\s*[^;,\s]+=[^;]+)/g)
    .map(cookie => cookie.trim())
    .filter(Boolean);
}

/** Clone a regex with the global flag, so callers' lastIndex is never touched. */
function toGlobalRegex(pattern: RegExp | string): RegExp {
  if (typeof pattern === 'string') return new RegExp(pattern, 'g');
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
}

// ===========================================
// HedgeDocClient Class
// ===========================================

/**
 * HedgeDocClient - Connect to a HedgeDoc 1.x server and edit a note in real time.
 *
 * Edits are applied locally right away and sent through an OT client that
 * keeps at most one operation in flight (later edits are composed into a
 * buffer). Use `flush()` to wait until the server has acknowledged every
 * local edit.
 *
 * Events:
 * - `ready` ({document, revision}) after each (re)load of the document
 * - `document` (text) whenever the local document changes
 * - `change` (ChangeEvent) for every local or remote edit
 * - `synchronized` when all local edits have been acknowledged
 * - `resync` (ResyncEvent) when a reconnect replaced or rebased local state
 * - `ot-error` when server messages could not be applied (a resync follows)
 * - `refresh`, `permission`, `users`, `user:status`, `user:left`, `cursor:*`,
 *   `connect`, `disconnect`, `error`, `info`, `delete`, `version`,
 *   `reconnect:scheduled|attempting|success|error|failed`, `undo`, `redo`
 */
export class HedgeDocClient extends SimpleEventEmitter {
  serverUrl: string;
  noteId: string;
  cookie: string | null;
  customHeaders: Record<string, string>;
  socket: SocketLike | null;
  document: string;
  connected: boolean;
  ready: boolean;
  otClient: OTClientImpl | null;
  noteInfo: NoteInfo;
  users: Map<string, UserInfo>;

  private _sessionCookie: string | null;
  private _isLoggedIn: boolean;
  private _runtime: HedgeSyncRuntime;
  private _request: HedgeSyncRequestFn;
  private _socketTransports: SocketTransport[] | null;
  private _socketFactory: SocketFactory;
  private _connectTimeoutMs: number;
  private _operationTimeoutMs: number;

  /** Client id of the remote operation currently being applied, if known. */
  _remoteOrigin: string | null;

  // Reconnection
  private _reconnect: Required<ReconnectConfig>;
  private _reconnectAttempts: number;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null;
  private _intentionalDisconnect: boolean;
  private _everReady: boolean;
  /** Set after an unexpected OT failure: local OT state cannot be trusted. */
  private _discardPendingOnNextDoc: boolean;

  // Batch
  private _batch: { op: TextOperation } | null;

  // Undo/Redo (stacks of inverse operations, transformed against remote edits)
  private _undoStack: TextOperation[];
  private _redoStack: TextOperation[];
  private _undoMaxSize: number;
  private _trackUndo: boolean;
  private _undoGroupInterval: number;
  private _lastUndoTimestamp: number;
  private _undoMayCompose: boolean;
  private _applyingUndo: boolean;

  constructor(options: HedgeDocClientOptions) {
    super();

    if (!options.serverUrl) {
      throw new Error('serverUrl is required');
    }
    if (!options.noteId) {
      throw new Error('noteId is required');
    }

    this.serverUrl = options.serverUrl.replace(/\/$/, '');
    this.noteId = options.noteId;
    this.cookie = options.cookie ? normalizeCookie(options.cookie) : null;
    this._runtime = options.runtime ?? 'auto';
    this._request = options.request || defaultHedgeSyncRequest;
    this._socketTransports = options.socketTransports ? [...options.socketTransports] : null;
    this._socketFactory = options.socketFactory ?? ((url, opts) => io(url, opts) as unknown as SocketLike);
    this._connectTimeoutMs = options.connectTimeout ?? 15000;
    this._operationTimeoutMs = options.operationTimeout ?? 10000;
    this.customHeaders = options.headers || {};

    if (!['auto', 'node', 'browser'].includes(this._runtime)) {
      throw new Error(`Invalid runtime mode: ${String(this._runtime)}`);
    }

    this.socket = null;
    this.document = '';
    this.connected = false;
    this.ready = false;
    this.otClient = null;

    this.noteInfo = {
      title: '',
      permission: '',
      owner: null,
      authors: {},
      createtime: null,
      updatetime: null
    };

    this.users = new Map();
    this._sessionCookie = null;
    this._isLoggedIn = !!this.cookie;
    this._remoteOrigin = null;

    this._reconnect = {
      enabled: options.reconnect?.enabled ?? true,
      maxAttempts: options.reconnect?.maxAttempts ?? 10,
      initialDelay: options.reconnect?.initialDelay ?? 1000,
      maxDelay: options.reconnect?.maxDelay ?? 30000,
      backoffFactor: options.reconnect?.backoffFactor ?? 2
    };
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._intentionalDisconnect = false;
    this._everReady = false;
    this._discardPendingOnNextDoc = false;

    this._batch = null;

    this._undoStack = [];
    this._redoStack = [];
    this._undoMaxSize = options.undoMaxSize ?? 100;
    this._trackUndo = options.trackUndo ?? true;
    this._undoGroupInterval = options.undoGroupInterval ?? 500;
    this._lastUndoTimestamp = 0;
    this._undoMayCompose = false;
    this._applyingUndo = false;
  }

  /** Current server revision known to this client. */
  get revision(): number {
    return this.otClient?.revision ?? 0;
  }

  // ============================================
  // Permissions
  // ============================================

  /** Account id of this connection, once the server has told us. */
  private _selfUserId(): string | null {
    const id = this.socket?.id;
    if (!id) return null;
    return this.users.get(id)?.userid ?? null;
  }

  /**
   * Whether this session may edit the note, as far as the client can tell.
   * For owner-only notes this is only certain once the online-user list has
   * told us our own account id; until then signed-in users get the benefit
   * of the doubt and `flush()` reports a silent server-side rejection.
   */
  canEdit(): boolean {
    switch (this.noteInfo.permission) {
      case 'freely':
        return true;
      case 'editable':
      case 'limited':
        return this._isLoggedIn;
      case 'locked':
      case 'private':
      case 'protected': {
        if (!this._isLoggedIn) return false;
        const self = this._selfUserId();
        return !self || !this.noteInfo.owner || self === this.noteInfo.owner;
      }
      default:
        return false;
    }
  }

  private _getPermissionError(): string | null {
    if (this.canEdit()) {
      return null;
    }
    const permission = this.noteInfo.permission;
    switch (permission) {
      case 'editable':
      case 'limited':
        return `This note requires login to edit (permission: ${permission}). Please provide an authenticated session cookie.`;
      case 'locked':
      case 'private':
      case 'protected':
        return `This note can only be edited by its owner (permission: ${permission}).`;
      default:
        return `Cannot edit this note (permission: ${permission || 'unknown'}).`;
    }
  }

  private _assertEditable(): void {
    if (!this.ready || !this.otClient) {
      throw new Error('Client not ready. Wait for connection to complete.');
    }
    const permError = this._getPermissionError();
    if (permError) {
      throw new Error(permError);
    }
  }

  // ============================================
  // Connection
  // ============================================

  private _isBrowserRuntime(): boolean {
    if (this._runtime === 'browser') {
      return true;
    }
    if (this._runtime === 'node') {
      return false;
    }
    return typeof (globalThis as { window?: unknown }).window !== 'undefined';
  }

  private async _getSessionCookie(): Promise<string> {
    if (this.cookie) {
      this._sessionCookie = this.cookie;
      this._isLoggedIn = true;
      return this.cookie;
    }

    const response = await this._request({
      url: `${this.serverUrl}/${this.noteId}`,
      method: 'GET',
      redirect: 'manual',
      credentials: 'include',
      headers: {
        'Accept': 'text/html',
        ...this.customHeaders,
      },
    });

    const setCookie = getHeader(response.headers, 'set-cookie');
    const cookies = setCookie ? splitSetCookieHeader(setCookie) : [];
    const sessionCookies = cookies.map(cookie => cookie.split(';')[0]).filter(Boolean);

    if (sessionCookies.length > 0) {
      this._sessionCookie = sessionCookies.join('; ');
      return this._sessionCookie;
    }

    // Browsers do not expose Set-Cookie to JavaScript, but the cookie jar can
    // still be populated and sent by Socket.IO when withCredentials is enabled.
    if (this._isBrowserRuntime()) {
      this._sessionCookie = '';
      return '';
    }

    throw new Error('Failed to obtain session cookie from server');
  }

  /**
   * Connect to the server. Resolves once the document and note metadata
   * (including permissions) have loaded.
   */
  connect(): Promise<void> {
    this._intentionalDisconnect = false;
    this._reconnectAttempts = 0;
    this._cancelReconnect();
    return this._openSocket();
  }

  private _teardownSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.ready = false;
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
    }
  }

  private async _openSocket(): Promise<void> {
    const cookie = await this._getSessionCookie();
    const isBrowser = this._isBrowserRuntime();
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
      path: socketPath,
      query: { noteId: this.noteId },
      // Bun has issues with XHR polling, so use websocket-only in Bun.
      transports: this._socketTransports ?? (isBun ? ['websocket'] : ['polling', 'websocket']),
      withCredentials: true,
      reconnection: false,
    };

    if (!isBrowser) {
      const extraHeaders: Record<string, string> = { ...this.customHeaders };
      if (cookie) {
        extraHeaders.Cookie = cookie;
      }
      socketOptions.extraHeaders = extraHeaders;
    } else if (Object.keys(this.customHeaders).length > 0) {
      console.warn('HedgeDocClient: custom socket headers are not supported in browser runtimes.');
    }

    this._teardownSocket();
    const socket = this._socketFactory(socketUrl, socketOptions);
    this.socket = socket;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let refreshFallback: ReturnType<typeof setTimeout> | null = null;
      const connectTimer = setTimeout(() => {
        fail(new HedgeDocError(`Timed out after ${this._connectTimeoutMs}ms waiting for the document`, 408));
      }, this._connectTimeoutMs);

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
        if (this.socket === socket) this._teardownSocket();
        reject(error);
      };

      this._attachSocketHandlers(socket, {
        onDocLoaded: () => {
          // Permissions arrive with 'refresh'; give it a moment before resolving anyway.
          refreshFallback = setTimeout(succeed, 3000);
        },
        onRefresh: succeed,
        fail,
      });
    });
  }

  private _attachSocketHandlers(
    socket: SocketLike,
    lifecycle: { onDocLoaded: () => void; onRefresh: () => void; fail: (error: Error) => void },
  ): void {
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
      this._reconnectAttempts = 0;
      this.emit('connect');
    });

    on('disconnect', (reason: string) => {
      this.connected = false;
      this.ready = false;
      this.emit('disconnect', reason);
      lifecycle.fail(new HedgeDocError(`Disconnected before the document loaded (${reason})`));
      if (!this._intentionalDisconnect && this._reconnect.enabled && this._everReady) {
        this._scheduleReconnect();
      }
    });

    on('connect_error', (error: Error) => {
      this.emit('error', error);
      lifecycle.fail(error);
    });

    on('doc', (data: DocData) => {
      docLoaded = true;
      this._handleDoc(data);
      socket.emit('refresh');
      lifecycle.onDocLoaded();
    });

    on('info', (data: InfoData) => {
      if (data.code === 403 || data.code === 404) {
        const error = new HedgeDocError(data.code === 403 ? 'Access forbidden' : 'Note not found', data.code);
        this.emit('error', error);
        lifecycle.fail(error);
      } else {
        this.emit('info', data);
      }
    });

    on('refresh', (data: RefreshData) => {
      this._handleRefresh(data);
      lifecycle.onRefresh();
    });

    onOT('ack', (revision: number) => this._handleAck(revision));

    onOT('operation', (clientId: string, revision: number, operation: OperationJSON) => {
      this._handleOperation(clientId, revision, operation);
    });

    onOT('operations', (head: number, operations: OperationJSON[]) => {
      this._handleOperations(head, operations);
    });

    on('online users', (data: { users?: UserInfo[] }) => this._handleOnlineUsers(data));

    on('user status', (user: UserInfo) => {
      if (user && user.id) {
        this.users.set(user.id, user);
        this.emit('user:status', user);
      }
    });

    on('cursor focus', (user: unknown) => this.emit('cursor:focus', user));
    on('cursor activity', (user: unknown) => this.emit('cursor:activity', user));
    on('cursor blur', (data: unknown) => this.emit('cursor:blur', data));

    on('client_left', (clientId: string) => {
      this.users.delete(clientId);
      this.emit('user:left', clientId);
    });

    on('permission', (data: { permission: string }) => {
      this.noteInfo.permission = data.permission;
      this.emit('permission', data.permission);
    });

    on('delete', () => {
      this.emit('delete');
      this.disconnect();
    });

    on('version', (data: unknown) => this.emit('version', data));
  }

  private _scheduleReconnect(): void {
    if (this._reconnectTimer) {
      return;
    }

    if (this._reconnectAttempts >= this._reconnect.maxAttempts) {
      this.emit('reconnect:failed', {
        attempts: this._reconnectAttempts,
        maxAttempts: this._reconnect.maxAttempts
      });
      return;
    }

    const delay = Math.min(
      this._reconnect.initialDelay * Math.pow(this._reconnect.backoffFactor, this._reconnectAttempts),
      this._reconnect.maxDelay
    );

    this._reconnectAttempts++;

    this.emit('reconnect:scheduled', {
      attempt: this._reconnectAttempts,
      maxAttempts: this._reconnect.maxAttempts,
      delay
    });

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.emit('reconnect:attempting', {
        attempt: this._reconnectAttempts,
        maxAttempts: this._reconnect.maxAttempts
      });
      this._openSocket().then(
        () => this.emit('reconnect:success', { attempts: this._reconnectAttempts }),
        (error) => {
          this.emit('reconnect:error', { error, attempt: this._reconnectAttempts });
          if (this._reconnect.enabled && !this._intentionalDisconnect) {
            this._scheduleReconnect();
          }
        },
      );
    }, delay);
  }

  private _cancelReconnect(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  /**
   * Drop the socket and load a fresh document from the server. Pending local
   * edits are re-sent or rebased unless `discardPending` is set.
   */
  _resync(discardPending: boolean): void {
    if (discardPending) this._discardPendingOnNextDoc = true;
    if (this._intentionalDisconnect) return;
    this._teardownSocket();
    this._openSocket().catch((error) => {
      this.emit('reconnect:error', { error, attempt: this._reconnectAttempts });
      if (this._reconnect.enabled && !this._intentionalDisconnect) {
        this._scheduleReconnect();
      }
    });
  }

  /** Disconnect from the server. Unacknowledged edits are lost; call flush() first. */
  disconnect(intentional: boolean = true): void {
    this._intentionalDisconnect = intentional;
    this._cancelReconnect();
    this._teardownSocket();
  }

  /** Manually reconnect. Pending local edits are kept and re-sent. */
  async reconnect(): Promise<void> {
    return this.connect();
  }

  /**
   * Wait until the server has acknowledged every local edit.
   *
   * HedgeDoc silently ignores edits from sessions without write access, so a
   * timeout here usually means the edit was rejected.
   */
  flush(timeoutMs: number = this._operationTimeoutMs): Promise<void> {
    if (!this.otClient || this.otClient.isSynchronized()) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onSynchronized = () => {
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new HedgeDocError(
          `Edits were not acknowledged within ${timeoutMs}ms (state: ${this.otClient?.stateName ?? 'none'}). ` +
          'The server may have rejected them; check that this session is allowed to edit the note.',
          408,
        ));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off('synchronized', onSynchronized);
      };
      this.on('synchronized', onSynchronized);
    });
  }

  // ============================================
  // Accessors
  // ============================================

  getDocument(): string {
    return this.document;
  }

  getRevision(): number {
    return this.revision;
  }

  getNoteInfo(): NoteInfo {
    return { ...this.noteInfo };
  }

  getOnlineUsers(): UserInfo[] {
    return Array.from(this.users.values());
  }

  /** True when the server has acknowledged every local edit. */
  isSynchronized(): boolean {
    return this.otClient ? this.otClient.isSynchronized() : true;
  }

  getDocumentWithAuthorship(): DocumentWithAuthorship {
    const content = this.document;
    const authors = this.noteInfo.authors || {};
    const rawAuthorship = this.noteInfo.authorship || [];

    const authorship: AuthorshipSpan[] = rawAuthorship.map(([userId, start, end, createdAt, updatedAt]) => ({
      userId: userId || null,
      start,
      end,
      text: content.substring(start, end),
      author: userId ? (authors[userId] || null) : null,
      createdAt: createdAt ? new Date(createdAt) : null,
      updatedAt: updatedAt ? new Date(updatedAt) : null
    }));

    return {
      content,
      authors,
      authorship,
      getTextByAuthor: (authorId: string) => {
        return authorship
          .filter(span => span.userId === authorId)
          .map(span => span.text)
          .join('');
      },
      getAuthorAtPosition: (position: number) => {
        for (const span of authorship) {
          if (position >= span.start && position < span.end) {
            return span.author;
          }
        }
        return null;
      }
    };
  }

  getAuthors(): AuthorEntry[] {
    const authors = this.noteInfo.authors || {};
    return Object.entries(authors).map(([userId, profile]) => ({
      userId,
      name: profile.name || 'Anonymous',
      color: profile.color || '#888888',
      photo: profile.photo || null
    }));
  }

  // ============================================
  // Editing
  // ============================================

  /** Insert text at a position */
  insert(position: number, text: string): void {
    this._assertEditable();
    if (position < 0 || position > this.document.length) {
      throw new Error('Position out of bounds');
    }
    this._submit(
      new TextOperation().retain(position).insert(text).retain(this.document.length - position),
    );
  }

  /** Delete text at a position */
  delete(position: number, length: number): void {
    this._assertEditable();
    if (position < 0 || position + length > this.document.length) {
      throw new Error('Position out of bounds');
    }
    if (length <= 0) return;
    this._submit(
      new TextOperation().retain(position).delete(length).retain(this.document.length - position - length),
    );
  }

  /** Replace text in a range */
  replace(position: number, length: number, text: string): void {
    this._assertEditable();
    if (position < 0 || length < 0 || position + length > this.document.length) {
      throw new Error('Position out of bounds');
    }
    this._submit(
      new TextOperation()
        .retain(position)
        .delete(length)
        .insert(text)
        .retain(this.document.length - position - length),
    );
  }

  /** Replace the entire document (one delete + insert; see updateContent for a minimal diff). */
  setContent(content: string): void {
    this._assertEditable();
    this._submit(new TextOperation().delete(this.document.length).insert(content));
  }

  /** Apply a raw TextOperation (must be based on the current document). */
  applyOperation(operation: TextOperation): void {
    this._assertEditable();
    if (operation.baseLength !== this.document.length) {
      throw new Error(`Operation base length ${operation.baseLength} does not match document length ${this.document.length}`);
    }
    this._submit(operation);
  }

  /**
   * Replace all matches of a pattern. Semantics match String.prototype.replace
   * (string templates support `$&`, `$1`, `$<name>`, ...). All replacements are
   * sent as a single operation. Returns the number of matches.
   */
  replaceRegex(pattern: RegExp | string, replacement: string | ReplacementFn): number {
    return this._replaceMatches(toGlobalRegex(pattern), replacement);
  }

  /** Replace the first match of a pattern. Returns whether a match was found. */
  replaceFirst(pattern: RegExp | string, replacement: string | ReplacementFn): boolean {
    const source = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
    const regex = new RegExp(source.source, source.flags.replace('g', ''));
    return this._replaceMatches(regex, replacement) > 0;
  }

  private _replaceMatches(regex: RegExp, replacement: string | ReplacementFn): number {
    this._assertEditable();
    const doc = this.document;
    const op = new TextOperation();
    let cursor = 0;
    let count = 0;

    doc.replace(regex, (...args: any[]) => {
      const hasNamed = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null;
      const offsetIndex = hasNamed ? args.length - 3 : args.length - 2;
      const match: string = args[0];
      const groups: (string | undefined)[] = args.slice(1, offsetIndex);
      const offset: number = args[offsetIndex];
      const named = hasNamed ? args[args.length - 1] : undefined;

      const text = typeof replacement === 'function'
        ? String(replacement(match, ...groups, offset, doc))
        : expandReplacement(replacement, match, groups, offset, doc, named);

      op.retain(offset - cursor).delete(match.length).insert(text);
      cursor = offset + match.length;
      count++;
      return match;
    });

    if (count > 0) {
      op.retain(doc.length - cursor);
      this._submit(op);
    }
    return count;
  }

  // ============================================
  // Line-based Operations
  // ============================================

  getLines(): string[] {
    return this.document.split('\n');
  }

  getLine(lineNum: number): string | null {
    const lines = this.getLines();
    if (lineNum < 0 || lineNum >= lines.length) {
      return null;
    }
    return lines[lineNum];
  }

  getLineCount(): number {
    return this.getLines().length;
  }

  /** Character position where a line starts, or -1 if out of range. */
  getLineStart(lineNum: number): number {
    if (lineNum < 0) return -1;
    let pos = 0;
    for (let i = 0; i < lineNum; i++) {
      const next = this.document.indexOf('\n', pos);
      if (next === -1) return -1;
      pos = next + 1;
    }
    return pos;
  }

  /** Character position where a line ends (before the newline), or -1. */
  getLineEnd(lineNum: number): number {
    const start = this.getLineStart(lineNum);
    if (start === -1) return -1;
    const end = this.document.indexOf('\n', start);
    return end === -1 ? this.document.length : end;
  }

  setLine(lineNum: number, content: string): void {
    const start = this.getLineStart(lineNum);
    if (start === -1) {
      throw new Error(`Line ${lineNum} out of bounds`);
    }
    this.replace(start, this.getLineEnd(lineNum) - start, content);
  }

  insertLine(lineNum: number, content: string): void {
    this._assertEditable();
    const lineCount = this.getLineCount();
    if (lineNum <= 0) {
      this.insert(0, content + '\n');
    } else if (lineNum >= lineCount) {
      this.insert(this.document.length, '\n' + content);
    } else {
      this.insert(this.getLineStart(lineNum), content + '\n');
    }
  }

  deleteLine(lineNum: number): void {
    this._assertEditable();
    const lineCount = this.getLineCount();
    if (lineNum < 0 || lineNum >= lineCount) {
      throw new Error(`Line ${lineNum} out of bounds`);
    }
    const start = this.getLineStart(lineNum);
    const end = this.getLineEnd(lineNum);

    if (lineCount === 1) {
      this.delete(0, end);
    } else if (lineNum === lineCount - 1) {
      this.delete(start - 1, end - start + 1);
    } else {
      this.delete(start, end - start + 1);
    }
  }

  /** Replace lines matching a pattern; sent as a single operation. Returns the count. */
  replaceLines(
    pattern: RegExp | string,
    replacement: string | ((line: string, lineNum: number, match: RegExpMatchArray) => string)
  ): number {
    this._assertEditable();
    const source = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
    const regex = new RegExp(source.source, source.flags.replace('g', ''));
    const lines = this.getLines();
    let count = 0;

    this.batch(() => {
      for (let i = lines.length - 1; i >= 0; i--) {
        const match = lines[i].match(regex);
        if (match) {
          const newContent = typeof replacement === 'function'
            ? replacement(lines[i], i, match)
            : lines[i].replace(regex, replacement);
          this.setLine(i, newContent);
          count++;
        }
      }
    });

    return count;
  }

  /**
   * Change the document to `newContent` using a minimal diff, so concurrent
   * edits by others in unchanged regions survive. Returns 1 if anything changed.
   */
  updateContent(newContent: string): number {
    this._assertEditable();
    if (this.document === newContent) {
      return 0;
    }
    this._submit(diffToOperation(this.document, newContent));
    return 1;
  }

  // ============================================
  // Batching
  // ============================================

  /**
   * Run synchronous edits and send them as one operation. Inside the callback
   * the document reflects each edit as it is made. If the callback throws,
   * all of its edits are rolled back.
   */
  batch(fn: () => void): TextOperation | null {
    if (this._batch) {
      fn();
      return null;
    }
    this._assertEditable();
    const before = this.document;
    this._batch = { op: new TextOperation().retain(before.length) };
    let op: TextOperation;
    try {
      const result: unknown = fn();
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        throw new Error('batch() callbacks must be synchronous');
      }
      op = this._batch.op;
    } catch (error) {
      this.document = before;
      throw error;
    } finally {
      this._batch = null;
    }
    this.document = before;
    if (op.isNoop()) {
      return null;
    }
    this._submit(op);
    return op;
  }

  /** True while inside a batch() callback. */
  isBatchMode(): boolean {
    return this._batch !== null;
  }

  // ============================================
  // Metadata requests
  // ============================================

  refresh(): void {
    if (this.socket && this.connected) {
      this.socket.emit('refresh');
    }
  }

  requestOnlineUsers(): void {
    if (this.socket && this.connected) {
      this.socket.emit('online users');
    }
  }

  requestVersion(): void {
    if (this.socket && this.connected) {
      this.socket.emit('version');
    }
  }

  // ============================================
  // Reconnection Control
  // ============================================

  setReconnectEnabled(enabled: boolean): void {
    this._reconnect.enabled = enabled;
    if (!enabled) {
      this._cancelReconnect();
    }
  }

  isReconnectEnabled(): boolean {
    return this._reconnect.enabled;
  }

  configureReconnect(options: Partial<ReconnectConfig>): void {
    if (options.maxAttempts !== undefined) {
      this._reconnect.maxAttempts = options.maxAttempts;
    }
    if (options.initialDelay !== undefined) {
      this._reconnect.initialDelay = options.initialDelay;
    }
    if (options.maxDelay !== undefined) {
      this._reconnect.maxDelay = options.maxDelay;
    }
    if (options.backoffFactor !== undefined) {
      this._reconnect.backoffFactor = options.backoffFactor;
    }
  }

  getReconnectConfig(): Required<ReconnectConfig> & { attempts: number; scheduled: boolean } {
    return {
      ...this._reconnect,
      attempts: this._reconnectAttempts,
      scheduled: this._reconnectTimer !== null
    };
  }

  // ============================================
  // Server message handling
  // ============================================

  private _handleDoc(data: DocData): void {
    const str = data.str || '';
    const revision = data.revision || 0;

    if (data.clients) {
      for (const [id, user] of Object.entries(data.clients)) {
        this.users.set(id, { ...user, id });
      }
    }

    if (!this.otClient) {
      const old = this.document;
      this.document = str;
      this.otClient = new OTClientImpl(this, revision, str);
      this.ready = true;
      this._everReady = true;
      if (old !== str) this.emit('document', this.document);
    } else {
      // Mark ready first so a resend can go out on this socket.
      this.ready = true;
      const outcome = this.otClient.serverReconnect(revision, str, !!data.force || this._discardPendingOnNextDoc);
      this._discardPendingOnNextDoc = false;
      this.emit('resync', outcome);
    }

    this.emit('ready', { document: this.document, revision: this.revision });
  }

  private _handleRefresh(data: RefreshData): void {
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
      docmaxlength: data.docmaxlength || null
    };
    this.emit('refresh', this.noteInfo);
  }

  /** Run an OT step; on failure report it and reload from the server. */
  private _otStep(details: Record<string, unknown>, step: () => void): void {
    if (!this.otClient) return;
    try {
      step();
    } catch (error) {
      this.emit('ot-error', { ...details, error });
      // A desync error is raised before any state changes, so pending edits
      // are still valid and can be re-sent. Anything else means the local OT
      // state is suspect.
      this._resync(!(error instanceof OTDesyncError));
    }
  }

  private _handleAck(revision: number): void {
    this._otStep({ type: 'ack', revision }, () => this.otClient!.serverAck(revision));
  }

  private _handleOperation(clientId: string, revision: number, operation: OperationJSON): void {
    this._otStep({ type: 'operation', clientId, revision, operation }, () => {
      const op = TextOperation.fromJSON(operation);
      this._remoteOrigin = clientId;
      try {
        this.otClient!.applyServer(revision, op);
      } finally {
        this._remoteOrigin = null;
      }
    });
  }

  private _handleOperations(head: number, operations: OperationJSON[]): void {
    this._otStep({ type: 'operations', head }, () => this.otClient!.applyOperations(head, operations));
  }

  private _handleOnlineUsers(data: { users?: UserInfo[] }): void {
    this.users.clear();
    if (data.users) {
      for (const user of data.users) {
        this.users.set(user.id, user);
      }
    }
    this.emit('users', this.getOnlineUsers());
  }

  // ============================================
  // Local edit pipeline
  // ============================================

  /** Apply a local operation and hand it to the OT client. */
  private _submit(operation: TextOperation): void {
    if (this._batch) {
      this.document = operation.apply(this.document);
      this._batch.op = this._batch.op.compose(operation);
      return;
    }
    if (operation.isNoop()) {
      return;
    }
    const oldDocument = this.document;
    this.document = operation.apply(oldDocument);
    this._recordUndo(operation, oldDocument);
    this.otClient!.applyClient(operation);
    this.emit('document', this.document);
    this.emit('change', { type: 'local', operation } satisfies ChangeEvent);
  }

  /** Called by the OT client when a remote change has been applied to `document`. */
  _onRemoteChange(operation: TextOperation): void {
    this._transformUndoStacks(operation);
    const clientId = this._remoteOrigin ?? undefined;
    const user = clientId ? this.users.get(clientId) : undefined;
    this.emit('document', this.document);
    this.emit('change', { type: 'remote', operation, clientId, user } satisfies ChangeEvent);
  }

  // ============================================
  // Undo/Redo
  // ============================================

  private _recordUndo(operation: TextOperation, oldDocument: string): void {
    if (!this._trackUndo || this._applyingUndo) return;
    const inverse = operation.invert(oldDocument);
    const now = Date.now();
    const top = this._undoStack[this._undoStack.length - 1];
    if (top && this._undoMayCompose && now - this._lastUndoTimestamp < this._undoGroupInterval) {
      this._undoStack[this._undoStack.length - 1] = inverse.compose(top);
    } else {
      this._undoStack.push(inverse);
      if (this._undoStack.length > this._undoMaxSize) {
        this._undoStack.shift();
      }
    }
    this._lastUndoTimestamp = now;
    this._undoMayCompose = true;
    this._redoStack = [];
  }

  private _transformUndoStacks(operation: TextOperation): void {
    const transformStack = (stack: TextOperation[]): TextOperation[] => {
      const result: TextOperation[] = [];
      let op = operation;
      for (let i = stack.length - 1; i >= 0; i--) {
        const [entryPrime, opPrime] = TextOperation.transform(stack[i], op);
        if (!entryPrime.isNoop()) result.push(entryPrime);
        op = opPrime;
      }
      return result.reverse();
    };
    this._undoStack = transformStack(this._undoStack);
    this._redoStack = transformStack(this._redoStack);
    this._undoMayCompose = false;
  }

  canUndo(): boolean {
    return this._undoStack.length > 0;
  }

  canRedo(): boolean {
    return this._redoStack.length > 0;
  }

  /** Undo the last local edit, keeping any remote edits made since. */
  undo(): boolean {
    if (!this.canUndo()) return false;
    this._assertEditable();
    const operation = this._undoStack.pop()!;
    this._applyHistory(operation, this._redoStack);
    this.emit('undo', { operation });
    return true;
  }

  /** Redo the last undone edit. */
  redo(): boolean {
    if (!this.canRedo()) return false;
    this._assertEditable();
    const operation = this._redoStack.pop()!;
    this._applyHistory(operation, this._undoStack);
    this.emit('redo', { operation });
    return true;
  }

  private _applyHistory(operation: TextOperation, opposite: TextOperation[]): void {
    const before = this.document;
    this._applyingUndo = true;
    try {
      this._submit(operation);
    } finally {
      this._applyingUndo = false;
    }
    opposite.push(operation.invert(before));
    this._undoMayCompose = false;
  }

  clearHistory(): void {
    this._undoStack = [];
    this._redoStack = [];
  }

  getUndoStackSize(): number {
    return this._undoStack.length;
  }

  getRedoStackSize(): number {
    return this._redoStack.length;
  }
}

// ===========================================
// OTClientImpl - binds the OT state machine to the client and socket
// ===========================================

class OTClientImpl extends OTClient {
  constructor(private readonly client: HedgeDocClient, revision: number, document: string) {
    super(revision, document);
  }

  sendOperation(revision: number, operation: TextOperation): void {
    // While disconnected the op stays outstanding and is re-sent on reconnect.
    if (this.client.socket && this.client.ready) {
      this.client.socket.emit('operation', revision, operation.toJSON(), null);
    }
  }

  applyOperation(operation: TextOperation): void {
    this.client.document = operation.apply(this.client.document);
    this.client._onRemoteChange(operation);
  }

  resetDocument(document: string): void {
    const old = this.client.document;
    this.client.clearHistory();
    if (old === document) return;
    this.client.document = document;
    this.client._onRemoteChange(diffToOperation(old, document));
  }

  getOperations(base: number, head: number): void {
    // The server ignores requests with base 0 (`if (!base) return`), so
    // recover through a fresh document instead.
    if (base === 0) {
      queueMicrotask(() => this.client._resync(false));
      return;
    }
    if (this.client.socket && this.client.ready) {
      this.client.socket.emit('get_operations', base, head);
    }
  }

  onSynchronized(): void {
    this.client.emit('synchronized');
  }
}
