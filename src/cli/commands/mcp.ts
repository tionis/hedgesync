/**
 * mcp: a Model Context Protocol server, so AI agents (Claude Code, Codex,
 * Cursor, ...) can read and edit HedgeDoc notes as collaborators.
 */

import { buildNoteUrl, parseNoteUrl, parseServerUrl } from '../../url.js';
import type { Command, Context } from '../context.js';
import { CliError } from '../ui.js';
import { TOOL_GROUPS, type ToolGroup, type ToolOptions } from '../mcp/tool-groups.js';

/** The tool options from --server, --read-only, --tools and --note. */
export function mcpToolOptions(ctx: Context): ToolOptions {
  // Empty means unset (e.g. an unset plugin option).
  const server = ctx.str('server') || undefined;
  let groups: ToolGroup[] = [...TOOL_GROUPS];
  const tools = ctx.str('tools');
  if (tools) {
    const wanted = tools.split(',').map(s => s.trim()).filter(Boolean);
    const unknown = wanted.filter(g => !(TOOL_GROUPS as readonly string[]).includes(g));
    if (unknown.length) throw new CliError(`Unknown tool group: ${unknown.join(', ')}`, `Groups: ${TOOL_GROUPS.join(', ')}`);
    groups = wanted as ToolGroup[];
  }
  if (ctx.flag('read-only')) groups = groups.filter(g => g === 'read');
  if (groups.length === 0) throw new CliError('No tools left to serve', `--tools takes some of: ${TOOL_GROUPS.join(', ')}`);
  const notes = ctx.list('note').map((spec) => {
    try {
      const { serverUrl, noteId } = parseNoteUrl(spec.replace(/[?#].*$/, ''));
      return buildNoteUrl(serverUrl, noteId);
    } catch (err) {
      throw new CliError(`Invalid --note "${spec}": ${(err as Error).message}`, 'Use --note <note-url> (repeatable)');
    }
  });
  return {
    defaultServer: server ? parseServerUrl(server) : undefined,
    groups,
    notes: notes.length ? notes : undefined,
  };
}

export const mcp: Command = {
  name: 'mcp',
  summary: 'Serve HedgeDoc notes to AI agents (Model Context Protocol)',
  options: [
    { name: 'server', short: 's', type: 'value' },
    { name: 'read-only', type: 'flag' },
    { name: 'tools', type: 'value' },
    { name: 'note', type: 'multi' },
    { name: 'http', type: 'value' },
    { name: 'public-url', type: 'value' },
    { name: 'token', type: 'value' },
    { name: 'owner', type: 'multi' },
  ],
  help: () => `
hedgesync mcp - Serve HedgeDoc notes to AI agents (Model Context Protocol)

USAGE:
  hedgesync mcp [--server <url>] [--read-only] [--tools <groups>] [--note <url>...]
  hedgesync mcp --http [<host>:]<port> [--token <t> | --owner <url>...] [...]

Speaks MCP on stdin/stdout, for agents such as Claude Code:

  claude mcp add hedgesync -- hedgesync mcp --server https://md.example.com

or over HTTP (--http), for agents elsewhere and hosted ones.

Edits go through live sessions, like a person typing: they merge with
concurrent edits, appear in everyone's editor at once, and the agent's cursor
shows where it worked (under your login's name). A session stays open ten
minutes after its last use. wait_for_change returns what people changed, so an
agent can take requests written into a note.

TOOLS (by group):
  read     list_notes, search_notes, read_note, wait_for_change
  edit     edit_note, edit_section, append_to_note, write_note
  create   create_note

Notes are also resources (their URL is the resource URI; subscribe to hear
about changes), and the prompt work_in_note sets an agent up to take requests
written into a note.

OPTIONS:
  -s, --server <url>   Default server for listing, searching and creating notes
  --read-only          Only the read tools: the agent cannot change anything
  --tools <groups>     Only these tool groups, comma-separated (read,edit,create)
  --note <url>         Only this note (repeatable): no other note can be read,
                       edited or listed, and no notes can be created

HTTP (Streamable HTTP, at /mcp):
  --http [<host>:]<port>   Listen here (host default 127.0.0.1)
  --token <token>          Require this bearer token (or HEDGESYNC_MCP_TOKEN)
  --owner <url>            Require OAuth sign-in by this person (repeatable):
                           their website, checked with IndieAuth
  --public-url <url>       Where clients reach the server, e.g. behind a
                           reverse proxy: https://mcp.example.com (an origin)

  Without --token or --owner the server only listens on loopback, and only
  answers requests for localhost (no web page can reach it).

  With --owner, agents sign in like apps do (OAuth 2.1: PKCE, client
  metadata documents or dynamic registration, refresh tokens). The person
  approves the agent and proves who they are with IndieAuth (their website
  names their IndieAuth server). The scopes read, edit and create pick
  the tool groups an agent gets. Tokens are stored (hashed) in
  mcp-oauth.json next to your logins.

Everyone who gets in works as this machine's HedgeDoc login.
Logins are the CLI's (hedgesync login <server> --save, or HEDGEDOC_COOKIE).

EXAMPLES:
  # An agent that may only read and comment on the team's planning note
  claude mcp add planning -- hedgesync mcp --note https://md.example.com/plan
  # Read-only access to everything in your history
  claude mcp add hedgedoc -- hedgesync mcp -s https://md.example.com --read-only
  # On a server, behind a reverse proxy, for you only
  hedgesync mcp --http 8788 --public-url https://mcp.example.com --owner https://you.example.com
  claude mcp add --transport http hedgedoc https://mcp.example.com/mcp
`,
  async run(ctx) {
    const options = mcpToolOptions(ctx);
    // Loaded here, not at startup: the SDK's stdio module takes over stdin,
    // which other commands read.
    const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
    const { buildServer } = await import('../mcp/server.js');
    const { HedgeDocTools } = await import('../mcp/tools.js');
    const tools = new HedgeDocTools(ctx, options);
    const http = ctx.str('http');
    if (http !== undefined) {
      await runHttp(ctx, tools, http, options.groups ?? []);
      return;
    }
    for (const o of ['public-url', 'token', 'owner']) {
      if (ctx.str(o) !== undefined || ctx.list(o).length) throw new CliError(`--${o} goes with --http`);
    }
    // One connection on stdio; it ends when the agent closes stdin.
    await new Promise<void>((resolve) => {
      serveStdio((requestCtx) => {
        const instance = buildServer(tools, requestCtx);
        const previous = instance.server.onclose;
        instance.server.onclose = () => {
          previous?.();
          resolve();
        };
        return instance;
      });
    });
    await tools.closeAll();
  },
};

/** "8788", "0.0.0.0:8788" or "[::1]:8788" to host and port. */
export function parseListen(spec: string): { host: string; port: number } {
  const m = /^(?:\[([^\]]+)\]:|([^:]+):)?(\d+)$/.exec(spec.trim());
  const port = m ? Number(m[3]) : NaN;
  if (!m || port > 65535) throw new CliError(`Invalid --http "${spec}"`, 'Use --http <port> or --http <host>:<port>');
  return { host: m[1] ?? m[2] ?? '127.0.0.1', port };
}

async function runHttp(ctx: Context, tools: import('../mcp/tools.js').HedgeDocTools, spec: string, groups: string[]): Promise<void> {
  const { host, port } = parseListen(spec);
  const { isLoopback, serveHttp } = await import('../mcp/http.js');
  const token = ctx.str('token') ?? process.env.HEDGESYNC_MCP_TOKEN;
  const owners = ctx.list('owner');
  const publicUrl = ctx.str('public-url');
  if (token && owners.length) throw new CliError('Use either --token or --owner, not both');
  if (!token && !owners.length && !isLoopback(host)) {
    throw new CliError(`Refusing to serve ${host} without authentication`, 'Add --owner <your website> (OAuth) or --token <secret>, or listen on 127.0.0.1');
  }
  if (owners.length && !publicUrl && !isLoopback(host)) {
    throw new CliError('--owner needs --public-url', 'The URL clients reach this server at, e.g. https://mcp.example.com');
  }
  if (publicUrl) {
    let url: URL;
    try {
      url = new URL(publicUrl);
    } catch {
      throw new CliError(`Invalid --public-url "${publicUrl}"`);
    }
    if (url.protocol !== 'https:' && !isLoopback(url.hostname)) throw new CliError('--public-url must use https (except on localhost)');
  }
  for (const owner of owners) {
    try {
      new URL(/^https?:\/\//i.test(owner) ? owner : `https://${owner}`);
    } catch {
      throw new CliError(`Invalid --owner "${owner}"`, 'Use your website, e.g. https://you.example.com');
    }
  }
  const server = await serveHttp(tools, {
    host, port, publicUrl, token, owners, groups,
    log: (m) => ctx.warn(m),
  });
  ctx.info(`MCP server at ${server.url}${owners.length ? ` (OAuth, sign-in: ${owners.join(', ')})` : token ? ' (bearer token)' : ' (no authentication, this machine only)'}`);
  ctx.info(`Tools: ${groups.join(', ')}${tools.allowedNotes ? `; notes: ${[...tools.allowedNotes].join(', ')}` : ''}. Ctrl+C stops.`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  await server.close();
  await tools.closeAll();
}
