/**
 * mcp: a Model Context Protocol server on stdio, so AI agents (Claude Code,
 * Claude Desktop, ...) can read and edit HedgeDoc notes as collaborators.
 *
 * Notes are edited through live realtime sessions, not by replacing them over
 * HTTP: an agent's edit merges with whatever people are typing at that moment,
 * shows up in their editors as it happens, and the agent's cursor marks where
 * it worked. Sessions stay open for a while after each use, so the agent stays
 * visible in the note and wait_for_change can see what people do next.
 *
 * The protocol (JSON-RPC 2.0, one message per line) is small enough to speak
 * directly: initialize, ping, tools/list, tools/call.
 */

import { createInterface } from 'node:readline';
import { cursorFromIndex } from '../../cursor.js';
import type { HedgeDocClient } from '../../hedgedoc-client.js';
import { unifiedDiff } from '../../line-diff.js';
import { buildNoteUrl, parseNoteUrl, parseServerUrl } from '../../url.js';
import { VERSION } from '../../version.js';
import type { Command, Context } from '../context.js';
import { readOnlyReason } from '../context.js';
import { listStoredSessions } from '../cookie-store.js';

/** Protocol versions this server speaks, newest first. */
export const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** Close a note's session after this long without a tool touching it. */
const IDLE_MS = 10 * 60_000;

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  annotations?: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<string>;
}

class ToolError extends Error {}

interface Open {
  client: HedgeDocClient;
  /** The note's text as the agent last saw it (read, edit, wait). */
  seen: string;
  timer?: ReturnType<typeof setTimeout>;
}

const str = (v: unknown, name: string, required = true): string | undefined => {
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolError(`${name} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new ToolError(`${name} must be a string`);
  return v;
};

function numbered(text: string): string {
  const lines = text.split('\n');
  const width = String(lines.length).length;
  return lines.map((l, i) => `${String(i + 1).padStart(width)}│${l}`).join('\n');
}

function lineOf(text: string, index: number): number {
  return cursorFromIndex(text, index).line + 1;
}

/** The tools, over a pool of live note sessions. */
export class HedgeDocTools {
  private readonly open = new Map<string, Open>();

  constructor(private readonly ctx: Context, private readonly defaultServer?: string) {}

  /** The server for list/search/create: the argument, --server, the only saved login, or the only open note's. */
  server(arg: unknown): string {
    const given = str(arg, 'server', false) ?? this.defaultServer;
    if (given) {
      try {
        return parseServerUrl(given);
      } catch (err) {
        throw new ToolError((err as Error).message);
      }
    }
    const saved = listStoredSessions().map(([s]) => s);
    if (saved.length === 1) return saved[0];
    const open = [...new Set([...this.open.keys()].map(u => parseNoteUrl(u).serverUrl))];
    if (open.length === 1) return open[0];
    throw new ToolError(saved.length
      ? `Which server? Pass "server", one of: ${saved.join(', ')}`
      : 'Which server? Pass "server" (no saved login; the user can run: hedgesync login <server> --save)');
  }

  private async session(urlArg: unknown): Promise<{ url: string; note: Open }> {
    const raw = str(urlArg, 'url')!;
    let serverUrl: string;
    let noteId: string;
    try {
      ({ serverUrl, noteId } = parseNoteUrl(raw.replace(/[?#].*$/, '')));
    } catch (err) {
      throw new ToolError(`${(err as Error).message} (expected a note URL such as https://md.example.com/abc123)`);
    }
    const url = buildNoteUrl(serverUrl, noteId);
    let note = this.open.get(url);
    if (!note) {
      let client: HedgeDocClient;
      try {
        client = await this.ctx.connectTo(serverUrl, noteId);
      } catch (err) {
        throw new ToolError((err as Error).message);
      }
      client.on('delete', () => this.close(url));
      // The online users list (which includes us) follows the connection.
      for (let i = 0; i < 50 && client.getOnlineUsers().length === 0; i++) await new Promise(r => setTimeout(r, 20));
      note = { client, seen: client.getDocument() };
      this.open.set(url, note);
    }
    clearTimeout(note.timer);
    note.timer = setTimeout(() => this.close(url), IDLE_MS);
    return { url, note };
  }

  private close(url: string): void {
    const note = this.open.get(url);
    if (!note) return;
    clearTimeout(note.timer);
    this.open.delete(url);
    note.client.disconnect();
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.open.values()].map(n => n.client.flush().catch(() => undefined)));
    for (const url of [...this.open.keys()]) this.close(url);
  }

  private others(client: HedgeDocClient): string[] {
    const self = client.socket?.id;
    return client.getOnlineUsers().filter(u => u.id !== self).map(u => u.name || 'Guest');
  }

  private describe(url: string, client: HedgeDocClient): string {
    const info = client.getNoteInfo();
    const others = this.others(client);
    const edit = client.canEdit() ? 'you can edit' : `read-only (${readOnlyReason(info.permission, client.serverUrl) ?? info.permission})`;
    return `${url} · "${info.title || 'Untitled'}" · ${edit} · ${others.length ? `also here: ${others.join(', ')}` : 'nobody else here'}`;
  }

  /** Apply a new full text as a minimal edit and put the agent's cursor at `cursorAt`. */
  private async apply(note: Open, text: string, cursorAt: number): Promise<void> {
    const { client } = note;
    if (!client.canEdit()) {
      const info = client.getNoteInfo();
      throw new ToolError(`No edit permission: ${readOnlyReason(info.permission, client.serverUrl) ?? info.permission}`);
    }
    client.updateContent(text);
    client.setCursor(cursorFromIndex(client.getDocument(), Math.min(cursorAt, client.getDocument().length)));
    await client.flush();
    note.seen = client.getDocument();
  }

  readonly tools: Tool[] = [
    {
      name: 'list_notes',
      description: 'List the notes in the user\'s HedgeDoc history (the notes they opened while signed in), pinned first, then most recently opened. Returns title, URL, tags and last visit.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Server URL, e.g. https://md.example.com (default: the saved login\'s)' },
          search: { type: 'string', description: 'Only notes whose title or id contains this' },
          limit: { type: 'number', description: 'At most this many notes (default 50)' },
        },
      },
      annotations: { readOnlyHint: true },
      run: async (a) => {
        const server = this.server(a.server);
        let entries = (await this.ctx.api(server, true).getHistory()).history;
        const search = str(a.search, 'search', false)?.toLowerCase();
        if (search) entries = entries.filter(e => (e.text || '').toLowerCase().includes(search) || e.id.toLowerCase().includes(search));
        entries.sort((x, y) => Number(y.pinned) - Number(x.pinned) || y.time - x.time);
        const limit = typeof a.limit === 'number' && a.limit > 0 ? a.limit : 50;
        if (entries.length === 0) return 'No notes in the history.';
        return entries.slice(0, limit).map(e =>
          `${e.pinned ? '★ ' : ''}${e.text || '(untitled)'} — ${buildNoteUrl(server, e.id)}${e.tags?.length ? ` [${e.tags.join(', ')}]` : ''} (opened ${new Date(e.time).toISOString().slice(0, 16).replace('T', ' ')})`,
        ).join('\n') + (entries.length > limit ? `\n… ${entries.length - limit} more` : '');
      },
    },
    {
      name: 'search_notes',
      description: 'Search the text of the notes in the user\'s history. Returns matching lines with line numbers, grouped by note.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Text to find (case-insensitive), or a regular expression with regex: true' },
          regex: { type: 'boolean' },
          server: { type: 'string', description: 'Server URL (default: the saved login\'s)' },
        },
        required: ['pattern'],
      },
      annotations: { readOnlyHint: true },
      run: async (a) => {
        const server = this.server(a.server);
        const pattern = str(a.pattern, 'pattern')!;
        let re: RegExp;
        try {
          re = new RegExp(a.regex === true ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        } catch (err) {
          throw new ToolError(`Invalid regular expression: ${(err as Error).message}`);
        }
        const api = this.ctx.api(server, true);
        const entries = (await api.getHistory()).history;
        const out: string[] = [];
        for (const e of entries) {
          let text: string;
          try {
            text = await api.downloadNote(e.id);
          } catch {
            continue;
          }
          const hits = text.split('\n').flatMap((l, i) => (re.test(l) ? [`  ${i + 1}: ${l}`] : []));
          if (hits.length) out.push(`${e.text || '(untitled)'} — ${buildNoteUrl(server, e.id)}\n${hits.slice(0, 20).join('\n')}`);
        }
        return out.length ? out.join('\n\n') : `No matches in ${entries.length} notes.`;
      },
    },
    {
      name: 'read_note',
      description: 'Read a note\'s current text (live, including unsaved typing of others), with who else is in it and whether you can edit it. Opens a live session that stays open while you work, so others see you in the note.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Note URL, e.g. https://md.example.com/abc123' },
          line_numbers: { type: 'boolean', description: 'Prefix lines with their numbers (default true)' },
        },
        required: ['url'],
      },
      annotations: { readOnlyHint: true },
      run: async (a) => {
        const { url, note } = await this.session(a.url);
        const text = note.client.getDocument();
        note.seen = text;
        return `${this.describe(url, note.client)}\n\n${a.line_numbers === false ? text : numbered(text)}`;
      },
    },
    {
      name: 'edit_note',
      description: 'Replace text in a note, live: old_text must occur exactly once (or pass replace_all). The edit merges with what others are typing and appears in their editors immediately; your cursor is left at the edit. Prefer this over write_note for changes to part of a note.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          old_text: { type: 'string', description: 'Exact text to replace (include enough context to be unique)' },
          new_text: { type: 'string', description: 'Replacement text' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence' },
        },
        required: ['url', 'old_text', 'new_text'],
      },
      run: async (a) => {
        const { note } = await this.session(a.url);
        const oldText = str(a.old_text, 'old_text')!;
        const newText = typeof a.new_text === 'string' ? a.new_text : str(a.new_text, 'new_text')!;
        const doc = note.client.getDocument();
        const first = doc.indexOf(oldText);
        if (first < 0) throw new ToolError('old_text not found in the note (it may have changed: read_note shows the current text)');
        const count = doc.split(oldText).length - 1;
        if (count > 1 && a.replace_all !== true) {
          throw new ToolError(`old_text occurs ${count} times; add context to make it unique, or pass replace_all`);
        }
        const updated = a.replace_all === true ? doc.split(oldText).join(newText) : doc.slice(0, first) + newText + doc.slice(first + oldText.length);
        await this.apply(note, updated, first + newText.length);
        return `Replaced ${a.replace_all === true ? `${count} occurrence(s)` : `at line ${lineOf(updated, first)}`}.`;
      },
    },
    {
      name: 'append_to_note',
      description: 'Add text at the end of a note (a newline is put before it if the note does not end with one).',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' }, text: { type: 'string' } },
        required: ['url', 'text'],
      },
      run: async (a) => {
        const { note } = await this.session(a.url);
        const text = str(a.text, 'text')!;
        const doc = note.client.getDocument();
        const glue = doc === '' || doc.endsWith('\n') ? '' : '\n';
        const updated = doc + glue + text;
        await this.apply(note, updated, updated.length);
        return `Appended ${text.split('\n').length} line(s), from line ${lineOf(updated, doc.length + glue.length)}.`;
      },
    },
    {
      name: 'write_note',
      description: 'Replace a note\'s whole text. Applied as the minimal change, so unchanged parts (and others\' cursors) are kept; use edit_note for local changes.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' }, content: { type: 'string' } },
        required: ['url', 'content'],
      },
      annotations: { destructiveHint: true },
      run: async (a) => {
        const { note } = await this.session(a.url);
        const content = typeof a.content === 'string' ? a.content : str(a.content, 'content')!;
        const before = note.client.getDocument();
        if (before !== note.seen) {
          throw new ToolError('The note changed since you last read it (others are editing); read_note again, or use edit_note');
        }
        let at = 0;
        while (at < before.length && at < content.length && before[at] === content[at]) at++;
        await this.apply(note, content, at);
        return 'Note replaced.';
      },
    },
    {
      name: 'create_note',
      description: 'Create a new note and return its URL. Start the content with "# Title" to give it a title.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Markdown text' },
          server: { type: 'string', description: 'Server URL (default: the saved login\'s)' },
        },
        required: ['content'],
      },
      run: async (a) => {
        const server = this.server(a.server);
        const content = str(a.content, 'content')!;
        const id = await this.ctx.api(server).createNote(content);
        return `Created ${buildNoteUrl(server, id)}`;
      },
    },
    {
      name: 'wait_for_change',
      description: 'Wait until people change the note, then return what changed (a diff against the text you last saw) and who changed it. Returns at once if it already changed. Use it to work with people in a note: e.g. wait for the user to write a request, then act on it. With "until", waits until that text appears.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          timeout_seconds: { type: 'number', description: 'Give up after this long (default 120, max 600)' },
          until: { type: 'string', description: 'Only return once the note contains this text (case-insensitive), e.g. "@claude"' },
          settle_seconds: { type: 'number', description: 'Wait for typing to pause this long before returning (default 2)' },
        },
        required: ['url'],
      },
      annotations: { readOnlyHint: true },
      run: async (a) => {
        const { url, note } = await this.session(a.url);
        const timeout = Math.min(600, typeof a.timeout_seconds === 'number' ? a.timeout_seconds : 120) * 1000;
        const settle = Math.max(0, typeof a.settle_seconds === 'number' ? a.settle_seconds : 2) * 1000;
        const until = str(a.until, 'until', false)?.toLowerCase();
        const { client } = note;
        const authors = new Set<string>();
        const ready = () => {
          const doc = client.getDocument();
          return doc !== note.seen && (!until || doc.toLowerCase().includes(until));
        };
        const changed = await new Promise<boolean>((done) => {
          let settleTimer: ReturnType<typeof setTimeout> | undefined;
          const finish = (result: boolean) => {
            clearTimeout(settleTimer);
            clearTimeout(timer);
            client.off('change', onChange);
            done(result);
          };
          const arm = () => {
            clearTimeout(settleTimer);
            if (ready()) settleTimer = setTimeout(() => finish(true), settle);
          };
          const onChange = (event: { type: string; user?: { name?: string } }) => {
            if (event.type === 'remote') authors.add(event.user?.name || 'someone');
            arm(); // typing restarts the settle timer
          };
          const timer = setTimeout(() => finish(ready()), timeout);
          client.on('change', onChange);
          arm();
        });
        // A lease on the session for the time we waited.
        clearTimeout(note.timer);
        note.timer = setTimeout(() => this.close(url), IDLE_MS);
        if (!changed) return `No change within ${Math.round(timeout / 1000)} s${until ? ` (waiting for "${a.until}")` : ''}.`;
        const doc = client.getDocument();
        const diff = unifiedDiff(note.seen, doc);
        note.seen = doc;
        return `Changed${authors.size ? ` by ${[...authors].join(', ')}` : ''}:\n${diff}`;
      },
    },
  ];

  async call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const tool = this.tools.find(t => t.name === name);
    if (!tool) return { text: `Unknown tool: ${name}`, isError: true };
    try {
      return { text: await tool.run(args ?? {}), isError: false };
    } catch (err) {
      return { text: (err as Error).message, isError: true };
    }
  }
}

type Message = { jsonrpc: '2.0'; id?: string | number | null; method?: string; params?: Record<string, unknown> };

/** Handle one JSON-RPC message; returns the response, or null for notifications. */
export async function handleMessage(tools: HedgeDocTools, msg: Message): Promise<object | null> {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (msg.id === undefined) return null; // notification (initialized, cancelled, ...)
  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion ?? '');
      return reply({
        protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'hedgesync', title: 'HedgeDoc (hedgesync)', version: VERSION },
        instructions:
          'Tools for HedgeDoc notes. Edits go through live sessions: they merge with what people type and appear in their '
          + 'editors at once. Read a note before editing it; prefer edit_note for partial changes. wait_for_change lets you '
          + 'react to what people write in a note.',
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: tools.tools.map(({ run: _run, ...t }) => t) });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const { text, isError } = await tools.call(name, (msg.params?.arguments ?? {}) as Record<string, unknown>);
      return reply({ content: [{ type: 'text', text }], isError });
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

export const mcp: Command = {
  name: 'mcp',
  summary: 'Serve HedgeDoc notes to AI agents (Model Context Protocol, stdio)',
  options: [{ name: 'server', short: 's', type: 'value' }],
  help: () => `
hedgesync mcp - Serve HedgeDoc notes to AI agents (Model Context Protocol)

USAGE:
  hedgesync mcp [--server <url>]

Speaks MCP on stdin/stdout, for agents such as Claude Code:

  claude mcp add hedgesync -- hedgesync mcp --server https://md.example.com

Tools: list_notes, search_notes, read_note, edit_note, append_to_note,
write_note, create_note, wait_for_change.

Edits go through live sessions, like a person typing: they merge with
concurrent edits, appear in everyone's editor at once, and the agent's cursor
shows where it worked (under your login's name). A session stays open ten
minutes after its last use. wait_for_change returns what people changed, so an
agent can take requests written into a note.

Logins are the CLI's (hedgesync login <server> --save, or HEDGEDOC_COOKIE).
--server sets the default server for list, search and create.
`,
  async run(ctx) {
    const server = ctx.str('server');
    const tools = new HedgeDocTools(ctx, server ? parseServerUrl(server) : undefined);
    const write = (obj: object) => process.stdout.write(JSON.stringify(obj) + '\n');
    const lines = createInterface({ input: process.stdin });
    const pending = new Set<Promise<void>>();
    for await (const line of lines) {
      if (!line.trim()) continue;
      let msg: Message;
      try {
        msg = JSON.parse(line) as Message;
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      // Calls run concurrently: a long wait_for_change must not block others.
      const p = handleMessage(tools, msg).then((res) => {
        if (res) write(res);
      }).catch((err: Error) => {
        write({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: err.message } });
      }).finally(() => pending.delete(p));
      pending.add(p);
    }
    // stdin closed: the agent is gone. Answer nothing more, leave the notes.
    await tools.closeAll();
  },
};
