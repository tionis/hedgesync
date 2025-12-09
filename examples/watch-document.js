/**
 * Watch Document Example
 * 
 * Connects to a HedgeDoc document and watches for changes in real-time.
 * Useful for building integrations that need to react to document updates.
 * 
 * Usage:
 *   node examples/watch-document.js <server-url> <note-id>
 * 
 * Press Ctrl+C to exit.
 */

import { HedgeDocClient } from '../src/index.js';

const serverUrl = process.argv[2];
const noteId = process.argv[3];

if (!serverUrl || !noteId) {
  console.error('Usage: node examples/watch-document.js <server-url> <note-id>');
  process.exit(1);
}

async function main() {
  console.log(`Watching ${serverUrl}/${noteId}...\n`);
  
  const client = new HedgeDocClient({ serverUrl, noteId });

  // Track document changes
  let lastContent = '';
  let changeCount = 0;

  client.on('connect', () => {
    console.log('✓ Connected');
  });

  client.on('ready', ({ document, revision }) => {
    lastContent = document;
    console.log(`✓ Document loaded (revision ${revision})`);
    console.log(`  Length: ${document.length} characters`);
    console.log('');
    console.log('Watching for changes... (Ctrl+C to exit)\n');
  });

  client.on('refresh', (info) => {
    console.log(`Note: "${info.title}" (${info.permission})`);
  });

  client.on('document', (content) => {
    if (content !== lastContent) {
      changeCount++;
      const timestamp = new Date().toISOString();
      
      // Calculate simple diff info
      const lengthDiff = content.length - lastContent.length;
      const sign = lengthDiff >= 0 ? '+' : '';
      
      console.log(`[${timestamp}] Change #${changeCount}: ${sign}${lengthDiff} chars (total: ${content.length})`);
      
      lastContent = content;
    }
  });

  client.on('users', (users) => {
    console.log(`Online: ${users.length} user(s)`);
  });

  client.on('user:left', (id) => {
    console.log(`User left: ${id}`);
  });

  client.on('disconnect', (reason) => {
    console.log('Disconnected:', reason);
    process.exit(0);
  });

  client.on('error', (error) => {
    console.error('Error:', error.message);
  });

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\nDisconnecting...');
    client.disconnect();
    console.log(`Total changes observed: ${changeCount}`);
    process.exit(0);
  });

  try {
    await client.connect();
  } catch (error) {
    console.error('Failed to connect:', error.message);
    process.exit(1);
  }
}

main();
