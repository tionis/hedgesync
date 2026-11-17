# Less common hedgesync commands

All take a note URL unless noted; `hedgesync help <command>` has the details
and `--json` gives machine-readable output for most.

| Task | Command |
|---|---|
| Change a line (0-based) | `hedgesync line <url> 3 'new text'` |
| Regex replace | `hedgesync replace <url> '- \[ \]' '- [x]' --regex --all` |
| Insert at a character offset | `hedgesync insert <url> 120 'text'` |
| Note settings (title, tags, type, ...) | `hedgesync meta <url>`, `hedgesync meta <url> tags a b`, `--add-tag x` |
| Who may view/edit | `hedgesync permission <url>`, `hedgesync permission <url> limited` |
| Who wrote what | `hedgesync authors <url>` |
| Who is online | `hedgesync users <url>` |
| Revisions | `hedgesync revisions <url>` (list), `<url> <rev>` (content), `<url> <rev> --diff`, `<url> <rev> --restore` |
| Download without a live session | `hedgesync download <url>` |
| Upload an image, get Markdown | `hedgesync upload <server-url> shot.png` |
| Published / slide URL | `hedgesync publish <url>` |
| Export all notes (zip) | `hedgesync export <server-url> -o notes.zip` |
| History | `hedgesync history <server-url>`, `pin`, `unpin`, `history-delete` |
| Keep a local file and a note in sync | `hedgesync share file.md <server-url>` (new note) or `share file.md <note-url>` |
| Two notes in sync | `hedgesync mirror <url-a> <url-b>` |
| Pandoc transform, heading levels | `hedgesync transform <url> --promote`, `--to <format>` |
| Expand text macros as people type | `hedgesync macro <url> --built-in --watch` |
| Answer @mentions with an LLM | `hedgesync assistant <url> --agent claude` |
| Append to notes from webhooks | `hedgesync serve --note name=<url>` |
| Delete a note (owner only, irreversible) | `hedgesync delete <url>` |

Ask before anything irreversible or visible to others beyond the note at
hand: `delete`, `permission`, `revisions --restore`, and `set` on a note
people are working in.

Permission values: `freely` (anyone edits), `editable` (anyone views, signed-in
users edit), `limited` (signed-in users only), `locked`, `protected`, `private`
(see `hedgesync help permission`).

Logins: `hedgesync login <server> --from-browser <browser> --save` reuses a
browser session; `hedgesync sessions` lists saved ones; `HEDGEDOC_COOKIE`
overrides them.
