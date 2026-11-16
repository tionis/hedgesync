/**
 * Self-update: how hedgesync was installed, and replacing a release binary.
 *
 * A compiled binary (from the GitHub releases) replaces itself with the
 * release's binary for this platform, after checking it against the
 * release's checksums.txt and running it once (`--version`). npm and bun
 * installs are updated with their package manager; a source checkout is
 * left to git.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';

export const RELEASES_URL = 'https://github.com/tionis/hedgesync/releases';

export type InstallKind =
  | { kind: 'binary'; path: string }
  | { kind: 'npm'; path: string }
  | { kind: 'bun'; path: string }
  | { kind: 'source'; path: string };

/** How the running hedgesync was installed. */
export function installKind(
  main = typeof Bun !== 'undefined' ? Bun.main : process.argv[1] ?? '',
  execPath = process.execPath,
): InstallKind {
  // Compiled with bun build --compile: the script lives in an embedded file system.
  if (main.startsWith('/$bunfs/') || /^[A-Z]:[\\/]~BUN[\\/]/i.test(main)) return { kind: 'binary', path: execPath };
  const p = main.split(sep).join('/');
  if (p.includes('/.bun/install/global/')) return { kind: 'bun', path: main };
  if (p.includes('/node_modules/hedgesync/')) return { kind: 'npm', path: main };
  return { kind: 'source', path: main };
}

/** The release asset for this platform, e.g. hedgesync-linux-x64 or hedgesync-windows-x64.exe. */
export function assetName(platform = process.platform, arch = process.arch, musl = isMusl()): string {
  const os = platform === 'win32' ? 'windows' : platform;
  if (!['linux', 'darwin', 'windows'].includes(os)) throw new Error(`No release binary for ${platform}`);
  if (arch !== 'x64' && arch !== 'arm64') throw new Error(`No release binary for ${arch}`);
  if (os === 'windows') {
    if (arch !== 'x64') throw new Error('No release binary for Windows on arm64');
    return 'hedgesync-windows-x64.exe';
  }
  if (musl) {
    if (arch !== 'x64') throw new Error('No release binary for musl on arm64');
    return 'hedgesync-linux-x64-musl';
  }
  return `hedgesync-${os}-${arch}`;
}

function isMusl(): boolean {
  if (process.platform !== 'linux') return false;
  const report = (process as { report?: { getReport?: () => { header?: { glibcVersionRuntime?: string } } } }).report;
  try {
    const header = report?.getReport?.().header;
    if (header) return !header.glibcVersionRuntime;
  } catch {
    // Fall through.
  }
  return existsSync('/lib/ld-musl-x86_64.so.1') || existsSync('/lib/ld-musl-aarch64.so.1');
}

/** Compare two versions (1.2.3, 1.2.3-beta.1); negative if a < b. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [main, pre] = v.replace(/^v/, '').split('-', 2);
    return { nums: main.split('.').map(Number), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1; // a release is newer than its prereleases
  if (y.pre === undefined) return -1;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true });
}

/** The latest release's version, from where /releases/latest redirects to. */
export async function latestVersion(releases = RELEASES_URL): Promise<string> {
  const res = await fetch(`${releases}/latest`, { redirect: 'manual' });
  const location = res.headers.get('location');
  const tag = location && /\/tag\/v?([^/?#]+)$/.exec(location)?.[1];
  if (!tag) throw new Error(`Could not find the latest release at ${releases}/latest (HTTP ${res.status})`);
  return decodeURIComponent(tag);
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${url} (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** The sha256 for `asset` in a checksums.txt (sha256sum format). */
export function checksumFor(checksums: string, asset: string): string | undefined {
  for (const line of checksums.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (m && m[2] === asset) return m[1].toLowerCase();
  }
  return undefined;
}

/**
 * Download `version`'s binary for this platform, check it, and put it in
 * place of `target`. Returns the size in bytes.
 */
export async function replaceBinary(target: string, version: string, options: { releases?: string; asset?: string } = {}): Promise<number> {
  const releases = options.releases ?? RELEASES_URL;
  const asset = options.asset ?? assetName();
  const base = `${releases}/download/v${encodeURIComponent(version)}`;
  const [binary, checksums] = await Promise.all([download(`${base}/${asset}`), download(`${base}/checksums.txt`).then(b => b.toString('utf8'))]);
  const expected = checksumFor(checksums, asset);
  if (!expected) throw new Error(`checksums.txt of v${version} has no entry for ${asset}`);
  const actual = createHash('sha256').update(binary).digest('hex');
  if (actual !== expected) throw new Error(`Checksum mismatch for ${asset}: expected ${expected}, got ${actual}. Nothing was changed.`);

  // Next to the target, so the rename stays on one file system.
  const dir = dirname(target);
  const fresh = join(dir, `.${basename(target)}.new-${process.pid}`);
  writeFileSync(fresh, binary, { mode: 0o755 });
  try {
    chmodSync(fresh, 0o755);
    const r = spawnSync(fresh, ['--version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    const said = (r.stdout ?? '').trim();
    if (r.status !== 0 || said !== version) {
      throw new Error(`The downloaded binary does not run here (${r.error?.message ?? `exit ${r.status}, said "${said}"`}). Nothing was changed.`);
    }
    if (process.platform === 'win32') {
      // A running .exe cannot be overwritten, but it can be renamed.
      const old = `${target}.old`;
      rmSync(old, { force: true });
      renameSync(target, old);
      try {
        renameSync(fresh, target);
      } catch (err) {
        renameSync(old, target);
        throw err;
      }
    } else {
      renameSync(fresh, target);
    }
  } finally {
    rmSync(fresh, { force: true });
  }
  return binary.length;
}

/** Remove what a Windows update left behind (the previous .exe, once it no longer runs). */
export function cleanUpAfterUpdate(target = process.execPath): void {
  if (process.platform !== 'win32' || installKind().kind !== 'binary') return;
  try {
    rmSync(`${target}.old`, { force: true });
  } catch {
    // Still running somewhere; next time.
  }
}
