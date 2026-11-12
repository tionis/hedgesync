/**
 * exec: run a user script with a connected client.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectionOptions, type Command } from '../context.js';
import { CliError, c } from '../ui.js';

export const exec: Command = {
  name: 'exec',
  summary: 'Run a script against a note',
  options: [...connectionOptions],
  help: () => `
${c('bold', 'hedgesync exec')} - Run a script against a note

${c('yellow', 'USAGE:')}
  hedgesync exec <script> [url] [-- script-args...]

The script is a JavaScript/TypeScript module exporting a default function (or
a function named ${c('cyan', 'run')}). It is called as ${c('cyan', 'fn(client, args)')}:

  ${c('cyan', 'client')}   A connected HedgeDocClient for <url>, or null without a URL
  ${c('cyan', 'args')}     { positional, options, rest } where rest holds the arguments after --

Pending edits are flushed and the client is disconnected when the function returns.

${c('yellow', 'EXAMPLE:')}
  ${c('dim', '// stamp.ts')}
  export default async (client, args) => {
    client.insert(client.getDocument().length, '\\nStamped by ' + (args.rest[0] ?? 'me'));
  };

  hedgesync exec stamp.ts https://md.example.com/abc123 -- alice
`,
  async run(ctx) {
    const scriptPath = ctx.need(0, 'Script path', 'hedgesync exec <script> [url] [-- args...]');
    const absolute = resolve(scriptPath);
    if (!existsSync(absolute)) throw new CliError(`Script not found: ${scriptPath}`);

    const mod = await import(pathToFileURL(absolute).href) as { default?: unknown; run?: unknown };
    const fn = typeof mod.default === 'function' ? mod.default : typeof mod.run === 'function' ? mod.run : null;
    if (!fn) throw new CliError('Script must export a default function or a function named run');

    const scriptArgs = { positional: ctx.positional.slice(2), options: ctx.args.options, rest: ctx.args.rest };
    if (!ctx.positional[1]) {
      await (fn as (client: null, args: unknown) => unknown)(null, scriptArgs);
      return;
    }
    await ctx.withClient({ index: 1 }, client => (fn as (client: unknown, args: unknown) => unknown)(client, scriptArgs));
  },
};
