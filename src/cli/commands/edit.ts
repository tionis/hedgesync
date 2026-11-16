/**
 * edit: open a note in your editor.
 *
 * - Neovim: live, keystroke-level editing through the bundled plugin
 *   (`nvim -c "Hedge open <url>"`). If the user's config does not load the
 *   plugin, the copy matching this binary is loaded for the session.
 * - Any other editor: the note in a temp file. Every save is merged into the
 *   note (three-way, so concurrent remote edits survive), and once more when
 *   the editor exits.
 * - --new <file>: a new note from a file, edited as above (with others, by
 *   link), and its final text written back to the file. Made for
 *   GIT_EDITOR: writing a commit message together.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HedgeDocClient } from '../../hedgedoc-client.js';
import { mergeText } from '../../mirror.js';
import { parseNoteUrl } from '../../url.js';
import { VERSION } from '../../version.js';
import { assertEditable, connectionOptions, readOnlyReason, type Command, type Context } from '../context.js';
import { helpText } from '../help-text.js';
import { NVIM_PLUGIN_FILES } from '../nvim-plugin.generated.js';
import { CliError, c } from '../ui.js';
import { defaultNvimDir, inspectInstall, installPlugin, lazySpecFile } from './editor.js';
import { createNote, defaultServer, noteText } from './share.js';

/** The editor command line: --editor, $VISUAL, $EDITOR, else nvim. */
export function chooseEditor(option: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return (option || env.VISUAL || env.EDITOR || 'nvim').trim();
}

/** Whether an editor command runs Neovim (by the program's name). */
export function isNeovim(editor: string): boolean {
  const quoted = editor.match(/^(["'])(.*?)\1/);
  const program = quoted ? quoted[2] : editor.split(/\s+/)[0] ?? '';
  return /^nvim(\.exe)?$/i.test(program.split(/[\\/]/).pop() ?? '');
}

/**
 * How to run this very hedgesync: the binary itself when compiled, else the
 * runtime plus the script (bun/node bin/hedgesync.ts, dist/cli/bin.js).
 */
export function selfCommand(argv: string[] = process.argv, execPath: string = process.execPath): string[] {
  const script = argv[1];
  const compiled = !script || script.startsWith('/$bunfs/') || /^[A-Z]:[\\/]~BUN[\\/]/i.test(script);
  return compiled ? [execPath] : [execPath, script];
}

function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = process.platform === 'win32'
    ? env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : env.XDG_CACHE_HOME || join(homedir(), '.cache');
  const hash = createHash('sha256').update(JSON.stringify(NVIM_PLUGIN_FILES)).digest('hex').slice(0, 12);
  return join(base, 'hedgesync', `nvim-plugin-${VERSION}-${hash}`);
}

/**
 * A plugin directory to load if the user's config does not load one: the
 * installed copy (refreshed if it is an unedited copy from another version),
 * else a copy unpacked into the cache.
 */
function pluginDirForSession(ctx: Context): string {
  const installed = inspectInstall(defaultNvimDir());
  if (installed.state === 'current') return installed.dir;
  if (installed.state === 'outdated' && !installed.edited.length && !installed.missing.length) {
    installPlugin(installed.dir, { lazySpecContent: lazySpecFile(installed.dir, true) });
    ctx.info(c('dim', `Updated the installed Neovim plugin to ${VERSION}`));
    return installed.dir;
  }
  if (installed.edited.length || installed.missing.length) {
    // The user changed it; plain Neovim loads it from the package directory anyway.
    ctx.info(c('dim', `Using your locally changed Neovim plugin (hedgesync editor nvim install --force restores it)`));
    return installed.dir;
  }
  const dir = cacheDir();
  if (inspectInstall(dir).state !== 'current') installPlugin(dir, { force: true });
  return dir;
}

/** Run an editor command line with extra arguments, attached to the terminal. */
function runEditor(editor: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = process.platform === 'win32'
      ? spawn(editor, args, { stdio: 'inherit', env, shell: true })
      : spawn('sh', ['-c', `${editor} "$@"`, 'sh', ...args], { stdio: 'inherit', env });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/**
 * Neovim with the plugin: `:Hedge open <url>`, or with no note `:Hedge browse
 * [server]`.
 */
async function editLive(ctx: Context, editor: string, target: { url: string; probe?: boolean } | { browse: string }): Promise<number> {
  if ('url' in target && target.probe !== false) {
    // Fail here, with the CLI's error messages, rather than in an empty editor.
    const probe = await ctx.connect(0);
    const readOnly = probe.canEdit() ? undefined : readOnlyReason(probe.getNoteInfo().permission, probe.serverUrl);
    probe.disconnect();
    if (readOnly) ctx.warn(`Read-only: ${readOnly}`);
  }
  const dir = pluginDirForSession(ctx);
  // After the user's config: load the plugin unless it already did (lazy.nvim
  // resets the runtimepath, so --cmd would be too early).
  const load = `lua if vim.fn.exists(':Hedge') ~= 2 then vim.opt.rtp:prepend(${luaString(dir)}); vim.cmd('runtime plugin/hedgesync.lua') end`;
  const env = { ...process.env, HEDGESYNC_CMD: JSON.stringify(selfCommand()) };
  const hedge = 'url' in target ? `Hedge open ${target.url}` : `Hedge browse ${target.browse}`.trim();
  const code = await runEditor(editor, ['-c', load, '-c', hedge], env);
  if (code === 127) throw new CliError(`Editor not found: ${editor}`, 'Set $EDITOR or pass --editor.');
  return code;
}

/** The server URL if `arg` is one with no note path (https://md.example.com), else undefined. */
export function serverOnly(arg: string): string | undefined {
  try {
    const u = new URL(arg);
    return (u.protocol === 'https:' || u.protocol === 'http:') && (u.pathname === '/' || u.pathname === '') && !u.search
      ? u.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function luaString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function editFile(ctx: Context, editor: string, client: HedgeDocClient, noteId: string): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'hedgesync-edit-'));
  const path = join(dir, `${noteId}.md`);
  try {
    const editable = client.canEdit();
    if (!editable) {
      const reason = readOnlyReason(client.getNoteInfo().permission, client.serverUrl);
      ctx.warn(`Read-only, changes will not be saved${reason ? `: ${reason}` : ''}`);
    }
    let base = client.getDocument();
    // Editors complain about, and then add, a missing final newline; add it
    // for them and take it off again, so the note is not changed behind
    // the user's back.
    const addNewline = base !== '' && !base.endsWith('\n');
    writeFileSync(path, addNewline ? base + '\n' : base);

    // Merge what changed in the file since the last sync into the note as it is now.
    const sync = (): boolean => {
      let mine: string;
      try {
        mine = readFileSync(path, 'utf8');
      } catch {
        return false; // mid-save (some editors replace the file)
      }
      if (addNewline && mine.endsWith('\n')) mine = mine.slice(0, -1);
      if (mine === base || !editable) return false;
      client.updateContent(mergeText(base, mine, client.getDocument()));
      base = mine;
      return true;
    };

    // Poll by path: editors that save by renaming defeat fs.watch.
    watchFile(path, { interval: 250 }, () => {
      try {
        sync();
      } catch {
        // Reported by the final sync.
      }
    });
    let code: number;
    try {
      code = await runEditor(editor, [path], process.env);
    } finally {
      unwatchFile(path);
    }
    if (code === 127) throw new CliError(`Editor not found: ${editor}`, 'Set $EDITOR or pass --editor.');
    if (editable) {
      assertEditable(client);
      sync();
      await client.flush();
      ctx.info(c('green', '✓ Note saved'));
    }
    return code;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Resolve once the note had no change for `quietMs` (at most `maxMs`): the last edits of an editor that just closed. */
function settle(client: HedgeDocClient, quietMs = 700, maxMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    let quiet: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(quiet);
      clearTimeout(cap);
      client.off('change', onChange);
      resolve();
    };
    const onChange = () => {
      clearTimeout(quiet);
      quiet = setTimeout(done, quietMs);
    };
    const cap = setTimeout(done, maxMs);
    client.on('change', onChange);
    onChange();
  });
}

/**
 * --new: a note from `file`, edited (live in Neovim) with whoever opens the
 * link, and its final text written back to `file` when the editor exits
 * successfully.
 */
async function editNew(ctx: Context, editor: string, live: boolean, server: string, file: string): Promise<number> {
  const original = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const url = await createNote(ctx, server, noteText(original));
  const { noteId } = parseNoteUrl(url);
  // To stderr, so it shows even when git runs the editor.
  ctx.info(`${c('cyan', 'Editing together:')} ${url}?edit`);
  const client = await ctx.connectTo(server, noteId);
  try {
    const code = live ? await editLive(ctx, editor, { url, probe: false }) : await editFile(ctx, editor, client, noteId);
    if (code !== 0) {
      ctx.warn(`The editor failed (exit ${code}); ${file} is unchanged. The note stays: ${url}`);
      return code;
    }
    await settle(client);
    const text = client.getDocument();
    // Keep the file's final newline convention (git messages end with one).
    const keepNewline = original === '' || original.endsWith('\n');
    writeFileSync(file, keepNewline && !text.endsWith('\n') ? text + '\n' : text);
    if (ctx.flag('delete-after')) {
      try {
        await client.deleteNote();
      } catch (err) {
        ctx.warn(`Could not delete ${url}: ${(err as Error).message}`);
      }
    }
    return 0;
  } finally {
    client.disconnect();
  }
}

export const edit: Command = {
  name: 'edit',
  summary: 'Open a note in your editor (live in Neovim)',
  options: [
    ...connectionOptions,
    { name: 'editor', short: 'e', type: 'value' },
    { name: 'no-live', type: 'flag' },
    { name: 'new', type: 'flag' },
    { name: 'delete-after', type: 'flag' },
    { name: 'permission', short: 'p', type: 'value' },
  ],
  help: helpText.edit,
  async run(ctx) {
    const usage = 'hedgesync edit [<note-url> | <server-url>] [--editor <cmd>]';
    const editor = chooseEditor(ctx.str('editor'));
    const live = isNeovim(editor) && !ctx.flag('no-live');
    if (ctx.flag('new')) {
      const newUsage = 'hedgesync edit --new [<server-url>] <file> [--delete-after]';
      const [first, second] = ctx.positional;
      if (!first) throw new CliError('Which file?', `Usage: ${newUsage}`);
      let server: string;
      let file: string;
      if (second !== undefined) {
        const s = serverOnly(first);
        if (!s) throw new CliError(`Not a server URL: ${first}`, `Usage: ${newUsage}`);
        [server, file] = [s, second];
      } else {
        [server, file] = [defaultServer(newUsage), first];
      }
      const code = await editNew(ctx, editor, live, server, file);
      if (code !== 0) process.exitCode = code;
      return;
    }
    const arg = ctx.positional[0];
    // No note: browse your notes (on that server, or the saved login's).
    const server = arg === undefined ? '' : serverOnly(arg);
    if (server !== undefined) {
      if (!live) throw new CliError('Which note?', `Browsing notes needs Neovim (the plugin). Usage: ${usage}`);
      const code = await editLive(ctx, editor, { browse: server });
      if (code !== 0) process.exitCode = code;
      return;
    }
    const { url } = ctx.note(0, usage);
    let code: number;
    if (live) {
      code = await editLive(ctx, editor, { url });
    } else {
      const client = await ctx.connect(0);
      try {
        code = await editFile(ctx, editor, client, ctx.note(0).noteId);
      } finally {
        client.disconnect();
      }
    }
    if (code !== 0) process.exitCode = code;
  },
};
