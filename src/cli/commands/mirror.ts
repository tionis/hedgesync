/**
 * mirror: keep a target note in sync with a source note.
 */

import type { HedgeDocClient } from '../../hedgedoc-client.js';
import { NoteMirror, createMirrorTransform } from '../../mirror.js';
import { createFilter } from '../../note-filter.js';
import { parseNoteUrl } from '../../url.js';
import { assertEditable, connectionOptions, type Command, type Context } from '../context.js';
import { helpText } from '../help-text.js';
import { CliError, c, eprint, printJsonLine } from '../ui.js';

export const mirror: Command = {
  name: 'mirror',
  summary: 'Sync two documents in real time',
  options: [
    ...connectionOptions,
    { name: 'bidirectional', type: 'flag' },
    { name: 'source-cookie', type: 'value' },
    { name: 'target-cookie', type: 'value' },
    { name: 'demote', type: 'flag' },
    { name: 'promote', type: 'flag' },
    { name: 'shift', type: 'value' },
    { name: 'prepend', type: 'value' },
    { name: 'append', type: 'value' },
    { name: 'wrap-prefix', type: 'value' },
    { name: 'wrap-suffix', type: 'value' },
    { name: 'strip', type: 'multi' },
    { name: 'only', type: 'multi' },
    { name: 'strip-heading', type: 'multi' },
    { name: 'replace', type: 'multi' },
    { name: 'filter', type: 'multi' },
  ],
  help: helpText.mirror,
  async run(ctx) {
    const usage = 'hedgesync mirror <source-url> <target-url> [options]';
    const sourceUrl = ctx.need(0, 'Source URL', usage);
    const targetUrl = ctx.need(1, 'Target URL', usage);
    const source = parseUrl(sourceUrl, 'source');
    const target = parseUrl(targetUrl, 'target');
    const bidirectional = ctx.flag('bidirectional');

    const headingShift = ctx.flag('demote') ? 1 : ctx.flag('promote') ? -1 : ctx.int('shift', 0);
    const transform = createMirrorTransform({
      headingShift,
      prepend: ctx.str('prepend'),
      append: ctx.str('append'),
      wrapPrefix: ctx.str('wrap-prefix'),
      wrapSuffix: ctx.str('wrap-suffix'),
    });
    let filter: ((text: string) => string) | undefined;
    try {
      filter = createFilter({
        strip: ctx.list('strip'),
        only: ctx.list('only'),
        stripHeading: ctx.list('strip-heading'),
        replace: ctx.list('replace'),
        filter: ctx.list('filter'),
      });
    } catch (err) {
      throw new CliError((err as Error).message);
    }
    // Filters first (they look for markers and headings as written), then the layout transforms.
    const transformAll = filter && transform ? (t: string) => transform(filter(t)) : filter ?? transform;
    if (transformAll && bidirectional) {
      throw new CliError('Transforms and filters only work one-way; drop --bidirectional or those options');
    }

    const log = (event: string, data: Record<string, unknown> = {}) => {
      if (ctx.json) {
        printJsonLine({ event, timestamp: new Date().toISOString(), ...data });
      } else if (!ctx.quiet) {
        const fields = Object.entries(data).map(([k, v]) => `${c('yellow', k)}=${v}`).join(' ');
        eprint(`${c('dim', `[${new Date().toISOString()}]`)} ${c('cyan', event)} ${fields}`);
      }
    };

    ctx.info(`${c('cyan', 'Source:')} ${sourceUrl}`);
    ctx.info(`${c('cyan', 'Target:')} ${targetUrl}`);
    ctx.info(`${c('cyan', 'Mode:')} ${bidirectional ? 'bidirectional' : 'one-way (source → target)'}${filter ? ', filtered' : ''}${transform ? ', with transform' : ''}`);

    const sourceClient = await connectWithCookie(ctx, source, ctx.str('source-cookie'));
    let targetClient: HedgeDocClient;
    try {
      targetClient = await connectWithCookie(ctx, target, ctx.str('target-cookie'));
    } catch (err) {
      sourceClient.disconnect();
      throw err;
    }
    const clients = [sourceClient, targetClient];

    try {
      assertEditable(targetClient);
      if (bidirectional) assertEditable(sourceClient);
    } catch (err) {
      clients.forEach(cl => cl.disconnect());
      throw err;
    }

    if (filter) {
      const warning = audienceWarning(sourceClient.getNoteInfo().permission, targetClient.getNoteInfo().permission);
      if (warning) ctx.warn(warning);
    }
    // With a filter, wait for typing to pause: a marker half typed is not yet a marker.
    const noteMirror = new NoteMirror(sourceClient, targetClient, { bidirectional, transform: transformAll, debounceMs: filter ? 1000 : undefined });
    noteMirror.on('sync', e => log(e.merged ? 'merge' : 'sync', { direction: e.direction, length: e.length }));
    noteMirror.on('error', (err: Error) => log('error', { message: err.message }));
    for (const [name, client] of [['source', sourceClient], ['target', targetClient]] as const) {
      client.on('disconnect', (reason: string) => log('disconnect', { document: name, reason }));
      client.on('reconnect:success', () => log('reconnect', { document: name }));
      client.on('resync', (outcome: { kind: string }) => log('resync', { document: name, outcome: outcome.kind }));
    }

    const initial = noteMirror.start();
    if (initial) log('initial-sync', { direction: initial.direction, length: initial.length });
    log('ready', { mode: bidirectional ? 'bidirectional' : 'one-way' });
    ctx.info(c('dim', 'Press Ctrl+C to stop'));

    await new Promise<void>((resolve) => {
      const stop = async () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        try {
          await noteMirror.flush(5000);
        } catch {
          // Leaving anyway.
        }
        noteMirror.stop();
        clients.forEach(cl => cl.disconnect());
        ctx.info(c('cyan', 'Mirror stopped.'));
        resolve();
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
  },
};

function parseUrl(url: string, which: string) {
  try {
    return parseNoteUrl(url);
  } catch (err) {
    throw new CliError(`Invalid ${which} URL: ${(err as Error).message}`);
  }
}

function connectWithCookie(ctx: Context, note: { serverUrl: string; noteId: string }, cookie: string | undefined) {
  return ctx.connectTo(note.serverUrl, note.noteId, cookie ? { cookie } : {});
}

/** Who can read a note: 0 owner only, 1 signed-in users, 2 anyone with the link. */
function readers(permission: string | undefined): number {
  if (permission === 'private') return 0;
  if (permission === 'limited' || permission === 'protected') return 1;
  return 2;
}

/** Filtering hides nothing if the source is readable by the target's audience anyway. */
export function audienceWarning(source: string | undefined, target: string | undefined): string | undefined {
  if (readers(source) === 0 || readers(source) < readers(target)) return undefined;
  return `The source note (${source || 'unknown permission'}) is readable by everyone who can read the target (${target || 'unknown'}): `
    + 'filtering hides nothing from them. Restrict the source (hedgesync permission <url> private).';
}
