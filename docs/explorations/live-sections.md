# Exploration: live sections

Status: idea, not built. 2026-11-16.

A note where some blocks are kept current by a program while people edit
the rest: a home dashboard, a CI board, a meeting agenda that shows the
calendar, an RPG session sheet with the initiative order. HedgeDoc does the
rendering, sharing and permissions; hedgesync supplies the moving parts.

## What it would look like

A section is marked with HTML comments, which HedgeDoc does not render:

```markdown
## Home

<!-- live: home -->
| Room | Temp | Light |
|------|------|-------|
| Living room | 21.4 °C | on |
<!-- /live -->

Notes below are ours.
```

and a daemon owns what is between the markers:

```sh
hedgesync live https://md.example.com/abc \
  --section home='ha-table living_room kitchen' --every 60s \
  --section ci='gh run list --limit 5 --json ... | jq -r ...' --every 5m
```

Each tick runs the source, and if the output differs from the section's
current text, replaces just that range as one minimal edit, through the
live client. People typing elsewhere in the note are not disturbed (OT), and
their cursors stay where they are.

## Sources

| Kind | How | Notes |
|---|---|---|
| Command | stdout of a shell command, on an interval | Covers almost everything (curl + jq, gh, scripts) |
| Stream | each NDJSON/line from a long-running command replaces the section | Push instead of poll: `journalctl -f`, `mosquitto_sub`, a websocket client |
| Home Assistant | a subscription over HA's websocket API, rendered with a template | Worth building in only if it gets used a lot; a stream command covers it at first |
| File | a local file's content | `hedgesync share` already does this for whole notes |

## Two-way sections: the note as a control panel

The interesting part. A section can also be read back when people change it:

```markdown
<!-- live: lights, control -->
- [x] Living room
- [ ] Kitchen
<!-- /live -->
```

Ticking a box changes the note. The daemon sees the edit (it gets every
remote change), diffs the section, and runs a handler (`ha switch.toggle
kitchen`). The next refresh then shows the real state, so a failed action
undoes itself visibly. The same shape gives polls, sign-up lists, or an RPG
initiative tracker where the GM drags lines and the daemon advances turns.

## Pieces hedgesync already has

- Live editing with minimal diffs (`updateContent`) and OT, so a writer
  never clobbers people.
- `macro`, which watches remote changes and replaces patterns (its `--exec`
  and `--block` are a special case of a section).
- `replace --section-heading`, which finds a section by heading.
- `mirror`'s loop structure (long-running, reconnects, flushes on exit).

A `live` command would mostly be marker parsing, scheduling and diffing a
range.

## Open questions

- **Markers or headings?** Comments are explicit and survive heading edits.
  Headings are friendlier to type. Supporting both, with comments as the
  canonical form, seems right.
- **People editing inside a section:** the next refresh overwrites them.
  HedgeDoc has no read-only ranges. A two-way section is the honest answer
  where editing matters; elsewhere a visible hint (`<!-- live: home (updated
  12:03) -->`) helps.
- **Where the configuration lives:** front matter in the note would make
  notes self-describing (`hedgesync live <url>` and nothing else). But then
  anyone who can edit the note chooses what the daemon runs. So commands
  must come from local configuration; the note may only name sections.
- **Revision noise:** HedgeDoc 1 saves revisions on a timer, not per edit,
  so frequent refreshes don't bloat history. The authorship colouring does
  attribute the section to the daemon's login, though, so a dedicated bot
  account would look better.
- **Several daemons on one note:** fine if they own different sections.
  Two on the same section would fight; the marker could carry an owner.

## Suggested first step

`hedgesync live <url> --section name=<command> [--every <interval>]` with
comment markers, one-way, command sources only. About a day of work,
including tests against the stand-in server. Two-way sections and streams
come next, once there is a real dashboard to try them on.
