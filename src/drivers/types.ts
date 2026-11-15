/**
 * The seam between HedgeDocClient and a server protocol.
 *
 * HedgeDocClient owns the document text and everything that does not depend
 * on the server (editing helpers, batching, undo/redo, events). A NoteDriver
 * owns the connection: transport, authentication bootstrap, synchronisation
 * algorithm (OT for HedgeDoc 1, a CRDT for HedgeDoc 2), note metadata and the
 * permission model. Edits cross the seam as TextOperations in both directions.
 */

import type { CursorPosition } from '../cursor.js';
import type { TextOperation } from '../text-operation.js';
import type { HedgeSyncRequestFn, HedgeSyncRuntime } from '../http.js';
import type { ReconnectConfig, ReconnectPolicy } from './reconnect.js';

/** Realtime protocol families. */
export type NoteProtocol = 'hedgedoc1' | 'hedgedoc2';

export class HedgeDocError extends Error {
  code?: number;

  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
    this.name = 'HedgeDocError';
  }
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
  /** Connection id. */
  id: string;
  /** Account id for signed-in users. */
  userid?: string | null;
  login?: boolean;
  name?: string;
  color?: string;
  photo?: string;
  /** Where the user's cursor is, while their editor has focus. */
  cursor?: CursorPosition | null;
  idle?: boolean;
}

export function emptyNoteInfo(): NoteInfo {
  return { title: '', permission: '', owner: null, authors: {}, createtime: null, updatetime: null };
}

/** Who made a remote change, when the protocol says. */
export interface ChangeOrigin {
  clientId?: string;
  user?: UserInfo;
}

/** What a driver may do to the client that hosts it. */
export interface DriverHost {
  /** The client's current document text. */
  readonly document: string;
  /** First document of a session: set the text without reporting a change. */
  loadDocument(text: string): void;
  /** A remote edit, based on the current document. */
  applyRemoteChange(operation: TextOperation, origin?: ChangeOrigin): void;
  /** The server replaced the document (forced reload); local history is dropped. */
  replaceDocument(text: string): void;
  emit(event: string, ...args: any[]): unknown;
}

/** Options every driver receives (a subset of HedgeDocClientOptions). */
export interface DriverOptions {
  serverUrl: string;
  noteId: string;
  cookie: string | null;
  runtime: HedgeSyncRuntime;
  request: HedgeSyncRequestFn;
  headers: Record<string, string>;
  connectTimeout: number;
  reconnect?: ReconnectConfig;
}

export interface NoteDriver {
  readonly protocol: NoteProtocol;
  /** Transport is up. */
  readonly connected: boolean;
  /** The document is loaded and local edits can be sent. */
  readonly ready: boolean;
  /** Server revision for revision-based protocols, otherwise 0. */
  readonly revision: number;
  readonly noteInfo: NoteInfo;
  readonly users: Map<string, UserInfo>;
  readonly reconnectPolicy: ReconnectPolicy;

  /** Connect and resolve once the document and permissions are loaded. */
  connect(): Promise<void>;
  /** Close the connection; `intentional` suppresses automatic reconnection. */
  disconnect(intentional: boolean): void;
  /** Send a local edit. The host's document already includes it. */
  submit(operation: TextOperation): void;
  /** True when the server has every local edit. */
  isSynchronized(): boolean;
  /** Short description of the sync state, for error messages. */
  syncState(): string;
  /** Why this session may not edit, or null if it may (as far as the client can tell). */
  permissionError(): string | null;

  refresh(): void;
  requestOnlineUsers(): void;
  requestVersion(): void;
  /** Share this client's cursor (null: the editor lost focus). Optional per protocol. */
  setCursor?(cursor: CursorPosition | null): void;

  /** Owner action: change who may view and edit the note. Resolves once the server confirms. */
  setPermission?(permission: string, timeoutMs: number): Promise<void>;
  /** Owner action: delete the note. Resolves once the server confirms. */
  deleteNote?(timeoutMs: number): Promise<void>;
}

/** Builds a driver for a client. */
export type NoteDriverFactory = (host: DriverHost, options: DriverOptions) => NoteDriver;
