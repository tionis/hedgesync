# Exploration: two-way task sync

Status: idea, not built. 2026-11-16.

Checkbox lists in a note stay in sync with a task system: GitHub or Gitea
issues, Taskwarrior, CalDAV todos (Nextcloud, Radicale). Ticking a box
closes the task, closing the task ticks the box, and a new task appears as a
new line. A note becomes a friendly, shared view of a task list that
people can reorder, group and annotate with prose around it.

## What it would look like

```markdown
## Release 2.4  <!-- tasks: github tionis/hedgesync milestone:2.4 -->

- [x] Windows: kill the process tree #41
- [ ] Note terminal timeout on Windows #42
- [ ] Write the release notes
```

```sh
hedgesync tasks https://md.example.com/abc --source github --interval 2m
```

## Mapping

Every synced line carries the task's identity: a visible reference where
the system has one (`#42`), otherwise a hidden suffix (`<!-- t:uuid -->`).

| In the note | In the task system |
|---|---|
| tick / untick | close / reopen |
| edit the text | rename (title only) |
| new line without an id | create the task, then add its id to the line |
| delete the line | nothing by default (deleting by accident is too easy); optional `--delete` |
| order of lines | kept in the note only (most systems have no order) |
| task created elsewhere | new line at the end of the section |
| task closed elsewhere | box ticked |

## Conflicts

Both sides can change between two syncs. The sync keeps the last state it
saw for each task (a small local state file), compares both sides with it,
and applies a change from either side; if both changed the same field,
the task system wins and the note gets a visible `(changed elsewhere)`
hint. This is the same three-way approach as `FileNoteSync` in
`hedgesync share`, per field instead of per text.

## Backends

- **GitHub/Gitea:** issues by query (milestone, label). Through `gh` or the
  REST API with a token. Webhooks would make it instant, polling is fine.
- **Taskwarrior:** `task export` / `task import`, by filter. Very easy.
- **CalDAV todos:** VTODO items, the most work, but it covers Nextcloud,
  phones and Thunderbird.
- **Generic:** commands that print and accept JSON tasks.

## Open questions

- **Sub-tasks:** nested list items could map to sub-tasks (Taskwarrior
  dependencies, GitHub task lists). Probably later.
- **Several sections:** each marker defines its own query, so one note can
  hold "this week" from Taskwarrior and "release" from GitHub.
- **Who did it:** closing an issue from a note uses the token's account.
  The note's authorship knows who actually ticked the box; the sync can add
  it as a comment ("closed from the note by alice").

## Suggested first step

`hedgesync tasks <url>` with section markers, the Taskwarrior and GitHub
backends, tick/untick/create/new-elsewhere, and the state file for
three-way merging. About two days. CalDAV and webhooks later.
