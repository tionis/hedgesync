/**
 * Every example runs against the HedgeDoc stand-in, so they cannot rot.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isPandocAvailable } from '../../src/pandoc-transformer.js';
import { startTestServer, type TestServer } from './server.js';

const dir = join(import.meta.dir, '../../examples');
let server: TestServer;
beforeAll(async () => {
  server = await startTestServer();
});
afterAll(() => server.close());

const fixture = '# Title\n\nTODO: foo [a link](https://example.com)\n{{DATE}}\n::BEGIN:sort::\nb\na\n::END:sort::\n';
const hasPandoc = await isPandocAvailable();

for (const file of readdirSync(dir).filter(f => f.endsWith('.js'))) {
  const skip = file === 'pandoc-transform.js' && !hasPandoc;
  test.skipIf(skip)(file, async () => {
    const id = file.replace(/\W/g, '-');
    server.note(id).document = fixture;
    const proc = Bun.spawn(['bun', join(dir, file), `${server.url}/${id}`, '--write'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '', HEDGESYNC_EXAMPLE_DURATION_MS: '300' },
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) console.error(stdout, stderr);
    expect(code).toBe(0);
    expect(stderr).not.toContain('Error');
  }, 15000);
}
