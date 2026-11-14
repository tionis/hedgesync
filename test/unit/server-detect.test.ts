import { describe, expect, test } from 'bun:test';
import { detectServer } from '../../src/server-detect.js';
import type { HedgeSyncHttpRequest } from '../../src/http.js';

function fakeServer(routes: Record<string, [number, string]>) {
  return async (req: HedgeSyncHttpRequest) => {
    const path = new URL(req.url).pathname;
    const [status, body] = routes[path] ?? [404, 'Not found'];
    return { status, headers: {}, text: async () => body, json: async () => JSON.parse(body), arrayBuffer: async () => new ArrayBuffer(0) };
  };
}

describe('detectServer', () => {
  test('HedgeDoc 1 via the /config script', async () => {
    const request = fakeServer({ '/hd/config': [200, "window.version = '1.10.3'\nwindow.urlpath = 'hd'"] });
    expect(await detectServer({ serverUrl: 'https://x.test/hd/', request })).toEqual({ protocol: 'hedgedoc1', version: '1.10.3' });
  });

  test('HedgeDoc 2 via /api/private/config', async () => {
    const request = fakeServer({
      '/api/private/config': [200, JSON.stringify({ version: { major: 2, minor: 1, patch: 0 } })],
      '/config': [200, '<html>frontend</html>'],
    });
    expect(await detectServer({ serverUrl: 'https://x.test', request })).toEqual({ protocol: 'hedgedoc2', version: '2.1.0' });
  });

  test('anything else is unknown, including HTML answers and network errors', async () => {
    const html = fakeServer({ '/api/private/config': [200, '<html>'], '/config': [200, '<html>'] });
    expect(await detectServer({ serverUrl: 'https://x.test', request: html })).toEqual({ protocol: null, version: null });
    const down = async () => { throw new Error('ECONNREFUSED'); };
    expect(await detectServer({ serverUrl: 'https://x.test', request: down })).toEqual({ protocol: null, version: null });
  });
});
