/**
 * End-to-end tests: run the real CLI against a socket.io HedgeDoc stand-in.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HedgeDocClient } from '../../src/hedgedoc-client.js';
import { startTestServer, type TestServer } from './server.js';

// Each test spawns CLI processes; startup alone can take a second on a busy machine.
setDefaultTimeout(30_000);

const CLI = join(import.meta.dir, '../../bin/hedgesync.ts');
const tmp = mkdtempSync(join(tmpdir(), 'hedgesync-e2e-'));
let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server.close();
  rmSync(tmp, { recursive: true, force: true });
});

interface Result { code: number; stdout: string; stderr: string }

async function cli(args: string[], options: { stdin?: string; env?: Record<string, string> } = {}): Promise<Result> {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    stdin: options.stdin !== undefined ? new TextEncoder().encode(options.stdin) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: tmp,
      NO_COLOR: '1',
      HEDGESYNC_COOKIE_FILE: join(tmp, 'cookies.json'),
      ...options.env,
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

let counter = 0;
function newNote(document = '', permission = 'freely'): { id: string; url: string } {
  const id = `note${++counter}`;
  Object.assign(server.note(id), { document, permission });
  return { id, url: `${server.url}/${id}` };
}

/** A fake HOME with one Firefox profile holding the given session cookie for the test server. */
function browserHome(sid: string): string {
  const home = mkdtempSync(join(tmp, 'home-'));
  const root = join(home, '.mozilla', 'firefox');
  mkdirSync(join(root, 'p1.default'), { recursive: true });
  writeFileSync(join(root, 'profiles.ini'), '[Profile0]\nName=default\nIsRelative=1\nPath=p1.default\n');
  const db = new Database(join(root, 'p1.default', 'cookies.sqlite'));
  db.run(`CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT,
    value TEXT, host TEXT, path TEXT, isSecure INTEGER, lastAccessed INTEGER)`);
  db.run("INSERT INTO moz_cookies (name, value, host, path, isSecure, lastAccessed) VALUES ('connect.sid', ?, ?, '/', 0, 1)",
    [sid, new URL(server.url).hostname]);
  db.close();
  return home;
}

describe('reading', () => {
  test('get prints the document exactly (no added newline)', async () => {
    const { url } = newNote('line one\nline two');
    const r = await cli(['get', url, '-q']);
    expect(r).toMatchObject({ code: 0, stdout: 'line one\nline two' });
  });

  test('flags before the URL do not swallow it', async () => {
    const { url } = newNote('hello');
    const r = await cli(['get', '--json', url, '-q']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ success: true, content: 'hello' });
  });

  test('get -o writes a file', async () => {
    const { url } = newNote('to file');
    const out = join(tmp, 'out.md');
    expect((await cli(['get', url, '-o', out, '-q'])).code).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('to file');
  });

  test('info --json includes metadata and online users', async () => {
    const { url } = newNote('abc');
    const r = await cli(['info', url, '--json', '-q']);
    const info = JSON.parse(r.stdout);
    expect(info).toMatchObject({ success: true, permission: 'freely', length: 3, canEdit: true });
    expect(info.onlineUsers).toEqual([]); // the CLI's own connection is not listed
  });

  test('line reads a line', async () => {
    const { url } = newNote('a\nb\nc');
    expect((await cli(['line', url, '1', '-q'])).stdout).toBe('b');
    expect((await cli(['line', url, '9', '-q'])).code).toBe(1);
  });

  test('download uses the HTTP API', async () => {
    const { url } = newNote('via http');
    expect((await cli(['download', url])).stdout).toBe('via http');
  });

  test('published and slide URLs resolve to the note', async () => {
    const { id } = newNote('published');
    expect((await cli(['download', `${server.url}/${id}/publish`])).stdout).toBe('published');
  });
});

describe('editing', () => {
  test('set from stdin, argument and file', async () => {
    const { id, url } = newNote('old');
    expect((await cli(['set', url, '-q'], { stdin: 'from stdin\n' })).code).toBe(0);
    expect(server.note(id).document).toBe('from stdin\n');
    await cli(['set', url, 'from', 'args', '-q']);
    expect(server.note(id).document).toBe('from args');
    const file = join(tmp, 'in.md');
    writeFileSync(file, '# From file\n');
    await cli(['set', url, '-f', file, '-q']);
    expect(server.note(id).document).toBe('# From file\n');
  });

  test('get | set round trip keeps the document unchanged', async () => {
    const { id, url } = newNote('no trailing newline');
    const got = await cli(['get', url, '-q']);
    await cli(['set', url, '-q'], { stdin: got.stdout });
    expect(server.note(id).document).toBe('no trailing newline');
  });

  test('append, prepend and insert', async () => {
    const { id, url } = newNote('middle');
    await cli(['append', url, 'end', '-q']);
    await cli(['prepend', url, 'start', '-q']);
    await cli(['insert', url, '0', '>', '-q']);
    expect(server.note(id).document).toBe('>start\nmiddle\nend');
    const past = await cli(['insert', url, '999', 'x', '-q']);
    expect(past.code).toBe(1);
    expect(past.stderr).toContain('past the end');
  });

  test('replace: literal by default (including $ in the replacement), regex on request', async () => {
    const { id, url } = newNote('a.b a.b axb');
    await cli(['replace', url, 'a.b', '$&!', '--all', '-q']);
    expect(server.note(id).document).toBe('$&! $&! axb');
    await cli(['replace', url, 'a(x)b', '<$1>', '--regex', '-q']);
    expect(server.note(id).document).toBe('$&! $&! <x>');
  });

  test('replace without --all changes only the first match', async () => {
    const { id, url } = newNote('x x x');
    const r = await cli(['replace', url, 'x', 'y', '--json', '-q']);
    expect(JSON.parse(r.stdout).count).toBe(1);
    expect(server.note(id).document).toBe('y x x');
  });

  test('line sets a line', async () => {
    const { id, url } = newNote('a\nb\nc');
    await cli(['line', url, '1', 'B', '-q']);
    expect(server.note(id).document).toBe('a\nB\nc');
  });

  test('editing a read-only note fails clearly', async () => {
    const { id, url } = newNote('keep', 'locked');
    const r = await cli(['set', url, 'nope', '--json', '-q']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ success: false, permission: 'locked' });
    expect(server.note(id).document).toBe('keep');
  });

  test('exec runs a script with a client and arguments', async () => {
    const { id, url } = newNote('x');
    const script = join(tmp, 'script.ts');
    writeFileSync(script, 'export default (client, args) => { client.insert(client.getDocument().length, "+" + args.rest.join(",")); };');
    const r = await cli(['exec', script, url, '-q', '--', 'a', 'b']);
    expect(r.code).toBe(0);
    expect(server.note(id).document).toBe('x+a,b');
  });

  test('macro --exec passes note text as data, not code', async () => {
    const canary = join(tmp, 'PWNED');
    const { id, url } = newNote(`::e $(touch ${canary})::`);
    const r = await cli(['macro', url, '--exec', '/::e (.+?)::/:printf "<%s>" {1}', '-q']);
    expect(r.code).toBe(0);
    expect(server.note(id).document).toBe(`<$(touch ${canary})>`);
    expect(existsSync(canary)).toBe(false);
  });
});

describe('mirror', () => {
  test('follows source edits until interrupted', async () => {
    const source = newNote('v1');
    const target = newNote('');
    const proc = Bun.spawn(['bun', CLI, 'mirror', source.url, target.url, '--json'], {
      stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '', HOME: tmp, NO_COLOR: '1' },
    });
    const waitFor = async (cond: () => boolean) => {
      for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(25);
      expect(cond()).toBe(true);
    };
    await waitFor(() => server.note(target.id).document === 'v1');
    const editor = new HedgeDocClient({ serverUrl: server.url, noteId: source.id });
    await editor.connect();
    editor.insert(2, ' and v2');
    await editor.flush();
    await waitFor(() => server.note(target.id).document === 'v1 and v2');
    editor.disconnect();
    proc.kill('SIGINT');
    expect(await proc.exited).toBe(0);
    const events = (await new Response(proc.stdout).text()).trim().split('\n').map(l => JSON.parse(l).event);
    expect(events).toContain('ready');
    expect(events).toContain('sync');
  });
});

describe('arguments and errors', () => {
  test('unknown options are rejected', async () => {
    const r = await cli(['get', 'http://x/y', '--frobnicate']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Unknown option --frobnicate');
  });

  test('a value option without a value is an error', async () => {
    const r = await cli(['get', 'http://x/y', '-o']);
    expect(r.stderr).toContain('needs a value');
  });

  test('--json errors are JSON', async () => {
    const r = await cli(['get', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ success: false, error: 'Note URL required' });
  });

  test('help works for every command', async () => {
    const r = await cli(['help', 'mirror']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('hedgesync mirror');
    expect(r.stdout).not.toContain('\x1b['); // NO_COLOR respected
  });
});

describe('saved sessions', () => {
  test('commands use a cookie saved for the server', async () => {
    const anon = await cli(['me', server.url]);
    expect(anon.code).toBe(1);
    expect(anon.stderr).toContain('needs a session cookie');
    writeFileSync(join(tmp, 'cookies.json'), JSON.stringify({
      version: 1,
      servers: { [server.url]: { cookie: 'connect.sid=good', savedAt: new Date().toISOString() } },
    }));
    const r = await cli(['me', `${server.url}/`, '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).profile).toMatchObject({ status: 'ok', name: 'Tester' });
    rmSync(join(tmp, 'cookies.json'));
  });
});

describe('login --from-browser', () => {

  test('imports and saves a logged-in browser session', async () => {
    const cookieFile = join(tmp, 'browser-cookies.json');
    const r = await cli(['login', server.url, '--from-browser', 'firefox', '--save'],
      { env: { HOME: browserHome('good'), HEDGESYNC_COOKIE_FILE: cookieFile } });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Logged in as Tester (from firefox, profile default)');
    const saved = JSON.parse(readFileSync(cookieFile, 'utf8')).servers[server.url];
    expect(saved).toMatchObject({ cookie: 'connect.sid=good', source: { method: 'browser', browser: 'firefox', profile: 'default' } });

    const me = await cli(['me', server.url, '--json'], { env: { HEDGESYNC_COOKIE_FILE: cookieFile } });
    expect(JSON.parse(me.stdout).profile).toMatchObject({ name: 'Tester' });
  });

  test('a logged-out browser is an error, and bad options are rejected', async () => {
    const out = await cli(['login', server.url, '-b', 'firefox'], { env: { HOME: browserHome('expired') } });
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('not logged in');

    const bad = await cli(['login', server.url, '--from-browser', 'netscape']);
    expect(bad.stderr).toContain("Unsupported browser 'netscape'");
    const mixed = await cli(['login', server.url, '--from-browser', 'firefox', '-u', 'x']);
    expect(mixed.stderr).toContain('cannot be combined');
    const oidc = await cli(['login', 'oidc', server.url]);
    expect(oidc.stderr).toContain('--from-browser');
  });
});

describe('server detection', () => {
  test('status reports the HedgeDoc version', async () => {
    const r = await cli(['status', server.url, '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).server).toEqual({ protocol: 'hedgedoc1', version: '1.12.2' });
  });

  test('a HedgeDoc 2 server gets a clear error instead of a timeout', async () => {
    const hd2 = Bun.serve({
      port: 0,
      fetch: req => new URL(req.url).pathname === '/api/private/config'
        ? Response.json({ allowRegister: false, version: { major: 2, minor: 0, patch: 0, preRelease: 'alpha.3' } })
        : new Response('Not found', { status: 404 }),
    });
    try {
      const r = await cli(['get', `http://127.0.0.1:${hd2.port}/abc`, '--cookie', 'connect.sid=x']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('runs HedgeDoc 2.0.0-alpha.3, which hedgesync does not support yet');
    } finally {
      hd2.stop(true);
    }
  });
});

describe('note collection commands', () => {
  const auth = ['--cookie', 'connect.sid=good'];
  const day = 86_400_000;

  test('list shows history, pinned first, with filters', async () => {
    server.history.splice(0, server.history.length,
      { id: 'old', text: 'Old notes', time: Date.now() - 30 * day, tags: ['archive'], pinned: false },
      { id: 'fav', text: 'Favourite', time: Date.now() - 10 * day, tags: ['project'], pinned: true },
      { id: 'new', text: 'Fresh idea', time: Date.now() - 60_000, tags: ['project', 'idea'], pinned: false },
    );
    const all = await cli(['ls', server.url, '--json', ...auth]);
    expect(all.code).toBe(0);
    expect(JSON.parse(all.stdout).notes.map((n: { id: string }) => n.id)).toEqual(['fav', 'new', 'old']);
    expect(JSON.parse(all.stdout).notes[0].url).toBe(`${server.url}/fav`);

    const tagged = await cli(['list', server.url, '-t', 'project', '-t', 'idea', '-q', ...auth]);
    expect(tagged.stdout).toBe(`${server.url}/new\n`);
    const searched = await cli(['list', server.url, '-s', 'old', '-q', ...auth]);
    expect(searched.stdout).toBe(`${server.url}/old\n`);

    const human = await cli(['list', server.url, ...auth]);
    expect(human.stdout).toContain('★ Favourite');
    expect(human.stdout).toContain('1 minute ago');
    expect(human.stdout).toContain('#project #idea');

    const anon = await cli(['list', server.url]);
    expect(anon.code).toBe(1);
    expect(anon.stderr).toContain('needs a session cookie');
  });

  test('search finds lines in history notes', async () => {
    Object.assign(server.note('s1'), { document: '# Plans\n- TODO buy milk\n- done' });
    Object.assign(server.note('s2'), { document: '# Other\nnothing here' });
    server.history.splice(0, server.history.length,
      { id: 's1', text: 'Plans', time: Date.now(), tags: [], pinned: false },
      { id: 's2', text: 'Other', time: Date.now() - day, tags: [], pinned: false },
    );
    const r = await cli(['search', server.url, 'todo', '-i', ...auth]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Plans  ${server.url}/s1`);
    expect(r.stdout).toContain('   2: - TODO buy milk');
    expect(r.stdout).not.toContain('Other');

    const files = await cli(['search', server.url, 'n.th', '-r', '-l', '-q', ...auth]);
    expect(files.stdout).toBe(`${server.url}/s2\n`);
    const none = await cli(['search', server.url, 'absent', ...auth]);
    expect(none.code).toBe(1);
    expect(none.stdout).toBe('');
  });

  test('permission shows and changes, only for the owner', async () => {
    Object.assign(server.note('mine'), { document: 'x', permission: 'editable', owner: 'u1' });
    Object.assign(server.note('theirs'), { document: 'x', permission: 'editable', owner: 'someone-else' });
    Object.assign(server.note('orphan'), { document: 'x', permission: 'freely', owner: null });

    const show = await cli(['permission', `${server.url}/mine`]);
    expect(show.stdout).toContain('editable  anyone can view, signed-in users can edit');

    const set = await cli(['permission', `${server.url}/mine`, 'locked', ...auth]);
    expect(set.code).toBe(0);
    expect(set.stderr).toContain('Permission changed from editable to locked');
    expect(server.note('mine').permission).toBe('locked');

    const theirs = await cli(['permission', `${server.url}/theirs`, 'private', ...auth]);
    expect(theirs.code).toBe(1);
    expect(theirs.stderr).toContain("Only the note's owner can change its permission");
    expect(server.note('theirs').permission).toBe('editable');

    const orphan = await cli(['permission', `${server.url}/orphan`, 'private', ...auth]);
    expect(orphan.stderr).toContain('has no owner');
    const bad = await cli(['permission', `${server.url}/mine`, 'public']);
    expect(bad.stderr).toContain("Invalid permission 'public'");
  });

  test('delete needs confirmation and ownership', async () => {
    Object.assign(server.note('doomed'), { document: 'bye', owner: 'u1' });
    const noYes = await cli(['delete', `${server.url}/doomed`, ...auth]);
    expect(noYes.code).toBe(1);
    expect(noYes.stderr).toContain('Pass --yes');
    expect(server.notes.has('doomed')).toBe(true);

    const r = await cli(['delete', `${server.url}/doomed`, '--yes', '--json', ...auth]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ action: 'delete', noteId: 'doomed' });
    expect(server.notes.has('doomed')).toBe(false);
  });

  test('create --permission sets the permission of the new note', async () => {
    const r = await cli(['create', server.url, '-p', 'private', '--json', ...auth], { stdin: '# Secret' });
    expect(r.code).toBe(0);
    const { noteId, permission } = JSON.parse(r.stdout);
    expect(permission).toBe('private');
    expect(server.note(noteId)).toMatchObject({ document: '# Secret', owner: 'u1', permission: 'private' });

    const anon = await cli(['create', server.url, '-p', 'private'], { stdin: 'x' });
    expect(anon.stderr).toContain('needs a session cookie');
  });

  test('upload sends a multipart image and prints Markdown', async () => {
    const png = join(tmp, 'my [pic].png');
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const r = await cli(['upload', server.url, png]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^!\[my pic\]\(http:\/\/img\.test\/upload_\d+\.png\)\n$/);
    const body = server.uploads.at(-1)!;
    expect(body).toContain('filename="my [pic].png"');
    expect(body).toContain('Content-Type: image/png');
    expect(body).toContain('\x89PNG');
  });
});

describe('sharing, settings, revisions, presence', () => {
  test('publish prints the server-assigned published and slide URLs', async () => {
    const { id, url } = newNote('# Shared');
    expect((await cli(['publish', url])).stdout).toBe(`${server.url}/s/short-${id}\n`);
    expect((await cli(['links', url, '--slide'])).stdout).toBe(`${server.url}/p/short-${id}\n`);
    const all = JSON.parse((await cli(['publish', url, '--json'])).stdout);
    expect(all).toMatchObject({ edit: url, view: `${url}?view`, download: `${url}/download` });
    const missing = await cli(['publish', `${server.url}/does-not-exist`]);
    expect(missing.code).toBe(1);
    expect(server.notes.has('does-not-exist')).toBe(false);
  });

  test('meta shows and edits front matter with minimal edits', async () => {
    const { id, url } = newNote('---\ntitle: Plan\ntags: [work]\n---\n# Body\n');
    const shown = await cli(['meta', url]);
    expect(shown.stdout).toContain('title: Plan');
    expect(shown.stdout).toContain('tags:  work');
    expect((await cli(['meta', url, 'title'])).stdout).toBe('Plan\n');

    await cli(['meta', url, '--add-tag', 'idea', '--remove-tag', 'work', '-q']);
    await cli(['meta', url, 'type', 'slide', '-q']);
    await cli(['meta', url, '--unset', 'title', '-q']);
    expect(server.note(id).document).toBe('---\ntags: [idea]\ntype: slide\n---\n# Body\n');

    const plain = newNote('# No settings\n');
    await cli(['meta', plain.url, 'tags', 'a, b', '-q']);
    expect(server.note(plain.id).document).toBe('---\ntags: [a, b]\n---\n# No settings\n');
    expect((await cli(['meta', url, 'nope'])).stderr).toContain("No setting 'nope'");
  });

  test('revisions: list, show, diff and restore', async () => {
    const { id, url } = newNote('one\nTWO\nthree\nfour');
    server.note(id).revisions.push(
      { time: 1_700_000_000_000, content: 'one\ntwo' },
      { time: 1_700_000_100_000, content: 'one\ntwo\nthree' },
    );
    const listed = await cli(['revisions', url]);
    expect(listed.stdout).toMatch(/~0 +1700000100000 .* 13 chars {2}\+6/);
    expect(listed.stdout).toMatch(/~1 +1700000000000 .* 7 chars/);

    expect((await cli(['revisions', url, '~1'])).stdout).toBe('one\ntwo');
    expect((await cli(['revisions', url, '1700000100000'])).stdout).toBe('one\ntwo\nthree');

    const diff = await cli(['revisions', url, '~0', '--diff']);
    expect(diff.stdout).toContain('--- ~0');
    expect(diff.stdout).toContain('+++ current');
    expect(diff.stdout).toContain('-two\n+TWO\n three\n+four');
    const between = await cli(['revisions', url, '~1', '~0', '--diff', '--json']);
    expect(JSON.parse(between.stdout)).toMatchObject({ added: 1, removed: 0 });

    const restored = await cli(['revisions', url, '~1', '--restore']);
    expect(restored.code).toBe(0);
    expect(restored.stderr).toContain('+1 -3 lines');
    expect(server.note(id).document).toBe('one\ntwo');
    expect((await cli(['revisions', url, '~9'])).stderr).toContain('No revision ~9');
  });

  test('users lists other connections, not our own, and --watch reports joins', async () => {
    const { id, url } = newNote('x');
    const alone = await cli(['users', url, '--json']);
    expect(JSON.parse(alone.stdout).users).toEqual([]);

    const other = new HedgeDocClient({ serverUrl: server.url, noteId: id, reconnect: { enabled: false } });
    await other.connect();
    try {
      const r = await cli(['users', url, '--json']);
      const list = JSON.parse(r.stdout).users;
      expect(list.length).toBe(1);
      expect(list[0].id).toBe(other.socket!.id);

      const proc = Bun.spawn(['bun', CLI, 'users', url, '--watch', '--json'], {
        stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '', HOME: tmp, NO_COLOR: '1' },
      });
      const reader = proc.stdout.getReader();
      let out = '';
      const readUntil = async (needle: string) => {
        while (!out.includes(needle)) {
          const { value, done } = await reader.read();
          if (done) break;
          out += new TextDecoder().decode(value);
        }
      };
      await readUntil('"present"');
      const third = new HedgeDocClient({ serverUrl: server.url, noteId: id, reconnect: { enabled: false } });
      await third.connect();
      await readUntil('"join"');
      third.disconnect();
      await readUntil('"leave"');
      proc.kill('SIGINT');
      await proc.exited;
      const events = out.trim().split('\n').map(l => JSON.parse(l));
      expect(events.map(e => e.type)).toEqual(['present', 'join', 'leave']);
      expect(events[1].user.id).toBe(events[2].user.id);
    } finally {
      other.disconnect();
    }
  });
});

describe('sessions', () => {
  /** A cookie store with the given servers, in its own file. */
  function store(servers: Record<string, object>): string {
    const file = join(mkdtempSync(join(tmp, 'store-')), 'cookies.json');
    writeFileSync(file, JSON.stringify({ version: 1, servers }));
    return file;
  }
  const saved = (file: string) => JSON.parse(readFileSync(file, 'utf8')).servers;
  const old = '2026-01-01T00:00:00.000Z';

  test('refresh renews live sessions and re-imports expired browser sessions', async () => {
    const file = store({
      [server.url]: { cookie: 'connect.sid=expired', user: { id: 'u1', name: 'Tester' }, savedAt: old,
        source: { method: 'browser', browser: 'firefox', profile: 'default' } },
    });
    const r = await cli(['sessions', 'refresh'], { env: { HOME: browserHome('good'), HEDGESYNC_COOKIE_FILE: file } });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('had expired, re-imported from firefox');
    const after = saved(file)[server.url];
    expect(after).toMatchObject({ cookie: 'connect.sid=good', status: 'ok', source: { profile: 'default' } });
    expect(after.savedAt).not.toBe(old);

    const again = await cli(['sessions', 'refresh', '--json'], { env: { HEDGESYNC_COOKIE_FILE: file } });
    expect(JSON.parse(again.stdout).results).toEqual([{ server: server.url, user: 'Tester', result: 'alive' }]);
    expect(saved(file)[server.url].savedAt).toBe(after.savedAt); // a renewal is not a new cookie
  });

  test('refresh reports what needs attention, with exit status 1', async () => {
    const file = store({
      [server.url]: { cookie: 'connect.sid=expired', user: { id: 'u1', name: 'Tester' }, savedAt: old, source: { method: 'email' } },
      'http://127.0.0.1:9': { cookie: 'connect.sid=x', savedAt: old, source: { method: 'ldap' } },
    });
    const r = await cli(['sessions', 'refresh', '-q'], { env: { HEDGESYNC_COOKIE_FILE: file } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`✗ ${server.url} (Tester): expired (log in again)`);
    expect(r.stderr).toContain('! http://127.0.0.1:9: could not check');
    expect(saved(file)[server.url].status).toBe('expired');
    expect(saved(file)['http://127.0.0.1:9'].status).toBe('unreachable');

    // A browser now logged in as somebody else is not silently swapped in.
    const other = store({
      [server.url]: { cookie: 'connect.sid=expired', user: { id: 'someone-else', name: 'Other' }, savedAt: old,
        source: { method: 'browser', browser: 'firefox', profile: 'default' } },
    });
    const swapped = await cli(['sessions', 'refresh'], { env: { HOME: browserHome('good'), HEDGESYNC_COOKIE_FILE: other } });
    expect(swapped.code).toBe(1);
    expect(swapped.stderr).toContain('firefox is logged in as Tester, not Other');

    const list = await cli(['sessions'], { env: { HEDGESYNC_COOKIE_FILE: file } });
    expect(list.stdout).toContain(`${server.url}  expired`);
    expect(list.stdout).toContain('source:  email login');
    expect(list.stdout).toContain('Auto-refresh: off');
  });

  test('install-timer writes systemd user units and enables them', async () => {
    const config = mkdtempSync(join(tmp, 'xdg-'));
    const log = join(config, 'systemctl.log');
    const fake = join(config, 'systemctl');
    writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${log}'\n`, { mode: 0o755 });
    const env = { XDG_CONFIG_HOME: config, HEDGESYNC_SYSTEMCTL: fake, HEDGESYNC_COOKIE_FILE: join(config, 'my cookies.json') };

    const r = await cli(['sessions', 'install-timer', '--exec', '/opt/hedge sync/bin'], { env });
    expect(r.code).toBe(0);
    const unit = join(config, 'systemd', 'user');
    const service = readFileSync(join(unit, 'hedgesync-refresh.service'), 'utf8');
    expect(service).toContain('ExecStart="/opt/hedge sync/bin" sessions refresh -q');
    expect(service).toContain(`Environment="HEDGESYNC_COOKIE_FILE=${config}/my cookies.json"`);
    const timer = readFileSync(join(unit, 'hedgesync-refresh.timer'), 'utf8');
    expect(timer).toContain('OnCalendar=daily');
    expect(timer).toContain('Persistent=true');
    expect(readFileSync(log, 'utf8')).toBe('--user daemon-reload\n--user enable --now hedgesync-refresh.timer\n');

    const removed = await cli(['sessions', 'uninstall-timer'], { env });
    expect(removed.code).toBe(0);
    expect(existsSync(join(unit, 'hedgesync-refresh.timer'))).toBe(false);
    expect(readFileSync(log, 'utf8')).toContain('--user disable --now hedgesync-refresh.timer');
  });

  test('logout leaves a browser-imported session running unless --end-session', async () => {
    const browserSession = { cookie: 'connect.sid=shared', savedAt: old, source: { method: 'browser', browser: 'brave', profile: 'Default' } };
    const before = server.logouts.length;
    const file = store({ [server.url]: browserSession });
    const r = await cli(['logout', server.url], { env: { HEDGESYNC_COOKIE_FILE: file } });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('brave, which stays logged in');
    expect(server.logouts.length).toBe(before);
    expect(saved(file)).toEqual({});

    const file2 = store({ [server.url]: browserSession });
    await cli(['logout', server.url, '--end-session'], { env: { HEDGESYNC_COOKIE_FILE: file2 } });
    expect(server.logouts.slice(before)).toEqual(['connect.sid=shared']);
  });
});
