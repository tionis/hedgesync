/**
 * Editing: insert, delete, replace, batch, undo and raw operations.
 *
 * Usage:
 *   bun examples/edit-document.js <note-url>
 *
 * The note must be editable for you (anonymous edits need 'freely').
 */

import { HedgeDocClient, TextOperation, parseNoteUrl } from '../src/index.js';

const url = process.argv[2];
if (!url) {
  console.error('Usage: bun examples/edit-document.js <note-url>');
  process.exit(1);
}
const client = new HedgeDocClient({ ...parseNoteUrl(url), cookie: process.env.HEDGEDOC_COOKIE });

try {
  await client.connect();
  if (!client.canEdit()) throw new Error('No edit permission for this note');

  // Insert at the end and at the start.
  client.insert(client.getDocument().length, `\n\nAdded at ${new Date().toISOString()}`);
  client.insert(0, '<!-- edited by hedgesync -->\n');

  // Replace a range (position, length, text).
  client.replace(0, 4, '<!--');

  // Several edits applied as a single operation (rolled back if fn throws).
  client.batch(() => {
    client.insert(client.getDocument().length, '\n- one');
    client.insert(client.getDocument().length, '\n- two');
  });

  // Undo the batch, then redo it.
  client.undo();
  client.redo();

  // Make the document equal to some text with a minimal diff.
  client.updateContent(client.getDocument().replace('- two', '- 2'));

  // A raw TextOperation for full control.
  const op = new TextOperation().retain(client.getDocument().length).insert('\n<!-- end -->');
  client.applyOperation(op);

  await client.flush();
  console.log(client.getDocument());
  console.log(`\nRevision ${client.getRevision()}`);
} catch (error) {
  console.error('Error:', error.message);
  process.exitCode = 1;
} finally {
  client.disconnect();
}
