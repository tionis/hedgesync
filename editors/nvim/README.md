# hedgesync.nvim

Live-edit HedgeDoc notes in Neovim, keystroke by keystroke, together with
people in the browser. Their edits appear in your buffer as they type, and
their cursors are shown inline with their names.

Requires Neovim 0.11+ and the `hedgesync` CLI.

## Install

The plugin ships inside the `hedgesync` binary, so the two always match:

```sh
# 1. The CLI: a release binary (or `npm i -g hedgesync`)
curl -fL https://github.com/tionis/hedgesync/releases/latest/download/hedgesync-linux-x64 \
  -o ~/.local/bin/hedgesync && chmod +x ~/.local/bin/hedgesync

# 2. The plugin, into Neovim's package directory
hedgesync editor nvim install

# 3. A login (the plugin uses the CLI's saved sessions)
hedgesync login https://md.example.com --from-browser firefox --save   # or -u <user>
```

Then check everything with `:checkhealth hedgesync`. After updating the CLI,
run `hedgesync editor nvim install` again (`hedgesync editor nvim status`
tells you whether you need to). Local edits to the installed plugin are never
overwritten without `--force`. If the CLI and the plugin speak different
protocol versions, the plugin refuses to start and tells you which to update.

Neovim loads the package directory by itself. lazy.nvim does not, so add a
spec pointing at it (`install` prints it):

```lua
{
  dir = vim.fn.stdpath("data") .. "/site/pack/hedgesync/start/hedgesync.nvim",
  name = "hedgesync.nvim",
  cond = vim.uv.fs_stat(vim.fn.stdpath("data") .. "/site/pack/hedgesync/start/hedgesync.nvim") ~= nil,
  lazy = false,
  opts = {},
}
```

Don't lazy-load it on `BufReadCmd`: lazy.nvim then loads the plugin but does
not replay the `:e hedgedoc://...` that triggered it. Loading it eagerly costs
nothing, because the startup file only defines `:Hedge` and an autocmd; the
module loads on first use.

To hack on the plugin, point `dir` at `editors/nvim` in a checkout instead
and run the CLI from the same checkout (`cmd = { "bun", "<checkout>/bin/hedgesync.ts" }`).

## Use

From the shell, `hedgesync edit <url>` starts Neovim on the note (this works
even before the plugin is installed: it loads the matching copy for that
session). Inside Neovim:

```vim
:Hedge open https://md.example.com/abc123
:e hedgedoc://md.example.com/abc123      " same thing
:Hedge users                              " who has a cursor in the note
:Hedge status
:Hedge close                              " stop syncing this buffer
```

There is nothing to save: every change is sent as you make it, and `:w`
just confirms the connection state. If the connection drops, keep typing;
your edits are sent once the bridge reconnects.

For a statusline: `require("hedgesync").status()` returns e.g.
`● connected`, and `b:hedgesync_title` holds the note title.

## Options

```lua
require("hedgesync").setup({
  cmd = { "hedgesync" },   -- how to run the CLI, e.g. { "bun", "/path/to/bin/hedgesync.ts" }
  args = {},               -- extra args for `hedgesync bridge`, e.g. { "--cookie", "..." }
  cursors = true,          -- show other people's cursors
  cursor_debounce = 50,    -- ms before sending your cursor position
})
```

## How it works

Each note buffer starts `hedgesync bridge <url>`, which holds the HedgeDoc
connection and exchanges newline-delimited JSON with the plugin. Because the
editor and the bridge are separate processes, a remote edit can be in flight
while you type; the bridge runs a second OT link toward the editor (all
transforming happens in the bridge; the plugin applies a remote edit only if
it has typed nothing since, and the bridge resends dropped ones rebased). The
protocol is documented in `src/editor-bridge.ts`.

The plugin does not trust `on_bytes` for content: some commands (`J`, undo)
report changes before the buffer holds the new text. It keeps a snapshot of
the lines and diffs it against the buffer after each command instead. Every
change carries the buffer size, so if the two sides ever disagree the buffer
is reset from the note rather than drifting.

`HEDGESYNC_BRIDGE_LOG=/tmp/bridge.log nvim` traces the protocol.

## Known limitations

- `u` undoes other people's edits too when they are interleaved with yours:
  Neovim has one undo history per buffer and cannot skip remote changes.
- A note is shown with lines joined by `\n`; `\r\n` line endings from
  Windows clients show as `^M`.
- Browsing notes (history picker) is not there yet; open notes by URL.
