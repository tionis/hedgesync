#!/usr/bin/env bun
/**
 * hedgesync CLI - Command-line interface for HedgeDoc document manipulation
 * 
 * Usage:
 *   hedgesync <command> [options]
 * 
 * Commands:
 *   get      - Get document content
 *   set      - Set document content
 *   append   - Append text to document
 *   prepend  - Prepend text to document
 *   replace  - Search and replace in document
 *   watch    - Watch document for changes
 *   info     - Get note metadata
 *   users    - List online users
 *   macro    - Run macros on document
 */

import { HedgeDocClient, PandocTransformer, MacroEngine, UserInfo } from '../src/index.js';
import type { StreamingMacro, DocumentContext } from '../src/macro-engine.js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Types
interface ParsedArgs {
  command: string | null;
  positional: string[];
  options: Record<string, string | string[] | boolean>;
}

interface ConnectionOptions {
  serverUrl: string;
  noteId: string;
  cookie?: string;
}

interface ParsedUrl {
  serverUrl: string;
  noteId: string;
}

// ANSI colors for terminal output
const colors: Record<string, string> = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

const c = (color: string, text: string): string => `${colors[color]}${text}${colors.reset}`;

// Parse command line arguments
function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: null,
    positional: [],
    options: {},
  };

  // Options that can be specified multiple times (will be collected into arrays)
  const multiValueOptions = new Set(['text', 'regex', 'exec', 'block']);

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];
      
      if (nextArg && !nextArg.startsWith('-')) {
        if (multiValueOptions.has(key)) {
          // Collect multiple values into an array
          if (!parsed.options[key]) {
            parsed.options[key] = [];
          }
          (parsed.options[key] as string[]).push(nextArg);
        } else {
          parsed.options[key] = nextArg;
        }
        i += 2;
      } else {
        parsed.options[key] = true;
        i += 1;
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const key = arg.slice(1);
      const nextArg = args[i + 1];
      
      if (nextArg && !nextArg.startsWith('-')) {
        parsed.options[key] = nextArg;
        i += 2;
      } else {
        parsed.options[key] = true;
        i += 1;
      }
    } else {
      if (!parsed.command) {
        parsed.command = arg;
      } else {
        parsed.positional.push(arg);
      }
      i += 1;
    }
  }

  return parsed;
}

// Parse a HedgeDoc URL into server URL and note ID
function parseUrl(url: string): ParsedUrl | null {
  if (!url) return null;
  
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    
    if (pathParts.length === 0) {
      return null;
    }
    
    const noteId = pathParts[pathParts.length - 1];
    const serverUrl = `${parsed.protocol}//${parsed.host}`;
    
    return { serverUrl, noteId };
  } catch {
    // Not a valid URL
    return null;
  }
}

// Get connection options from args (URL is required as argument)
function getConnectionOptions(args: ParsedArgs): ConnectionOptions | null {
  const url = args.positional[0] || args.options.url || args.options.u;
  const cookie = (args.options.cookie || args.options.c || process.env.HEDGEDOC_COOKIE) as string | undefined;
  
  if (!url || typeof url !== 'string') {
    return null;
  }
  
  // Parse the URL
  const parsed = parseUrl(url);
  
  if (parsed) {
    return {
      serverUrl: parsed.serverUrl,
      noteId: parsed.noteId,
      cookie,
    };
  }
  
  // URL parsing failed
  return null;
}

// Subcommand-specific help texts
const subcommandHelp: Record<string, string> = {
  get: `
${c('bold', 'hedgesync get')} - Get document content

${c('yellow', 'USAGE:')}
  hedgesync get <url> [options]

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-c, --cookie')}   Session cookie for authentication
  ${c('cyan', '-o, --output')}   Write output to file
  ${c('cyan', '--json')}         Output in JSON format
  ${c('cyan', '--authors')}      Include authorship information

${c('yellow', 'EXAMPLES:')}
  hedgesync get https://md.example.com/abc123
  hedgesync get https://md.example.com/abc123 -o backup.md
  hedgesync get https://md.example.com/abc123 --authors --json
`,

  set: `
${c('bold', 'hedgesync set')} - Set document content

${c('yellow', 'USAGE:')}
  hedgesync set <url> [options]

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-c, --cookie')}   Session cookie for authentication
  ${c('cyan', '-f, --file')}     Read content from file (otherwise reads from stdin)

${c('yellow', 'EXAMPLES:')}
  echo "# Hello" | hedgesync set https://md.example.com/abc123
  hedgesync set https://md.example.com/abc123 -f document.md
`,

  replace: `
${c('bold', 'hedgesync replace')} - Search and replace in document

${c('yellow', 'USAGE:')}
  hedgesync replace <url> <search> <replacement> [options]

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-c, --cookie')}   Session cookie for authentication
  ${c('cyan', '-r, --regex')}    Treat search pattern as regex
  ${c('cyan', '-a, --all, -g')}  Replace all occurrences (not just first)

${c('yellow', 'EXAMPLES:')}
  hedgesync replace https://md.example.com/abc123 "old" "new"
  hedgesync replace https://md.example.com/abc123 "\\\\d+" "NUM" --regex --all
`,

  macro: `
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

  ${c('cyan', '--track-state')}  Prevent re-triggering while command runs.
                    Appends "→" while running, changes to "✓" when done.
                    Example: "::ask hi::" → "::ask hi::→" → "::ask hi::✓ Hello!"

${c('yellow', 'FILTER OPTIONS:')}
  ${c('cyan', '--user-filter')}  Only trigger macros for edits from users matching this
                    regex pattern. Matches against the user's display name.
                    Example: --user-filter 'Alice|Bob' (only Alice or Bob)
                    Example: --user-filter '^Guest' (only guest users)

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

  The {DOC} placeholder is replaced with the entire document text, so the
  LLM receives the full context. Output replaces "::summarize::".

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

  "::ask What is 2+2?::" → "::ask What is 2+2::→" → "::ask What is 2+2::✓ 2+2 equals 4."

${c('green', 'Load from config file:')}
  hedgesync macro <url> --config macros.json --watch

${c('yellow', 'SHELL EXECUTION NOTE:')}
  Commands run via 'sh -c "command"'. Use single quotes in the command
  template to prevent the outer shell from expanding variables:
  ${c('dim', "--exec \"/::run (.+?)::/i:bash -c '{1}'\"")}

${c('yellow', 'SECURITY NOTE:')}
  Exec and block macros run arbitrary shell commands. Only use on documents
  you trust. Malicious document content could execute harmful commands.
`,

  watch: `
${c('bold', 'hedgesync watch')} - Watch document for changes in real-time

${c('yellow', 'USAGE:')}
  hedgesync watch <url> [options]

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-c, --cookie')}   Session cookie for authentication
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

  transform: `
${c('bold', 'hedgesync transform')} - Transform document with pandoc

${c('yellow', 'USAGE:')}
  hedgesync transform <url> [options]

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-c, --cookie')}   Session cookie for authentication
  ${c('cyan', '--to <format>')}  Convert to format (html, latex, etc.)
  ${c('cyan', '--demote')}       Demote all headers by one level
  ${c('cyan', '--promote')}      Promote all headers by one level
  ${c('cyan', '--shift <n>')}    Shift header levels by n

${c('yellow', 'EXAMPLES:')}
  hedgesync transform https://md.example.com/abc123 --demote
  hedgesync transform https://md.example.com/abc123 --to html
`,

  authors: `
${c('bold', 'hedgesync authors')} - List document authors and contributions

${c('yellow', 'USAGE:')}
  hedgesync authors <url> [options]

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-c, --cookie')}   Session cookie for authentication
  ${c('cyan', '-v, --verbose')}  Show detailed authorship with timestamps
  ${c('cyan', '--json')}         Output in JSON format

${c('yellow', 'EXAMPLES:')}
  hedgesync authors https://md.example.com/abc123
  hedgesync authors https://md.example.com/abc123 -v
  hedgesync authors https://md.example.com/abc123 --json
`,

  line: `
${c('bold', 'hedgesync line')} - Get or set a specific line

${c('yellow', 'USAGE:')}
  hedgesync line <url> <line-number> [new-content]

${c('yellow', 'ARGUMENTS:')}
  ${c('cyan', '<line-number>')}  Line number (0-indexed)
  ${c('cyan', '[new-content]')}  If provided, sets the line content

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-c, --cookie')}   Session cookie for authentication

${c('yellow', 'EXAMPLES:')}
  hedgesync line https://md.example.com/abc123 0        # Get first line
  hedgesync line https://md.example.com/abc123 0 "# Title"  # Set first line
`,

  append: `
${c('bold', 'hedgesync append')} - Append text to document

${c('yellow', 'USAGE:')}
  hedgesync append <url> <text>

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-c, --cookie')}   Session cookie for authentication

${c('yellow', 'EXAMPLES:')}
  hedgesync append https://md.example.com/abc123 "New content at end"
  echo "More text" | hedgesync append https://md.example.com/abc123
`,

  prepend: `
${c('bold', 'hedgesync prepend')} - Prepend text to document

${c('yellow', 'USAGE:')}
  hedgesync prepend <url> <text>

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-c, --cookie')}   Session cookie for authentication

${c('yellow', 'EXAMPLES:')}
  hedgesync prepend https://md.example.com/abc123 "Content at start"
`,

  insert: `
${c('bold', 'hedgesync insert')} - Insert text at position

${c('yellow', 'USAGE:')}
  hedgesync insert <url> <position> <text>

${c('yellow', 'ARGUMENTS:')}
  ${c('cyan', '<position>')}     Character position (0-indexed)
  ${c('cyan', '<text>')}         Text to insert

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-c, --cookie')}   Session cookie for authentication

${c('yellow', 'EXAMPLES:')}
  hedgesync insert https://md.example.com/abc123 0 "Start: "
  hedgesync insert https://md.example.com/abc123 100 "[inserted]"
`,

  info: `
${c('bold', 'hedgesync info')} - Get note metadata

${c('yellow', 'USAGE:')}
  hedgesync info <url> [options]

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-c, --cookie')}   Session cookie for authentication
  ${c('cyan', '--json')}         Output in JSON format

${c('yellow', 'EXAMPLES:')}
  hedgesync info https://md.example.com/abc123
  hedgesync info https://md.example.com/abc123 --json
`,

  users: `
${c('bold', 'hedgesync users')} - List online users

${c('yellow', 'USAGE:')}
  hedgesync users <url> [options]

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-c, --cookie')}   Session cookie for authentication
  ${c('cyan', '--json')}         Output in JSON format

${c('yellow', 'EXAMPLES:')}
  hedgesync users https://md.example.com/abc123
`
};

// Print main help message (overview)
function printHelp(subcommand?: string): void {
  // If a specific subcommand is requested and exists, show its help
  if (subcommand && subcommandHelp[subcommand]) {
    console.log(subcommandHelp[subcommand]);
    return;
  }
  
  // Show overview help
  console.log(`
${c('bold', 'hedgesync')} - HedgeDoc CLI for document manipulation

${c('yellow', 'USAGE:')}
  hedgesync <command> <url> [options]
  hedgesync help <command>          ${c('dim', '# Show help for a specific command')}

${c('yellow', 'COMMANDS:')}
  ${c('green', 'get')}         Get document content
  ${c('green', 'set')}         Set document content (from stdin or file)
  ${c('green', 'append')}      Append text to document
  ${c('green', 'prepend')}     Prepend text to document
  ${c('green', 'insert')}      Insert text at position
  ${c('green', 'replace')}     Search and replace in document
  ${c('green', 'line')}        Get or set a specific line
  ${c('green', 'watch')}       Watch document for changes
  ${c('green', 'info')}        Get note metadata
  ${c('green', 'users')}       List online users
  ${c('green', 'authors')}     List document authors and contributions
  ${c('green', 'transform')}   Transform document with pandoc
  ${c('green', 'macro')}       Run macros on document (expand triggers)
  ${c('green', 'help')}        Show help (use 'help <command>' for details)

${c('yellow', 'GLOBAL OPTIONS:')}
  ${c('cyan', '-c, --cookie')}   Session cookie for authentication (or HEDGEDOC_COOKIE env var)
  ${c('cyan', '-q, --quiet')}    Suppress non-essential output
  ${c('cyan', '--no-reconnect')} Disable auto-reconnection

${c('yellow', 'EXAMPLES:')}
  hedgesync get https://md.example.com/abc123
  hedgesync set https://md.example.com/abc123 -f doc.md
  hedgesync replace https://md.example.com/abc123 "old" "new" --all
  hedgesync macro https://md.example.com/abc123 --exec '/::date::/i:date' --watch

${c('yellow', 'MORE HELP:')}
  hedgesync help get       ${c('dim', '# Help for get command')}
  hedgesync help macro     ${c('dim', '# Help for macro command (detailed)')}
`);
}

// Connect to HedgeDoc and return client
async function connect(args: ParsedArgs, options: Record<string, unknown> = {}): Promise<HedgeDocClient> {
  const connOpts = getConnectionOptions(args);
  
  if (!connOpts || !connOpts.serverUrl || !connOpts.noteId) {
    console.error(c('red', 'Error: URL is required'));
    console.error('Usage: hedgesync <command> <url> [options]');
    console.error('Example: hedgesync get https://md.example.com/abc123');
    process.exit(1);
  }
  
  const quiet = args.options.quiet || args.options.q;
  
  if (!quiet) {
    console.error(c('dim', `Connecting to ${connOpts.serverUrl}/${connOpts.noteId}...`));
  }
  
  const client = new HedgeDocClient({
    ...connOpts,
    reconnect: {
      enabled: !args.options['no-reconnect'],
    },
    ...options,
  });
  
  try {
    await client.connect();
    
    // Wait for refresh event to get permissions
    await new Promise<void>((resolve) => {
      if (client.noteInfo.permission) {
        resolve();
      } else {
        const timeout = setTimeout(resolve, 1000);
        client.once('refresh', () => {
          clearTimeout(timeout);
          resolve();
        });
      }
    });
    
    if (!quiet) {
      console.error(c('green', '✓ Connected'));
    }
    
    return client;
  } catch (error) {
    console.error(c('red', `Error connecting: ${(error as Error).message}`));
    process.exit(1);
  }
}

// Read input from stdin
async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// Command: get
async function cmdGet(args: ParsedArgs): Promise<void> {
  const client = await connect(args);
  
  try {
    const showAuthors = args.options.authors || args.options.A;
    const json = args.options.json;
    const output = args.options.output || args.options.o;
    
    if (showAuthors) {
      // Wait for refresh data which contains authorship
      await new Promise<void>(resolve => {
        client.once('refresh', () => resolve());
        setTimeout(resolve, 1000);
      });
      
      const result = client.getDocumentWithAuthorship();
      
      if (json) {
        const jsonOutput = {
          content: result.content,
          authors: result.authors,
          authorship: result.authorship.map(s => ({
            userId: s.userId,
            author: s.author?.name || null,
            start: s.start,
            end: s.end,
            text: s.text,
            createdAt: s.createdAt?.toISOString(),
            updatedAt: s.updatedAt?.toISOString()
          }))
        };
        
        if (output && typeof output === 'string') {
          await Bun.write(output, JSON.stringify(jsonOutput, null, 2));
          console.error(c('green', `✓ Written to ${output}`));
        } else {
          console.log(JSON.stringify(jsonOutput, null, 2));
        }
      } else {
        // Human-readable format with colored authorship
        let outputText = '';
        const colorList = ['cyan', 'yellow', 'magenta', 'green', 'blue'];
        const authorColors = new Map<string, string>();
        let colorIndex = 0;
        
        for (const span of result.authorship) {
          const authorId = span.userId || 'anonymous';
          if (!authorColors.has(authorId)) {
            authorColors.set(authorId, colorList[colorIndex % colorList.length]);
            colorIndex++;
          }
          
          const color = authorColors.get(authorId)!;
          outputText += c(color, span.text);
        }
        
        // Print legend
        console.error(c('bold', '=== Authors ==='));
        for (const [authorId, color] of authorColors) {
          const author = result.authors[authorId];
          console.error(c(color, `█ ${author?.name || 'Anonymous'}`));
        }
        console.error();
        
        if (output && typeof output === 'string') {
          // For file output, strip colors
          await Bun.write(output, result.content);
          console.error(c('green', `✓ Written to ${output}`));
        } else {
          console.log(outputText);
        }
      }
    } else {
      const content = client.getDocument();
      
      if (output && typeof output === 'string') {
        await Bun.write(output, content);
        console.error(c('green', `✓ Written to ${output}`));
      } else {
        console.log(content);
      }
    }
  } finally {
    client.disconnect();
  }
}

// Command: set
async function cmdSet(args: ParsedArgs): Promise<void> {
  const client = await connect(args);
  
  try {
    let content: string;
    const file = args.options.file || args.options.f;
    
    if (file && typeof file === 'string') {
      content = readFileSync(resolve(file), 'utf-8');
    } else if (args.positional.length > 1) {
      content = args.positional.slice(1).join(' ');
    } else {
      content = await readStdin();
    }
    
    if (!client.canEdit()) {
      console.error(c('red', 'Error: No edit permission for this document'));
      process.exit(1);
    }
    
    client.updateContent(content);
    
    // Wait a bit for the operation to be sent
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const quiet = args.options.quiet || args.options.q;
    if (!quiet) {
      console.error(c('green', '✓ Document updated'));
    }
  } finally {
    client.disconnect();
  }
}

// Command: append
async function cmdAppend(args: ParsedArgs): Promise<void> {
  const client = await connect(args);
  
  try {
    let text: string;
    const file = args.options.file || args.options.f;
    
    if (file && typeof file === 'string') {
      text = readFileSync(resolve(file), 'utf-8');
    } else if (args.positional.length > 1) {
      text = args.positional.slice(1).join(' ');
    } else {
      text = await readStdin();
    }
    
    if (!client.canEdit()) {
      console.error(c('red', 'Error: No edit permission for this document'));
      process.exit(1);
    }
    
    const doc = client.getDocument();
    const separator = doc.endsWith('\n') ? '' : '\n';
    client.insert(doc.length, separator + text);
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const quiet = args.options.quiet || args.options.q;
    if (!quiet) {
      console.error(c('green', '✓ Content appended'));
    }
  } finally {
    client.disconnect();
  }
}

// Command: prepend
async function cmdPrepend(args: ParsedArgs): Promise<void> {
  const client = await connect(args);
  
  try {
    let text: string;
    const file = args.options.file || args.options.f;
    
    if (file && typeof file === 'string') {
      text = readFileSync(resolve(file), 'utf-8');
    } else if (args.positional.length > 1) {
      text = args.positional.slice(1).join(' ');
    } else {
      text = await readStdin();
    }
    
    if (!client.canEdit()) {
      console.error(c('red', 'Error: No edit permission for this document'));
      process.exit(1);
    }
    
    const separator = text.endsWith('\n') ? '' : '\n';
    client.insert(0, text + separator);
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const quiet = args.options.quiet || args.options.q;
    if (!quiet) {
      console.error(c('green', '✓ Content prepended'));
    }
  } finally {
    client.disconnect();
  }
}

// Command: insert
async function cmdInsert(args: ParsedArgs): Promise<void> {
  const client = await connect(args);
  
  try {
    const position = parseInt(args.positional[1], 10);
    
    if (isNaN(position)) {
      console.error(c('red', 'Error: Position must be a number'));
      process.exit(1);
    }
    
    let text: string;
    const file = args.options.file || args.options.f;
    
    if (file && typeof file === 'string') {
      text = readFileSync(resolve(file), 'utf-8');
    } else if (args.positional.length > 2) {
      text = args.positional.slice(2).join(' ');
    } else {
      text = await readStdin();
    }
    
    if (!client.canEdit()) {
      console.error(c('red', 'Error: No edit permission for this document'));
      process.exit(1);
    }
    
    client.insert(position, text);
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const quiet = args.options.quiet || args.options.q;
    if (!quiet) {
      console.error(c('green', `✓ Inserted at position ${position}`));
    }
  } finally {
    client.disconnect();
  }
}

// Command: replace
async function cmdReplace(args: ParsedArgs): Promise<void> {
  const client = await connect(args);
  
  try {
    const search = args.positional[1];
    const replacement = args.positional[2] || '';
    
    if (!search) {
      console.error(c('red', 'Error: Search pattern required'));
      console.error('Usage: hedgesync replace <url> <search> [replacement]');
      process.exit(1);
    }
    
    if (!client.canEdit()) {
      console.error(c('red', 'Error: No edit permission for this document'));
      process.exit(1);
    }
    
    const isRegex = args.options.regex || args.options.r;
    const all = args.options.all || args.options.a || args.options.g;
    const flags = (args.options.flags as string) || (all ? 'g' : '');
    
    let pattern: RegExp;
    if (isRegex) {
      pattern = new RegExp(search, flags);
    } else {
      // Escape special regex chars for literal search
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      pattern = new RegExp(escaped, flags);
    }
    
    const count = client.replaceRegex(pattern, replacement);
    
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const quiet = args.options.quiet || args.options.q;
    if (!quiet) {
      console.error(c('green', `✓ Replaced ${count} occurrence(s)`));
    }
  } finally {
    client.disconnect();
  }
}

// Command: line
async function cmdLine(args: ParsedArgs): Promise<void> {
  const client = await connect(args);
  
  try {
    const lineNum = parseInt(args.positional[1], 10);
    
    if (isNaN(lineNum) || lineNum < 0) {
      console.error(c('red', 'Error: Line number must be a non-negative integer'));
      process.exit(1);
    }
    
    // Check if we're setting or getting
    if (args.positional.length > 2 || args.options.file || args.options.f) {
      // Setting a line
      if (!client.canEdit()) {
        console.error(c('red', 'Error: No edit permission for this document'));
        process.exit(1);
      }
      
      let content: string;
      const file = args.options.file || args.options.f;
      
      if (file && typeof file === 'string') {
        content = readFileSync(resolve(file), 'utf-8').replace(/\n$/, '');
      } else {
        content = args.positional.slice(2).join(' ');
      }
      
      client.setLine(lineNum, content);
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const quiet = args.options.quiet || args.options.q;
      if (!quiet) {
        console.error(c('green', `✓ Line ${lineNum} updated`));
      }
    } else {
      // Getting a line
      const line = client.getLine(lineNum);
      
      if (line === null) {
        console.error(c('red', `Error: Line ${lineNum} does not exist`));
        process.exit(1);
      }
      
      console.log(line);
    }
  } finally {
    client.disconnect();
  }
}

// Command: watch
async function cmdWatch(args: ParsedArgs): Promise<void> {
  const client = await connect(args);
  
  const json = args.options.json;
  const ndjson = args.options.ndjson;
  const quiet = args.options.quiet || args.options.q;
  const eventsMode = args.options.events || args.options.e;
  
  // Helper to output events
  const outputEvent = (eventType: string, data: unknown) => {
    const timestamp = new Date().toISOString();
    if (ndjson) {
      console.log(JSON.stringify({ event: eventType, timestamp, ...data as object }));
    } else if (json) {
      console.log(JSON.stringify({ type: eventType, timestamp, data }, null, 2));
    } else {
      console.log(c('dim', `[${timestamp}]`) + ' ' + c('cyan', eventType));
      if (data && typeof data === 'object') {
        for (const [key, value] of Object.entries(data as object)) {
          if (value !== undefined && value !== null) {
            const displayValue = typeof value === 'object' 
              ? JSON.stringify(value)
              : String(value);
            console.log(`  ${c('yellow', key)}: ${displayValue}`);
          }
        }
      }
      console.log();
    }
  };
  
  if (!quiet && !json && !ndjson) {
    if (eventsMode) {
      console.error(c('cyan', 'Watching all events... (Ctrl+C to stop)'));
    } else {
      console.error(c('cyan', 'Watching for changes... (Ctrl+C to stop)'));
      console.error(c('dim', 'Tip: Use --events for detailed operation events, --ndjson for scripting'));
    }
  }
  
  if (eventsMode) {
    // Detailed event mode - watch all events with full information
    
    // Change events with operation details
    client.on('change', (event) => {
      const inserts: Array<{position: number, text: string}> = [];
      const deletes: Array<{position: number, length: number}> = [];
      
      if (event.operation) {
        let position = 0;
        for (const op of event.operation.ops) {
          if (typeof op === 'string') {
            inserts.push({ position, text: op });
            position += op.length;
          } else if (op > 0) {
            position += op;
          } else if (op < 0) {
            deletes.push({ position, length: -op });
          }
        }
      }
      
      outputEvent('change', {
        source: event.type,
        clientId: event.clientId,
        user: event.user ? {
          id: event.user.id,
          name: event.user.name,
          color: event.user.color
        } : undefined,
        inserts: inserts.length > 0 ? inserts : undefined,
        deletes: deletes.length > 0 ? deletes : undefined,
        operation: event.operation ? event.operation.ops : undefined
      });
    });
    
    // Cursor events
    client.on('cursor:focus', (user) => {
      outputEvent('cursor:focus', { user });
    });
    
    client.on('cursor:activity', (user) => {
      outputEvent('cursor:activity', { 
        clientId: user.id,
        name: user.name,
        color: user.color,
        cursor: user.cursor
      });
    });
    
    client.on('cursor:blur', (data) => {
      outputEvent('cursor:blur', data);
    });
    
    // User events
    client.on('user:left', (clientId: string) => {
      outputEvent('user:left', { clientId });
    });
    
    client.on('users', (users: Map<string, UserInfo>) => {
      const userList = Array.from(users.entries()).map(([id, user]) => ({
        clientId: id,
        ...user
      }));
      outputEvent('users', { count: userList.length, users: userList });
    });
    
    // Connection events
    client.on('connect', () => {
      outputEvent('connect', {});
    });
    
    client.on('disconnect', (reason: string) => {
      outputEvent('disconnect', { reason });
    });
    
    client.on('reconnect:success', (data) => {
      outputEvent('reconnect:success', data);
    });
    
    // Document events
    client.on('document', (content: string) => {
      outputEvent('document', { 
        length: content.length,
        preview: content.slice(0, 100) + (content.length > 100 ? '...' : '')
      });
    });
    
    // Info/permission events
    client.on('permission', (permission: string) => {
      outputEvent('permission', { permission });
    });
    
    client.on('info', (data) => {
      outputEvent('info', data);
    });
    
  } else {
    // Simple mode - just document changes and users
    let lastContent = client.getDocument();
    
    client.on('document', (content: string) => {
      if (content !== lastContent) {
        if (json || ndjson) {
          console.log(JSON.stringify({
            type: 'change',
            timestamp: new Date().toISOString(),
            content: content,
          }));
        } else {
          console.log(c('dim', `--- ${new Date().toISOString()} ---`));
          console.log(content);
          console.log();
        }
        lastContent = content;
      }
    });
    
    client.on('users', (users: Map<string, UserInfo>) => {
      const userList = Array.from(users.values());
      if (json || ndjson) {
        console.log(JSON.stringify({
          type: 'users',
          timestamp: new Date().toISOString(),
          users: userList,
        }));
      } else if (!quiet) {
        console.error(c('dim', `Online: ${userList.map(u => u.name || u.id).join(', ')}`));
      }
    });
    
    client.on('disconnect', (reason: string) => {
      if (!quiet) {
        console.error(c('yellow', `Disconnected: ${reason}`));
      }
    });
    
    client.on('reconnect:success', () => {
      if (!quiet) {
        console.error(c('green', 'Reconnected'));
      }
    });
  }
  
  // Keep running until interrupted
  process.on('SIGINT', () => {
    client.disconnect();
    process.exit(0);
  });
  
  // Keep the process alive
  await new Promise(() => {});
}

// Command: info
async function cmdInfo(args: ParsedArgs): Promise<void> {
  const client = await connect(args);
  
  try {
    // Wait for refresh to complete
    await new Promise<void>(resolve => {
      client.once('refresh', () => resolve());
      setTimeout(resolve, 1000); // Timeout fallback
    });
    
    // Also request online users
    client.requestOnlineUsers();
    await new Promise(resolve => setTimeout(resolve, 300));
    
    const info = client.getNoteInfo();
    const users = client.getOnlineUsers();
    const json = args.options.json;
    
    if (json) {
      console.log(JSON.stringify({
        ...info,
        revision: client.getRevision(),
        length: client.getDocument().length,
        lines: client.getLineCount(),
        onlineUsers: users
      }, null, 2));
    } else {
      console.log(`${c('bold', 'Title:')} ${info.title || '(untitled)'}`);
      console.log(`${c('bold', 'Permission:')} ${info.permission}`);
      console.log(`${c('bold', 'Owner:')} ${info.owner || '(none)'}`);
      console.log(`${c('bold', 'Created:')} ${info.createtime ? new Date(info.createtime).toLocaleString() : 'unknown'}`);
      console.log(`${c('bold', 'Updated:')} ${info.updatetime ? new Date(info.updatetime).toLocaleString() : 'unknown'}`);
      console.log(`${c('bold', 'Revision:')} ${client.getRevision()}`);
      console.log(`${c('bold', 'Length:')} ${client.getDocument().length} characters`);
      console.log(`${c('bold', 'Lines:')} ${client.getLineCount()}`);
      
      // Show online users
      if (users.length === 0) {
        console.log(`${c('bold', 'Online:')} ${c('dim', '(no other users)')}`);
      } else {
        console.log(`${c('bold', 'Online:')} ${users.length} user${users.length === 1 ? '' : 's'}`);
        for (const user of users) {
          const colorDot = user.color ? c('bold', '●') : '';
          console.log(`  ${colorDot} ${user.name || user.id}${user.id !== user.name ? c('dim', ` (${user.id.slice(0, 8)}...)`) : ''}`);
        }
      }
    }
  } finally {
    client.disconnect();
  }
}

// Command: users
async function cmdUsers(args: ParsedArgs): Promise<void> {
  const client = await connect(args);
  
  try {
    // Request users and wait a moment
    client.requestOnlineUsers();
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const users = client.getOnlineUsers();
    const json = args.options.json;
    
    if (json) {
      console.log(JSON.stringify(users, null, 2));
    } else {
      if (users.length === 0) {
        console.log(c('dim', 'No other users online'));
      } else {
        console.log(c('bold', `Online users (${users.length}):`));
        for (const user of users) {
          console.log(`  - ${user.name || user.id} ${user.color ? `(${user.color})` : ''}`);
        }
      }
    }
  } finally {
    client.disconnect();
  }
}

// Command: authors
async function cmdAuthors(args: ParsedArgs): Promise<void> {
  const client = await connect(args);
  
  try {
    // Wait for refresh data which contains authorship
    await new Promise<void>(resolve => {
      client.once('refresh', () => resolve());
      setTimeout(resolve, 1000);
    });
    
    const result = client.getDocumentWithAuthorship();
    const json = args.options.json;
    const verbose = args.options.verbose || args.options.v;
    
    // Calculate statistics per author
    interface AuthorStat {
      id: string;
      name: string;
      color: string;
      photo: string | null;
      charCount: number;
      spanCount: number;
      firstEdit: Date | null;
      lastEdit: Date | null;
    }
    
    const authorStats = new Map<string, AuthorStat>();
    for (const span of result.authorship) {
      const authorId = span.userId || 'anonymous';
      if (!authorStats.has(authorId)) {
        authorStats.set(authorId, {
          id: authorId,
          name: span.author?.name || 'Anonymous',
          color: span.author?.color || '#888888',
          photo: span.author?.photo || null,
          charCount: 0,
          spanCount: 0,
          firstEdit: span.createdAt,
          lastEdit: span.updatedAt
        });
      }
      const stats = authorStats.get(authorId)!;
      stats.charCount += span.end - span.start;
      stats.spanCount += 1;
      if (span.createdAt && (!stats.firstEdit || span.createdAt < stats.firstEdit)) {
        stats.firstEdit = span.createdAt;
      }
      if (span.updatedAt && (!stats.lastEdit || span.updatedAt > stats.lastEdit)) {
        stats.lastEdit = span.updatedAt;
      }
    }
    
    const totalChars = result.content.length;
    const stats = Array.from(authorStats.values()).sort((a, b) => b.charCount - a.charCount);
    
    if (json) {
      console.log(JSON.stringify({
        totalCharacters: totalChars,
        authorCount: stats.length,
        authors: stats.map(s => ({
          ...s,
          percentage: ((s.charCount / totalChars) * 100).toFixed(1),
          firstEdit: s.firstEdit?.toISOString(),
          lastEdit: s.lastEdit?.toISOString()
        }))
      }, null, 2));
    } else {
      console.log(c('bold', `Document Authors (${stats.length}):`));
      console.log();
      
      for (const stat of stats) {
        const pct = ((stat.charCount / totalChars) * 100).toFixed(1);
        const bar = '█'.repeat(Math.round(parseFloat(pct) / 5));
        
        console.log(`  ${c('cyan', stat.name)}`);
        console.log(`    ${c('dim', bar)} ${pct}% (${stat.charCount} chars, ${stat.spanCount} regions)`);
        
        if (verbose) {
          if (stat.firstEdit) {
            console.log(`    First edit: ${stat.firstEdit.toLocaleString()}`);
          }
          if (stat.lastEdit) {
            console.log(`    Last edit: ${stat.lastEdit.toLocaleString()}`);
          }
          if (stat.id !== 'anonymous') {
            console.log(`    User ID: ${stat.id}`);
          }
        }
        console.log();
      }
    }
  } finally {
    client.disconnect();
  }
}

// Command: transform
async function cmdTransform(args: ParsedArgs): Promise<void> {
  const client = await connect(args);
  
  try {
    if (!client.canEdit()) {
      console.error(c('red', 'Error: No edit permission for this document'));
      process.exit(1);
    }
    
    const pandoc = new PandocTransformer();
    
    const doc = client.getDocument();
    const quiet = args.options.quiet || args.options.q;
    
    // Check what operation to perform
    if (args.options.demote) {
      // Demote headers by one level
      await pandoc.applyToClient(client, (ast) => {
        pandoc.walkAST(ast, (el) => {
          const node = el as { t?: string; c?: unknown[] };
          if (node.t === 'Header' && Array.isArray(node.c)) {
            (node.c as unknown[])[0] = Math.min((node.c[0] as number) + 1, 6);
          }
        });
        return ast;
      });
      if (!quiet) console.error(c('green', '✓ Headers demoted'));
    } else if (args.options.promote) {
      // Promote headers by one level
      await pandoc.applyToClient(client, (ast) => {
        pandoc.walkAST(ast, (el) => {
          const node = el as { t?: string; c?: unknown[] };
          if (node.t === 'Header' && Array.isArray(node.c)) {
            (node.c as unknown[])[0] = Math.max((node.c[0] as number) - 1, 1);
          }
        });
        return ast;
      });
      if (!quiet) console.error(c('green', '✓ Headers promoted'));
    } else if (args.options.to && typeof args.options.to === 'string') {
      // Convert to another format and output
      const output = await pandoc.convert(doc, 'markdown', args.options.to);
      console.log(output);
    } else {
      // Just parse and re-render (normalizes the document)
      const normalized = await pandoc.transform(doc, ast => ast);
      client.updateContent(normalized);
      await new Promise(resolve => setTimeout(resolve, 500));
      if (!quiet) console.error(c('green', '✓ Document normalized'));
    }
  } finally {
    client.disconnect();
  }
}

// Command: macro (run macros on document) - significantly truncated for brevity
async function cmdMacro(args: ParsedArgs): Promise<void> {
  const client = await connect(args);
  
  const quiet = args.options.quiet || args.options.q;
  const json = args.options.json;
  const watchMode = args.options.watch || args.options.w;
  const configFile = args.options.config || args.options.C;
  const textMacros = ([] as string[]).concat((args.options.text || args.options.t || []) as string[]);
  const regexMacros = ([] as string[]).concat((args.options.regex || args.options.r || []) as string[]);
  const execMacros = ([] as string[]).concat((args.options.exec || args.options.e || []) as string[]);
  const blockMacros = ([] as string[]).concat((args.options.block || args.options.B || []) as string[]);
  const streamOutput = args.options.stream || args.options.s;
  const trackState = args.options['track-state'] || args.options.T;
  const userFilterStr = args.options['user-filter'] || args.options.U;
  
  // Parse user filter regex
  let userFilter: RegExp | undefined;
  if (userFilterStr && typeof userFilterStr === 'string') {
    try {
      userFilter = new RegExp(userFilterStr);
      if (!quiet) {
        console.error(c('cyan', `User filter: /${userFilterStr}/ (only matching users trigger macros)`));
      }
    } catch (e) {
      console.error(c('red', `Invalid user filter regex: ${userFilterStr}`));
      process.exit(1);
    }
  }
  
  // Create macro engine with options
  const engine = new MacroEngine(client, { userFilter });
  
  // Built-in macros
  if (args.options['built-in'] || args.options.b) {
    engine.addTextMacro('::date::', () => new Date().toISOString().split('T')[0]);
    engine.addTextMacro('::time::', () => new Date().toTimeString().split(' ')[0]);
    engine.addTextMacro('::datetime::', () => new Date().toISOString());
    engine.addTextMacro('::ts::', () => String(Date.now()));
    
    if (!quiet) {
      console.error(c('cyan', 'Loaded built-in macros: ::date::, ::time::, ::datetime::, ::ts::'));
    }
  }
  
  // Load macros from config file
  if (configFile && typeof configFile === 'string') {
    try {
      const configPath = resolve(process.cwd(), configFile);
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      
      // Text macros from config
      if (config.text) {
        for (const [trigger, replacement] of Object.entries(config.text)) {
          if (typeof replacement === 'string' && replacement.startsWith('$')) {
            const cmd = replacement.slice(1);
            engine.addTextMacro(trigger, async () => {
              const proc = Bun.spawn(['sh', '-c', cmd], { stdout: 'pipe' });
              const text = await new Response(proc.stdout).text();
              return text.trim();
            });
          } else {
            engine.addTextMacro(trigger, replacement as string);
          }
        }
      }
      
      // Regex macros from config
      if (config.regex) {
        for (const [pattern, replacement] of Object.entries(config.regex)) {
          const regex = new RegExp(pattern, 'g');
          if (typeof replacement === 'string' && replacement.startsWith('$')) {
            const cmd = replacement.slice(1);
            engine.addRegexMacro(pattern, regex, async (match: string, ...groups: string[]) => {
              const env: Record<string, string> = { MATCH: match };
              groups.forEach((g, i) => env[`GROUP${i + 1}`] = g || '');
              const proc = Bun.spawn(['sh', '-c', cmd], { stdout: 'pipe', env: { ...process.env, ...env } });
              const text = await new Response(proc.stdout).text();
              return text.trim();
            });
          } else {
            engine.addRegexMacro(pattern, regex, (match: string, ...groups: string[]) => {
              let result = replacement as string;
              groups.forEach((g, i) => {
                result = result.replace(new RegExp(`\\$${i + 1}`, 'g'), g || '');
              });
              result = result.replace(/\$&/g, match);
              return result;
            });
          }
        }
      }
      
      if (!quiet) {
        console.error(c('cyan', `Loaded macros from ${configFile}`));
      }
    } catch (err) {
      console.error(c('red', `Error loading config: ${(err as Error).message}`));
      process.exit(1);
    }
  }
  
  // Add text macros from command line
  for (const macro of textMacros) {
    // Allow empty replacement (pattern=)
    const eqIndex = macro.indexOf('=');
    if (eqIndex === -1 || eqIndex === 0) {
      console.error(c('red', `Invalid text macro format: ${macro}`));
      console.error(c('dim', 'Expected format: trigger=replacement or trigger= (for empty replacement)'));
      process.exit(1);
    }
    
    const trigger = macro.slice(0, eqIndex);
    const replacement = macro.slice(eqIndex + 1);
    if (replacement.startsWith('$(') && replacement.endsWith(')')) {
      const cmd = replacement.slice(2, -1);
      engine.addTextMacro(trigger, async () => {
        const proc = Bun.spawn(['sh', '-c', cmd], { stdout: 'pipe' });
        const text = await new Response(proc.stdout).text();
        return text.trim();
      });
    } else {
      engine.addTextMacro(trigger, replacement);
    }
  }
  
  // Add regex macros from command line
  for (const macro of regexMacros) {
    const match = macro.match(/^\/(.+?)\/([gimsuy]*)=(.+)$/);
    if (!match) {
      console.error(c('red', `Invalid regex macro format: ${macro}`));
      process.exit(1);
    }
    
    const [, pattern, flags, replacement] = match;
    const regex = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
    
    engine.addRegexMacro(pattern, regex, (m: string, ...groups: string[]) => {
      let result = replacement;
      groups.forEach((g, i) => {
        result = result.replace(new RegExp(`\\$${i + 1}`, 'g'), g || '');
      });
      result = result.replace(/\$&/g, m);
      return result;
    });
  }
  
  // Add exec macros from command line
  for (const macro of execMacros) {
    const execMatch = macro.match(/^\/(.+?)\/([gimsuy]*):(.+)$/);
    if (!execMatch) {
      console.error(c('red', `Invalid exec macro format: ${macro}`));
      process.exit(1);
    }
    
    const [, pattern, flags, cmdTemplate] = execMatch;
    const regex = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g');
    
    // Check if command template uses document context placeholders
    const usesDocContext = /\{DOC\}|\{BEFORE\}|\{AFTER\}/.test(cmdTemplate);
    
    const buildCommand = (fullMatch: string, ...groups: string[]): string => {
      let cmd = cmdTemplate;
      cmd = cmd.replace(/\{0\}/g, fullMatch);
      groups.forEach((g, i) => {
        cmd = cmd.replace(new RegExp(`\\{${i + 1}\\}`, 'g'), g || '');
      });
      return cmd;
    };
    
    const buildCommandWithContext = (ctx: { fullDocument: string; beforeMatch: string; afterMatch: string; matchText: string; groups: string[] }): string => {
      let cmd = cmdTemplate;
      // Replace document context placeholders
      // Use shell-safe escaping for document content
      const escapeForShell = (s: string): string => s.replace(/'/g, "'\\''");
      cmd = cmd.replace(/\{DOC\}/g, escapeForShell(ctx.fullDocument));
      cmd = cmd.replace(/\{BEFORE\}/g, escapeForShell(ctx.beforeMatch));
      cmd = cmd.replace(/\{AFTER\}/g, escapeForShell(ctx.afterMatch));
      cmd = cmd.replace(/\{0\}/g, ctx.matchText);
      ctx.groups.forEach((g, i) => {
        cmd = cmd.replace(new RegExp(`\\{${i + 1}\\}`, 'g'), g || '');
      });
      return cmd;
    };
    
    if (streamOutput) {
      engine.addStreamingExecMacro(`exec:${pattern}`, regex, 
        usesDocContext 
          ? (match: string, ...groups: string[]) => buildCommand(match, ...groups)  // Will be overridden by contextCommandBuilder
          : buildCommand, 
        {
          lineBuffered: true,
          trackState: !!trackState,
          useDocumentContext: usesDocContext,
          onStart: (match: string, pos: number) => {
            if (!quiet) {
              console.error(c('dim', `  Streaming: ${buildCommand(match)} at position ${pos}`));
            }
          },
          onEnd: (exitCode: number) => {
            if (!quiet) {
              console.error(c('dim', `  Stream ended (exit: ${exitCode})`));
            }
          },
          onError: (err: Error) => {
            console.error(c('red', `  Stream error: ${err.message}`));
          }
        });
      
      // If using document context, we need to set up a custom context command builder
      if (usesDocContext) {
        const macroEntry = engine.macros.get(`exec:${pattern}`);
        if (macroEntry && macroEntry.type === 'streaming') {
          (macroEntry as StreamingMacro).contextCommandBuilder = (ctx: DocumentContext) => buildCommandWithContext(ctx);
        }
      }
    } else {
      engine.addRegexMacro(`exec:${pattern}`, regex, async (fullMatch: string, ...groups: string[]) => {
        let cmd: string;
        if (usesDocContext) {
          const doc = client.getDocument();
          const idx = doc.indexOf(fullMatch);
          cmd = buildCommandWithContext({
            fullDocument: doc,
            beforeMatch: idx >= 0 ? doc.substring(0, idx) : '',
            afterMatch: idx >= 0 ? doc.substring(idx + fullMatch.length) : '',
            matchText: fullMatch,
            groups
          });
        } else {
          cmd = buildCommand(fullMatch, ...groups);
        }
        
        if (!quiet) {
          console.error(c('dim', `  Executing: ${cmd}`));
        }
      
        try {
          const proc = Bun.spawn(['sh', '-c', cmd], { stdout: 'pipe', stderr: 'pipe' });
          const stdout = await new Response(proc.stdout).text();
          return stdout.trim();
        } catch (err) {
          console.error(c('red', `  Command failed: ${(err as Error).message}`));
          return fullMatch;
        }
      });
    }
  }
  
  // Add block macros from command line
  // Format: --block 'blockname:command'
  // Transforms content between ::BEGIN:blockname:: and ::END:blockname::
  for (const macro of blockMacros) {
    const blockMatch = macro.match(/^(\w+):(.+)$/);
    if (!blockMatch) {
      console.error(c('red', `Invalid block macro format: ${macro}`));
      console.error(c('red', `  Expected: blockname:command (e.g., "sort:sort" or "upper:tr a-z A-Z")`));
      process.exit(1);
    }
    
    const [, blockName, cmdTemplate] = blockMatch;
    
    engine.addBlockMacro(blockName, async (content, ctx) => {
      // Build the command - pass content via stdin
      let cmd = cmdTemplate;
      // Replace placeholders if present
      cmd = cmd.replace(/\{CONTENT\}/g, content);
      cmd = cmd.replace(/\{DOC\}/g, ctx.fullDocument);
      cmd = cmd.replace(/\{BEFORE\}/g, ctx.beforeMatch);
      cmd = cmd.replace(/\{AFTER\}/g, ctx.afterMatch);
      
      if (!quiet) {
        console.error(c('dim', `  Block ${blockName}: ${cmd}`));
      }
      
      try {
        // Pipe content to the command
        const proc = Bun.spawn(['sh', '-c', cmd], { 
          stdout: 'pipe', 
          stderr: 'pipe',
          stdin: new Response(content).body
        });
        const stdout = await new Response(proc.stdout).text();
        return stdout;
      } catch (err) {
        console.error(c('red', `  Block command failed: ${(err as Error).message}`));
        return ctx.matchText; // Return original on error
      }
    });
    
    if (!quiet) {
      console.error(c('cyan', `Registered block macro: ${blockName}`));
    }
  }
  
  // Check if any macros were registered
  const macroList = engine.listMacros();
  if (macroList.length === 0) {
    console.error(c('red', 'Error: No macros defined'));
    process.exit(1);
  }
  
  if (!quiet) {
    console.error(c('cyan', `Registered ${macroList.length} macro(s)`));
  }
  
  if (watchMode) {
    if (!quiet) {
      console.error(c('cyan', '\nWatching for changes... (Ctrl+C to stop)'));
    }
    
    engine.start();
    
    process.on('SIGINT', () => {
      engine.stop();
      client.disconnect();
      process.exit(0);
    });
    
    await new Promise(() => {});
  } else {
    try {
      const results = await engine.expand();
      
      if (json) {
        console.log(JSON.stringify({ results }, null, 2));
      } else {
        if (results.length === 0) {
          if (!quiet) console.error(c('yellow', 'No macros expanded'));
        } else {
          for (const r of results) {
            console.error(c('green', `✓ Expanded ${r.macro}: ${r.matches.length} match(es)`));
          }
        }
      }
      
      if (engine.hasActiveStreams()) {
        if (!quiet) {
          console.error(c('cyan', 'Waiting for streaming macros to complete...'));
        }
        await engine.waitForStreams();
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
    } finally {
      client.disconnect();
    }
  }
}

// Command: exec (run a script)
async function cmdExec(args: ParsedArgs): Promise<void> {
  const scriptPath = args.positional[1];
  
  if (!scriptPath) {
    console.error(c('red', 'Error: Script path required'));
    process.exit(1);
  }
  
  if (!existsSync(scriptPath)) {
    console.error(c('red', `Error: Script not found: ${scriptPath}`));
    process.exit(1);
  }
  
  const script = await import(resolve(scriptPath));
  
  if (typeof script.default === 'function') {
    const client = args.positional[2] ? await connect(args) : null;
    try {
      await script.default(client, args);
    } finally {
      if (client) client.disconnect();
    }
  } else if (typeof script.run === 'function') {
    const client = args.positional[2] ? await connect(args) : null;
    try {
      await script.run(client, args);
    } finally {
      if (client) client.disconnect();
    }
  } else {
    console.error(c('red', 'Error: Script must export a default function or a run function'));
    process.exit(1);
  }
}

// Main entry point
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  
  // Handle help command with optional subcommand
  if (args.command === 'help') {
    const subcommand = args.positional[0];
    printHelp(subcommand);
    process.exit(0);
  }
  
  // Handle --help flag or no command
  if (!args.command || args.options.help || args.options.h) {
    printHelp();
    process.exit(0);
  }
  
  try {
    switch (args.command) {
      case 'get':
        await cmdGet(args);
        break;
      case 'set':
        await cmdSet(args);
        break;
      case 'append':
        await cmdAppend(args);
        break;
      case 'prepend':
        await cmdPrepend(args);
        break;
      case 'insert':
        await cmdInsert(args);
        break;
      case 'replace':
        await cmdReplace(args);
        break;
      case 'line':
        await cmdLine(args);
        break;
      case 'watch':
        await cmdWatch(args);
        break;
      case 'info':
        await cmdInfo(args);
        break;
      case 'users':
        await cmdUsers(args);
        break;
      case 'authors':
        await cmdAuthors(args);
        break;
      case 'transform':
        await cmdTransform(args);
        break;
      case 'macro':
        await cmdMacro(args);
        break;
      case 'exec':
        await cmdExec(args);
        break;
      default:
        console.error(c('red', `Unknown command: ${args.command}`));
        process.exit(1);
    }
  } catch (error) {
    console.error(c('red', `Error: ${(error as Error).message}`));
    if (args.options.debug) {
      console.error((error as Error).stack);
    }
    process.exit(1);
  }
}

main();
