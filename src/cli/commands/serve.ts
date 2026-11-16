/**
 * serve: an HTTP endpoint for writing into notes, so that scripts, Home
 * Assistant, CI or a phone shortcut can append to a note with one request.
 *
 * Only notes listed with --note are reachable, by the names given there.
 * Edits go through live sessions (kept open), so they merge with what people
 * type at the same moment.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { HedgeDocClient } from '../../hedgedoc-client.js';
import { appendToSection, findSection, replaceSection } from '../../note-sections.js';
import { parseNoteUrl } from '../../url.js';
import { assertEditable, connectionOptions, type Command, type Context } from '../context.js';
import { CliError, c } from '../ui.js';

/** Largest request body accepted. */
const MAX_BODY = 1024 * 1024;

export interface ServeNote {
  name: string;
  url: string;
}

/** Parse `--note name=url` (or a bare URL, named by its id). */
export function parseServeNote(spec: string): ServeNote {
  const m = /^([\w.-]+)=(.+)$/.exec(spec);
  const url = m ? m[2] : spec;
  let noteId: string;
  try {
    ({ noteId } = parseNoteUrl(url));
  } catch (err) {
    throw new CliError(`Invalid --note "${spec}": ${(err as Error).message}`, 'Use --note <name>=<note-url>');
  }
  return { name: m ? m[1] : noteId, url };
}

const isLoopback = (host: string) => host === 'localhost' || host === '::1' || /^127\./.test(host);

/** Add the time ("14:02") in front of each first line, for logs and timelines. */
function stamped(text: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const time = `${p(now.getHours())}:${p(now.getMinutes())}`;
  const m = /^(\s*(?:[-*+]|\d+\.)\s+)?/.exec(text)!;
  return text.slice(0, m[0].length) + `${time} ` + text.slice(m[0].length);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The text of a request: text/plain as is, JSON {"text": ...}, or form text=... */
export function bodyText(body: string, contentType: string | undefined): string {
  const type = (contentType ?? '').toLowerCase();
  if (type.includes('application/json')) {
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      throw Object.assign(new Error('Invalid JSON'), { status: 400 });
    }
    if (typeof data === 'string') return data;
    if (data && typeof (data as { text?: unknown }).text === 'string') return (data as { text: string }).text;
    throw Object.assign(new Error('JSON body needs a "text" field'), { status: 400 });
  }
  if (type.includes('application/x-www-form-urlencoded')) {
    const text = new URLSearchParams(body).get('text');
    if (text === null) throw Object.assign(new Error('Form body needs a "text" field'), { status: 400 });
    return text;
  }
  return body;
}

export const serve: Command = {
  name: 'serve',
  summary: 'An HTTP endpoint for appending to notes (webhooks, scripts)',
  options: [
    ...connectionOptions,
    { name: 'note', short: 'n', type: 'multi' },
    { name: 'port', short: 'p', type: 'value' },
    { name: 'host', type: 'value' },
    { name: 'token', type: 'value' },
  ],
  help: () => `
${c('bold', 'hedgesync serve')} - An HTTP endpoint for appending to notes

${c('yellow', 'USAGE:')}
  hedgesync serve --note <name>=<note-url> [--note ...] [--port 8787] [--host 127.0.0.1] [--token <t>]

Lets scripts, webhooks (Home Assistant, CI, monitoring) or a phone shortcut
write into notes with one HTTP request. Only the notes given with --note can
be reached, by their names. Edits are live: they merge with what people type
and show up in their editors at once. Sessions stay open while serving.

${c('yellow', 'ENDPOINTS:')}
  GET  /                          The note names
  GET  /notes/<name>              The note's text
  POST /notes/<name>/append       Add the body as new lines at the end
  POST /notes/<name>/prepend      Add the body at the start
  PUT  /notes/<name>              Replace the note's text

  Query: ${c('cyan', 'section=<heading>')} appends to (or, with PUT, replaces) that section
  instead of the whole note; ${c('cyan', 'stamp=1')} puts the time in front ("- 14:02 ...").
  The body is plain text, JSON {"text": "..."} or a form field text=...

${c('yellow', 'SECURITY:')}
  Requests need the token, as "Authorization: Bearer <token>" or ?token=.
  The token is --token or HEDGESYNC_SERVE_TOKEN. Without one the server only
  listens on 127.0.0.1 (no token needed there); --host with another address
  requires one. Anyone with the token can write to the listed notes.

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-n, --note <name>=<url>')} A note to serve (repeatable; a bare URL is named by its id)
  ${c('cyan', '-p, --port <n>')}   Port (default 8787; 0 picks a free one)
  ${c('cyan', '--host <addr>')}    Address to listen on (default 127.0.0.1)
  ${c('cyan', '--token <t>')}      Required token (also HEDGESYNC_SERVE_TOKEN)

${c('yellow', 'EXAMPLES:')}
  hedgesync serve --note ops=https://md.example.com/abc --token "$TOKEN" --host 0.0.0.0
  curl -H "Authorization: Bearer $TOKEN" --data-binary "- deploy finished" \\
    "http://box:8787/notes/ops/append?section=Timeline&stamp=1"
`,
  async run(ctx: Context) {
    const notes = ctx.list('note').map(parseServeNote);
    if (notes.length === 0) throw new CliError('No notes to serve', 'Pass --note <name>=<note-url> (repeatable).');
    const byName = new Map(notes.map(n => [n.name, n]));
    if (byName.size !== notes.length) throw new CliError('Two --note entries have the same name');
    const host = ctx.str('host') ?? '127.0.0.1';
    const port = ctx.int('port', 8787);
    const token = ctx.str('token') ?? process.env.HEDGESYNC_SERVE_TOKEN;
    if (!token && !isLoopback(host)) {
      throw new CliError(`Listening on ${host} needs a token`, 'Pass --token <t> or set HEDGESYNC_SERVE_TOKEN.');
    }

    const clients = new Map<string, Promise<HedgeDocClient>>();
    const client = (note: ServeNote): Promise<HedgeDocClient> => {
      let p = clients.get(note.name);
      if (!p) {
        const { serverUrl, noteId } = parseNoteUrl(note.url);
        p = ctx.connectTo(serverUrl, noteId);
        p.catch(() => clients.delete(note.name));
        clients.set(note.name, p);
      }
      return p;
    };
    // One edit at a time per note, so concurrent requests apply in order.
    const queues = new Map<string, Promise<unknown>>();
    const serial = <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const next = (queues.get(name) ?? Promise.resolve()).then(fn, fn);
      queues.set(name, next.catch(() => undefined));
      return next;
    };

    const authorized = (req: IncomingMessage, url: URL): boolean => {
      if (!token) return true;
      const given = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
      const a = Buffer.from(given);
      const b = Buffer.from(token);
      return a.length === b.length && timingSafeEqual(a, b);
    };

    const send = (res: ServerResponse, status: number, body: unknown) => {
      const text = typeof body === 'string' ? body : JSON.stringify(body) + '\n';
      res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/markdown; charset=utf-8' : 'application/json' });
      res.end(text);
    };

    const handle = async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (!authorized(req, url)) return send(res, 401, { ok: false, error: 'Missing or wrong token' });
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (parts.length === 0 && req.method === 'GET') return send(res, 200, { ok: true, notes: notes.map(n => n.name) });
      if (parts[0] !== 'notes' || !parts[1] || parts.length > 3) return send(res, 404, { ok: false, error: 'Not found' });
      const note = byName.get(parts[1]);
      if (!note) return send(res, 404, { ok: false, error: `No note named "${parts[1]}"`, notes: notes.map(n => n.name) });
      const action = parts[2] ?? (req.method === 'PUT' ? 'replace' : req.method === 'GET' ? 'get' : '');
      const allowed: Record<string, string> = { get: 'GET', replace: 'PUT', append: 'POST', prepend: 'POST' };
      if (allowed[action] !== req.method) return send(res, 405, { ok: false, error: `${req.method} ${url.pathname} is not supported` });

      const cl = await client(note);
      if (action === 'get') return send(res, 200, cl.getDocument());
      let text = bodyText(await readBody(req), req.headers['content-type']);
      if (url.searchParams.get('stamp') === '1') text = stamped(text);
      const sectionName = url.searchParams.get('section');
      const length = await serial(note.name, async () => {
        assertEditable(cl);
        const doc = cl.getDocument();
        let updated: string;
        if (sectionName) {
          const section = findSection(doc, sectionName);
          if (!section) throw Object.assign(new Error(`No section "${sectionName}" in the note`), { status: 404 });
          updated = action === 'replace' ? replaceSection(doc, section, text) : action === 'append' ? appendToSection(doc, section, text)
            : doc.slice(0, section.bodyStart) + text.replace(/\n*$/, '\n') + doc.slice(section.bodyStart);
        } else if (action === 'replace') {
          updated = text;
        } else if (action === 'append') {
          updated = doc + (doc === '' || doc.endsWith('\n') ? '' : '\n') + text.replace(/\n*$/, '\n');
        } else {
          updated = text.replace(/\n*$/, '\n') + doc;
        }
        cl.updateContent(updated);
        await cl.flush();
        return updated.length;
      });
      ctx.info(`${c('dim', new Date().toLocaleTimeString())} ${req.method} ${note.name}${sectionName ? ` § ${sectionName}` : ''} ${action} (${text.length} characters)`);
      send(res, 200, { ok: true, length });
    };

    const server = createServer((req, res) => {
      handle(req, res).catch((err: Error & { status?: number; hint?: string }) => {
        if (!res.headersSent) send(res, err.status ?? (err instanceof CliError ? 403 : 500), { ok: false, error: err.message, ...(err.hint ? { hint: err.hint } : {}) });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', (err: NodeJS.ErrnoException) => reject(new CliError(`Cannot listen on ${host}:${port}: ${err.code ?? err.message}`)));
      server.listen(port, host, resolve);
    });
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    ctx.result({ action: 'serve', host, port: actualPort, notes: notes.map(n => n.name) }, () => {
      ctx.info(`${c('green', '✓ Serving')} http://${host.includes(':') ? `[${host}]` : host}:${actualPort} ${c('dim', `(${notes.map(n => n.name).join(', ')}${token ? '; token required' : ''}; Ctrl+C stops)`)}`);
    });

    await new Promise<void>((resolve) => {
      const stop = async () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        server.close();
        for (const p of clients.values()) {
          const cl = await p.catch(() => undefined);
          await cl?.flush().catch(() => undefined);
          cl?.disconnect();
        }
        resolve();
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
  },
};
