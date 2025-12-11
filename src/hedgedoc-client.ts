import { EventEmitter } from 'events';
import { io, Socket } from 'socket.io-client';
import { TextOperation, OperationJSON } from './text-operation.js';
import { OTClient, Transformable } from './ot-client.js';

// ===========================================
// Types
// ===========================================

/** Rate limit configuration */
export interface RateLimitConfig {
  minInterval?: number;
  maxBurst?: number;
  burstWindow?: number;
  enabled?: boolean;
}

/** Reconnection configuration */
export interface ReconnectConfig {
  enabled?: boolean;
  maxAttempts?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffFactor?: number;
}

/** Client options */
export interface HedgeDocClientOptions {
  serverUrl: string;
  noteId: string;
  cookie?: string | null;
  operationTimeout?: number;
  rateLimit?: RateLimitConfig;
  reconnect?: ReconnectConfig;
  undoMaxSize?: number;
  trackUndo?: boolean;
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
  id: string;
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

/** Undo entry */
interface UndoEntry {
  operation: TextOperation;
  oldDocument: string;
  newDocument: string;
  timestamp: number;
}

/** Change event */
export interface ChangeEvent {
  type: 'local' | 'remote';
  operation: TextOperation;
  /** Client ID of the user who made the change (only for remote changes) */
  clientId?: string;
  /** User info of who made the change (only for remote changes, if available) */
  user?: UserInfo;
}

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

// ===========================================
// Error Types
// ===========================================

class HedgeDocError extends Error {
  code?: number;
  
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
    this.name = 'HedgeDocError';
  }
}

// ===========================================
// HedgeDocClient Class
// ===========================================

/**
 * HedgeDocClient - Connect to a HedgeDoc server and sync documents in real-time
 * 
 * This is the main entry point for the hedgesync library. It provides:
 * - Connection management to HedgeDoc servers
 * - Real-time document synchronization using Operational Transformation
 * - High-level editing API (insert, delete, replace)
 * - Event emission for document changes
 * - Rate limiting, reconnection handling, and batch operations
 */
export class HedgeDocClient extends EventEmitter {
  serverUrl: string;
  noteId: string;
  cookie: string | null;
  socket: Socket | null;
  document: string;
  revision: number;
  connected: boolean;
  ready: boolean;
  otClient: OTClientImpl | null;
  noteInfo: NoteInfo;
  users: Map<string, UserInfo>;

  private _sessionCookie: string | null;
  private _isLoggedIn: boolean;
  private _pendingOperation: TextOperation | null;
  private _operationTimeout: ReturnType<typeof setTimeout> | null;
  private _operationTimeoutMs: number;
  
  /** Last client ID that made a remote change (for user attribution) */
  _lastRemoteClientId: string | null;
  
  // Rate limiting
  private _rateLimit: Required<RateLimitConfig>;
  private _lastOperationTime: number;
  private _operationTimes: number[];
  _operationQueue: TextOperation[];
  private _processingQueue: boolean;
  
  // Reconnection
  private _reconnect: Required<ReconnectConfig>;
  private _reconnectAttempts: number;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null;
  private _intentionalDisconnect: boolean;
  private _pendingOperationsDuringDisconnect: TextOperation[];
  
  // Batch operations
  private _batchMode: boolean;
  private _batchOperations: TextOperation[];
  
  // Undo/Redo
  private _undoStack: UndoEntry[];
  private _redoStack: UndoEntry[];
  private _undoMaxSize: number;
  private _trackUndo: boolean;
  private _lastUndoTimestamp: number;
  private _undoGroupInterval: number;

  /**
   * Create a new HedgeDoc client
   */
  constructor(options: HedgeDocClientOptions) {
    super();
    
    if (!options.serverUrl) {
      throw new Error('serverUrl is required');
    }
    if (!options.noteId) {
      throw new Error('noteId is required');
    }

    this.serverUrl = options.serverUrl.replace(/\/$/, ''); // Remove trailing slash
    this.noteId = options.noteId;
    this.cookie = options.cookie || null;
    
    this.socket = null;
    this.document = '';
    this.revision = 0;
    this.connected = false;
    this.ready = false;
    
    // OT client for handling operations
    this.otClient = null;
    
    // Note metadata
    this.noteInfo = {
      title: '',
      permission: '',
      owner: null,
      authors: {},
      createtime: null,
      updatetime: null
    };
    
    // Online users
    this.users = new Map();
    
    // Session cookie obtained from server
    this._sessionCookie = null;
    
    // Track if user is logged in (for permission checking)
    this._isLoggedIn = false;
    
    // Last remote client ID (for user attribution)
    this._lastRemoteClientId = null;
    
    // Pending operation tracking for timeout detection
    this._pendingOperation = null;
    this._operationTimeout = null;
    this._operationTimeoutMs = options.operationTimeout || 5000;

    // Rate Limiting
    this._rateLimit = {
      minInterval: options.rateLimit?.minInterval ?? 50,
      maxBurst: options.rateLimit?.maxBurst ?? 10,
      burstWindow: options.rateLimit?.burstWindow ?? 1000,
      enabled: options.rateLimit?.enabled ?? true
    };
    this._lastOperationTime = 0;
    this._operationTimes = [];
    this._operationQueue = [];
    this._processingQueue = false;

    // Reconnection Handling
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
    this._pendingOperationsDuringDisconnect = [];

    // Batch Operations
    this._batchMode = false;
    this._batchOperations = [];

    // Undo/Redo Stack
    this._undoStack = [];
    this._redoStack = [];
    this._undoMaxSize = options.undoMaxSize ?? 100;
    this._trackUndo = options.trackUndo ?? true;
    this._lastUndoTimestamp = 0;
    this._undoGroupInterval = options.undoGroupInterval ?? 500;
  }

  /**
   * Check if the current user can edit the note based on permissions
   */
  canEdit(): boolean {
    const permission = this.noteInfo.permission;
    
    switch (permission) {
      case 'freely':
        return true;
      case 'editable':
      case 'limited':
        return this._isLoggedIn;
      case 'locked':
      case 'private':
      case 'protected':
        return this._isLoggedIn;
      default:
        return false;
    }
  }

  /**
   * Get a human-readable explanation of why editing is not allowed
   */
  private _getPermissionError(): string | null {
    const permission = this.noteInfo.permission;
    
    if (this.canEdit()) {
      return null;
    }
    
    switch (permission) {
      case 'editable':
      case 'limited':
        return `This note requires login to edit (permission: ${permission}). Please provide an authenticated session cookie.`;
      case 'locked':
      case 'private':
      case 'protected':
        return `This note can only be edited by its owner (permission: ${permission}).`;
      default:
        return `Cannot edit this note (permission: ${permission}).`;
    }
  }

  /**
   * Fetch a session cookie from the HedgeDoc server
   */
  private async _getSessionCookie(): Promise<string> {
    if (this.cookie) {
      return this.cookie;
    }

    const response = await fetch(`${this.serverUrl}/${this.noteId}`, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'Accept': 'text/html'
      }
    });

    let cookies: string[] = [];
    if ((response.headers as any).getSetCookie) {
      cookies = (response.headers as any).getSetCookie();
    } else {
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) {
        cookies = [setCookie];
      }
    }

    const sessionCookies: string[] = [];
    for (const cookie of cookies) {
      const cookiePart = cookie.split(';')[0];
      if (cookiePart) {
        sessionCookies.push(cookiePart);
      }
    }
    
    if (sessionCookies.length > 0) {
      this._sessionCookie = sessionCookies.join('; ');
      return this._sessionCookie;
    }

    throw new Error('Failed to obtain session cookie from server');
  }

  /**
   * Connect to the HedgeDoc server
   */
  connect(): Promise<void> {
    this._intentionalDisconnect = false;
    this._reconnectAttempts = 0;
    
    return new Promise(async (resolve, reject) => {
      try {
        await this._doConnect(resolve, reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Internal connection logic (supports reconnection)
   */
  private async _doConnect(
    resolve: (() => void) | null, 
    reject: ((error: Error) => void) | null
  ): Promise<void> {
    try {
      const cookie = await this._getSessionCookie();
      
      // Detect if we're running in Bun
      const isBun = typeof Bun !== 'undefined';
      
      const socketOptions = {
        query: {
          noteId: this.noteId
        },
        transports: isBun ? ['websocket'] as ('websocket')[] : ['polling', 'websocket'] as ('polling' | 'websocket')[],
        withCredentials: true,
        extraHeaders: {
          Cookie: cookie
        },
        reconnection: false
      };

      this.socket = io(this.serverUrl, socketOptions);

      // Connection events
      this.socket.on('connect', () => {
        this.connected = true;
        this._reconnectAttempts = 0;
        this.emit('connect');
        
        if (this._pendingOperationsDuringDisconnect.length > 0) {
          this.emit('reconnect:replaying', this._pendingOperationsDuringDisconnect.length);
        }
      });

      this.socket.on('disconnect', (reason: string) => {
        const wasReady = this.ready;
        this.connected = false;
        this.ready = false;
        this.emit('disconnect', reason);
        
        if (!this._intentionalDisconnect && this._reconnect.enabled && wasReady) {
          this._scheduleReconnect();
        }
      });

      this.socket.on('connect_error', (error: Error) => {
        if (!this.ready && reject) {
          reject(error);
          reject = null;
        }
        this.emit('error', error);
        
        if (!this._intentionalDisconnect && this._reconnect.enabled) {
          this._scheduleReconnect();
        }
      });

      this.socket.on('doc', (data: DocData) => {
        this._handleDoc(data);
        this.socket!.emit('refresh');
        this.ready = true;
        
        if (resolve) {
          resolve();
          resolve = null;
        }
        
        this.emit('ready', {
          document: this.document,
          revision: this.revision
        });
        
        this._pendingOperationsDuringDisconnect = [];
      });

      this.socket.on('info', (data: InfoData) => {
        if (data.code === 403) {
          const error = new HedgeDocError('Access forbidden', 403);
          if (reject) {
            reject(error);
            reject = null;
          }
          this.emit('error', error);
        } else if (data.code === 404) {
          const error = new HedgeDocError('Note not found', 404);
          if (reject) {
            reject(error);
            reject = null;
          }
          this.emit('error', error);
        } else {
          this.emit('info', data);
        }
      });

      this.socket.on('refresh', (data: RefreshData) => {
        this._handleRefresh(data);
      });

      this.socket.on('ack', (revision: number) => {
        this._handleAck(revision);
      });

      this.socket.on('operation', (clientId: string, revision: number, operation: OperationJSON, selection: unknown) => {
        this._handleOperation(clientId, revision, operation, selection);
      });

      this.socket.on('operations', (head: number, operations: OperationJSON[]) => {
        this._handleOperations(head, operations);
      });

      this.socket.on('online users', (data: { users?: UserInfo[] }) => {
        this._handleOnlineUsers(data);
      });

      this.socket.on('user status', (user: UserInfo) => {
        this._handleUserStatus(user);
      });

      this.socket.on('cursor focus', (user: unknown) => {
        this.emit('cursor:focus', user);
      });

      this.socket.on('cursor activity', (user: unknown) => {
        this.emit('cursor:activity', user);
      });

      this.socket.on('cursor blur', (data: unknown) => {
        this.emit('cursor:blur', data);
      });

      this.socket.on('client_left', (clientId: string) => {
        this.users.delete(clientId);
        this.emit('user:left', clientId);
      });

      this.socket.on('permission', (data: { permission: string }) => {
        this.noteInfo.permission = data.permission;
        this.emit('permission', data.permission);
      });

      this.socket.on('delete', () => {
        this.emit('delete');
        this.disconnect();
      });

      this.socket.on('version', (data: unknown) => {
        this.emit('version', data);
      });
      
    } catch (error) {
      if (reject) reject(error as Error);
      else throw error;
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   */
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
    
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      
      this.emit('reconnect:attempting', {
        attempt: this._reconnectAttempts,
        maxAttempts: this._reconnect.maxAttempts
      });
      
      try {
        if (this.socket) {
          this.socket.removeAllListeners();
          this.socket.disconnect();
          this.socket = null;
        }
        
        await this._doConnect(
          () => this.emit('reconnect:success', { attempts: this._reconnectAttempts }),
          (error) => {
            this.emit('reconnect:error', { error, attempt: this._reconnectAttempts });
            if (this._reconnect.enabled && !this._intentionalDisconnect) {
              this._scheduleReconnect();
            }
          }
        );
      } catch (error) {
        this.emit('reconnect:error', { error, attempt: this._reconnectAttempts });
        if (this._reconnect.enabled && !this._intentionalDisconnect) {
          this._scheduleReconnect();
        }
      }
    }, delay);
  }

  /**
   * Cancel any pending reconnection attempt
   */
  private _cancelReconnect(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  /**
   * Disconnect from the server
   */
  disconnect(intentional: boolean = true): void {
    this._intentionalDisconnect = intentional;
    this._cancelReconnect();
    
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.connected = false;
    this.ready = false;
  }

  /**
   * Get the current document content
   */
  getDocument(): string {
    return this.document;
  }

  /**
   * Get the current revision number
   */
  getRevision(): number {
    return this.revision;
  }

  /**
   * Get note information
   */
  getNoteInfo(): NoteInfo {
    return { ...this.noteInfo };
  }

  /**
   * Get online users
   */
  getOnlineUsers(): UserInfo[] {
    return Array.from(this.users.values());
  }

  /**
   * Check if the OT client is in synchronized state (no pending operations)
   */
  isSynchronized(): boolean {
    return this.otClient ? this.otClient.isSynchronized() : true;
  }

  /**
   * Get document content with authorship information
   */
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

  /**
   * Get authors who have contributed to this document
   */
  getAuthors(): AuthorEntry[] {
    const authors = this.noteInfo.authors || {};
    return Object.entries(authors).map(([userId, profile]) => ({
      userId,
      name: profile.name || 'Anonymous',
      color: profile.color || '#888888',
      photo: profile.photo || null
    }));
  }

  /**
   * Insert text at a position
   */
  insert(position: number, text: string): void {
    if (!this.ready) {
      throw new Error('Client not ready. Wait for connection to complete.');
    }
    const permError = this._getPermissionError();
    if (permError) {
      throw new Error(permError);
    }
    if (position < 0 || position > this.document.length) {
      throw new Error('Position out of bounds');
    }
    
    const op = new TextOperation();
    if (position > 0) {
      op.retain(position);
    }
    op.insert(text);
    if (position < this.document.length) {
      op.retain(this.document.length - position);
    }
    
    this._applyClientOperation(op);
  }

  /**
   * Delete text at a position
   */
  delete(position: number, length: number): void {
    if (!this.ready) {
      throw new Error('Client not ready. Wait for connection to complete.');
    }
    const permError = this._getPermissionError();
    if (permError) {
      throw new Error(permError);
    }
    if (position < 0 || position + length > this.document.length) {
      throw new Error('Position out of bounds');
    }
    if (length <= 0) return;
    
    const op = new TextOperation();
    if (position > 0) {
      op.retain(position);
    }
    op.delete(length);
    if (position + length < this.document.length) {
      op.retain(this.document.length - position - length);
    }
    
    this._applyClientOperation(op);
  }

  /**
   * Replace text in a range
   */
  replace(position: number, length: number, text: string): void {
    if (!this.ready) {
      throw new Error('Client not ready. Wait for connection to complete.');
    }
    const permError = this._getPermissionError();
    if (permError) {
      throw new Error(permError);
    }
    if (position < 0 || position + length > this.document.length) {
      throw new Error('Position out of bounds');
    }
    
    const op = new TextOperation();
    if (position > 0) {
      op.retain(position);
    }
    if (length > 0) {
      op.delete(length);
    }
    if (text) {
      op.insert(text);
    }
    if (position + length < this.document.length) {
      op.retain(this.document.length - position - length);
    }
    
    this._applyClientOperation(op);
  }

  /**
   * Set the entire document content
   */
  setContent(content: string): void {
    if (!this.ready) {
      throw new Error('Client not ready. Wait for connection to complete.');
    }
    const permError = this._getPermissionError();
    if (permError) {
      throw new Error(permError);
    }
    
    const op = new TextOperation();
    if (this.document.length > 0) {
      op.delete(this.document.length);
    }
    if (content) {
      op.insert(content);
    }
    
    this._applyClientOperation(op);
  }

  /**
   * Apply a raw TextOperation
   */
  applyOperation(operation: TextOperation): void {
    if (!this.ready) {
      throw new Error('Client not ready. Wait for connection to complete.');
    }
    const permError = this._getPermissionError();
    if (permError) {
      throw new Error(permError);
    }
    this._applyClientOperation(operation);
  }

  // ============================================
  // Advanced Editing Methods
  // ============================================

  /**
   * Replace all matches of a pattern with a replacement string
   */
  replaceRegex(
    pattern: RegExp | string, 
    replacement: string | ((match: string, ...args: unknown[]) => string)
  ): number {
    if (!this.ready) {
      throw new Error('Client not ready. Wait for connection to complete.');
    }
    const permError = this._getPermissionError();
    if (permError) {
      throw new Error(permError);
    }

    const doc = this.document;
    const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'g');
    
    const globalRegex = regex.global ? regex : new RegExp(regex.source, regex.flags + 'g');
    
    interface MatchInfo {
      index: number;
      length: number;
      match: string;
      groups: string[];
    }
    
    const matches: MatchInfo[] = [];
    let match: RegExpExecArray | null;
    while ((match = globalRegex.exec(doc)) !== null) {
      matches.push({
        index: match.index,
        length: match[0].length,
        match: match[0],
        groups: match.slice(1)
      });
    }
    
    if (matches.length === 0) {
      return 0;
    }

    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      let replaceText: string;
      
      if (typeof replacement === 'function') {
        replaceText = replacement(m.match, ...m.groups, m.index, doc);
      } else {
        replaceText = replacement.replace(/\$(\d+)/g, (_, n) => m.groups[parseInt(n) - 1] || '');
        replaceText = replaceText.replace(/\$&/g, m.match);
      }
      
      this.replace(m.index, m.length, replaceText);
    }
    
    return matches.length;
  }

  /**
   * Replace the first match of a pattern
   */
  replaceFirst(
    pattern: RegExp | string, 
    replacement: string | ((match: string, ...args: unknown[]) => string)
  ): boolean {
    if (!this.ready) {
      throw new Error('Client not ready. Wait for connection to complete.');
    }
    const permError = this._getPermissionError();
    if (permError) {
      throw new Error(permError);
    }

    const doc = this.document;
    const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    const match = doc.match(regex);
    
    if (!match || match.index === undefined) {
      return false;
    }
    
    let replaceText: string;
    if (typeof replacement === 'function') {
      replaceText = replacement(match[0], ...match.slice(1), match.index, doc);
    } else {
      replaceText = replacement.replace(/\$(\d+)/g, (_, n) => match[parseInt(n)] || '');
      replaceText = replaceText.replace(/\$&/g, match[0]);
    }
    
    this.replace(match.index, match[0].length, replaceText);
    return true;
  }

  // ============================================
  // Line-based Operations
  // ============================================

  /**
   * Get the document split into lines
   */
  getLines(): string[] {
    return this.document.split('\n');
  }

  /**
   * Get a specific line (0-indexed)
   */
  getLine(lineNum: number): string | null {
    const lines = this.getLines();
    if (lineNum < 0 || lineNum >= lines.length) {
      return null;
    }
    return lines[lineNum];
  }

  /**
   * Get the number of lines in the document
   */
  getLineCount(): number {
    return this.getLines().length;
  }

  /**
   * Get the character position where a line starts
   */
  getLineStart(lineNum: number): number {
    if (lineNum < 0) return -1;
    const lines = this.getLines();
    if (lineNum >= lines.length) return -1;
    
    let pos = 0;
    for (let i = 0; i < lineNum; i++) {
      pos += lines[i].length + 1;
    }
    return pos;
  }

  /**
   * Get the character position where a line ends (before newline)
   */
  getLineEnd(lineNum: number): number {
    const start = this.getLineStart(lineNum);
    if (start === -1) return -1;
    const line = this.getLine(lineNum);
    return start + (line?.length || 0);
  }

  /**
   * Replace the content of a specific line
   */
  setLine(lineNum: number, content: string): void {
    const start = this.getLineStart(lineNum);
    if (start === -1) {
      throw new Error(`Line ${lineNum} out of bounds`);
    }
    const oldLine = this.getLine(lineNum);
    this.replace(start, oldLine?.length || 0, content);
  }

  /**
   * Insert a new line at the specified position
   */
  insertLine(lineNum: number, content: string): void {
    if (!this.ready) {
      throw new Error('Client not ready. Wait for connection to complete.');
    }
    const permError = this._getPermissionError();
    if (permError) {
      throw new Error(permError);
    }

    const lines = this.getLines();
    
    if (lineNum <= 0) {
      this.insert(0, content + '\n');
    } else if (lineNum >= lines.length) {
      this.insert(this.document.length, '\n' + content);
    } else {
      const pos = this.getLineStart(lineNum);
      this.insert(pos, content + '\n');
    }
  }

  /**
   * Delete a specific line
   */
  deleteLine(lineNum: number): void {
    if (!this.ready) {
      throw new Error('Client not ready. Wait for connection to complete.');
    }
    const permError = this._getPermissionError();
    if (permError) {
      throw new Error(permError);
    }

    const lines = this.getLines();
    if (lineNum < 0 || lineNum >= lines.length) {
      throw new Error(`Line ${lineNum} out of bounds`);
    }
    
    const start = this.getLineStart(lineNum);
    const line = lines[lineNum];
    
    if (lines.length === 1) {
      this.delete(0, line.length);
    } else if (lineNum === lines.length - 1) {
      this.delete(start - 1, line.length + 1);
    } else {
      this.delete(start, line.length + 1);
    }
  }

  /**
   * Replace lines matching a pattern
   */
  replaceLines(
    pattern: RegExp | string, 
    replacement: string | ((line: string, lineNum: number, match: RegExpMatchArray) => string)
  ): number {
    if (!this.ready) {
      throw new Error('Client not ready. Wait for connection to complete.');
    }
    const permError = this._getPermissionError();
    if (permError) {
      throw new Error(permError);
    }

    const lines = this.getLines();
    const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    let count = 0;
    
    for (let i = lines.length - 1; i >= 0; i--) {
      const match = lines[i].match(regex);
      if (match) {
        let newContent: string;
        if (typeof replacement === 'function') {
          newContent = replacement(lines[i], i, match);
        } else {
          newContent = lines[i].replace(regex, replacement);
        }
        this.setLine(i, newContent);
        count++;
      }
    }
    
    return count;
  }

  // ============================================
  // Smart Update Methods
  // ============================================

  /**
   * Update document content using minimal diff operations
   */
  updateContent(newContent: string): number {
    if (!this.ready) {
      throw new Error('Client not ready. Wait for connection to complete.');
    }
    const permError = this._getPermissionError();
    if (permError) {
      throw new Error(permError);
    }

    const oldContent = this.document;
    if (oldContent === newContent) {
      return 0;
    }

    let prefixLen = 0;
    const minLen = Math.min(oldContent.length, newContent.length);
    
    while (prefixLen < minLen && oldContent[prefixLen] === newContent[prefixLen]) {
      prefixLen++;
    }
    
    let suffixLen = 0;
    while (
      suffixLen < minLen - prefixLen &&
      oldContent[oldContent.length - 1 - suffixLen] === newContent[newContent.length - 1 - suffixLen]
    ) {
      suffixLen++;
    }
    
    const deleteLen = oldContent.length - prefixLen - suffixLen;
    const insertText = newContent.slice(prefixLen, newContent.length - suffixLen);
    
    if (deleteLen > 0 || insertText.length > 0) {
      this.replace(prefixLen, deleteLen, insertText);
      return 1;
    }
    
    return 0;
  }

  /**
   * Request a refresh of note metadata
   */
  refresh(): void {
    if (this.socket && this.connected) {
      this.socket.emit('refresh');
    }
  }

  /**
   * Request online users
   */
  requestOnlineUsers(): void {
    if (this.socket && this.connected) {
      this.socket.emit('online users');
    }
  }

  /**
   * Request version info
   */
  requestVersion(): void {
    if (this.socket && this.connected) {
      this.socket.emit('version');
    }
  }

  // ============================================
  // Rate Limiting Control
  // ============================================

  /**
   * Enable or disable rate limiting
   */
  setRateLimitEnabled(enabled: boolean): void {
    this._rateLimit.enabled = enabled;
  }

  /**
   * Check if rate limiting is enabled
   */
  isRateLimitEnabled(): boolean {
    return this._rateLimit.enabled;
  }

  /**
   * Configure rate limiting
   */
  configureRateLimit(options: Partial<RateLimitConfig>): void {
    if (options.minInterval !== undefined) {
      this._rateLimit.minInterval = options.minInterval;
    }
    if (options.maxBurst !== undefined) {
      this._rateLimit.maxBurst = options.maxBurst;
    }
    if (options.burstWindow !== undefined) {
      this._rateLimit.burstWindow = options.burstWindow;
    }
  }

  /**
   * Get the current rate limit configuration
   */
  getRateLimitConfig(): Required<RateLimitConfig> {
    return { ...this._rateLimit };
  }

  /**
   * Get the number of operations currently queued
   */
  getQueuedOperationCount(): number {
    return this._operationQueue.length;
  }

  // ============================================
  // Reconnection Control
  // ============================================

  /**
   * Enable or disable auto-reconnection
   */
  setReconnectEnabled(enabled: boolean): void {
    this._reconnect.enabled = enabled;
    if (!enabled) {
      this._cancelReconnect();
    }
  }

  /**
   * Check if auto-reconnection is enabled
   */
  isReconnectEnabled(): boolean {
    return this._reconnect.enabled;
  }

  /**
   * Configure reconnection
   */
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

  /**
   * Get the current reconnection configuration
   */
  getReconnectConfig(): Required<ReconnectConfig> & { attempts: number; scheduled: boolean } {
    return {
      ...this._reconnect,
      attempts: this._reconnectAttempts,
      scheduled: this._reconnectTimer !== null
    };
  }

  /**
   * Manually trigger a reconnection
   */
  async reconnect(): Promise<void> {
    this._intentionalDisconnect = false;
    this._reconnectAttempts = 0;
    
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    
    return this.connect();
  }

  // ============================================
  // Private Event Handlers
  // ============================================

  private _handleDoc(data: DocData): void {
    this.document = data.str || '';
    this.revision = data.revision || 0;
    
    this.otClient = new OTClientImpl(this, this.revision);
    
    if (data.clients) {
      for (const [id, user] of Object.entries(data.clients)) {
        this.users.set(id, user);
      }
    }
    
    if (data.force) {
      this.emit('document', this.document);
    }
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

  private _handleAck(revision: number): void {
    if (this.otClient) {
      try {
        this.otClient.serverAck(revision);
      } catch (err) {
        this.emit('ot-error', { type: 'ack', revision, error: err });
        // Try to resync by emitting a refresh event
        this.refresh();
      }
    }
  }

  private _handleOperation(clientId: string, revision: number, operation: OperationJSON, selection: unknown): void {
    if (this.otClient) {
      try {
        // Store the clientId for user attribution in change events
        this._lastRemoteClientId = clientId;
        const op = TextOperation.fromJSON(operation);
        this.otClient.applyServer(revision, op);
      } catch (err) {
        this.emit('ot-error', { type: 'operation', clientId, revision, operation, error: err });
        // Try to resync by requesting a refresh
        this.refresh();
      }
    }
  }

  private _handleOperations(head: number, operations: OperationJSON[]): void {
    if (this.otClient) {
      try {
        this.otClient.applyOperations(head, operations);
      } catch (err) {
        this.emit('ot-error', { type: 'operations', head, error: err });
        this.refresh();
      }
    }
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

  private _handleUserStatus(user: UserInfo): void {
    if (user && user.id) {
      this.users.set(user.id, user);
      this.emit('user:status', user);
    }
  }

  // ============================================
  // Rate Limiting
  // ============================================

  /**
   * Check if we're within rate limits
   */
  private _checkRateLimit(): boolean {
    if (!this._rateLimit.enabled) {
      return true;
    }
    
    const now = Date.now();
    
    if (now - this._lastOperationTime < this._rateLimit.minInterval) {
      return false;
    }
    
    const windowStart = now - this._rateLimit.burstWindow;
    this._operationTimes = this._operationTimes.filter(t => t > windowStart);
    
    if (this._operationTimes.length >= this._rateLimit.maxBurst) {
      return false;
    }
    
    return true;
  }

  /**
   * Record an operation for rate limiting
   */
  private _recordOperation(): void {
    const now = Date.now();
    this._lastOperationTime = now;
    this._operationTimes.push(now);
  }

  /**
   * Process the operation queue
   */
  private async _processOperationQueue(): Promise<void> {
    if (this._processingQueue || this._operationQueue.length === 0) {
      return;
    }
    
    this._processingQueue = true;
    
    while (this._operationQueue.length > 0) {
      if (!this._checkRateLimit()) {
        const waitTime = this._rateLimit.minInterval - (Date.now() - this._lastOperationTime);
        await new Promise(resolve => setTimeout(resolve, Math.max(waitTime, 10)));
        continue;
      }
      
      const operation = this._operationQueue.shift()!;
      
      if (operation.baseLength !== this.document.length) {
        console.error(`Skipping stale operation: baseLength ${operation.baseLength} != doc length ${this.document.length}`);
        continue;
      }
      
      this._executeOperation(operation);
    }
    
    this._processingQueue = false;
  }

  /**
   * Execute an operation immediately
   */
  private _executeOperation(operation: TextOperation): void {
    const oldDocument = this.document;
    this.document = operation.apply(this.document);
    
    if (this._trackUndo) {
      this._pushUndo(operation, oldDocument);
    }
    
    this._recordOperation();
    
    if (this.otClient) {
      this.otClient.applyClient(operation);
    }
    
    this.emit('document', this.document);
    this.emit('change', { type: 'local', operation });
  }

  private _applyClientOperation(operation: TextOperation): void {
    if (this._batchMode) {
      this._batchOperations.push(operation);
      return;
    }
    
    if (this._rateLimit.enabled && !this._checkRateLimit()) {
      this._operationQueue.push(operation);
      this._processOperationQueue();
      return;
    }
    
    this._executeOperation(operation);
  }

  // ============================================
  // Batch Operations
  // ============================================

  /**
   * Start a batch of operations that will be applied together
   */
  startBatch(): HedgeDocClient {
    this._batchMode = true;
    this._batchOperations = [];
    return this;
  }

  /**
   * End the batch and apply all queued operations as one
   */
  endBatch(): TextOperation | null {
    this._batchMode = false;
    
    if (this._batchOperations.length === 0) {
      return null;
    }
    
    let combined = this._batchOperations[0];
    for (let i = 1; i < this._batchOperations.length; i++) {
      combined = combined.compose(this._batchOperations[i]);
    }
    
    this._batchOperations = [];
    
    this._executeOperation(combined);
    
    return combined;
  }

  /**
   * Discard the current batch without applying
   */
  cancelBatch(): void {
    this._batchMode = false;
    this._batchOperations = [];
  }

  /**
   * Check if currently in batch mode
   */
  isBatchMode(): boolean {
    return this._batchMode;
  }

  /**
   * Execute a function within a batch
   */
  batch(fn: () => void): TextOperation | null {
    this.startBatch();
    try {
      fn();
      return this.endBatch();
    } catch (error) {
      this.cancelBatch();
      throw error;
    }
  }

  // ============================================
  // Undo/Redo
  // ============================================

  /**
   * Push an operation to the undo stack
   */
  private _pushUndo(operation: TextOperation, oldDocument: string): void {
    const now = Date.now();
    
    if (this._undoStack.length > 0 && 
        now - this._lastUndoTimestamp < this._undoGroupInterval) {
      const last = this._undoStack[this._undoStack.length - 1];
      last.operation = last.operation.compose(operation);
      last.newDocument = this.document;
    } else {
      this._undoStack.push({
        operation: operation,
        oldDocument: oldDocument,
        newDocument: this.document,
        timestamp: now
      });
      
      while (this._undoStack.length > this._undoMaxSize) {
        this._undoStack.shift();
      }
    }
    
    this._lastUndoTimestamp = now;
    
    this._redoStack = [];
  }

  /**
   * Check if undo is available
   */
  canUndo(): boolean {
    return this._trackUndo && this._undoStack.length > 0;
  }

  /**
   * Check if redo is available
   */
  canRedo(): boolean {
    return this._trackUndo && this._redoStack.length > 0;
  }

  /**
   * Undo the last operation
   */
  undo(): boolean {
    if (!this.canUndo()) {
      return false;
    }
    
    const entry = this._undoStack.pop()!;
    
    this._trackUndo = false;
    try {
      this.updateContent(entry.oldDocument);
      
      this._redoStack.push({
        operation: entry.operation,
        oldDocument: entry.oldDocument,
        newDocument: entry.newDocument,
        timestamp: Date.now()
      });
      
      this.emit('undo', entry);
    } finally {
      this._trackUndo = true;
    }
    
    return true;
  }

  /**
   * Redo the last undone operation
   */
  redo(): boolean {
    if (!this.canRedo()) {
      return false;
    }
    
    const entry = this._redoStack.pop()!;
    
    this._trackUndo = false;
    try {
      this.updateContent(entry.newDocument);
      
      this._undoStack.push({
        operation: entry.operation,
        oldDocument: entry.oldDocument,
        newDocument: entry.newDocument,
        timestamp: Date.now()
      });
      
      this.emit('redo', entry);
    } finally {
      this._trackUndo = true;
    }
    
    return true;
  }

  /**
   * Clear the undo/redo history
   */
  clearHistory(): void {
    this._undoStack = [];
    this._redoStack = [];
  }

  /**
   * Get the undo stack size
   */
  getUndoStackSize(): number {
    return this._undoStack.length;
  }

  /**
   * Get the redo stack size
   */
  getRedoStackSize(): number {
    return this._redoStack.length;
  }
}

// ===========================================
// OTClientImpl - Internal OT client implementation
// ===========================================

class OTClientImpl extends OTClient {
  hedgeDocClient: HedgeDocClient;

  constructor(hedgeDocClient: HedgeDocClient, revision: number) {
    super(revision);
    this.hedgeDocClient = hedgeDocClient;
  }

  sendOperation(revision: number, operation: TextOperation): void {
    if (this.hedgeDocClient.socket && this.hedgeDocClient.connected) {
      this.hedgeDocClient.socket.emit('operation', revision, operation.toJSON(), null);
    }
  }

  applyOperation(operation: TextOperation): void {
    this.hedgeDocClient.document = operation.apply(this.hedgeDocClient.document);
    
    if (this.hedgeDocClient._operationQueue && this.hedgeDocClient._operationQueue.length > 0) {
      const transformedQueue: TextOperation[] = [];
      let serverOp = operation;
      
      for (const queuedOp of this.hedgeDocClient._operationQueue) {
        try {
          const [transformedQueued, transformedServer] = TextOperation.transform(queuedOp, serverOp);
          transformedQueue.push(transformedQueued);
          serverOp = transformedServer;
        } catch (err) {
          console.error('Failed to transform queued operation:', (err as Error).message);
        }
      }
      
      this.hedgeDocClient._operationQueue = transformedQueue;
    }
    
    this.hedgeDocClient.emit('document', this.hedgeDocClient.document);
    
    // Include user info in change event
    const clientId = this.hedgeDocClient._lastRemoteClientId;
    const user = clientId ? this.hedgeDocClient.users.get(clientId) : undefined;
    this.hedgeDocClient.emit('change', { 
      type: 'remote', 
      operation,
      clientId: clientId || undefined,
      user
    });
  }

  getOperations(base: number, head: number): void {
    if (this.hedgeDocClient.socket && this.hedgeDocClient.connected) {
      this.hedgeDocClient.socket.emit('get_operations', base, head);
    }
  }
}
