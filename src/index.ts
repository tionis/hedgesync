/**
 * hedgesync - HedgeDoc Live Document Editing Library
 * 
 * A TypeScript library for connecting to HedgeDoc servers and performing
 * real-time document synchronization using Operational Transformation.
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

// Authentication
export { 
  normalizeCookie, 
  extractSessionId,
  loginWithEmail, 
  loginWithLDAP, 
  loginWithOIDC,
  loginWithOAuth2Password,
  loginWithClientCredentials,
  loginWithDeviceCode,
  detectAuthMethods,
  AuthError 
} from './auth.js';
export type { 
  AuthResult,
  EmailAuthOptions,
  LDAPAuthOptions,
  OIDCAuthOptions,
  OAuth2PasswordOptions,
  OAuth2ClientCredentialsOptions,
  OAuth2DeviceCodeOptions,
  DeviceCodeInfo,
  AutoAuthOptions,
  ServerAuthMethods
} from './auth.js';

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
