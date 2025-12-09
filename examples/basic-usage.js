/**
 * Basic Usage Example
 * 
 * Demonstrates connecting to a HedgeDoc server, reading a document,
 * and making live edits.
 * 
 * Usage:
 *   node examples/basic-usage.js <server-url> <note-id>
 * 
 * Examples:
 *   node examples/basic-usage.js https://hedgedoc.example.com my-note-id
 *   node examples/basic-usage.js https://md.tionis.dev 49vCOEWsR0KR6UowrEV8Kg
 */

import { HedgeDocClient } from '../src/index.js';

// Parse command line arguments
const serverUrl = process.argv[2];
const noteId = process.argv[3];

if (!serverUrl || !noteId) {
  console.error('Usage: node examples/basic-usage.js <server-url> <note-id>');
  console.error('');
  console.error('Examples:');
  console.error('  node examples/basic-usage.js https://hedgedoc.example.com my-note');
  console.error('  node examples/basic-usage.js https://md.tionis.dev 49vCOEWsR0KR6UowrEV8Kg');
  process.exit(1);
}

async function main() {
  console.log(`Connecting to ${serverUrl}/${noteId}...\n`);
  
  // Create client
  const client = new HedgeDocClient({
    serverUrl,
    noteId
  });

  // Set up event listeners
  client.on('connect', () => {
    console.log('✓ Connected to server');
  });

  client.on('disconnect', (reason) => {
    console.log('✗ Disconnected:', reason);
  });

  client.on('error', (error) => {
    console.error('Error:', error.message);
  });

  client.on('refresh', (info) => {
    console.log(`Note: "${info.title}" (permission: ${info.permission})`);
  });

  client.on('document', (content) => {
    console.log('\n--- Document updated ---');
    console.log(content.slice(0, 500) + (content.length > 500 ? '...' : ''));
    console.log(`--- (${content.length} characters) ---\n`);
  });

  client.on('users', (users) => {
    const names = users.map(u => u.name || 'Anonymous').join(', ');
    console.log(`Online users: ${names || 'none'}`);
  });

  try {
    // Connect and wait for document
    await client.connect();
    
    console.log('\n=== Document Loaded ===');
    console.log('Revision:', client.getRevision());
    console.log('Length:', client.getDocument().length, 'characters');
    console.log('Can edit:', client.canEdit());
    console.log('');

    // Wait for note info
    await new Promise(resolve => setTimeout(resolve, 500));

    // Try to make an edit (if allowed)
    if (client.canEdit()) {
      const timestamp = new Date().toISOString();
      const text = `\n\n<!-- Last edited by hedgesync at ${timestamp} -->`;
      
      console.log('Making an edit...');
      client.insert(client.getDocument().length, text);
      
      // Wait for sync
      await new Promise(resolve => setTimeout(resolve, 2000));
      console.log('Edit complete! New revision:', client.getRevision());
    } else {
      console.log('Note: Document is read-only for anonymous users.');
    }

    // Clean disconnect
    client.disconnect();
    console.log('\nDone!');
    process.exit(0);

  } catch (error) {
    console.error('Failed:', error.message);
    process.exit(1);
  }
}

main();
