import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetName } from '../../src/self-update.js';
import { VERSION } from '../../src/version.js';

// A compiled hedgesync updating itself from a fake release server. The
// "new release" is a shell script that answers --version, so not on Windows.
describe.skipIf(process.platform === 'win32')('self-update of a release binary', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hedgesync-update-'));
  const compiled = join(tmp, 'compiled');
  const asset = assetName();
  const fresh = Buffer.from('#!/bin/sh\necho 9.9.9\n');
  let checksum = createHash('sha256').update(fresh).digest('hex');
  let latest = '9.9.9';
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    const build = Bun.spawnSync(['bun', 'build', 'bin/hedgesync.ts', '--compile', '--outfile', compiled], { stderr: 'pipe' });
    if (build.exitCode !== 0) throw new Error(build.stderr.toString());
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === '/releases/latest') return new Response(null, { status: 302, headers: { location: `/releases/tag/v${latest}` } });
        if (path === `/releases/download/v9.9.9/${asset}`) return new Response(fresh);
        if (path === '/releases/download/v9.9.9/checksums.txt') return new Response(`${checksum}  ${asset}\n`);
        return new Response('not found', { status: 404 });
      },
    });
  }, 120_000);
  afterAll(() => {
    server?.stop(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A copy of the compiled binary, and a way to run it. */
  function install(name: string) {
    const bin = join(tmp, name);
    copyFileSync(compiled, bin);
    // Async: the fake server runs in this process.
    const run = async (...args: string[]) => {
      const p = Bun.spawn([bin, ...args], {
        env: { PATH: process.env.PATH ?? '', HOME: tmp, NO_COLOR: '1', HEDGESYNC_RELEASES_URL: `${server.url.origin}/releases` },
        stdout: 'pipe', stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { code, stdout, stderr };
    };
    return { bin, run };
  }

  test('--check reports without changing anything', async () => {
    const { bin, run } = install('check');
    const before = readFileSync(bin);
    const r = await run('self-update', '--check', '--json');
    expect(JSON.parse(r.stdout)).toMatchObject({ current: VERSION, latest: '9.9.9', updateAvailable: true, install: 'binary' });
    expect(readFileSync(bin).equals(before)).toBe(true);
  });

  test('replaces the binary with the checked release', async () => {
    const { bin, run } = install('update');
    const r = await run('self-update');
    expect(r.stderr).toContain(`Updating ${VERSION} → 9.9.9`);
    expect(r.code).toBe(0);
    expect(readFileSync(bin).equals(fresh)).toBe(true);
    expect((await run('--version')).stdout.trim()).toBe('9.9.9');
  });

  test('a checksum mismatch changes nothing', async () => {
    const { bin, run } = install('mismatch');
    const before = readFileSync(bin);
    const good = checksum;
    checksum = 'f'.repeat(64);
    try {
      const r = await run('self-update');
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain('Checksum mismatch');
    } finally {
      checksum = good;
    }
    expect(readFileSync(bin).equals(before)).toBe(true);
  });

  test('up to date: nothing to do', async () => {
    const { bin, run } = install('current');
    const before = readFileSync(bin);
    latest = VERSION;
    try {
      const r = await run('self-update');
      expect(r.code).toBe(0);
      expect(r.stderr).toContain('is up to date');
    } finally {
      latest = '9.9.9';
    }
    expect(readFileSync(bin).equals(before)).toBe(true);
  });
});
