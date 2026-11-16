/**
 * edit: open a note in your editor.
 *
 * - Neovim: live, keystroke-level editing through the bundled plugin
 *   (`nvim -c "Hedge open <url>"`). If the user's config does not load the
 *   plugin, the copy matching this binary is loaded for the session.
 * - Any other editor: the note in a temp file. Every save is merged into the
 *   note (three-way, so concurrent remote edits survive), and once more when
 *   the editor exits.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeText } from '../../mirror.js';
import { VERSION } from '../../version.js';
import { assertEditable, connectionOptions, readOnlyReason, type Command, type Context } from '../context.js';
import { helpText } from '../help-text.js';
import { NVIM_PLUGIN_FILES } from '../nvim-plugin.generated.js';
import { CliError, c } from '../ui.js';
import { defaultNvimDir, inspectInstall, installPlugin } from './editor.js';

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
    installPlugin(installed.dir);
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

async function editLive(ctx: Context, editor: string, url: string): Promise<number> {
  // Fail here, with the CLI's error messages, rather than in an empty editor.
  const probe = await ctx.connect(0);
  const readOnly = probe.canEdit() ? undefined : readOnlyReason(probe.getNoteInfo().permission, probe.serverUrl);
  probe.disconnect();
  if (readOnly) ctx.warn(`Read-only: ${readOnly}`);
  const dir = pluginDirForSession(ctx);
  // After the user's config: load the plugin unless it already did (lazy.nvim
  // resets the runtimepath, so --cmd would be too early).
  const load = `lua if vim.fn.exists(':Hedge') ~= 2 then vim.opt.rtp:prepend(${luaString(dir)}); vim.cmd('runtime plugin/hedgesync.lua') end`;
  const env = { ...process.env, HEDGESYNC_CMD: JSON.stringify(selfCommand()) };
  const code = await runEditor(editor, ['-c', load, '-c', `Hedge open ${url}`], env);
  if (code === 127) throw new CliError(`Editor not found: ${editor}`, 'Set $EDITOR or pass --editor.');
  return code;
}

function luaString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function editFile(ctx: Context, editor: string): Promise<number> {
  const { noteId } = ctx.note(0);
  const client = await ctx.connect(0);
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
    client.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

export const edit: Command = {
  name: 'edit',
  summary: 'Open a note in your editor (live in Neovim)',
  options: [...connectionOptions, { name: 'editor', short: 'e', type: 'value' }, { name: 'no-live', type: 'flag' }],
  help: helpText.edit,
  async run(ctx) {
    const { url } = ctx.note(0, 'hedgesync edit <url> [--editor <cmd>]');
    const editor = chooseEditor(ctx.str('editor'));
    const code = isNeovim(editor) && !ctx.flag('no-live')
      ? await editLive(ctx, editor, url)
      : await editFile(ctx, editor);
    if (code !== 0) process.exitCode = code;
  },
};
