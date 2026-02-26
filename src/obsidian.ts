/**
 * Obsidian/browser-safe entrypoint.
 *
 * Exposes the runtime-safe subset of hedgesync and intentionally excludes
 * Node-only modules (auth flow server, macro shell execution, pandoc process spawning).
 */

// Main client
export { HedgeDocClient } from './hedgedoc-client.js';
export type {
  HedgeDocClientOptions,
  RateLimitConfig,
  ReconnectConfig,
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

export { OTClient } from './ot-client.js';
export type { Transformable } from './ot-client.js';

// HTTP API client
export { HedgeDocAPI, HedgeDocAPIError } from './hedgedoc-api.js';
export type {
  HedgeDocAPIOptions,
  NoteMetadata,
  NotePermission,
  UserProfile,
  HistoryEntry,
  RevisionInfo,
  Revision,
  ServerStatus,
  ServerConfig
} from './hedgedoc-api.js';

// Cookie helpers
export { normalizeCookie, extractSessionId } from './cookie.js';
