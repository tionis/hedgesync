# Exploration: incident war room

Status: idea, not built. 2026-11-16.

During an incident, one note holds everything: a timeline that monitoring
writes into, what people observed and decided, and the commands they ran
with their output. When the incident is over, the note is the postmortem
draft.

## What it would look like

```markdown
# Incident 2026-11-16: API latency

Status: **investigating** · Lead: alice · Started 14:02

## Timeline
- 14:02 🔥 alert: api p99 latency > 2 s (alertmanager)
- 14:04 alice: looking at the database
- 14:07 ✅ alert resolved: disk usage on db-1 (alertmanager)

## Commands
```terminal
$ ssh db-1 df -h /var
...
```

## Notes
```

```sh
hedgesync incident new https://md.example.com --title "API latency" \
  --webhook :9099 --terminal
```

## Parts

All of these exist or are small:

- **A note from a template:** `create` with the skeleton above. The URL is
  printed and can be posted to the on-call channel (or by the
  [chat bridge](chat-bridge.md)).
- **A webhook receiver:** a small HTTP server that accepts Alertmanager,
  Grafana, Uptime Kuma or plain JSON, and appends a timeline line per event.
  New: about 100 lines.
- **Timestamps for people:** a macro that turns `- ` at the start of a new
  line in the Timeline into `- 14:04 alice: ` using the author of the
  change. `macro` can almost do this already.
- **Commands:** `hedgesync terminal` on a block in the note: commands typed
  there run on the responder's machine and their output lands in the note,
  so the record is complete without copy and paste.
- **Status line:** the header line is a [live section](live-sections.md),
  updated from the open alerts.

## The postmortem

When the incident is closed (`hedgesync incident close` or typing
`Status: resolved`), the tool:

- appends postmortem headings (Impact, Root cause, What went well, Action
  items),
- computes the duration and time to resolution from the timeline,
- optionally asks an agent (through MCP) for a first summary, which people
  edit.

Since the note is a HedgeDoc note, publishing it is a permission change.

## Open questions

- **Running commands from a shared note** is powerful and dangerous. The
  terminal runs only where someone started it, on their machine, with
  their rights. That is the right default; there is no remote execution.
- **Secrets in output:** terminal output lands in a note others can read.
  A redaction filter (tokens, passwords matching patterns) on terminal
  output would be worth adding before using this for real.
- **Many incidents:** one daemon with the webhook can route alerts to the
  open incident note by label, or start a new note for an unknown one.
- **Where the receiver runs:** on a machine that monitoring can reach. For
  a home lab, the same box as HedgeDoc.

## Suggested first step

`hedgesync incident new <server> --title <t> [--webhook <port>]`: template
note, webhook receiver for Alertmanager and generic JSON, timeline appends,
and the timestamp macro for people. About a day and a half. The postmortem
step and status line next.
