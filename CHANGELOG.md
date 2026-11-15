# Changelog

## Unreleased

### Added

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
- Saved sessions record where they came from (`source`).
- `detectServer()` tells HedgeDoc 1 and 2 apart; `hedgesync status` shows
  the server version, and connecting to a HedgeDoc 2 server fails with a
  clear "not supported yet" error instead of a timeout.

### Fixed

- `users` and `info` no longer count the CLI's own connection as an online
  user; `watch` reported user lists keyed by array index.
- `NoteMetadata` (from `/{note}/info`) now matches what HedgeDoc returns:
  `title`, `description`, `viewcount`, `createtime`, `updatetime`.

- Without a cookie, the client fetched the note page to get an anonymous
  session, which on servers with free URLs created the note if it did not
  exist (a typo in a note URL left an empty note behind). It now uses
  `/config`, which has no side effects; missing notes are reported as such.

### Changed

- `HedgeDocClient` is split into a protocol-neutral client and a HedgeDoc 1
  driver (`HedgeDoc1Driver`: Socket.IO, OT, permissions, reconnection) behind
  a `NoteDriver` interface, ready for a HedgeDoc 2 (Yjs) driver. The public
  API is unchanged; new options `protocol` and `driver`, new getter
  `protocol`. Private members such as `_getSessionCookie` moved to the driver.

## 2.0.0

A correctness and safety overhaul. Several APIs and CLI behaviours changed;
see "Breaking changes".

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

### Added

- `NoteMirror`, `mergeText`, `createMirrorTransform` for keeping notes in sync.
- `diffToOperation`, `getSessionUser`, `parseSetCookie`, `parseServerUrl`,
  `renderShellTemplate`/`runShell`, `VERSION`.
- CLI: `login --save` and `logout` with a per-server cookie store,
  `--no-color`/`NO_COLOR`, `--version`, `--json` error output, `--opt=value`.
- Unit, fuzz and end-to-end test suites that need no network.
