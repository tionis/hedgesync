import { describe, expect, test } from 'bun:test';
import { assetName, checksumFor, compareVersions, installKind } from '../../src/self-update.js';

describe('self-update', () => {
  test('install kind', () => {
    expect(installKind('/$bunfs/root/hedgesync', '/home/u/.local/bin/hedgesync')).toEqual({ kind: 'binary', path: '/home/u/.local/bin/hedgesync' });
    expect(installKind('B:/~BUN/root/hedgesync.exe', 'C:\\bin\\hedgesync.exe').kind).toBe('binary');
    expect(installKind('/usr/lib/node_modules/hedgesync/dist/cli/bin.js').kind).toBe('npm');
    expect(installKind('/home/u/.bun/install/global/node_modules/hedgesync/dist/cli/bin.js').kind).toBe('bun');
    expect(installKind('/home/u/dev/hedgesync/bin/hedgesync.ts').kind).toBe('source');
  });

  test('asset names', () => {
    expect(assetName('linux', 'x64', false)).toBe('hedgesync-linux-x64');
    expect(assetName('linux', 'arm64', false)).toBe('hedgesync-linux-arm64');
    expect(assetName('linux', 'x64', true)).toBe('hedgesync-linux-x64-musl');
    expect(assetName('darwin', 'arm64', false)).toBe('hedgesync-darwin-arm64');
    expect(assetName('win32', 'x64', false)).toBe('hedgesync-windows-x64.exe');
    expect(() => assetName('freebsd', 'x64', false)).toThrow();
  });

  test('versions', () => {
    expect(compareVersions('2.5.0', '2.4.1')).toBeGreaterThan(0);
    expect(compareVersions('v2.4.1', '2.4.1')).toBe(0);
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0);
    expect(compareVersions('2.5.0-beta.1', '2.5.0')).toBeLessThan(0);
    expect(compareVersions('2.5.0-beta.10', '2.5.0-beta.2')).toBeGreaterThan(0);
  });

  test('checksums.txt', () => {
    const sum = 'a'.repeat(64);
    const txt = `${'b'.repeat(64)}  hedgesync-linux-x64-musl\n${sum}  hedgesync-linux-x64\n`;
    expect(checksumFor(txt, 'hedgesync-linux-x64')).toBe(sum);
    expect(checksumFor(txt, 'hedgesync-darwin-x64')).toBeUndefined();
  });
});
