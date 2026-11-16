/**
 * End-to-end: headless Neovim with the plugin in editors/nvim, the real
 * `hedgesync bridge` process, and the socket.io HedgeDoc stand-in, while
 * another client edits the same note. Everyone must end with the same text.
 * Skipped when nvim is not installed.
 *
 * Reproduce with NVIM_SEED=<seed> bun test test/e2e/nvim.test.ts
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HedgeDocClient } from '../../src/hedgedoc-client.js';
import { TextOperation } from '../../src/text-operation.js';
import { rng, tick } from '../sim/sim-server.js';
import { startTestServer, type TestServer } from './server.js';

setDefaultTimeout(120_000);

const NVIM = Bun.which('nvim');
const ROOT = join(import.meta.dir, '../..');
const CLI = join(ROOT, 'bin/hedgesync.ts');
const PLUGIN = join(ROOT, 'editors/nvim');
const tmp = mkdtempSync(join(tmpdir(), 'hedgesync-nvim-'));
let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server?.close();
  rmSync(tmp, { recursive: true, force: true });
});

const SCRIPT = join(import.meta.dir, 'nvim-session.lua');
async function waitForFile(path: string, timeout: number): Promise<void> {
  const start = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${path}`);
    await tick(20);
  }
}

async function runSession(seed: number, steps: number, remoteEdits: number) {
  const id = `nvim${seed}`;
  Object.assign(server.note(id), { document: 'first line\nsecond line\n\nthird é line', permission: 'freely' });
  const dir = mkdtempSync(join(tmp, `s${seed}-`));
  const files = Object.fromEntries(['ready', 'done', 'out', 'log'].map(f => [f, join(dir, f)]));

  const nvim = Bun.spawn([NVIM!, '--headless', '--clean', '-n', '-l', SCRIPT], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: dir,
      NO_COLOR: '1',
      HEDGESYNC_COOKIE_FILE: join(dir, 'cookies.json'),
      PLUGIN,
      ...(process.env.HEDGESYNC_BRIDGE_LOG ? { HEDGESYNC_BRIDGE_LOG: process.env.HEDGESYNC_BRIDGE_LOG } : {}),
      CLI,
      URL: `${server.url}/${id}`,
      SEED: String(seed),
      STEPS: String(steps),
      READY: files.ready,
      DONE: files.done,
      OUT: files.out,
      LOG: files.log,
    },
  });

  try {
    await Promise.race([
      waitForFile(files.ready, 30_000),
      waitForFile(files.out, 30_000).then(() => {
        throw new Error(`nvim could not load the note:\n${readFileSync(files.out, 'utf8')}`);
      }),
    ]);
    const other = new HedgeDocClient({ serverUrl: server.url, noteId: id, reconnect: { enabled: false } });
    await other.connect();
    const r = rng(seed);
    for (let i = 0; i < remoteEdits; i++) {
      const doc = other.getDocument();
      // Like a real editor, never split a surrogate pair (an emoji typed in nvim).
      const isLow = (i: number) => /[\uDC00-\uDFFF]/.test(doc[i] ?? '');
      let pos = Math.floor(r() * (doc.length + 1));
      if (isLow(pos)) pos--;
      let len = Math.floor(r() * Math.min(3, doc.length - pos + 1));
      if (isLow(pos + len)) len++;
      const text = ['R', 'rem\n', 'ü', '', '\n', '🎉'][Math.floor(r() * 6)];
      other.applyOperation(new TextOperation().retain(pos).delete(len).insert(text || 'r').retain(doc.length - pos - len));
      other.setCursor({ line: 0, ch: Math.floor(r() * 3) });
      await tick(Math.floor(r() * 12));
    }
    await other.flush();
    writeFileSync(files.done, '');

    const code = await nvim.exited;
    const stderr = await new Response(nvim.stderr).text();
    // Headless nvim prints mode messages ("-- INSERT --") to stderr too; only errors count.
    expect({ code, errors: stderr.match(/(E\d+:|Error|stack traceback).*/g) }).toEqual({ code: 0, errors: null });
    const editorText = readFileSync(files.out, 'utf8');
    const notes = readFileSync(files.log, 'utf8');
    await tick(300);
    expect(notes).not.toMatch(/resync|could not apply|bridge exited/);
    expect(editorText).toBe(server.note(id).document);
    expect(other.getDocument()).toBe(server.note(id).document);
    other.disconnect();
  } catch (err) {
    nvim.kill();
    const read = (stream: ReadableStream) => (stream.locked ? Promise.resolve('(read above)') : new Response(stream).text());
    const [out, errText] = await Promise.all([read(nvim.stdout), read(nvim.stderr)]);
    throw new Error(`${(err as Error).message}\n--- nvim stdout ---\n${out.slice(-2000)}\n--- nvim stderr ---\n${errText.slice(-2000)}`);
  } finally {
    nvim.kill();
  }
}

describe.skipIf(!NVIM)('neovim plugin', () => {
  const seeds = process.env.NVIM_SEED ? [Number(process.env.NVIM_SEED)] : [1, 2, 3];
  for (const seed of seeds) {
    test(`concurrent editing converges (seed ${seed})`, async () => {
      await runSession(seed, 250, 150);
    });
  }
});

/** Run headless nvim with the plugin from `rtp`, a setup() cmd, and a Lua snippet; returns what it wrote to $OUT. */
async function nvimWith(rtp: string, cmd: string[], lua: string): Promise<string> {
  const dir = mkdtempSync(join(tmp, 'misc-'));
  const out = join(dir, 'out');
  const script = join(dir, 'script.lua');
  writeFileSync(script, `
vim.opt.rtp:prepend(vim.env.RTP)
vim.cmd("runtime plugin/hedgesync.lua")
local notes = {}
vim.notify = function(msg) table.insert(notes, msg) end
local hs = require("hedgesync")
hs.setup({ cmd = vim.json.decode(vim.env.CMD) })
local function finish(text)
  local f = io.open(vim.env.OUT, "w"); f:write(text); f:close()
  vim.cmd("qa!")
end
${lua}
`);
  const proc = Bun.spawn([NVIM!, '--headless', '--clean', '-n', '-l', script], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', HOME: dir, RTP: rtp, CMD: JSON.stringify(cmd), OUT: out, HEDGESYNC_COOKIE_FILE: join(dir, 'cookies.json') },
  });
  await proc.exited;
  if (!existsSync(out)) throw new Error(`nvim wrote nothing:\n${await new Response(proc.stderr).text()}`);
  return readFileSync(out, 'utf8');
}

const OPEN_AND_REPORT = `
local buf = hs.open("http://127.0.0.1:1/x")
vim.wait(5000, function() return hs.session(buf) == nil or hs.session(buf).closed end, 20)
vim.wait(300)
finish(table.concat(notes, "\\n"))
`;

describe.skipIf(!NVIM)('neovim plugin setup checks', () => {
  test('refuses a bridge that speaks another protocol', async () => {
    const fake = ['sh', '-c', `echo '{"t":"ready","protocol":99,"version":"9.9.9"}'; sleep 3`, 'sh'];
    const notes = await nvimWith(PLUGIN, fake, OPEN_AND_REPORT);
    expect(notes).toContain('hedgesync 9.9.9 speaks editor protocol 99, this plugin speaks 1: run `hedgesync editor nvim install`');
  });

  test('says so when the CLI has no bridge command', async () => {
    const old = ['sh', '-c', 'echo "Unknown command: bridge" >&2; exit 1', 'sh'];
    const notes = await nvimWith(PLUGIN, old, OPEN_AND_REPORT);
    expect(notes).toContain('too old for this plugin');
  });

  test(':checkhealth hedgesync on an installed copy', async () => {
    const dir = join(tmp, 'installed-plugin');
    const install = Bun.spawnSync(['bun', CLI, 'editor', 'nvim', 'install', '--dir', dir, '-q']);
    expect(install.exitCode).toBe(0);
    const report = await nvimWith(dir, ['bun', CLI], `
vim.cmd("checkhealth hedgesync")
finish(table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), "\\n"))
`);
    expect(report).toContain('editor protocol 1');
    expect(report).toMatch(/Plugin in \S+ matches the CLI/);
    expect(report).toContain('No saved logins');
    expect(report).not.toMatch(/ERROR/);
  });
});
