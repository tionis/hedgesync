/**
 * Working with notes as a collection: list, search, permission, delete, upload.
 *
 * HedgeDoc 1 has no "notes I own" endpoint; the per-account history (notes
 * you have opened) is the only server-side list, so list and search use it.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import { HEDGEDOC1_PERMISSIONS } from '../../drivers/hedgedoc1.js';
import type { HedgeDocAPI, HistoryEntry } from '../../hedgedoc-api.js';
import { buildNoteUrl } from '../../url.js';
import { connectionOptions, type Command, type Context } from '../context.js';
import { CliError, c, print } from '../ui.js';

/** What each HedgeDoc 1 permission means, for help and `permission` output. */
export const PERMISSION_MEANINGS: Record<string, string> = {
  freely: 'anyone can view and edit',
  editable: 'anyone can view, signed-in users can edit',
  limited: 'signed-in users can view and edit',
  locked: 'anyone can view, only the owner can edit',
  protected: 'signed-in users can view, only the owner can edit',
  private: 'only the owner can view and edit',
};

const permissionTable = () => HEDGEDOC1_PERMISSIONS
  .map(p => `  ${c('cyan', p.padEnd(10))} ${PERMISSION_MEANINGS[p]}`).join('\n');

const filterOptions = [
  { name: 'tag', short: 't', type: 'multi' as const },
  { name: 'pinned', type: 'flag' as const },
  { name: 'limit', short: 'n', type: 'value' as const },
];

/** History entries filtered by --tag/--pinned/--search and sorted, most recently visited first. */
async function historyEntries(ctx: Context, api: HedgeDocAPI, titleSearch?: string): Promise<HistoryEntry[]> {
  let entries = (await api.getHistory()).history;
  const tags = ctx.list('tag').map(t => t.toLowerCase());
  if (tags.length) entries = entries.filter(e => tags.every(t => e.tags?.some(tag => tag.toLowerCase() === t)));
  if (ctx.flag('pinned')) entries = entries.filter(e => e.pinned);
  if (titleSearch) {
    const needle = titleSearch.toLowerCase();
    entries = entries.filter(e => (e.text || '').toLowerCase().includes(needle) || e.id.toLowerCase().includes(needle));
  }
  entries.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.time - a.time);
  const limit = ctx.int('limit', 0);
  return limit > 0 ? entries.slice(0, limit) : entries;
}

function relativeTime(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  const units: [number, string][] = [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [604800, 'week'], [2629800, 'month'], [31557600, 'year']];
  let [size, name] = units[0];
  for (const unit of units) if (s >= unit[0]) [size, name] = unit;
  const n = Math.floor(s / size);
  return `${n} ${name}${n === 1 ? '' : 's'} ago`;
}

export const list: Command = {
  name: 'list',
  aliases: ['ls'],
  summary: 'List your notes (from your history)',
  options: [...filterOptions, { name: 'search', short: 's', type: 'value' }],
  help: () => `
${c('bold', 'hedgesync list')} - List your notes (alias: ls)

${c('yellow', 'USAGE:')}
  hedgesync list <server-url> [options]

Lists the notes in your HedgeDoc history (the notes you have opened while
signed in), pinned first, then most recently visited. HedgeDoc 1 has no way
to list notes you own but never opened; ${c('cyan', 'hedgesync export')} gets those.

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-t, --tag')} <tag>      Only notes with this tag (repeatable: all must match)
  ${c('cyan', '-s, --search')} <text>  Only notes whose title or id contains the text
  ${c('cyan', '--pinned')}             Only pinned notes
  ${c('cyan', '-n, --limit')} <n>      Show at most n notes
  ${c('cyan', '-q, --quiet')}          Print only the note URLs (for scripts)
  ${c('cyan', '--json')}               Full entries as JSON

${c('yellow', 'EXAMPLES:')}
  hedgesync ls https://md.example.com
  hedgesync ls https://md.example.com -t project -n 10
  hedgesync ls https://md.example.com -q -t journal | xargs -n1 hedgesync get
`,
  async run(ctx) {
    const serverUrl = ctx.server(0, 'hedgesync list <server-url>');
    const entries = await historyEntries(ctx, ctx.api(serverUrl, true), ctx.str('search'));
    const notes = entries.map(e => ({ ...e, url: buildNoteUrl(serverUrl, e.id) }));
    if (ctx.json) {
      ctx.result({ action: 'list', count: notes.length, notes });
      return;
    }
    if (ctx.quiet) {
      for (const n of notes) print(n.url);
      return;
    }
    if (notes.length === 0) {
      print('(no matching notes in your history)');
      return;
    }
    for (const n of notes) {
      print(`${n.pinned ? c('yellow', '★ ') : '  '}${c('bold', n.text || '(untitled)')}`);
      const tags = n.tags?.length ? `  ${n.tags.map(t => `#${t}`).join(' ')}` : '';
      print(`    ${c('cyan', n.url)}  ${c('dim', relativeTime(n.time))}${c('magenta', tags)}`);
    }
  },
};

export const search: Command = {
  name: 'search',
  summary: 'Search the text of your notes',
  options: [
    ...filterOptions,
    { name: 'regex', short: 'r', type: 'flag' },
    { name: 'ignore-case', short: 'i', type: 'flag' },
    { name: 'files-with-matches', short: 'l', type: 'flag' },
  ],
  help: () => `
${c('bold', 'hedgesync search')} - Search the text of your notes

${c('yellow', 'USAGE:')}
  hedgesync search <server-url> <pattern> [options]

Downloads the notes in your history and prints the lines that match.
Notes that no longer exist or that you cannot read are skipped.

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-r, --regex')}               Treat the pattern as a regular expression
  ${c('cyan', '-i, --ignore-case')}         Case-insensitive
  ${c('cyan', '-l, --files-with-matches')}  Only list the matching notes
  ${c('cyan', '-t, --tag')} <tag>           Only search notes with this tag (repeatable)
  ${c('cyan', '--pinned')}                  Only search pinned notes
  ${c('cyan', '-n, --limit')} <n>           Only search the n most recently visited notes
  ${c('cyan', '--json')}                    Matches as JSON

${c('yellow', 'EXAMPLES:')}
  hedgesync search https://md.example.com TODO
  hedgesync search https://md.example.com -ri 'meeting (notes|minutes)' -l
`,
  async run(ctx) {
    const usage = 'hedgesync search <server-url> <pattern>';
    const serverUrl = ctx.server(0, usage);
    const pattern = ctx.need(1, 'Search pattern', usage);
    let regex: RegExp;
    try {
      const source = ctx.flag('regex') ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      regex = new RegExp(source, ctx.flag('ignore-case') ? 'i' : '');
    } catch (err) {
      throw new CliError(`Invalid regular expression: ${(err as Error).message}`);
    }
    const api = ctx.api(serverUrl, true);
    const entries = await historyEntries(ctx, api);
    ctx.info(c('dim', `Searching ${entries.length} note(s)...`));

    type Hit = { id: string; title: string; url: string; lines: { line: number; text: string }[] };
    const hits: Hit[] = [];
    let skipped = 0;
    await mapLimit(entries, 6, async (entry) => {
      let text: string;
      try {
        text = await api.downloadNote(entry.id);
      } catch {
        skipped++;
        return;
      }
      const lines = text.split('\n').flatMap((t, i) => (regex.test(t) ? [{ line: i + 1, text: t }] : []));
      if (lines.length) hits.push({ id: entry.id, title: entry.text || '(untitled)', url: buildNoteUrl(serverUrl, entry.id), lines });
    });
    // Keep history order (pinned, then most recent) regardless of download order.
    const order = new Map(entries.map((e, i) => [e.id, i]));
    hits.sort((a, b) => order.get(a.id)! - order.get(b.id)!);

    if (ctx.json) {
      ctx.result({ action: 'search', pattern, searched: entries.length, skipped, count: hits.length, notes: hits });
      return;
    }
    const highlight = (t: string) => t.replace(new RegExp(regex.source, regex.flags + 'g'), m => c('red', m));
    for (const hit of hits) {
      if (ctx.flag('files-with-matches')) {
        print(ctx.quiet ? hit.url : `${c('bold', hit.title)}  ${c('cyan', hit.url)}`);
        continue;
      }
      print(`${c('bold', hit.title)}  ${c('cyan', hit.url)}`);
      for (const l of hit.lines) print(`  ${c('green', String(l.line).padStart(4))}: ${highlight(l.text)}`);
      print();
    }
    ctx.info(c('dim', `${hits.length} of ${entries.length} note(s) match${skipped ? ` (${skipped} could not be read)` : ''}`));
    if (hits.length === 0) process.exitCode = 1; // like grep
  },
};

export const permission: Command = {
  name: 'permission',
  summary: 'Show or change who can view and edit a note',
  options: [...connectionOptions],
  help: () => `
${c('bold', 'hedgesync permission')} - Show or change who can view and edit a note

${c('yellow', 'USAGE:')}
  hedgesync permission <note-url>            Show the current permission
  hedgesync permission <note-url> <value>    Change it (owner only)

${c('yellow', 'VALUES:')}
${permissionTable()}

Only the note's owner can change the permission, and notes created
anonymously have no owner. The server may refuse ${c('cyan', 'freely')} if it does not
allow anonymous editing.
`,
  async run(ctx) {
    const usage = 'hedgesync permission <note-url> [value]';
    const { serverUrl, url } = ctx.note(0, usage);
    const value = ctx.positional[1]?.toLowerCase();
    if (value && !(HEDGEDOC1_PERMISSIONS as readonly string[]).includes(value)) {
      throw new CliError(`Invalid permission '${ctx.positional[1]}'`, `One of: ${HEDGEDOC1_PERMISSIONS.join(', ')}`);
    }
    if (value) ctx.requireCookie(serverUrl);
    const result = await ctx.withClient({}, async (client) => {
      const before = client.noteInfo.permission;
      if (value) await client.setPermission(value);
      return { before, permission: client.noteInfo.permission, owner: client.noteInfo.owner };
    });
    const changed = !!value && result.before !== result.permission;
    ctx.result({ action: value ? 'set-permission' : 'get-permission', url, ...result, changed }, () => {
      const meaning = PERMISSION_MEANINGS[result.permission] ?? '';
      if (value) {
        ctx.info(c('green', changed ? `✓ Permission changed from ${result.before} to ${result.permission}` : `✓ Permission already ${result.permission}`));
      } else {
        print(`${c('cyan', result.permission || 'unknown')}  ${c('dim', meaning)}`);
        if (!result.owner) print(c('dim', 'This note has no owner (created anonymously).'));
      }
    });
  },
};

export const deleteNote: Command = {
  name: 'delete',
  summary: 'Delete a note (owner only)',
  options: [...connectionOptions, { name: 'yes', short: 'y', type: 'flag' }, { name: 'keep-history', type: 'flag' }],
  help: () => `
${c('bold', 'hedgesync delete')} - Delete a note permanently (owner only)

${c('yellow', 'USAGE:')}
  hedgesync delete <note-url> [--yes]

Asks you to type the note id to confirm, unless --yes is given (required
when not on a terminal). The note is also removed from your history unless
--keep-history is given. This cannot be undone.

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-y, --yes')}          Do not ask for confirmation
  ${c('cyan', '--keep-history')}     Leave the entry in your history
`,
  async run(ctx) {
    const { serverUrl, noteId, url } = ctx.note(0, 'hedgesync delete <note-url> [--yes]');
    ctx.requireCookie(serverUrl);
    if (!ctx.flag('yes') && !(process.stdin.isTTY && process.stderr.isTTY)) {
      throw new CliError('Refusing to delete without confirmation', 'Pass --yes when not running on a terminal.');
    }
    const client = await ctx.connect(0);
    let title = '';
    try {
      title = client.noteInfo.title || '(untitled)';
      if (!ctx.flag('yes')) {
        const answer = await promptLine(
          `Delete "${title}" (${client.getDocument().length} characters) at ${url}?\nType the note id (${noteId}) to confirm: `);
        if (answer.trim() !== noteId) throw new CliError('Not confirmed; nothing was deleted');
      }
      await client.deleteNote();
    } finally {
      client.disconnect();
    }
    let removedFromHistory = false;
    if (!ctx.flag('keep-history')) {
      removedFromHistory = await ctx.api(serverUrl, true).deleteFromHistory(noteId).then(() => true, () => false);
    }
    ctx.result({ action: 'delete', url, noteId, title, removedFromHistory },
      () => ctx.info(c('green', `✓ Deleted "${title}"`)));
  },
};

export const upload: Command = {
  name: 'upload',
  summary: 'Upload images and print Markdown links',
  options: [{ name: 'url-only', short: 'u', type: 'flag' }],
  help: () => `
${c('bold', 'hedgesync upload')} - Upload images and print Markdown links

${c('yellow', 'USAGE:')}
  hedgesync upload <server-url> <image>... [--url-only]

Uploads through the server's image upload (the same as pasting an image in
the editor) and prints ${c('cyan', '![name](link)')} for each, ready to append to a note.

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-u, --url-only')}     Print only the links

${c('yellow', 'EXAMPLES:')}
  hedgesync upload https://md.example.com diagram.png
  hedgesync upload https://md.example.com shot.png | hedgesync append https://md.example.com/abc
`,
  async run(ctx) {
    const usage = 'hedgesync upload <server-url> <image>...';
    const serverUrl = ctx.server(0, usage);
    const files = ctx.positional.slice(1);
    if (files.length === 0) throw new CliError('No image given', `Usage: ${usage}`);
    const api = ctx.api(serverUrl);
    const uploaded: { file: string; link: string }[] = [];
    for (const file of files) {
      let data: Buffer;
      try {
        data = readFileSync(file);
      } catch (err) {
        throw new CliError(`Cannot read ${file}: ${(err as Error).message}`);
      }
      ctx.info(c('dim', `Uploading ${file}...`));
      uploaded.push({ file, link: await api.uploadImage(data, basename(file)) });
    }
    ctx.result({ action: 'upload', files: uploaded }, () => {
      for (const u of uploaded) {
        const alt = basename(u.file).replace(/\.[^.]+$/, '').replace(/[[\]]/g, '');
        print(ctx.flag('url-only') ? u.link : `![${alt}](${u.link})`);
      }
    });
  },
};


/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Read one line from the terminal. */
function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
