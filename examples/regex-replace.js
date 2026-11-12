/**
 * Regex search and replace. Each call sends one operation, and replacement
 * strings support $1, $<name>, $& like String.prototype.replace.
 *
 * Usage:
 *   bun examples/regex-replace.js <note-url>
 */

import { HedgeDocClient, parseNoteUrl } from '../src/index.js';

const url = process.argv[2];
if (!url) {
  console.error('Usage: bun examples/regex-replace.js <note-url>');
  process.exit(1);
}
const client = new HedgeDocClient({ ...parseNoteUrl(url), cookie: process.env.HEDGEDOC_COOKIE });

try {
  await client.connect();
  if (!client.canEdit()) throw new Error('No edit permission for this note');

  // First match only; returns whether one was found.
  console.log('TODO -> DONE:', client.replaceFirst(/TODO/i, 'DONE'));

  // All matches (replaceRegex is always global); returns the count.
  console.log('foo -> bar:', client.replaceRegex(/\bfoo\b/gi, 'bar'));

  // Capture groups: [text](url) -> <a href="url">text</a>
  console.log('links:', client.replaceRegex(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>'));

  // A function computes each replacement.
  console.log('dates:', client.replaceRegex(/\{\{DATE\}\}/g, () => new Date().toISOString().slice(0, 10)));

  await client.flush();
  console.log('\n' + client.getDocument().slice(0, 500));
} catch (error) {
  console.error('Error:', error.message);
  process.exitCode = 1;
} finally {
  client.disconnect();
}
