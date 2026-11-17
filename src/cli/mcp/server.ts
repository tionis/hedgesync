/**
 * The MCP server: hedgesync's tools for HedgeDoc notes, built on the
 * official SDK, which speaks both the current protocol (2026-07-28) and the
 * 2025-era `initialize` handshake.
 *
 * Besides the tools, notes are resources (their URL is the resource URI), with
 * change notifications for subscribed notes, and there is a prompt for working
 * with people in a note.
 */

import { McpServer, ResourceTemplate, type McpRequestContext } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { VERSION } from '../../version.js';
import { type HedgeDocTools, type Tool, ToolError } from './tools.js';

/** How long a note read as a resource over HTTP stays open, so listeners hear about changes. */
const HTTP_RESOURCE_KEEP_MS = 60 * 60_000;

export interface BuildOptions {
  /** Only tools of these groups (e.g. the scopes of an OAuth token). */
  groups?: string[];
  /** Served over HTTP: one instance per request, notifications published by the handler. */
  http?: boolean;
}

/** The server's instructions to agents; key words first, since clients may cut them short. */
export function instructions(tools: HedgeDocTools, enabled: Tool[] = tools.enabled()): string {
  const names = new Set(enabled.map(t => t.name));
  const lines = [
    'HedgeDoc notes (collaborative Markdown), read and edited live: your edits merge with what people are typing and appear in their editors at once, with your cursor where you worked.',
    'Notes are identified by their URL, e.g. https://md.example.com/abc123.',
  ];
  if (names.has('edit_note')) {
    lines.push('Read a note (read_note) before editing it. Prefer small edits: edit_note to replace exact text, edit_section to change or add to the section under a heading, append_to_note to add at the end; write_note replaces everything and is refused if the note changed since you read it.');
    lines.push('People may be typing in the same place: if old_text is not found, read the note again rather than retrying blindly.');
  } else {
    lines.push('Read-only: notes can be read and searched, not changed.');
  }
  lines.push('Long notes: read_note with section or lines, after looking at the outline it gives for notes too long to return at once.');
  if (names.has('wait_for_change')) {
    lines.push('To work with people in a note, call wait_for_change (e.g. until "@agent") and act on what they wrote; call it again to keep listening.');
  }
  if (tools.allowedNotes) lines.push(`Only these notes are available: ${[...tools.allowedNotes].join(', ')}.`);
  return lines.join('\n');
}

/** An MCP server instance over a tool pool (one per connection; the pool can be shared). */
export function buildServer(tools: HedgeDocTools, ctx?: Partial<McpRequestContext>, options: BuildOptions = {}): McpServer {
  const enabled = tools.enabled().filter(t => !options.groups || options.groups.includes(t.group));
  const server = new McpServer(
    { name: 'hedgesync', title: 'HedgeDoc (hedgesync)', version: VERSION, websiteUrl: 'https://github.com/tionis/hedgesync' },
    {
      instructions: instructions(tools, enabled),
      // A 2025 request over HTTP is stateless: nothing to subscribe on.
      capabilities: { resources: { subscribe: !(options.http && ctx?.era !== 'modern'), listChanged: false } },
    },
  );

  for (const tool of enabled) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: { title: tool.title, ...tool.annotations },
    }, async (args: Record<string, unknown>, extra) => {
      const progressToken = extra.mcpReq._meta?.progressToken;
      try {
        const result = await tool.run(args ?? {}, {
          signal: extra.mcpReq.signal,
          progress: (progress, total, message) => {
            if (progressToken === undefined) return;
            void extra.mcpReq.notify({
              method: 'notifications/progress',
              params: { progressToken, progress, total, message },
            }).catch(() => undefined);
          },
        });
        return {
          content: [{ type: 'text' as const, text: result.text }],
          ...(tool.outputSchema && result.structured ? { structuredContent: result.structured } : {}),
        };
      } catch (err) {
        // Agents see the message and can correct themselves; other errors are bugs or outages.
        const text = err instanceof ToolError ? err.message : `Failed: ${(err as Error).message}`;
        return { content: [{ type: 'text' as const, text }], isError: true };
      }
    });
  }

  if (enabled.some(t => t.name === 'read_note')) {
    // Change notifications. 2025 clients subscribe note by note (and we keep
    // those notes open). 2026-07-28 clients name the notes in
    // subscriptions/listen, which the SDK serves and filters without telling
    // us, so there a note read as a resource stays open for the connection.
    const legacy = ctx?.era !== 'modern';
    const subscribed = new Set<string>();
    server.registerResource('note', new ResourceTemplate('{+url}', {
      list: async () => {
        let notes: { title: string; url: string }[] = [];
        try {
          notes = (await tools.history()).notes;
        } catch {
          // No default server or no login: only the open notes are listed.
          notes = tools.openNotes().map(url => ({ title: url, url }));
        }
        return { resources: notes.slice(0, 100).map(n => ({ uri: n.url, name: n.title, mimeType: 'text/markdown' })) };
      },
    }), {
      title: 'HedgeDoc note',
      description: 'A note\'s live Markdown text, by its URL. Subscribe to be told when people change it.',
      mimeType: 'text/markdown',
    }, async (uri) => {
      try {
        const { url, title, text } = await tools.text(uri.href);
        if (options.http) tools.keepOpen(url, HTTP_RESOURCE_KEEP_MS);
        else if (!legacy && !subscribed.has(url)) {
          subscribed.add(url);
          await tools.pin(url);
        }
        return { contents: [{ uri: url, mimeType: 'text/markdown', text, _meta: { title } }] };
      } catch (err) {
        throw new Error((err as Error).message);
      }
    });

    // Over HTTP the handler publishes changes; requests have no connection to subscribe on.
    if (!options.http) {
      const stop = tools.onNoteChange((url) => {
        if (legacy && !subscribed.has(url)) return;
        void server.server.sendResourceUpdated({ uri: url }).catch(() => undefined);
      });
      server.server.setRequestHandler('resources/subscribe', async (req) => {
        const { url } = tools.noteUrl(req.params.uri);
        if (!subscribed.has(url)) {
          await tools.pin(url);
          subscribed.add(url);
        }
        return {};
      });
      server.server.setRequestHandler('resources/unsubscribe', async (req) => {
        const { url } = tools.noteUrl(req.params.uri);
        if (subscribed.delete(url)) tools.unpin(url);
        return {};
      });
      const previous = server.server.onclose;
      server.server.onclose = () => {
        stop();
        for (const url of subscribed) tools.unpin(url);
        subscribed.clear();
        previous?.();
      };
    }
  }

  if (enabled.some(t => t.name === 'wait_for_change') && enabled.some(t => t.name === 'edit_note')) {
    server.registerPrompt('work_in_note', {
      title: 'Work with people in a note',
      description: 'Stay in a HedgeDoc note and do what people ask for in it, e.g. when they write "@agent please summarize this".',
      argsSchema: z.object({
        url: z.string().describe('The note\'s URL'),
        mention: z.string().optional().describe('What people write to address you (default "@agent")'),
      }),
    }, ({ url, mention }) => {
      const tag = mention || '@agent';
      return {
        messages: [{
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: [
              `Work with the people in the HedgeDoc note ${url}.`,
              '',
              `1. Read it with read_note to see what it is about.`,
              `2. Call wait_for_change with url ${url} and until "${tag}". It returns what people changed.`,
              `3. When someone writes a request addressed to ${tag}, do it in the note: edit_note or edit_section for changes, or answer right below the request. Then remove or mark the ${tag} line so it is not handled twice (e.g. replace "${tag}" with "✓").`,
              '4. Go back to step 2. Keep going until told to stop; when wait_for_change times out, just call it again.',
              '',
              'People keep typing while you work: make small, targeted edits and read the note again if text you expected has moved.',
            ].join('\n'),
          },
        }],
      };
    });
  }

  return server;
}
