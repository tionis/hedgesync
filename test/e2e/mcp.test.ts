/**
 * End-to-end: `hedgesync mcp` spoken to over stdio like an agent host would,
 * against the HedgeDoc stand-in, while a person edits the same note.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HedgeDocClient } from '../../src/hedgedoc-client.js';
import { startTestServer, type TestServer } from './server.js';

setDefaultTimeout(60_000);

const CLI = join(import.meta.dir, '../../bin/hedgesync.ts');
const tmp = mkdtempSync(join(tmpdir(), 'hedgesync-mcp-'));
let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});
afterAll(async () => {
  await server?.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** A running `hedgesync mcp` and a way to call it. */
function startMcp() {
  const proc = Bun.spawn(['bun', CLI, 'mcp', '--server', server.url], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', HOME: tmp, NO_COLOR: '1', HEDGESYNC_COOKIE_FILE: join(tmp, 'cookies.json'), HEDGEDOC_COOKIE: 'connect.sid=good' },
  });
  const waiting = new Map<number, (msg: any) => void>();
  let buffer = '';
  (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk);
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        waiting.get(msg.id)?.(msg);
      }
    }
  })();
  let next = 1;
  const request = (method: string, params: object = {}): Promise<any> => {
    const id = next++;
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    proc.stdin.flush();
    return new Promise((resolve) => waiting.set(id, resolve));
  };
  const call = async (name: string, args: object) => {
    const res = await request('tools/call', { name, arguments: args });
    return { text: res.result.content[0].text as string, isError: res.result.isError as boolean };
  };
  return { proc, request, call };
}

describe('hedgesync mcp', () => {
  test('initialize and list the tools', async () => {
    const { proc, request } = startMcp();
    try {
      const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
      expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hedgesync' } });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const list = await request('tools/list');
      expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual([
        'list_notes', 'search_notes', 'read_note', 'edit_note', 'append_to_note', 'write_note', 'create_note', 'wait_for_change',
      ]);
      expect((await request('nope')).error.code).toBe(-32601);
    } finally {
      proc.stdin.end();
      await proc.exited;
    }
  });

  test('read, edit and append live, alongside a person typing', async () => {
    const id = 'mcp-live';
    Object.assign(server.note(id), { document: '# Plan\n\n- [ ] write tests\n', permission: 'freely' });
    const person = new HedgeDocClient({ serverUrl: server.url, noteId: id });
    await person.connect();
    const { proc, call } = startMcp();
    try {
      const url = `${server.url}/${id}`;
      const read = await call('read_note', { url });
      expect(read.text).toContain('you can edit');
      expect(read.text).toContain('also here: user-');
      expect(read.text).toContain('3│- [ ] write tests');

      person.insert(person.getDocument().length, '- [ ] ship\n'); // typed meanwhile
      await person.flush();
      const edit = await call('edit_note', { url, old_text: '- [ ] write tests', new_text: '- [x] write tests' });
      expect(edit).toEqual({ text: 'Replaced at line 3.', isError: false });
      expect(server.note(id).document).toBe('# Plan\n\n- [x] write tests\n- [ ] ship\n');

      expect((await call('edit_note', { url, old_text: 'missing', new_text: 'x' })).isError).toBe(true);
      expect((await call('edit_note', { url, old_text: '- [', new_text: 'x' })).text).toContain('occurs 2 times');

      await call('append_to_note', { url, text: '- [ ] celebrate' });
      expect(server.note(id).document).toBe('# Plan\n\n- [x] write tests\n- [ ] ship\n- [ ] celebrate');
      // The agent's cursor is where it last worked.
      await Bun.sleep(300);
      const agent = [...person.users.values()].find(u => u.id !== person.socket?.id);
      expect(agent?.cursor).toEqual({ line: 4, ch: 15 });
    } finally {
      proc.stdin.end();
      await proc.exited;
      person.disconnect();
    }
  });

  test('wait_for_change returns what a person wrote, once they pause', async () => {
    const id = 'mcp-wait';
    Object.assign(server.note(id), { document: 'Questions:\n', permission: 'freely' });
    const person = new HedgeDocClient({ serverUrl: server.url, noteId: id });
    await person.connect();
    const { proc, call } = startMcp();
    try {
      const url = `${server.url}/${id}`;
      await call('read_note', { url });
      const waiting = call('wait_for_change', { url, until: '@claude', settle_seconds: 0.3, timeout_seconds: 20 });
      await Bun.sleep(500);
      person.insert(person.getDocument().length, 'unrelated line\n');
      await Bun.sleep(400);
      person.insert(person.getDocument().length, '@claude what is 2+2?\n');
      const result = await waiting;
      expect(result.isError).toBe(false);
      expect(result.text).toContain('+unrelated line');
      expect(result.text).toContain('+@claude what is 2+2?');

      const quiet = await call('wait_for_change', { url, timeout_seconds: 0.5 });
      expect(quiet.text).toContain('No change within');
    } finally {
      proc.stdin.end();
      await proc.exited;
      person.disconnect();
    }
  });

  test('create, list and search notes on the default server', async () => {
    server.history.splice(0, server.history.length);
    const { proc, call } = startMcp();
    try {
      const created = await call('create_note', { content: '# From an agent\n\nneedle in here\n' });
      const url = /Created (\S+)/.exec(created.text)![1];
      await call('read_note', { url }); // a signed-in visit puts it in the history
      expect((await call('list_notes', {})).text).toContain(`From an agent — ${url}`);
      expect((await call('search_notes', { pattern: 'NEEDLE' })).text).toContain('3: needle in here');
    } finally {
      proc.stdin.end();
      await proc.exited;
    }
  });
});
