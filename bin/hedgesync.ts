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

import { HedgeDocClient, PandocTransformer, MacroEngine } from '../src/index.js';
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
  const multiValueOptions = new Set(['text', 'regex', 'exec']);

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

// Print help message
function printHelp(): void {
  console.log(`
${c('bold', 'hedgesync')} - HedgeDoc CLI for document manipulation

${c('yellow', 'USAGE:')}
  hedgesync <command> <url> [options] [arguments]

${c('yellow', 'COMMANDS:')}
  ${c('green', 'get')}         Get document content
  ${c('green', 'get --authors')} Get document with authorship information
  ${c('green', 'set')}         Set document content (from stdin or file)
  ${c('green', 'append')}      Append text to document
  ${c('green', 'prepend')}     Prepend text to document
  ${c('green', 'insert')}      Insert text at position
  ${c('green', 'replace')}     Search and replace in document
  ${c('green', 'line')}        Get or set a specific line
  ${c('green', 'watch')}       Watch document for changes
  ${c('green', 'info')}        Get note metadata
  ${c('green', 'users')}       List online users
  ${c('green', 'authors')}     List document authors and their contributions
  ${c('green', 'transform')}   Transform document with pandoc
  ${c('green', 'macro')}       Run macros on document (expand triggers, watch mode)
  ${c('green', 'help')}        Show this help message

${c('yellow', 'ARGUMENTS:')}
  ${c('cyan', '<url>')}          Full HedgeDoc URL (required, e.g., https://md.example.com/abc123)

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-c, --cookie')}   Session cookie for authentication (or HEDGEDOC_COOKIE env var)
  ${c('cyan', '-f, --file')}     Read content from file
  ${c('cyan', '-o, --output')}   Write output to file
  ${c('cyan', '-q, --quiet')}    Suppress non-essential output
  ${c('cyan', '--json')}         Output in JSON format
  ${c('cyan', '--no-reconnect')} Disable auto-reconnection
  ${c('cyan', '-r, --regex')}    Treat search pattern as regex (for replace)
  ${c('cyan', '-a, --all')}      Replace all occurrences (for replace)

${c('yellow', 'EXAMPLES:')}
  # Get document content
  hedgesync get https://md.example.com/abc123
  
  # Set document from stdin
  echo "# Hello" | hedgesync set https://md.example.com/abc123
  
  # Set document from file
  hedgesync set https://md.example.com/abc123 -f document.md
  
  # Append text
  hedgesync append https://md.example.com/abc123 "New content"
  
  # Search and replace
  hedgesync replace https://md.example.com/abc123 "old" "new"
  
  # Regex replace all
  hedgesync replace https://md.example.com/abc123 "\\d+" "NUM" --regex --all
  
  # Watch for changes
  hedgesync watch https://md.example.com/abc123
  
  # Get line 5 (0-indexed)
  hedgesync line https://md.example.com/abc123 5
  
  # Set line 5
  hedgesync line https://md.example.com/abc123 5 "New line content"
  
  # Run macros once (expand all triggers)
  hedgesync macro https://md.example.com/abc123 --text "::date::=\\$(date -I)"
  
  # Run macros in watch mode (continuously expand triggers)
  hedgesync macro https://md.example.com/abc123 --watch --text "::date::=\\$(date -I)"
  
  # Load macros from config file
  hedgesync macro https://md.example.com/abc123 --config macros.json --watch
  
  # Execute shell command with regex captures as arguments
  # {0} = full match, {1}, {2}... = capture groups
  hedgesync macro https://md.example.com/abc123 --exec '/::calc\\s+(.+?)::/i:bc -l <<< {1}'
  
  # Embed file contents: ::file path/to/file.txt::
  hedgesync macro https://md.example.com/abc123 --exec '/::file\\s+(.+?)::/i:cat {1}'
  
  # Run a script with arguments: ::run myscript.sh arg1 arg2::
  hedgesync macro https://md.example.com/abc123 --exec '/::run\\s+(\\S+)\\s*(.*?)::/:./{1} {2}'
  
  # Stream long command output (shows progress)
  hedgesync macro https://md.example.com/abc123 --exec '/::slow::/i:sleep 1; echo done' --stream
  
  # With authentication cookie
  hedgesync get https://md.example.com/abc123 -c 'connect.sid=...'
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
  const quiet = args.options.quiet || args.options.q;
  
  if (!quiet && !json) {
    console.error(c('cyan', 'Watching for changes... (Ctrl+C to stop)'));
  }
  
  let lastContent = client.getDocument();
  
  client.on('document', (content: string) => {
    if (content !== lastContent) {
      if (json) {
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
  
  client.on('users', (users: Array<{ name?: string; id: string }>) => {
    if (json) {
      console.log(JSON.stringify({
        type: 'users',
        timestamp: new Date().toISOString(),
        users: users,
      }));
    } else if (!quiet) {
      console.error(c('dim', `Online: ${users.map(u => u.name || u.id).join(', ')}`));
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
    
    const info = client.getNoteInfo();
    const json = args.options.json;
    
    if (json) {
      console.log(JSON.stringify(info, null, 2));
    } else {
      console.log(`${c('bold', 'Title:')} ${info.title || '(untitled)'}`);
      console.log(`${c('bold', 'Permission:')} ${info.permission}`);
      console.log(`${c('bold', 'Owner:')} ${info.owner || '(none)'}`);
      console.log(`${c('bold', 'Created:')} ${info.createtime ? new Date(info.createtime).toLocaleString() : 'unknown'}`);
      console.log(`${c('bold', 'Updated:')} ${info.updatetime ? new Date(info.updatetime).toLocaleString() : 'unknown'}`);
      console.log(`${c('bold', 'Revision:')} ${client.getRevision()}`);
      console.log(`${c('bold', 'Length:')} ${client.getDocument().length} characters`);
      console.log(`${c('bold', 'Lines:')} ${client.getLineCount()}`);
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
  const streamOutput = args.options.stream || args.options.s;
  
  // Create macro engine
  const engine = new MacroEngine(client);
  
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
    const match = macro.match(/^(.+?)=(.+)$/);
    if (!match) {
      console.error(c('red', `Invalid text macro format: ${macro}`));
      process.exit(1);
    }
    
    const [, trigger, replacement] = match;
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
    
    const buildCommand = (fullMatch: string, ...groups: string[]): string => {
      let cmd = cmdTemplate;
      cmd = cmd.replace(/\{0\}/g, fullMatch);
      groups.forEach((g, i) => {
        cmd = cmd.replace(new RegExp(`\\{${i + 1}\\}`, 'g'), g || '');
      });
      return cmd;
    };
    
    if (streamOutput) {
      engine.addStreamingExecMacro(`exec:${pattern}`, regex, buildCommand, {
        lineBuffered: true,
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
    } else {
      engine.addRegexMacro(`exec:${pattern}`, regex, async (fullMatch: string, ...groups: string[]) => {
        const cmd = buildCommand(fullMatch, ...groups);
        
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
  
  if (!args.command || args.command === 'help' || args.options.help || args.options.h) {
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
