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

## Compatibility

- **HedgeDoc 1.x** (versions **1.10.4** and later): Full support
- **Subpath deployments**: Supports deployments at subpaths (e.g., `https://example.com/hedgedoc/note-id`)

> **Note**: HedgeDoc versions before 1.10.4 use Socket.IO v2, which is not supported due to protocol incompatibilities. HedgeDoc 2.x is also not supported as it uses a different real-time backend (Y.js instead of OT).

## Installation

### As a Library

```bash
# npm
npm install hedgesync

# bun
bun add hedgesync

# pnpm
pnpm add hedgesync
```

**Deno**: Copy the `deno.json` from this package to your project, or add to your existing import map:

```json
{
  "imports": {
    "socket.io-client": "npm:socket.io-client@^4.7.0"
  }
}
```

Then import directly:

```typescript
import { HedgeDocClient } from "npm:hedgesync";
```

### As a CLI Tool

```bash
# npm (global)
npm install -g hedgesync

# bun (global)
bun install -g hedgesync

# Then use directly:
hedgesync get https://md.example.com/abc123
```

### Runtime Compatibility

| Runtime | Library | CLI |
|---------|---------|-----|
| Node.js 18+ | ✅ | ✅ |
| Bun | ✅ | ✅ |
| Deno | ✅ (with import map) | ✅ |
| Obsidian plugin | ✅ via `hedgesync/obsidian` | ❌ |

### Building Standalone Executables

You can compile the CLI into a standalone executable that doesn't require any runtime:

```bash
# Clone the repo first
git clone https://github.com/tionis/hedgesync.git
cd hedgesync
bun install

# Build for current platform
bun run build:cli

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

# Authentication / Login
hedgesync login email https://md.example.com -u user@example.com -p password
hedgesync login ldap https://md.example.com -u username -p password
hedgesync login oidc https://md.example.com                    # Opens browser
hedgesync login device-code-oidc https://md.example.com \      # CLI-friendly OIDC
  --client-id my-client \
  --device-url https://sso.example.com/application/o/device/ \
  --token-url https://sso.example.com/application/o/token/
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

If a document requires authentication, you need a session cookie. There are multiple ways to obtain one:

#### Method 1: Manual Cookie (Browser)

Copy your session cookie from your browser after logging in:

```bash
# Via command-line option
hedgesync get https://md.example.com/abc123 -c 'connect.sid=...'

# Via environment variable
export HEDGEDOC_COOKIE='connect.sid=...'
hedgesync get https://md.example.com/abc123

# The 'connect.sid=' prefix is optional - it will be added automatically
hedgesync get https://md.example.com/abc123 -c 's%3Axyz...'
```

#### Method 2: Email/Password Login

For HedgeDoc instances with email authentication enabled:

```bash
hedgesync login email https://md.example.com -u user@example.com -p password
# Outputs: connect.sid=s%3A...

# Store and use the cookie
export HEDGEDOC_COOKIE=$(hedgesync login email https://md.example.com -u user@example.com -p password)
```

#### Method 3: LDAP Login

For HedgeDoc instances with LDAP authentication:

```bash
hedgesync login ldap https://md.example.com -u username -p password
```

#### Method 4: OIDC Login (Interactive)

Opens a browser for SSO authentication. This implements the full OAuth2 Authorization Code flow:

```bash
hedgesync login oidc https://md.example.com
# Opens browser, user authenticates, returns cookie automatically
```

**How it works:**
1. Starts a local server to receive the OAuth callback
2. Opens the HedgeDoc OAuth URL in your browser
3. After you authenticate, the IdP redirects to the local server
4. The CLI forwards the authorization code to HedgeDoc
5. Returns the authenticated session cookie

**Note:** Your identity provider must allow `http://127.0.0.1:*/callback` as a redirect URI. Most IdPs (including Authentik, Keycloak, etc.) support localhost redirects for CLI/development use cases.

#### Method 5: Device Code + OIDC (CLI-friendly)

**Recommended for automation and scripts.** This combines device code flow (for user authentication without needing a local browser) with OIDC flow (for HedgeDoc session creation).

```bash
hedgesync login device-code-oidc https://md.example.com \
  --client-id my-cli-app \
  --device-url https://sso.example.com/application/o/device/ \
  --token-url https://sso.example.com/application/o/token/

# Displays something like:
# Please visit: https://sso.example.com/device
# And enter code: ABCD-EFGH
# Waiting for authorization...
# (After user authorizes, browser opens to complete OAuth flow)
```

**How it works:**
1. Starts device code flow - displays a URL and code for user to authorize
2. User visits the URL on any device and enters the code
3. Once authorized, automatically opens browser to complete HedgeDoc OAuth flow
4. Returns the authenticated session cookie

**Requirements:**
- Your IdP must support device code flow (Authentik, Azure AD, Google, etc.)
- The same browser session must be used for both steps (don't close browser after entering code)
- HedgeDoc must have OAuth2/OIDC configured

#### Request Timeouts

All authentication methods support configurable timeouts (default: 30 seconds):

```bash
# Use a longer timeout for slow networks
hedgesync login ldap https://md.example.com -u user -p pass --timeout 60000

# Device code flow has a longer default (5 minutes) for user authorization
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

### SSO Provider Setup: Authentik

This section explains how to configure [Authentik](https://goauthentik.io/) for HedgeDoc access.

#### Option A: Interactive OIDC Login (Recommended)

Best for CLI use when you can open a browser. This uses the standard OAuth2 Authorization Code flow:

**1. Add localhost to allowed redirect URIs:**

In your existing HedgeDoc OAuth2 Provider in Authentik:
- Go to **Applications → Providers → Your HedgeDoc Provider**
- Under **Redirect URIs/Origins (RegEx)**, add: `http://127\.0\.0\.1:[0-9]+/callback`
- Save

**2. Use with hedgesync:**

```bash
hedgesync login oidc https://md.example.com
# Browser opens, you authenticate, cookie is returned automatically
```

#### Option B: Device Code + OIDC (CLI-friendly)

Best for CLI tools where you need to authenticate but can't easily open a browser locally (e.g., SSH sessions, headless servers).

**1. Create an OAuth2 Provider for CLI use:**

- Go to **Applications → Providers → Create**
- Select **OAuth2/OpenID Provider**
- Name: `hedgedoc-cli`
- Authorization flow: Select an appropriate flow (e.g., `default-provider-authorization-implicit-consent`)
- Client type: **Public** (no client secret needed)
- Client ID: Auto-generated (copy this)
- Redirect URIs: Add `http://127\.0\.0\.1:[0-9]+/callback`
- Under **Advanced protocol settings**:
  - Scopes: `openid profile email`
  - Enable **Device code flow**

**2. Create an Application:**

- Go to **Applications → Applications → Create**
- Name: `HedgeDoc CLI`
- Slug: `hedgedoc-cli`
- Provider: Select your `hedgedoc-cli` provider

**3. Use with hedgesync:**

```bash
hedgesync login device-code-oidc https://md.example.com \
  --client-id <your-client-id> \
  --device-url https://authentik.example.com/application/o/device/ \
  --token-url https://authentik.example.com/application/o/token/

# Output:
# Please visit: https://authentik.example.com/device
# And enter code: ABCD-1234
# Waiting for authorization...
# (Browser opens automatically to complete OAuth flow)
```

**How it works:**
1. You're shown a URL and code to enter on any device
2. You authorize the CLI on that device (can be your phone, another computer, etc.)
3. The CLI then opens a browser to complete the HedgeDoc OAuth flow
4. Since you're already logged into Authentik, it auto-approves and creates the session

**Note:** Don't close the browser after entering the device code - the same browser session is needed to complete the OAuth flow.

#### Authentik URLs Reference

| Endpoint | URL Pattern |
|----------|-------------|
| Token URL | `https://<authentik>/application/o/token/` |
| Device Authorization | `https://<authentik>/application/o/device/` |
| Authorization URL | `https://<authentik>/application/o/authorize/` |
| OIDC Discovery | `https://<authentik>/application/o/<app-slug>/.well-known/openid-configuration` |

#### HedgeDoc Configuration

Ensure your HedgeDoc instance is configured to accept OAuth2/OIDC authentication. In `config.json`:

```json
{
  "oauth2": {
    "authorizationURL": "https://authentik.example.com/application/o/authorize/",
    "tokenURL": "https://authentik.example.com/application/o/token/",
    "clientID": "<your-hedgedoc-app-client-id>",
    "clientSecret": "<your-hedgedoc-app-client-secret>"
  }
}
```

See [HedgeDoc OAuth2 documentation](https://docs.hedgedoc.org/configuration/#oauth2-login) for complete configuration options.

## Library Quick Start

```javascript
import { HedgeDocClient } from 'hedgesync';

const client = new HedgeDocClient({
  serverUrl: 'https://hedgedoc.example.com',
  noteId: 'my-note-id',
  // Optional: session cookie for authenticated access
  // cookie: 'connect.sid=s%3A...'
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

### Obsidian Plugin Usage

Use the Obsidian-safe entrypoint:

```typescript
import { HedgeDocClient } from 'hedgesync/obsidian';
```

`hedgesync/obsidian` includes the runtime-safe subset:
- `HedgeDocClient`
- `HedgeDocAPI`
- OT types (`TextOperation`, `OTClient`)
- Cookie helpers (`normalizeCookie`, `extractSessionId`)

It intentionally excludes Node-only modules:
- auth flows that start a local HTTP callback server
- macro execution that spawns shell commands
- pandoc transformers that spawn external processes

Browser-style runtimes (including Obsidian WebView environments) cannot attach custom Socket.IO headers. Use standard cookie-based auth with CORS credentials enabled on your HedgeDoc server.

Both entrypoints (`hedgesync` and `hedgesync/obsidian`) support:
- `runtime: 'auto' | 'node' | 'browser'` on `HedgeDocClient`
- `request` transport injection on `HedgeDocClient` and `HedgeDocAPI`
- `socketTransports` on `HedgeDocClient` for Socket.IO transport selection

This allows Obsidian plugins to use a custom HTTP layer (for example `requestUrl`) instead of direct `fetch`.
Use `socketTransports: ['websocket']` in Obsidian or proxy environments where XHR polling is unavailable or unreliable.

### Authentication

For documents requiring login, obtain a session cookie using the auth helpers:

```javascript
import { loginWithEmail, loginWithLDAP, HedgeDocClient } from 'hedgesync';

// Email/password authentication
const { cookie } = await loginWithEmail({
  serverUrl: 'https://hedgedoc.example.com',
  email: 'user@example.com',
  password: 'password'
});

// LDAP authentication
const { cookie } = await loginWithLDAP({
  serverUrl: 'https://hedgedoc.example.com',
  username: 'user',
  password: 'password'
});

// Use the cookie
const client = new HedgeDocClient({
  serverUrl: 'https://hedgedoc.example.com',
  noteId: 'private-note',
  cookie
});
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
import { HedgeDocClient, defaultHedgeSyncRequest } from 'hedgesync';

const client = new HedgeDocClient({
  serverUrl: 'https://hedgedoc.example.com',  // Required
  noteId: 'my-note-id',                        // Required
  cookie: 'connect.sid=...',                   // Optional: session cookie for auth
  runtime: 'auto',                             // Optional: 'auto' | 'node' | 'browser'
  request: async (req) => {                    // Optional: custom HTTP transport
    return defaultHedgeSyncRequest(req);
  },
  socketTransports: ['polling', 'websocket'],  // Optional: Socket.IO transports
  connectTimeout: 15000,                       // Optional: how long connect() waits for the document (ms)
  operationTimeout: 10000,                     // Optional: default flush() timeout (ms)
  
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
| `connect()` | Connect to the server. Resolves once the document and note metadata (permissions) have loaded. |
| `flush(timeoutMs?)` | Resolves when the server has acknowledged every local edit; rejects on timeout (HedgeDoc silently drops edits without write access). |
| `isSynchronized()` | `true` when no local edits are waiting for acknowledgement. |
| `disconnect()` | Disconnect from the server. Call `flush()` first, or unacknowledged edits are lost. |
| `reconnect()` | Reconnect; pending local edits are kept and re-sent. |
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
| `replaceRegex(pattern, replacement)` | Replace all matches (`String.prototype.replace` semantics), sent as one operation. Returns the count. |
| `replaceFirst(pattern, replacement)` | Replace the first match. |
| `replaceLines(pattern, replacement)` | Replace matching lines, sent as one operation. |
| `getLine(lineNumber)` | Get content of a specific line (0-indexed). |
| `getLines()` | Get all lines as an array. |
| `setLine(lineNumber, content)` | Replace a specific line. |
| `insertLine(lineNumber, content)` | Insert a new line at position. |
| `deleteLine(lineNumber)` | Delete a specific line. |
| `batch(fn)` | Run synchronous edits and send them as one operation (rolled back if `fn` throws). |
| `undo()` | Undo the last local edit, keeping remote edits made since. |
| `redo()` | Redo the last undone edit. |
| `canUndo()` / `canRedo()` | Check if undo/redo is available. |
| `clearHistory()` | Clear undo/redo history. |
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
client.on('change', ({ type, operation, clientId, user }) => { /* Local/remote change */ });
client.on('synchronized', () => { /* All local edits acknowledged */ });
client.on('resync', (outcome) => {
  // A fresh document arrived after a reconnect. outcome.kind is one of:
  // 'reset' (nothing pending), 'resent', 'acked', 'catchup' (missed ops verified
  // and pending edits transformed), 'rebased' (server history was reset; pending
  // edits rebased via diff), 'discarded' (server forced a reset; outcome.pending lost)
});
client.on('ot-error', ({ type, error }) => { /* A server message could not be applied; a resync follows */ });
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
client.on('undo', ({ operation }) => { /* Operation was undone */ });
client.on('redo', ({ operation }) => { /* Operation was redone */ });
```

### Waiting for Acknowledgement

Edits are applied locally at once and sent through the OT client, which keeps
one operation in flight and composes later edits into a buffer. To know an
edit actually landed, wait for the server's acknowledgement:

```javascript
client.insert(0, 'Hello ');
await client.flush();          // rejects after operationTimeout if not acknowledged
client.disconnect();
```

HedgeDoc ignores edits from sessions without write access without replying,
so a `flush()` timeout usually means the edit was rejected.

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

Combine multiple edits into a single operation. Inside the callback the
document reflects each edit as it is made, so later edits can build on
earlier ones. The callback must be synchronous; if it throws, all of its
edits are rolled back.

```javascript
client.batch(() => {
  client.setLine(0, '# Title');
  client.insert(client.getDocument().length, '\nFooter');
});
await client.flush();
```

### Undo/Redo

Track local edit history with automatic grouping of rapid edits. Undo
inverts your own edits only: history entries are transformed against remote
edits, so undoing never removes what collaborators wrote in the meantime.

```javascript
// Check availability
if (client.canUndo()) {
  client.undo();
}

if (client.canRedo()) {
  client.redo();
}

// Listen to undo/redo events
client.on('undo', ({ operation }) => {
  console.log('Undid operation');
});

client.on('redo', ({ operation }) => {
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

Auto-expand triggers as collaborators type.

- **What triggers a macro:** in watch mode, only text touched by a remote edit
  can trigger one. If filters are set, the edit must come from an allowed user.
  The engine's own edits never trigger macros, so macro output cannot loop.
- **Where the result goes:** each match is tracked through later edits, and the
  result applies only if the original text is still there.

```javascript
import { HedgeDocClient, MacroEngine, renderShellTemplate, runShell } from 'hedgesync';

const client = new HedgeDocClient({ serverUrl, noteId, cookie });
await client.connect();

const macros = new MacroEngine(client, {
  allowedUserIds: ['<hedgedoc-account-id>'], // optional: only these accounts trigger macros
});

// Simple text triggers
macros.addTextMacro('::date::', () => new Date().toISOString().split('T')[0]);
macros.addTextMacro('::sig::', 'Signed by Bot');

// Regex macros: handler gets String.replace-style arguments
// (match, ...groups, index, document); return null to leave the match alone
macros.addRegexMacro('uppercase', /UPPER\(([^)]+)\)/g, (match, text) => text.toUpperCase());

// Template macros: {{variable}}
macros.addTemplateMacro('vars', '{{', '}}', (name) => ({ user: 'Alice' })[name.trim()] ?? null);

// Running commands: never splice note text into a command string.
// renderShellTemplate passes placeholder values via environment variables.
macros.addRegexMacro('calc', /::calc\s+(.+?)::/g, async (match, expr) => {
  const result = await runShell(renderShellTemplate('echo {1} | bc -l', { '1': expr }));
  return result.code === 0 ? result.stdout.trim() : null;
});

// Streaming macros: stdout streams into the document as the command runs
macros.addStreamingExecMacro('ask', /::ask\s+(.+?)::/g,
  (match, question) => renderShellTemplate('llm {1}', { '1': question }),
  { trackState: true, timeoutMs: 120_000 } // marks the trigger → / ✓ / ✗; never reruns it
);

// Block macros: process content between ::BEGIN:name:: and ::END:name:: lines
macros.addBlockMacro('sort', (content, context) => content.split('\n').sort().join('\n'));

macros.start();          // watch mode
await macros.expand();   // or: expand everything in the current document once
await macros.waitForStreams();
macros.stop();           // also kills running commands
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

#### Macro Command Options

| Option | Description |
|--------|-------------|
| `--text 'trigger=replacement'` | Simple text replacement macro |
| `--regex '/pattern/flags=replacement'` | Regex pattern replacement macro |
| `--exec '/pattern/flags:command'` | Execute shell command on pattern match |
| `--block 'name:command'` | Block macro for `::BEGIN:name::` ... `::END:name::` |
| `--built-in` | Enable built-in macros (see below) |
| `--config <file>` | Load macros from JSON config file |
| `--watch` | Run continuously; only text touched by others' edits triggers macros |
| `--stream` | Stream command output live into document |
| `--track-state` | Keep the trigger and mark it `→` running / `✓` done / `✗` failed; marked triggers never rerun |
| `--timeout <s>` | Kill exec/block commands after this many seconds |
| `--allow-user <id>` | Only edits by this HedgeDoc account id trigger macros (repeatable; find ids with `hedgesync me`) |
| `--user-filter <regex>` | Only edits by users whose display name matches (spoofable; prefer `--allow-user`) |
| `--section-heading`, `--section-lines`, `--section-regex` | Limit macros to part of the note |

#### Built-in Macros (`--built-in`)

When you use `--built-in`, the following text macros are automatically registered:

| Trigger | Replacement | Example Output |
|---------|-------------|----------------|
| `::date::` | Current date (ISO format) | `2024-12-16` |
| `::time::` | Current time (24h format) | `14:30:45` |
| `::datetime::` | Full ISO 8601 timestamp | `2024-12-16T14:30:45.123Z` |
| `::ts::` | Unix timestamp (milliseconds) | `1734358245123` |

**Usage examples:**

```bash
# Enable built-in macros and watch for changes
hedgesync macro https://md.example.com/abc123 --built-in --watch

# Type "::date::" in your document, it becomes "2024-12-16"
# Type "::datetime::" becomes "2024-12-16T14:30:45.123Z"
```

**Note:** Built-in macros can be combined with custom macros:

```bash
hedgesync macro <url> --built-in --text '::sig::=— Signed by Bot' --watch
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

#### How Placeholders Reach the Shell

Commands run via `sh -c`, so templates can use pipes, redirects and so on. Note
content never becomes part of the command text, though. Each placeholder is
replaced by a reference to an environment variable (`{1}` becomes `"${HS_1}"`,
`{DOC}` becomes `"${HS_DOC}"`), and the value is passed in the environment. The
shell expands a variable exactly once and never re-parses the result, so text
like `$(rm -rf ~)` in the note arrives as a literal argument.

You can write a placeholder bare, inside double quotes or inside single quotes;
either way it expands to exactly one argument. If a command exits with a
non-zero status, the trigger is left unchanged and stderr is logged.

**Security note:** anyone who can edit the note can trigger your macros and
choose their input. Shell injection is not possible, but the command still acts
on that input: `cat {1}` lets collaborators read any file you can read, and
`bash -c {1}` runs whatever they write. Restrict who can trigger macros with
`--allow-user`, and only template commands that are safe for any input.

#### State Tracking

Use `--track-state` with `--stream` to keep the trigger visible and mark its status:

```bash
hedgesync macro <url> --exec '/::ask\s+(.+?)::/gi:llm {1}' --stream --track-state --watch
```

```text
::ask What is 2+2?::      typed by a collaborator
::ask What is 2+2?::→     command running; output streams in on the next lines
::ask What is 2+2?::✓     command finished (✗ if it failed)
2+2 equals 4.
```

A marked trigger never runs again, even if it is edited later. Without
`--track-state`, the trigger is deleted when the command starts.

#### Document Context Placeholders

Access full document context in your commands using special placeholders:

```bash
# {DOC} = entire document content
# {BEFORE} = text before the match
# {AFTER} = text after the match

# Summarize the entire document with an LLM
hedgesync macro <url> --exec '/::summarize::/gi:llm --context "{DOC}" "summarize this document"' --stream

# Generate a conclusion based on preceding content
hedgesync macro <url> --exec '/::conclude::/gi:llm --context "{BEFORE}" "write a conclusion"' --stream

# Answer a question using document context
hedgesync macro <url> --exec '/::answer\s+(.+?)::/gi:llm --doc "{DOC}" --question "{1}"' --stream
```

This is particularly useful for LLM integrations where the model needs context beyond just the trigger text.

#### Block Macros

Process multi-line content between `::BEGIN:name::` and `::END:name::` markers:

```bash
# Sort lines between markers
hedgesync macro <url> --block 'sort:sort' --watch

# Convert to uppercase  
hedgesync macro <url> --block 'upper:tr a-z A-Z' --watch

# Strike through each line
hedgesync macro <url> --block 'strike:sed "s/.*$/~~&~~/"' --watch

# Number lines
hedgesync macro <url> --block 'number:nl -ba' --watch

# Multiple block handlers
hedgesync macro <url> --block 'sort:sort' --block 'upper:tr a-z A-Z' --watch
```

Example document:
```markdown
Shopping list:
::BEGIN:sort::
bananas
apples
milk
eggs
::END:sort::
```

After macro runs:
```markdown
Shopping list:
apples
bananas
eggs
milk
```

Block macros:
- Content between markers is piped to stdin of the command
- Command output replaces the entire block (including markers); if the command fails, the block is left unchanged
- Placeholders `{CONTENT}`, `{DOC}`, `{BEFORE}`, `{AFTER}` are also available
- Great for transformations that need multi-line input
- Can be combined with watch mode for live processing

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
      "type": "exec",
      "pattern": "/::ask\\s+(.+?)::/gi",
      "command": "llm {1}",
      "streaming": true,
      "trackState": true
    },
    {
      "type": "block",
      "name": "sort",
      "command": "sort"
    },
    {
      "type": "block",
      "name": "upper",
      "command": "tr a-z A-Z"
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
- `trackState`: Mark triggers running/done/failed; marked triggers never rerun (default: `false`)
- Placeholders `{0}`, `{1}`…, `{DOC}`, `{BEFORE}`, `{AFTER}` are always available

Config options for builtin macros:
- `name`: one of `date`, `time`, `datetime`, `ts`

The older `{ "text": { "trigger": "replacement" }, "regex": { "pattern": "replacement" } }`
format is still accepted. A replacement starting with `$` runs the rest as a
command; regex commands get `MATCH` and `GROUP1`… in their environment.

Config options for block macros:
- `name`: The block name that appears in `::BEGIN:name::` markers
- `command`: Shell command to process the block content (receives content via stdin)

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

- **HedgeDoc**: Version 1.10.4 or later (uses OT-based real-time sync with Socket.IO v4)
- **Runtime**: Node.js 18+, Bun, Deno (with import map), and Obsidian plugins via `hedgesync/obsidian`
- **Node-only modules**: Auth helper flows, macro engine, and pandoc transformer are not part of the Obsidian entrypoint
- **Not supported**: HedgeDoc < 1.10.4 (Socket.IO v2) or HedgeDoc 2.x (uses Y.js instead of OT)

## License

AGPL-3.0-only (same as HedgeDoc)

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.
