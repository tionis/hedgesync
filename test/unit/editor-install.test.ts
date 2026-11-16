/**
 * `hedgesync editor nvim`: the embedded plugin copy and installing it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { renderPluginModule, GENERATED } from '../../scripts/gen-nvim-plugin.js';
import { defaultLazySpecPath, defaultNvimDir, inspectInstall, installPlugin, lazySpecFile, MARKER, uninstallPlugin } from '../../src/cli/commands/editor.js';
import { NVIM_PLUGIN_FILES } from '../../src/cli/nvim-plugin.generated.js';
import { BRIDGE_PROTOCOL } from '../../src/editor-bridge.js';

const tmp = mkdtempSync(join(tmpdir(), 'hedgesync-editor-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(tmp, `p${++n}`);

test('embedded plugin is up to date with editors/nvim (run: bun run gen:nvim)', () => {
  expect(readFileSync(GENERATED, 'utf8')).toBe(renderPluginModule());
});

test('plugin and bridge agree on the protocol version', () => {
  const init = NVIM_PLUGIN_FILES['lua/hedgesync/init.lua'];
  expect(init).toContain(`M.protocol = ${BRIDGE_PROTOCOL}\n`);
  expect(Object.keys(NVIM_PLUGIN_FILES)).toEqual(expect.arrayContaining([
    'plugin/hedgesync.lua', 'lua/hedgesync/init.lua', 'lua/hedgesync/health.lua', 'README.md',
  ]));
});

describe('lazy.nvim spec', () => {
  const content = (dir: string) => lazySpecFile(dir, false);

  test('default path follows XDG_CONFIG_HOME, NVIM_APPNAME and Windows', () => {
    expect(defaultLazySpecPath({ XDG_CONFIG_HOME: '/c', NVIM_APPNAME: 'lv' }, 'linux')).toBe(join('/c', 'lv', 'lua', 'plugins', 'hedgesync.lua'));
    expect(defaultLazySpecPath({ LOCALAPPDATA: 'C:/L' }, 'win32')).toBe(join('C:/L', 'nvim', 'lua', 'plugins', 'hedgesync.lua'));
  });

  test('the default spec points at the package directory, a custom one at --dir', () => {
    expect(lazySpecFile('/x', true)).toContain('local dir = vim.fn.stdpath "data" .. "/site/pack/hedgesync/start/hedgesync.nvim"');
    expect(lazySpecFile('/x/y', false)).toContain('local dir = "/x/y"');
  });

  test('written with the plugin, kept current, removed on uninstall', () => {
    const dir = fresh();
    const spec = join(fresh(), 'lua', 'plugins', 'hedgesync.lua');
    expect(installPlugin(dir, { lazySpecPath: spec, lazySpecContent: content(dir) }).lazySpec).toBe(spec);
    expect(readFileSync(spec, 'utf8')).toBe(content(dir));
    // A later plain install updates an unedited spec.
    installPlugin(dir, { lazySpecContent: 'newer' });
    expect(readFileSync(spec, 'utf8')).toBe('newer');
    uninstallPlugin(dir);
    expect(existsSync(spec)).toBe(false);
  });

  test('an edited spec is left alone, without blocking plugin updates', () => {
    const dir = fresh();
    const spec = join(fresh(), 'hedgesync.lua');
    installPlugin(dir, { lazySpecPath: spec, lazySpecContent: content(dir) });
    writeFileSync(spec, '-- mine');
    expect(inspectInstall(dir)).toMatchObject({ state: 'current', lazySpec: spec, lazySpecEdited: true });
    installPlugin(dir, { lazySpecContent: 'newer' });
    expect(readFileSync(spec, 'utf8')).toBe('-- mine');
    expect(() => installPlugin(dir, { lazySpecPath: spec, lazySpecContent: 'newer' })).toThrow(/exists with other content/);
    uninstallPlugin(dir);
    expect(readFileSync(spec, 'utf8')).toBe('-- mine');
  });

  test('an existing file is replaced only if identical or with --force', () => {
    const dir = fresh();
    const spec = join(fresh(), 'hedgesync.lua');
    mkdirSync(dirname(spec), { recursive: true });
    writeFileSync(spec, content(dir));
    expect(installPlugin(dir, { lazySpecPath: spec, lazySpecContent: content(dir) }).lazySpecEdited).toBe(false);
    writeFileSync(spec, '-- someone else');
    expect(() => installPlugin(dir, { lazySpecPath: spec, lazySpecContent: content(dir) })).toThrow(/exists with other content/);
    installPlugin(dir, { lazySpecPath: spec, lazySpecContent: content(dir), force: true });
    expect(readFileSync(spec, 'utf8')).toBe(content(dir));
  });

  test('a deleted spec is no longer managed', () => {
    const dir = fresh();
    const spec = join(fresh(), 'hedgesync.lua');
    installPlugin(dir, { lazySpecPath: spec, lazySpecContent: content(dir) });
    rmSync(spec);
    installPlugin(dir, { lazySpecContent: content(dir) });
    expect(existsSync(spec)).toBe(false);
    expect(inspectInstall(dir).lazySpec).toBeUndefined();
  });
});

describe('defaultNvimDir', () => {
  const tail = join('site', 'pack', 'hedgesync', 'start', 'hedgesync.nvim');
  test('XDG_DATA_HOME and NVIM_APPNAME', () => {
    expect(defaultNvimDir({ XDG_DATA_HOME: '/x' }, 'linux')).toBe(join('/x', 'nvim', tail));
    expect(defaultNvimDir({ XDG_DATA_HOME: '/x', NVIM_APPNAME: 'lazyvim' }, 'linux')).toBe(join('/x', 'lazyvim', tail));
  });
  test('Windows uses LOCALAPPDATA/<app>-data', () => {
    expect(defaultNvimDir({ LOCALAPPDATA: 'C:\\L' }, 'win32')).toBe(join('C:\\L', 'nvim-data', tail));
  });
});

describe('install / status / uninstall', () => {
  test('fresh install is current; a second install changes nothing', () => {
    const dir = fresh();
    expect(inspectInstall(dir).state).toBe('missing');
    expect(installPlugin(dir).state).toBe('current');
    for (const [path, content] of Object.entries(NVIM_PLUGIN_FILES)) {
      expect(readFileSync(join(dir, path), 'utf8')).toBe(content);
    }
    expect(installPlugin(dir).state).toBe('current');
  });

  test('a copy from another version is outdated and gets updated; stale files are removed', () => {
    const dir = fresh();
    installPlugin(dir, { files: { 'lua/hedgesync/init.lua': 'old', 'lua/hedgesync/gone.lua': 'x' } });
    const before = inspectInstall(dir);
    expect(before.state).toBe('outdated');
    expect(before.edited).toEqual([]);
    expect(installPlugin(dir).state).toBe('current');
    expect(existsSync(join(dir, 'lua/hedgesync/gone.lua'))).toBe(false);
  });

  test('local edits are reported and protected unless --force', () => {
    const dir = fresh();
    installPlugin(dir);
    writeFileSync(join(dir, 'plugin/hedgesync.lua'), '-- mine');
    const info = inspectInstall(dir);
    expect(info).toMatchObject({ state: 'outdated', edited: ['plugin/hedgesync.lua'] });
    expect(() => installPlugin(dir)).toThrow(/local changes: plugin\/hedgesync.lua/);
    expect(() => uninstallPlugin(dir)).toThrow(/local changes/);
    expect(installPlugin(dir, { force: true }).state).toBe('current');
  });

  test('a directory hedgesync did not create is left alone', () => {
    const dir = fresh();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'other.lua'), 'x');
    expect(inspectInstall(dir).state).toBe('unmanaged');
    expect(() => installPlugin(dir)).toThrow(/not installed by hedgesync/);
    expect(() => uninstallPlugin(dir)).toThrow(/not installed by hedgesync/);
    expect(readFileSync(join(dir, 'other.lua'), 'utf8')).toBe('x');
  });

  test('uninstall removes only its own files', () => {
    const dir = fresh();
    installPlugin(dir);
    writeFileSync(join(dir, 'lua', 'extra.lua'), 'keep');
    uninstallPlugin(dir);
    expect(existsSync(join(dir, MARKER))).toBe(false);
    expect(existsSync(join(dir, 'plugin'))).toBe(false);
    expect(readFileSync(join(dir, 'lua', 'extra.lua'), 'utf8')).toBe('keep');

    const clean = fresh();
    installPlugin(clean);
    uninstallPlugin(clean);
    expect(existsSync(clean)).toBe(false);
  });

  test('uninstall from the default layout removes the empty pack/hedgesync folders', () => {
    const site = join(fresh(), 'site');
    const dir = join(site, 'pack', 'hedgesync', 'start', 'hedgesync.nvim');
    installPlugin(dir);
    uninstallPlugin(dir);
    expect(existsSync(join(site, 'pack', 'hedgesync'))).toBe(false);
    expect(existsSync(join(site, 'pack'))).toBe(true);
  });
});
