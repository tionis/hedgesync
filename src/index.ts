/**
 * hedgesync - HedgeDoc Live Document Editing Library
 * 
 * A TypeScript library for connecting to HedgeDoc servers and performing
 * real-time document synchronization using Operational Transformation.
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

// Protocol drivers and server detection
export { HedgeDoc1Driver, createHedgeDoc1Driver } from './drivers/hedgedoc1.js';
export type { HedgeDoc1DriverOptions } from './drivers/hedgedoc1.js';
export { ReconnectPolicy } from './drivers/reconnect.js';
export type {
  NoteDriver,
  NoteDriverFactory,
  NoteProtocol,
  DriverHost,
  DriverOptions,
  ChangeOrigin
} from './drivers/types.js';
export { detectServer } from './server-detect.js';
export type { ServerInfo, DetectServerOptions } from './server-detect.js';

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
export { diffLines, unifiedDiff, diffStat, hunks } from './line-diff.js';
export type { DiffLine, Hunk } from './line-diff.js';
export { readFrontMatter, getMeta, getTags, setMeta } from './frontmatter.js';
export type { MetaEntry, MetaValue } from './frontmatter.js';
export { VERSION } from './version.js';

// HTTP API client
export { HedgeDocAPI, HedgeDocAPIError } from './hedgedoc-api.js';
export type {
  HedgeDocAPIOptions,
  CreatedNoteRef,
  NoteMetadata,
  NotePermission,
  NoteLinks,
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

// Authentication
export {
  normalizeCookie,
  extractSessionId,
  parseSetCookie,
  loginWithEmail,
  loginWithLDAP,
  getSessionUser,
  AuthError
} from './auth.js';
export type {
  AuthResult,
  SessionUser,
  EmailAuthOptions,
  LDAPAuthOptions,
  SessionCheckOptions
} from './auth.js';

// Session cookies from installed browsers (for OIDC/OAuth/SAML servers)
export {
  readBrowserCookies,
  sessionFromBrowser,
  BrowserCookieError,
  SUPPORTED_BROWSERS
} from './browser-cookies.js';
export type {
  BrowserName,
  BrowserCookie,
  CookieCandidate,
  BrowserCookieOptions,
  BrowserSession
} from './browser-cookies.js';

// Note mirroring
export { NoteMirror, mergeText, createMirrorTransform } from './mirror.js';
export type { MirrorClient, MirrorOptions, MirrorSyncEvent, MirrorDirection, MirrorTransformOptions } from './mirror.js';

// Pandoc integration
export { 
  PandocTransformer, 
  isPandocAvailable, 
  getPandocVersion, 
  markdownToAST, 
  astToMarkdown, 
  convert 
} from './pandoc-transformer.js';
export type {
  PandocAST,
  PandocOptions,
  TransformerOptions,
  ASTNode,
  Attr,
  Block,
  Inline,
  ASTVisitor,
  ASTTransformFn
} from './pandoc-transformer.js';

// Macro engine
export { MacroEngine } from './macro-engine.js';

// Safe shell execution for macros (Node/Bun only)
export { renderShellTemplate, runShell, spawnShell, killShell } from './shell.js';
export type { ShellCommand, ShellResult } from './shell.js';
export { expandReplacement } from './replace.js';
export type {
  Macro,
  TextMacro,
  RegexMacro,
  TemplateMacro,
  StreamingMacro,
  BlockMacro,
  MacroMatch,
  Expansion,
  MacroInfo,
  TextMacroOptions,
  StreamingExecOptions,
  StreamingCallbacks,
  BlockMacroOptions,
  DocumentContext,
  StateTracking,
  MacroEngineOptions
} from './macro-engine.js';
