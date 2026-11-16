/**
 * share: keep a local file and a note in sync, both ways, until Ctrl+C.
 *
 *   hedgesync share <file> [<server-url>]   new note from the file
 *   hedgesync share <file> <note-url>       join a shared note into the file
 *
 * Any editor works: saves go to the note, others' edits are written into the
 * file (editors that reload changed files show them). Each side's changes
 * since the last sync are merged three-way, so typing on both sides at once
 * keeps both.
 */

import { existsSync, readFileSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { HEDGEDOC1_PERMISSIONS } from '../../drivers/hedgedoc1.js';
import type { HedgeDocClient } from '../../hedgedoc-client.js';
import { mergeText } from '../../mirror.js';
import { buildNoteUrl, parseNoteUrl } from '../../url.js';
import { connectionOptions, readOnlyReason, type Command, type Context } from '../context.js';
import { listStoredSessions } from '../cookie-store.js';
import { CliError, c, print } from '../ui.js';
import { serverOnly } from './edit.js';

const USAGE = 'hedgesync share <file> [<server-url> | <note-url>] [--permission <p>]';

/**
 * The note holds the text without the file's final newline, like a buffer
 * in the Neovim plugin, so Neovim guests do not see an extra empty line.
 */
export function noteText(fileText: string): string {
  return fileText.endsWith('\n') ? fileText.slice(0, -1) : fileText;
}

/** Where a file and a note last agreed, and how to merge either side's changes. */
export class FileNoteSync {
  /** The last text both sides had, in note form. */
  base: string;

  constructor(
    private readonly read: () => string | null,
    private readonly write: (text: string) => void,
    private readonly note: { get(): string; set(text: string): void },
    base: string,
    /** Whether the file ends with a newline the note does not have. */
    private readonly newline = true,
  ) {
    this.base = base;
  }

  private toFile(text: string): string {
    return this.newline ? `${text}\n` : text;
  }

  /** Merge both sides' changes since the last sync into both. */
  sync(): void {
    const raw = this.read();
    if (raw === null) return; // mid-save
    const mine = this.newline ? noteText(raw) : raw;
    const theirs = this.note.get();
    if (mine === this.base && theirs === this.base) return;
    const merged = mine === this.base ? theirs : theirs === this.base ? mine : mergeText(this.base, mine, theirs);
    if (merged !== theirs) this.note.set(merged);
    if (merged !== mine) this.write(this.toFile(merged));
    this.base = merged;
  }
}

/** The server of the only saved login. */
export function defaultServer(usage: string = USAGE): string {
  const saved = listStoredSessions().map(([server]) => server);
  if (saved.length === 1) return saved[0];
  throw new CliError(saved.length ? 'Which server?' : 'Which server? (no saved login)',
    saved.length ? `Saved logins: ${saved.join(', ')}. Usage: ${usage}` : `Usage: ${usage}`);
}

/** Create a note with `text` (and --permission, if given); returns its URL. */
export async function createNote(ctx: Context, server: string, text: string): Promise<string> {
  const permission = ctx.str('permission')?.toLowerCase();
  if (permission && !(HEDGEDOC1_PERMISSIONS as readonly string[]).includes(permission)) {
    throw new CliError(`Invalid permission '${permission}'`, `One of: ${HEDGEDOC1_PERMISSIONS.join(', ')}`);
  }
  // An empty body would get the server's new-note template.
  const id = await ctx.api(server).createNote(text === '' ? '\n' : text);
  const url = buildNoteUrl(server, id);
  if (permission) {
    const client = await ctx.connectTo(server, id);
    try {
      await client.setPermission(permission);
    } finally {
      client.disconnect();
    }
  }
  return url;
}

export const share: Command = {
  name: 'share',
  summary: 'Keep a local file and a note in sync (share a file live)',
  options: [...connectionOptions, { name: 'permission', short: 'p', type: 'value' }, { name: 'force', short: 'f', type: 'flag' }],
  help: () => `
${c('bold', 'hedgesync share')} - Keep a local file and a note in sync

${c('yellow', 'USAGE:')}
  hedgesync share <file> [<server-url>]   Share the file as a new note
  hedgesync share <file> <note-url>       Join a shared note into the file

Runs until Ctrl+C. Saving the file sends your changes; others' changes are
written into the file (most editors reload it, or offer to). Changes made on
both sides at once are merged, keeping both.

People join from the printed link: in a browser, with ${c('cyan', 'hedgesync edit')} or
${c('cyan', ':Hedge open')} in Neovim (which takes the filetype from the link), or with
${c('cyan', 'hedgesync share <their-file> <link>')}. In Neovim, ${c('cyan', ':Hedge share')} shares the
buffer you are in without a separate process.

Without a server, the one you have a saved login for is used. Joining
replaces the file's content with the note's (an existing, different file
needs --force).

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-p, --permission')} <p>  Permission of the new note (freely, editable, limited, ...)
  ${c('cyan', '-f, --force')}           Join even if the file exists with other content

${c('yellow', 'EXAMPLES:')}
  hedgesync share main.go
  hedgesync share notes.txt https://md.example.com -p freely
  hedgesync share main.go https://md.example.com/abc123
`,
  async run(ctx) {
    const file = resolve(ctx.need(0, 'File', USAGE));
    const target = ctx.positional[1];
    const server = target === undefined ? defaultServer() : serverOnly(target);
    const fileText = existsSync(file) ? readFileSync(file, 'utf8') : null;

    let url: string;
    if (server !== undefined) {
      if (fileText === null) throw new CliError(`No such file: ${file}`, 'To join a note into a new file, pass the note URL.');
      url = await createNote(ctx, server, noteText(fileText));
    } else {
      try {
        parseNoteUrl(target!);
      } catch {
        throw new CliError(`Not a server or note URL: ${target}`, `Usage: ${USAGE}`);
      }
      url = target!.replace(/[?#].*$/, '');
    }
    const { serverUrl, noteId } = parseNoteUrl(url);
    const client: HedgeDocClient = await ctx.connectTo(serverUrl, noteId);
    try {
      const doc = client.getDocument();
      if (server === undefined) {
        // Joining: the file becomes the note.
        if (fileText !== null && fileText !== '' && noteText(fileText) !== doc && !ctx.flag('force')) {
          throw new CliError(`${file} exists with other content`, 'Pass --force to replace it with the note\'s text, or pick a new file.');
        }
        writeFileSync(file, `${doc}\n`);
      }
      if (!client.canEdit()) {
        const reason = readOnlyReason(client.getNoteInfo().permission, client.serverUrl);
        ctx.warn(`Read-only, your changes will not be sent${reason ? `: ${reason}` : ''}`);
      }

      const sync = new FileNoteSync(
        () => {
          try {
            return readFileSync(file, 'utf8');
          } catch {
            return null;
          }
        },
        (text) => writeFileSync(file, text),
        { get: () => client.getDocument(), set: (text) => client.canEdit() && client.updateContent(text) },
        client.getDocument(),
      );
      const safeSync = () => {
        try {
          sync.sync();
        } catch (err) {
          ctx.warn(`Sync failed: ${(err as Error).message}`);
        }
      };
      // Poll by path: editors that save by renaming defeat fs.watch.
      watchFile(file, { interval: 250 }, safeSync);
      let timer: ReturnType<typeof setTimeout> | undefined;
      client.on('document', () => {
        clearTimeout(timer);
        timer = setTimeout(safeSync, 150); // one write per burst of typing
      });

      const link = `${url}?edit`;
      ctx.result({ action: 'share', file, url, link }, () => {
        print(link);
        ctx.info(c('green', `✓ Sharing ${basename(file)}`) + c('dim', ' — others join from the link above; Ctrl+C stops'));
      });

      await new Promise<void>((done) => {
        process.once('SIGINT', done);
        process.once('SIGTERM', done);
        client.on('disconnect', () => {
          if (ctx.flag('no-reconnect')) done();
          else ctx.warn('Connection lost; reconnecting (file changes are sent once back)');
        });
        client.on('reconnect:failed', () => {
          ctx.warn('Reconnecting failed; stopped syncing');
          done();
        });
        client.on('delete', () => {
          ctx.warn('The note was deleted; stopped syncing');
          done();
        });
      });
      unwatchFile(file);
      clearTimeout(timer);
      safeSync(); // a save in the last moments
      await client.flush();
      ctx.info(c('dim', 'Stopped sharing; the file stays as it is.'));
    } finally {
      client.disconnect();
    }
  },
};
