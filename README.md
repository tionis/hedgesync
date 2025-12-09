# hedgesync

A library and CLI to programmatically connect to a running [HedgeDoc](https://hedgedoc.org/) server and make live edits to documents using Operational Transformation (OT).

## Features

- 🔌 **Real-time connection** via Socket.IO
- ✏️ **Live editing** with automatic conflict resolution (OT)
- 👥 **User presence** - see who's online
- 🔒 **Permission-aware** - proper error handling for read-only documents
- 📡 **Event-driven** - react to document changes from other users
- 🍪 **Auto-authentication** - automatically obtains session cookies
- 🔍 **Regex operations** - search and replace with patterns
- 📝 **Line operations** - manipulate documents by line number
- 🔄 **Pandoc integration** - AST-based transformations
- 🤖 **Macro system** - auto-expand triggers as you type
- ⏱️ **Rate limiting** - prevent overwhelming the server
- 🔁 **Auto-reconnection** - exponential backoff with operation queuing
- 📦 **Batch operations** - combine multiple edits into one
- ↩️ **Undo/Redo** - track edit history with grouping
- 💻 **CLI tool** - command-line interface for scripting

## Installation

```bash
cd hedgesync
bun install
```

Or with npm:

```bash
npm install
```

## Building Standalone Executable

You can compile the CLI into a standalone executable that doesn't require Bun or Node.js to be installed:

```bash
# Build for current platform
bun run build

# Build for specific platforms
bun run build:linux       # Linux x64
bun run build:macos       # macOS x64 (Intel)
bun run build:macos-arm   # macOS ARM64 (Apple Silicon)
bun run build:windows     # Windows x64

# Build for all platforms
bun run build:all
```

Compiled binaries are placed in the `dist/` directory.

## CLI Usage

The `hedgesync` CLI provides quick access to HedgeDoc documents from the command line.

### Commands

```bash
# Get document content
hedgesync get https://md.example.com/abc123

# Set document content from stdin
echo "# Hello World" | hedgesync set https://md.example.com/abc123

# Set document content from file
hedgesync set https://md.example.com/abc123 -f document.md

# Append text to document
hedgesync append https://md.example.com/abc123 "New content at the end"

# Prepend text to document
hedgesync prepend https://md.example.com/abc123 "New content at the start"

# Insert at position
hedgesync insert https://md.example.com/abc123 10 "inserted text"

# Search and replace (literal)
hedgesync replace https://md.example.com/abc123 "old text" "new text"

# Search and replace (regex)
hedgesync replace https://md.example.com/abc123 "\\d+" "NUMBER" --regex --all

# Get/set specific line (0-indexed)
hedgesync line https://md.example.com/abc123 0           # Get line 0
hedgesync line https://md.example.com/abc123 0 "# Title" # Set line 0

# Watch for changes
hedgesync watch https://md.example.com/abc123

# Get note info
hedgesync info https://md.example.com/abc123

# List online users
hedgesync users https://md.example.com/abc123

# Transform with pandoc
hedgesync transform https://md.example.com/abc123 --demote  # Demote headers
hedgesync transform https://md.example.com/abc123 --to html # Convert to HTML

# Get document authors/contributors
hedgesync authors https://md.example.com/abc123          # List authors
hedgesync authors https://md.example.com/abc123 -v       # Verbose with timestamps
hedgesync authors https://md.example.com/abc123 --json   # JSON output

# Run macros (text replacement)
hedgesync macro https://md.example.com/abc123 --text '::date' "$(date)"
hedgesync macro https://md.example.com/abc123 --regex '/TODO/gi' 'DONE'
hedgesync macro https://md.example.com/abc123 --built-in date
hedgesync macro https://md.example.com/abc123 --config macros.json --watch

# Execute shell commands via macros
hedgesync macro https://md.example.com/abc123 --exec '/::calc (.+?)::/gi:echo {1} | bc -l'
hedgesync macro https://md.example.com/abc123 --exec '/::uptime::/gi:uptime -p' --watch
```

### Options

```
<url>          Full HedgeDoc URL (required, e.g., https://md.example.com/abc123)
-c, --cookie   Session cookie for authentication (or HEDGEDOC_COOKIE env var)
-f, --file     Read content from file
-o, --output   Write output to file
-q, --quiet    Suppress non-essential output
--json         Output in JSON format
--regex, -r    Treat search pattern as regex
--all, -a, -g  Replace all occurrences
```

### Authentication

If the document requires authentication, provide a session cookie:

```bash
# Via command-line option
hedgesync get https://md.example.com/abc123 -c 'connect.sid=...'

# Via environment variable
export HEDGEDOC_COOKIE='connect.sid=...'
hedgesync get https://md.example.com/abc123
```

### Scripting Examples

```bash
# Backup a document
hedgesync get https://md.example.com/abc123 > backup.md

# Update timestamp in document
hedgesync replace https://md.example.com/abc123 \
  "Last updated:.*" \
  "Last updated: $(date)" \
  --regex

# Append log entry
echo "- $(date): Automated entry" | hedgesync append https://md.example.com/abc123

# Watch and log changes
hedgesync watch https://md.example.com/abc123 --json | while read line; do
  echo "$line" >> changes.log
done

# Pipe through pandoc
hedgesync get https://md.example.com/abc123 | pandoc -f markdown -t html > doc.html
```

## Library Quick Start

```javascript
import { HedgeDocClient } from 'hedgesync';

const client = new HedgeDocClient({
  serverUrl: 'https://hedgedoc.example.com',
  noteId: 'my-note-id'
});

// Connect to the document
await client.connect();

// Read the document
console.log(client.getDocument());

// Make edits (if you have permission)
if (client.canEdit()) {
  client.insert(0, 'Hello, World!\n');
}

// Listen for changes from other users
client.on('document', (content) => {
  console.log('Document updated:', content);
});

// Disconnect when done
client.disconnect();
```

## Examples

Run the examples with Bun:

```bash
# Basic usage - connect, read, and optionally edit
bun run examples/basic-usage.js https://your-hedgedoc.com note-id

# Watch a document for changes
bun run examples/watch-document.js https://your-hedgedoc.com note-id

# Programmatic editing demo
bun run examples/edit-document.js https://your-hedgedoc.com note-id

# Regex search and replace
bun run examples/regex-replace.js

# Line-based operations
bun run examples/line-operations.js

# Pandoc AST transformations (requires pandoc)
bun run examples/pandoc-transform.js

# Macro auto-expansion system
bun run examples/macro-system.js
```

Or with Node.js (still compatible):

```bash
node examples/basic-usage.js https://your-hedgedoc.com note-id
```

## API Reference

### `HedgeDocClient`

The main class for interacting with HedgeDoc.

#### Constructor

```javascript
const client = new HedgeDocClient({
  serverUrl: 'https://hedgedoc.example.com',  // Required
  noteId: 'my-note-id',                        // Required
  cookie: 'connect.sid=...',                   // Optional: session cookie for auth
  operationTimeout: 5000,                      // Optional: timeout for operations (ms)
  
  // Rate limiting options
  rateLimit: {
    enabled: true,       // Enable rate limiting (default: true)
    minInterval: 50,     // Min ms between operations (default: 50)
    maxBurst: 10,        // Max operations per burst window (default: 10)
    burstWindow: 1000    // Burst window in ms (default: 1000)
  },
  
  // Reconnection options
  reconnect: {
    enabled: true,       // Enable auto-reconnection (default: true)
    maxAttempts: 10,     // Max reconnection attempts (default: 10)
    initialDelay: 1000,  // Initial delay in ms (default: 1000)
    maxDelay: 30000,     // Max delay in ms (default: 30000)
    backoffFactor: 2     // Exponential backoff multiplier (default: 2)
  },
  
  // Undo/Redo options
  trackUndo: true,         // Enable undo tracking (default: true)
  undoMaxSize: 100,        // Max undo stack size (default: 100)
  undoGroupInterval: 500   // Group rapid edits within this window (ms, default: 500)
});
```

#### Methods

| Method | Description |
|--------|-------------|
| `connect()` | Connect to the server. Returns a Promise. |
| `disconnect()` | Disconnect from the server. |
| `reconnect()` | Manually trigger a reconnection. |
| `getDocument()` | Get the current document content as a string. |
| `getDocumentWithAuthorship()` | Get document with authorship information (see below). |
| `getAuthors()` | Get array of authors who have contributed to the document. |
| `getRevision()` | Get the current revision number. |
| `getNoteInfo()` | Get note metadata (title, permission, authors, etc.). |
| `getOnlineUsers()` | Get array of currently online users. |
| `canEdit()` | Check if the current user can edit the document. |
| `insert(position, text)` | Insert text at a position. |
| `delete(position, length)` | Delete characters starting at a position. |
| `replace(position, length, text)` | Replace a range with new text. |
| `setContent(content)` | Replace the entire document content. |
| `updateContent(content)` | Smart update using minimal diff operations. |
| `applyOperation(op)` | Apply a raw `TextOperation`. |
| `refresh()` | Request updated note metadata. |
| `requestOnlineUsers()` | Request the online users list. |
| `replaceRegex(pattern, replacement)` | Replace first regex match. |
| `replaceAllRegex(pattern, replacement)` | Replace all regex matches. |
| `getLine(lineNumber)` | Get content of a specific line (0-indexed). |
| `getLines()` | Get all lines as an array. |
| `setLine(lineNumber, content)` | Replace a specific line. |
| `insertLine(lineNumber, content)` | Insert a new line at position. |
| `deleteLine(lineNumber)` | Delete a specific line. |
| `startBatch()` | Begin a batch of operations. |
| `endBatch()` | End batch and apply combined operation. |
| `cancelBatch()` | Discard batch without applying. |
| `batch(fn)` | Execute function within a batch. |
| `undo()` | Undo the last operation. |
| `redo()` | Redo the last undone operation. |
| `canUndo()` / `canRedo()` | Check if undo/redo is available. |
| `clearHistory()` | Clear undo/redo history. |
| `setRateLimitEnabled(bool)` | Enable/disable rate limiting. |
| `configureRateLimit(opts)` | Configure rate limit settings. |
| `setReconnectEnabled(bool)` | Enable/disable auto-reconnection. |
| `configureReconnect(opts)` | Configure reconnection settings. |

#### Authorship Information

HedgeDoc tracks which user wrote each part of the document. Use `getDocumentWithAuthorship()` to get this information:

```javascript
const result = client.getDocumentWithAuthorship();

// result.content - The full document text
// result.authors - Object mapping userId to author profile
// result.authorship - Array of authorship spans

// Each span in authorship contains:
for (const span of result.authorship) {
  console.log(`User ${span.author?.name || 'Anonymous'} wrote:`);
  console.log(`  "${span.text}" (chars ${span.start}-${span.end})`);
  console.log(`  Created: ${span.createdAt}`);
}

// Helper: Get all text by a specific author
const ericText = result.getTextByAuthor('user-id-123');

// Helper: Get author at a position in the document
const authorAt50 = result.getAuthorAtPosition(50);
```

#### User Identity

When connecting to HedgeDoc:
- **Logged-in users**: Display name comes from their HedgeDoc profile
- **Anonymous users**: Display name is auto-generated as "Guest \<RandomSurname\>"

⚠️ **Note**: HedgeDoc does not support setting a custom display name for anonymous connections. To appear with a custom name, you must:
1. Create an account on the HedgeDoc server
2. Log in and obtain a session cookie
3. Use that cookie when connecting

```javascript
// With authentication (shows your profile name)
const client = new HedgeDocClient({
  serverUrl: 'https://hedgedoc.example.com',
  noteId: 'my-note',
  cookie: 'connect.sid=your-session-cookie'  // From browser after login
});
```

#### Events

```javascript
client.on('connect', () => { /* Connected to server */ });
client.on('disconnect', (reason) => { /* Disconnected */ });
client.on('ready', ({ document, revision }) => { /* Document loaded */ });
client.on('error', (error) => { /* Error occurred */ });

client.on('document', (content) => { /* Document content changed */ });
client.on('change', ({ type, operation }) => { /* Local/remote change */ });
client.on('refresh', (noteInfo) => { /* Note metadata updated */ });
client.on('permission', (permission) => { /* Permission changed */ });
client.on('delete', () => { /* Note was deleted */ });

client.on('users', (users) => { /* Online users list updated */ });
client.on('user:status', (user) => { /* User status changed */ });
client.on('user:left', (clientId) => { /* User disconnected */ });

client.on('cursor:focus', (user) => { /* User focused their cursor */ });
client.on('cursor:activity', (user) => { /* User moved their cursor */ });
client.on('cursor:blur', (data) => { /* User unfocused their cursor */ });

// Reconnection events
client.on('reconnect:scheduled', ({ attempt, maxAttempts, delay }) => { /* Reconnect scheduled */ });
client.on('reconnect:attempting', ({ attempt, maxAttempts }) => { /* Attempting to reconnect */ });
client.on('reconnect:success', ({ attempts }) => { /* Reconnected successfully */ });
client.on('reconnect:error', ({ error, attempt }) => { /* Reconnection attempt failed */ });
client.on('reconnect:failed', ({ attempts, maxAttempts }) => { /* All reconnection attempts failed */ });

// Undo/Redo events
client.on('undo', (entry) => { /* Operation was undone */ });
client.on('redo', (entry) => { /* Operation was redone */ });
```

### Rate Limiting

Rate limiting prevents overwhelming the server with rapid operations.

```javascript
// Configure at construction
const client = new HedgeDocClient({
  serverUrl: 'https://example.com',
  noteId: 'abc123',
  rateLimit: {
    minInterval: 100,  // Wait at least 100ms between ops
    maxBurst: 5,       // Max 5 ops per second
    burstWindow: 1000
  }
});

// Or configure at runtime
client.configureRateLimit({ minInterval: 50, maxBurst: 10 });

// Enable/disable
client.setRateLimitEnabled(false); // Disable for bulk operations
client.setRateLimitEnabled(true);  // Re-enable

// Check queue status
const queued = client.getQueuedOperationCount();
```

### Auto-Reconnection

The client automatically reconnects on connection loss with exponential backoff.

```javascript
// Configure at construction
const client = new HedgeDocClient({
  serverUrl: 'https://example.com',
  noteId: 'abc123',
  reconnect: {
    enabled: true,
    maxAttempts: 10,
    initialDelay: 1000,
    maxDelay: 30000,
    backoffFactor: 2
  }
});

// Listen to reconnection events
client.on('reconnect:scheduled', ({ attempt, delay }) => {
  console.log(`Reconnecting in ${delay}ms (attempt ${attempt})...`);
});

client.on('reconnect:success', () => {
  console.log('Reconnected!');
});

client.on('reconnect:failed', () => {
  console.log('All reconnection attempts failed');
});

// Disable auto-reconnection
client.setReconnectEnabled(false);

// Manual reconnection
await client.reconnect();
```

### Batch Operations

Combine multiple edits into a single atomic operation.

```javascript
// Method 1: Manual start/end
client.startBatch();
client.insert(0, 'Hello ');
client.insert(6, 'World');
client.delete(11, 1);
const combinedOp = client.endBatch(); // All edits sent as one operation

// Method 2: Using batch() wrapper
client.batch(() => {
  client.setLine(0, '# Title');
  client.setLine(1, '');
  client.setLine(2, 'Content here');
});

// Cancel a batch
client.startBatch();
client.insert(0, 'test');
client.cancelBatch(); // Discards without applying
```

### Undo/Redo

Track edit history with automatic grouping of rapid edits.

```javascript
// Check availability
if (client.canUndo()) {
  client.undo();
}

if (client.canRedo()) {
  client.redo();
}

// Listen to undo/redo events
client.on('undo', (entry) => {
  console.log('Undid operation');
});

client.on('redo', (entry) => {
  console.log('Redid operation');
});

// Clear history
client.clearHistory();

// Check stack sizes
console.log(`Undo: ${client.getUndoStackSize()}, Redo: ${client.getRedoStackSize()}`);
```

### Diff-Based Updates

Use `updateContent()` for efficient updates that compute minimal changes.

```javascript
// Instead of replacing entire document:
client.setContent(newContent); // Sends delete-all + insert-all

// Use diff-based update:
client.updateContent(newContent); // Computes and sends only the diff

// This is especially efficient for small changes to large documents
const doc = client.getDocument();
const modified = doc.replace('old text', 'new text');
client.updateContent(modified); // Only sends the changed portion
```

### `TextOperation`

Low-level class for building document transformations.

```javascript
import { TextOperation } from 'hedgesync';

const doc = client.getDocument();
const op = new TextOperation();

// Build an operation:
// 1. Keep first 10 characters unchanged
// 2. Delete the next 5 characters
// 3. Insert "hello"
// 4. Keep the rest of the document
op.retain(10)
  .delete(5)
  .insert('hello')
  .retain(doc.length - 15);

client.applyOperation(op);
```

#### Methods

| Method | Description |
|--------|-------------|
| `retain(n)` | Skip over n characters |
| `insert(str)` | Insert a string at current position |
| `delete(n)` | Delete n characters |
| `apply(str)` | Apply operation to a string, returns new string |
| `compose(op)` | Compose with another operation |
| `toJSON()` | Convert to JSON array |
| `toString()` | Human-readable representation |

#### Static Methods

| Method | Description |
|--------|-------------|
| `TextOperation.fromJSON(arr)` | Create from JSON array |
| `TextOperation.transform(op1, op2)` | Transform concurrent operations |

### `PandocTransformer`

Transform documents using Pandoc's AST (Abstract Syntax Tree). Requires `pandoc` to be installed.

```javascript
import { HedgeDocClient, PandocTransformer } from 'hedgesync';

const pandoc = new PandocTransformer();
const client = new HedgeDocClient(serverUrl);
await client.connect(noteId);

// Transform document using AST manipulation
const result = await pandoc.transform(client.getDocument(), (ast) => {
  pandoc.walkAST(ast, (el) => {
    if (el.t === 'Header') {
      el.c[0] = Math.min(el.c[0] + 1, 6); // Demote headers
    }
  });
  return ast;
});

// Extract specific elements
const ast = await pandoc.markdownToAST(doc);
const links = pandoc.filterByType(ast, 'Link');
const images = pandoc.filterByType(ast, 'Image');

// Apply transformation directly to client
await pandoc.applyToClient(client, (ast) => {
  // Your transformation
  return ast;
});
```

#### Methods

| Method | Description |
|--------|-------------|
| `transform(markdown, transformFn)` | Transform markdown via AST |
| `markdownToAST(markdown)` | Convert markdown to Pandoc AST |
| `astToMarkdown(ast)` | Convert AST back to markdown |
| `walkAST(ast, callback)` | Walk all elements in AST |
| `filterByType(ast, type)` | Get all elements of a type |
| `replaceText(ast, search, replace)` | Replace text in Str elements |
| `applyToClient(client, transformFn)` | Transform and apply to client |
| `convert(text, from, to)` | Convert between formats |

### `MacroEngine`

Auto-expand triggers as you type. Listens for document changes and replaces patterns.

```javascript
import { HedgeDocClient, MacroEngine } from 'hedgesync';

const client = new HedgeDocClient(serverUrl);
await client.connect(noteId);

const macros = new MacroEngine(client);

// Simple text triggers
macros.addTextMacro('::date', () => new Date().toISOString().split('T')[0]);
macros.addTextMacro('::sig', 'Signed by Bot');

// Regex-based macros
macros.addRegexMacro('uppercase', /UPPER\(([^)]+)\)/g, (match, text) => {
  return text.toUpperCase();
});

// Template macros ${variable}
macros.addTemplateMacro('vars', '${', '}', (name) => {
  const vars = { user: 'Alice', project: 'Demo' };
  return vars[name] || `[unknown: ${name}]`;
});

// Built-in helpers
const { dateMacro, uuidMacro, counterMacro } = MacroEngine.builtins;
macros.addTextMacro(...Object.values(dateMacro('::now', 'locale')));
macros.addTextMacro(...Object.values(uuidMacro('::uuid')));

// Start auto-expansion
macros.start();

// Manual expansion
await macros.expand();

// Stop listening
macros.stop();
```

#### Built-in Macro Helpers

```javascript
// Date/time macros
MacroEngine.builtins.dateMacro('::date', 'iso')     // 2024-01-15T10:30:00.000Z
MacroEngine.builtins.dateMacro('::date', 'locale')  // 1/15/2024, 10:30:00 AM
MacroEngine.builtins.dateMacro('::date', 'isoDate') // 2024-01-15

// UUID macro
MacroEngine.builtins.uuidMacro('::uuid')  // 550e8400-e29b-41d4-...

// Counter macro
MacroEngine.builtins.counterMacro('::n', 1)  // 1, 2, 3, ...

// Snippet macro
MacroEngine.builtins.snippetMacro('::todo', '- [ ] ')
```

### CLI Macro Command

The `macro` command provides command-line access to the macro system:

```bash
# Text macro: replace literal text
hedgesync macro <url> --text '::date::=$(date +%Y-%m-%d)'
hedgesync macro <url> --text '::sig::=Signed by Bot'

# Multiple macros can be specified at once
hedgesync macro <url> --text '::a::=AAA' --text '::b::=BBB' --text '::c::=CCC'

# Regex macro: replace patterns
hedgesync macro <url> --regex '/TODO/gi=DONE'
hedgesync macro <url> --regex '/\bfoo\b/gi=bar'

# Built-in macros
hedgesync macro <url> --built-in       # Enable all built-in macros

# Config file with multiple macros
hedgesync macro <url> --config macros.json

# Watch mode: continuously apply macros
hedgesync macro <url> --built-in --watch

# Mix and match different macro types
hedgesync macro <url> --text '::sig::=Bot' --exec '/::date::/gi:date +%F' --built-in
```

#### Exec Macros (Shell Command Execution)

Execute shell commands when patterns match, with regex capture groups as arguments:

```bash
# Format: --exec '/pattern/flags:command'
# Placeholders: {0} = full match, {1} = first capture, {2} = second capture, etc.

# Calculator: ::calc 2+2:: → 4
hedgesync macro <url> --exec '/::calc\s+(.+?)::/gi:echo {1} | bc -l'

# Echo: ::echo hello world:: → hello world
hedgesync macro <url> --exec '/::echo\s+(.+?)::/gi:echo {1}'

# System info: ::uptime:: → up 2 days, 3 hours
hedgesync macro <url> --exec '/::uptime::/gi:uptime -p'

# Multiple exec macros
hedgesync macro <url> \
  --exec '/::calc\s+(.+?)::/gi:echo {1} | bc -l' \
  --exec '/::date::/gi:date +%F' \
  --exec '/::uptime::/gi:uptime -p'

# Date formatting: ::date YYYY-MM-DD:: → formatted date
hedgesync macro <url> --exec '/::date\s+(.+?)::/gi:date +{1}'

# External API: ::weather London:: → weather data
hedgesync macro <url> --exec '/::weather\s+(.+?)::/gi:curl -s wttr.in/{1}?format=3'

# Combine with watch mode for live updates
hedgesync macro <url> --exec '/::uptime::/gi:uptime -p' --watch
```

#### Streaming Output

Use `--stream` to stream command output live into the document. This is useful for long-running commands where you want to see output as it's generated:

```bash
# Stream output line-by-line into the document
hedgesync macro <url> --exec '/::slow::/gi:for i in 1 2 3 4 5; do echo "Step $i"; sleep 1; done' --stream

# Stream a log file
hedgesync macro <url> --exec '/::tail-log::/gi:tail -f /var/log/syslog' --stream --watch

# Stream a build process
hedgesync macro <url> --exec '/::build::/gi:make 2>&1' --stream
```

With streaming enabled:
1. The matched pattern is immediately removed from the document
2. Command output is inserted into the document as it's generated (line-buffered by default)
3. Multiple streaming commands can run concurrently
4. The CLI waits for all streams to complete before exiting

**Security Note:** Exec macros execute arbitrary shell commands. Only use on documents you trust, and be careful with user-provided content.

#### Macro Config File Format

```json
{
  "macros": [
    {
      "type": "text",
      "trigger": "::sig",
      "replacement": "— Signed by Bot"
    },
    {
      "type": "regex",
      "pattern": "/TODO/gi",
      "replacement": "DONE"
    },
    {
      "type": "exec",
      "pattern": "/::calc\\s+(.+?)::/gi",
      "command": "echo {1} | bc -l"
    },
    {
      "type": "exec",
      "pattern": "/::slow-cmd::/gi",
      "command": "for i in 1 2 3; do echo \"Step $i\"; sleep 1; done",
      "streaming": true,
      "lineBuffered": true
    },
    {
      "type": "builtin",
      "name": "date"
    }
  ]
}
```

Config options for exec macros:
- `streaming`: Set to `true` to enable live streaming output (default: `false`)
- `lineBuffered`: When streaming, buffer by line instead of character (default: `true`)

See `examples/macros.json` for more examples.

## Permissions

HedgeDoc documents have different permission levels that affect who can edit:

| Permission | Anonymous Users | Logged-in Users | Owner |
|------------|-----------------|-----------------|-------|
| `freely` | ✅ Can edit | ✅ Can edit | ✅ Can edit |
| `editable` | ❌ Read-only | ✅ Can edit | ✅ Can edit |
| `limited` | ❌ Read-only | ✅ Can edit | ✅ Can edit |
| `locked` | ❌ Read-only | ❌ Read-only | ✅ Can edit |
| `private` | ❌ No access | ❌ No access | ✅ Can edit |
| `protected` | ❌ Read-only | ❌ Read-only | ✅ Can edit |

The library automatically checks permissions and throws descriptive errors:

```javascript
try {
  client.insert(0, 'Hello');
} catch (error) {
  // "This note requires login to edit (permission: editable). 
  //  Please provide an authenticated session cookie."
}
```

### Authenticated Access

For documents that require login, pass your session cookie:

```javascript
const client = new HedgeDocClient({
  serverUrl: 'https://hedgedoc.example.com',
  noteId: 'private-note',
  cookie: 'connect.sid=s%3Ayour-session-cookie-here'
});
```

You can get the session cookie from your browser's developer tools after logging in.

## How It Works

1. **Session Cookie**: The library first makes an HTTP request to get a session cookie (HedgeDoc requires this even for anonymous users).

2. **Socket.IO**: Connects to HedgeDoc's real-time WebSocket endpoint using Socket.IO.

3. **Document Sync**: Receives the initial document state and revision number.

4. **Operational Transformation**: When you make edits, they're sent as OT operations. When other users edit, their operations are transformed against yours to ensure consistency.

5. **Conflict Resolution**: The OT algorithm ensures all clients converge to the same document state, even with concurrent edits.

## Compatibility

- **HedgeDoc**: Tested with HedgeDoc 1.x (uses OT-based real-time sync)
- **Runtime**: Bun (recommended) or Node.js 18+
- **HedgeDoc 2.x**: Not compatible (uses Y.js instead of OT)

## License

AGPL-3.0-only (same as HedgeDoc)

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.
