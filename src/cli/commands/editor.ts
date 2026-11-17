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
 *
 * With --lazy, install also writes a lazy.nvim spec for the plugin into the
 * Neovim config (lua/plugins/hedgesync.lua), since lazy.nvim does not load
 * the package directory. The marker records its hash too, so later installs
 * keep it current and uninstall removes it, unless it was edited.
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
  /** The lazy.nvim spec written with --lazy: where, and its sha256 as written. */
  lazySpec?: { path: string; sha256: string };
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
  /** The lazy.nvim spec hedgesync wrote, if it is still there. */
  lazySpec?: string;
  /** That spec was changed by hand (it is then left alone). */
  lazySpecEdited?: boolean;
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

/** Neovim's stdpath("config"). */
export function defaultNvimConfigDir(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  const app = env.NVIM_APPNAME || 'nvim';
  return platform === 'win32'
    ? join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), app)
    : join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), app);
}

/** Where --lazy writes the spec: lua/plugins/hedgesync.lua in the config, which lazy.nvim's `{ import = "plugins" }` picks up. */
export function defaultLazySpecPath(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  return join(defaultNvimConfigDir(env, platform), 'lua', 'plugins', 'hedgesync.lua');
}

/** The lazy.nvim spec file for a plugin installed in `dir`. */
export function lazySpecFile(dir: string, isDefault: boolean): string {
  const path = isDefault ? 'vim.fn.stdpath "data" .. "/site/pack/hedgesync/start/hedgesync.nvim"' : JSON.stringify(dir);
  return `-- hedgesync.nvim as installed by \`hedgesync editor nvim install\`, so it always
-- matches the binary (run that again after updating hedgesync;
-- \`:checkhealth hedgesync\` tells you when). Live-edit notes with
-- \`:Hedge open <url>\` or \`:e hedgedoc://host/id\`.
-- lazy.nvim does not load Neovim's package directory, hence the \`dir\` spec;
-- \`cond\` skips it on machines where the plugin is not installed.
local dir = ${path}

---@type LazySpec
return {
  dir = dir,
  name = "hedgesync.nvim",
  cond = vim.uv.fs_stat(dir) ~= nil,
  -- Not lazy: lazy.nvim's BufReadCmd trigger loads the plugin but does not
  -- replay the \`:e hedgedoc://...\` that triggered it. The startup file only
  -- defines \`:Hedge\` and the autocmd; the module loads on first use.
  lazy = false,
  opts = {},
}
`;
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
  // A deleted spec is a choice, not damage: it is just no longer managed.
  const spec = marker.lazySpec && existsSync(marker.lazySpec.path) ? marker.lazySpec : undefined;
  return {
    dir, state: current ? 'current' : 'outdated', version: marker.version, edited, missing,
    ...(spec ? { lazySpec: spec.path, lazySpecEdited: sha256(readFileSync(spec.path)) !== spec.sha256 } : {}),
  };
}

/** Write the bundled files to `dir`, removing files a previous install left that are no longer bundled. */
export function installPlugin(dir: string, options: {
  force?: boolean;
  files?: Record<string, string>;
  /** Content of the lazy.nvim spec, to keep a spec written earlier current. */
  lazySpecContent?: string;
  /** Write the spec here (--lazy). */
  lazySpecPath?: string;
} = {}): Inspection {
  const files = options.files ?? NVIM_PLUGIN_FILES;
  const before = inspectInstall(dir, files);
  if (before.state === 'unmanaged' && !options.force) {
    throw new CliError(`${dir} exists but was not installed by hedgesync`, 'Remove it, pick another --dir, or pass --force to overwrite.');
  }
  if (before.edited.length && !options.force) {
    throw new CliError(`The installed copy has local changes: ${before.edited.join(', ')}`,
      'Pass --force to overwrite them.');
  }
  const old = readMarker(dir);
  // The lazy.nvim spec: write it where --lazy asks, and keep one an earlier
  // --lazy wrote current while nobody edited it.
  const recorded = old?.lazySpec && existsSync(old.lazySpec.path) ? old.lazySpec : undefined;
  const unedited = (path: string) => recorded?.path === path && sha256(readFileSync(path)) === recorded.sha256;
  const content = options.lazySpecContent ?? '';
  let specPath: string | undefined;
  if (options.lazySpecPath) {
    const path = options.lazySpecPath;
    if (existsSync(path) && readFileSync(path, 'utf8') !== content && !unedited(path) && !options.force) {
      throw new CliError(`${path} exists with other content`, 'Keep it (drop --lazy), or pass --force to overwrite it.');
    }
    specPath = path;
  } else if (recorded && options.lazySpecContent !== undefined && unedited(recorded.path)) {
    specPath = recorded.path;
  }
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
  let lazySpec: Marker['lazySpec'];
  if (specPath) {
    mkdirSync(dirname(specPath), { recursive: true });
    writeFileSync(specPath, content);
    lazySpec = { path: specPath, sha256: sha256(content) };
  } else if (recorded) {
    lazySpec = recorded; // edited by hand: no longer updated, still reported
  }
  const marker: Marker = {
    version: VERSION, protocol: BRIDGE_PROTOCOL, installedAt: new Date().toISOString(), files: hashes, ...(lazySpec ? { lazySpec } : {}),
  };
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
    throw new CliError(`The installed copy has local changes: ${edited.join(', ')}`, 'Pass --force to remove it anyway.');
  }
  for (const path of Object.keys(marker.files)) {
    rmSync(join(dir, path), { force: true });
    pruneEmptyDirs(dir, dirname(join(dir, path)));
  }
  const spec = marker.lazySpec;
  if (spec && existsSync(spec.path) && (options.force || sha256(readFileSync(spec.path)) === spec.sha256)) {
    rmSync(spec.path);
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

const ACTIONS = ['install', 'status', 'path', 'uninstall'];

export const editor: Command = {
  name: 'editor',
  summary: 'Install the bundled Neovim plugin',
  options: [
    { name: 'dir', type: 'value' },
    { name: 'force', type: 'flag' },
    { name: 'lazy', type: 'flag' },
    { name: 'lazy-file', type: 'value' },
  ],
  help: helpText.editor,
  async run(ctx: Context) {
    const usage = 'hedgesync editor nvim <install|status|path|uninstall> [--dir <path>] [--lazy [--lazy-file <path>]] [--force]';
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
          if (info.lazySpec) print(`${c('cyan', 'lazy spec:')}   ${info.lazySpec}${info.lazySpecEdited ? c('dim', ' (edited, left alone)') : ''}`);
          if (info.state === 'missing') print(c('dim', 'Run: hedgesync editor nvim install'));
          else if (info.state === 'outdated') print(c('dim', `Run: hedgesync editor nvim install${info.edited.length || info.missing.length ? ' --force (discards your changes)' : ''}`));
        });
        if (info.state !== 'current') process.exitCode = 1;
        return;
      }

      case 'install': {
        const before = inspectInstall(dir);
        const lazyFile = ctx.str('lazy-file');
        const lazySpecPath = lazyFile ? resolve(lazyFile) : ctx.flag('lazy') ? defaultLazySpecPath() : undefined;
        const content = lazySpecFile(dir, !custom);
        const specBefore = lazySpecPath && existsSync(lazySpecPath) ? readFileSync(lazySpecPath, 'utf8') : undefined;
        const info = installPlugin(dir, { force: ctx.flag('force'), lazySpecContent: content, lazySpecPath });
        const action = before.state === 'missing' ? 'installed' : before.state === 'current' ? 'unchanged' : 'updated';
        const spec = info.lazySpec && !info.lazySpecEdited ? info.lazySpec : undefined;
        ctx.result({ action, dir, version: VERSION, ...(spec ? { lazySpec: spec } : {}) }, () => {
          ctx.info(c('green', `✓ hedgesync.nvim ${action} (${VERSION})`) + c('dim', ` in ${info.dir}`));
          if (lazySpecPath) {
            ctx.info(c('green', `✓ lazy.nvim spec ${specBefore === content ? 'unchanged' : specBefore === undefined ? 'written' : 'updated'}`) + c('dim', ` in ${lazySpecPath}`));
          } else if (before.state === 'missing' && !spec) {
            ctx.info('');
            ctx.info('Neovim loads it from its package directory on start. lazy.nvim does not;');
            ctx.info('with lazy.nvim, run again with --lazy to add a spec to lua/plugins/.');
          }
        });
        return;
      }

      case 'uninstall':
        const { lazySpec } = existsSync(dir) ? inspectInstall(dir) : { lazySpec: undefined };
        uninstallPlugin(dir, { force: ctx.flag('force') });
        const kept = lazySpec && existsSync(lazySpec) ? lazySpec : undefined;
        ctx.result({ action: 'uninstalled', dir, ...(kept ? { keptLazySpec: kept } : {}) }, () => {
          ctx.info(c('green', `✓ Removed hedgesync.nvim from ${dir}`));
          if (lazySpec && !kept) ctx.info(c('green', `✓ Removed the lazy.nvim spec ${lazySpec}`));
          if (kept) ctx.info(c('yellow', `Kept ${kept}: it was edited (--force removes it)`));
        });
        return;
    }
  },
};
