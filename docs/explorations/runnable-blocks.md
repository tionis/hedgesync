# Exploration: runnable code blocks

Status: idea, not built. 2026-11-16.

Code fences in a note that run, with their output written below them:
a shared, live notebook on top of HedgeDoc. Several people (or an agent
through `hedgesync mcp`) edit the code, and everyone sees the results.

## What it would look like

````markdown
```python run
import statistics
print(statistics.mean([3, 5, 8]))
```

```output
5.333333333333333
```
````

A daemon (`hedgesync run <url>`) watches the note. When a block is
triggered, it runs the code with a runner configured for that language and
writes the output into the `output` fence right after the block (created if
missing, replaced otherwise), as one live edit.

## Triggering

Running every block on every keystroke is expensive and surprising,
especially with several people typing. Options:

1. **Explicit marker.** Typing ` run` (or `▶`) on the fence line triggers a
   run, and the daemon rewrites it to `ran 12:03 (0.4 s)`. Retyping triggers
   again. It works from any editor, the browser included, and leaves a
   visible record.
2. **On change, after a pause.** Re-run when a block's code changed and
   nobody has typed for a few seconds. Good for cheap, pure blocks (a
   calculator, a SQL query against a local file).
3. **From the editor.** `:Hedge run` on the block under the cursor, which
   sends a message to the daemon (or runs locally). Natural in Neovim, but it
   doesn't help browser users.

The fence's info string can carry the choice: `python run`, `python
run=auto`.

## Runners

- **Stateless:** a fresh process per run (`python3 -c`, `bash -c`, `bun -e`,
  `sqlite3 db.sqlite`). Simple and predictable.
- **Kernels:** a persistent REPL per note and language, so variables carry
  over between blocks, as in Jupyter. A "restart kernel" marker resets it.
  More work, and it needs ordering rules ("run all above").
- **Rich output:** images (matplotlib, plots) are uploaded through
  HedgeDoc's `/uploadimage` (`hedgesync upload` already does this) and
  embedded as `![](...)`. HedgeDoc renders mermaid, graphviz and math by
  itself, so those need no runner at all.

## Security: the hard part

Whoever can edit the note decides what code runs on the daemon's machine. A
note with `freely` permission makes it a public remote shell. So any real
version needs:

- **Trusted authors only.** HedgeDoc 1 tracks authorship: which user id
  wrote which character ranges. The daemon can refuse to run a block unless
  every character of it was written by an allowed user id. That is precise,
  and already available from the note info hedgesync receives.
- **A sandbox regardless:** a container (podman, bubblewrap) with no
  network and a scratch directory, or a disposable cloud VM (Sprites)
  per note. Time and output limits, and the output is cut when too long.
- **Opt-in per note:** the daemon only runs notes it was started for, with
  runners from local configuration, never from the note itself.

## Relation to what exists

- `macro --exec` replaces a trigger with a command's output; `--block`
  transforms a block. Runnable blocks differ by keeping the code and
  managing a separate output block.
- `exec` runs a local script against a live client: the daemon's skeleton.
- The MCP server makes agents a natural user: an agent writes a block,
  triggers it, reads the output and iterates, all visible to people
  watching the note.

## Open questions

- Should output blocks be marked as owned (`<!-- output of block 3 -->`) so
  that people deleting or moving them don't confuse the pairing?
- What happens when a block is edited while it runs? Probably: write the
  output, but mark it stale (the fence line shows `ran on an older version`).
- Is a kernel worth it, or is "stateless plus a shared scratch directory"
  enough for the notebook use?

## Suggested first step

`hedgesync run <url> --runner python=python3 --runner sh=bash --trust <user-id>`:
explicit ` run` markers, stateless runs inside `bwrap` or `podman` with no
network, a 10 s limit and 200 output lines. About two days including tests.
Kernels and images come after it has been used for real.
