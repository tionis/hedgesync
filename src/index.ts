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
  MacroMatch,
  Expansion,
  MacroInfo,
  TextMacroOptions,
  StreamingExecOptions,
  StreamingCallbacks
} from './macro-engine.js';
