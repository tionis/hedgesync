# HedgeDoc notes for AI agents

hedgesync lets AI agents read and edit HedgeDoc notes **live**: an agent's
edits go through the same realtime connection a browser uses, merge with what
people are typing at that moment, and show up in their editors at once, with
the agent's cursor where it worked. An agent can also wait for people to
change a note and react, e.g. to requests written into it.

There are three ways to connect an agent. They share the CLI's login and can
be combined.

| | What it is | Use it when |
|---|---|---|
| [Skill](#the-skill) | A `SKILL.md` that teaches an agent the hedgesync CLI | The agent has a shell (Claude Code, Codex, ...) |
| [MCP over stdio](#mcp-on-your-machine) | `hedgesync mcp`, started by the agent | The agent runs on your machine; you want structured tools, live sessions, change notifications |
| [MCP over HTTP](#mcp-over-http) | `hedgesync mcp --http`, a server | Agents on other machines or hosted ones (claude.ai, ChatGPT, ...), or several agents sharing one server |

## Before you start

Install hedgesync (`npm install -g hedgesync`, or a binary from the
[releases](https://github.com/tionis/hedgesync/releases)) and sign in to your
HedgeDoc server once, e.g. by reusing your browser's session:

```sh
hedgesync login https://md.example.com --from-browser firefox --save
hedgesync me https://md.example.com     # check
```

Notes anyone may edit work without signing in, as a guest. Everything an
agent does, it does **as this login**: it can read and change whatever you
can.

## The skill

`plugin/skills/hedgesync` is an [Agent Skill](https://agentskills.io): when to
use hedgesync, the commands, how to edit safely while people type, and how to
set up the MCP server. Agents load it when a task involves HedgeDoc.

```sh
hedgesync agent install                       # for every agent found: ~/.claude/skills, ~/.agents/skills
hedgesync agent install --for claude          # just Claude Code
hedgesync agent install --for agents --project  # into ./.agents/skills, to commit with a repository
hedgesync agent status                        # is the installed copy current?
```

The installed copy matches the binary; run `install` again after updating
hedgesync. Copies you edited are left alone unless you pass `--force`.

## MCP on your machine

`hedgesync mcp` speaks the Model Context Protocol on stdin/stdout. It
supports the current protocol revision (2026-07-28) and the 2025 revisions.

### Claude Code

The plugin installs the skill and registers the MCP server; it asks for your
HedgeDoc server URL and which tools to allow:

```sh
claude plugin marketplace add tionis/hedgesync
claude plugin install hedgesync@hedgesync
```

Or register the server alone:

```sh
claude mcp add hedgesync -- hedgesync mcp --server https://md.example.com
claude mcp add --scope project hedgesync -- hedgesync mcp --note https://md.example.com/plan
```

### Other clients

`hedgesync agent config <client>` prints the registration for `claude`,
`codex`, `cursor`, `gemini`, `vscode`, or generic `json`, passing on
`--server`, `--read-only` and `--note`:

```sh
hedgesync agent config codex --server https://md.example.com >> ~/.codex/config.toml
```

| Client | Where | Format |
|---|---|---|
| Codex | `~/.codex/config.toml` | `[mcp_servers.hedgesync]` with `command` and `args` |
| Cursor | `.cursor/mcp.json` or `~/.cursor/mcp.json` | `{"mcpServers": {"hedgesync": {"command", "args"}}}` |
| VS Code | `.vscode/mcp.json` | `{"servers": {"hedgesync": {"type": "stdio", "command", "args"}}}` |
| Gemini CLI | `~/.gemini/settings.json` | `{"mcpServers": {...}}` as for Cursor |
| Claude Desktop | `claude_desktop_config.json` | `{"mcpServers": {...}}` as for Cursor |

`--server` is the server for listing, searching and creating notes. Note
URLs work on any server you are signed in to.

### What the agent gets

| Group | Tool | |
|---|---|---|
| read | `list_notes` | Notes in your history: title, URL, tags |
| read | `search_notes` | Matching lines across those notes (reports progress, can be cancelled) |
| read | `read_note` | Live text with line numbers, who is in the note, whether it can edit; `section` or `lines` for part of a long note. Notes over 40,000 characters are cut, with an outline of their headings |
| read | `wait_for_change` | Waits until people change the note (or until some text appears), returns a diff and who did it |
| edit | `edit_note` | Replace exact text |
| edit | `edit_section` | Replace, append to or prepend to the section under a heading, or add the section |
| edit | `append_to_note` | Add text at the end |
| edit | `write_note` | Replace everything (refused if the note changed since the agent read it) |
| create | `create_note` | A new note |

Tools carry annotations (read-only, destructive, idempotent) and structured
results. Errors say how to recover: a missing section lists the headings, text
that changed meanwhile says to read again.

Notes are also **resources**: the note URL is the resource URI, and clients
that subscribe are told when the note changes. The **prompt** `work_in_note`
sets an agent up to take requests written into a note.

A session stays open for ten minutes after its last use (as long as needed
while a client subscribes), so people see the agent in the note between
calls.

### Limiting an agent

```sh
hedgesync mcp --read-only                          # read tools only
hedgesync mcp --tools read,edit                    # pick tool groups
hedgesync mcp --note https://md.example.com/plan   # only these notes (repeatable); no creating
```

Notes are written by people, and an agent reads them as input. Someone who
can edit a note can write instructions into it that the agent may follow. For
agents that read notes others write, especially agents with shell or file
access, give the MCP server only the notes and tools the task needs.

## MCP over HTTP

`hedgesync mcp --http [<host>:]<port>` serves the same tools over Streamable
HTTP at `/mcp`. It accepts `--read-only`, `--tools` and `--note` as above,
plus one of three ways in:

```sh
hedgesync mcp --http 8788                                     # 1: this machine only
hedgesync mcp --http 0.0.0.0:8788 --token "$HEDGESYNC_MCP_TOKEN"  # 2: a fixed bearer token
hedgesync mcp --http 127.0.0.1:8788 --public-url https://mcp.example.com \
  --owner https://you.example.com                             # 3: OAuth 2.1 with IndieAuth
```

1. **No authentication** is allowed on loopback addresses only. The server
   answers only requests addressed to localhost, so web pages can't reach it
   through DNS rebinding or cross-site requests. Other programs on the
   machine can.
2. **A bearer token** (`--token`, or the `HEDGESYNC_MCP_TOKEN` environment
   variable) suits scripts and clients that let you set a header:
   `claude mcp add --transport http hedgedoc https://mcp.example.com/mcp --header "Authorization: Bearer $TOKEN"`.
3. **OAuth 2.1** is what hosted agents and most MCP clients expect: you add
   the server's URL, approve the agent in your browser, and the client
   handles the tokens.

Several clients can share one HTTP server; they share its note sessions too.

### OAuth with IndieAuth

With `--owner`, hedgesync is its own OAuth 2.1 authorization server, as the
MCP authorization spec expects:

- metadata at `/.well-known/oauth-authorization-server` and
  `/.well-known/oauth-protected-resource/mcp`, and a `WWW-Authenticate`
  challenge pointing there;
- authorization code flow with PKCE (S256 only), resource indicators, and
  rotating refresh tokens (access tokens last an hour, refresh tokens 30 days);
- clients identified by a Client ID Metadata Document (an https URL as
  `client_id`) or registered dynamically (`/oauth/register`);
- revocation at `/oauth/revoke`.

To approve an agent, you prove who you are with
[IndieAuth](https://indieauth.spec.indieweb.org/): you enter your website,
and the IndieAuth server your website names signs you in. Only the websites
given with `--owner` (repeatable) are let in. Your website needs to link an
IndieAuth server:

```html
<link rel="indieauth-metadata" href="https://auth.example.com/.well-known/oauth-authorization-server">
<!-- or, older: -->
<link rel="authorization_endpoint" href="https://auth.example.com/auth">
```

The flow, from the agent host's side:

1. The client calls `/mcp`, gets `401` with the metadata URL, discovers the
   authorization server, and registers (or presents its metadata document).
2. Your browser opens the consent page: which app, what it may do (the
   scopes `read`, `edit`, `create`, i.e. tool groups), and where you'll be
   sent back. You allow it and enter your website.
3. Your IndieAuth server signs you in and sends you back; hedgesync checks
   that it confirmed one of the owners, then sends you on to the client.
4. The client gets tokens. Its scopes decide which tools it sees.

Tokens are opaque and stored only as SHA-256 hashes, with the registered
clients, in `mcp-oauth.json` next to the CLI's saved logins
(`~/.config/hedgesync/`), so restarts keep agents signed in. Deleting that
file signs every agent out. Removing someone from `--owner` (and
restarting) ends their agents' access.

### Running it on a server

Run hedgesync on loopback and put a TLS-terminating reverse proxy in front.
`--public-url` is the origin clients use (no path); the proxy must pass
`/mcp`, `/oauth/` and `/.well-known/` through. With Caddy:

```caddy
mcp.example.com {
	reverse_proxy 127.0.0.1:8788 {
		flush_interval -1   # stream responses (wait_for_change, progress)
	}
}
```

A systemd user service:

```ini
# ~/.config/systemd/user/hedgesync-mcp.service
[Unit]
Description=hedgesync MCP server

[Service]
ExecStart=%h/.local/bin/hedgesync mcp --http 127.0.0.1:8788 --public-url https://mcp.example.com --owner https://you.example.com
Restart=on-failure

[Install]
WantedBy=default.target
```

Keep the login fresh with `hedgesync sessions install-timer` (see
`hedgesync help sessions`).

## Working with people in a note

The pattern that works well:

1. `read_note` to see what the note is about.
2. `wait_for_change` with `until: "@agent"` (any marker you agree on). It
   returns what people changed once they stop typing.
3. Do what was asked with small edits (`edit_note`, `edit_section`), or
   answer right below the request, and mark it handled (e.g. replace
   `@agent` with `✓`).
4. Back to 2.

The `work_in_note` prompt gives an agent exactly these instructions. For a
standalone bot that answers mentions with any LLM, without an agent host,
see `hedgesync assistant` ([README](../README.md#an-assistant-in-a-note)).

## Troubleshooting

- **"Which server?"**: pass `--server`, or give the tool a `server`
  argument. With exactly one saved login, that one is used.
- **"No edit permission"**: the note is read-only for your login (see
  `hedgesync permission <url>`), or you are not signed in.
- **"old_text not found"**: someone changed that text since the agent read
  it. Read again; agents should copy `old_text` without line-number prefixes.
- **An HTTP client gets 403 "Invalid Host" or "Invalid Origin"**: without
  authentication, the server only answers requests for localhost. Add
  `--token` or `--owner` to serve other names.
- **OAuth: "Could not find your IndieAuth server"**: your website must link
  `rel="indieauth-metadata"` or `rel="authorization_endpoint"` in its HTML or
  `Link` header, and be reachable from the machine running hedgesync.
- Inspect the server with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):
  `npx @modelcontextprotocol/inspector hedgesync mcp`.
