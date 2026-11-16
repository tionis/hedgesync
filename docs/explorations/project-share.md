# Exploration: share a whole project

Status: idea, not built. 2026-11-16.

`hedgesync share` and `:Hedge share` share one file. For pairing on code
you want the project: the other person opens whichever file they need, and
follows you between files. A self-hosted Live Share, built from notes.

## What it would look like

```sh
hedgesync share --dir . https://md.example.com
# sharing 37 files: https://md.example.com/xYz?edit  (index)
```

In Neovim: `:Hedge share project`, which shares the files under the current
working directory (or the git root).

The guest opens the index link: a note listing the shared files as links.
In Neovim, `:Hedge open <index>` turns the index into a file tree (like
`:Hedge browse`), and opening an entry opens that file's note with the
right filetype.

## Which files

- Only files tracked by git (`git ls-files`), or not ignored, so
  `node_modules`, builds and secrets in `.env` stay out.
- Text files only, and below a size limit (HedgeDoc 1 notes top out at
  about 100 k characters by default).
- **Lazily:** a note is created the first time someone opens a file,
  not for all files up front. A 2 000-file repository should not become
  2 000 notes. The index lists all paths; opening an unshared one asks
  the host to create its note.

## Host and guest

- **Host** runs the share (CLI or Neovim). Their files are the truth: notes
  sync to them like `hedgesync share` does today (three-way merges), and
  `:w` on the host writes the file.
- **Guests** only see notes. They can't run the code, but the host can share
  a terminal through `hedgesync terminal` in a note, which runs on the host,
  so tests and builds are visible to both.

## Follow across files

`:Hedge follow` follows a cursor within one note. With a project, following
alice should also switch files when she does. HedgeDoc doesn't announce
which note someone is in, so the host's share process writes a small
presence line into the index note (`alice: src/main.ts:42`), updated as
people move, and a follower's plugin opens that file.

## Open questions

- **Creating and deleting files:** a guest creating `src/new.ts` in the
  index could make the host create it. Renames are harder. First version:
  existing files only.
- **The host closes the session:** notes stay on the server. A cleanup step
  that deletes the notes (owner only) is needed, or the notes pile up in
  the history.
- **Permissions:** notes are created as `limited` or `private` and the
  link is shared deliberately; nothing is public by default.
- **Language servers:** guests have no LSP on notes. Neovim guests could
  run their own LSP if they have the repo checked out, which is often the
  case in pairing. Then it is closer to "my checkout follows yours".

## Suggested first step

`hedgesync share --dir <path> <server>`: an index note, lazy note creation
on request, file↔note sync for opened files reusing `FileNoteSync`, and
`:Hedge open` on an index showing a tree. About three days. Follow across
files next.
