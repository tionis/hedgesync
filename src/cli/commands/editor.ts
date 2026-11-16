/**
 * editor: install the editor plugins bundled with this binary.
 *
 *   hedgesync editor nvim install | status | path | uninstall
 *
 * The plugin files are embedded at build time (scripts/gen-nvim-plugin.ts),
 * so an installed copy always matches the binary that installed it. A marker
 * file records the version and a hash of every file, which tells an outdated
 * copy from a locally edited one; edited copies are never overwritten
 * without --force.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { BRIDGE_PROTOCOL } from '../../editor-bridge.js';
import { VERSION } from '../../version.js';
import type { Command, Context } from '../context.js';
import { helpText } from '../help-text.js';
import { NVIM_PLUGIN_FILES } from '../nvim-plugin.generated.js';
import { CliError, c, print } from '../ui.js';

export const MARKER = '.hedgesync-install.json';

interface Marker {
  version: string;
  protocol: number;
  installedAt: string;
  /** sha256 of each file as installed, by relative path. */
  files: Record<string, string>;
}

export type InstallState = 'missing' | 'unmanaged' | 'current' | 'outdated';

export interface Inspection {
  dir: string;
  state: InstallState;
  /** Version that installed the copy (managed copies only). */
  version?: string;
  /** Installed files changed since installation. */
  edited: string[];
  /** Installed files that have gone missing. */
  missing: string[];
}

const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');

/** Neovim's stdpath("data")/site/pack/hedgesync/start/hedgesync.nvim. */
export function defaultNvimDir(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  const app = env.NVIM_APPNAME || 'nvim';
  const data = platform === 'win32'
    ? join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), `${app}-data`)
    : join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), app);
  return join(data, 'site', 'pack', 'hedgesync', 'start', 'hedgesync.nvim');
}

function readMarker(dir: string): Marker | null {
  try {
    const marker = JSON.parse(readFileSync(join(dir, MARKER), 'utf8')) as Marker;
    return marker && typeof marker.files === 'object' ? marker : null;
  } catch {
    return null;
  }
}

export function inspectInstall(dir: string, files: Record<string, string> = NVIM_PLUGIN_FILES): Inspection {
  if (!existsSync(dir)) return { dir, state: 'missing', edited: [], missing: [] };
  const marker = readMarker(dir);
  if (!marker) return { dir, state: 'unmanaged', edited: [], missing: [] };
  const edited: string[] = [];
  const missing: string[] = [];
  for (const [path, hash] of Object.entries(marker.files)) {
    const full = join(dir, path);
    if (!existsSync(full)) missing.push(path);
    else if (sha256(readFileSync(full)) !== hash) edited.push(path);
  }
  const bundled = Object.keys(files);
  const sameFiles = bundled.length === Object.keys(marker.files).length
    && bundled.every(path => marker.files[path] === sha256(files[path]));
  const current = sameFiles && edited.length === 0 && missing.length === 0;
  return { dir, state: current ? 'current' : 'outdated', version: marker.version, edited, missing };
}

/** Write the bundled files to `dir`, removing files a previous install left that are no longer bundled. */
export function installPlugin(dir: string, options: { force?: boolean; files?: Record<string, string> } = {}): Inspection {
  const files = options.files ?? NVIM_PLUGIN_FILES;
  const before = inspectInstall(dir, files);
  if (before.state === 'unmanaged' && !options.force) {
    throw new CliError(`${dir} exists but was not installed by hedgesync`, 'Remove it, pick another --dir, or pass --force to overwrite.');
  }
  if (before.edited.length && !options.force) {
    throw new CliError(`The installed plugin has local changes: ${before.edited.join(', ')}`,
      'Pass --force to overwrite them.');
  }
  const old = readMarker(dir);
  const hashes: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    hashes[path] = sha256(content);
  }
  for (const path of Object.keys(old?.files ?? {})) {
    if (!(path in files)) {
      rmSync(join(dir, path), { force: true });
      pruneEmptyDirs(dir, dirname(join(dir, path)));
    }
  }
  const marker: Marker = { version: VERSION, protocol: BRIDGE_PROTOCOL, installedAt: new Date().toISOString(), files: hashes };
  writeFileSync(join(dir, MARKER), JSON.stringify(marker, null, 2) + '\n');
  return inspectInstall(dir, files);
}

/** Remove a copy hedgesync installed (its files only; anything else added there stays). */
export function uninstallPlugin(dir: string, options: { force?: boolean } = {}): void {
  const marker = readMarker(dir);
  if (!existsSync(dir)) throw new CliError(`Nothing installed at ${dir}`);
  if (!marker) throw new CliError(`${dir} was not installed by hedgesync; remove it yourself if you want it gone`);
  const { edited } = inspectInstall(dir);
  if (edited.length && !options.force) {
    throw new CliError(`The installed plugin has local changes: ${edited.join(', ')}`, 'Pass --force to remove it anyway.');
  }
  for (const path of Object.keys(marker.files)) {
    rmSync(join(dir, path), { force: true });
    pruneEmptyDirs(dir, dirname(join(dir, path)));
  }
  rmSync(join(dir, MARKER), { force: true });
  // In the default place, also drop the empty pack/hedgesync/start folders.
  const start = dirname(dir);
  const isPack = basename(start) === 'start' && basename(dirname(start)) === 'hedgesync';
  pruneEmptyDirs(isPack ? dirname(dirname(start)) : start, dir);
}

/** Remove empty directories from `from` up to (not including) `stop`. */
function pruneEmptyDirs(stop: string, from: string): void {
  let dir = resolve(from);
  const end = resolve(stop);
  while (dir.startsWith(end) && dir !== end) {
    try {
      if (readdirSync(dir).length > 0) return;
      rmdirSync(dir);
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

function lazySpec(dir: string, isDefault: boolean): string {
  const path = isDefault ? 'vim.fn.stdpath("data") .. "/site/pack/hedgesync/start/hedgesync.nvim"' : JSON.stringify(dir);
  return `{ dir = ${path}, name = "hedgesync.nvim", lazy = false, opts = {} }`;
}

const ACTIONS = ['install', 'status', 'path', 'uninstall'];

export const editor: Command = {
  name: 'editor',
  summary: 'Install the bundled Neovim plugin',
  options: [{ name: 'dir', type: 'value' }, { name: 'force', type: 'flag' }],
  help: helpText.editor,
  async run(ctx: Context) {
    const usage = 'hedgesync editor nvim <install|status|path|uninstall> [--dir <path>] [--force]';
    const target = ctx.need(0, 'Editor', usage);
    if (target !== 'nvim' && target !== 'neovim') throw new CliError(`Unknown editor: ${target}`, 'Only nvim is supported.');
    const action = ctx.positional[1] ?? 'status';
    if (!ACTIONS.includes(action)) throw new CliError(`Unknown action: ${action}`, `Usage: ${usage}`);
    const custom = ctx.str('dir');
    const dir = custom ? resolve(custom) : defaultNvimDir();

    switch (action) {
      case 'path':
        ctx.result({ dir }, () => print(dir));
        return;

      case 'status': {
        const info = inspectInstall(dir);
        ctx.result({ ...info, binaryVersion: VERSION, protocol: BRIDGE_PROTOCOL }, () => {
          const changed = info.edited.length > 0 || info.missing.length > 0;
          const line = {
            missing: c('yellow', 'not installed'),
            unmanaged: c('yellow', 'present, but not installed by hedgesync'),
            current: c('green', `installed, matches this binary (${VERSION})`),
            outdated: changed
              ? c('yellow', `installed by ${info.version ?? 'an unknown version'}, with local changes`)
              : c('yellow', `installed by ${info.version ?? 'an unknown version'}, this binary bundles a different copy (${VERSION})`),
          }[info.state];
          print(`${c('cyan', 'nvim plugin:')} ${line}`);
          print(`${c('cyan', 'path:')}        ${dir}`);
          if (info.edited.length) print(`${c('cyan', 'edited:')}      ${info.edited.join(', ')}`);
          if (info.missing.length) print(`${c('cyan', 'missing:')}     ${info.missing.join(', ')}`);
          if (info.state === 'missing') print(c('dim', 'Run: hedgesync editor nvim install'));
          else if (info.state === 'outdated') print(c('dim', `Run: hedgesync editor nvim install${info.edited.length || info.missing.length ? ' --force (discards your changes)' : ''}`));
        });
        if (info.state !== 'current') process.exitCode = 1;
        return;
      }

      case 'install': {
        const before = inspectInstall(dir);
        const info = installPlugin(dir, { force: ctx.flag('force') });
        const action = before.state === 'missing' ? 'installed' : before.state === 'current' ? 'unchanged' : 'updated';
        ctx.result({ action, dir, version: VERSION }, () => {
          ctx.info(c('green', `✓ hedgesync.nvim ${action} (${VERSION})`) + c('dim', ` in ${info.dir}`));
          if (before.state === 'missing') {
            ctx.info('');
            ctx.info('Neovim loads it from its package directory on start. lazy.nvim replaces');
            ctx.info('that directory, so with lazy.nvim add this spec:');
            ctx.info('  ' + lazySpec(dir, !custom));
          }
        });
        return;
      }

      case 'uninstall':
        uninstallPlugin(dir, { force: ctx.flag('force') });
        ctx.result({ action: 'uninstalled', dir }, () => ctx.info(c('green', `✓ Removed hedgesync.nvim from ${dir}`)));
        return;
    }
  },
};
