/**
 * Programmatic Editing Example
 * 
 * Demonstrates various editing operations: insert, delete, replace.
 * 
 * Usage:
 *   node examples/edit-document.js <server-url> <note-id>
 * 
 * Note: The document must have 'freely' permission for anonymous edits.
 */

import { HedgeDocClient, TextOperation } from '../src/index.js';

const serverUrl = process.argv[2];
const noteId = process.argv[3];

if (!serverUrl || !noteId) {
  console.error('Usage: node examples/edit-document.js <server-url> <note-id>');
  process.exit(1);
}

async function main() {
  console.log(`Connecting to ${serverUrl}/${noteId}...\n`);
  
  const client = new HedgeDocClient({ serverUrl, noteId });

  client.on('refresh', (info) => {
    console.log(`Note: "${info.title}" (permission: ${info.permission})`);
  });

  try {
    await client.connect();
    
    // Wait for permission info
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log('\nInitial document:');
    console.log('─'.repeat(40));
    console.log(client.getDocument());
    console.log('─'.repeat(40));
    console.log(`Revision: ${client.getRevision()}`);
    console.log(`Can edit: ${client.canEdit()}`);
    
    if (!client.canEdit()) {
      console.log('\n⚠ Cannot edit this document (requires login or different permission)');
      client.disconnect();
      process.exit(0);
    }
    
    console.log('\n--- Performing edits ---\n');
    
    // Example 1: Insert at end
    console.log('1. Inserting text at the end...');
    const timestamp = new Date().toISOString();
    client.insert(client.getDocument().length, `\n\nAdded at ${timestamp}`);
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Example 2: Insert at beginning  
    console.log('2. Inserting comment at beginning...');
    client.insert(0, '<!-- Modified by hedgesync -->\n');
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Example 3: Using a raw TextOperation for more control
    console.log('3. Using TextOperation directly...');
    const doc = client.getDocument();
    const op = new TextOperation();
    op.retain(doc.length);
    op.insert('\n<!-- End of document -->');
    client.applyOperation(op);
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log('\n--- Final document ---');
    console.log('─'.repeat(40));
    console.log(client.getDocument());
    console.log('─'.repeat(40));
    console.log(`Final revision: ${client.getRevision()}`);
    
    client.disconnect();
    console.log('\n✓ Done!');
    process.exit(0);

  } catch (error) {
    console.error('Error:', error.message);
    client.disconnect();
    process.exit(1);
  }
}

main();
