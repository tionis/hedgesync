/**
 * The MCP tools: HedgeDoc notes for AI agents, over a pool of live sessions.
 *
 * Notes are edited through live realtime sessions, not by replacing them over
 * HTTP: an agent's edit merges with whatever people are typing at that moment,
 * shows up in their editors as it happens, and the agent's cursor marks where
 * it worked. Sessions stay open for a while after each use, so the agent stays
 * visible in the note and wait_for_change can see what people do next.
 *
 * Each tool belongs to a group (read, edit, create); the server can be limited
 * to some groups, and to a list of notes.
 */

import * as z from 'zod/v4';
import { cursorFromIndex } from '../../cursor.js';
import type { HedgeDocClient } from '../../hedgedoc-client.js';
import { unifiedDiff } from '../../line-diff.js';
import { appendToSection, findSection, replaceSection, sections } from '../../note-sections.js';
import { buildNoteUrl, parseNoteUrl, parseServerUrl } from '../../url.js';
import type { Context } from '../context.js';
import { readOnlyReason } from '../context.js';
import { listStoredSessions } from '../cookie-store.js';
import { TOOL_GROUPS, type ToolGroup, type ToolOptions } from './tool-groups.js';

export { TOOL_GROUPS, type ToolGroup, type ToolOptions };

/** Close a note's session after this long without a tool touching it. */
const IDLE_MS = 10 * 60_000;
/** Longest note text returned at once (about 10k tokens); longer notes are cut, with an outline. */
export const MAX_TEXT = 40_000;
/** Notes downloaded at once by search_notes. */
const SEARCH_PARALLEL = 6;
/** Changes to an open note are reported this long after typing pauses. */
const UPDATE_DEBOUNCE_MS = 500;

/** What a tool run gets besides its arguments. */
export interface ToolRun {
  /** Aborted when the client cancels the call or goes away. */
  signal: AbortSignal;
  /** Report progress (only delivered if the client asked for it). */
  progress(done: number, total?: number, message?: string): void;
}

export interface ToolResult {
  text: string;
  /** Machine-readable result, matching the tool's outputSchema. */
  structured?: Record<string, unknown>;
}

export interface Tool {
  name: string;
  title: string;
  group: ToolGroup;
  description: string;
  inputSchema: z.ZodObject;
  outputSchema?: z.ZodObject;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean };
  run: (args: Record<string, unknown>, run: ToolRun) => Promise<ToolResult>;
}

/** A failure the agent can act on: reported as a tool error, with its message. */
export class ToolError extends Error {}

interface Open {
  client: HedgeDocClient;
  /** The note's text as the agent last saw it (read, edit, wait). */
  seen: string;
  timer?: ReturnType<typeof setTimeout>;
  /** Kept open while a client is subscribed to the note as a resource. */
  pinned: number;
  updateTimer?: ReturnType<typeof setTimeout>;
}

const str = (v: unknown, name: string, required = true): string | undefined => {
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolError(`${name} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new ToolError(`${name} must be a string`);
  return v;
};

function numbered(lines: string[], first = 1): string {
  const width = String(first + lines.length - 1).length;
  return lines.map((l, i) => `${String(first + i).padStart(width)}│${l}`).join('\n');
}

function lineOf(text: string, index: number): number {
  return cursorFromIndex(text, index).line + 1;
}

/** "12-40", "12-" or "12" to a 1-based inclusive range. */
export function parseLineRange(spec: string, total: number): { from: number; to: number } {
  const m = /^\s*(\d+)\s*(?:-\s*(\d*)\s*)?$/.exec(spec);
  if (!m) throw new ToolError(`lines must look like "12-40", "12-" or "12", got "${spec}"`);
  const from = Math.max(1, Number(m[1]));
  const to = m[2] === undefined ? from : m[2] === '' ? total : Math.min(total, Number(m[2]));
  if (from > total) throw new ToolError(`The note has ${total} lines; lines ${spec} is past its end`);
  if (to < from) throw new ToolError(`lines ${spec}: the end comes before the start`);
  return { from, to };
}

/** Headings of a note with their line numbers, for orientation in long notes. */
export function outline(doc: string): string {
  return sections(doc).map(s => `${String(lineOf(doc, s.start)).padStart(5)}  ${'#'.repeat(s.level)} ${s.heading}`).join('\n');
}

const noteUrlSchema = z.string().describe('Note URL, e.g. https://md.example.com/abc123');
const serverSchema = z.string().optional().describe('Server URL, e.g. https://md.example.com (default: the configured server or the saved login\'s)');

/** The tools, over a pool of live note sessions. */
export class HedgeDocTools {
  private readonly open = new Map<string, Open>();
  private readonly changeListeners = new Set<(url: string) => void>();
  private readonly defaultServer?: string;
  private readonly groups: Set<ToolGroup>;
  /** Normalized URLs of the only notes allowed, or undefined for any. */
  readonly allowedNotes?: Set<string>;

  constructor(private readonly ctx: Context, options: ToolOptions = {}) {
    this.defaultServer = options.defaultServer;
    this.groups = new Set(options.groups ?? TOOL_GROUPS);
    if (options.notes?.length) this.allowedNotes = new Set(options.notes);
  }

  /** The tools this server offers, given its groups and note list. */
  enabled(): Tool[] {
    return this.tools.filter(t => this.groups.has(t.group) && !(t.name === 'create_note' && this.allowedNotes));
  }

  /** Called (debounced) when an open note changes, by anyone. */
  onNoteChange(listener: (url: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** The URLs of the notes with an open session. */
  openNotes(): string[] {
    return [...this.open.keys()];
  }

  /** The server for list/search/create: the argument, --server, the only saved login, or the only open/allowed note's. */
  server(arg: unknown): string {
    const given = str(arg, 'server', false) ?? this.defaultServer;
    if (given) {
      try {
        return parseServerUrl(given);
      } catch (err) {
        throw new ToolError((err as Error).message);
      }
    }
    const known = [...new Set([...this.open.keys(), ...(this.allowedNotes ?? [])].map(u => parseNoteUrl(u).serverUrl))];
    if (known.length === 1 && this.allowedNotes) return known[0];
    const saved = listStoredSessions().map(([s]) => s);
    if (saved.length === 1) return saved[0];
    if (known.length === 1) return known[0];
    throw new ToolError(saved.length
      ? `Which server? Pass "server", one of: ${saved.join(', ')}`
      : 'Which server? Pass "server" (no saved login; the user can run: hedgesync login <server> --save)');
  }

  /** Normalize a note URL argument, checking it is allowed. */
  noteUrl(urlArg: unknown): { url: string; serverUrl: string; noteId: string } {
    const raw = str(urlArg, 'url')!;
    let serverUrl: string;
    let noteId: string;
    try {
      ({ serverUrl, noteId } = parseNoteUrl(raw.replace(/[?#].*$/, '')));
    } catch (err) {
      throw new ToolError(`${(err as Error).message} (expected a note URL such as https://md.example.com/abc123)`);
    }
    const url = buildNoteUrl(serverUrl, noteId);
    if (this.allowedNotes && !this.allowedNotes.has(url)) {
      throw new ToolError(`This server only gives access to: ${[...this.allowedNotes].join(', ')}`);
    }
    return { url, serverUrl, noteId };
  }

  private async session(urlArg: unknown): Promise<{ url: string; note: Open }> {
    const { url, serverUrl, noteId } = this.noteUrl(urlArg);
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
      // Another call may have opened it meanwhile.
      const existing = this.open.get(url);
      if (existing) {
        client.disconnect();
        note = existing;
      } else {
        const opened: Open = { client, seen: client.getDocument(), pinned: 0 };
        client.on('change', () => {
          clearTimeout(opened.updateTimer);
          opened.updateTimer = setTimeout(() => {
            for (const l of this.changeListeners) l(url);
          }, UPDATE_DEBOUNCE_MS);
        });
        this.open.set(url, opened);
        note = opened;
      }
    }
    this.touch(url, note);
    return { url, note };
  }

  private touch(url: string, note: Open): void {
    clearTimeout(note.timer);
    if (note.pinned === 0) note.timer = setTimeout(() => this.close(url), IDLE_MS);
  }

  private close(url: string): void {
    const note = this.open.get(url);
    if (!note) return;
    clearTimeout(note.timer);
    clearTimeout(note.updateTimer);
    this.open.delete(url);
    note.client.disconnect();
  }

  /** Keep a note's session open (and its changes reported) until unpin. */
  async pin(url: string): Promise<void> {
    const { url: u, note } = await this.session(url);
    note.pinned++;
    this.touch(u, note);
  }

  unpin(url: string): void {
    let u: string;
    try {
      u = this.noteUrl(url).url;
    } catch {
      return;
    }
    const note = this.open.get(u);
    if (!note || note.pinned === 0) return;
    note.pinned--;
    this.touch(u, note);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.open.values()].map(n => n.client.flush().catch(() => undefined)));
    for (const url of [...this.open.keys()]) this.close(url);
  }

  /** A note's live text, for resources. */
  async text(urlArg: string): Promise<{ url: string; title: string; text: string }> {
    const { url, note } = await this.session(urlArg);
    return { url, title: note.client.getNoteInfo().title || 'Untitled', text: note.client.getDocument() };
  }

  /** Notes in the user's history (only the allowed ones, if limited). */
  async history(serverArg?: unknown): Promise<{ server: string; notes: NoteEntry[] }> {
    const server = this.server(serverArg);
    let entries = (await this.ctx.api(server, true).getHistory()).history;
    if (this.allowedNotes) entries = entries.filter(e => this.allowedNotes!.has(buildNoteUrl(server, e.id)));
    entries.sort((x, y) => Number(y.pinned) - Number(x.pinned) || y.time - x.time);
    const notes = entries.map(e => ({
      title: e.text || '(untitled)',
      url: buildNoteUrl(server, e.id),
      tags: e.tags ?? [],
      pinned: !!e.pinned,
      last_opened: new Date(e.time).toISOString(),
    }));
    // Allowed notes that aren't in the history are still listed.
    for (const url of this.allowedNotes ?? []) {
      if (!notes.some(n => n.url === url) && parseNoteUrl(url).serverUrl === server) {
        notes.push({ title: '(not in your history)', url, tags: [], pinned: false, last_opened: '' });
      }
    }
    return { server, notes };
  }

  private others(client: HedgeDocClient): string[] {
    const self = client.socket?.id;
    return client.getOnlineUsers().filter(u => u.id !== self).map(u => u.name || 'Guest');
  }

  private info(url: string, client: HedgeDocClient) {
    const info = client.getNoteInfo();
    const permission = info.permission ?? 'unknown';
    return {
      url,
      title: info.title || 'Untitled',
      can_edit: client.canEdit(),
      read_only_reason: client.canEdit() ? undefined : (readOnlyReason(permission, client.serverUrl) ?? permission),
      others_here: this.others(client),
    };
  }

  private describe(i: ReturnType<HedgeDocTools['info']>): string {
    const edit = i.can_edit ? 'you can edit' : `read-only (${i.read_only_reason})`;
    return `${i.url} · "${i.title}" · ${edit} · ${i.others_here.length ? `also here: ${i.others_here.join(', ')}` : 'nobody else here'}`;
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
      title: 'List notes',
      group: 'read',
      description: 'List the notes in the user\'s HedgeDoc history (the notes they opened while signed in), pinned first, then most recently opened. Returns title, URL, tags and when each was last opened. Use it to find a note by name; use search_notes to find one by its content.',
      inputSchema: z.object({
        server: serverSchema,
        search: z.string().optional().describe('Only notes whose title or id contains this (case-insensitive)'),
        limit: z.number().int().positive().optional().describe('At most this many notes (default 50)'),
      }),
      outputSchema: z.object({
        server: z.string(),
        total: z.number(),
        notes: z.array(z.object({
          title: z.string(), url: z.string(), tags: z.array(z.string()), pinned: z.boolean(), last_opened: z.string(),
        })),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      run: async (a) => {
        const { server, notes: all } = await this.history(a.server);
        const search = str(a.search, 'search', false)?.toLowerCase();
        const matching = search ? all.filter(n => n.title.toLowerCase().includes(search) || n.url.toLowerCase().includes(search)) : all;
        const limit = typeof a.limit === 'number' && a.limit > 0 ? a.limit : 50;
        const notes = matching.slice(0, limit);
        const structured = { server, total: matching.length, notes };
        if (notes.length === 0) return { text: search ? `No notes match "${a.search}".` : 'No notes in the history.', structured };
        const text = notes.map(n =>
          `${n.pinned ? '★ ' : ''}${n.title} — ${n.url}${n.tags.length ? ` [${n.tags.join(', ')}]` : ''}${n.last_opened ? ` (opened ${n.last_opened.slice(0, 16).replace('T', ' ')})` : ''}`,
        ).join('\n') + (matching.length > limit ? `\n… ${matching.length - limit} more (raise limit, or narrow with search)` : '');
        return { text, structured };
      },
    },
    {
      name: 'search_notes',
      title: 'Search notes',
      group: 'read',
      description: 'Search the text of the notes in the user\'s history. Returns matching lines with their line numbers, grouped by note (at most 20 lines per note). Slow with a long history: every note is downloaded.',
      inputSchema: z.object({
        pattern: z.string().describe('Text to find (case-insensitive), or a regular expression with regex: true'),
        regex: z.boolean().optional().describe('Treat pattern as a regular expression'),
        server: serverSchema,
        max_notes: z.number().int().positive().optional().describe('Stop after this many notes with matches (default 25)'),
      }),
      outputSchema: z.object({
        searched: z.number(),
        results: z.array(z.object({
          title: z.string(), url: z.string(),
          matches: z.array(z.object({ line: z.number(), text: z.string() })),
          more: z.number(),
        })),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      run: async (a, run) => {
        const pattern = str(a.pattern, 'pattern')!;
        let re: RegExp;
        try {
          re = new RegExp(a.regex === true ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        } catch (err) {
          throw new ToolError(`Invalid regular expression: ${(err as Error).message}`);
        }
        const maxNotes = typeof a.max_notes === 'number' ? a.max_notes : 25;
        const { server, notes } = await this.history(a.server);
        const api = this.ctx.api(server, true);
        const results: { title: string; url: string; matches: { line: number; text: string }[]; more: number }[] = [];
        let done = 0;
        let next = 0;
        const worker = async () => {
          while (next < notes.length && results.length < maxNotes && !run.signal.aborted) {
            const n = notes[next++];
            let text: string | undefined;
            try {
              text = await api.downloadNote(parseNoteUrl(n.url).noteId);
            } catch {
              // Deleted or no longer readable: skip.
            }
            run.progress(++done, notes.length, n.title);
            if (text === undefined) continue;
            const hits = text.split('\n').flatMap((l, i) => (re.test(l) ? [{ line: i + 1, text: l }] : []));
            if (hits.length && results.length < maxNotes) results.push({ title: n.title, url: n.url, matches: hits.slice(0, 20), more: Math.max(0, hits.length - 20) });
          }
        };
        await Promise.all(Array.from({ length: SEARCH_PARALLEL }, worker));
        const structured = { searched: done, results };
        if (results.length === 0) return { text: `No matches in ${done} notes.`, structured };
        const text = results.map(r =>
          `${r.title} — ${r.url}\n${r.matches.map(m => `  ${m.line}: ${m.text}`).join('\n')}${r.more ? `\n  … ${r.more} more matches` : ''}`,
        ).join('\n\n') + (results.length >= maxNotes ? `\n\nStopped after ${maxNotes} notes with matches (raise max_notes, or search for something more specific).` : '');
        return { text, structured };
      },
    },
    {
      name: 'read_note',
      title: 'Read a note',
      group: 'read',
      description: 'Read a note\'s current text, live (including what others are typing right now), with who else is in it and whether you can edit it. Read part of a long note with lines or section; notes over 40,000 characters are cut, with an outline of their headings. Opens a live session that stays open while you work, so others see you in the note.',
      inputSchema: z.object({
        url: noteUrlSchema,
        lines: z.string().optional().describe('Only these lines: "12-40", "12-" (to the end) or "12"'),
        section: z.string().optional().describe('Only the section under this heading (exact heading text, case-insensitive), including subsections'),
        line_numbers: z.boolean().optional().describe('Prefix lines with their numbers (default true)'),
      }),
      outputSchema: z.object({
        url: z.string(), title: z.string(), can_edit: z.boolean(), read_only_reason: z.string().optional(),
        others_here: z.array(z.string()),
        total_lines: z.number(), from_line: z.number(), to_line: z.number(), truncated: z.boolean(), text: z.string(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      run: async (a) => {
        const { url, note } = await this.session(a.url);
        const doc = note.client.getDocument();
        note.seen = doc;
        const all = doc.split('\n');
        let from = 1;
        let to = all.length;
        if (a.section !== undefined) {
          const heading = str(a.section, 'section')!;
          const s = findSection(doc, heading);
          if (!s) throw new ToolError(`No section "${heading}". Headings in this note:\n${outline(doc) || '(none)'}`);
          from = lineOf(doc, s.start);
          to = lineOf(doc, Math.max(s.start, s.end - 1));
        }
        if (a.lines !== undefined) {
          const r = parseLineRange(str(a.lines, 'lines')!, all.length);
          from = Math.max(from, r.from);
          to = Math.min(to, r.to);
        }
        let shown = all.slice(from - 1, to);
        let truncated = false;
        let size = 0;
        for (let i = 0; i < shown.length; i++) {
          size += shown[i].length + 1;
          if (size > MAX_TEXT) {
            shown = shown.slice(0, i);
            truncated = true;
            break;
          }
        }
        const last = from + shown.length - 1;
        const info = this.info(url, note.client);
        const body = a.line_numbers === false ? shown.join('\n') : numbered(shown, from);
        const parts = [this.describe(info)];
        if (from !== 1 || last !== all.length) parts.push(`Lines ${from}-${last} of ${all.length}:`);
        parts.push(body);
        if (truncated) {
          parts.push(`[Cut at line ${last} of ${all.length}: too long to read at once. Read on with lines: "${last + 1}-", or one section at a time. Outline:]\n${outline(doc)}`);
        }
        return {
          text: parts.join('\n\n'),
          structured: { ...info, total_lines: all.length, from_line: from, to_line: last, truncated, text: shown.join('\n') },
        };
      },
    },
    {
      name: 'edit_note',
      title: 'Edit a note',
      group: 'edit',
      description: 'Replace text in a note, live: old_text must occur exactly once (or pass replace_all). The edit merges with what others are typing and appears in their editors immediately; your cursor is left at the edit. Prefer this (or edit_section) over write_note.',
      inputSchema: z.object({
        url: noteUrlSchema,
        old_text: z.string().describe('Exact text to replace, as in the note (without line-number prefixes); include enough context to be unique'),
        new_text: z.string().describe('Replacement text'),
        replace_all: z.boolean().optional().describe('Replace every occurrence'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      run: async (a) => {
        const { note } = await this.session(a.url);
        const oldText = str(a.old_text, 'old_text')!;
        const newText = typeof a.new_text === 'string' ? a.new_text : str(a.new_text, 'new_text')!;
        const doc = note.client.getDocument();
        const first = doc.indexOf(oldText);
        if (first < 0) throw new ToolError('old_text not found in the note. It may have changed meanwhile: read_note shows the current text (copy old_text without the line-number prefixes).');
        const count = doc.split(oldText).length - 1;
        if (count > 1 && a.replace_all !== true) {
          throw new ToolError(`old_text occurs ${count} times; add surrounding text to make it unique, or pass replace_all: true`);
        }
        const updated = a.replace_all === true ? doc.split(oldText).join(newText) : doc.slice(0, first) + newText + doc.slice(first + oldText.length);
        await this.apply(note, updated, first + newText.length);
        return { text: `Replaced ${a.replace_all === true ? `${count} occurrence(s)` : `at line ${lineOf(updated, first)}`}.` };
      },
    },
    {
      name: 'edit_section',
      title: 'Edit a section',
      group: 'edit',
      description: 'Change the section under a Markdown heading: replace its text, or add text at its start or end (e.g. a new item in a "## Tasks" list, an entry in a log). The heading itself is kept. With create: true a missing section is added at the end of the note.',
      inputSchema: z.object({
        url: noteUrlSchema,
        heading: z.string().describe('The section\'s heading text, without the #s (case-insensitive)'),
        text: z.string().describe('The text to put in'),
        mode: z.enum(['replace', 'append', 'prepend']).optional().describe('replace the section\'s text (default), or append/prepend to it'),
        create: z.boolean().optional().describe('Add the section (as ## heading) at the end of the note if it does not exist'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      run: async (a) => {
        const { note } = await this.session(a.url);
        const heading = str(a.heading, 'heading')!.replace(/^#+\s*/, '');
        const text = typeof a.text === 'string' ? a.text : str(a.text, 'text')!;
        const mode = (a.mode ?? 'replace') as 'replace' | 'append' | 'prepend';
        const doc = note.client.getDocument();
        const s = findSection(doc, heading);
        if (!s) {
          if (a.create !== true) {
            throw new ToolError(`No section "${heading}". Pass create: true to add it, or use one of:\n${outline(doc) || '(no headings)'}`);
          }
          const glue = doc === '' ? '' : doc.endsWith('\n\n') ? '' : doc.endsWith('\n') ? '\n' : '\n\n';
          const updated = `${doc}${glue}## ${heading}\n\n${text.replace(/\n*$/, '\n')}`;
          await this.apply(note, updated, updated.length);
          return { text: `Added section "${heading}" at line ${lineOf(updated, doc.length + glue.length)}.` };
        }
        let updated: string;
        let at: number;
        if (mode === 'append') {
          updated = appendToSection(doc, s, text);
          at = updated.length - (doc.length - s.end);
        } else if (mode === 'prepend') {
          const body = text.replace(/\n*$/, '\n');
          updated = doc.slice(0, s.bodyStart) + body + doc.slice(s.bodyStart);
          at = s.bodyStart + body.length;
        } else {
          updated = replaceSection(doc, s, text);
          at = updated.length - (doc.length - s.end);
        }
        await this.apply(note, updated, at);
        return { text: `${mode === 'replace' ? 'Replaced' : mode === 'append' ? 'Appended to' : 'Prepended to'} section "${s.heading}" (line ${lineOf(updated, s.start)}).` };
      },
    },
    {
      name: 'append_to_note',
      title: 'Append to a note',
      group: 'edit',
      description: 'Add text at the end of a note (a line break is put before it if the note does not end with one). To add to a particular section, use edit_section with mode: "append".',
      inputSchema: z.object({ url: noteUrlSchema, text: z.string().describe('The text to add') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      run: async (a) => {
        const { note } = await this.session(a.url);
        const text = str(a.text, 'text')!;
        const doc = note.client.getDocument();
        const glue = doc === '' || doc.endsWith('\n') ? '' : '\n';
        const updated = doc + glue + text;
        await this.apply(note, updated, updated.length);
        return { text: `Appended ${text.split('\n').length} line(s), from line ${lineOf(updated, doc.length + glue.length)}.` };
      },
    },
    {
      name: 'write_note',
      title: 'Replace a note',
      group: 'edit',
      description: 'Replace a note\'s whole text. Applied as the minimal change, so unchanged parts (and others\' cursors) are kept. Refused if the note changed since you last read it. For changes to part of a note use edit_note or edit_section.',
      inputSchema: z.object({ url: noteUrlSchema, content: z.string().describe('The note\'s complete new text (Markdown)') }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      run: async (a) => {
        const { note } = await this.session(a.url);
        const content = typeof a.content === 'string' ? a.content : str(a.content, 'content')!;
        const before = note.client.getDocument();
        if (before !== note.seen) {
          throw new ToolError('The note changed since you last read it (others are editing). read_note again and redo your change, or use edit_note / edit_section for a targeted edit.');
        }
        let at = 0;
        while (at < before.length && at < content.length && before[at] === content[at]) at++;
        await this.apply(note, content, at);
        return { text: 'Note replaced.' };
      },
    },
    {
      name: 'create_note',
      title: 'Create a note',
      group: 'create',
      description: 'Create a new note and return its URL. Start the content with "# Title" to give it a title.',
      inputSchema: z.object({
        content: z.string().describe('Markdown text'),
        server: serverSchema,
      }),
      outputSchema: z.object({ url: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      run: async (a) => {
        const server = this.server(a.server);
        const content = str(a.content, 'content')!;
        const url = buildNoteUrl(server, await this.ctx.api(server).createNote(content));
        return { text: `Created ${url}`, structured: { url } };
      },
    },
    {
      name: 'wait_for_change',
      title: 'Wait for changes',
      group: 'read',
      description: 'Wait until people change the note, then return what changed (a diff against the text you last saw) and who changed it. Returns at once if it already changed. Use it to work with people in a note: e.g. wait for the user to write a request, act on it, then wait again. With "until", waits until that text appears.',
      inputSchema: z.object({
        url: noteUrlSchema,
        timeout_seconds: z.number().positive().optional().describe('Give up after this long (default 120, max 600)'),
        until: z.string().optional().describe('Only return once the note contains this text (case-insensitive), e.g. "@claude"'),
        settle_seconds: z.number().min(0).optional().describe('Wait for typing to pause this long before returning (default 2)'),
      }),
      outputSchema: z.object({ changed: z.boolean(), by: z.array(z.string()), diff: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: true },
      run: async (a, run) => {
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
        note.pinned++; // no idle close while we wait
        const changed = await new Promise<boolean>((done) => {
          let settleTimer: ReturnType<typeof setTimeout> | undefined;
          const finish = (result: boolean) => {
            clearTimeout(settleTimer);
            clearTimeout(timer);
            client.off('change', onChange);
            run.signal.removeEventListener('abort', onAbort);
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
          const onAbort = () => finish(false);
          const timer = setTimeout(() => finish(ready()), timeout);
          client.on('change', onChange);
          run.signal.addEventListener('abort', onAbort);
          arm();
        });
        note.pinned--;
        this.touch(url, note);
        if (!changed) {
          return {
            text: `No change within ${Math.round(timeout / 1000)} s${until ? ` (waiting for "${a.until}")` : ''}. Call again to keep waiting.`,
            structured: { changed: false, by: [], diff: '' },
          };
        }
        const doc = client.getDocument();
        const diff = unifiedDiff(note.seen, doc);
        note.seen = doc;
        const by = [...authors];
        return { text: `Changed${by.length ? ` by ${by.join(', ')}` : ''}:\n${diff}`, structured: { changed: true, by, diff } };
      },
    },
  ];
}

export interface NoteEntry {
  title: string;
  url: string;
  tags: string[];
  pinned: boolean;
  last_opened: string;
}
