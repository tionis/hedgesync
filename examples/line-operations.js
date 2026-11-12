/**
 * Line operations (line numbers are 0-based).
 *
 * Usage:
 *   bun examples/line-operations.js <note-url>
 */

import { HedgeDocClient, parseNoteUrl } from '../src/index.js';

const url = process.argv[2];
if (!url) {
  console.error('Usage: bun examples/line-operations.js <note-url>');
  process.exit(1);
}
const client = new HedgeDocClient({ ...parseNoteUrl(url), cookie: process.env.HEDGEDOC_COOKIE });

try {
  await client.connect();
  const lines = client.getLines();
  console.log(`${lines.length} lines; first five:`);
  lines.slice(0, 5).forEach((line, i) => console.log(`${String(i).padStart(3)}: ${line}`));

  const heading = lines.findIndex(line => line.startsWith('#'));
  console.log(heading === -1 ? 'No heading found' : `First heading on line ${heading}: ${lines[heading]}`);

  if (client.canEdit()) {
    client.insertLine(0, `<!-- checked ${new Date().toISOString()} -->`); // new line 0
    client.setLine(0, client.getLine(0) + ' by hedgesync');               // replace it
    client.insertLine(client.getLineCount(), 'appended line');             // insert after the last line
    client.deleteLine(client.getLineCount() - 1);                          // and remove it again
    await client.flush();
    console.log('Line 0 is now:', client.getLine(0));
  }
} catch (error) {
  console.error('Error:', error.message);
  process.exitCode = 1;
} finally {
  client.disconnect();
}
