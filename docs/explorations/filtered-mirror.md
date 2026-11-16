# Exploration: mirror with a filter

Status: built (`hedgesync mirror --strip/--only/--strip-heading/--replace/--filter`), 2026-11-16.

`hedgesync mirror` copies a note to another live, with a few transforms
(header shifting, prepend, append). A filter that removes or rewrites
marked parts would turn it into a publishing tool: one source note, and a
derived note for a different audience that never falls behind.

## Uses

- **RPG handouts:** the GM's session note holds secrets; the players' note
  is the same text without them, updated as the GM writes during play.
- **Internal and public:** a team's note with names, internal links and
  todos; a public version without them.
- **Language or level:** a teacher's note with solutions, and the students'
  copy without.
- **Views:** only the "Decisions" sections of a long meeting note, or only
  open checkboxes.

## What it would look like

```markdown
The party reaches the mill at dusk.

<!-- gm -->
The miller is the cult leader. If asked about the flour, he lies (DC 15).
<!-- /gm -->

The door is locked. ::gm A key is under the mat.::
```

```sh
hedgesync mirror $GM_NOTE $PLAYER_NOTE --strip gm
```

The player note reads "The party reaches the mill at dusk. The door is
locked."

## Filters

- `--strip <name>`: remove `<!-- name -->...<!-- /name -->` blocks and
  inline `::name ...::` spans.
- `--only <name>`: keep only those blocks (the reverse: a summary note).
- `--strip-heading <regex>`: remove sections by heading, to the next heading
  of the same level.
- `--replace /re/=text`: rewrite (anonymise names, rewrite internal links).
- `--filter <cmd>`: any program reading the text and printing the result,
  for everything else.

## How it applies

The existing mirror sends minimal diffs of the transformed text, so a
filter is a function `source text → target text` applied before the diff.
Typing in the source becomes a small edit in the target, and readers of
the target see a live document, not a reload.

Two-way mode does not make sense with a filter that removes text (an edit
in the target can't be mapped back reliably), so `--bidirectional` and
`--strip` exclude each other.

## Safety

The point of the filter is to keep things secret, so its failure mode
matters more than its features:

- **An unclosed `<!-- gm -->`** while the GM is typing would leak or hide
  everything after it. Rule: an unclosed block hides everything to the end,
  so a mistake hides too much rather than leaking.
- **Half-typed markers:** while the GM types `<!-- g`, the text after it is
  briefly an unrecognised comment, which HedgeDoc doesn't render but the
  target's text does contain. So the mirror waits for typing to pause
  (about 1 s) before updating the target.
- **History:** the target note's revisions only ever contain filtered text.
  The source must never be readable by the audience; the tool can warn if
  the source's permission is wider than the target's.

## Suggested first step

`--strip`, `--only` and `--strip-heading` for `mirror`, with the
fail-closed rule and the typing pause, plus unit tests of the filter
(nested, unclosed and half-typed markers). About a day. `--filter <cmd>`
right after.
