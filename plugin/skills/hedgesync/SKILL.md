---
name: hedgesync
description: Read, edit and collaborate live in HedgeDoc notes (collaborative Markdown, also known as CodiMD) with the hedgesync CLI or its MCP server. Use when the user shares a HedgeDoc note URL (e.g. https://md.example.com/abc123), asks to read, update, summarize, search or create HedgeDoc notes, or wants an agent to work in a note alongside people, e.g. answering requests written into it.
license: AGPL-3.0-only
compatibility: Needs the hedgesync CLI (npm install -g hedgesync, or a release binary) and network access to the HedgeDoc server.
metadata:
  homepage: https://github.com/tionis/hedgesync
---

# HedgeDoc notes with hedgesync

HedgeDoc notes are Markdown documents that several people edit at the same
time. hedgesync edits them through the same realtime connection a browser
uses: your edit merges with what people are typing right now and shows up in
their editors at once. So **edit small and targeted**, never download, change
and upload the whole note while others work in it.

## MCP tools or CLI?

If tools such as `read_note`, `edit_note` and `wait_for_change` are available
(the hedgesync MCP server), use them: they keep a live session open, show your
cursor to others and return structured results. Otherwise use the CLI below.
Both use the same login.

## Before you start

```sh
hedgesync me https://md.example.com      # who you are signed in as there
```

If that says you are not signed in, notes that anyone may edit still work as a
guest. For everything else, ask the user to sign in once (it opens nothing, it
reuses their browser session; don't run it for them unasked):

```sh
hedgesync login https://md.example.com --from-browser firefox --save   # or chrome, ...
```

## Reading

```sh
hedgesync get <url>                 # the note's current text (live, including unsaved typing)
hedgesync info <url>                # title, permission, who is in it now
hedgesync list <server-url>         # notes in the user's history (-s <text> to filter, --json)
hedgesync search <server-url> <pattern> [-i]   # lines matching, across the user's notes
```

## Editing (live)

```sh
hedgesync replace <url> 'exact old text' 'new text'   # first occurrence; --all for every one
hedgesync append <url> 'text'                         # at the end (also: -f file, or stdin)
hedgesync prepend <url> 'text'
hedgesync set <url> -f note.md                        # whole note, applied as a minimal diff
hedgesync create <server-url> -f note.md              # a new note; prints its URL
```

- Read the note right before changing it, and copy `old text` exactly from it.
- If `replace` finds nothing, someone changed that text meanwhile: read again.
- Use `set` only for notes nobody else is editing, or for full rewrites the
  user asked for; it overwrites concurrent typing in the changed parts.
- Text with quotes, `$` or newlines: pass it on stdin or with `-f`, e.g.
  `printf '%s\n' '- [ ] item' | hedgesync append <url>`.
- Markdown conventions in HedgeDoc: the first `# Heading` is the title; YAML
  front matter (`---`) holds `title`, `tags`, `type: slide`. Change those with
  `hedgesync meta <url>` (see `hedgesync help meta`).

## Working with people in a note

To act on requests people write into a note (e.g. lines mentioning
`@agent`), prefer the MCP tool `wait_for_change` with `until: "@agent"`: it
returns what changed and who changed it, then you act and wait again. Without
MCP, `hedgesync watch <url> --ndjson` streams changes, but it never exits on
its own; run it in the background or with a timeout. For a ready-made bot that
answers mentions with an LLM, see `hedgesync help assistant`.

When you answer in a note, write below the request and mark it handled (e.g.
replace `@agent` with `✓`), so it is not picked up twice.

## Setting up the MCP server

If the user wants the MCP tools, see [references/mcp.md](references/mcp.md):
`claude mcp add hedgesync -- hedgesync mcp --server https://md.example.com`
for Claude Code, and setups for other agents, read-only and single-note modes,
and HTTP with OAuth.

## More

`hedgesync help` lists every command; `hedgesync help <command>` explains
one. [references/cli.md](references/cli.md) covers the less common ones
(permissions, revisions, uploads, exports, macros, mirroring).
