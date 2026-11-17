# The hedgesync MCP server

`hedgesync mcp` serves HedgeDoc notes over the Model Context Protocol. It
speaks the current revision (2026-07-28) and the 2025 ones.

## Tools

| Group | Tool | What it does |
|---|---|---|
| read | `list_notes` | Notes in the user's history (title, URL, tags) |
| read | `search_notes` | Lines matching a pattern, across those notes |
| read | `read_note` | Live text with line numbers; `section` or `lines` for part of a long note |
| read | `wait_for_change` | Waits until people change the note (optionally until some text appears), returns a diff and who did it |
| edit | `edit_note` | Replace exact text (unique, or `replace_all`) |
| edit | `edit_section` | Replace, append to or prepend to the section under a heading; `create: true` adds it |
| edit | `append_to_note` | Add text at the end |
| edit | `write_note` | Replace the whole note; refused if it changed since you read it |
| create | `create_note` | New note, returns its URL |

Notes are also resources: the note URL is the resource URI, and subscribers
are told when the note changes. The prompt `work_in_note` sets an agent up to
take requests written into a note.

## Registering it

Claude Code:

```sh
claude mcp add hedgesync -- hedgesync mcp --server https://md.example.com
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.hedgesync]
command = "hedgesync"
args = ["mcp", "--server", "https://md.example.com"]
```

Cursor (`.cursor/mcp.json`), Gemini CLI (`~/.gemini/settings.json`) and most
others:

```json
{ "mcpServers": { "hedgesync": { "command": "hedgesync", "args": ["mcp", "--server", "https://md.example.com"] } } }
```

VS Code (`.vscode/mcp.json`):

```json
{ "servers": { "hedgesync": { "type": "stdio", "command": "hedgesync", "args": ["mcp", "--server", "https://md.example.com"] } } }
```

`hedgesync agent config <client>` prints these with the right paths.

## Limiting what an agent can do

```sh
hedgesync mcp --read-only                          # only the read tools
hedgesync mcp --tools read,edit                    # tool groups: read, edit, create
hedgesync mcp --note https://md.example.com/plan   # only this note (repeatable)
```

## Over HTTP

```sh
hedgesync mcp --http 8788                                   # loopback only, no sign-in
hedgesync mcp --http 0.0.0.0:8788 --token "$SECRET"         # bearer token
hedgesync mcp --http 8788 --public-url https://mcp.example.com --owner https://you.example.com
```

With `--owner`, the server is an OAuth 2.1 authorization server: clients
register themselves, the owner approves them in a browser and signs in with
IndieAuth (their website names their IndieAuth server), and token scopes
(`read`, `edit`, `create`) pick the tools. Connect with, e.g.,
`claude mcp add --transport http hedgedoc https://mcp.example.com/mcp`.

Whoever gets in works as the HedgeDoc login of the machine running the server.
