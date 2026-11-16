# Exploration: spreadsheet tables

Status: idea, not built. 2026-11-16.

Markdown tables whose cells are computed: totals, prices with tax, a
shared budget, an RPG character's derived values. People edit numbers in
the note (from any editor, the browser included), and a daemon updates the
computed cells.

## What it would look like

The formula has to survive in the note while the cell shows the result.
HedgeDoc renders the table, so the formula can't live in the cell text
alone. Two options:

**A formula row or comment under the table:**

```markdown
| Item    | Qty | Price | Total |
|---------|-----|-------|-------|
| Pizza   | 3   | 9.50  | 28.50 |
| Drinks  | 6   | 2.00  | 12.00 |
| **Sum** |     |       | **40.50** |
<!-- calc: D{2..3} = B*C; D4 = sum(D2:D3) -->
```

**Or a formula in the cell, kept next to its value:**

```markdown
| Pizza | 3 | 9.50 | 28.50 <!-- =B*C --> |
```

HedgeDoc doesn't render the comment in either. The second keeps formulas
next to values and survives rows being moved; the first is easier to read
in the source. The cell form is probably better.

```sh
hedgesync calc https://md.example.com/abc
```

## Engine

- **References:** `A1` style within the table (columns by letter, rows from
  the first data row), `B` for "this row, column B", ranges `B2:B9`, and
  maybe header names (`Price*Qty`).
- **Functions:** sum, avg, min, max, count, round, if. Enough for budgets
  and stats; anything bigger is a spreadsheet's job.
- **Numbers:** parse `1,234.50`, `1.234,50 €`, `12 %` by a locale setting,
  write results in the column's existing format.
- **Evaluation:** a small expression parser, never `eval`: a note's
  editors must not be able to run code on the daemon's machine.
- **Cycles:** detected and shown as `#CYCLE` in the cell.

## When it runs

After a change to the table settles (half a second of quiet), only the
cells whose value differs are rewritten, as one live edit. The daemon's own
edits don't trigger it again (it ignores its own change events, like
`macro`).

## Relation to what exists

`macro` already watches remote edits and rewrites matches; this is a macro
whose match is a whole table. It could ship as a built-in macro type
(`hedgesync macro <url> --calc`) instead of a command of its own.

## Open questions

- **Cross-table references** (`Budget!D4`): useful for a summary table,
  needs table names (a heading or a comment above the table).
- **Neovim:** the plugin could compute locally on save, without a daemon,
  using the same parser through the bridge. Nice, but a daemon serves the
  browser users too.
- **RPG sheets:** a character note with `Str 14 | Mod <!-- =floor((A-10)/2) -->`
  would be a lightweight sheet. The RPG tools elsewhere already do rules
  properly; this would be for quick homebrew.

## Suggested first step

The cell form, A1 references, ranges and the basic functions, as `macro
--calc`, with unit tests of the parser and the table rewriting. About a
day and a half.
