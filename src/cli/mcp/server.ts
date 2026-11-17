/**
 * The MCP server: hedgesync's tools for HedgeDoc notes, built on the
 * official SDK, which speaks both the current protocol (2026-07-28) and the
 * 2025-era `initialize` handshake.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { VERSION } from '../../version.js';
import type { HedgeDocTools } from './tools.js';

export const INSTRUCTIONS =
  'Tools for HedgeDoc notes. Edits go through live sessions: they merge with what people type and appear in their '
  + 'editors at once. Read a note before editing it; prefer edit_note for partial changes. wait_for_change lets you '
  + 'react to what people write in a note.';

/** An MCP server instance over a tool pool (one per connection; the pool can be shared). */
export function buildServer(tools: HedgeDocTools): McpServer {
  const server = new McpServer(
    { name: 'hedgesync', title: 'HedgeDoc (hedgesync)', version: VERSION },
    { instructions: INSTRUCTIONS },
  );
  for (const tool of tools.tools) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    }, async (args: Record<string, unknown>) => {
      const { text, isError } = await tools.call(tool.name, args);
      return { content: [{ type: 'text' as const, text }], isError };
    });
  }
  return server;
}
