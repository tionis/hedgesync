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
 */

import { HedgeDocClient, PandocTransformer } from '../src/index.js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ANSI colors for terminal output
const colors = {
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

const c = (color, text) => `${colors[color]}${text}${colors.reset}`;

// Parse command line arguments
function parseArgs(args) {
  const parsed = {
    command: null,
    positional: [],
    options: {},
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];
      
      if (nextArg && !nextArg.startsWith('-')) {
        parsed.options[key] = nextArg;
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
function parseUrl(url) {
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
function getConnectionOptions(args) {
  const url = args.positional[0] || args.options.url || args.options.u;
  const cookie = args.options.cookie || args.options.c || process.env.HEDGEDOC_COOKIE;
  
  if (!url) {
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
function printHelp() {
  console.log(`
${c('bold', 'hedgesync')} - HedgeDoc CLI for document manipulation

${c('yellow', 'USAGE:')}
  hedgesync <command> <url> [options] [arguments]

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
  ${c('green', 'transform')}   Transform document with pandoc
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
  
  # With authentication cookie
  hedgesync get https://md.example.com/abc123 -c 'connect.sid=...'
`);
}

// Connect to HedgeDoc and return client
async function connect(args, options = {}) {
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
    await new Promise((resolve) => {
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
    console.error(c('red', `Error connecting: ${error.message}`));
    process.exit(1);
  }
}

// Read input from stdin
async function readStdin() {
  const chunks = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// Command: get
async function cmdGet(args) {
  const client = await connect(args);
  
  try {
    const content = client.getDocument();
    const output = args.options.output || args.options.o;
    
    if (output) {
      await Bun.write(output, content);
      console.error(c('green', `✓ Written to ${output}`));
    } else {
      console.log(content);
    }
  } finally {
    client.disconnect();
  }
}

// Command: set
async function cmdSet(args) {
  const client = await connect(args);
  
  try {
    let content;
    const file = args.options.file || args.options.f;
    
    if (file) {
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
async function cmdAppend(args) {
  const client = await connect(args);
  
  try {
    let text;
    const file = args.options.file || args.options.f;
    
    if (file) {
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
async function cmdPrepend(args) {
  const client = await connect(args);
  
  try {
    let text;
    const file = args.options.file || args.options.f;
    
    if (file) {
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
async function cmdInsert(args) {
  const client = await connect(args);
  
  try {
    const position = parseInt(args.positional[1], 10);
    
    if (isNaN(position)) {
      console.error(c('red', 'Error: Position must be a number'));
      process.exit(1);
    }
    
    let text;
    const file = args.options.file || args.options.f;
    
    if (file) {
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
async function cmdReplace(args) {
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
    const flags = args.options.flags || (all ? 'g' : '');
    
    let pattern;
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
async function cmdLine(args) {
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
      
      let content;
      const file = args.options.file || args.options.f;
      
      if (file) {
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
async function cmdWatch(args) {
  const client = await connect(args);
  
  const json = args.options.json;
  const quiet = args.options.quiet || args.options.q;
  
  if (!quiet && !json) {
    console.error(c('cyan', 'Watching for changes... (Ctrl+C to stop)'));
  }
  
  let lastContent = client.getDocument();
  
  client.on('document', (content) => {
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
  
  client.on('users', (users) => {
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
  
  client.on('disconnect', (reason) => {
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
async function cmdInfo(args) {
  const client = await connect(args);
  
  try {
    // Wait for refresh to complete
    await new Promise(resolve => {
      client.once('refresh', resolve);
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
async function cmdUsers(args) {
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

// Command: transform
async function cmdTransform(args) {
  const client = await connect(args);
  
  try {
    if (!client.canEdit()) {
      console.error(c('red', 'Error: No edit permission for this document'));
      process.exit(1);
    }
    
    const format = args.positional[1] || 'markdown';
    const pandoc = new PandocTransformer();
    
    const doc = client.getDocument();
    const quiet = args.options.quiet || args.options.q;
    
    // Check what operation to perform
    if (args.options.demote) {
      // Demote headers by one level
      await pandoc.applyToClient(client, (ast) => {
        pandoc.walkAST(ast, (el) => {
          if (el.t === 'Header') {
            el.c[0] = Math.min(el.c[0] + 1, 6);
          }
        });
        return ast;
      });
      if (!quiet) console.error(c('green', '✓ Headers demoted'));
    } else if (args.options.promote) {
      // Promote headers by one level
      await pandoc.applyToClient(client, (ast) => {
        pandoc.walkAST(ast, (el) => {
          if (el.t === 'Header') {
            el.c[0] = Math.max(el.c[0] - 1, 1);
          }
        });
        return ast;
      });
      if (!quiet) console.error(c('green', '✓ Headers promoted'));
    } else if (args.options.to) {
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

// Command: exec (run a script)
async function cmdExec(args) {
  const scriptPath = args.positional[1];
  
  if (!scriptPath) {
    console.error(c('red', 'Error: Script path required'));
    console.error('Usage: hedgesync exec <script.js> [url]');
    process.exit(1);
  }
  
  if (!existsSync(scriptPath)) {
    console.error(c('red', `Error: Script not found: ${scriptPath}`));
    process.exit(1);
  }
  
  // Import and run the script
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
async function main() {
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
      case 'transform':
        await cmdTransform(args);
        break;
      case 'exec':
        await cmdExec(args);
        break;
      default:
        console.error(c('red', `Unknown command: ${args.command}`));
        console.error(`Run 'hedgesync help' for usage information.`);
        process.exit(1);
    }
  } catch (error) {
    console.error(c('red', `Error: ${error.message}`));
    if (args.options.debug) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
