/**
 * Basic usage: connect to a note, read it, and make one edit.
 *
 * Usage:
 *   bun examples/basic-usage.js <note-url>
 *   HEDGEDOC_COOKIE='connect.sid=...' bun examples/basic-usage.js https://md.example.com/abc123
 */

import { HedgeDocClient, parseNoteUrl } from '../src/index.js';

const url = process.argv[2];
if (!url) {
  console.error('Usage: bun examples/basic-usage.js <note-url>');
  process.exit(1);
}
const { serverUrl, noteId } = parseNoteUrl(url);

const client = new HedgeDocClient({ serverUrl, noteId, cookie: process.env.HEDGEDOC_COOKIE });

client.on('disconnect', (reason) => console.log('Disconnected:', reason));
client.on('users', (users) => console.log('Online:', users.map(u => u.name || 'Anonymous').join(', ') || 'nobody'));

try {
  // Resolves once the document and the note's permissions have loaded.
  await client.connect();
  const info = client.getNoteInfo();
  console.log(`Note "${info.title}" (permission: ${info.permission}), revision ${client.getRevision()}`);
  console.log(`${client.getDocument().length} characters, ${client.getLineCount()} lines`);

  if (client.canEdit()) {
    client.insert(client.getDocument().length, `\n<!-- touched by hedgesync at ${new Date().toISOString()} -->`);
    await client.flush(); // wait until the server has acknowledged the edit
    console.log('Edit acknowledged; revision is now', client.getRevision());
  } else {
    console.log('This note is read-only for you (pass HEDGEDOC_COOKIE to log in).');
  }
} catch (error) {
  console.error('Error:', error.message);
  process.exitCode = 1;
} finally {
  client.disconnect();
}
