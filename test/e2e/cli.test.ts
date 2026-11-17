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

describe('mirror --strip', () => {
  test('the target never shows marked parts, even while they are typed', async () => {
    const source = newNote('Public intro.\n'); // freely: the GM edits as a guest here
    const target = newNote('', 'freely');
    const proc = Bun.spawn(['bun', CLI, 'mirror', source.url, target.url, '--strip', 'gm'], {
      stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '', HOME: tmp, NO_COLOR: '1' },
    });
    const waitFor = async (cond: () => boolean) => {
      for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(25);
      expect(cond()).toBe(true);
    };
    try {
      await waitFor(() => server.note(target.id).document === 'Public intro.\n');
      const gm = new HedgeDocClient({ serverUrl: server.url, noteId: source.id });
      await gm.connect();
      const seen: string[] = [];
      const watcher = new HedgeDocClient({ serverUrl: server.url, noteId: target.id });
      await watcher.connect();
      watcher.on('change', () => seen.push(watcher.getDocument()));
      // Typed piece by piece, the secret before the closing marker.
      for (const piece of ['<!-- g', 'm -->\n', 'The miller', ' is the cult leader.\n', '<!-- /gm -->\n', 'The door is locked.\n']) {
        gm.insert(gm.getDocument().length, piece);
        await gm.flush();
        await Bun.sleep(150);
      }
      await waitFor(() => server.note(target.id).document === 'Public intro.\nThe door is locked.\n');
      expect(seen.some(t => t.includes('miller') || t.includes('<!--'))).toBe(false);
      gm.disconnect();
      watcher.disconnect();
    } finally {
      proc.kill('SIGINT');
      await proc.exited;
    }
  });
});

describe('edit --new', () => {
  test('a file edited as a new note, with someone else, and written back', async () => {
    const file = join(tmp, 'COMMIT_EDITMSG');
    writeFileSync(file, '\n# Please enter the commit message\n');
    // The "editor" writes a subject line, then waits while a collaborator adds a line.
    const editor = `sh -c 'printf "Fix the bug\\n\\n# Please enter the commit message\\n" > "$1"; sleep 2' sh`;
    const proc = Bun.spawn(['bun', CLI, 'edit', '--new', server.url, file, '--editor', editor], {
      stdout: 'pipe', stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '', HOME: tmp, NO_COLOR: '1', HEDGESYNC_COOKIE_FILE: join(tmp, 'cookies.json'), HEDGEDOC_COOKIE: 'connect.sid=good' },
    });
    const reader = proc.stderr.getReader();
    let err = '';
    while (!/Editing together: (\S+)\?edit/.test(err)) {
      const { value, done } = await reader.read();
      if (done) break;
      err += new TextDecoder().decode(value);
    }
    const url = /Editing together: (\S+)\?edit/.exec(err)![1];
    const id = url.slice(url.lastIndexOf('/') + 1);
    const pair = new HedgeDocClient({ serverUrl: server.url, noteId: id });
    await pair.connect();
    for (let i = 0; i < 100 && !pair.getDocument().startsWith('Fix the bug'); i++) await Bun.sleep(25);
    pair.insert('Fix the bug\n'.length, '\nCo-authored-by: Pair <pair@example.com>\n');
    await pair.flush();
    expect(await proc.exited).toBe(0);
    pair.disconnect();
    expect(readFileSync(file, 'utf8')).toBe('Fix the bug\n\nCo-authored-by: Pair <pair@example.com>\n\n# Please enter the commit message\n');
  });

  async function startWait(file: string) {
    const proc = Bun.spawn(['bun', CLI, 'edit', '--new', server.url, file, '--wait'], {
      stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '', HOME: tmp, NO_COLOR: '1' },
    });
    const reader = proc.stderr.getReader();
    let err = '';
    while (!/Editing together: (\S+)\?edit[\s\S]*Ctrl\+C/.test(err)) {
      const { value, done } = await reader.read();
      if (done) break;
      err += new TextDecoder().decode(value);
    }
    const url = /Editing together: (\S+)\?edit/.exec(err)![1];
    const pair = new HedgeDocClient({ serverUrl: server.url, noteId: url.slice(url.lastIndexOf('/') + 1) });
    await pair.connect();
    return { proc, pair };
  }

  test('--wait: written in the browser, finished with /done', async () => {
    const file = join(tmp, 'MSG-wait');
    writeFileSync(file, '\n# comment\n');
    const { proc, pair } = await startWait(file);
    pair.insert(0, 'Written in the browser');
    pair.insert(pair.getDocument().length, '\n/done\n');
    await pair.flush();
    expect(await proc.exited).toBe(0);
    pair.disconnect();
    expect(readFileSync(file, 'utf8')).toBe('Written in the browser\n# comment\n');
  });

  test('--wait: Ctrl+C aborts and keeps the file', async () => {
    const file = join(tmp, 'MSG-abort');
    writeFileSync(file, 'original\n');
    const { proc, pair } = await startWait(file);
    pair.insert(0, 'changed ');
    await pair.flush();
    proc.kill('SIGINT');
    expect(await proc.exited).toBe(130);
    pair.disconnect();
    expect(readFileSync(file, 'utf8')).toBe('original\n');
  });

  test('a failing editor leaves the file alone', async () => {
    const file = join(tmp, 'MSG2');
    writeFileSync(file, 'original\n');
    const r = await cli(['edit', '--new', server.url, file, '--editor', `sh -c 'echo changed > "$1"; exit 1' sh`]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('is unchanged');
    expect(readFileSync(file, 'utf8')).toBe('original\n');
  });
});

describe('clip', () => {
  const home = () => join(tmp, 'clip-home');
  const env = () => ({ HOME: home(), HEDGESYNC_COOKIE_FILE: join(home(), 'cookies.json'), HEDGEDOC_COOKIE: 'connect.sid=good' });

  test('setup, copy, paste, list, and an entry written in the browser', async () => {
    let r = await cli(['clip', 'setup', server.url], { env: env() });
    expect(r.code).toBe(0);
    const url = r.stdout.trim();
    const id = url.slice(url.lastIndexOf('/') + 1);
    expect(server.note(id).permission).toBe('private');
    expect((await cli(['clip', 'setup', server.url], { env: env() })).stderr).toContain('Already set up');

    expect((await cli(['clip'], { env: env(), stdin: 'first\n' })).code).toBe(0);
    expect((await cli(['clip', 'copy', 'second', 'one'], { env: env() })).code).toBe(0);
    expect((await cli(['clip', 'paste'], { env: env() })).stdout).toBe('second one\n');
    expect((await cli(['clip', 'paste', '2'], { env: env() })).stdout).toBe('first\n');

    // On the phone: a new entry typed at the top.
    const doc = server.note(id).document;
    const at = doc.indexOf('\n## ') + 1;
    server.note(id).document = doc.slice(0, at) + '## phone\n\nfrom the phone\n\n' + doc.slice(at);
    r = await cli(['clip', 'list', '--json'], { env: env() });
    expect(JSON.parse(r.stdout).entries.map((e: { text: string }) => e.text)).toEqual(['from the phone', 'second one', 'first']);
  });

  test('images: copy uploads and shows them, paste gives the bytes back', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 0, 255]);
    const file = join(tmp, 'shot.png');
    writeFileSync(file, png);
    expect((await cli(['clip', 'copy', '--image', file], { env: env() })).code).toBe(0);
    const list = JSON.parse((await cli(['clip', 'list', '--json'], { env: env() })).stdout).entries;
    expect(list[0].text).toMatch(/^!\[shot\]\(http:\/\/127\.0\.0\.1:\d+\/uploads\/upload_\d+\.png\)$/);
    const out = join(tmp, 'pasted.png');
    expect((await cli(['clip', 'paste', '-o', out], { env: env() })).code).toBe(0);
    expect(readFileSync(out).equals(png)).toBe(true);
    // Piped: the bytes on stdout.
    const proc = Bun.spawn(['bun', CLI, 'clip', 'paste'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '', NO_COLOR: '1', ...env() } });
    const piped = Buffer.from(await new Response(proc.stdout).arrayBuffer());
    expect(await proc.exited).toBe(0);
    expect(piped.equals(png)).toBe(true);
  });

  test.skipIf(process.platform === 'win32')('watch moves images both ways', async () => {
    const board = join(tmp, 'img-board.png');
    const text = join(tmp, 'img-text.txt');
    writeFileSync(text, '');
    const proc = Bun.spawn(['bun', CLI, 'clip', 'watch', '--to-clipboard', '--from-clipboard', '--interval', '250'], {
      stdout: 'pipe', stderr: 'pipe',
      env: {
        PATH: process.env.PATH ?? '', NO_COLOR: '1', ...env(),
        HEDGESYNC_CLIP_COPY_CMD: `cat > '${text}'`, HEDGESYNC_CLIP_PASTE_CMD: `cat '${text}'`, HEDGESYNC_CLIP_TYPES_CMD: `test -s '${board}' && echo image/png || echo text/plain`,
        HEDGESYNC_CLIP_IMAGE_COPY_CMD: `cat > '${board}'`, HEDGESYNC_CLIP_IMAGE_PASTE_CMD: `cat '${board}' 2>/dev/null`,
      },
    });
    const waitFor = async (cond: () => boolean) => {
      for (let i = 0; i < 300 && !cond(); i++) await Bun.sleep(25);
      expect(cond()).toBe(true);
    };
    const newest = async () => JSON.parse((await cli(['clip', 'list', '--json'], { env: env() })).stdout).entries[0]?.text as string;
    try {
      await Bun.sleep(1500);
      // A screenshot on this machine goes to the note.
      const shot = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);
      writeFileSync(board, shot);
      let entry = '';
      for (let i = 0; i < 40 && !/^!\[/.test(entry); i++) { await Bun.sleep(250); entry = await newest(); }
      expect(entry).toMatch(/^!\[clipboard-[^\]]*\]\(http:\/\/127\.0\.0\.1:\d+\/uploads\/upload_\d+\.png\)$/);
      // An image copied elsewhere comes onto this clipboard.
      const other = Buffer.from([0x89, 0x50, 0x4e, 0x47, 7, 7]);
      const file = join(tmp, 'other.png');
      writeFileSync(file, other);
      expect((await cli(['clip', 'copy', '--image', file], { env: env() })).code).toBe(0);
      await waitFor(() => readFileSync(board).equals(other));
      // ... and is not sent back as a new entry.
      await Bun.sleep(1200);
      expect(await newest()).toMatch(/^!\[other\]/);
    } finally {
      proc.kill('SIGINT');
      await proc.exited;
    }
  });

  test.skipIf(process.platform === 'win32')('watch moves entries both ways and skips secrets', async () => {
    const board = join(tmp, 'clipboard.txt');
    const types = join(tmp, 'clipboard-types.txt');
    writeFileSync(board, 'before');
    writeFileSync(types, 'text/plain\n');
    const proc = Bun.spawn(['bun', CLI, 'clip', 'watch', '--to-clipboard', '--from-clipboard', '--interval', '250'], {
      stdout: 'pipe', stderr: 'pipe',
      env: {
        PATH: process.env.PATH ?? '', NO_COLOR: '1', ...env(),
        HEDGESYNC_CLIP_COPY_CMD: `cat > '${board}'`, HEDGESYNC_CLIP_PASTE_CMD: `cat '${board}'`, HEDGESYNC_CLIP_TYPES_CMD: `cat '${types}'`,
      },
    });
    const waitFor = async (cond: () => boolean) => {
      for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(25);
      expect(cond()).toBe(true);
    };
    try {
      await Bun.sleep(1500);
      // Copied on this machine: into the note.
      writeFileSync(board, 'copied here');
      await waitFor(() => /copied here/.test([...server.notes.values()].find(n => n.document.includes('# Clipboard'))?.document ?? ''));
      // A password manager's entry: not.
      writeFileSync(types, 'text/plain\nx-kde-passwordManagerHint\n');
      writeFileSync(board, 'hunter2');
      await Bun.sleep(800);
      // Copied elsewhere: into this clipboard.
      writeFileSync(types, 'text/plain\n');
      expect((await cli(['clip', 'copy', 'from elsewhere'], { env: env() })).code).toBe(0);
      await waitFor(() => readFileSync(board, 'utf8') === 'from elsewhere');
      const list = JSON.parse((await cli(['clip', 'list', '--json'], { env: env() })).stdout).entries.map((e: { text: string }) => e.text);
      expect(list).not.toContain('hunter2');
      expect(list.slice(0, 2)).toEqual(['from elsewhere', 'copied here']);
    } finally {
      proc.kill('SIGINT');
      await proc.exited;
    }
  });
});

describe('serve', () => {
  async function startServe(args: string[]) {
    const proc = Bun.spawn(['bun', CLI, 'serve', '--port', '0', ...args], {
      stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '', HOME: tmp, NO_COLOR: '1' },
    });
    const reader = proc.stderr.getReader();
    let err = '';
    while (!/Serving (http:\/\/\S+)/.test(err)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`serve exited: ${err}`);
      err += new TextDecoder().decode(value);
    }
    return { proc, base: /Serving (http:\/\/\S+)/.exec(err)![1] };
  }

  test('append, sections, stamps and replace over HTTP, next to a person typing', async () => {
    const note = newNote('# Ops\n\n## Timeline\n\n- 14:00 start\n\n## Notes\n');
    const { proc, base } = await startServe(['--note', `ops=${note.url}`, '--token', 'sekrit']);
    const auth = { authorization: 'Bearer sekrit' };
    try {
      expect((await fetch(`${base}/notes/ops`)).status).toBe(401);
      expect((await fetch(`${base}/notes/other`, { headers: auth })).status).toBe(404);
      expect(await (await fetch(`${base}/`, { headers: auth })).json()).toEqual({ ok: true, notes: ['ops'] });

      const person = new HedgeDocClient({ serverUrl: server.url, noteId: note.id });
      await person.connect();
      person.insert(person.getDocument().length, 'typed by a person\n');
      await person.flush();

      let r = await fetch(`${base}/notes/ops/append?section=Timeline&stamp=1`, { method: 'POST', headers: auth, body: '- deploy done' });
      expect(r.status).toBe(200);
      expect(server.note(note.id).document).toMatch(/- 14:00 start\n- \d\d:\d\d deploy done\n\n## Notes\ntyped by a person\n$/);

      r = await fetch(`${base}/notes/ops/append?token=sekrit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'from JSON' }) });
      expect(r.status).toBe(200);
      expect(server.note(note.id).document.endsWith('typed by a person\nfrom JSON\n')).toBe(true);

      r = await fetch(`${base}/notes/ops?section=Notes`, { method: 'PUT', headers: auth, body: 'replaced' });
      expect(server.note(note.id).document.endsWith('## Notes\n\nreplaced\n')).toBe(true);
      expect(await (await fetch(`${base}/notes/ops`, { headers: auth })).text()).toBe(server.note(note.id).document);

      r = await fetch(`${base}/notes/ops/append?section=Missing`, { method: 'POST', headers: auth, body: 'x' });
      expect(r.status).toBe(404);
      person.disconnect();
    } finally {
      proc.kill('SIGINT');
      await proc.exited;
    }
  });

  test('another address needs a token', async () => {
    const note = newNote('');
    const r = await cli(['serve', '--note', `x=${note.url}`, '--host', '0.0.0.0', '--port', '0']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('needs a token');
  });
});

describe('prank ghost with a persona', () => {
  test('--ghost-persona needs an agent and no --ghost-message', async () => {
    const url = newNote('').url;
    let r = await cli(['prank', url, '--ghost', '5', '--ghost-persona', 'snarky']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('--agent');
    r = await cli(['prank', url, '--ghost', '5', '--ghost-persona', 'snarky', '--ghost-message', 'hi', '--agent', 'cat']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("--ghost-message and --ghost-persona don't go together");
    r = await cli(['prank', url, '--ghost-persona', 'snarky', '--agent', 'cat']);
    expect(r.stderr).toContain('--ghost-persona goes with --ghost');
  });

  test.skipIf(process.platform === 'win32')('the agent\'s remark is typed inline after its quote', async () => {
    const note = newNote('# Plan\n\nShip on Friday.\n');
    const agent = `sh -c 'cat > /dev/null; printf "%s" "{\\"quote\\": \\"Friday.\\", \\"say\\": \\"sure.\\", \\"inline\\": true}"'`;
    const proc = Bun.spawn(['bun', CLI, 'prank', note.url, '--ghost', '1', '--ghost-persona', 'a snarky ghost',
      '--ghost-linger', '--agent', agent, '--settle', '0.3'], {
      stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '', HOME: tmp, NO_COLOR: '1' },
    });
    try {
      const person = new HedgeDocClient({ serverUrl: server.url, noteId: note.id });
      await person.connect();
      await Bun.sleep(1200);
      person.insert(person.getDocument().length, '\nNext');
      await person.flush();
      for (let i = 0; i < 400 && !server.note(note.id).document.includes('Friday. sure.'); i++) await Bun.sleep(25);
      expect(server.note(note.id).document).toBe('# Plan\n\nShip on Friday. sure.\n\nNext');
      person.disconnect();
    } finally {
      proc.kill('SIGINT');
      await proc.exited;
    }
    expect(await new Response(proc.stderr).text()).toContain('The ghost is a snarky ghost');
  });
});

describe('assistant', () => {
  const waitFor = async (cond: () => boolean, tries = 400) => {
    for (let i = 0; i < tries && !cond(); i++) await Bun.sleep(25);
    expect(cond()).toBe(true);
  };

  test.skipIf(process.platform === 'win32')('a command agent answers a mention, streaming, with the request in its environment', async () => {
    const note = newNote('# Plan\n\nShip on Friday.\n\n@ai old question\n');
    // Streams in two parts; echoes what it was given.
    const agent = `sh -c 'grep -q "Ship on Friday" "$HEDGESYNC_NOTE_FILE" && printf "Four"; sleep 0.8; printf ", asked: %s" "$HEDGESYNC_REQUEST"'`;
    const proc = Bun.spawn(['bun', CLI, 'assistant', note.url, '--agent', agent, '--settle', '0.3'], {
      stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '', HOME: tmp, NO_COLOR: '1' },
    });
    try {
      const person = new HedgeDocClient({ serverUrl: server.url, noteId: note.id });
      await person.connect();
      await Bun.sleep(1200); // the assistant is up; the old question stays unanswered
      person.insert(person.getDocument().length, '\n@ai what is 2+2?\n');
      await person.flush();
      // The first part shows while the agent still works (the marker is there until it is done).
      await waitFor(() => /> \*\*ai:\*\* <!-- hedgesync:\S+ --> Four$/m.test(server.note(note.id).document));
      await waitFor(() => server.note(note.id).document.includes('asked: @ai what is 2+2?'));
      await waitFor(() => !server.note(note.id).document.includes('<!-- hedgesync:'));
      expect(server.note(note.id).document).toBe('# Plan\n\nShip on Friday.\n\n@ai old question\n\n@ai what is 2+2?\n\n> **ai:** Four, asked: @ai what is 2+2?\n');
      person.disconnect();
    } finally {
      proc.kill('SIGINT');
      await proc.exited;
    }
  });

  test.skipIf(process.platform === 'win32')('--allow: requests from others are left alone', async () => {
    const note = newNote('');
    const proc = Bun.spawn(['bun', CLI, 'assistant', note.url, '--agent', 'printf answered', '--allow', 'alice', '--settle', '0.3'], {
      stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '', HOME: tmp, NO_COLOR: '1' },
    });
    try {
      const person = new HedgeDocClient({ serverUrl: server.url, noteId: note.id }); // a guest, not alice
      await person.connect();
      await Bun.sleep(1200);
      person.insert(0, '@ai hello\n');
      await person.flush();
      await Bun.sleep(1500);
      expect(server.note(note.id).document).toBe('@ai hello\n');
      person.disconnect();
    } finally {
      proc.kill('SIGINT');
      await proc.exited;
    }
    expect(await new Response(proc.stderr).text()).toContain('not in --allow');
  });

  test('an OpenAI-compatible API, streamed', async () => {
    let body: any;
    const api = Bun.serve({
      port: 0,
      async fetch(req) {
        body = await req.json();
        const events = ['Hel', 'lo!'].map(t => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
        return new Response(events, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const note = newNote('');
    const proc = Bun.spawn(['bun', CLI, 'assistant', note.url, '--api', `http://127.0.0.1:${api.port}/v1`, '--model', 'm1', '--name', 'bot', '--settle', '0.3'], {
      stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '', HOME: tmp, NO_COLOR: '1', OPENAI_API_KEY: 'k' },
    });
    try {
      const person = new HedgeDocClient({ serverUrl: server.url, noteId: note.id });
      await person.connect();
      await Bun.sleep(1200);
      person.insert(0, 'Hi @bot\n');
      await person.flush();
      await waitFor(() => server.note(note.id).document === 'Hi @bot\n\n> **bot:** Hello!\n');
      expect(body.model).toBe('m1');
      expect(body.stream).toBe(true);
      expect(body.messages[1].content).toContain('Hi @bot');
      person.disconnect();
    } finally {
      proc.kill('SIGINT');
      await proc.exited;
      api.stop(true);
    }
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
    expect(r.stdout).toMatch(/^!\[my pic\]\(http:\/\/127\.0\.0\.1:\d+\/uploads\/upload_\d+\.png\)\n$/);
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

describe('terminal', () => {
  test('refuses to start without a signed-in account or --anyone', async () => {
    const { url } = newNote('');
    const r = await cli(['terminal', url]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('--anyone');
  });

  test('runs commands typed into the note and closes the block on exit', async () => {
    const { id, url } = newNote('# Ops\n');
    const proc = Bun.spawn(['bun', CLI, 'terminal', url, '--anyone', '--shell', 'sh', '--json'], {
      stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH ?? '', HOME: tmp, NO_COLOR: '1' },
    });
    const human = new HedgeDocClient({ serverUrl: server.url, noteId: id, reconnect: { enabled: false } });
    await human.connect();
    const until = async (cond: () => boolean) => {
      const deadline = Date.now() + 15_000;
      while (!cond()) {
        if (Date.now() > deadline) throw new Error(`timed out; note: ${JSON.stringify(human.document)}`);
        await Bun.sleep(20);
      }
    };
    try {
      await until(() => human.document.includes('$ \n```'));
      human.insert(human.document.lastIndexOf('```') - 1, 'echo "hi from $HEDGESYNC_NOTE"\n');
      await until(() => human.document.includes(`hi from ${url}\n$ \n`));
      proc.kill('SIGINT');
      expect(await proc.exited).toBe(0);
      await until(() => human.document.includes('[terminal closed]'));
      expect(human.document).toBe(`# Ops\n\n\`\`\`terminal\n$ echo "hi from $HEDGESYNC_NOTE"\nhi from ${url}\n[terminal closed]\n\`\`\`\n`);
      const events = (await new Response(proc.stdout).text()).trim().split('\n').map(l => JSON.parse(l));
      expect(events.map(e => e.event)).toEqual(['command', 'done']);
      expect(events[1].code).toBe(0);
    } finally {
      human.disconnect();
      proc.kill();
    }
  });
});

describe('editor nvim', () => {
  test('install, status, path, uninstall', async () => {
    const dir = join(tmp, 'nvim-plugin');
    let r = await cli(['editor', 'nvim', 'status', '--dir', dir, '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ state: 'missing' });

    r = await cli(['editor', 'nvim', 'install', '--dir', dir]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('installed');
    expect(r.stderr).toContain('run again with --lazy');
    expect(existsSync(join(dir, 'lua/hedgesync/init.lua'))).toBe(true);

    r = await cli(['editor', 'nvim', 'status', '--dir', dir, '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ state: 'current', protocol: 1 });

    writeFileSync(join(dir, 'plugin/hedgesync.lua'), '-- edited');
    r = await cli(['editor', 'nvim', 'install', '--dir', dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('local changes');
    expect((await cli(['editor', 'nvim', 'install', '--dir', dir, '--force'])).code).toBe(0);

    r = await cli(['editor', 'nvim', 'path'], { env: { XDG_DATA_HOME: '/data' } });
    expect(r.stdout.trim()).toBe('/data/nvim/site/pack/hedgesync/start/hedgesync.nvim');

    expect((await cli(['editor', 'nvim', 'uninstall', '--dir', dir])).code).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  test('--lazy writes a lazy.nvim spec, and uninstall removes it', async () => {
    const dir = join(tmp, 'nvim-lazy', 'plugin');
    const spec = join(tmp, 'nvim-lazy', 'config', 'lua', 'plugins', 'hedgesync.lua');
    let r = await cli(['editor', 'nvim', 'install', '--dir', dir, '--lazy-file', spec, '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ action: 'installed', lazySpec: spec });
    expect(readFileSync(spec, 'utf8')).toContain(`local dir = "${dir}"`);

    r = await cli(['editor', 'nvim', 'status', '--dir', dir]);
    expect(r.stdout).toContain(`lazy spec:   ${spec}`);

    // With XDG_CONFIG_HOME, --lazy alone writes into that config.
    r = await cli(['editor', 'nvim', 'install', '--dir', dir, '--lazy'], { env: { XDG_CONFIG_HOME: join(tmp, 'nvim-lazy', 'xdg') } });
    expect(r.code).toBe(0);
    expect(existsSync(join(tmp, 'nvim-lazy', 'xdg', 'nvim', 'lua', 'plugins', 'hedgesync.lua'))).toBe(true);

    r = await cli(['editor', 'nvim', 'uninstall', '--dir', dir]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('Removed the lazy.nvim spec');
  });

  test('bridge --info reports the protocol', async () => {
    const r = await cli(['bridge', '--info']);
    expect(JSON.parse(r.stdout)).toMatchObject({ protocol: 1 });
  });
});

describe('share', () => {
  async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    let text = '';
    while (!text.includes('\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    return text.trim();
  }
  const until = async (what: string, cond: () => boolean) => {
    for (let i = 0; i < 300 && !cond(); i++) await Bun.sleep(20);
    if (!cond()) throw new Error(`timed out: ${what}`);
  };

  test('shares a file as a note and keeps both in sync until Ctrl+C', async () => {
    const file = join(tmp, 'shared.py');
    writeFileSync(file, 'print("hi")\n');
    const proc = Bun.spawn(['bun', CLI, 'share', file, server.url], {
      stdout: 'pipe', stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '', HOME: tmp, NO_COLOR: '1', HEDGESYNC_COOKIE_FILE: join(tmp, 'cookies.json') },
    });
    try {
      const link = await readLine(proc.stdout);
      expect(link).toMatch(/\/created\d+\?edit$/);
      const id = /\/(created\d+)\?/.exec(link)![1];
      expect(server.note(id).document).toBe('print("hi")');

      writeFileSync(file, 'print("hi")\nprint("saved")\n');
      await until('the save reaching the note', () => server.note(id).document.includes('saved'));

      const other = new HedgeDocClient({ serverUrl: server.url, noteId: id });
      await other.connect();
      other.insert(0, '# remote\n');
      await other.flush();
      other.disconnect();
      await until('the remote edit reaching the file', () => readFileSync(file, 'utf8').startsWith('# remote'));
      expect(readFileSync(file, 'utf8')).toBe('# remote\nprint("hi")\nprint("saved")\n');

      proc.kill('SIGINT');
      expect(await proc.exited).toBe(0);
    } finally {
      proc.kill();
    }
  });

  test('joining a note writes it into the file; an existing other file needs --force', async () => {
    const { url } = newNote('fn main() {}');
    const file = join(tmp, 'joined.rs');
    writeFileSync(file, 'something else\n');
    const refused = await cli(['share', file, url]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('exists with other content');
    expect(readFileSync(file, 'utf8')).toBe('something else\n');
  });
});

describe('edit', () => {
  const waitFor = async (check: () => boolean, timeout = 10_000) => {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > timeout) throw new Error('timed out');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  test('a non-Neovim editor: saves are merged into the note, keeping concurrent edits', async () => {
    const { id, url } = newNote('one\ntwo\nthree\n');
    // An "editor" that saves twice: the first save must reach the note before it exits.
    const script = join(tmp, 'fake-editor.sh');
    writeFileSync(script, `#!/bin/sh
f="$1"
sed -i 's/one/ONE/' "$f"
sleep 1.5
sed -i 's/three/THREE/' "$f"
`);
    const run = cli(['edit', url, '--editor', `sh ${script}`]);
    await waitFor(() => server.note(id).document.startsWith('ONE'));
    const other = new HedgeDocClient({ serverUrl: server.url, noteId: id, reconnect: { enabled: false } });
    await other.connect();
    other.insert(other.getDocument().indexOf('two'), 'remote ');
    await other.flush();
    other.disconnect();
    const r = await run;
    expect(r.code).toBe(0);
    expect(server.note(id).document).toBe('ONE\nremote two\nTHREE\n');
  });

  test('a note without a final newline keeps it that way; read-only notes say why', async () => {
    const { id, url } = newNote('alpha\nbeta');
    const r = await cli(['edit', url, '--editor', 'sed -i s/alpha/ALPHA/']);
    expect(r.code).toBe(0);
    expect(server.note(id).document).toBe('ALPHA\nbeta');

    const locked = newNote('x', 'locked');
    const ro = await cli(['edit', locked.url, '--editor', 'sed -i s/x/y/']);
    expect(ro.stderr).toContain('Read-only, changes will not be saved: Only the owner can edit this note (permission: locked)');
    expect(server.note(locked.id).document).toBe('x');
  });

  test('without a note it browses, which needs Neovim', async () => {
    const r = await cli(['edit', '--editor', 'vi']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Browsing notes needs Neovim');
  });

  test('fails before starting Neovim when the note cannot be reached', async () => {
    const marker = join(tmp, 'editor-started');
    const r = await cli(['edit', 'http://127.0.0.1:1/nothing', '--editor', `nvim-would-start; touch ${marker}`]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Could not connect');
    expect(existsSync(marker)).toBe(false);
  });

  test.skipIf(!Bun.which('nvim'))('Neovim edits live through the plugin, even when the config does not load it', async () => {
    const { id, url } = newNote('from the server\n');
    const lua = join(tmp, 'edit-live.lua');
    writeFileSync(lua, `
local function poll()
  local hs = package.loaded["hedgesync"]
  local s = hs and hs.session(0)
  if not (s and s.loaded) then return vim.defer_fn(poll, 50) end
  vim.api.nvim_buf_set_lines(0, -1, -1, false, { "typed in nvim" })
  vim.defer_fn(function() vim.cmd("qa!") end, 800)
end
vim.defer_fn(poll, 50)
`);
    const r = await cli(['edit', url, '--editor', `nvim --headless --clean -n -c "luafile ${lua}"`], {
      env: { XDG_CACHE_HOME: join(tmp, 'cache'), XDG_DATA_HOME: join(tmp, 'data') },
    });
    expect(r.code).toBe(0);
    expect(server.note(id).document).toBe('from the server\n\ntyped in nvim');
  });
});
