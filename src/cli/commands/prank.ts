/**
 * prank: mess with whoever is typing in a note (see src/prank/).
 */

import {
  PrankEngine, bombs, deny, echo, fatFingers, ghostTypist, hauntedUndo, homoglyphs, keyboardLayouts,
  rulesKeeper, stickyCaps, stutter, transposer, userMatcher, type KeyboardLayout, type Prank, type PrankEvent,
} from '../../prank/index.js';
import { agentFromOptions, agentOptions, seconds } from '../agent-options.js';
import { assertEditable, connectionOptions, type Command, type Context } from '../context.js';
import { helpText } from '../help-text.js';
import { CliError, c } from '../ui.js';

/** "30" or "30%" to a probability in 0..1. */
export function parsePercent(value: string, option: string): number {
  const n = Number(value.trim().replace(/%$/, ''));
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new CliError(`${option} must be a percentage between 0 and 100, got '${value}'`);
  }
  return n / 100;
}

/** Percent-valued pranks: option name -> constructor. */
const CHANCE_PRANKS: Record<string, (probability: number, ctx: Context) => Prank> = {
  stutter: (probability, ctx) => stutter({ probability, deletes: ctx.flag('stutter-deletes') }),
  'fat-fingers': (probability, ctx) => {
    const layout = (ctx.str('keyboard') ?? 'qwerty') as KeyboardLayout;
    if (!keyboardLayouts.includes(layout)) {
      throw new CliError(`Unknown --keyboard '${layout}'`, `One of: ${keyboardLayouts.join(', ')}`);
    }
    return fatFingers({ probability, layout });
  },
  transpose: (probability) => transposer({ probability }),
  'sticky-caps': (probability) => stickyCaps({ probability }),
  echo: (probability) => echo({ probability }),
  homoglyphs: (probability) => homoglyphs({ probability }),
  haunt: (probability) => hauntedUndo({ probability }),
  bombs: (probability, ctx) => bombs({
    probability,
    fuseSeconds: seconds(ctx.str('fuse'), 15, '--fuse'),
    radius: ctx.int('blast', 25),
  }),
};

export const prank: Command = {
  name: 'prank',
  summary: 'Annoy people typing in a note (typos, bombs, a ghost, an AI enforcing rules, ...)',
  options: [
    ...connectionOptions,
    ...Object.keys(CHANCE_PRANKS).map(name => ({ name, type: 'value' as const })),
    { name: 'stutter-deletes', type: 'flag' },
    { name: 'keyboard', type: 'value' },
    { name: 'fuse', type: 'value' },
    { name: 'blast', type: 'value' },
    { name: 'ghost', type: 'value' },
    { name: 'ghost-message', type: 'multi' },
    { name: 'deny', type: 'multi' },
    { name: 'rule', type: 'multi' },
    ...agentOptions,
    { name: 'settle', type: 'value' },
    { name: 'allow-user', type: 'multi' },
    { name: 'user-filter', short: 'U', type: 'value' },
  ],
  help: helpText.prank,
  async run(ctx) {
    const usage = 'hedgesync prank <url> --stutter 10 [more pranks] [options]';
    const pranks: Prank[] = [];
    for (const [name, make] of Object.entries(CHANCE_PRANKS)) {
      const value = ctx.str(name);
      if (value !== undefined) pranks.push(make(parsePercent(value, `--${name}`), ctx));
    }
    const needs = (option: string, prankOption: string) => {
      if ((ctx.str(option) !== undefined || ctx.flag(option) || ctx.list(option).length > 0) && ctx.str(prankOption) === undefined) {
        throw new CliError(`--${option} goes with --${prankOption}`);
      }
    };
    needs('stutter-deletes', 'stutter');
    needs('keyboard', 'fat-fingers');
    needs('fuse', 'bombs');
    needs('blast', 'bombs');
    needs('ghost-message', 'ghost');

    const ghost = ctx.str('ghost');
    if (ghost !== undefined) {
      const messages = ctx.list('ghost-message');
      pranks.push(ghostTypist({
        everySeconds: seconds(ghost, 60, '--ghost'),
        messages: messages.length ? messages : undefined,
      }));
    }

    const denied = ctx.list('deny');
    if (denied.length) pranks.push(deny({ targets: userMatcher(denied) }));

    const rules = ctx.list('rule');
    let agentDescription: string | undefined;
    if (rules.length) {
      const { agent, described } = agentFromOptions(ctx, usage, 60);
      agentDescription = described;
      pranks.push(rulesKeeper({
        rules, agent, url: ctx.positional[0],
        settleMs: seconds(ctx.str('settle'), 1.5, '--settle') * 1000,
      }));
    } else if (ctx.str('agent') !== undefined || ctx.str('api') !== undefined) {
      throw new CliError('--agent and --api go with --rule');
    }

    if (pranks.length === 0) throw new CliError('No prank chosen', `Try: ${usage}`);

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
    engine.onPrank(e => ctx.info(`${c('dim', new Date().toLocaleTimeString())} ${c('magenta', e.prank)} ${describe(e)}`));
    engine.start();

    const targets = [
      ...allowedUserIds.map(id => `user id ${id}`),
      ...(userFilter ? [`names matching /${filter}/`] : []),
    ];
    ctx.info(`${c('green', '✓ Pranking')} ${targets.length ? targets.join(', ') : 'everyone'} `
      + c('dim', `with ${engine.list().join(', ')} (Ctrl+C stops)`));
    if (denied.length) ctx.info(c('dim', `  Denying edits by: ${denied.join(', ')}`));
    if (agentDescription) ctx.info(c('dim', `  Rules enforced by ${agentDescription}: ${rules.join('; ')}`));

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

function describe(e: PrankEvent): string {
  const who = e.user?.name ? `${e.user.name}: ` : '';
  if (e.message) return who + e.message;
  const edits = (e.edits ?? []).map(x => x.type === 'insert' ? `+${JSON.stringify(x.text)}` : `-${x.length}`).join(' ');
  return who + edits;
}
