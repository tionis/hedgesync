/**
 * Read-only realtime commands: info, users, authors.
 */

import type { HedgeDocClient, UserInfo } from '../../hedgedoc-client.js';
import { connectionOptions, type Command } from '../context.js';
import { helpText } from '../help-text.js';
import { c, print, printJsonLine } from '../ui.js';

/** Ask for the online user list and wait for the answer (or give up after `ms`). */
/** Online users other than this CLI's own connection, after asking the server for a fresh list. */
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
  return othersOnline(client);
}

function othersOnline(client: HedgeDocClient): UserInfo[] {
  const self = client.socket?.id;
  return client.getOnlineUsers().filter(u => u.id !== self);
}

const signedIn = (u: UserInfo) => !!(u.login || u.userid);
const describeUser = (u: UserInfo) => `${u.name || 'Guest'}${signedIn(u) ? '' : c('dim', ' (guest)')}`;

export const info: Command = {
  name: 'info',
  summary: 'Show note metadata and online users',
  options: [...connectionOptions],
  help: helpText.info,
  async run(ctx) {
    await ctx.withClient({}, async (client) => {
      const users = await fetchOnlineUsers(client);
      // View count and published URL come from HTTP; leave them out if that fails.
      const api = ctx.api(client.serverUrl);
      const [details, links] = await Promise.all([
        api.getNoteInfo(client.noteId).catch(() => null),
        api.getNoteLinks(client.noteId).catch(() => null),
      ]);
      const note = client.getNoteInfo();
      const revision = client.getRevision();
      const length = client.getDocument().length;
      const lines = client.getLineCount();
      ctx.result({
        action: 'info', ...note, revision, length, lines, canEdit: client.canEdit(), onlineUsers: users,
        viewcount: details?.viewcount ?? null, description: details?.description ?? null, links,
      }, () => {
        const date = (t: unknown) => (t ? new Date(t as string).toLocaleString() : 'unknown');
        print(`${c('bold', 'Title:')} ${note.title || '(untitled)'}`);
        print(`${c('bold', 'Permission:')} ${note.permission}${client.canEdit() ? '' : c('dim', ' (read-only for you)')}`);
        print(`${c('bold', 'Owner:')} ${note.owner || '(none)'}`);
        print(`${c('bold', 'Created:')} ${date(note.createtime)}`);
        print(`${c('bold', 'Updated:')} ${date(note.updatetime)}`);
        print(`${c('bold', 'Revision:')} ${revision}`);
        print(`${c('bold', 'Length:')} ${length} characters, ${lines} lines`);
        if (details) print(`${c('bold', 'Views:')} ${details.viewcount}`);
        if (links) print(`${c('bold', 'Published:')} ${links.publish}`);
        print(`${c('bold', 'Online:')} ${users.length === 0 ? c('dim', '(nobody else)') : users.length}`);
        for (const user of users) print(`  ● ${describeUser(user)}`);
      });
    });
  },
};

export const users: Command = {
  name: 'users',
  summary: 'List who else is in the note (or --watch them come and go)',
  options: [...connectionOptions, { name: 'watch', short: 'w', type: 'flag' }],
  help: () => `
${c('bold', 'hedgesync users')} - List who else has the note open

${c('yellow', 'USAGE:')}
  hedgesync users <url> [--watch]

Lists the other connections to the note (this command's own connection is
left out). Guests are anonymous visitors. The same account can appear more
than once, once per open tab.

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-w, --watch')}    Keep running and report people joining and leaving (Ctrl+C to stop)
  ${c('cyan', '--json')}         JSON (with --watch: one JSON object per line)
`,
  async run(ctx) {
    if (!ctx.flag('watch')) {
      const list = await ctx.withClient({}, client => fetchOnlineUsers(client));
      ctx.result({ action: 'users', count: list.length, users: list }, () => {
        if (list.length === 0) {
          print(c('dim', 'Nobody else is in this note'));
          return;
        }
        for (const user of list) print(`  ● ${describeUser(user)}`);
      });
      return;
    }

    const client = await ctx.connect(0);
    const known = new Map<string, UserInfo>();
    const report = (type: 'join' | 'leave', user: UserInfo) => {
      if (ctx.json) printJsonLine({ type, time: new Date().toISOString(), user });
      else print(`${c('dim', new Date().toLocaleTimeString())} ${type === 'join' ? c('green', '→ joined') : c('red', '← left  ')} ${describeUser(user)}`);
    };
    const sync = () => {
      const now = new Map(othersOnline(client).map(u => [u.id, u]));
      for (const [id, user] of now) if (!known.has(id)) report('join', user);
      for (const [id, user] of known) if (!now.has(id)) report('leave', user);
      known.clear();
      for (const [id, user] of now) known.set(id, user);
    };
    for (const user of await fetchOnlineUsers(client)) known.set(user.id, user);
    if (!ctx.json) {
      print(known.size ? c('bold', `In the note now (${known.size}):`) : c('dim', 'Nobody else is in the note yet'));
      for (const user of known.values()) print(`  ● ${describeUser(user)}`);
      ctx.info(c('dim', 'Watching for people joining and leaving (Ctrl+C to stop)...'));
    } else {
      for (const user of known.values()) printJsonLine({ type: 'present', time: new Date().toISOString(), user });
    }
    client.on('users', sync);
    client.on('user:status', sync);
    client.on('user:left', sync);
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
      client.on('delete', resolve);
    });
    client.disconnect();
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
