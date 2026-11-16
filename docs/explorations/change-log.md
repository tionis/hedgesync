# Evaluation: a fine-grained change log

Status: evaluation, not built. 2026-11-16.

The question: record every change to a note, with time and author, in a
store of our own (not git), for history finer than HedgeDoc's revisions.

## What HedgeDoc 1 already keeps

| | Granularity | Author |
|---|---|---|
| Revisions | a snapshot about every few minutes while the note is edited | none per revision |
| Authorship | current text only: which user wrote which character range | user id for signed-in users, nothing for guests |
| `lastchangeuser` / `lastchangeAt` | the latest change | one user |

So HedgeDoc can't answer "who wrote this sentence that was deleted
yesterday", "what did the note look like at 14:32:10", or "replay the
session". Text written and deleted between two revisions is gone.

## What a recorder can see

Every realtime client receives every operation, live, with the server's
revision number, the author's connection id, and their name and user id
(when signed in). hedgesync already exposes this as `change` events with
`user`. A recorder is a client that stays connected and appends each
operation to a log:

```
notes(id, server, note_id, title)
ops(note, revision, at, user_id, user_name, client_id, op_json, length_after)
snapshots(note, revision, at, text)          -- every N ops, for fast lookup
gaps(note, from_revision, to_revision, at)   -- while disconnected
```

SQLite fits: `bun:sqlite` in the binary, `node:sqlite` for the npm build.
Keystroke-level typing is about one small row per keystroke burst. An
active note might produce some tens of thousands of rows a day, a few MB,
and snapshots keep reconstruction cheap.

What it enables:

- **Time travel:** the exact text at any moment (nearest snapshot plus the
  ops after it).
- **Blame, including deleted text:** who wrote and who removed a passage,
  when.
- **Replay:** a session played back, for example in Neovim at 10× speed
  with cursors.
- **Activity:** who worked on what, when; per-note and per-person
  timelines.
- **Recovery** of text that never reached a HedgeDoc revision.

## Limits

- **It only sees what happens while it is connected.** After a disconnect
  or server restart, the server's revision numbers show the gap; it can be
  closed with a snapshot diff attributed to "unknown". Changes made while
  the recorder is down can't be attributed.
- **It sees the notes it is told to watch.** HedgeDoc 1 cannot announce new
  notes. Watching "my history" means polling `/history` and connecting to
  new entries, one realtime connection per note. That is fine for dozens of
  notes, not for a whole server; an admin would do better with a database
  trigger on the server.
- **It is visible:** the recorder appears in the note's online users. That
  is arguably right (people can see they are recorded), but it shows under
  the recording account's name.
- **Privacy:** HedgeDoc already broadcasts every keystroke to everyone in
  the note, but keeping them is new. Shared notes need the participants'
  agreement; personal notes are unproblematic.

## Cheaper alternative

Snapshots instead of ops: store the text every 30 s while it changes, with
the authors from HedgeDoc's authorship data and the online users at the
time. It is far simpler (no op replay, robust to gaps) and gives most of
time travel and recovery. It loses exact attribution of deletions and
keystroke replay.

## Assessment

Useful in narrow cases:

- Important shared documents: meeting minutes, contracts being drafted,
  RPG session logs where "who changed this" matters.
- Teaching and pairing, through replay.
- Personal safety net: recovering text lost between revisions.

Not worth running on everything: most notes never need it, and the
always-connected client per note is the real cost.

Recommendation: if built, start with `hedgesync record <url>... --db
file.sqlite` (ops plus periodic snapshots, gap detection) and two read
commands, `hedgesync record show <url> --at <time>` and `hedgesync record
blame <url>`. Watching the whole history and replay come later. About two to
three days for the first version. It would also be a good base for the MCP
server ("what changed in this note since Monday, and who did it").
