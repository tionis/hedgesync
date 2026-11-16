/**
 * clip: a private note as a clipboard across devices.
 *
 *   hedgesync clip setup [<server>]     create the note (private) and remember it
 *   echo hi | hedgesync clip            copy (stdin, or text arguments)
 *   hedgesync clip                      paste (on a terminal)
 *   hedgesync clip watch --to-clipboard keep the system clipboard current
 *
 * On a phone the note is just a page in the browser: copy from it, or write
 * a new entry. Entries are kept newest first (see src/clip-note.ts).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { addClipEntry, CLIP_TEMPLATE, clipImage, clipLabel, parseClipNote } from '../../clip-note.js';
import type { HedgeDocClient } from '../../hedgedoc-client.js';
import { hasImage, isConcealed, systemClipboard } from '../../system-clipboard.js';
import { buildNoteUrl, parseNoteUrl } from '../../url.js';
import { assertEditable, connectionOptions, readStdin, type Command, type Context } from '../context.js';
import { cookieStorePath } from '../cookie-store.js';
import { CliError, c, print } from '../ui.js';
import { serverOnly } from './edit.js';
import { defaultServer } from './share.js';

const USAGE = 'hedgesync clip [copy [text...] | paste [n] | list | watch | setup [<server>] | url]';

/** Where the clipboard note's URL is remembered. */
export function clipConfigPath(): string {
  return join(dirname(cookieStorePath()), 'clip.json');
}

function clipNote(): string {
  if (process.env.HEDGESYNC_CLIP_NOTE) return process.env.HEDGESYNC_CLIP_NOTE;
  try {
    const { url } = JSON.parse(readFileSync(clipConfigPath(), 'utf8')) as { url?: string };
    if (url) return url;
  } catch {
    // Not set up.
  }
  throw new CliError('No clipboard note yet', 'Run: hedgesync clip setup [<server>] (or set HEDGESYNC_CLIP_NOTE)');
}

async function connect(ctx: Context): Promise<HedgeDocClient> {
  const { serverUrl, noteId } = parseNoteUrl(clipNote());
  return ctx.connectTo(serverUrl, noteId);
}

async function readStdinBytes(): Promise<Buffer> {
  if (process.stdin.isTTY) throw new CliError('No image on stdin', 'Usage: hedgesync clip copy --image <file | ->');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const device = () => hostname().split('.')[0] || 'this device';

/** Strip one final newline, the one `echo` and most commands add. */
const chomp = (s: string) => s.replace(/\r?\n$/, '');

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Upload an image to the clipboard note's server; returns the entry text. */
async function uploadImage(ctx: Context, data: Buffer, name: string): Promise<string> {
  const { serverUrl } = parseNoteUrl(clipNote());
  const url = await ctx.api(serverUrl).uploadImage(data, name.endsWith('.png') || /\.\w+$/.test(name) ? name : `${name}.png`);
  return `![${name.replace(/\.\w+$/, '').replace(/[[\]]/g, '')}](${url})`;
}

/** Fetch an image entry's bytes (relative links resolve against the server). */
async function downloadImage(url: string): Promise<Buffer> {
  const absolute = new URL(url, parseNoteUrl(clipNote()).serverUrl).toString();
  const res = await fetch(absolute);
  if (!res.ok) throw new CliError(`Could not download ${absolute}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function copy(ctx: Context, text: string, options: { raw?: boolean } = {}): Promise<void> {
  if (text === '') throw new CliError('Nothing to copy');
  const client = await connect(ctx);
  try {
    assertEditable(client);
    client.updateContent(addClipEntry(client.getDocument(), text, clipLabel(device()), ctx.int('keep', 50), options));
    await client.flush();
  } finally {
    client.disconnect();
  }
  ctx.result({ action: 'copy', length: text.length }, () => ctx.info(c('green', `✓ Copied (${text.length} characters)`)));
}

async function watch(ctx: Context): Promise<void> {
  const toClipboard = ctx.flag('to-clipboard');
  const fromClipboard = ctx.flag('from-clipboard');
  if (!toClipboard && !fromClipboard) {
    throw new CliError('Which direction?', 'Pass --to-clipboard (note → this machine), --from-clipboard (this machine → note), or both.');
  }
  const system = systemClipboard();
  if (!system) {
    throw new CliError('No clipboard tool found', 'Install wl-clipboard (Wayland) or xclip (X11), or set HEDGESYNC_CLIP_COPY_CMD / HEDGESYNC_CLIP_PASTE_CMD.');
  }
  if (fromClipboard && system.types() === null) {
    ctx.warn(`${system.name} cannot list the clipboard's content types, so entries password managers mark as secret are not recognised and will be copied to the note too.`);
  }
  const client = await connect(ctx);
  if (fromClipboard) assertEditable(client);
  const keep = ctx.int('keep', 50);
  const newest = () => parseClipNote(client.getDocument())[0]?.text;
  let lastNote = newest();
  let lastSystem = system.paste();
  // The image on the clipboard at start, so it is not uploaded right away.
  const imageNow = () => (system.pasteImage && !system.paste()?.trim() && hasImage(system.types() ?? ['image/png']) ? system.pasteImage() : null);
  let lastImage: string | undefined;
  if (fromClipboard) {
    const png = imageNow();
    if (png) lastImage = sha(png);
  }
  let uploading = false;
  let echoImage = false;
  const log = (msg: string) => ctx.info(`${c('dim', new Date().toLocaleTimeString())} ${msg}`);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const onChange = () => {
    clearTimeout(timer);
    // Wait for typing on the phone to pause.
    timer = setTimeout(() => {
      const text = newest();
      if (text === undefined || text === lastNote) return;
      lastNote = text;
      if (!toClipboard || text === lastSystem) return;
      const image = clipImage(text);
      if (image && system.copyImage) {
        void downloadImage(image.url).then((png) => {
          system.copyImage!(png);
          lastImage = sha(png);
          // The clipboard may hand it back re-encoded: don't take that for a new image.
          echoImage = true;
          log(`note → clipboard (image, ${png.length} bytes)`);
        }).catch((err: Error) => ctx.warn(err.message));
        return;
      }
      try {
        system.copy(text);
        lastSystem = text;
        log(`note → clipboard (${text.length} characters)`);
      } catch (err) {
        ctx.warn((err as Error).message);
      }
    }, 800);
  };
  client.on('change', onChange);

  const poll = fromClipboard
    ? setInterval(() => {
      const text = system.paste();
      if (!text?.trim() && system.pasteImage && !uploading) {
        // No text: maybe an image (a screenshot).
        const png = imageNow();
        if (png && sha(png) === lastImage) echoImage = false; // handed back unchanged
        if (png && sha(png) !== lastImage) {
          lastImage = sha(png);
          if (echoImage) {
            echoImage = false;
            return;
          }
          if (isConcealed(system.types() ?? [])) return;
          uploading = true;
          void uploadImage(ctx, png, `clipboard-${clipLabel(device()).slice(0, 16).replace(/[ :]/g, '-')}.png`).then((entry) => {
            lastNote = entry;
            client.updateContent(addClipEntry(client.getDocument(), entry, clipLabel(device()), keep, { raw: true }));
            log(`clipboard → note (image, ${png.length} bytes)`);
          }).catch((err: Error) => ctx.warn(`Image upload failed: ${err.message}`)).finally(() => { uploading = false; });
        }
      }
      if (text === null || text === lastSystem) return;
      lastSystem = text;
      if (!text.trim() || text === lastNote) return;
      if (isConcealed(system.types() ?? [])) {
        log('skipped a secret (marked by a password manager)');
        return;
      }
      lastNote = text;
      client.updateContent(addClipEntry(client.getDocument(), text, clipLabel(device()), keep));
      log(`clipboard → note (${text.length} characters)`);
    }, Math.max(250, ctx.int('interval', 1000)))
    : undefined;

  ctx.info(`${c('cyan', 'Watching')} ${clipNote()} ${c('dim', `(${[toClipboard && 'note → clipboard', fromClipboard && 'clipboard → note'].filter(Boolean).join(', ')}; ${system.name}; Ctrl+C stops)`)}`);
  await new Promise<void>((resolve) => {
    const stop = async () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      clearInterval(poll);
      clearTimeout(timer);
      await client.flush().catch(() => undefined);
      client.disconnect();
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    client.on('delete', stop);
  });
}

export const clip: Command = {
  name: 'clip',
  summary: 'A private note as a clipboard across devices',
  options: [
    ...connectionOptions,
    { name: 'keep', type: 'value' },
    { name: 'to-clipboard', type: 'flag' },
    { name: 'from-clipboard', type: 'flag' },
    { name: 'interval', type: 'value' },
    { name: 'note', type: 'value' },
    { name: 'force', short: 'f', type: 'flag' },
    { name: 'image', short: 'i', type: 'value' },
    { name: 'output', short: 'o', type: 'value' },
  ],
  help: () => `
${c('bold', 'hedgesync clip')} - A private note as a clipboard across devices

${c('yellow', 'USAGE:')}
  hedgesync clip setup [<server-url>]   Create the clipboard note (private) and remember it
  hedgesync clip setup --note <url>     Use an existing note instead
  hedgesync clip [copy] [text...]       Copy text (or stdin) into the note
  hedgesync clip copy --image <file|->   Copy an image (uploaded to the server)
  hedgesync clip [paste] [n] [-o <file>] Print the newest entry (or the n-th)
  hedgesync clip list                   List the entries
  hedgesync clip url                    Print the note's URL
  hedgesync clip watch --to-clipboard [--from-clipboard]

Without a subcommand, clip copies what is piped in, and pastes on a
terminal. Entries are kept newest first, each under a heading with time and
device, the text in a code block. On another device, open the note in a
browser to copy from it, or write a new entry at the top (a ## heading and
the text below it), and paste it here.

watch keeps the system clipboard current: --to-clipboard copies new
entries to this machine's clipboard, --from-clipboard adds what you copy
here to the note, skipping entries password managers mark as secret
(KeePassXC, 1Password, Bitwarden and others set such a mark). Tools:
wl-copy/wl-paste or xclip (Linux), pbcopy/pbpaste (macOS), PowerShell
(Windows), xsel (which cannot see the mark, so nothing is skipped);
HEDGESYNC_CLIP_COPY_CMD, HEDGESYNC_CLIP_PASTE_CMD and
HEDGESYNC_CLIP_TYPES_CMD override them.

The note is created private (only you, signed in, can read it); setup needs
a saved login for that. HEDGESYNC_CLIP_NOTE overrides the remembered note.

Images are uploaded to the HedgeDoc server and shown in the note. Pasting an
image entry writes the image to -o <file>, or to stdout when it is piped
(hedgesync clip > shot.png); on a terminal it prints the link. watch moves
images too: a screenshot copied here goes to the note, an image entry from
elsewhere onto this clipboard (where the tool supports images: wl-clipboard,
xclip, macOS, Windows).

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-i, --image <file|->')} copy: an image file (- for stdin) instead of text
  ${c('cyan', '-o, --output <file>')}  paste: write the entry (an image's bytes) to a file
  ${c('cyan', '--keep <n>')}       Keep at most n entries (default 50)
  ${c('cyan', '--interval <ms>')}  How often watch --from-clipboard looks (default 1000)
  ${c('cyan', '--note <url>')}     setup: use this note
  ${c('cyan', '-f, --force')}      setup: replace the remembered note
`,
  async run(ctx) {
    const subs = ['copy', 'paste', 'list', 'watch', 'setup', 'url'];
    const first = ctx.positional[0];
    const sub = first && subs.includes(first) ? first : undefined;
    const rest = sub ? ctx.positional.slice(1) : ctx.positional;
    const action = sub ?? (rest.length || !process.stdin.isTTY ? 'copy' : 'paste');

    switch (action) {
      case 'setup': {
        const path = clipConfigPath();
        if (existsSync(path) && !ctx.flag('force')) {
          throw new CliError(`Already set up: ${clipNote()}`, 'Pass --force to replace it (the old note stays).');
        }
        let url = ctx.str('note');
        if (url) {
          const { serverUrl, noteId } = parseNoteUrl(url);
          url = buildNoteUrl(serverUrl, noteId);
        } else {
          const server = rest[0] ? serverOnly(rest[0]) : defaultServer('hedgesync clip setup <server-url>');
          if (!server) throw new CliError(`Not a server URL: ${rest[0]}`, 'Usage: hedgesync clip setup [<server-url>]');
          const id = await ctx.api(server).createNote(CLIP_TEMPLATE);
          url = buildNoteUrl(server, id);
          const client = await ctx.connectTo(server, id);
          try {
            await client.setPermission('private');
          } catch (err) {
            ctx.warn(`Could not make it private (${(err as Error).message}); anyone with the link can read it.`
              + ' Log in (hedgesync login <server> --save) and set it: hedgesync permission <url> private');
          } finally {
            client.disconnect();
          }
        }
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ url }, null, 2) + '\n', { mode: 0o600 });
        ctx.result({ action: 'setup', url }, () => {
          ctx.info(c('green', '✓ Clipboard note ready'));
          print(url!);
        });
        return;
      }
      case 'url':
        ctx.result({ url: clipNote() }, () => print(clipNote()));
        return;
      case 'copy': {
        const image = ctx.str('image');
        if (image) {
          const data = image === '-' ? await readStdinBytes() : readFileSync(image);
          if (!data.length) throw new CliError('The image is empty');
          await copy(ctx, await uploadImage(ctx, data, image === '-' ? 'image.png' : basename(image)), { raw: true });
          return;
        }
        const text = rest.length ? rest.join(' ') : chomp(await readStdin(`Usage: ${USAGE}`));
        await copy(ctx, text);
        return;
      }
      case 'paste':
      case 'list': {
        const client = await connect(ctx);
        const entries = parseClipNote(client.getDocument());
        client.disconnect();
        if (action === 'list') {
          ctx.result({ entries: entries.map(({ label, text }) => ({ label, text })) }, () => {
            if (!entries.length) ctx.info('No entries yet.');
            entries.forEach((e, i) => {
              const preview = e.text.split('\n')[0].slice(0, 60);
              print(`${c('cyan', String(i + 1).padStart(2))} ${c('dim', e.label)}  ${preview}${e.text.includes('\n') || e.text.length > 60 ? c('dim', ' …') : ''}`);
            });
          });
          return;
        }
        const n = rest[0] ? Number(rest[0]) : 1;
        if (!Number.isInteger(n) || n < 1) throw new CliError(`Not an entry number: ${rest[0]}`);
        const entry = entries[n - 1];
        if (!entry) throw new CliError(entries.length ? `There are only ${entries.length} entries` : 'The clipboard note is empty');
        const image = clipImage(entry.text);
        const output = ctx.str('output');
        // An image goes to a file, or to stdout when that is not a terminal (hedgesync clip > shot.png).
        if (image && (output || (!process.stdout.isTTY && !ctx.json))) {
          const png = await downloadImage(image.url);
          if (output) {
            writeFileSync(output, png);
            ctx.info(c('green', `✓ Saved ${output} (${png.length} bytes)`));
          } else {
            process.stdout.write(png);
          }
          return;
        }
        if (output) writeFileSync(output, entry.text.endsWith('\n') ? entry.text : entry.text + '\n');
        ctx.result({ label: entry.label, text: entry.text, ...(image ? { image: image.url } : {}) }, () => {
          if (!output) process.stdout.write(entry.text + (entry.text.endsWith('\n') ? '' : '\n'));
        });
        return;
      }
      case 'watch':
        await watch(ctx);
        return;
    }
  },
};
