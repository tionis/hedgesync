# hedgesync

A library and CLI to programmatically connect to a running [HedgeDoc](https://hedgedoc.org/) server and make live edits to documents using Operational Transformation (OT).

## Features

- 🔌 **Real-time connection** via Socket.IO
- ✏️ **Live editing** with automatic conflict resolution (OT)
- 👥 **User presence** - see who's online
- 🔒 **Permission-aware** - proper error handling for read-only documents
- 📡 **Event-driven** - react to document changes from other users
- 🍪 **Email/LDAP login** - obtains and verifies session cookies
- 🔍 **Regex operations** - search and replace with patterns
- 📝 **Line operations** - manipulate documents by line number
- 🔄 **Pandoc integration** - AST-based transformations
- 🤖 **Macro system** - auto-expand triggers as you type
- 🖥️ **Note terminal** - a shared shell session inside a note
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

# or a standalone binary from the releases page (no runtime needed)
curl -fL https://github.com/tionis/hedgesync/releases/latest/download/hedgesync-linux-x64 \
  -o ~/.local/bin/hedgesync && chmod +x ~/.local/bin/hedgesync

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

Note commands take a note URL; the forms HedgeDoc shows in the browser all
work, including sub-path deployments (`https://example.com/hedgedoc/abc123`),
published and slide links (`/s/<id>`, `/abc123/publish`, `/abc123/slide`).

```bash
# Read
hedgesync get https://md.example.com/abc123 > note.md     # exact content, no added newline
hedgesync get https://md.example.com/abc123 --authors      # coloured by author
hedgesync line https://md.example.com/abc123 0             # one line (0-based)
hedgesync info https://md.example.com/abc123               # metadata, permission, online users
hedgesync users https://md.example.com/abc123                # who else is in the note
hedgesync users https://md.example.com/abc123 --watch        # report joins and leaves live
hedgesync authors https://md.example.com/abc123 -v
hedgesync watch https://md.example.com/abc123 --ndjson

# Edit (text from an argument, -f/--file, or piped stdin)
hedgesync set https://md.example.com/abc123 -f note.md
echo "- $(date): done" | hedgesync append https://md.example.com/abc123
hedgesync prepend https://md.example.com/abc123 "New first line"
hedgesync insert https://md.example.com/abc123 10 "inserted text"
hedgesync line https://md.example.com/abc123 0 "# Title"
hedgesync replace https://md.example.com/abc123 "old text" "new text" --all   # literal
hedgesync replace https://md.example.com/abc123 '(\d+) items' '$1 things' --regex --all

# Pandoc
hedgesync transform https://md.example.com/abc123 --demote   # or --promote, --shift <n>
hedgesync transform https://md.example.com/abc123 --to html  # convert (read-only)

# Macros
hedgesync macro https://md.example.com/abc123 --text '::sig::=— Signed by Bot'
hedgesync macro https://md.example.com/abc123 --regex '/TODO/gi=DONE'
hedgesync macro https://md.example.com/abc123 --built-in --watch
hedgesync macro https://md.example.com/abc123 --exec '/::calc (.+?)::/gi:echo {1} | bc -l' --watch
hedgesync macro https://md.example.com/abc123 --config macros.json --watch

# Mirror one note into another (Ctrl+C to stop)
hedgesync mirror https://md.example.com/source https://md.example.com/target
hedgesync mirror https://md.example.com/a https://md.example.com/b --bidirectional
hedgesync mirror https://md.example.com/src https://md.example.com/dst --demote

# Settings (HedgeDoc keeps them in the note's YAML front matter)
hedgesync meta https://md.example.com/abc123                    # title, tags, type, ...
hedgesync meta https://md.example.com/abc123 tags work planning
hedgesync meta https://md.example.com/abc123 --add-tag done --remove-tag todo
hedgesync meta https://md.example.com/abc123 type slide

# Owner actions
hedgesync permission https://md.example.com/abc123              # show who can view/edit
hedgesync permission https://md.example.com/abc123 private      # change it (owner only)
hedgesync delete https://md.example.com/abc123                  # asks you to type the id

# Run your own script with a connected client (see `hedgesync help exec`)
hedgesync exec stamp.ts https://md.example.com/abc123 -- extra args

# Shared shell: type commands into a ```terminal block in the note (see below)
hedgesync terminal https://md.example.com/ops --cwd ~/project --timeout 300

# Your notes (HedgeDoc 1 can only list your history: notes you have opened)
hedgesync ls https://md.example.com                         # pinned first, then most recent
hedgesync ls https://md.example.com -t project -s plan -n 10
hedgesync search https://md.example.com TODO -i             # grep through their text
hedgesync search https://md.example.com 'v\d+\.\d+' -r -l

# HTTP API (no realtime session)
hedgesync download https://md.example.com/abc123
hedgesync create https://md.example.com -f note.md -n my-alias
hedgesync create https://md.example.com -f secret.md -p private
hedgesync upload https://md.example.com diagram.png        # prints ![diagram](link)
hedgesync publish https://md.example.com/abc123            # published URL (/s/...), --slide, --all

# Revisions (~0 is the newest, ~1 the one before, or a timestamp from the list)
hedgesync revisions https://md.example.com/abc123
hedgesync revisions https://md.example.com/abc123 ~1 --diff         # what changed since
hedgesync revisions https://md.example.com/abc123 ~3 --restore      # bring it back (as a new edit)
hedgesync me https://md.example.com
hedgesync history https://md.example.com --pinned
hedgesync pin https://md.example.com/abc123
hedgesync export https://md.example.com -o notes.zip
hedgesync status https://md.example.com

# Sessions
hedgesync login https://md.example.com -u user@example.com --save   # prompts for the password
hedgesync logout https://md.example.com
```

Run `hedgesync help <command>` for every option of a command.

### Global Options

```
-c, --cookie <cookie>  Session cookie (default: HEDGEDOC_COOKIE, then a saved login)
-H, --header <header>  Extra HTTP header, "Name: value" (repeatable; also HEDGEDOC_HEADERS)
--json                 Machine-readable output; errors become {"success": false, "error": ...}
-q, --quiet            Suppress progress messages
--no-color             Disable colours (also honoured: NO_COLOR, FORCE_COLOR)
--no-reconnect         Do not reconnect dropped realtime sessions
--debug                Show stack traces for unexpected errors
```

Options may come before or after the URL, `--opt=value` works, short flags
combine (`-qA`), and `--` ends option parsing. Unknown options are errors.
Status messages go to stderr, so stdout can be piped.

### Authentication

Private, locked or protected notes need a HedgeDoc session cookie. hedgesync
uses, in order: `-c/--cookie`, the `HEDGEDOC_COOKIE` environment variable, and
a cookie saved for that server by `hedgesync login --save`.

#### From a browser (OIDC, OAuth2, GitHub, SAML, ...)

These providers are browser redirect flows, so the CLI reuses the session of
a browser you are already signed in with. Sign in to the server there, then:

```bash
hedgesync login https://md.example.com --from-browser firefox --save
hedgesync login https://md.example.com -b chromium --profile Work --save
```

Supported: `firefox`, `librewolf`, `zen`, `chrome`, `chromium`, `brave`,
`vivaldi`, `edge`. hedgesync reads a copy of the browser's cookie database
(the browser may stay open), tries every profile and Firefox container,
freshest first, unless `--profile` names one, and keeps the first cookie set
that the server's `/me` accepts. Native, Flatpak and Snap installs are
searched. Chromium-based browsers on Linux usually keep their cookie key in
the desktop keyring: install `secret-tool` (Debian/Ubuntu: `libsecret-tools`)
for GNOME Keyring, or `kwallet-query` for KDE. On macOS the Keychain asks for
permission. Chromium cookies on Windows are not supported.

HedgeDoc sessions expire after two weeks without use (by default), and any
request renews them. The imported session is the browser's own session, so
using either keeps both alive, and `hedgesync logout` only forgets the
cookie unless you pass `--end-session` (which would log the browser out too).

#### Keeping sessions alive

```bash
hedgesync sessions                  # saved sessions, their source and last check
hedgesync sessions refresh          # renew them; re-import expired browser sessions
hedgesync sessions install-timer    # do that daily (systemd user timer, Linux)
```

`refresh` calls `/me` for each saved session, which renews it. An expired
session that came from a browser is imported again from the same browser,
provided it is still logged in as the same account; password logins have to
be repeated. It exits with status 1 when a session needs attention.
`install-timer` writes `~/.config/systemd/user/hedgesync-refresh.{service,timer}`
(daily, catching up after downtime) and enables it; logs are in
`journalctl --user -u hedgesync-refresh`. On other systems, run
`hedgesync sessions refresh -q` from cron or launchd.

#### Email or LDAP login

If the server has email or LDAP accounts enabled, `hedgesync login` signs in
directly:

```bash
hedgesync login https://md.example.com -u user@example.com --save
export HEDGEDOC_COOKIE="$(hedgesync login ldap https://md.example.com -u username)"
hedgesync logout https://md.example.com   # ends the session and forgets it
```

The password is prompted for on the terminal, read from `HEDGEDOC_PASSWORD`,
or read from stdin with `--password-stdin`
(`pass show hedgedoc | hedgesync login ... --password-stdin`). It is not
accepted as a command-line argument, where other local users could see it.

HedgeDoc answers a failed login exactly like a successful one, so `login`
checks the new session against `/me` and fails on a wrong password instead
of handing back a useless cookie.

#### Saving and passing cookies

With `--save`, `login` stores the cookie for that server in
`~/.config/hedgesync/cookies.json` (mode 0600; `$XDG_CONFIG_HOME` and
`HEDGESYNC_COOKIE_FILE` are honoured) and later commands pick it up; without
it, the cookie alone is printed to stdout. Use `--json` to also get the
account id and name, and `--timeout <seconds>` for slow servers.

A cookie copied by hand from a browser's developer tools also works
(`export HEDGEDOC_COOKIE='connect.sid=s%3A...'`; a bare value without
`connect.sid=` is accepted too).

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
- `socketOptions` on `HedgeDocClient` for extra Socket.IO/engine.io settings (in Node, TLS options such as `ca`)

This allows Obsidian plugins to use a custom HTTP layer instead of direct `fetch`.
A custom `request` function must not follow redirects (`request.redirect` is
`'manual'`): note creation reads the new note's id from the redirect. Obsidian's
`requestUrl` always follows redirects, so it cannot create notes.
Use `socketTransports: ['websocket']` in Obsidian or proxy environments where XHR polling is unavailable or unreliable.

### Authentication

For documents requiring login, obtain a session cookie using the auth helpers.
Both verify the login against `/me` and throw `AuthError` (status 401) on bad
credentials; the result also carries the account (`user: {id, name, photo}`).

```javascript
import { loginWithEmail, loginWithLDAP, getSessionUser, HedgeDocClient } from 'hedgesync';

// Email/password authentication
const { cookie, user } = await loginWithEmail({
  serverUrl: 'https://hedgedoc.example.com',
  email: 'user@example.com',
  password: 'password'
});

// ...or LDAP: loginWithLDAP({ serverUrl, username, password })

// Later: check whether a stored cookie is still logged in (null if not)
const stillValid = await getSessionUser({ serverUrl: 'https://hedgedoc.example.com', cookie });

// Use the cookie
const client = new HedgeDocClient({
  serverUrl: 'https://hedgedoc.example.com',
  noteId: 'private-note',
  cookie
});
```

For OIDC/OAuth/SAML servers, take the session from an installed browser
(Bun, or Node 22.5+ for `node:sqlite`). It throws `BrowserCookieError` with a
`hint` when no profile is logged in:

```javascript
import { sessionFromBrowser } from 'hedgesync';

const { cookie, user, profile } = await sessionFromBrowser('firefox', {
  serverUrl: 'https://hedgedoc.example.com',
  // profile: 'work',   // default: every profile, freshest first
});
```

### Mirroring Notes

`NoteMirror` keeps two connected clients in sync (this is what `hedgesync mirror` uses):

```javascript
import { HedgeDocClient, NoteMirror, createMirrorTransform } from 'hedgesync';

const source = new HedgeDocClient({ serverUrl, noteId: 'draft' });
const target = new HedgeDocClient({ serverUrl, noteId: 'published' });
await Promise.all([source.connect(), target.connect()]);

const mirror = new NoteMirror(source, target, {
  // One-way with a transform...
  transform: createMirrorTransform({ headingShift: 1, prepend: '> Mirrored from draft\n\n' }),
  // ...or { bidirectional: true }: concurrent edits on both sides are merged with OT
});
mirror.on('sync', (e) => console.log(e.direction, e.merged ? '(merged)' : ''));
mirror.start();

// later
await mirror.flush();
mirror.stop();
```

`mergeText(base, ours, theirs)` exposes the three-way merge on its own.

## Examples

Each example takes a note URL (use a scratch note: most of them edit it) and
honours `HEDGEDOC_COOKIE`. They import the TypeScript sources, so run them with Bun:

```bash
bun examples/basic-usage.js https://md.example.com/scratch      # read, one edit
bun examples/edit-document.js https://md.example.com/scratch    # insert/replace/batch/undo/raw ops
bun examples/line-operations.js https://md.example.com/scratch  # 0-based line helpers
bun examples/regex-replace.js https://md.example.com/scratch    # replaceFirst / replaceRegex
bun examples/watch-document.js https://md.example.com/scratch   # change and presence events
bun examples/macro-system.js https://md.example.com/scratch     # macro engine, runs until Ctrl+C
bun examples/pandoc-transform.js https://md.example.com/scratch [--write]   # needs pandoc
```

`examples/macros.json` is a config for `hedgesync macro --config`.

## Development

```bash
bun install
bun run test        # unit + end-to-end tests (no network), then the offline feature script
bun run typecheck
bun run build       # npm package into dist/ (library + Node CLI)
```

`test/unit` covers the OT client (including seeded fuzzing against an
in-memory server, `FUZZ_SEED=n` to reproduce), macros, shell quoting, auth,
mirroring and argument parsing. `test/e2e` runs the real CLI and every example
against a socket.io stand-in for HedgeDoc. `test/test-all-features.ts` also
has live tests that edit a real note; they run only with
`HEDGESYNC_LIVE_NOTE_URL=<scratch note URL>`.

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
  socketOptions: { ca: myCaCertificates },     // Optional: extra Socket.IO options (Node: TLS settings)
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
| `setCursor(position \| null)` | Show others where your cursor is (`{line, ch}`, zero-based), or `null` when your editor loses focus. Ignored while not connected; send it again after a reconnect. |
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

client.on('cursor:focus', (user) => { /* User focused their editor; user.cursor is {line, ch} */ });
client.on('cursor:activity', (user) => { /* User moved their cursor */ });
client.on('cursor:blur', ({ id }) => { /* User's editor lost focus */ });

// Cursors are also kept on getOnlineUsers() entries (user.cursor, null after a blur).
// Convert between {line, ch} and text offsets with cursorFromIndex(text, index)
// and indexFromCursor(text, cursor). HedgeDoc shares only the cursor, not selections.

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

### CLI Terminal Command

`hedgesync terminal <url>` turns a code block in the note into a shell that
everyone in the note can see. Type a command after the `$` prompt and press
Enter; hedgesync runs it on the machine where it is running, streams the
output into the note and adds a new prompt:

````markdown
```terminal
$ cd ~/project && git log --oneline -2
a4b5e57 Release 2.1.0
f9d0028 Add cursor sharing
$ 
```
````

- The block is added at the end of the note if there is none (`--block` picks
  another info string). One shell runs for the whole session, so `cd`,
  variables and functions persist; `--shell` picks it (bash, else sh).
- Input that spans several lines (heredocs, pasted scripts) runs once it ends
  in an empty line.
- Commands get no stdin and no TTY: editors, pagers and password prompts do
  not work. `TERM=dumb`, `NO_COLOR=1` and `PAGER=cat` are set, colour codes
  are stripped, and progress bars show their last state. Output is capped at
  `--max-output` characters per command, and `--timeout` kills runaway
  commands (restarting the shell).
- Ctrl+C ends the session and marks the block `[terminal closed]`.

**Security:** running commands means a shell on your machine, as you. By
default only the account behind your session cookie may run commands, so you
can drive it from your browser. Input that anyone else touched is refused, not
run. `--allow-user <id>` names other accounts (ids are in `hedgesync users
<url> --json`), and `--anyone` lets everyone who can edit the note in, after a
warning.

The same is available as a library, `new NoteTerminal(client, options)`
(Node/Bun), with `command`, `done` and `refused` events.

### Editing from Neovim

`editors/nvim` is a Neovim plugin for live, keystroke-level editing of notes
with collaborators' cursors shown inline:

```sh
hedgesync editor nvim install    # the plugin ships inside the CLI
```

```vim
:Hedge open https://md.example.com/abc123
:checkhealth hedgesync
```

It runs `hedgesync bridge <url>`, which speaks newline-delimited JSON on
stdin/stdout and does all the operational transformation, so other editors
can reuse it. See [editors/nvim/README.md](editors/nvim/README.md) and
`src/editor-bridge.ts` for the protocol.

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

Get the cookie with `hedgesync login <server> --from-browser <browser>`,
`sessionFromBrowser()`, or from your browser's developer tools.

## How It Works

`HedgeDocClient` owns the document text, the editing helpers, batching and
undo/redo. Everything server-specific lives in a protocol driver
(`src/drivers/`): transport, session bootstrap, synchronisation, note
metadata and permissions. Edits cross between the two as `TextOperation`s.
The HedgeDoc 1.x driver works like this:

1. **Session Cookie**: The library first makes an HTTP request to get a session cookie (HedgeDoc requires this even for anonymous users).

2. **Socket.IO**: Connects to HedgeDoc's real-time WebSocket endpoint using Socket.IO.

3. **Document Sync**: Receives the initial document state and revision number.

4. **Operational Transformation**: When you make edits, they're sent as OT operations. When other users edit, their operations are transformed against yours to ensure consistency.

5. **Conflict Resolution**: The OT algorithm ensures all clients converge to the same document state, even with concurrent edits.

## Compatibility

- **HedgeDoc**: Version 1.10.4 or later (uses OT-based real-time sync with Socket.IO v4)
- **Runtime**: Node.js 18+, Bun, Deno (with import map), and Obsidian plugins via `hedgesync/obsidian`
- **Node-only modules**: Auth helper flows, macro engine, and pandoc transformer are not part of the Obsidian entrypoint
- **Not supported**: HedgeDoc < 1.10.4 (Socket.IO v2) or HedgeDoc 2.x (a plain
  WebSocket with Y.js instead of Socket.IO with OT). `detectServer()` and
  `hedgesync status` tell the two apart, and connecting to a HedgeDoc 2 server
  fails with a clear message. The driver interface (`NoteDriver`, option
  `driver`) is where a HedgeDoc 2 driver will plug in.

## License

AGPL-3.0-only (same as HedgeDoc)

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.
