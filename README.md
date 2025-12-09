# hedgesync

A Node.js library to programmatically connect to a running [HedgeDoc](https://hedgedoc.org/) server and make live edits to documents using Operational Transformation (OT).

## Features

- 🔌 **Real-time connection** via Socket.IO
- ✏️ **Live editing** with automatic conflict resolution (OT)
- 👥 **User presence** - see who's online
- 🔒 **Permission-aware** - proper error handling for read-only documents
- 📡 **Event-driven** - react to document changes from other users
- 🍪 **Auto-authentication** - automatically obtains session cookies

## Installation

```bash
cd hedgesync
npm install
```

## Quick Start

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

Run the examples with:

```bash
# Basic usage - connect, read, and optionally edit
node examples/basic-usage.js https://your-hedgedoc.com note-id

# Watch a document for changes
node examples/watch-document.js https://your-hedgedoc.com note-id

# Programmatic editing demo
node examples/edit-document.js https://your-hedgedoc.com note-id
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
  operationTimeout: 5000                       // Optional: timeout for operations (ms)
});
```

#### Methods

| Method | Description |
|--------|-------------|
| `connect()` | Connect to the server. Returns a Promise. |
| `disconnect()` | Disconnect from the server. |
| `getDocument()` | Get the current document content as a string. |
| `getRevision()` | Get the current revision number. |
| `getNoteInfo()` | Get note metadata (title, permission, authors, etc.). |
| `getOnlineUsers()` | Get array of currently online users. |
| `canEdit()` | Check if the current user can edit the document. |
| `insert(position, text)` | Insert text at a position. |
| `delete(position, length)` | Delete characters starting at a position. |
| `replace(position, length, text)` | Replace a range with new text. |
| `setContent(content)` | Replace the entire document content. |
| `applyOperation(op)` | Apply a raw `TextOperation`. |
| `refresh()` | Request updated note metadata. |
| `requestOnlineUsers()` | Request the online users list. |

#### Events

```javascript
client.on('connect', () => { /* Connected to server */ });
client.on('disconnect', (reason) => { /* Disconnected */ });
client.on('ready', ({ document, revision }) => { /* Document loaded */ });
client.on('error', (error) => { /* Error occurred */ });

client.on('document', (content) => { /* Document content changed */ });
client.on('refresh', (noteInfo) => { /* Note metadata updated */ });
client.on('permission', (permission) => { /* Permission changed */ });
client.on('delete', () => { /* Note was deleted */ });

client.on('users', (users) => { /* Online users list updated */ });
client.on('user:status', (user) => { /* User status changed */ });
client.on('user:left', (clientId) => { /* User disconnected */ });

client.on('cursor:focus', (user) => { /* User focused their cursor */ });
client.on('cursor:activity', (user) => { /* User moved their cursor */ });
client.on('cursor:blur', (data) => { /* User unfocused their cursor */ });
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
- **Node.js**: Requires Node.js 18+ (uses native `fetch`)
- **HedgeDoc 2.x**: Not compatible (uses Y.js instead of OT)

## License

AGPL-3.0-only (same as HedgeDoc)

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.
