/**
 * Watch a note and report changes, who made them, and presence.
 *
 * Usage:
 *   bun examples/watch-document.js <note-url>
 *
 * Runs until Ctrl+C (or for HEDGESYNC_EXAMPLE_DURATION_MS milliseconds).
 */

import { HedgeDocClient, parseNoteUrl } from '../src/index.js';

const url = process.argv[2];
if (!url) {
  console.error('Usage: bun examples/watch-document.js <note-url>');
  process.exit(1);
}
const client = new HedgeDocClient({ ...parseNoteUrl(url), cookie: process.env.HEDGEDOC_COOKIE });
let changes = 0;

client.on('change', (event) => {
  if (event.type !== 'remote') return;
  changes++;
  const who = event.user?.name ?? 'someone';
  const delta = event.operation.targetLength - event.operation.baseLength;
  console.log(`[${new Date().toISOString()}] ${who}: ${delta >= 0 ? '+' : ''}${delta} chars (now ${client.getDocument().length})`);
});
client.on('users', (users) => console.log(`Online: ${users.map(u => u.name || 'Anonymous').join(', ')}`));
client.on('refresh', (info) => console.log(`Note "${info.title}" (${info.permission})`));
client.on('resync', (outcome) => console.log(`Resynced after reconnect (${outcome.kind})`));
client.on('disconnect', (reason) => console.log('Disconnected:', reason));

try {
  await client.connect();
  console.log(`Watching revision ${client.getRevision()}, ${client.getDocument().length} characters. Ctrl+C to stop.`);
  const duration = Number(process.env.HEDGESYNC_EXAMPLE_DURATION_MS) || 0;
  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    if (duration) setTimeout(resolve, duration);
  });
  console.log(`\n${changes} change(s) observed`);
} catch (error) {
  console.error('Failed:', error.message);
  process.exitCode = 1;
} finally {
  client.disconnect();
}
