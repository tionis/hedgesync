# Changelog

## Unreleased

### Added

- Neovim: `:Hedge browse` lists your notes (history: pinned, tags, last
  opened) to open, pin, create, remove or search; `:Hedge find` picks one
  with `vim.ui.select`; `:Hedge new [title]` creates a note and opens it
  (`:'<,'>Hedge new` from the selected lines); `:Hedge search` puts matches
  in the quickfix list; `:Hedge revisions` views a revision, diffs it
  against the live note or restores it as an undoable edit; `:Hedge url
  [publish|slide]` copies a link.
- Neovim: `:Hedge follow [name]` makes your view follow someone's cursor
  until you press a key.
- Neovim: `:Hedge share [permission]` shares the file buffer you are in
  live: a new note gets its text and the buffer stays the file (`:w` saves
  it) while syncing; the copied link carries the filetype for Neovim guests.
- `hedgesync share <file> [<server-url> | <note-url>]`: share a local file
  live from any editor, or join a shared one; file and note are synced both
  ways (three-way merges) until Ctrl+C.
- `hedgesync mcp`: a Model Context Protocol server, so AI agents read,
  search, create and edit notes. Edits are live (merged with people's
  typing, the agent's cursor visible), and `wait_for_change` lets an agent
  react to what people write in a note.
- `hedgesync edit` without a note opens `:Hedge browse` (on the given server
  or your saved login's).
- Release binaries for linux-arm64 and linux-x64-musl (Alpine).

### Changed

- `:e hedgedoc://...` reads the note like a file (waits for its text), so
  `nvim hedgedoc://host/id +42`, quickfix entries and jumps land on the
  right line.
- `--json` errors include the hint shown in the terminal.
- CI: current action versions (no Node 20 deprecation warnings), pinned Bun
  and Neovim, the plugin's end-to-end tests run against a real Neovim, unit
  tests also on macOS and Windows, the released binaries are the ones built
  and smoke-tested (not a rebuild), and release notes come from this file.

## 2.3.0 (2026-11-16)

### Added

- `hedgesync edit <url>`: open a note in `$VISUAL`/`$EDITOR` (or `-e`).
  Neovim edits live through the bundled plugin, loaded for the session if
  your config does not load it; the bridge is the binary you ran. Other
  editors get a temp file whose saves are merged into the note (three-way, so
  concurrent edits survive), and once more on exit.
- Neovim plugin (`editors/nvim`): live, keystroke-level editing of a note in
  a Neovim buffer, with collaborators' cursors shown inline. `:Hedge open
  <url>` or `:e hedgedoc://host/id`.
- `hedgesync bridge <url>`: the process behind the plugin. Exchanges edits,
  cursors and status with an editor as newline-delimited JSON on stdio and
  does all transformation itself (an editor-side OT link on top of
  HedgeDoc's), so editor plugins stay simple. Edits made while disconnected
  are kept and sent on reconnect. `HEDGESYNC_BRIDGE_LOG=<file>` traces the
  protocol. The sync core is `EditorBridge` in `src/editor-bridge.ts`.
- `hedgesync editor nvim install | status | path | uninstall`: the Neovim
  plugin ships inside the CLI and installs into Neovim's package directory,
  so plugin and bridge always match. Local edits to an installed copy are
  never overwritten without `--force`.
- The editor protocol is versioned (`hedgesync bridge --info`); the plugin
  refuses a bridge with another version and says which side to update.
- `:checkhealth hedgesync`: Neovim version, CLI and protocol, how the plugin
  was installed, saved logins, open notes.

## 2.2.0 (2026-11-15)

### Added

- `hedgesync terminal <url>`: a shared shell session in a ` ```terminal `
  block of the note. Commands typed after the `$` prompt run in one
  persistent shell on the host and their output streams into the note. Only
  the host's own account may run commands unless `--allow-user` or
  `--anyone` says otherwise; input edited by anyone else is refused. Also
  available as the `NoteTerminal` class (Node/Bun).

### Fixed

- `TextOperation.transformPosition` mixed old and new coordinates, so a
  position inside a deleted range came out wrong when the same operation
  also inserted text before it. This also affects macro range tracking.

## 2.1.0 (2026-11-15)

### Added

- Cursors: `client.setCursor({line, ch} | null)` shows collaborators where
  your cursor is (HedgeDoc's `cursor focus` / `cursor activity` /
  `cursor blur`). Others' cursors are typed (`UserInfo.cursor` is a
  `CursorPosition` or null), kept up to date on `getOnlineUsers()` entries and
  cleared on blur; malformed positions from the server become null.
- `cursorFromIndex(text, index)`, `indexFromCursor(text, cursor)` and
  `isCursorPosition(value)`, exported from both entry points.

## 2.0.1 (2026-11-15)

### Fixed

- Node runtimes with websocket-only transport sent no session cookie, so the
  server answered "AUTH failed: No cookie transmitted". engine.io's cookie jar
  replaced a `Cookie` header with its own empty `cookie`; the header key is
  now lower-case.
- `createNote()` returned the editor page's HTML as the note id when the HTTP
  transport followed the redirect itself (for example Obsidian's `requestUrl`).
  It now throws an error that explains the cause.
- Connect errors explain the usual causes: a HedgeDoc 1.10.3 or older server
  (Socket.IO 2, unsupported), a rejected session, or an untrusted TLS
  certificate.

### Changed

- `package.json` `bin` path written as npm normalizes it (`dist/cli/bin.js`),
  which silences a misleading warning on publish.

### Added

- `socketOptions` client option for extra Socket.IO/engine.io settings, such as
  `ca` or `rejectUnauthorized` for servers behind a private certificate
  authority.

## 2.0.0 (2026-11-15)

A correctness and safety overhaul, plus browser login for OIDC servers, note
management commands, session upkeep, and a protocol driver layer ready for
HedgeDoc 2. Several APIs and CLI behaviours changed; see "Breaking changes".

### Breaking changes

**Library**

- `HedgeDocClient`: the rate limiter and `startBatch`/`endBatch`/`cancelBatch`/
  `getQueuedOperationCount` are gone. Use `batch(fn)` (synchronous, rolls back
  if `fn` throws) and `await flush()` to wait for the server's acknowledgement.
- `revision` is a read-only getter. Undo/redo events carry `{ operation }`.
- `MacroEngine`: regex handlers and streaming command builders receive
  `String.replace`-style arguments `(match, ...groups, index, document)`;
  `contextCommandBuilder` and `useDocumentContext` were removed. `start()` only
  watches; call `expand()` for a one-off pass. Only edits by other users (and,
  with `allowedUserIds`, only listed accounts) trigger macros.
- Auth: `loginWithOIDC`, `loginWithOAuth2Password`, `loginWithDeviceCodeOIDC`
  and `detectAuthMethods` were removed (none can create a HedgeDoc 1.x
  session). `loginWithEmail`/`loginWithLDAP` results include `user`.
- `ServerConfig` (from `HedgeDocAPI.getConfig()`) is parsed from HedgeDoc's
  `window.*` script: `urlpath` and `userToken` replace the never-present `CSRF`.
- `parseNoteUrl` strips `/publish`, `/slide`, `/download`, ... suffixes and
  `/s/`, `/p/` prefixes.

**CLI**

- Unknown options are errors, and a flag never consumes the next argument.
- `login` accepts only `email` and `ldap`; passwords are no longer accepted
  via `-p` (use the prompt, `HEDGEDOC_PASSWORD` or `--password-stdin`).
- Server commands (`me`, `history`, `export`, `create`, `status`, `login`)
  take the server URL as given; note commands require a note URL.
- `get` prints the document verbatim (no extra trailing newline when piped).
- `replace` without `--all` replaces only the first match (it used to replace
  every match); literal searches treat `$` in the replacement literally.
- `exec` is `exec <script> [url] [-- args]`.
- `mirror` reacts only to collaborators' edits; bidirectional mode merges
  concurrent edits instead of letting the source win.
- The npm package's CLI entry point is `dist/cli/bin.js`.

### Changed

- `HedgeDocClient` is split into a protocol-neutral client and a HedgeDoc 1
  driver (`HedgeDoc1Driver`: Socket.IO, OT, permissions, reconnection) behind
  a `NoteDriver` interface, ready for a HedgeDoc 2 (Yjs) driver. The public
  API is unchanged; new options `protocol` and `driver`, new getter
  `protocol`. Private members such as `_getSessionCookie` moved to the driver.

### Fixed

- OT client rewritten: lost acknowledgements, missed broadcasts, server
  restarts and forced resets are recovered without corrupting or duplicating
  edits (fuzz-tested against an in-memory HedgeDoc server).
- Macro commands no longer splice note text into shell commands; placeholders
  become quoted environment variables, so collaborators cannot run commands.
- Email login posted to a non-existent endpoint; a wrong password looked like
  a successful login. Logins are now verified with `GET /me`.
- History deletes now send the delete token HedgeDoc requires.
- The Node build of the CLI was broken.
- `transform --to` works on read-only notes; `transform --shift <n>` exists.
- Commands no longer hang waiting for stdin on a terminal.
- `users` and `info` no longer count the CLI's own connection as an online
  user; `watch` reported user lists keyed by array index.
- `NoteMetadata` (from `/{note}/info`) now matches what HedgeDoc returns:
  `title`, `description`, `viewcount`, `createtime`, `updatetime`.
- Without a cookie, the client fetched the note page to get an anonymous
  session, which on servers with free URLs created the note if it did not
  exist (a typo in a note URL left an empty note behind). It now uses
  `/config`, which has no side effects; missing notes are reported as such.

### Added

- `NoteMirror`, `mergeText`, `createMirrorTransform` for keeping notes in sync.
- `diffToOperation`, `getSessionUser`, `parseSetCookie`, `parseServerUrl`,
  `renderShellTemplate`/`runShell`, `VERSION`.
- CLI: `login --save` and `logout` with a per-server cookie store,
  `--no-color`/`NO_COLOR`, `--version`, `--json` error output, `--opt=value`.
- Unit, fuzz and end-to-end test suites that need no network.
- `hedgesync login <server> --from-browser <browser> [--profile <name>]`
  reuses a browser's HedgeDoc session, so servers that only offer OIDC,
  OAuth2, GitHub or SAML login work from the CLI. Firefox, LibreWolf and Zen
  (including containers) and Chrome, Chromium, Brave, Vivaldi and Edge on
  Linux and macOS are supported (native, Flatpak and Snap installs); the
  session is verified against `/me`.
- New commands: `list`/`ls` (your notes from history, with tag/title
  filters), `search` (grep through the text of those notes), `permission`
  (show or change, owner only), `delete` (owner only, with confirmation),
  `upload` (images, printed as Markdown links); `create --permission`.
- `publish` (alias `links`) prints a note's published, slide and other URLs;
  `meta` shows and edits front matter settings (title, tags, type, ...) as
  minimal edits; `revisions` gained `--diff`, `--restore`, `~N` references
  and a change column; `users --watch` reports people joining and leaving;
  `info` shows the view count and published URL.
- Library: `HedgeDocAPI.getNoteLinks()`, `readFrontMatter`/`getMeta`/
  `getTags`/`setMeta`, `diffLines`/`unifiedDiff`/`diffStat`.
- Library: `HedgeDocClient.setPermission()` and `deleteNote()` wait for the
  server's confirmation (HedgeDoc ignores non-owners silently);
  `HedgeDocAPI.uploadImage()`.
- Library: `sessionFromBrowser`, `readBrowserCookies`, `BrowserCookieError`,
  `SUPPORTED_BROWSERS`.
- Saved sessions record where they came from (`source`) and when they were
  last checked.
- `hedgesync sessions` lists saved sessions; `sessions refresh` renews them
  (HedgeDoc sessions are rolling) and re-imports expired browser sessions
  when the browser is still logged in as the same account;
  `sessions install-timer` sets up a daily systemd user timer for that.
- `logout` only forgets a browser-imported session (it is shared with the
  browser) unless `--end-session` is given.
- `detectServer()` tells HedgeDoc 1 and 2 apart; `hedgesync status` shows
  the server version, and connecting to a HedgeDoc 2 server fails with a
  clear "not supported yet" error instead of a timeout.
