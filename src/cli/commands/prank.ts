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
    radius: ctx.int('blast', 10),
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
    { name: 'only', type: 'multi' },
    { name: 'except', type: 'multi' },
    { name: 'spare-me', type: 'flag' },
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
      const { agent, described } = agentFromOptions(ctx, usage, {
        timeoutSeconds: 60,
        // Rewrites must be quick; Haiku is plenty for them.
        model: (spec) => spec === 'claude' ? 'haiku' : undefined,
      });
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
    const only = ctx.list('only');
    const except = ctx.list('except');
    for (const spec of [...only, ...except, ...denied]) {
      try {
        new RegExp(spec, 'i');
      } catch {
        // Still usable as an account id; say so, since a name was probably meant.
        ctx.warn(`'${spec}' is not a valid regex, so it only matches the account id '${spec}'`);
      }
    }

    const client = await ctx.connect(0);
    try {
      assertEditable(client);
      if (ctx.flag('spare-me')) {
        const profile = await ctx.api(client.serverUrl, true).getProfile();
        if (profile.status !== 'ok' || !profile.id) {
          throw new CliError('--spare-me needs a login', 'Log in (hedgesync login) or pass --except <your name>');
        }
        except.push(profile.id);
        ctx.info(c('dim', `  Sparing you (${profile.name}, ${profile.id})`));
      }
    } catch (err) {
      client.disconnect();
      throw err;
    }

    const engine = new PrankEngine(client, {
      only: only.length ? only : undefined,
      except: except.length ? except : undefined,
      allowedUserIds,
      userFilter,
    });
    for (const p of pranks) engine.add(p);
    engine.onPrank(e => ctx.info(`${c('dim', new Date().toLocaleTimeString())} ${c('magenta', e.prank)} ${describe(e)}`));
    engine.start();

    const targets = [
      ...only,
      ...allowedUserIds.map(id => `account ${id}`),
      ...(userFilter ? [`names matching /${filter}/`] : []),
    ];
    const pranked = engine.list().filter(n => n !== 'deny');
    if (pranked.length) {
      ctx.info(`${c('green', '✓ Pranking')} ${targets.length ? targets.join(' + ') : 'everyone'}`
        + `${except.length ? ` except ${except.join(', ')}` : ''} `
        + c('dim', `with ${pranked.join(', ')} (Ctrl+C stops)`));
    }
    if (denied.length) {
      ctx.info(`${c('green', '✓ Denying')} edits by ${denied.join(', ')}`
        + `${except.length ? ` except ${except.join(', ')}` : ''} ${c('dim', '(Ctrl+C stops)')}`);
    }
    if (agentDescription) ctx.info(c('dim', `  Rules enforced by ${agentDescription}: ${rules.join('; ')}`));

    // Who is here, so you can pick victims by name or account id next time.
    const online = client.getOnlineUsers().filter(u => u.id !== client.socket?.id);
    if (online.length) {
      ctx.info(c('dim', `  Online: ${online.map(u => {
        const who = engine.isTarget(u) ? c('magenta', u.name ?? '?') : u.name ?? '?';
        return `${who}${u.userid ? ` (${u.userid})` : ''}`;
      }).join(', ')}`));
    }

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
