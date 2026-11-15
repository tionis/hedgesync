/**
 * Commands that use HedgeDoc's HTTP API (no realtime connection).
 */

import { detectServer } from '../../server-detect.js';
import { HEDGEDOC1_PERMISSIONS } from '../../drivers/hedgedoc1.js';
import { buildNoteUrl } from '../../url.js';
import { readFile, readStdin, type Command } from '../context.js';
import { helpText } from '../help-text.js';
import { CliError, c, print } from '../ui.js';

const outputOption = { name: 'output', short: 'o', type: 'value' } as const;

export const download: Command = {
  name: 'download',
  summary: 'Download note content (HTTP, no realtime session)',
  options: [outputOption],
  help: helpText.download,
  async run(ctx) {
    const { serverUrl, noteId } = ctx.note(0, 'hedgesync download <url> [-o file]');
    const content = await ctx.api(serverUrl).downloadNote(noteId);
    const file = ctx.str('output');
    if (ctx.writeOutputFile(content)) {
      ctx.result({ action: 'download', noteId, file, length: content.length });
    } else {
      ctx.result({ action: 'download', noteId, content }, () => process.stdout.write(content));
    }
  },
};

export const create: Command = {
  name: 'create',
  summary: 'Create a new note',
  options: [
    { name: 'file', short: 'f', type: 'value' },
    { name: 'name', short: 'n', type: 'value', aliases: ['alias'] },
    { name: 'permission', short: 'p', type: 'value' },
  ],
  help: helpText.create,
  async run(ctx) {
    const serverUrl = ctx.server(0, 'hedgesync create <server-url> [-f file] [-n alias]');
    const file = ctx.str('file');
    const content = file ? readFile(file) : process.stdin.isTTY ? '' : await readStdin();
    const alias = ctx.str('name');
    const api = ctx.api(serverUrl);
    const permission = ctx.str('permission')?.toLowerCase();
    if (permission && !(HEDGEDOC1_PERMISSIONS as readonly string[]).includes(permission)) {
      throw new CliError(`Invalid permission '${permission}'`, `One of: ${HEDGEDOC1_PERMISSIONS.join(', ')}`);
    }
    if (permission) ctx.requireCookie(serverUrl); // only an owned (signed-in) note can have its permission set
    const noteId = alias ? await api.createNoteWithAlias(alias, content) : await api.createNote(content || undefined);
    const url = buildNoteUrl(serverUrl, noteId);
    if (permission) {
      try {
        const client = await ctx.connectTo(serverUrl, noteId);
        try {
          await client.setPermission(permission);
        } finally {
          client.disconnect();
        }
      } catch (err) {
        throw new CliError(`Created ${url}, but could not set its permission: ${(err as Error).message}`);
      }
    }
    ctx.result({ action: 'create', noteId, alias: alias ?? null, url, permission: permission ?? null }, () => print(ctx.quiet ? noteId : url));
  },
};

export const me: Command = {
  name: 'me',
  summary: 'Show the logged-in user',
  options: [],
  help: helpText.me,
  async run(ctx) {
    const serverUrl = ctx.server(0, 'hedgesync me <server-url>');
    const profile = await ctx.api(serverUrl, true).getProfile();
    ctx.result({ action: 'get-profile', profile }, () => {
      if (profile.status !== 'ok') {
        print(c('yellow', 'Not logged in (the session cookie is missing, invalid or expired)'));
        return;
      }
      print(`  ${c('cyan', 'ID:')}    ${profile.id}`);
      print(`  ${c('cyan', 'Name:')}  ${profile.name}`);
      if (profile.photo) print(`  ${c('cyan', 'Photo:')} ${profile.photo}`);
    });
    if (profile.status !== 'ok') process.exitCode = 1;
  },
};

export const exportNotes: Command = {
  name: 'export',
  summary: 'Export all your notes as a zip archive',
  options: [outputOption],
  help: helpText.export,
  async run(ctx) {
    const serverUrl = ctx.server(0, 'hedgesync export <server-url> -o notes.zip');
    const file = ctx.str('output');
    if (!file) throw new CliError('Output file required', 'Use -o <file.zip>');
    ctx.info(c('cyan', 'Exporting notes...'));
    const zip = await ctx.api(serverUrl, true).downloadExport();
    ctx.writeOutputFile(new Uint8Array(zip));
    ctx.result({ action: 'export', file, size: zip.byteLength });
  },
};

export const history: Command = {
  name: 'history',
  summary: 'Show or clear your note history',
  options: [{ name: 'pinned', type: 'flag' }, { name: 'delete', type: 'flag' }],
  help: helpText.history,
  async run(ctx) {
    const serverUrl = ctx.server(0, 'hedgesync history <server-url> [--pinned] [--delete]');
    const api = ctx.api(serverUrl, true);
    if (ctx.flag('delete')) {
      await api.deleteHistory();
      ctx.result({ action: 'delete-history' }, () => ctx.info(c('green', '✓ History deleted')));
      return;
    }
    let entries = (await api.getHistory()).history;
    if (ctx.flag('pinned')) entries = entries.filter(e => e.pinned);
    ctx.result({ action: 'list-history', count: entries.length, entries }, () => {
      if (entries.length === 0) {
        print('(no notes in history)');
        return;
      }
      for (const entry of entries) {
        print(`${entry.pinned ? c('yellow', '★ ') : '  '}${c('cyan', entry.id)}  ${entry.text || '(untitled)'}`);
        const tags = entry.tags?.length ? `  tags: ${entry.tags.join(', ')}` : '';
        print(c('dim', `    ${new Date(entry.time).toLocaleString()}${tags}`));
      }
      print();
      print(`Total: ${entries.length} note(s)`);
    });
  },
};

function pinCommand(pin: boolean): Command {
  const name = pin ? 'pin' : 'unpin';
  return {
    name,
    summary: pin ? 'Pin a note in your history' : 'Unpin a note in your history',
    options: [],
    help: helpText.pin,
    async run(ctx) {
      const { serverUrl, noteId } = ctx.note(0, `hedgesync ${name} <url>`);
      await ctx.api(serverUrl, true).setHistoryPinned(noteId, pin);
      ctx.result({ action: name, noteId }, () => ctx.info(c('green', pin ? '✓ Note pinned' : '✓ Note unpinned')));
    },
  };
}

export const pin = pinCommand(true);
export const unpin = pinCommand(false);

export const historyDelete: Command = {
  name: 'history-delete',
  summary: 'Remove a note from your history',
  options: [],
  help: helpText['history-delete'],
  async run(ctx) {
    const { serverUrl, noteId } = ctx.note(0, 'hedgesync history-delete <url>');
    await ctx.api(serverUrl, true).deleteFromHistory(noteId);
    ctx.result({ action: 'history-delete', noteId }, () => ctx.info(c('green', '✓ Note removed from history')));
  },
};

export const status: Command = {
  name: 'status',
  summary: 'Show server status',
  options: [],
  help: helpText.status,
  async run(ctx) {
    const serverUrl = ctx.server(0, 'hedgesync status <server-url>');
    const server = await detectServer({ serverUrl, headers: ctx.headers() });
    if (server.protocol === 'hedgedoc2') {
      ctx.result({ action: 'status', server }, () => {
        print(`  ${c('cyan', 'Server:'.padEnd(28))} HedgeDoc ${server.version ?? '2'} (not supported by hedgesync yet)`);
      });
      return;
    }
    const s = await ctx.api(serverUrl).getStatus();
    ctx.result({ action: 'status', server, status: s }, () => {
      const rows: [string, unknown][] = [
        ['Server', server.protocol ? `HedgeDoc ${server.version ?? '1.x'}` : 'unknown'],
        ['Online users', s.onlineUsers],
        ['Online notes', s.onlineNotes],
        ['Distinct online users', s.distinctOnlineUsers],
        ['Notes', s.notesCount],
        ['Registered users', s.registeredUsers],
        ['Online registered users', s.onlineRegisteredUsers],
        ['Distinct online registered', s.distinctOnlineRegisteredUsers],
        ['Connection queue', s.connectionSocketQueueLength],
        ['Disconnect queue', s.disconnectSocketQueueLength],
      ];
      for (const [label, value] of rows) print(`  ${c('cyan', (label + ':').padEnd(28))} ${value}`);
    });
  },
};

export const apiCommands = [download, create, me, exportNotes, history, pin, unpin, historyDelete, status];
