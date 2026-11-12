/**
 * End-to-end tests: run the real CLI against a socket.io HedgeDoc stand-in.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HedgeDocClient } from '../../src/hedgedoc-client.js';
import { startTestServer, type TestServer } from './server.js';

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
    expect(info.onlineUsers.length).toBeGreaterThanOrEqual(1);
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
