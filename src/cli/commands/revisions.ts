/**
 * revisions: list, show, diff and restore a note's revisions.
 *
 * HedgeDoc 1 saves a revision of a note periodically while it is edited;
 * /{note}/revision lists them as {time, length}, /{note}/revision/{time}
 * returns one. Restoring is an ordinary edit (so it becomes a new revision
 * itself and can be undone the same way).
 */

import type { HedgeDocAPI, RevisionInfo } from '../../hedgedoc-api.js';
import { diffStat, hunks, diffLines } from '../../line-diff.js';
import { connectionOptions, type Command, type Context } from '../context.js';
import { CliError, c, print } from '../ui.js';

function relative(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  for (const [size, name] of [[31557600, 'year'], [2629800, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']] as const) {
    if (s >= size) {
      const n = Math.floor(s / size);
      return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

/** Revisions, newest first. */
async function listNewestFirst(api: HedgeDocAPI, noteId: string): Promise<RevisionInfo[]> {
  return [...(await api.listRevisions(noteId)).revision].sort((a, b) => b.time - a.time);
}

/**
 * A revision reference: a timestamp in milliseconds (as listed), or an
 * index counted from the newest: 0 / ~0 is the newest, ~1 the one before.
 */
function resolve(ref: string, revisions: RevisionInfo[]): RevisionInfo {
  const m = /^~?(\d+)$/.exec(ref);
  if (!m) throw new CliError(`Invalid revision '${ref}'`, 'Use a timestamp from the list, or ~N for the N-th revision before the newest.');
  const n = Number(m[1]);
  const found = ref.startsWith('~') || n < 1e11 ? revisions[n] : revisions.find(r => r.time === n);
  if (!found) {
    throw new CliError(`No revision ${ref}`, revisions.length ? `This note has ${revisions.length} revision(s); ~0 is the newest.` : 'This note has no revisions yet.');
  }
  return found;
}

const label = (r: RevisionInfo, revisions: RevisionInfo[]) => `~${revisions.indexOf(r)} (${new Date(r.time).toLocaleString()})`;

function printDiff(ctx: Context, from: string, to: string, fromLabel: string, toLabel: string): void {
  const result = hunks(diffLines(from, to));
  if (result.length === 0) {
    ctx.info(c('dim', 'No differences'));
    return;
  }
  print(c('bold', `--- ${fromLabel}`));
  print(c('bold', `+++ ${toLabel}`));
  for (const h of result) {
    print(c('cyan', `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`));
    for (const l of h.lines) print(l.type === '+' ? c('green', '+' + l.text) : l.type === '-' ? c('red', '-' + l.text) : ' ' + l.text);
  }
}

export const revisions: Command = {
  name: 'revisions',
  summary: 'List, show, diff or restore note revisions',
  options: [
    { name: 'output', short: 'o', type: 'value' },
    { name: 'diff', short: 'd', type: 'flag' },
    { name: 'restore', type: 'flag' },
    { name: 'limit', short: 'n', type: 'value' },
    ...connectionOptions,
  ],
  help: () => `
${c('bold', 'hedgesync revisions')} - List, show, diff or restore note revisions

${c('yellow', 'USAGE:')}
  hedgesync revisions <url>                       List revisions, newest first
  hedgesync revisions <url> <rev>                 Print a revision's content
  hedgesync revisions <url> <rev> --diff          Changes from <rev> to the current note
  hedgesync revisions <url> <rev> <rev2> --diff   Changes from <rev> to <rev2>
  hedgesync revisions <url> <rev> --restore       Make the note's content <rev> again

A revision is ${c('cyan', '~N')} (the N-th before the newest; ${c('cyan', '~0')} is the newest) or the
timestamp shown in the list. HedgeDoc saves revisions periodically while a
note is edited, so the newest revision may lag a little behind the note.

--restore applies the difference as one edit, so collaborators' cursors
survive and the restore itself can be undone by restoring again.

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-d, --diff')}         Show a unified diff instead of the content
  ${c('cyan', '--restore')}          Restore the revision (needs edit permission)
  ${c('cyan', '-n, --limit')} <n>    List at most n revisions
  ${c('cyan', '-o, --output')} <f>   Write the revision's content to a file
  ${c('cyan', '--json')}             Output as JSON

${c('yellow', 'EXAMPLES:')}
  hedgesync revisions https://md.example.com/abc
  hedgesync revisions https://md.example.com/abc ~1 --diff
  hedgesync revisions https://md.example.com/abc ~3 --restore
`,
  async run(ctx) {
    const usage = 'hedgesync revisions <url> [rev] [rev2] [--diff|--restore]';
    const { serverUrl, noteId } = ctx.note(0, usage);
    const api = ctx.api(serverUrl);
    const list = await listNewestFirst(api, noteId);
    const [ref, ref2] = ctx.positional.slice(1);

    if (!ref) {
      if (ctx.flag('diff') || ctx.flag('restore')) throw new CliError('Which revision?', `Usage: ${usage}`);
      const limit = ctx.int('limit', 0);
      const shown = limit > 0 ? list.slice(0, limit) : list;
      ctx.result({ action: 'list-revisions', noteId, count: list.length, revisions: shown }, () => {
        if (list.length === 0) {
          print(c('dim', 'No revisions yet'));
          return;
        }
        shown.forEach((rev, i) => {
          const older = list[i + 1];
          const delta = older ? rev.length - older.length : null;
          const deltaText = delta === null ? '' : delta === 0 ? c('dim', '  ±0') : delta > 0 ? c('green', `  +${delta}`) : c('red', `  ${delta}`);
          print(`  ${c('yellow', `~${i}`.padEnd(4))} ${c('cyan', String(rev.time))}  ${new Date(rev.time).toLocaleString().padEnd(22)} ${c('dim', relative(rev.time).padEnd(15))} ${String(rev.length).padStart(7)} chars${deltaText}`);
        });
        if (shown.length < list.length) print(c('dim', `  ... ${list.length - shown.length} older`));
      });
      return;
    }

    const rev = resolve(ref, list);
    const content = (await api.getRevision(noteId, rev.time)).content;

    if (ctx.flag('restore')) {
      if (ref2 || ctx.flag('diff')) throw new CliError('--restore takes one revision and no --diff');
      const stat = await ctx.withClient({ edit: true }, (client) => {
        const before = client.getDocument();
        client.updateContent(content);
        return diffStat(before, content);
      });
      ctx.result({ action: 'restore', noteId, revision: rev.time, ...stat }, () => {
        ctx.info(stat.added || stat.removed
          ? c('green', `✓ Restored ${label(rev, list)}: +${stat.added} -${stat.removed} lines`)
          : c('dim', 'The note already matches that revision'));
      });
      return;
    }

    if (ctx.flag('diff')) {
      let to: string;
      let toLabel: string;
      if (ref2) {
        const rev2 = resolve(ref2, list);
        to = (await api.getRevision(noteId, rev2.time)).content;
        toLabel = label(rev2, list);
      } else {
        to = await api.downloadNote(noteId);
        toLabel = 'current';
      }
      ctx.result({ action: 'diff', noteId, from: rev.time, to: ref2 ? resolve(ref2, list).time : 'current', ...diffStat(content, to),
        hunks: hunks(diffLines(content, to)) }, () => printDiff(ctx, content, to, label(rev, list), toLabel));
      return;
    }

    if (ref2) throw new CliError('A second revision only makes sense with --diff');
    if (ctx.writeOutputFile(content)) {
      ctx.result({ action: 'get-revision', noteId, revision: rev.time, file: ctx.str('output'), length: content.length });
    } else {
      ctx.result({ action: 'get-revision', noteId, revision: rev.time, content }, () => process.stdout.write(content));
    }
  },
};
