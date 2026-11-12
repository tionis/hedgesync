/**
 * Obsidian/browser-safe entrypoint.
 *
 * Exposes the runtime-safe subset of hedgesync and intentionally excludes
 * Node-only modules (auth flow server, macro shell execution, pandoc process spawning).
 */

// Main client
export { HedgeDocClient, HedgeDocError } from './hedgedoc-client.js';
export type {
  HedgeDocClientOptions,
  SocketTransport,
  ReconnectConfig,
  SocketLike,
  SocketFactory,
  SocketFactoryOptions,
  ResyncEvent,
  NoteInfo,
  UserInfo,
  AuthorProfile,
  AuthorEntry,
  AuthorshipSpan,
  DocumentWithAuthorship,
  ChangeEvent
} from './hedgedoc-client.js';

// Operational Transformation
export { TextOperation } from './text-operation.js';
export type {
  Operation,
  RetainOp,
  InsertOp,
  DeleteOp,
  OperationJSON
} from './text-operation.js';

export { OTClient, OTDesyncError } from './ot-client.js';
export type { Transformable, ReconnectOutcome } from './ot-client.js';
export { diffToOperation } from './diff.js';

// HTTP API client
export { HedgeDocAPI, HedgeDocAPIError } from './hedgedoc-api.js';
export type {
  HedgeDocAPIOptions,
  CreatedNoteRef,
  NoteMetadata,
  NotePermission,
  UserProfile,
  HistoryEntry,
  RevisionInfo,
  Revision,
  ServerStatus,
  ServerConfig
} from './hedgedoc-api.js';

// HTTP transport abstraction
export {
  defaultHedgeSyncRequest,
  getHeader
} from './http.js';
export type {
  HedgeSyncRuntime,
  HedgeSyncHttpRequest,
  HedgeSyncHttpResponse,
  HedgeSyncRequestFn
} from './http.js';

// URL helpers
export {
  parseNoteUrl,
  parseServerUrl,
  buildNoteUrl
} from './url.js';
export type {
  ParsedNoteUrl
} from './url.js';

// Cookie helpers
export { normalizeCookie, extractSessionId } from './cookie.js';
