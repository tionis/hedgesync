/**
 * Read-only realtime commands: info, users, authors.
 */

import type { HedgeDocClient, UserInfo } from '../../hedgedoc-client.js';
import { connectionOptions, type Command } from '../context.js';
import { helpText } from '../help-text.js';
import { c, print } from '../ui.js';

/** Ask for the online user list and wait for the answer (or give up after `ms`). */
async function fetchOnlineUsers(client: HedgeDocClient, ms = 2000): Promise<UserInfo[]> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      client.off('users', done);
      resolve();
    }
    client.on('users', done);
    client.requestOnlineUsers();
  });
  return client.getOnlineUsers();
}

export const info: Command = {
  name: 'info',
  summary: 'Show note metadata and online users',
  options: [...connectionOptions],
  help: helpText.info,
  async run(ctx) {
    await ctx.withClient({}, async (client) => {
      const users = await fetchOnlineUsers(client);
      const note = client.getNoteInfo();
      const revision = client.getRevision();
      const length = client.getDocument().length;
      const lines = client.getLineCount();
      ctx.result({ action: 'info', ...note, revision, length, lines, canEdit: client.canEdit(), onlineUsers: users }, () => {
        const date = (t: unknown) => (t ? new Date(t as string).toLocaleString() : 'unknown');
        print(`${c('bold', 'Title:')} ${note.title || '(untitled)'}`);
        print(`${c('bold', 'Permission:')} ${note.permission}${client.canEdit() ? '' : c('dim', ' (read-only for you)')}`);
        print(`${c('bold', 'Owner:')} ${note.owner || '(none)'}`);
        print(`${c('bold', 'Created:')} ${date(note.createtime)}`);
        print(`${c('bold', 'Updated:')} ${date(note.updatetime)}`);
        print(`${c('bold', 'Revision:')} ${revision}`);
        print(`${c('bold', 'Length:')} ${length} characters, ${lines} lines`);
        print(`${c('bold', 'Online:')} ${users.length === 0 ? c('dim', '(nobody else)') : users.length}`);
        for (const user of users) print(`  ● ${user.name || user.id}`);
      });
    });
  },
};

export const users: Command = {
  name: 'users',
  summary: 'List online users',
  options: [...connectionOptions],
  help: helpText.users,
  async run(ctx) {
    const list = await ctx.withClient({}, client => fetchOnlineUsers(client));
    ctx.result({ action: 'users', count: list.length, users: list }, () => {
      if (list.length === 0) {
        print(c('dim', 'No other users online'));
        return;
      }
      print(c('bold', `Online users (${list.length}):`));
      for (const user of list) print(`  - ${user.name || user.id}${user.color ? ` (${user.color})` : ''}`);
    });
  },
};

interface AuthorStat {
  id: string;
  name: string;
  color: string;
  photo: string | null;
  charCount: number;
  spanCount: number;
  firstEdit: Date | null;
  lastEdit: Date | null;
}

export const authors: Command = {
  name: 'authors',
  summary: 'List document authors and contributions',
  options: [...connectionOptions, { name: 'verbose', short: 'v', type: 'flag' }],
  help: helpText.authors,
  async run(ctx) {
    const result = await ctx.withClient({}, client => client.getDocumentWithAuthorship());
    const byAuthor = new Map<string, AuthorStat>();
    for (const span of result.authorship) {
      const id = span.userId || 'anonymous';
      let stat = byAuthor.get(id);
      if (!stat) {
        stat = {
          id,
          name: span.author?.name || 'Anonymous',
          color: span.author?.color || '#888888',
          photo: span.author?.photo || null,
          charCount: 0,
          spanCount: 0,
          firstEdit: span.createdAt,
          lastEdit: span.updatedAt,
        };
        byAuthor.set(id, stat);
      }
      stat.charCount += span.end - span.start;
      stat.spanCount += 1;
      if (span.createdAt && (!stat.firstEdit || span.createdAt < stat.firstEdit)) stat.firstEdit = span.createdAt;
      if (span.updatedAt && (!stat.lastEdit || span.updatedAt > stat.lastEdit)) stat.lastEdit = span.updatedAt;
    }

    const total = result.content.length;
    const stats = [...byAuthor.values()].sort((a, b) => b.charCount - a.charCount);
    const pct = (n: number) => (total ? (n / total) * 100 : 0).toFixed(1);

    ctx.result({
      action: 'authors',
      totalCharacters: total,
      authorCount: stats.length,
      authors: stats.map(s => ({
        ...s,
        percentage: pct(s.charCount),
        firstEdit: s.firstEdit?.toISOString(),
        lastEdit: s.lastEdit?.toISOString(),
      })),
    }, () => {
      print(c('bold', `Document Authors (${stats.length}):`));
      print();
      for (const stat of stats) {
        const p = pct(stat.charCount);
        print(`  ${c('cyan', stat.name)}`);
        print(`    ${c('dim', '█'.repeat(Math.round(parseFloat(p) / 5)))} ${p}% (${stat.charCount} chars, ${stat.spanCount} regions)`);
        if (ctx.flag('verbose')) {
          if (stat.firstEdit) print(`    First edit: ${stat.firstEdit.toLocaleString()}`);
          if (stat.lastEdit) print(`    Last edit: ${stat.lastEdit.toLocaleString()}`);
          if (stat.id !== 'anonymous') print(`    User ID: ${stat.id}`);
        }
        print();
      }
    });
  },
};
