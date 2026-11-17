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
function startMcp(...args: string[]) {
  const proc = Bun.spawn(['bun', CLI, 'mcp', '--server', server.url, ...args], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { PATH: process.env.PATH ?? '', HOME: tmp, NO_COLOR: '1', HEDGESYNC_COOKIE_FILE: join(tmp, 'cookies.json'), HEDGEDOC_COOKIE: 'connect.sid=good' },
  });
  const waiting = new Map<number, (msg: any) => void>();
  const notifications: any[] = [];
  let buffer = '';
  (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk);
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (msg.id === undefined) notifications.push(msg);
        else waiting.get(msg.id)?.(msg);
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
    if (res.error) return { text: res.error.message as string, isError: true, structured: undefined };
    return { text: res.result.content[0].text as string, isError: res.result.isError === true, structured: res.result.structuredContent };
  };
  return { proc, request, call, notifications };
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
        'list_notes', 'search_notes', 'read_note', 'edit_note', 'edit_section', 'append_to_note', 'write_note', 'create_note', 'wait_for_change',
      ]);
      const read = list.result.tools.find((t: { name: string }) => t.name === 'read_note');
      expect(read).toMatchObject({ title: 'Read a note', annotations: { readOnlyHint: true }, outputSchema: { type: 'object' } });
      expect((await request('prompts/list')).result.prompts.map((p: { name: string }) => p.name)).toEqual(['work_in_note']);
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
      expect(edit).toMatchObject({ text: 'Replaced at line 3.', isError: false });
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

  test('sections and line ranges', async () => {
    const id = 'mcp-sections';
    Object.assign(server.note(id), { document: '# Notes\n\n## Tasks\n\n- one\n\n## Log\n\nstarted\n', permission: 'freely' });
    const { proc, call } = startMcp();
    try {
      const url = `${server.url}/${id}`;
      const tasks = await call('read_note', { url, section: 'tasks' });
      expect(tasks.text).toContain('Lines 3-6 of 10:');
      expect(tasks.structured).toMatchObject({ from_line: 3, to_line: 6, text: '## Tasks\n\n- one\n', can_edit: true });
      expect((await call('read_note', { url, lines: '9-' })).structured.text).toBe('started\n');
      expect((await call('read_note', { url, section: 'Nope' })).text).toContain('## Tasks');
      expect((await call('read_note', { url, lines: 'x' })).isError).toBe(true);

      await call('edit_section', { url, heading: 'Tasks', text: '- two', mode: 'append' });
      await call('edit_section', { url, heading: '## Log', text: 'done' });
      expect((await call('edit_section', { url, heading: 'Ideas', text: '- fly' })).isError).toBe(true);
      await call('edit_section', { url, heading: 'Ideas', text: '- fly', create: true });
      expect(server.note(id).document).toBe('# Notes\n\n## Tasks\n\n- one\n- two\n\n## Log\n\ndone\n\n## Ideas\n\n- fly\n');
    } finally {
      proc.stdin.end();
      await proc.exited;
    }
  });

  test('--read-only, --tools and --note limit what an agent can do', async () => {
    const id = 'mcp-limited';
    Object.assign(server.note(id), { document: 'allowed\n', permission: 'freely' });
    Object.assign(server.note('mcp-other'), { document: 'secret\n', permission: 'freely' });
    const url = `${server.url}/${id}`;
    const names = async (m: ReturnType<typeof startMcp>) => (await m.request('tools/list')).result.tools.map((t: { name: string }) => t.name);

    const readOnly = startMcp('--read-only');
    try {
      expect(await names(readOnly)).toEqual(['list_notes', 'search_notes', 'read_note', 'wait_for_change']);
      expect((await readOnly.request('prompts/list')).error.code).toBe(-32601); // no prompts without edit tools
      expect((await readOnly.call('edit_note', { url, old_text: 'a', new_text: 'b' })).isError).toBe(true);
    } finally {
      readOnly.proc.stdin.end();
      await readOnly.proc.exited;
    }

    const oneNote = startMcp('--note', url, '--tools', 'read,edit,create');
    try {
      expect(await names(oneNote)).not.toContain('create_note');
      expect((await oneNote.call('read_note', { url })).text).toContain('allowed');
      const other = await oneNote.call('read_note', { url: `${server.url}/mcp-other` });
      expect(other).toMatchObject({ isError: true });
      expect(other.text).toContain(`only gives access to: ${url}`);
      await oneNote.call('append_to_note', { url, text: 'more' });
      expect(server.note(id).document).toBe('allowed\nmore');
    } finally {
      oneNote.proc.stdin.end();
      await oneNote.proc.exited;
    }

    const bad = Bun.spawnSync(['bun', CLI, 'mcp', '--tools', 'read,nuke'], { env: { PATH: process.env.PATH ?? '', HOME: tmp, NO_COLOR: '1' } });
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr.toString()).toContain('Unknown tool group: nuke');
  });

  test('notes are resources, with updates for subscribers', async () => {
    const id = 'mcp-resource';
    Object.assign(server.note(id), { document: 'v1\n', permission: 'freely' });
    const person = new HedgeDocClient({ serverUrl: server.url, noteId: id });
    await person.connect();
    const m = startMcp();
    try {
      const url = `${server.url}/${id}`;
      await m.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
      m.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const templates = (await m.request('resources/templates/list')).result.resourceTemplates;
      expect(templates[0]).toMatchObject({ name: 'note', uriTemplate: '{+url}' });
      const read = await m.request('resources/read', { uri: url });
      expect(read.result.contents[0]).toMatchObject({ uri: url, mimeType: 'text/markdown', text: 'v1\n' });

      expect((await m.request('resources/subscribe', { uri: url })).result).toEqual({});
      person.insert(person.getDocument().length, 'v2\n');
      await person.flush();
      for (let i = 0; i < 50 && !m.notifications.some(n => n.method === 'notifications/resources/updated'); i++) await Bun.sleep(50);
      expect(m.notifications.find(n => n.method === 'notifications/resources/updated')?.params).toEqual({ uri: url });
    } finally {
      m.proc.stdin.end();
      await m.proc.exited;
      person.disconnect();
    }
  });

  test('2026-07-28 clients hear about changes on subscriptions/listen', async () => {
    const id = 'mcp-listen';
    Object.assign(server.note(id), { document: 'v1\n', permission: 'freely' });
    const person = new HedgeDocClient({ serverUrl: server.url, noteId: id });
    await person.connect();
    const m = startMcp();
    const _meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
    };
    try {
      const url = `${server.url}/${id}`;
      const discover = await m.request('server/discover', { _meta });
      expect(discover.result.capabilities.resources).toMatchObject({ subscribe: true });
      expect(discover.result.instructions).toStartWith('HedgeDoc notes');
      expect((await m.request('resources/read', { uri: url, _meta })).result.contents[0].text).toBe('v1\n');
      void m.request('subscriptions/listen', { _meta, notifications: { resourceSubscriptions: [url] } });
      await Bun.sleep(300);
      person.insert(person.getDocument().length, 'v2\n');
      await person.flush();
      const updated = () => m.notifications.find(n => n.method === 'notifications/resources/updated');
      for (let i = 0; i < 50 && !updated(); i++) await Bun.sleep(50);
      expect(updated()?.params).toMatchObject({ uri: url });
    } finally {
      m.proc.stdin.end();
      await m.proc.exited;
      person.disconnect();
    }
  });
});
