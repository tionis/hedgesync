#!/usr/bin/env bun
/**
 * Manual/Interactive test script for hedgesync
 * Run with: bun run test/manual-test.js
 */

import { HedgeDocClient, MacroEngine, PandocTransformer } from '../src/index.js';
import { isPandocAvailable } from '../src/pandoc-transformer.js';

const SERVER_URL = 'https://md.tionis.dev';
const NOTE_ID = '49vCOEWsR0KR6UowrEV8Kg';

const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function log(msg) {
  console.log(msg);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Simple readline for user input
async function prompt(question) {
  process.stdout.write(question);
  for await (const line of console) {
    return line.trim();
  }
}

async function main() {
  log(c.bold(c.cyan('\n🧪 hedgesync Manual Test\n')));
  log(c.dim(`Server: ${SERVER_URL}`));
  log(c.dim(`Note:   ${NOTE_ID}\n`));
  
  // Connect
  log(c.bold('🔌 Connecting...'));
  const client = new HedgeDocClient({
    serverUrl: SERVER_URL,
    noteId: NOTE_ID
  });
  
  await client.connect();
  log(c.green('✓ Connected!\n'));
  
  // Show current doc
  log(c.bold('📄 Current document:'));
  log(c.dim('─'.repeat(40)));
  log(client.getDocument());
  log(c.dim('─'.repeat(40)));
  log('');
  
  // Menu
  while (true) {
    log(c.bold('\nChoose a test:'));
    log('  1. Watch for changes (10 seconds)');
    log('  2. Test macro engine (adds ::date:: macro)');
    log('  3. Append timestamped line');
    log('  4. Show online users');
    log('  5. Reset document to clean state');
    log('  6. Test undo/redo');
    log('  7. Convert to HTML (pandoc)');
    log('  8. Show document');
    log('  q. Quit');
    
    const choice = await prompt(c.cyan('\nChoice: '));
    
    switch (choice) {
      case '1':
        log(c.yellow('\nWatching for changes for 10 seconds...'));
        log(c.dim('(Make edits in the browser to see them here)'));
        
        const changeHandler = (event) => {
          if (event.type === 'remote') {
            log(c.green(`\n📝 Remote change detected!`));
          }
        };
        const docHandler = (doc) => {
          log(c.dim(`Document now ${doc.length} chars`));
        };
        
        client.on('change', changeHandler);
        client.on('document', docHandler);
        
        await sleep(10000);
        
        client.off('change', changeHandler);
        client.off('document', docHandler);
        log(c.yellow('\nDone watching.'));
        break;
        
      case '2':
        log(c.yellow('\nSetting up macro engine...'));
        const engine = new MacroEngine(client);
        
        // Add date macro
        engine.addTextMacro('::date::', () => new Date().toISOString().split('T')[0]);
        engine.addTextMacro('::time::', () => new Date().toLocaleTimeString());
        engine.addTextMacro('::now::', () => new Date().toISOString());
        
        log(c.green('✓ Macros registered:'));
        log(c.dim('  ::date:: → current date (YYYY-MM-DD)'));
        log(c.dim('  ::time:: → current time'));
        log(c.dim('  ::now::  → full ISO timestamp'));
        
        engine.start();
        log(c.yellow('\nMacro engine started. Type a trigger in the document to expand it.'));
        log(c.dim('Watching for 30 seconds...'));
        
        await sleep(30000);
        
        engine.stop();
        log(c.yellow('\nMacro engine stopped.'));
        break;
        
      case '3':
        const timestamp = new Date().toISOString();
        const line = `\n- Entry at ${timestamp}`;
        client.insert(client.getDocument().length, line);
        await sleep(500);
        log(c.green(`✓ Appended: "${line.trim()}"`));
        break;
        
      case '4':
        const users = client.getOnlineUsers();
        log(c.bold('\n👥 Online users:'));
        if (users.size === 0) {
          log(c.dim('  No other users online'));
        } else {
          for (const [id, user] of users) {
            log(`  - ${user.name || 'Anonymous'} (${user.color || 'no color'})`);
          }
        }
        break;
        
      case '5':
        log(c.yellow('\nResetting document...'));
        const cleanDoc = `# Hedgedsync test document (freely)

This is a test document for the hedgesync library.
Feel free to edit it!

---
Last reset: ${new Date().toISOString()}
`;
        client.setContent(cleanDoc);
        await sleep(500);
        log(c.green('✓ Document reset to clean state'));
        break;
        
      case '6':
        log(c.yellow('\nTesting undo/redo...'));
        
        // Clear history
        client.clearHistory();
        
        // Make a change
        const marker = `\n<!-- UNDO TEST ${Date.now()} -->`;
        client.insert(client.getDocument().length, marker);
        await sleep(600);
        log(c.dim(`Added marker: ${marker.trim()}`));
        
        // Check undo
        if (client.canUndo()) {
          log(c.dim('Can undo: yes'));
          client.undo();
          await sleep(500);
          log(c.green('✓ Undid the change'));
          
          if (client.canRedo()) {
            log(c.dim('Can redo: yes'));
            client.redo();
            await sleep(500);
            log(c.green('✓ Redid the change'));
          }
        } else {
          log(c.red('Cannot undo (no history)'));
        }
        break;
        
      case '7':
        if (await isPandocAvailable()) {
          const transformer = new PandocTransformer();
          const html = await transformer.convert(client.getDocument(), 'markdown', 'html');
          log(c.bold('\n📄 HTML output:'));
          log(c.dim('─'.repeat(40)));
          log(html);
          log(c.dim('─'.repeat(40)));
        } else {
          log(c.red('Pandoc not available'));
        }
        break;
        
      case '8':
        log(c.bold('\n📄 Current document:'));
        log(c.dim('─'.repeat(40)));
        log(client.getDocument());
        log(c.dim('─'.repeat(40)));
        break;
        
      case 'q':
      case 'Q':
        log(c.yellow('\nDisconnecting...'));
        client.disconnect();
        log(c.green('✓ Goodbye!'));
        process.exit(0);
        break;
        
      default:
        log(c.red('Invalid choice'));
    }
  }
}

main().catch(err => {
  console.error(c.red(`Error: ${err.message}`));
  process.exit(1);
});
