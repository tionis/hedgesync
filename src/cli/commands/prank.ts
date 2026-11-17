/**
 * prank: mess with whoever is typing in a note (see src/prank.ts).
 */

import { PrankEngine, stutter, type Prank } from '../../prank.js';
import { assertEditable, connectionOptions, type Command } from '../context.js';
import { helpText } from '../help-text.js';
import { CliError, c } from '../ui.js';

/** "30", "30%" or "0.3%"-style percentage to a probability in 0..1. */
export function parsePercent(value: string, option: string): number {
  const n = Number(value.trim().replace(/%$/, ''));
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new CliError(`${option} must be a percentage between 0 and 100, got '${value}'`);
  }
  return n / 100;
}

export const prank: Command = {
  name: 'prank',
  summary: 'Annoy people typing in a note (stutter, ...)',
  options: [
    ...connectionOptions,
    { name: 'stutter', type: 'value' },
    { name: 'stutter-deletes', type: 'flag' },
    { name: 'allow-user', type: 'multi' },
    { name: 'user-filter', short: 'U', type: 'value' },
  ],
  help: helpText.prank,
  async run(ctx) {
    const pranks: Prank[] = [];
    const stutterPct = ctx.str('stutter');
    if (stutterPct !== undefined) {
      pranks.push(stutter({ probability: parsePercent(stutterPct, '--stutter'), deletes: ctx.flag('stutter-deletes') }));
    } else if (ctx.flag('stutter-deletes')) {
      throw new CliError('--stutter-deletes needs --stutter <percent>');
    }
    if (pranks.length === 0) throw new CliError('No prank chosen', 'Try --stutter 20');

    const filter = ctx.str('user-filter');
    let userFilter: RegExp | undefined;
    if (filter !== undefined) {
      try {
        userFilter = new RegExp(filter);
      } catch {
        throw new CliError(`Invalid --user-filter regex: ${filter}`);
      }
    }
    const allowedUserIds = ctx.list('allow-user');

    const client = await ctx.connect(0);
    try {
      assertEditable(client);
    } catch (err) {
      client.disconnect();
      throw err;
    }

    const engine = new PrankEngine(client, { allowedUserIds, userFilter });
    for (const p of pranks) engine.add(p);
    engine.onPrank(e => {
      const who = e.user?.name ?? 'someone';
      const what = e.edits.map(x => x.type === 'insert' ? `+${JSON.stringify(x.text)}` : `-${x.length}`).join(' ');
      ctx.info(`${c('dim', new Date().toLocaleTimeString())} ${c('magenta', e.prank)} ${who}: ${what}`);
    });
    engine.start();

    const targets = [
      ...allowedUserIds.map(id => `user id ${id}`),
      ...(userFilter ? [`names matching /${filter}/`] : []),
    ];
    ctx.info(`${c('green', '✓ Pranking')} ${targets.length ? targets.join(', ') : 'everyone'} ` +
      c('dim', `with ${engine.list().join(', ')} (Ctrl+C stops)`));

    await new Promise<void>((resolve) => {
      const stop = async () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        engine.stop();
        await client.flush().catch(() => undefined);
        client.disconnect();
        resolve();
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      client.on('delete', stop);
    });
  },
};
