/**
 * Help text for each command.
 */

import { c } from './ui.js';

export const helpText: Record<string, () => string> = {
  get: () => `
${c('bold', 'hedgesync get')} - Get document content

${c('yellow', 'USAGE:')}
  hedgesync get <url> [options]

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-o, --output')}   Write output to file
  ${c('cyan', '--json')}         Output in JSON format
  ${c('cyan', '--authors')}      Include authorship information

${c('yellow', 'EXAMPLES:')}
  hedgesync get https://md.example.com/abc123
  hedgesync get https://md.example.com/abc123 -o backup.md
  hedgesync get https://md.example.com/abc123 --authors --json
`,

  set: () => `
${c('bold', 'hedgesync set')} - Set document content

${c('yellow', 'USAGE:')}
  hedgesync set <url> [options]

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-f, --file')}     Read content from file (otherwise reads from stdin)
  ${c('cyan', '--json')}         Output result in JSON format
  ${c('cyan', '-q, --quiet')}    Suppress success message

${c('yellow', 'EXAMPLES:')}
  echo "# Hello" | hedgesync set https://md.example.com/abc123
  hedgesync set https://md.example.com/abc123 -f document.md
`,

  replace: () => `
${c('bold', 'hedgesync replace')} - Search and replace in document

${c('yellow', 'USAGE:')}
  hedgesync replace <url> <search> <replacement> [options]

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-r, --regex')}    Treat search pattern as regex
  ${c('cyan', '-a, --all')}      Replace all occurrences (not just first; also --global)
  ${c('cyan', '--flags <f>')}    Regular expression flags, e.g. i (case-insensitive), m, s
  ${c('cyan', '--json')}         Output result in JSON format
  ${c('cyan', '-q, --quiet')}    Suppress success message

${c('yellow', 'EXAMPLES:')}
  hedgesync replace https://md.example.com/abc123 "old" "new"
  hedgesync replace https://md.example.com/abc123 "\\\\d+" "NUM" --regex --all
  hedgesync replace https://md.example.com/abc123 "todo" "TODO" --all --flags i
`,

  macro: () => `
${c('bold', 'hedgesync macro')} - Run macros on document (auto-expand triggers)

Macros watch a HedgeDoc document and automatically replace patterns with
computed values. When a user types a trigger pattern, it gets expanded.

${c('yellow', 'USAGE:')}
  hedgesync macro <url> [options]

${c('yellow', 'MACRO TYPES:')}
  ${c('cyan', '--text')}         Simple text replacement
                    Format: ${c('dim', "'trigger=replacement'")}
                    Example: --text '::sig::=— Signed by Bot'
                    When user types "::sig::" it becomes "— Signed by Bot"

  ${c('cyan', '--regex')}        Regex pattern replacement
                    Format: ${c('dim', "'/pattern/flags=replacement'")}
                    Example: --regex '/TODO/gi=DONE'
                    All "TODO" (case-insensitive) becomes "DONE"

  ${c('cyan', '--exec')}         Execute shell command on match
                    Format: ${c('dim', "'/pattern/flags:shell-command'")}
                    The matched text is replaced with command output.
                    Use {0} for full match, {1},{2}... for capture groups.
                    If the command fails, the trigger is left unchanged.
                    Example: --exec '/::calc\\s+(.+?)::/i:echo {1} | bc -l'
                    "::calc 2+2::" becomes "4"

  ${c('cyan', '--block')}        Transform multi-line content blocks
                    Format: ${c('dim', "'blockname:shell-command'")}
                    See BLOCK MACROS section below for details.

  ${c('cyan', '--built-in')}     Enable built-in macros (::date::, ::uuid::, etc.)
  ${c('cyan', '--config')}       Load macro definitions from JSON file

${c('yellow', 'EXEC OPTIONS:')}
  ${c('cyan', '--stream')}       Stream command output into document as it runs.
                    Useful for slow commands (LLMs, builds) to show progress.

  ${c('cyan', '--track-state')}  Keep the trigger and mark it instead of deleting it.
                    Appends "→" while running, "✓" when done ("✗" on failure);
                    marked triggers never run again. Output goes on the next line.

  ${c('cyan', '--timeout')} <s>  Kill exec/block commands after this many seconds.

${c('yellow', 'FILTER OPTIONS:')}
  In --watch mode only text touched by someone else's edit can trigger a
  macro; macro output never triggers macros.

  ${c('cyan', '--allow-user')} <id>  Only edits by this HedgeDoc account id trigger macros.
                    Repeatable. Account ids cannot be spoofed, so this is the
                    option to use when running exec/block macros.
                    Find an id with: hedgesync me <server-url> -c <cookie>

  ${c('cyan', '--user-filter')}  Only trigger macros for edits from users matching this
                    regex pattern. Matches against the user's display name,
                    which users choose themselves: a convenience, not security.
                    Example: --user-filter 'Alice|Bob' (only Alice or Bob)

${c('yellow', 'SECTION FILTER OPTIONS:')}
  ${c('cyan', '--section-heading')} <pattern>
                    Only apply macros within sections under matching headings.
                    Matches heading text with regex. Includes content until 
                    next heading at same or higher level.
                    Example: --section-heading 'Scripts' (only in ## Scripts section)
                    Example: --section-heading 'TODO|Tasks' (multiple sections)

  ${c('cyan', '--section-lines')} <start>-<end>
                    Only apply macros within specified line range.
                    Line numbers are 1-indexed.
                    Example: --section-lines 10-50 (lines 10 through 50)
                    Example: --section-lines 100- (line 100 to end)

  ${c('cyan', '--section-regex')} <start>/<end>
                    Only apply macros between regex delimiter matches.
                    Useful for fenced regions or custom markers.
                    Example: --section-regex '<!-- MACROS -->/' '<!-- /MACROS -->'
                    Example: --section-regex '\\[\\[START\\]\\]'/'\\[\\[END\\]\\]'

${c('yellow', 'MODE OPTIONS:')}
  ${c('cyan', '--watch')}        Run continuously, expanding triggers as they appear.
                    Without --watch, macros run once and exit.

${c('yellow', '─────────────────────────────────────────────────────────────────────────────')}
${c('yellow', 'DOCUMENT CONTEXT PLACEHOLDERS')}
${c('yellow', '─────────────────────────────────────────────────────────────────────────────')}

When using --exec, you can access the full document in your command:

  ${c('cyan', '{0}')}       The full matched text (the trigger itself)
  ${c('cyan', '{1}')}       First capture group from the regex
  ${c('cyan', '{2}...')}    Additional capture groups
  ${c('cyan', '{DOC}')}     ${c('bold', 'The entire document content')}
  ${c('cyan', '{BEFORE}')}  All text before the match
  ${c('cyan', '{AFTER}')}   All text after the match

${c('green', 'Example: Summarize document with an LLM')}
  
  Document contains:
    # My Notes
    Some long content here...
    ::summarize::
    More content...

  Command:
    hedgesync macro <url> --exec '/::summarize::/i:llm "Summarize: {DOC}"' --stream

  The LLM receives the entire document text as one argument. Output
  replaces "::summarize::".

Placeholder values are passed to the shell as environment variables
(HS_0, HS_1, HS_DOC, ...), never pasted into the command text, so note
content cannot inject shell syntax. Write placeholders bare or inside
quotes; either way each one expands to exactly one argument.

${c('green', 'Example: Generate conclusion from preceding text')}

  hedgesync macro <url> --exec '/::conclude::/i:llm "Write conclusion for: {BEFORE}"'

  Uses only the text before the trigger as context.

${c('yellow', '─────────────────────────────────────────────────────────────────────────────')}
${c('yellow', 'BLOCK MACROS')}
${c('yellow', '─────────────────────────────────────────────────────────────────────────────')}

Block macros transform content between special markers. Unlike --exec which
replaces a single trigger, --block operates on multi-line regions.

${c('green', 'Syntax in document:')}
  ::BEGIN:blockname::
  content line 1
  content line 2
  ...
  ::END:blockname::

${c('green', 'How it works:')}
  1. The content between BEGIN and END is extracted
  2. Content is piped to stdin of the shell command
  3. Command output replaces the entire block (including markers)

${c('green', 'Example: Sort a list')}

  CLI:
    hedgesync macro <url> --block 'sort:sort' --watch

  Document before:
    Shopping list:
    ::BEGIN:sort::
    bananas
    apples
    milk
    eggs
    ::END:sort::

  Document after (markers removed, content sorted):
    Shopping list:
    apples
    bananas
    eggs
    milk

${c('green', 'Example: Convert to uppercase')}

  CLI:
    hedgesync macro <url> --block 'upper:tr a-z A-Z' --watch

  Document:
    ::BEGIN:upper::
    hello world
    ::END:upper::

  Result:
    HELLO WORLD

${c('green', 'Example: Number lines')}

  CLI:
    hedgesync macro <url> --block 'number:nl -ba' --watch

${c('green', 'Example: Format as markdown table')}

  CLI:
    hedgesync macro <url> --block 'table:column -t -s ","' --watch

  Document:
    ::BEGIN:table::
    Name,Age,City
    Alice,30,NYC
    Bob,25,LA
    ::END:table::

${c('green', 'Multiple block handlers:')}
  hedgesync macro <url> --block 'sort:sort' --block 'upper:tr a-z A-Z' --watch

${c('yellow', '─────────────────────────────────────────────────────────────────────────────')}
${c('yellow', 'MORE EXAMPLES')}
${c('yellow', '─────────────────────────────────────────────────────────────────────────────')}

${c('green', 'Calculator:')}
  hedgesync macro <url> --exec '/::calc\\s+(.+?)::/i:echo {1} | bc -l' --watch
  "::calc 2+2::" → "4"
  "::calc sqrt(2)::" → "1.41421356..."

${c('green', 'Embed file contents:')}
  hedgesync macro <url> --exec '/::file\\s+(.+?)::/i:cat {1}' --watch
  "::file README.md::" → (contents of README.md)

${c('green', 'Current date/time:')}
  hedgesync macro <url> --exec '/::now::/i:date' --watch
  "::now::" → "Tue Dec 10 14:30:00 UTC 2025"

${c('green', 'LLM with streaming and state tracking:')}
  hedgesync macro <url> \\
    --exec '/::ask\\s+(.+?)::/i:llm "{1}"' \\
    --stream --track-state --watch

  "::ask What is 2+2?::" → "::ask What is 2+2?::→" (running) → "::ask What is 2+2?::✓"
  with the answer streamed in on the following lines.

${c('green', 'Load from config file:')}
  hedgesync macro <url> --config macros.json --watch

${c('yellow', 'SECURITY NOTE:')}
  Anyone who can edit the note can trigger your exec/block macros and choose
  their input. Note content cannot inject shell syntax, but the command still
  acts on it: "cat {1}" lets collaborators read any file you can, and
  "bash -c {1}" runs whatever they write. Use --allow-user to restrict who
  can trigger macros, and only template commands that are safe for any input.
`,

  watch: () => `
${c('bold', 'hedgesync watch')} - Watch document for changes in real-time

${c('yellow', 'USAGE:')}
  hedgesync watch <url> [options]

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '--json')}         Output changes as formatted JSON
  ${c('cyan', '--ndjson')}       Output as newline-delimited JSON (for scripting)
  ${c('cyan', '-e, --events')}   Watch all events with detailed info (ops, users, cursors)
  ${c('cyan', '-q, --quiet')}    Suppress connection status messages

${c('yellow', 'OUTPUT MODES:')}
  ${c('green', 'Default:')}      Prints full document on each change
  ${c('green', '--events:')}     Prints each operation with user info, positions, etc.
  ${c('green', '--ndjson:')}     Machine-readable, one JSON object per line

${c('yellow', 'EVENTS (--events mode):')}
  ${c('cyan', 'change')}         Document edit (insert/delete with user info)
  ${c('cyan', 'cursor:focus')}   User focused their cursor
  ${c('cyan', 'cursor:activity')} User cursor position changed
  ${c('cyan', 'cursor:blur')}    User unfocused
  ${c('cyan', 'user:left')}      User disconnected
  ${c('cyan', 'users')}          Online user list update
  ${c('cyan', 'connect')}        Connected to server
  ${c('cyan', 'disconnect')}     Lost connection
  ${c('cyan', 'permission')}     Permission change

${c('yellow', 'EXAMPLES:')}
  # Watch and print document on changes
  hedgesync watch https://md.example.com/abc123

  # Watch all events in detail (debug/monitor)
  hedgesync watch https://md.example.com/abc123 --events

  # Machine-readable output for piping to other tools
  hedgesync watch https://md.example.com/abc123 --events --ndjson | jq .

  # Watch with JSON output
  hedgesync watch https://md.example.com/abc123 --json

${c('yellow', 'USE CASES:')}
  - Debug HedgeDoc collaboration issues
  - Monitor document activity
  - Build integrations (pipe --ndjson to scripts)
  - Watch for specific changes
`,

  mirror: () => `
${c('bold', 'hedgesync mirror')} - Sync two HedgeDoc documents in real-time

${c('yellow', 'USAGE:')}
  hedgesync mirror <source-url> <target-url> [options]

${c('yellow', 'DESCRIPTION:')}
  Copies the source document to the target, then keeps the target in sync
  with every edit to the source until interrupted (Ctrl+C). In one-way mode,
  edits made directly to the target are overwritten by the next source edit.

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-c, --cookie')}   Session cookie for both documents (shared server)
  ${c('cyan', '--source-cookie')} Session cookie for source server only
  ${c('cyan', '--target-cookie')} Session cookie for target server only
  ${c('cyan', '--bidirectional')} Sync changes both ways (two-way mirror)
  ${c('cyan', '-q, --quiet')}    Suppress status messages
  ${c('cyan', '--json')}         Output sync events as JSON

${c('yellow', 'TRANSFORM OPTIONS:')}
  ${c('cyan', '--demote')}       Demote headers by one level in target
  ${c('cyan', '--promote')}      Promote headers by one level in target
  ${c('cyan', '--shift <n>')}    Shift header levels by n in target
  ${c('cyan', '--prepend <text>')} Add text at start of target document
  ${c('cyan', '--append <text>')}  Add text at end of target document
  ${c('cyan', '--wrap-prefix <p>')} Wrap each paragraph with prefix
  ${c('cyan', '--wrap-suffix <s>')} Wrap each paragraph with suffix

${c('yellow', 'FILTER OPTIONS:')} (repeatable; one-way only)
  ${c('cyan', '--strip <name>')}  Remove <!-- name --> ... <!-- /name --> blocks and
                    ::name ...:: inline spans
  ${c('cyan', '--only <name>')}   Keep only the content of those blocks and spans
  ${c('cyan', '--strip-heading <regex>')} Remove sections whose heading matches
                    (with their subsections)
  ${c('cyan', '--replace /re/flags=text')} Rewrite matches ($1, $& work)
  ${c('cyan', '--filter <cmd>')}  Pipe the text through a shell command

  Filters fail closed, to keep secrets secret: a block that is not closed
  hides everything after it, as does a comment still being typed
  (<!-- g...), and when --filter fails the target is not updated. The
  target is updated after a 1 s pause in typing. The source should be
  readable by fewer people than the target; mirror warns if it is not.

${c('yellow', 'BIDIRECTIONAL MODE:')}
  Edits on either side are copied to the other. When both notes change at
  once, both sets of edits are kept: each side's changes since the last sync
  are combined with operational transformation (the same merge HedgeDoc
  uses for simultaneous typing). Transforms only work one-way.

  With --json, sync events are printed one per line: ${c('cyan', 'ready')}, ${c('cyan', 'initial-sync')},
  ${c('cyan', 'sync')}, ${c('cyan', 'merge')}, ${c('cyan', 'resync')}, ${c('cyan', 'disconnect')}, ${c('cyan', 'reconnect')}, ${c('cyan', 'error')}.

${c('yellow', 'EXAMPLES:')}
  ${c('dim', '# One-way mirror: source changes flow to target')}
  hedgesync mirror https://md.example.com/source https://md.example.com/target

  ${c('dim', '# Two-way sync: changes in either doc sync to the other')}
  hedgesync mirror https://md.example.com/doc1 https://md.example.com/doc2 --bidirectional

  ${c('dim', '# Mirror with header demotion (for embedding as subsection)')}
  hedgesync mirror https://md.example.com/src https://md.example.com/dest --demote

  ${c('dim', '# A player handout from the GM\'s notes, without the secrets')}
  hedgesync mirror https://md.example.com/gm https://md.example.com/players --strip gm

  ${c('dim', '# Cross-server mirroring with different cookies')}
  hedgesync mirror https://md1.example.com/abc https://md2.example.com/xyz \\
    --source-cookie "session=xxx" --target-cookie "session=yyy"

  ${c('dim', '# Mirror with prefix/suffix for commenting')}
  hedgesync mirror https://md.example.com/draft https://md.example.com/review \\
    --wrap-prefix "> " --wrap-suffix "\\n<!-- end quote -->"

${c('yellow', 'USE CASES:')}
  - Keep backup document in sync automatically
  - Mirror public doc to internal wiki
  - Create derivative documents with transformations
  - Collaborative review (bidirectional sync)
  - Cross-server document replication
`,

  transform: () => `
${c('bold', 'hedgesync transform')} - Transform document with pandoc

${c('yellow', 'USAGE:')}
  hedgesync transform <url> [options]

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '--to <format>')}  Convert to format (html, latex, etc.)
  ${c('cyan', '--demote')}       Demote all headers by one level
  ${c('cyan', '--promote')}      Promote all headers by one level
  ${c('cyan', '--shift <n>')}    Shift header levels by n
  ${c('cyan', '--json')}         Output result in JSON format
  ${c('cyan', '-q, --quiet')}    Suppress success message

${c('yellow', 'EXAMPLES:')}
  hedgesync transform https://md.example.com/abc123 --demote
  hedgesync transform https://md.example.com/abc123 --to html
`,

  authors: () => `
${c('bold', 'hedgesync authors')} - List document authors and contributions

${c('yellow', 'USAGE:')}
  hedgesync authors <url> [options]

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-v, --verbose')}  Show detailed authorship with timestamps
  ${c('cyan', '--json')}         Output in JSON format

${c('yellow', 'EXAMPLES:')}
  hedgesync authors https://md.example.com/abc123
  hedgesync authors https://md.example.com/abc123 -v
  hedgesync authors https://md.example.com/abc123 --json
`,

  line: () => `
${c('bold', 'hedgesync line')} - Get or set a specific line

${c('yellow', 'USAGE:')}
  hedgesync line <url> <line-number> [<new-content> | -f <file>]

${c('yellow', 'ARGUMENTS:')}
  ${c('cyan', '<line-number>')}  Line number (0-indexed)
  ${c('cyan', '[new-content]')}  If provided (or --file), sets the line content

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-f, --file')}     Set the line to a file's content (its final newline dropped)
  ${c('cyan', '--json')}         Output result in JSON format
  ${c('cyan', '-q, --quiet')}    Suppress success message

${c('yellow', 'EXAMPLES:')}
  hedgesync line https://md.example.com/abc123 0        # Get first line
  hedgesync line https://md.example.com/abc123 0 "# Title"  # Set first line
`,

  append: () => `
${c('bold', 'hedgesync append')} - Append text to document

${c('yellow', 'USAGE:')}
  hedgesync append <url> [<text> | -f <file>]   (else stdin)

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-f, --file')}     Read the text from a file (otherwise the argument, else stdin)
  ${c('cyan', '--json')}         Output result in JSON format
  ${c('cyan', '-q, --quiet')}    Suppress success message

${c('yellow', 'EXAMPLES:')}
  hedgesync append https://md.example.com/abc123 "New content at end"
  echo "More text" | hedgesync append https://md.example.com/abc123
`,

  prepend: () => `
${c('bold', 'hedgesync prepend')} - Prepend text to document

${c('yellow', 'USAGE:')}
  hedgesync prepend <url> [<text> | -f <file>]  (else stdin)

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-f, --file')}     Read the text from a file (otherwise the argument, else stdin)
  ${c('cyan', '--json')}         Output result in JSON format
  ${c('cyan', '-q, --quiet')}    Suppress success message

${c('yellow', 'EXAMPLES:')}
  hedgesync prepend https://md.example.com/abc123 "Content at start"
  hedgesync prepend https://md.example.com/abc123 -f header.md
`,

  insert: () => `
${c('bold', 'hedgesync insert')} - Insert text at position

${c('yellow', 'USAGE:')}
  hedgesync insert <url> <position> [<text> | -f <file>]  (else stdin)

${c('yellow', 'ARGUMENTS:')}
  ${c('cyan', '<position>')}     Character position (0-indexed)
  ${c('cyan', '<text>')}         Text to insert (or --file, or stdin)

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-f, --file')}     Read the text from a file (otherwise the argument, else stdin)
  ${c('cyan', '--json')}         Output result in JSON format
  ${c('cyan', '-q, --quiet')}    Suppress success message

${c('yellow', 'EXAMPLES:')}
  hedgesync insert https://md.example.com/abc123 0 "Start: "
  hedgesync insert https://md.example.com/abc123 100 "[inserted]"
`,

  info: () => `
${c('bold', 'hedgesync info')} - Get note metadata

${c('yellow', 'USAGE:')}
  hedgesync info <url> [options]

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '--json')}         Output in JSON format

${c('yellow', 'EXAMPLES:')}
  hedgesync info https://md.example.com/abc123
  hedgesync info https://md.example.com/abc123 --json
`,


  download: () => `
${c('bold', 'hedgesync download')} - Download note content via HTTP API

${c('yellow', 'USAGE:')}
  hedgesync download <url> [options]

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-o, --output')}   Write output to file
  ${c('cyan', '--json')}         Output result in JSON format

${c('yellow', 'EXAMPLES:')}
  hedgesync download https://md.example.com/abc123
  hedgesync download https://md.example.com/abc123 -o note.md
`,

  create: () => `
${c('bold', 'hedgesync create')} - Create a new note

${c('yellow', 'USAGE:')}
  hedgesync create <server-url> [options]

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-n, --name')}     Custom alias/name for the note (requires FreeURL mode)
  ${c('cyan', '-f, --file')}     Initial content from file
  ${c('cyan', '-p, --permission')} <value>
                 Set the permission right away (requires login; one of freely,
                 editable, limited, locked, protected, private; see
                 hedgesync permission --help)
  ${c('cyan', '-q, --quiet')}    Only output the new note ID
  ${c('cyan', '--json')}         Output result in JSON format

${c('yellow', 'EXAMPLES:')}
  # Create empty note with random ID
  hedgesync create https://md.example.com

  # Create note with custom alias (requires FreeURL mode)
  hedgesync create https://md.example.com -n my-note-name

  # Create note with initial content
  echo "# Hello World" | hedgesync create https://md.example.com
  hedgesync create https://md.example.com -f document.md

  # Private note, only visible to you
  hedgesync create https://md.example.com -f secret.md -p private
`,


  me: () => `
${c('bold', 'hedgesync me')} - Show current user profile

${c('yellow', 'USAGE:')}
  hedgesync me <server-url> [options]

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '--json')}         Output in JSON format

${c('yellow', 'EXAMPLES:')}
  hedgesync me https://md.example.com -c 'connect.sid=...'
  HEDGEDOC_COOKIE='connect.sid=...' hedgesync me https://md.example.com
`,

  'export': () => `
${c('bold', 'hedgesync export')} - Export all user notes as a zip archive

${c('yellow', 'USAGE:')}
  hedgesync export <server-url> -o <output-file> [options]

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-o, --output')}   Output file path (required, should end in .zip)
  ${c('cyan', '--json')}         Output result in JSON format

${c('yellow', 'EXAMPLES:')}
  hedgesync export https://md.example.com -o my-notes.zip -c 'connect.sid=...'
`,

  history: () => `
${c('bold', 'hedgesync history')} - Show note history

${c('yellow', 'USAGE:')}
  hedgesync history <server-url> [options]

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '--json')}         Output in JSON format
  ${c('cyan', '--pinned')}       Show only pinned notes
  ${c('cyan', '--delete')}       Delete entire history (use with caution!)

${c('yellow', 'EXAMPLES:')}
  hedgesync history https://md.example.com -c 'connect.sid=...'
  hedgesync history https://md.example.com --pinned
  hedgesync history https://md.example.com --delete
`,

  pin: () => `
${c('bold', 'hedgesync pin')} - Pin or unpin a note in history

${c('yellow', 'USAGE:')}
  hedgesync pin <url> [options]
  hedgesync unpin <url> [options]

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '--json')}         Output result in JSON format

${c('yellow', 'EXAMPLES:')}
  hedgesync pin https://md.example.com/abc123
  hedgesync unpin https://md.example.com/abc123
`,

  'history-delete': () => `
${c('bold', 'hedgesync history-delete')} - Delete a note from history

${c('yellow', 'USAGE:')}
  hedgesync history-delete <url> [options]

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '--json')}         Output result in JSON format

${c('yellow', 'EXAMPLES:')}
  hedgesync history-delete https://md.example.com/abc123
`,

  status: () => `
${c('bold', 'hedgesync status')} - Show server status

${c('yellow', 'USAGE:')}
  hedgesync status <server-url> [options]

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '--json')}         Output in JSON format

${c('yellow', 'EXAMPLES:')}
  hedgesync status https://md.example.com
  hedgesync status https://md.example.com --json
`,


  bridge: () => `
${c('bold', 'hedgesync bridge')} - Live-edit a note from an editor plugin

${c('yellow', 'USAGE:')}
  hedgesync bridge <url> [options]

${c('yellow', 'DESCRIPTION:')}
  Connects to the note and exchanges edits, cursors and status with an editor
  plugin as newline-delimited JSON on stdin/stdout, keystroke by keystroke.
  Started by the Neovim plugin in editors/nvim; not meant to be run by hand.
  Exits (after flushing edits) when stdin closes. Status goes to stderr.

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '--no-reconnect')} Do not reconnect a dropped session
  ${c('cyan', '--info')}         Print the protocol version as JSON and exit (no URL)
`,
  editor: () => `
${c('bold', 'hedgesync editor')} - Install the editor plugin bundled with this binary

${c('yellow', 'USAGE:')}
  hedgesync editor nvim install    [--dir <path>] [--lazy [--lazy-file <path>]] [--force]
  hedgesync editor nvim status     [--dir <path>]
  hedgesync editor nvim path       [--dir <path>]
  hedgesync editor nvim uninstall  [--dir <path>] [--force]

${c('yellow', 'DESCRIPTION:')}
  The Neovim plugin for live editing (:Hedge open <url>) ships inside this
  binary, so the installed copy always matches the bridge it talks to. Run
  install again after updating hedgesync. By default it goes into Neovim's
  package directory, stdpath("data")/site/pack/hedgesync/start/hedgesync.nvim
  (respects NVIM_APPNAME and XDG_DATA_HOME).

  lazy.nvim does not load that directory. --lazy also writes a lazy.nvim spec
  for the plugin to stdpath("config")/lua/plugins/hedgesync.lua (or
  --lazy-file), which lazy.nvim's { import = "plugins" } picks up. Later
  installs keep it current, and uninstall removes it, unless you edited it.
  An existing file with other content is only replaced with --force.

  status exits with 1 unless the installed copy matches this binary. Files
  you edited are never overwritten or removed without --force.

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '--dir <path>')}   Install somewhere else
  ${c('cyan', '--lazy')}         Also write a lazy.nvim spec into the Neovim config
  ${c('cyan', '--lazy-file <path>')} Write the spec there instead (implies --lazy)
  ${c('cyan', '--force')}        Overwrite or remove local changes
  ${c('cyan', '--json')}         Machine-readable output
`,
  edit: () => `
${c('bold', 'hedgesync edit')} - Open a note in your editor

${c('yellow', 'USAGE:')}
  hedgesync edit <url> [--editor <cmd>] [--no-live]
  hedgesync edit [<server-url>]        Browse your notes (Neovim)
  hedgesync edit --new [<server-url>] <file>   Write a file together

${c('yellow', 'DESCRIPTION:')}
  Opens the note in --editor, $VISUAL or $EDITOR (default: nvim).

  Neovim edits live: every keystroke is sent as you type, and others' edits
  and cursors appear in your buffer. Uses the bundled plugin; if your config
  does not load it, the copy matching this binary is loaded for the session
  (an unedited installed copy from another version is updated).

  Other editors get the note in a temp file. Each save is merged into the
  note, keeping edits others made meanwhile, and once more when the editor
  exits. Changes others make are not shown in the file.

  Without a note, Neovim opens :Hedge browse: the notes in your history on
  that server (or your saved login's), to open, pin, create or search, with
  revisions to view, diff and restore.

  --new makes a note from <file> (on that server, or your saved login's),
  prints its link for others to join, and opens it like any note. When the
  editor exits successfully, the note's final text is written back to the
  file. Made for git: write a commit message or tag together with whoever
  you are pairing with (see the examples). If the editor fails, the file is
  left as it was.

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-e, --editor <cmd>')} Editor command line (may include arguments)
  ${c('cyan', '--no-live')}          Use the temp-file mode even with Neovim
  ${c('cyan', '--no-reconnect')}     Do not reconnect a dropped session
  ${c('cyan', '--new')}              Create a note from <file> and write the result back
  ${c('cyan', '--delete-after')}     With --new: delete the note afterwards (needs a login)
  ${c('cyan', '-p, --permission <p>')} With --new: the note's permission

${c('yellow', 'EXAMPLES:')}
  hedgesync edit https://md.example.com/abc123
  hedgesync edit https://md.example.com/abc123 -e "code --wait"
  hedgesync edit                        # browse your notes in Neovim

  ${c('dim', '# A commit message written together (or: git config alias.pair-commit ...)')}
  GIT_EDITOR="hedgesync edit --new --delete-after" git commit
  git config alias.pair-commit '!GIT_EDITOR="hedgesync edit --new --delete-after" git commit'
`,
};
