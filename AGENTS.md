# Working on hedgesync

A TypeScript library and CLI for live (OT) editing of HedgeDoc 1 notes. Bun
for development and the standalone binary; the npm package also runs on
Node 20+.

## Commands

```sh
bun install
bun run test         # unit + end-to-end (offline, against a socket.io stand-in for HedgeDoc)
bun run typecheck    # both tsconfigs (Bun sources, and the Node build)
bun run build:cli    # standalone binary in dist/hedgesync (regenerates embedded files first)
bun run build        # npm package in dist/ (library + Node CLI)
```

Run one file with `bun test test/e2e/mcp.test.ts`, one test with `-t <name>`.

## Layout

- `src/` library: `hedgedoc-client.ts` (realtime client), `ot-client.ts` and
  `text-operation.ts` (OT), `hedgedoc-api.ts` (HTTP API), `prank/`, macros,
  sections, ...
- `src/cli/` the CLI: `main.ts` registers commands from `commands/`, each a
  `Command` with options and help. `help-text.ts` holds the longer help pages.
- `src/cli/mcp/` the MCP server: `tools.ts` (tools over a pool of live note
  sessions), `server.ts` (SDK server: tools, resources, prompts),
  `http.ts` (Streamable HTTP), `oauth.ts` (OAuth 2.1 authorization server
  with IndieAuth sign-in).
- `plugin/` the Claude Code plugin; `plugin/skills/hedgesync` the Agent
  Skill. `.claude-plugin/marketplace.json` makes the repository a marketplace.
- `editors/nvim/` the Neovim plugin.
- `test/unit`, `test/e2e` (spawns the real CLI against `test/e2e/server.ts`).

## Conventions

- Embedded files are generated: after changing `editors/nvim/` run
  `bun run gen:nvim`, after changing `plugin/skills/hedgesync/` run
  `bun run gen:skill`. Tests fail when the generated files are stale.
- Every CLI option must appear in its command's help (a test checks).
- User-facing changes go into `CHANGELOG.md` under "Unreleased", and into the
  README or `docs/` where they are documented.
- A release bumps `package.json`, `src/version.ts` and
  `plugin/.claude-plugin/plugin.json` together (tests check they agree).
- `hedgesync mcp` imports the MCP SDK lazily: its stdio module takes over
  stdin on import, which breaks commands that read stdin.
- MCP tool errors (`ToolError`) are read by agents: say what went wrong and
  what to do next (e.g. list the headings when a section is missing).
