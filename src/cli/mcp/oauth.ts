/**
 * An OAuth 2.1 authorization server for `hedgesync mcp --http`, as the MCP
 * authorization spec asks for: authorization code with PKCE (S256), resource
 * indicators, refresh token rotation, clients identified by a Client ID
 * Metadata Document (an https URL) or by dynamic registration, and the
 * discovery documents (RFC 8414, RFC 9728).
 *
 * People sign in with IndieAuth: they name their website, their own
 * authorization server confirms it is them, and only the websites given with
 * --owner are let in. Everyone let in works as the HedgeDoc login of the
 * machine running the server, so owners should be the people that login
 * belongs to.
 *
 * Tokens are opaque; only their SHA-256 is stored, in mcp-oauth.json next
 * to the CLI's logins, so restarts keep agents signed in.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { OAuthError, type AuthInfo } from '@modelcontextprotocol/server';
import { cookieStorePath } from '../cookie-store.js';

const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const CODE_TTL_MS = 5 * 60_000;
/** How long someone has to approve and sign in. */
const PENDING_TTL_MS = 15 * 60_000;
const CLIENT_DOC_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_DOC_BYTES = 256 * 1024;
/** Anyone can start an authorization or name a client document: keep at most this many of each. */
const MAX_PENDING = 500;

export interface OAuthOptions {
  /** Where the server is reached, an origin such as https://mcp.example.com. */
  issuer: string;
  /** The MCP endpoint, the resource tokens are for. */
  resource: string;
  /** Websites (IndieAuth profile URLs) allowed to sign in. */
  owners: string[];
  /** Scopes that can be granted (the tool groups the server offers). */
  scopes: string[];
  /** The token store (default: mcp-oauth.json in the config directory). */
  storePath?: string;
  /** Replaces fetch, for tests. */
  fetch?: typeof fetch;
}

interface Client { name?: string; uri?: string; redirectUris: string[] }

interface StoredToken {
  kind: 'access' | 'refresh';
  clientId: string;
  scopes: string[];
  me: string;
  resource: string;
  /** Seconds since the epoch. */
  expiresAt: number;
}

interface StoreFile {
  version: 1;
  clients: Record<string, Client & { created: number }>;
  tokens: Record<string, StoredToken>;
}

/** An authorization request waiting for its owner to approve and sign in. */
interface Pending {
  clientId: string;
  client: Client;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
  created: number;
  /** Set once the person is sent to their IndieAuth server. */
  indieauth?: { me: string; endpoint: string; issuer?: string; verifier: string; state: string };
}

interface Code {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
  me: string;
  expires: number;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

/** A profile URL as IndieAuth compares them: lower-case host, at least "/" as path, no fragment. */
export function canonicalProfile(input: string): string {
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  const url = new URL(raw);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname === '') url.pathname = '/';
  return url.href;
}

const isLoopbackHost = (host: string) => host === 'localhost' || host === '[::1]' || host === '::1' || /^127\./.test(host);

/** Redirect URIs match exactly, except that loopback ones may use any port (RFC 8252). */
export function redirectMatches(registered: string, given: string): boolean {
  if (registered === given) return true;
  try {
    const a = new URL(registered);
    const b = new URL(given);
    return a.protocol === 'http:' && b.protocol === 'http:' && isLoopbackHost(a.hostname) && a.hostname === b.hostname
      && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

function pkceMatches(verifier: string, challenge: string): boolean {
  const computed = createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]!);

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>
:root{color-scheme:light dark;--bg:#f6f6f4;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--line:#e2e2dc;--accent:#2f6f4f}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ececea;--muted:#a3a39c;--card:#20201e;--line:#34342f;--accent:#7cc6a0}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px;max-width:440px;width:100%}
h1{font-size:1.25rem;margin:0 0 12px}p{margin:8px 0}.muted{color:var(--muted);font-size:.9rem}code{font-size:.9em;word-break:break-all}
ul{padding-left:20px;margin:8px 0}label{display:block;margin:16px 0 4px;font-weight:600}
input{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
.row{display:flex;gap:8px;margin-top:20px}button{flex:1;padding:9px;border-radius:8px;border:1px solid var(--line);font:inherit;cursor:pointer;background:var(--bg);color:var(--fg)}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--card);font-weight:600}
</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'content-security-policy': 'default-src \'none\'; style-src \'unsafe-inline\'; frame-ancestors \'none\'',
      'referrer-policy': 'no-referrer',
    },
  });
}

const errorPage = (message: string, status = 400) =>
  page('Cannot sign in', `<h1>Cannot sign in</h1><p>${escapeHtml(message)}</p>`, status);

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*', ...headers },
  });
}

const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status);

/** Back to the client with the result of an authorization request. */
function redirectTo(uri: string, params: Record<string, string | undefined>): Response {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { location: url.href, 'cache-control': 'no-store' } });
}

/** Link targets with a rel, from Link headers and HTML <link>/<a> tags. */
export function findRels(html: string, linkHeader: string | null, base: string): Map<string, string> {
  const rels = new Map<string, string>();
  const add = (rel: string, href: string) => {
    for (const r of rel.toLowerCase().split(/\s+/)) {
      if (r && !rels.has(r)) {
        try {
          rels.set(r, new URL(href, base).href);
        } catch {
          // ignore bad URLs
        }
      }
    }
  };
  for (const part of (linkHeader ?? '').split(/,(?=\s*<)/)) {
    const m = /<([^>]*)>(.*)/.exec(part.trim());
    const rel = m && /;\s*rel="?([^";]+)"?/i.exec(m[2]);
    if (m && rel) add(rel[1], m[1]);
  }
  for (const tag of html.match(/<(?:link|a)\b[^>]*>/gi) ?? []) {
    const rel = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (rel && href) add(rel[1] ?? rel[2] ?? rel[3], (href[1] ?? href[2] ?? href[3]).replace(/&amp;/g, '&'));
  }
  return rels;
}

export class OAuthServer {
  private readonly owners: Set<string>;
  private readonly storePath: string;
  private store: StoreFile;
  private readonly pending = new Map<string, Pending>();
  private readonly byIndieAuthState = new Map<string, string>();
  private readonly codes = new Map<string, Code>();
  private readonly clientDocs = new Map<string, { client: Client; fetched: number }>();
  private readonly fetch: typeof fetch;

  constructor(private readonly options: OAuthOptions) {
    this.owners = new Set(options.owners.map(canonicalProfile));
    this.storePath = options.storePath ?? join(dirname(cookieStorePath()), 'mcp-oauth.json');
    this.fetch = options.fetch ?? fetch;
    this.store = this.load();
  }

  get issuer(): string {
    return this.options.issuer;
  }

  private url(path: string): string {
    return new URL(path, this.options.issuer).href;
  }

  /** The IndieAuth client id: this server's own client metadata document. */
  get indieAuthClientId(): string {
    return this.url('/oauth/indieauth-client');
  }

  /** RFC 8414 metadata. */
  metadata() {
    return {
      issuer: this.options.issuer,
      authorization_endpoint: this.url('/oauth/authorize'),
      token_endpoint: this.url('/oauth/token'),
      registration_endpoint: this.url('/oauth/register'),
      revocation_endpoint: this.url('/oauth/revoke'),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: this.options.scopes,
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  }

  // --- persistence ---

  private load(): StoreFile {
    if (!existsSync(this.storePath)) return { version: 1, clients: {}, tokens: {} };
    try {
      const data = JSON.parse(readFileSync(this.storePath, 'utf8')) as Partial<StoreFile>;
      return { version: 1, clients: data.clients ?? {}, tokens: data.tokens ?? {} };
    } catch {
      return { version: 1, clients: {}, tokens: {} };
    }
  }

  private save(): void {
    const t = now();
    for (const [hash, token] of Object.entries(this.store.tokens)) if (token.expiresAt < t) delete this.store.tokens[hash];
    mkdirSync(dirname(this.storePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.storePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.store, null, 2), { mode: 0o600 });
    renameSync(tmp, this.storePath);
  }

  private sweep(): void {
    const t = Date.now();
    for (const [id, p] of this.pending) {
      if (t - p.created > PENDING_TTL_MS) {
        this.pending.delete(id);
        if (p.indieauth) this.byIndieAuthState.delete(p.indieauth.state);
      }
    }
    for (const [code, c] of this.codes) if (c.expires < t) this.codes.delete(code);
  }

  // --- tokens ---

  /** Verifies an access token, for requireBearerAuth. */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = this.store.tokens[sha256(token)];
    if (!stored || stored.kind !== 'access' || stored.expiresAt < now()) {
      throw new OAuthError('invalid_token', 'The access token is unknown or expired');
    }
    return {
      token, clientId: stored.clientId, scopes: stored.scopes, expiresAt: stored.expiresAt,
      resource: new URL(stored.resource), extra: { me: stored.me },
    };
  }

  private issueTokens(grant: { clientId: string; scopes: string[]; me: string; resource: string }) {
    const access = random();
    const refresh = random();
    const t = now();
    this.store.tokens[sha256(access)] = { kind: 'access', ...grant, expiresAt: t + ACCESS_TTL_S };
    this.store.tokens[sha256(refresh)] = { kind: 'refresh', ...grant, expiresAt: t + REFRESH_TTL_S };
    this.save();
    return {
      access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S,
      refresh_token: refresh, scope: grant.scopes.join(' '),
    };
  }

  // --- clients ---

  /** A client by its id: a registered one, or a Client ID Metadata Document at that URL. */
  private async client(clientId: string): Promise<Client> {
    const registered = this.store.clients[clientId];
    if (registered) return registered;
    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      throw new Error('Unknown client_id');
    }
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname))) || url.pathname === '/' || url.hash) {
      throw new Error('client_id must be a registered id or an https URL with a path (a Client ID Metadata Document)');
    }
    const cached = this.clientDocs.get(clientId);
    if (cached && Date.now() - cached.fetched < CLIENT_DOC_TTL_MS) return cached.client;
    const res = await this.fetch(clientId, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Could not fetch the client's metadata document (${res.status})`);
    const text = await res.text();
    if (text.length > MAX_DOC_BYTES) throw new Error('The client\'s metadata document is too large');
    let doc: { client_id?: string; client_name?: string; client_uri?: string; redirect_uris?: unknown };
    try {
      doc = JSON.parse(text);
    } catch {
      throw new Error('The client\'s metadata document is not JSON');
    }
    if (doc.client_id !== clientId) throw new Error('The client\'s metadata document names a different client_id');
    if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.every(u => typeof u === 'string')) {
      throw new Error('The client\'s metadata document has no redirect_uris');
    }
    const client = { name: doc.client_name, uri: doc.client_uri, redirectUris: doc.redirect_uris as string[] };
    if (this.clientDocs.size >= MAX_PENDING) this.clientDocs.delete(this.clientDocs.keys().next().value!);
    this.clientDocs.set(clientId, { client, fetched: Date.now() });
    return client;
  }

  /** POST /oauth/register: dynamic client registration (RFC 7591), public clients only. */
  async register(req: Request): Promise<Response> {
    let body: { redirect_uris?: unknown; client_name?: unknown; client_uri?: unknown };
    try {
      body = await req.json() as typeof body;
    } catch {
      return oauthError('invalid_client_metadata', 'Expected a JSON body');
    }
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every(u => typeof u === 'string')) {
      return oauthError('invalid_redirect_uri', 'redirect_uris must be a non-empty list of URLs');
    }
    for (const u of uris as string[]) {
      let url: URL;
      try {
        url = new URL(u);
      } catch {
        return oauthError('invalid_redirect_uri', `Not a URL: ${u}`);
      }
      if (url.hash || (url.protocol === 'http:' && !isLoopbackHost(url.hostname))) {
        return oauthError('invalid_redirect_uri', `${u}: use https, a loopback http URL, or an app scheme`);
      }
    }
    const id = `client-${random()}`;
    const name = typeof body.client_name === 'string' ? body.client_name.slice(0, 200) : undefined;
    const uri = typeof body.client_uri === 'string' ? body.client_uri.slice(0, 500) : undefined;
    // A crowd of registrations would grow the file forever: keep the newest.
    const entries = Object.entries(this.store.clients).sort((a, b) => b[1].created - a[1].created).slice(0, 499);
    this.store.clients = Object.fromEntries(entries);
    this.store.clients[id] = { name, uri, redirectUris: uris as string[], created: Date.now() };
    this.save();
    return json({
      client_id: id, client_id_issued_at: now(), redirect_uris: uris, client_name: name, client_uri: uri,
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    }, 201);
  }

  private scopesFrom(scope: string | null): string[] | undefined {
    if (!scope?.trim()) return [...this.options.scopes];
    const wanted = scope.split(/\s+/).filter(Boolean);
    const granted = wanted.filter(s => this.options.scopes.includes(s));
    return granted.length ? granted : undefined;
  }

  private resourceMatches(given: string | null): boolean {
    if (!given) return true;
    const trim = (s: string) => s.replace(/\/+$/, '');
    return trim(given) === trim(this.options.resource) || trim(given) === trim(this.options.issuer);
  }

  // --- authorization ---

  /** GET /oauth/authorize: check the request, then ask the owner to approve it. */
  async authorize(req: Request): Promise<Response> {
    this.sweep();
    const q = new URL(req.url).searchParams;
    const clientId = q.get('client_id');
    const redirectUri = q.get('redirect_uri');
    if (!clientId || !redirectUri) return errorPage('The app did not say who it is (client_id and redirect_uri are required).');
    let client: Client;
    try {
      client = await this.client(clientId);
    } catch (err) {
      return errorPage(`${(err as Error).message}.`);
    }
    if (!client.redirectUris.some(r => redirectMatches(r, redirectUri))) {
      return errorPage('The app asked to be sent back to an address it has not registered.');
    }
    const state = q.get('state') ?? undefined;
    const fail = (error: string, description: string) =>
      redirectTo(redirectUri, { error, error_description: description, state, iss: this.options.issuer });
    if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported');
    const challenge = q.get('code_challenge');
    if (!challenge || q.get('code_challenge_method') !== 'S256') return fail('invalid_request', 'PKCE with S256 is required');
    if (!this.resourceMatches(q.get('resource'))) return fail('invalid_target', `This server only issues tokens for ${this.options.resource}`);
    const scopes = this.scopesFrom(q.get('scope'));
    if (!scopes) return fail('invalid_scope', `Scopes offered: ${this.options.scopes.join(' ')}`);

    const id = random();
    if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(id, {
      clientId, client, redirectUri, state, codeChallenge: challenge, scopes,
      resource: this.options.resource, created: Date.now(),
    });
    return this.consentPage(id, this.pending.get(id)!);
  }

  private consentPage(id: string, p: Pending, problem?: string): Response {
    const app = p.client.name || new URL(p.clientId.startsWith('http') ? p.clientId : p.redirectUri).host || p.clientId;
    const back = (() => {
      try {
        return new URL(p.redirectUri).host || p.redirectUri;
      } catch {
        return p.redirectUri;
      }
    })();
    const what: Record<string, string> = {
      read: 'Read and search your notes, and see who is in them',
      edit: 'Change your notes',
      create: 'Create notes',
    };
    const owners = [...this.owners];
    return page('Allow access to HedgeDoc notes', `
<h1>Allow ${escapeHtml(app)} to use your HedgeDoc notes?</h1>
${problem ? `<p><strong>${escapeHtml(problem)}</strong></p>` : ''}
<ul>${p.scopes.map(s => `<li>${escapeHtml(what[s] ?? s)}</li>`).join('')}</ul>
<p class="muted">It acts as the HedgeDoc account this server is signed in with. Afterwards you are sent back to <code>${escapeHtml(back)}</code>.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="request" value="${escapeHtml(id)}">
<label for="me">Sign in with your website</label>
<input id="me" name="me" type="url" required autocomplete="url" value="${escapeHtml(owners.length === 1 ? owners[0] : '')}" placeholder="https://you.example.com/">
<div class="row"><button type="submit" name="decision" value="deny">Deny</button><button class="primary" type="submit" name="decision" value="allow">Allow</button></div>
</form>`);
  }

  /** POST /oauth/authorize: the owner's decision; on allow, off to their IndieAuth server. */
  async decide(req: Request): Promise<Response> {
    this.sweep();
    const form = new URLSearchParams(await req.text());
    const id = form.get('request') ?? '';
    const p = this.pending.get(id);
    if (!p || p.indieauth) return errorPage('This sign-in has expired. Start again from the app.');
    if (form.get('decision') !== 'allow') {
      this.pending.delete(id);
      return redirectTo(p.redirectUri, { error: 'access_denied', error_description: 'The owner denied access', state: p.state, iss: this.options.issuer });
    }
    let me: string;
    try {
      me = canonicalProfile(form.get('me') ?? '');
    } catch {
      return this.consentPage(id, p, 'That is not a web address.');
    }
    if (!this.owners.has(me)) return this.consentPage(id, p, `${me} may not use this server.`);
    let endpoints: { authorization: string; issuer?: string };
    try {
      endpoints = await this.discover(me);
    } catch (err) {
      return this.consentPage(id, p, `Could not find your IndieAuth server: ${(err as Error).message}`);
    }
    const verifier = random();
    const state = random();
    p.indieauth = { me, endpoint: endpoints.authorization, issuer: endpoints.issuer, verifier, state };
    this.byIndieAuthState.set(state, id);
    const url = new URL(endpoints.authorization);
    for (const [k, v] of Object.entries({
      response_type: 'code', client_id: this.indieAuthClientId, redirect_uri: this.url('/oauth/indieauth-callback'),
      state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', me,
    })) url.searchParams.set(k, v);
    return new Response(null, { status: 302, headers: { location: url.href, 'cache-control': 'no-store' } });
  }

  /** IndieAuth discovery: metadata via rel=indieauth-metadata, or the older rel=authorization_endpoint. */
  async discover(me: string): Promise<{ authorization: string; issuer?: string }> {
    const res = await this.fetch(me, { headers: { accept: 'text/html, application/xhtml+xml' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${me} answered ${res.status}`);
    const html = (await res.text()).slice(0, MAX_DOC_BYTES);
    const rels = findRels(html, res.headers.get('link'), res.url || me);
    const metadataUrl = rels.get('indieauth-metadata');
    if (metadataUrl) {
      const m = await this.fetch(metadataUrl, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!m.ok) throw new Error(`its metadata (${metadataUrl}) answered ${m.status}`);
      const meta = await m.json() as { authorization_endpoint?: string; issuer?: string };
      if (!meta.authorization_endpoint) throw new Error('its metadata has no authorization_endpoint');
      return { authorization: meta.authorization_endpoint, issuer: meta.issuer };
    }
    const authorization = rels.get('authorization_endpoint');
    if (!authorization) throw new Error(`${me} links no IndieAuth server (rel="indieauth-metadata")`);
    return { authorization };
  }

  /** GET /oauth/indieauth-callback: the owner's IndieAuth server sends them back here. */
  async indieAuthCallback(req: Request): Promise<Response> {
    this.sweep();
    const q = new URL(req.url).searchParams;
    const id = this.byIndieAuthState.get(q.get('state') ?? '');
    const p = id ? this.pending.get(id) : undefined;
    if (!id || !p?.indieauth) return errorPage('This sign-in has expired. Start again from the app.');
    this.byIndieAuthState.delete(p.indieauth.state);
    this.pending.delete(id);
    const back = (error: string, description: string) =>
      redirectTo(p.redirectUri, { error, error_description: description, state: p.state, iss: this.options.issuer });
    if (q.get('error')) return back('access_denied', `Sign-in failed: ${q.get('error_description') ?? q.get('error')}`);
    if (p.indieauth.issuer && q.get('iss') !== p.indieauth.issuer) return back('access_denied', 'Sign-in failed: the answer came from the wrong server');
    const code = q.get('code');
    if (!code) return back('access_denied', 'Sign-in failed: no code');

    let me: string;
    try {
      const res = await this.fetch(p.indieauth.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code, client_id: this.indieAuthClientId,
          redirect_uri: this.url('/oauth/indieauth-callback'), code_verifier: p.indieauth.verifier,
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const body = await res.json() as { me?: string; error?: string };
      if (!res.ok || !body.me) throw new Error(body.error ?? `status ${res.status}`);
      me = canonicalProfile(body.me);
    } catch (err) {
      return back('access_denied', `Sign-in could not be confirmed: ${(err as Error).message}`);
    }
    // The answer must be for the person we sent there, whose server we asked.
    if (me !== p.indieauth.me || !this.owners.has(me)) return back('access_denied', `${me} may not use this server`);

    const ours = random();
    this.codes.set(ours, {
      clientId: p.clientId, redirectUri: p.redirectUri, codeChallenge: p.codeChallenge,
      scopes: p.scopes, resource: p.resource, me, expires: Date.now() + CODE_TTL_MS,
    });
    return redirectTo(p.redirectUri, { code: ours, state: p.state, iss: this.options.issuer });
  }

  /** POST /oauth/token: authorization_code and refresh_token grants. */
  async token(req: Request): Promise<Response> {
    this.sweep();
    const form = new URLSearchParams(await req.text());
    const clientId = form.get('client_id');
    switch (form.get('grant_type')) {
      case 'authorization_code': {
        const code = this.codes.get(form.get('code') ?? '');
        if (!code) return oauthError('invalid_grant', 'Unknown, used or expired code');
        this.codes.delete(form.get('code')!); // single use
        if (clientId !== code.clientId) return oauthError('invalid_grant', 'The code was issued to another client');
        if (form.get('redirect_uri') !== code.redirectUri) return oauthError('invalid_grant', 'redirect_uri differs from the authorization request');
        if (!pkceMatches(form.get('code_verifier') ?? '', code.codeChallenge)) return oauthError('invalid_grant', 'PKCE verification failed');
        if (!this.resourceMatches(form.get('resource'))) return oauthError('invalid_target', `Tokens are only for ${this.options.resource}`);
        return json(this.issueTokens({ clientId: code.clientId, scopes: code.scopes, me: code.me, resource: code.resource }));
      }
      case 'refresh_token': {
        const hash = sha256(form.get('refresh_token') ?? '');
        const stored = this.store.tokens[hash];
        if (!stored || stored.kind !== 'refresh' || stored.expiresAt < now()) return oauthError('invalid_grant', 'Unknown or expired refresh token');
        if (clientId && clientId !== stored.clientId) return oauthError('invalid_grant', 'The token was issued to another client');
        if (!this.owners.has(stored.me)) return oauthError('invalid_grant', 'This user may no longer use the server');
        let scopes = stored.scopes.filter(s => this.options.scopes.includes(s));
        const asked = form.get('scope');
        if (asked) {
          const wanted = asked.split(/\s+/).filter(Boolean);
          if (wanted.some(s => !scopes.includes(s))) return oauthError('invalid_scope', 'A refresh cannot add scopes');
          scopes = wanted;
        }
        delete this.store.tokens[hash]; // rotation
        return json(this.issueTokens({ clientId: stored.clientId, scopes, me: stored.me, resource: stored.resource }));
      }
      default:
        return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
    }
  }

  /** POST /oauth/revoke (RFC 7009): forget a token; always 200. */
  async revoke(req: Request): Promise<Response> {
    const form = new URLSearchParams(await req.text());
    const hash = sha256(form.get('token') ?? '');
    if (this.store.tokens[hash]) {
      delete this.store.tokens[hash];
      this.save();
    }
    return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
  }

  /** This server as an IndieAuth client (its client metadata document). */
  indieAuthClient(): Response {
    return json({
      client_id: this.indieAuthClientId,
      client_name: 'hedgesync MCP server',
      client_uri: this.options.issuer + '/',
      redirect_uris: [this.url('/oauth/indieauth-callback')],
    });
  }

  /** Routes the authorization server's own endpoints; undefined for other paths. */
  async route(req: Request): Promise<Response | undefined> {
    const { pathname } = new URL(req.url);
    const method = req.method;
    if (method === 'OPTIONS' && pathname.startsWith('/oauth/')) {
      return new Response(null, {
        status: 204,
        headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type, authorization' },
      });
    }
    if (pathname === '/oauth/authorize' && method === 'GET') return this.authorize(req);
    if (pathname === '/oauth/authorize' && method === 'POST') return this.decide(req);
    if (pathname === '/oauth/indieauth-callback' && method === 'GET') return this.indieAuthCallback(req);
    if (pathname === '/oauth/token' && method === 'POST') return this.token(req);
    if (pathname === '/oauth/register' && method === 'POST') return this.register(req);
    if (pathname === '/oauth/revoke' && method === 'POST') return this.revoke(req);
    if (pathname === '/oauth/indieauth-client' && method === 'GET') return this.indieAuthClient();
    if (pathname.startsWith('/oauth/')) return oauthError('invalid_request', 'Unknown endpoint or method', 404);
    return undefined;
  }
}
