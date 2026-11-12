/**
 * Macros: expand triggers that collaborators type into the note.
 *
 * Usage:
 *   bun examples/macro-system.js <note-url>
 *
 * Runs until Ctrl+C (or for HEDGESYNC_EXAMPLE_DURATION_MS milliseconds).
 * Only edits made by others trigger macros, never the bot's own output.
 */

import { HedgeDocClient, MacroEngine, parseNoteUrl } from '../src/index.js';

const url = process.argv[2];
if (!url) {
  console.error('Usage: bun examples/macro-system.js <note-url>');
  process.exit(1);
}
const client = new HedgeDocClient({ ...parseNoteUrl(url), cookie: process.env.HEDGEDOC_COOKIE });

try {
  await client.connect();
  if (!client.canEdit()) throw new Error('No edit permission for this note');

  // Restrict triggering to particular accounts with { allowedUserIds: ['...'] }.
  const macros = new MacroEngine(client);

  // Built-in helpers return { trigger, replacement }.
  for (const m of [
    MacroEngine.builtins.dateMacro('::date::', 'isoDate'),
    MacroEngine.builtins.dateMacro('::time::', 'time'),
    MacroEngine.builtins.uuidMacro('::uuid::'),
    MacroEngine.builtins.counterMacro('::n::'),
  ]) macros.addTextMacro(m.trigger, m.replacement);

  // Text macro with a computed replacement.
  macros.addTextMacro('::sig::', () => `— hedgesync bot, ${new Date().toISOString()}`);

  // Regex macros get String.replace-style arguments: (match, ...groups, index, document).
  macros.addRegexMacro('upper', /UPPER\(([^)]+)\)/g, (_match, text) => text.toUpperCase());

  // Template macros: {{name}}
  const vars = { user: 'hedgesync bot', project: 'hedgesync' };
  macros.addTemplateMacro('vars', '{{', '}}', (name) => vars[name.trim()] ?? `{{${name}}}`);

  // Block macro: ::BEGIN:sort:: ... ::END:sort:: is replaced by its sorted lines.
  macros.addBlockMacro('sort', (content) => content.split('\n').sort().join('\n'));

  console.log('Registered:', macros.listMacros().map(m => m.name).join(', '));

  // Expand whatever is already in the note once...
  const results = await macros.expand();
  console.log(`Initial pass expanded ${results.length} macro(s)`);

  // ...then watch for new triggers.
  macros.start();
  console.log('Watching. Type ::date::, UPPER(hi) or {{user}} into the note; Ctrl+C to stop.');

  const duration = Number(process.env.HEDGESYNC_EXAMPLE_DURATION_MS) || 0;
  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    if (duration) setTimeout(resolve, duration);
  });
  macros.stop();
  await client.flush();
} catch (error) {
  console.error('Error:', error.message);
  process.exitCode = 1;
} finally {
  client.disconnect();
}
