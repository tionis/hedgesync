/**
 * mcp: a Model Context Protocol server, so AI agents (Claude Code, Codex,
 * Cursor, ...) can read and edit HedgeDoc notes as collaborators.
 */

import { parseServerUrl } from '../../url.js';
import type { Command } from '../context.js';

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
    // Loaded here, not at startup: the SDK's stdio module takes over stdin,
    // which other commands read.
    const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
    const { buildServer } = await import('../mcp/server.js');
    const { HedgeDocTools } = await import('../mcp/tools.js');
    const server = ctx.str('server');
    const tools = new HedgeDocTools(ctx, server ? parseServerUrl(server) : undefined);
    // One connection on stdio; it ends when the agent closes stdin.
    await new Promise<void>((resolve) => {
      serveStdio(() => {
        const instance = buildServer(tools);
        instance.server.onclose = () => resolve();
        return instance;
      });
    });
    await tools.closeAll();
  },
};
