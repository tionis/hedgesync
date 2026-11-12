/**
 * Cookie utility helpers shared across runtime profiles.
 *
 * HedgeDoc's session cookie is called `connect.sid` unless the server sets
 * `sessionName`, so nothing here assumes that name except as the default for a
 * bare value.
 */

/** Default HedgeDoc session cookie name. */
export const DEFAULT_SESSION_COOKIE = 'connect.sid';

const COOKIE_ATTRIBUTES = new Set([
  'path', 'domain', 'expires', 'max-age', 'httponly', 'secure', 'samesite', 'priority', 'partitioned',
]);
const COOKIE_PAIR = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)=(.*)$/;

/**
 * Normalize a cookie value to a Cookie request header.
 *
 * Accepts:
 * - Just the session ID value: "s%3Axxx..." (assumed to be `connect.sid`)
 * - A name=value pair: "connect.sid=s%3Axxx..." or "hedgedoc.sid=..."
 * - A Set-Cookie style string: "connect.sid=s%3Axxx...; Path=/; HttpOnly"
 * - A Cookie header with several pairs: "a=1; connect.sid=..."
 *
 * Attributes such as Path or HttpOnly are dropped.
 */
export function normalizeCookie(cookie: string): string {
  if (!cookie) return '';
  const parts = cookie.split(';').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return '';

  const pairs: string[] = [];
  for (const part of parts) {
    const m = COOKIE_PAIR.exec(part);
    if (m && !COOKIE_ATTRIBUTES.has(m[1].toLowerCase())) pairs.push(`${m[1]}=${m[2]}`);
  }
  if (pairs.length > 0) return pairs.join('; ');

  // A bare value (no name=), e.g. copied from the browser's cookie view.
  return `${DEFAULT_SESSION_COOKIE}=${parts[0]}`;
}

/**
 * Extract the session ID value from a cookie string.
 *
 * Returns the value of `name` (default `connect.sid`), or of the only cookie
 * when there is just one, or the input itself when it is a bare value.
 */
export function extractSessionId(cookie: string, name = DEFAULT_SESSION_COOKIE): string {
  const normalized = normalizeCookie(cookie);
  if (!normalized) return '';
  const pairs = normalized.split('; ').map(p => {
    const i = p.indexOf('=');
    return [p.slice(0, i), p.slice(i + 1)] as const;
  });
  const named = pairs.find(([n]) => n === name);
  if (named) return named[1];
  return pairs.length === 1 ? pairs[0][1] : '';
}

/**
 * Parse Set-Cookie header lines into name=value pairs (attributes dropped).
 *
 * Accepts an array of header values, or one string holding several values
 * separated by newlines (as `defaultHedgeSyncRequest` produces) or by commas
 * (as `Headers.get('set-cookie')` produces).
 */
export function parseSetCookie(header: string | string[] | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  const lines = (Array.isArray(header) ? header : [header])
    .flatMap(h => h.split('\n'))
    // A comma only separates cookies when a new name= follows; Expires dates
    // contain commas too ("Thu, 01 Jan 2026 ...").
    .flatMap(h => h.split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/));

  for (const line of lines) {
    const [first, ...attrs] = line.split(';').map(s => s.trim());
    const m = first ? COOKIE_PAIR.exec(first) : null;
    if (!m) continue;
    const expired = attrs.some(a => /^max-age\s*=\s*0$/i.test(a) || /^expires\s*=.*\b1970\b/i.test(a));
    if (expired || m[2] === '') cookies.delete(m[1]);
    else cookies.set(m[1], m[2]);
  }
  return cookies;
}
