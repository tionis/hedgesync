/**
 * transform: pandoc-based document transformations.
 */

import { PandocTransformer, isPandocAvailable } from '../../pandoc-transformer.js';
import type { PandocAST } from '../../pandoc-transformer.js';
import { assertEditable, connectionOptions, type Command } from '../context.js';
import { helpText } from '../help-text.js';
import { CliError, c } from '../ui.js';

function shiftHeaders(pandoc: PandocTransformer, delta: number) {
  return (ast: PandocAST) => {
    pandoc.walkAST(ast, (el) => {
      const node = el as { t?: string; c?: unknown[] };
      if (node.t === 'Header' && Array.isArray(node.c)) {
        node.c[0] = Math.min(6, Math.max(1, (node.c[0] as number) + delta));
      }
    });
    return ast;
  };
}

export const transform: Command = {
  name: 'transform',
  summary: 'Transform document with pandoc',
  options: [
    ...connectionOptions,
    { name: 'demote', type: 'flag' },
    { name: 'promote', type: 'flag' },
    { name: 'shift', type: 'value' },
    { name: 'to', type: 'value' },
  ],
  help: helpText.transform,
  async run(ctx) {
    ctx.note(0, 'hedgesync transform <url> [--demote|--promote|--to <format>]');
    if (!(await isPandocAvailable())) {
      throw new CliError('pandoc is not installed or not on PATH', 'See https://pandoc.org/installing.html');
    }
    const pandoc = new PandocTransformer();
    const to = ctx.str('to');

    if (to) {
      // Conversion only reads the note, so read-only access is enough.
      const output = await ctx.withClient({}, client => pandoc.convert(client.getDocument(), 'markdown', to));
      ctx.result({ action: 'transform', operation: 'convert', format: to, content: output },
        () => process.stdout.write(output.endsWith('\n') ? output : output + '\n'));
      return;
    }

    const shift = ctx.flag('demote') ? 1 : ctx.flag('promote') ? -1 : ctx.int('shift', 0);
    const operation = shift > 0 ? 'demote' : shift < 0 ? 'promote' : 'normalize';
    await ctx.withClient({}, async (client) => {
      assertEditable(client);
      await pandoc.applyToClient(client, shift ? shiftHeaders(pandoc, shift) : ast => ast);
    });
    const done = shift ? `Headers shifted by ${shift}` : 'Document normalized';
    ctx.result({ action: 'transform', operation, shift }, () => ctx.info(c('green', `✓ ${done}`)));
  },
};
