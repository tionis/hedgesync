# Exploration: live transcript

Status: idea, not built. 2026-11-16.

Speech from a call or a room is transcribed into a note as people talk,
while everyone in the note corrects it, highlights decisions and writes
action items in the same place. After the meeting the minutes are mostly
done.

## What it would look like

```markdown
# Planning, 2026-11-16

## Decisions
- Ship 2.4 on Friday

## Transcript
**[10:02] Speaker 1:** Let's start with the release. I think Friday works
if the Windows fix is in.
**[10:03] Speaker 2:** It's in since this morning.
```

```sh
hedgesync transcribe https://md.example.com/abc --section Transcript --source pulse:default
```

Audio is cut into short chunks, sent to a speech-to-text engine, and the
text is appended to the section. Everything above the section belongs to
people.

## Pipeline

1. **Capture:** a local device (PulseAudio/PipeWire monitor for a call,
   a microphone for a room), or a file or stream (`ffmpeg -i ...`).
2. **Segmenting:** voice activity detection cuts at pauses, so lines end at
   sentence boundaries rather than every N seconds.
3. **Recognition:**
   - local: whisper.cpp or faster-whisper (private, needs a decent CPU or
     GPU for real time)
   - remote: an API (fast, good, but the audio leaves the machine)
4. **Writing:** each segment is appended as a paragraph. A partial result
   can be shown first in italics and replaced by the final text, so readers
   see text within a second.

The engine is a command that reads audio and prints NDJSON segments, so the
note side stays independent of the engine.

## Living with corrections

People will fix words in the transcript while it grows. That is fine: the
transcriber only ever appends at the end of its section, and OT keeps
corrections above. It must never rewrite earlier segments, except to
replace its own partial result, which it finds by a marker it inserted,
not by position.

## Speakers

Diarization (who is speaking) is a separate, less reliable step.
`Speaker 1/2/3` labels that people rename once in the note ("Speaker 1 =
alice") work well enough: the transcriber reads that mapping from the note
and uses names from then on.

## With an agent

Combined with `hedgesync mcp`, an agent can maintain the Decisions and
Action items sections from the transcript as the meeting goes, with its
cursor visible, and people correct it in place.

## Open questions

- **Consent:** recording a conversation needs everyone's agreement, and in
  many places it is a legal requirement. The note should state at the top
  that a transcript is being written, and the command should refuse to
  start without a `--announce` text it adds.
- **Size:** an hour of talk is 8–10 k words. Long notes are fine for
  HedgeDoc, but people may prefer the transcript in a second note, linked
  from the minutes.
- **Language:** whisper detects it; mixed-language meetings work but get
  worse with fast switching.

## Suggested first step

`hedgesync transcribe <url> --section <heading> --engine <cmd>` with a
whisper.cpp stream example, appending final segments only, plus a test
with a fake engine printing canned segments. About a day. Partial results
and speaker mapping come next.
