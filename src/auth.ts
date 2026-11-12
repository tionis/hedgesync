/**
 * HedgeDoc 1.x login helpers.
 *
 * HedgeDoc 1.x has two credential forms a client can post to: email/password
 * (`POST /login`) and LDAP (`POST /auth/ldap`). All other providers (OAuth2,
 * OIDC, GitHub, SAML, ...) are browser redirect flows that end in a session
 * cookie; for those, sign in with a browser and copy the cookie.
 *
 * Both forms answer success *and* failure with the same 302 redirect to the
 * front page, and the session middleware sets a cookie either way, so neither
 * the status code nor the presence of a cookie says whether the login worked.
 * After posting, we therefore ask `GET /me`, which reports `status: 'ok'` only
 * for an authenticated session.
 */

import { defaultHedgeSyncRequest, getHeader } from './http.js';
import type { HedgeSyncRequestFn, HedgeSyncHttpResponse } from './http.js';
import { DEFAULT_SESSION_COOKIE, normalizeCookie, parseSetCookie } from './cookie.js';

export { normalizeCookie, extractSessionId, parseSetCookie } from './cookie.js';

/** The account a session belongs to, as reported by `GET /me`. */
export interface SessionUser {
  id: string;
  name: string;
  photo?: string;
}

export interface AuthResult {
  /** Value of the session cookie (connect.sid, or the only cookie set). */
  sessionId: string;
  /** Cookie header to send with later requests, e.g. "connect.sid=s%3A..." */
  cookie: string;
  /** The logged-in account. */
  user: SessionUser;
  /** When the session was acquired. */
  acquiredAt: Date;
}

interface CommonAuthOptions {
  /** HedgeDoc server URL, including any sub-path. */
  serverUrl: string;
  /** Password. */
  password: string;
  /** Extra headers, e.g. for reverse proxy auth. */
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds (default: 30000). */
  timeout?: number;
  /** HTTP transport (default: global fetch). */
  request?: HedgeSyncRequestFn;
}

export interface EmailAuthOptions extends CommonAuthOptions {
  email: string;
}

export interface LDAPAuthOptions extends CommonAuthOptions {
  username: string;
}

export interface SessionCheckOptions {
  serverUrl: string;
  cookie: string;
  headers?: Record<string, string>;
  timeout?: number;
  request?: HedgeSyncRequestFn;
}

export class AuthError extends Error {
  statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
  }
}

/** Log in with HedgeDoc's built-in email/password provider. */
export function loginWithEmail(options: EmailAuthOptions): Promise<AuthResult> {
  return formLogin('/login', { email: options.email, password: options.password }, options, 'email or password');
}

/** Log in with HedgeDoc's LDAP provider. */
export function loginWithLDAP(options: LDAPAuthOptions): Promise<AuthResult> {
  return formLogin('/auth/ldap', { username: options.username, password: options.password }, options, 'username or password');
}

/**
 * Return the account a session cookie belongs to, or null if the cookie is
 * not (or no longer) logged in.
 */
export async function getSessionUser(options: SessionCheckOptions): Promise<SessionUser | null> {
  const { serverUrl, cookie, headers = {}, timeout = 30000, request = defaultHedgeSyncRequest } = options;
  const res = await withTimeout(request({
    url: `${trimUrl(serverUrl)}/me`,
    headers: { Accept: 'application/json', ...headers, Cookie: normalizeCookie(cookie) },
    redirect: 'manual',
  }), timeout);
  if (res.status !== 200) {
    throw new AuthError(`Session check failed: GET /me returned HTTP ${res.status}`, res.status);
  }
  let body: { status?: string; id?: unknown; name?: unknown; photo?: unknown };
  try {
    body = JSON.parse(await res.text());
  } catch {
    throw new AuthError('Session check failed: GET /me did not return JSON (is this a HedgeDoc 1.x server?)');
  }
  if (body.status !== 'ok') return null;
  return {
    id: String(body.id),
    name: typeof body.name === 'string' ? body.name : '',
    photo: typeof body.photo === 'string' ? body.photo : undefined,
  };
}

async function formLogin(
  path: string,
  fields: Record<string, string>,
  options: CommonAuthOptions,
  credentialNoun: string,
): Promise<AuthResult> {
  const { serverUrl, headers = {}, timeout = 30000, request = defaultHedgeSyncRequest } = options;
  const baseUrl = trimUrl(serverUrl);

  const res = await withTimeout(request({
    url: `${baseUrl}${path}`,
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  }), timeout);

  if (res.status === 404) {
    throw new AuthError(`POST ${path} returned 404; this login method is probably not enabled on the server`, 404);
  }
  if (res.status === 429) {
    throw new AuthError('Too many login attempts; try again later', 429);
  }
  if (res.status === 400) {
    throw new AuthError(`The server rejected the login request as malformed (check the ${credentialNoun.split(' ')[0]} format)`, 400);
  }
  if (res.status < 300 || res.status >= 400) {
    throw new AuthError(`Login failed: POST ${path} returned HTTP ${res.status}`, res.status);
  }

  const cookies = parseSetCookie(getHeader(res.headers, 'set-cookie'));
  if (cookies.size === 0) {
    throw new AuthError('The server set no session cookie (a proxy may be stripping Set-Cookie)');
  }
  const cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');

  const user = await getSessionUser({ serverUrl: baseUrl, cookie, headers, timeout, request });
  if (!user) {
    throw new AuthError(`Invalid ${credentialNoun}`, 401);
  }

  return {
    sessionId: cookies.get(DEFAULT_SESSION_COOKIE) ?? [...cookies.values()][0],
    cookie,
    user,
    acquiredAt: new Date(),
  };
}

function trimUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function withTimeout(p: Promise<HedgeSyncHttpResponse>, ms: number): Promise<HedgeSyncHttpResponse> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AuthError(`Request timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
