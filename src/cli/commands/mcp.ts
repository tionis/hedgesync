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
  const server = ctx.str('server');
  let groups: ToolGroup[] = [...TOOL_GROUPS];
  const tools = ctx.str('tools');
  if (tools !== undefined) {
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
  ],
  help: () => `
hedgesync mcp - Serve HedgeDoc notes to AI agents (Model Context Protocol)

USAGE:
  hedgesync mcp [--server <url>] [--read-only] [--tools <groups>] [--note <url>...]

Speaks MCP on stdin/stdout, for agents such as Claude Code:

  claude mcp add hedgesync -- hedgesync mcp --server https://md.example.com

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

Logins are the CLI's (hedgesync login <server> --save, or HEDGEDOC_COOKIE).

EXAMPLES:
  # An agent that may only read and comment on the team's planning note
  claude mcp add planning -- hedgesync mcp --note https://md.example.com/plan
  # Read-only access to everything in your history
  claude mcp add hedgedoc -- hedgesync mcp -s https://md.example.com --read-only
`,
  async run(ctx) {
    const options = mcpToolOptions(ctx);
    // Loaded here, not at startup: the SDK's stdio module takes over stdin,
    // which other commands read.
    const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
    const { buildServer } = await import('../mcp/server.js');
    const { HedgeDocTools } = await import('../mcp/tools.js');
    const tools = new HedgeDocTools(ctx, options);
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
