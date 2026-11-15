import { TextOperation } from './text-operation.js';
import type { ReconnectOutcome } from './ot-client.js';
import { diffToOperation } from './diff.js';
import { expandReplacement } from './replace.js';
import { normalizeCookie } from './cookie.js';
import { SimpleEventEmitter } from './simple-event-emitter.js';
import { HedgeSyncRuntime, HedgeSyncRequestFn, defaultHedgeSyncRequest } from './http.js';
import {
  HedgeDoc1Driver,
  createHedgeDoc1Driver,
  type SocketFactory,
  type SocketLike,
  type SocketTransport,
} from './drivers/hedgedoc1.js';
import type { ReconnectConfig } from './drivers/reconnect.js';
import {
  HedgeDocError,
  type AuthorProfile,
  type ChangeOrigin,
  type DriverHost,
  type NoteDriver,
  type NoteDriverFactory,
  type NoteInfo,
  type NoteProtocol,
  type UserInfo,
} from './drivers/types.js';

export { HedgeDocError };
export type { AuthorProfile, NoteInfo, UserInfo, ReconnectConfig, SocketTransport, SocketLike, SocketFactory };
export type { SocketFactoryOptions } from './drivers/hedgedoc1.js';

// ===========================================
// Types
// ===========================================

/** Client options */
export interface HedgeDocClientOptions {
  serverUrl: string;
  noteId: string;
  cookie?: string | null;
  /**
   * Server protocol (default "hedgedoc1"). HedgeDoc 2 is not supported yet;
   * use detectServer() to find out what a server speaks.
   */
  protocol?: NoteProtocol;
  /** Custom driver (overrides `protocol`); mainly for tests and experiments. */
  driver?: NoteDriverFactory;
  /** Force runtime mode instead of auto-detection (default: "auto"). */
  runtime?: HedgeSyncRuntime;
  /** Custom HTTP transport for bootstrap requests. Falls back to fetch. */
  request?: HedgeSyncRequestFn;
  /** Custom headers to include in all requests (for reverse proxy authentication, etc.) */
  headers?: Record<string, string>;
  /** HedgeDoc 1: Socket.IO transports. Defaults to polling with websocket upgrade, or websocket-only in Bun. */
  socketTransports?: SocketTransport[];
  /** HedgeDoc 1: custom socket factory (mainly for tests). */
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

type ReplacementFn = (match: string, ...args: any[]) => string;

/** Clone a regex with the global flag, so callers' lastIndex is never touched. */
function toGlobalRegex(pattern: RegExp | string): RegExp {
  if (typeof pattern === 'string') return new RegExp(pattern, 'g');
  return new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
}

function createDriver(protocol: NoteProtocol): NoteDriverFactory {
  if (protocol === 'hedgedoc1') return createHedgeDoc1Driver as NoteDriverFactory;
  if (protocol === 'hedgedoc2') {
    throw new HedgeDocError('HedgeDoc 2 servers are not supported yet (only HedgeDoc 1.x)', 501);
  }
  throw new Error(`Unknown protocol: ${String(protocol)}`);
}

// ===========================================
// HedgeDocClient Class
// ===========================================

/**
 * HedgeDocClient - edit a HedgeDoc note in real time.
 *
 * Edits are applied to `document` right away and handed to a protocol driver
 * (HedgeDoc 1.x: Socket.IO + OT, see drivers/hedgedoc1.ts) that sends them to
 * the server. Use `flush()` to wait until the server has every local edit.
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
export class HedgeDocClient extends SimpleEventEmitter implements DriverHost {
  serverUrl: string;
  noteId: string;
  cookie: string | null;
  customHeaders: Record<string, string>;
  document: string;
  /** The protocol driver this client talks through. */
  readonly driver: NoteDriver;

  private _operationTimeoutMs: number;

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
    const runtime = options.runtime ?? 'auto';
    if (!['auto', 'node', 'browser'].includes(runtime)) {
      throw new Error(`Invalid runtime mode: ${String(runtime)}`);
    }

    this.serverUrl = options.serverUrl.replace(/\/$/, '');
    this.noteId = options.noteId;
    this.cookie = options.cookie ? normalizeCookie(options.cookie) : null;
    this.customHeaders = options.headers || {};
    this._operationTimeoutMs = options.operationTimeout ?? 10000;
    this.document = '';

    this._batch = null;

    this._undoStack = [];
    this._redoStack = [];
    this._undoMaxSize = options.undoMaxSize ?? 100;
    this._trackUndo = options.trackUndo ?? true;
    this._undoGroupInterval = options.undoGroupInterval ?? 500;
    this._lastUndoTimestamp = 0;
    this._undoMayCompose = false;
    this._applyingUndo = false;

    const factory = options.driver ?? createDriver(options.protocol ?? 'hedgedoc1');
    this.driver = factory(this, {
      ...options,
      serverUrl: this.serverUrl,
      cookie: this.cookie,
      runtime,
      request: options.request || defaultHedgeSyncRequest,
      headers: this.customHeaders,
      connectTimeout: options.connectTimeout ?? 15000,
    });
  }

  // ============================================
  // Driver state
  // ============================================

  /** Server protocol of the driver. */
  get protocol(): NoteProtocol {
    return this.driver.protocol;
  }

  /** Current server revision known to this client (0 for revisionless protocols). */
  get revision(): number {
    return this.driver.revision;
  }

  get connected(): boolean {
    return this.driver.connected;
  }

  get ready(): boolean {
    return this.driver.ready;
  }

  get noteInfo(): NoteInfo {
    return this.driver.noteInfo;
  }

  get users(): Map<string, UserInfo> {
    return this.driver.users;
  }

  /** HedgeDoc 1 only: the Socket.IO socket. */
  get socket(): SocketLike | null {
    return this.driver instanceof HedgeDoc1Driver ? this.driver.socket : null;
  }

  /** HedgeDoc 1 only: the OT state machine. */
  get otClient(): HedgeDoc1Driver['otClient'] {
    return this.driver instanceof HedgeDoc1Driver ? this.driver.otClient : null;
  }

  // ============================================
  // Permissions
  // ============================================

  /**
   * Whether this session may edit the note, as far as the client can tell.
   * Servers may still reject edits silently; `flush()` reports that.
   */
  canEdit(): boolean {
    return this.driver.permissionError() === null;
  }

  private _assertEditable(): void {
    if (!this.driver.ready) {
      throw new Error('Client not ready. Wait for connection to complete.');
    }
    const permError = this.driver.permissionError();
    if (permError) {
      throw new Error(permError);
    }
  }

  // ============================================
  // Connection
  // ============================================

  /**
   * Connect to the server. Resolves once the document and note metadata
   * (including permissions) have loaded.
   */
  connect(): Promise<void> {
    return this.driver.connect();
  }

  /** Disconnect from the server. Unacknowledged edits are lost; call flush() first. */
  disconnect(intentional: boolean = true): void {
    this.driver.disconnect(intentional);
  }

  /** Manually reconnect. Pending local edits are kept and re-sent. */
  async reconnect(): Promise<void> {
    return this.connect();
  }

  /**
   * Wait until the server has every local edit.
   *
   * HedgeDoc silently ignores edits from sessions without write access, so a
   * timeout here usually means the edit was rejected.
   */
  flush(timeoutMs: number = this._operationTimeoutMs): Promise<void> {
    if (this.driver.isSynchronized()) {
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
          `Edits were not acknowledged within ${timeoutMs}ms (state: ${this.driver.syncState()}). ` +
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

  /** True when the server has every local edit. */
  isSynchronized(): boolean {
    return this.driver.isSynchronized();
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
    this.driver.refresh();
  }

  requestOnlineUsers(): void {
    this.driver.requestOnlineUsers();
  }

  requestVersion(): void {
    this.driver.requestVersion();
  }

  // ============================================
  // Owner actions
  // ============================================

  /**
   * Change who may view and edit the note (owner only). HedgeDoc 1 values:
   * freely, editable, limited, locked, protected, private. Resolves once the
   * server confirms; rejects if it does not (e.g. not the owner).
   */
  setPermission(permission: string, timeoutMs: number = this._operationTimeoutMs): Promise<void> {
    if (!this.driver.setPermission) return Promise.reject(new HedgeDocError(`${this.protocol} does not support changing permissions`, 501));
    return this.driver.setPermission(permission, timeoutMs);
  }

  /** Delete the note (owner only). The client is disconnected afterwards. */
  deleteNote(timeoutMs: number = this._operationTimeoutMs): Promise<void> {
    if (!this.driver.deleteNote) return Promise.reject(new HedgeDocError(`${this.protocol} does not support deleting notes`, 501));
    return this.driver.deleteNote(timeoutMs);
  }

  // ============================================
  // Reconnection Control
  // ============================================

  setReconnectEnabled(enabled: boolean): void {
    this.driver.reconnectPolicy.setEnabled(enabled);
  }

  isReconnectEnabled(): boolean {
    return this.driver.reconnectPolicy.config.enabled;
  }

  configureReconnect(options: Partial<ReconnectConfig>): void {
    this.driver.reconnectPolicy.configure(options);
  }

  getReconnectConfig(): Required<ReconnectConfig> & { attempts: number; scheduled: boolean } {
    return this.driver.reconnectPolicy.snapshot();
  }

  // ============================================
  // Document changes (local edits; DriverHost callbacks)
  // ============================================

  /** Apply a local operation and hand it to the driver. */
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
    this.driver.submit(operation);
    this.emit('document', this.document);
    this.emit('change', { type: 'local', operation } satisfies ChangeEvent);
  }

  /** @internal DriverHost: first document of a session. */
  loadDocument(text: string): void {
    const old = this.document;
    this.document = text;
    if (old !== text) this.emit('document', this.document);
  }

  /** @internal DriverHost: a remote edit based on the current document. */
  applyRemoteChange(operation: TextOperation, origin: ChangeOrigin = {}): void {
    this.document = operation.apply(this.document);
    this._transformUndoStacks(operation);
    this.emit('document', this.document);
    this.emit('change', { type: 'remote', operation, clientId: origin.clientId, user: origin.user } satisfies ChangeEvent);
  }

  /** @internal DriverHost: the server replaced the document; history is dropped. */
  replaceDocument(text: string): void {
    const old = this.document;
    this.clearHistory();
    if (old === text) return;
    this.applyRemoteChange(diffToOperation(old, text));
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
