/**
 * End-to-end: `hedgesync mcp --http`, with a fixed token and with OAuth 2.1
 * sign-in through a stand-in IndieAuth server, the way an agent host and a
 * person's browser would go through it.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTestServer, type TestServer } from './server.js';

setDefaultTimeout(60_000);

const CLI = join(import.meta.dir, '../../bin/hedgesync.ts');
const tmp = mkdtempSync(join(tmpdir(), 'hedgesync-mcp-http-'));
let hedgedoc: TestServer;

/** A stand-in IndieAuth server; `me` is who it says signed in. */
let indieAuthMe = '';
const indie = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    const self = `http://127.0.0.1:${indie.port}`;
    if (url.pathname === '/') {
      return new Response(`<html><head><link rel="indieauth-metadata" href="/meta"></head><body>me</body></html>`, { headers: { 'content-type': 'text/html' } });
    }
    if (url.pathname === '/meta') return Response.json({ issuer: `${self}/`, authorization_endpoint: `${self}/auth` });
    if (url.pathname === '/auth' && req.method === 'GET') {
      // Signs the person in at once and sends them back.
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', `code-for-${url.searchParams.get('code_challenge')}`);
      back.searchParams.set('state', url.searchParams.get('state')!);
      back.searchParams.set('iss', `${self}/`);
      return Response.redirect(back.href, 302);
    }
    if (url.pathname === '/auth' && req.method === 'POST') {
      const form = new URLSearchParams(await req.text());
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (form.get('code') !== `code-for-${challenge}`) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ me: indieAuthMe || `${self}/` });
    }
    if (url.pathname === '/client.json') {
      return Response.json({ client_id: `${self}/client.json`, client_name: 'Doc Client', redirect_uris: ['http://127.0.0.1/callback'] });
    }
    return new Response('nope', { status: 404 });
  },
});
const profile = () => `http://127.0.0.1:${indie.port}/`;

beforeAll(async () => {
  hedgedoc = await startTestServer();
});
afterAll(async () => {
  await hedgedoc?.close();
  indie.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

/** `hedgesync mcp --http` on a free port; resolves with its /mcp URL. */
async function startHttp(...args: string[]) {
  const proc = Bun.spawn(['bun', CLI, 'mcp', '--server', hedgedoc.url, '--http', '127.0.0.1:0', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH ?? '', HOME: tmp, NO_COLOR: '1',
      HEDGESYNC_COOKIE_FILE: join(tmp, 'cookies.json'), HEDGEDOC_COOKIE: 'connect.sid=good',
    },
  });
  // Keep reading stderr: a closed pipe would end the server at its next message.
  let log = '';
  const decoder = new TextDecoder();
  const started = new Promise<string>((resolve, reject) => {
    (async () => {
      for await (const chunk of proc.stderr) {
        log += decoder.decode(chunk);
        const m = /MCP server at (\S+)/.exec(log);
        if (m) resolve(m[1]);
      }
      reject(new Error(`mcp --http did not start:\n${log}`));
    })();
  });
  const url = await started;
  return { proc, url, origin: new URL(url).origin };
}

const headers = (token?: string) => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-11-25',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

/** One JSON-RPC call over HTTP (2025 stateless), parsed from JSON or SSE. */
async function rpc(url: string, method: string, params: object = {}, token?: string): Promise<{ status: number; body: any; res: Response }> {
  const res = await fetch(url, { method: 'POST', headers: headers(token), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const text = await res.text();
  const data = /^data: (.*)$/m.exec(text)?.[1] ?? text;
  let body: any;
  try {
    body = JSON.parse(data);
  } catch {
    body = text;
  }
  return { status: res.status, body, res };
}

const toolNames = (r: { body: any }) => r.body.result.tools.map((t: { name: string }) => t.name);

describe('hedgesync mcp --http', () => {
  test('a fixed bearer token', async () => {
    const { proc, url } = await startHttp('--token', 's3cret', '--read-only');
    try {
      expect((await rpc(url, 'tools/list')).status).toBe(401);
      expect((await rpc(url, 'tools/list', {}, 'wrong')).status).toBe(401);
      const list = await rpc(url, 'tools/list', {}, 's3cret');
      expect(toolNames(list)).toEqual(['list_notes', 'search_notes', 'read_note', 'wait_for_change']);
      Object.assign(hedgedoc.note('http-token'), { document: 'over http\n', permission: 'freely' });
      const read = await rpc(url, 'tools/call', { name: 'read_note', arguments: { url: `${hedgedoc.url}/http-token` } }, 's3cret');
      expect(read.body.result.content[0].text).toContain('1│over http');
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  test('refuses to serve the network without authentication', async () => {
    const res = Bun.spawnSync(['bun', CLI, 'mcp', '--http', '0.0.0.0:0'], { env: { PATH: process.env.PATH ?? '', HOME: tmp, NO_COLOR: '1' } });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr.toString()).toContain('without authentication');
  });

  test('OAuth 2.1 sign-in through IndieAuth, scopes picking the tools', async () => {
    const { proc, url, origin } = await startHttp('--owner', profile());
    try {
      // Unauthenticated: a challenge pointing at the resource metadata.
      const challenge = await rpc(url, 'tools/list');
      expect(challenge.status).toBe(401);
      const www = challenge.res.headers.get('www-authenticate')!;
      const prmUrl = /resource_metadata="([^"]+)"/.exec(www)![1];
      const prm = await (await fetch(prmUrl)).json() as { resource: string; authorization_servers: string[]; scopes_supported: string[] };
      expect(prm.resource).toBe(url);
      expect(prm.scopes_supported).toEqual(['read', 'edit', 'create']);
      const as = await (await fetch(`${prm.authorization_servers[0].replace(/\/$/, '')}/.well-known/oauth-authorization-server`)).json() as Record<string, any>;
      expect(as).toMatchObject({ issuer: origin, code_challenge_methods_supported: ['S256'], client_id_metadata_document_supported: true });

      // Dynamic registration.
      const reg = await (await fetch(as.registration_endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Test Agent', redirect_uris: ['http://127.0.0.1:9999/cb'] }),
      })).json() as { client_id: string };

      const signIn = async (clientId: string, redirectUri: string, scope: string, me = profile()) => {
        const verifier = randomBytes(32).toString('base64url');
        const authorize = new URL(as.authorization_endpoint);
        for (const [k, v] of Object.entries({
          response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state: 'xyz', scope, resource: url,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
        })) authorize.searchParams.set(k, v);
        const consent = await (await fetch(authorize)).text();
        const request = /name="request" value="([^"]+)"/.exec(consent)?.[1];
        if (!request) throw new Error(consent);
        // The person approves; off to their IndieAuth server, which sends them back.
        const toIndie = await fetch(as.authorization_endpoint, {
          method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ request, me, decision: 'allow' }),
        });
        if (toIndie.status !== 302) return { error: await toIndie.text() };
        const toCallback = await fetch(toIndie.headers.get('location')!, { redirect: 'manual' });
        const toClient = await fetch(toCallback.headers.get('location')!, { redirect: 'manual' });
        const back = new URL(toClient.headers.get('location')!);
        expect(back.searchParams.get('state')).toBe('xyz');
        expect(back.searchParams.get('iss')).toBe(origin);
        const code = back.searchParams.get('code');
        if (!code) return { error: back.searchParams.get('error_description') };
        const tokenRes = await fetch(as.token_endpoint, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier, resource: url }),
        });
        const tokens = await tokenRes.json() as { access_token: string; refresh_token: string; scope: string };
        // Codes are single use.
        const again = await fetch(as.token_endpoint, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier }),
        });
        expect(again.status).toBe(400);
        return { tokens };
      };

      // A registered client, any loopback port, read-only scope.
      const readOnly = await signIn(reg.client_id, 'http://127.0.0.1:41234/cb', 'read');
      expect(readOnly.tokens!.scope).toBe('read');
      expect(toolNames(await rpc(url, 'tools/list', {}, readOnly.tokens!.access_token))).toEqual(['list_notes', 'search_notes', 'read_note', 'wait_for_change']);

      // A client identified by its metadata document, all scopes.
      const doc = `http://127.0.0.1:${indie.port}/client.json`;
      const full = await signIn(doc, 'http://127.0.0.1/callback', '');
      expect(toolNames(await rpc(url, 'tools/list', {}, full.tokens!.access_token))).toContain('create_note');

      // Refresh rotates the token.
      const refreshed = await (await fetch(as.token_endpoint, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: full.tokens!.refresh_token, client_id: doc }),
      })).json() as { access_token: string };
      expect(toolNames(await rpc(url, 'tools/list', {}, refreshed.access_token))).toContain('create_note');
      const reused = await fetch(as.token_endpoint, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: full.tokens!.refresh_token }),
      });
      expect(reused.status).toBe(400);

      // Someone else's website is turned away before IndieAuth.
      const stranger = await signIn(reg.client_id, 'http://127.0.0.1:9999/cb', 'read', 'https://stranger.example/');
      expect(stranger.error).toContain('may not use this server');
      // An IndieAuth answer for someone else is refused.
      indieAuthMe = 'https://stranger.example/';
      const spoofed = await signIn(reg.client_id, 'http://127.0.0.1:9999/cb', 'read');
      indieAuthMe = '';
      expect(spoofed.error).toContain('may not use this server');

      // Unregistered redirect URIs never get a redirect.
      const bad = new URL(as.authorization_endpoint);
      for (const [k, v] of Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://evil.example/cb', code_challenge: 'x', code_challenge_method: 'S256' })) bad.searchParams.set(k, v);
      const badRes = await fetch(bad, { redirect: 'manual' });
      expect(badRes.status).toBe(400);
      expect(await badRes.text()).toContain('has not registered');

      // Tokens are stored hashed.
      const stored = readFileSync(join(tmp, 'mcp-oauth.json'), 'utf8');
      expect(stored).not.toContain(refreshed.access_token);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
});
