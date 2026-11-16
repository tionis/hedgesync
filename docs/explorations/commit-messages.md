# Exploration: writing commit messages and PR descriptions together

Status: built (`hedgesync edit --new`, without `--wait` for browser-only use), 2026-11-16.

When two people pair, one of them types the commit message and the other
dictates. With a note as the editor, both write it, from their own editor
or the browser, and the commit is made when they're done.

## What it would look like

```sh
GIT_EDITOR="hedgesync edit --new --wait" git commit
```

or once for the repository:

```sh
git config core.editor "hedgesync edit --new --wait"
```

`git commit` creates a note with the message template (git's comment lines
included), opens it in the local editor, and prints the link for the
other person. When the person who ran the commit closes the editor (or
types `:wq` in Neovim), the note's text is written back to git's message
file and the commit completes. The note can be deleted afterwards, or kept
as a record.

PR descriptions work the same way: `gh pr create --body-file <(hedgesync
edit --new --wait --print)`.

## What is needed

- `hedgesync edit --new [server]`: create a note with the content of the
  file given by git (`.git/COMMIT_EDITMSG`), then edit it live.
- **Waiting:** git waits until the editor command exits. Neovim already
  blocks until it is closed. For the browser-only case, `--wait` waits
  until someone types a finishing marker, or Ctrl+C.
- **Writing back:** the note's final text goes into the file git passed.
  Git strips the `#` comment lines itself.
- **Cleanup:** `--delete-after` deletes the note once the file is written.

## Variations

- **Code review comments together:** the same flow for `git notes`, a tag
  annotation or a release changelog.
- **With an agent:** an agent connected through `hedgesync mcp` drafts the
  message from the staged diff into the shared note while both people
  watch and correct it.
- **Async:** the person who runs `git commit` sends the link to a reviewer
  and waits; useful when the message needs someone else's sign-off.

## Open questions

- **The link has to reach the other person.** Printing it is fine in a
  call. With the [chat bridge](chat-bridge.md) or a configured command it
  could be posted automatically.
- **Commits made in a hurry:** a remote round trip for every commit is too
  slow to be the default; it should be an alias (`git pair-commit`), not
  `core.editor`.
- **Merge commits, rebase todo lists:** they also use the editor. Rebasing
  together through a note is an amusing idea, but the todo list format is
  fragile; leave it out.

## Suggested first step

`hedgesync edit --new [<server>] <file>`: create a note from the file, edit
it live, write the final text back to the file on exit, with
`--delete-after`. About half a day, mostly tests with a fake editor. A
`git pair-commit` alias in the README.
