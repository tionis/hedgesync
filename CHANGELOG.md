# Changelog

## Unreleased

### Added

- `hedgesync login <server> --from-browser <browser> [--profile <name>]`
  reuses a browser's HedgeDoc session, so servers that only offer OIDC,
  OAuth2, GitHub or SAML login work from the CLI. Firefox, LibreWolf and Zen
  (including containers) and Chrome, Chromium, Brave, Vivaldi and Edge on
  Linux and macOS are supported; the session is verified against `/me`.
- Library: `sessionFromBrowser`, `readBrowserCookies`, `BrowserCookieError`,
  `SUPPORTED_BROWSERS`.
- Saved sessions record where they came from (`source`).

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
