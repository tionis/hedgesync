# Exploration: chat bridge

Status: idea, not built. 2026-11-16.

A chat room (Matrix, Signal, IRC, Slack) and a note mirror each other: chat
messages arrive as lines in the note, and lines written in the note are
posted to the room. Meeting minutes where some people chat and others
write, a support channel with a living FAQ next to it, or a game night where
the party chats on their phones and the GM keeps the log.

## What it would look like

```markdown
## Chat

- 19:02 **alice:** are we starting at 19:30?
- 19:03 **bob:** yes, bring dice
- 19:05 **eric (note):** agenda is above, please add items
```

```sh
hedgesync bridge-chat https://md.example.com/abc --matrix '#game:example.org' --section Chat
```

The bridge owns a section (a heading or comment markers, as in
[live sections](live-sections.md)). Incoming messages are appended to it
as one live edit each. A new line typed at the end of the section by a
person is posted to the room once they press Enter and pause, under their
HedgeDoc name.

## Directions

- **Room → note:** simple. Append, with time and sender. Edits and
  deletions in the chat can update the line if the bridge remembers which
  line belongs to which message id (a hidden `<!-- m:$id -->` suffix, which
  HedgeDoc does not render).
- **Note → room:** the hard direction. The bridge must decide when a line is
  a finished message rather than half-typed text. Rule: a new list item in
  the section whose author (from the remote change events) is a person,
  after Enter and 2 s of quiet. It is posted as `alice (note): ...` from the
  bridge's account, then rewritten in the note to the standard form, so it
  is not posted twice.
- **Edits of old lines in the note** are not sent: chat history is append
  only. Optionally the bridge answers with a "(edited in the note)" reply.

## Backends

| Backend | How | Notes |
|---|---|---|
| Matrix | client-server API with a bot account, `/sync` long polling | Best fit: open, threads, edits, self-hostable |
| Signal | `signal-cli` JSON-RPC daemon | Works with groups; needs a phone number for the bot |
| IRC | plain socket | Easiest to build, nice for a first test |
| Slack/Discord | bot APIs | Possible, not a priority for a self-hosted crowd |
| Generic | a command that prints NDJSON messages and one that sends them | Lets people bridge anything with a script |

Starting with the generic command interface keeps the core small; Matrix
can be the first built-in backend.

## Open questions

- **One section or the whole note?** A section is safer. A whole note would
  be a "chat log as a document", which is what the section becomes anyway.
- **Threads and replies:** quote the replied-to message (`> bob: yes`) or
  nest list items. Nesting reads well in HedgeDoc.
- **Attachments:** images from the chat can be uploaded to HedgeDoc and
  embedded; files become links.
- **Privacy:** everyone in the room should know the chat is copied to a
  note that may have other readers. The bridge can announce itself in the
  room and the note's permission should match the room's audience.
- **Identity:** HedgeDoc names for note→room, chat names for room→note.
  Mapping people across both (alice in the note is @alice:example.org)
  would allow mentions both ways.

## Suggested first step

`hedgesync bridge-chat <url> --section <heading> --recv <cmd> --send <cmd>`,
with the generic NDJSON interface, both directions, and tests with a fake
chat script. Then a Matrix backend. About two days for the generic version,
one more for Matrix.
