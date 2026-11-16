# Exploration: code review in a note

Status: idea, not built. 2026-11-16.

A pull request's diff becomes a note. Reviewers read it in their editor or
the browser and write comments directly under the lines they mean, all at
the same time, seeing each other's comments as they type. When they're
done, the comments are posted to the forge as one review with inline
comments.

Why: reviewing together in a call is much faster than in GitHub's UI, and
small teams and pairs do it already, sharing a screen. A note lets both
people point, write and discuss at once.

## What it would look like

````markdown
# PR #43: Kill the whole process tree on Windows

## src/shell.ts

```diff
@@ -134,6 +134,12 @@
   try {
+    if (proc.pid && process.platform === 'win32') {
+      spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], ...);
```

> **alice:** spawnSync blocks the event loop; taskkill can take a second
> on slow machines. Is that fine here?

> **eric:** Only on timeout or exit, so yes. Adding a comment.
````

```sh
hedgesync review https://github.com/tionis/hedgesync/pull/43 --server https://md.example.com
# review note: https://md.example.com/aBc?edit
# ... later:
hedgesync review --submit https://md.example.com/aBc
```

## From the note back to the forge

- **Comments:** a blockquote after a diff block, or between diff lines
  (the fence is split there), is a comment on the line above it. The note
  keeps hidden anchors (`<!-- @src/shell.ts:+136 -->`) so that edits to
  the note don't lose the position.
- **Authors:** HedgeDoc's authorship data says who wrote each comment; the
  submission posts them as one review from the submitter's account, with
  "alice:" prefixes for others, or as separate reviews if each reviewer
  submits their own part.
- **Summary:** text under a `## Summary` heading becomes the review body;
  a line `Verdict: approve | request changes | comment` sets the state.
- **Existing comments** from the forge are pulled into the note when it is
  created, so the discussion continues in one place.

## Variations

- **Local review before a PR:** `hedgesync review <git range>` for a
  branch without a forge; the comments become a checklist note.
- **Suggested changes:** a ```` ```suggestion ```` block under a line, as
  GitHub knows it, is posted as a suggestion.
- **With the [project share](project-share.md):** jumping from a diff line
  to the full file note, to see context.

## Open questions

- **Large PRs:** a 3 000-line diff is a long note. One note per file,
  linked from an index, scales better.
- **Re-review after new commits:** regenerating the note would clash with
  comments. Better: append a new section "Changes since review", with the
  incremental diff.
- **Forges:** GitHub first (the API has review comments with line
  positions), then Gitea/Forgejo, which has a similar API.

## Suggested first step

`hedgesync review <pr-url>` creating the note from the PR's diff and
existing comments, and `--submit` posting quotes under diff lines as one
GitHub review, with tests against recorded API responses. About two days.
