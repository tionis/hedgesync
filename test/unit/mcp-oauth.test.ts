import { describe, expect, test } from 'bun:test';
import { parseListen } from '../../src/cli/commands/mcp.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cacheLifetimeMs, canonicalProfile, findRels, isPrivateAddress, OAuthServer, parseClientDocument, redirectMatches } from '../../src/cli/mcp/oauth.js';
import { outline, parseLineRange } from '../../src/cli/mcp/tools.js';

describe('IndieAuth helpers', () => {
  test('profile URLs are compared in canonical form', () => {
    expect(canonicalProfile('Example.COM')).toBe('https://example.com/');
    expect(canonicalProfile('https://example.com/me#x')).toBe('https://example.com/me');
    expect(canonicalProfile(' http://localhost:8080 ')).toBe('http://localhost:8080/');
  });

  test('rels from Link headers and HTML, header first', () => {
    const html = `<link rel="authorization_endpoint" href="/auth"><a rel='me indieauth-metadata' href=https://x.example/meta>`;
    const rels = findRels(html, '<https://h.example/meta>; rel="indieauth-metadata", </tok>; rel=token_endpoint', 'https://me.example/p/');
    expect(rels.get('indieauth-metadata')).toBe('https://h.example/meta');
    expect(rels.get('token_endpoint')).toBe('https://me.example/tok');
    expect(rels.get('authorization_endpoint')).toBe('https://me.example/auth');
    expect(rels.get('me')).toBe('https://x.example/meta');
  });

  test('redirect URIs match exactly, loopback on any port', () => {
    expect(redirectMatches('https://app.example/cb', 'https://app.example/cb')).toBe(true);
    expect(redirectMatches('https://app.example/cb', 'https://app.example/cb2')).toBe(false);
    expect(redirectMatches('http://127.0.0.1/cb', 'http://127.0.0.1:5555/cb')).toBe(true);
    expect(redirectMatches('http://localhost:1/cb', 'http://localhost:2/other')).toBe(false);
    expect(redirectMatches('http://app.example:1/cb', 'http://app.example:2/cb')).toBe(false);
  });
});

describe('mcp helpers', () => {
  test('--http values', () => {
    expect(parseListen('8788')).toEqual({ host: '127.0.0.1', port: 8788 });
    expect(parseListen('0.0.0.0:80')).toEqual({ host: '0.0.0.0', port: 80 });
    expect(parseListen('[::1]:9')).toEqual({ host: '::1', port: 9 });
    expect(() => parseListen('nope')).toThrow('Invalid --http');
  });

  test('line ranges and outlines', () => {
    expect(parseLineRange('3-5', 10)).toEqual({ from: 3, to: 5 });
    expect(parseLineRange('7-', 10)).toEqual({ from: 7, to: 10 });
    expect(parseLineRange('4', 10)).toEqual({ from: 4, to: 4 });
    expect(parseLineRange('8-99', 10)).toEqual({ from: 8, to: 10 });
    expect(() => parseLineRange('11', 10)).toThrow('past its end');
    expect(() => parseLineRange('5-2', 10)).toThrow('before the start');
    expect(outline('# A\ntext\n## B\n')).toBe('    1  # A\n    3  ## B');
  });
});

describe('Client ID Metadata Documents', () => {
  const id = 'https://app.example/oauth/client.json';
  const doc = (extra: object = {}) => JSON.stringify({ client_id: id, client_name: 'App', redirect_uris: ['http://127.0.0.1/cb'], ...extra });

  test('documents are validated', () => {
    expect(parseClientDocument(id, doc())).toMatchObject({ name: 'App', redirectUris: ['http://127.0.0.1/cb'], document: true });
    expect(() => parseClientDocument(id, 'nope')).toThrow('not JSON');
    expect(() => parseClientDocument(id, doc({ client_id: 'https://other.example/c.json' }))).toThrow('different client_id');
    expect(() => parseClientDocument(id, doc({ client_name: '' }))).toThrow('no client_name');
    expect(() => parseClientDocument(id, doc({ redirect_uris: [] }))).toThrow('no redirect_uris');
    expect(() => parseClientDocument(id, doc({ redirect_uris: ['http://evil.example/cb'] }))).toThrow('neither https');
    expect(() => parseClientDocument(id, doc({ token_endpoint_auth_method: 'private_key_jwt' }))).toThrow('only supports public clients');
    expect(() => parseClientDocument(id, doc({ grant_types: ['client_credentials'] }))).toThrow('authorization_code');
    expect(parseClientDocument(id, doc({ token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] })).name).toBe('App');
  });

  test('private addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['93.184.216.34', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) expect(isPrivateAddress(ip)).toBe(false);
  });

  test('cache lifetimes follow the headers', () => {
    expect(cacheLifetimeMs(new Headers({ 'cache-control': 'max-age=60' }))).toBe(60_000);
    expect(cacheLifetimeMs(new Headers({ 'cache-control': 'no-store' }))).toBe(0);
    expect(cacheLifetimeMs(new Headers({ 'cache-control': 'max-age=9999999' }))).toBe(24 * 3600_000);
    expect(cacheLifetimeMs(new Headers({ expires: new Date(1_000_000 + 30_000).toUTCString() }), 1_000_000)).toBe(30_000);
    expect(cacheLifetimeMs(new Headers())).toBe(600_000);
  });

  test('the authorization server fetches, checks, caches and shows them', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'hedgesync-cimd-'));
    let fetches = 0;
    let body = doc();
    let headers: Record<string, string> = { 'cache-control': 'max-age=300' };
    let address = '93.184.216.34';
    const server = new OAuthServer({
      issuer: 'https://mcp.example', resource: 'https://mcp.example/mcp', owners: ['https://me.example/'], scopes: ['read'],
      storePath: join(tmp, 'oauth.json'),
      lookup: async () => [address],
      fetch: (async () => {
        fetches++;
        return new Response(body, { headers: { 'content-type': 'application/json', ...headers } });
      }) as typeof fetch,
    });
    const authorize = (clientId = id, redirect = 'http://127.0.0.1:4567/cb') => server.authorize(new Request(
      `https://mcp.example/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=abc&code_challenge_method=S256`,
    ));
    try {
      const page = await (await authorize()).text();
      expect(page).toContain('Allow App to use');
      expect(page).toContain('come from <code>app.example</code>');
      expect(page).toContain('sent to <code>127.0.0.1:4567</code>');
      expect(page).toContain('on your own computer');
      await authorize();
      expect(fetches).toBe(1); // cached (max-age)

      expect(await (await authorize(id, 'https://evil.example/cb')).text()).toContain('has not registered');

      headers = { 'cache-control': 'no-store' };
      body = doc({ client_id: 'https://app.example/oauth/client2.json' });
      const id2 = 'https://app.example/oauth/client2.json';
      await authorize(id2);
      await authorize(id2);
      expect(fetches).toBe(3); // no-store: fetched each time

      address = '10.0.0.5';
      const internal = await authorize('https://intranet.example/client.json');
      expect(internal.status).toBe(400);
      expect(await internal.text()).toContain('private address');
      expect(fetches).toBe(3); // never fetched

      expect(await (await authorize('http://app.example/client.json')).text()).toContain('https URL with a path');
      expect(await (await authorize('https://app.example/')).text()).toContain('https URL with a path');

      address = '93.184.216.34';
      headers = {};
      body = 'x'.repeat(20_000);
      expect(await (await authorize('https://app.example/big.json')).text()).toContain('too large');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
