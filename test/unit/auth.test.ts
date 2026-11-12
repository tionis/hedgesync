import { describe, expect, test } from 'bun:test';
import {
  AuthError,
  extractSessionId,
  getSessionUser,
  loginWithEmail,
  loginWithLDAP,
  normalizeCookie,
  parseSetCookie,
} from '../../src/auth.js';
import { HedgeDocAPI, parseConfigScript } from '../../src/hedgedoc-api.js';
import type { HedgeSyncHttpRequest, HedgeSyncHttpResponse } from '../../src/http.js';

function response(status: number, body = '', headers: Record<string, string> = {}): HedgeSyncHttpResponse {
  return {
    status,
    headers,
    text: async () => body,
    json: async <T>() => JSON.parse(body) as T,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
  };
}

/**
 * Mimics HedgeDoc 1.x: every response gets a session cookie
 * (saveUninitialized), a login answers 302 to "/" whether or not the
 * credentials are right, and only /me tells the two apart.
 */
function fakeHedgeDoc(opts: { sessionName?: string; emailEnabled?: boolean; ldapEnabled?: boolean } = {}) {
  const { sessionName = 'connect.sid', emailEnabled = true, ldapEnabled = true } = opts;
  const sessions = new Map<string, string | null>(); // sid -> user id
  const requests: HedgeSyncHttpRequest[] = [];
  let next = 0;

  const sidOf = (req: HedgeSyncHttpRequest) => {
    const m = new RegExp(`${sessionName.replace('.', '\\.')}=([^;]+)`).exec(req.headers?.Cookie ?? '');
    return m ? decodeURIComponent(m[1]) : null;
  };
  const newSession = (user: string | null) => {
    const sid = `s:sid${next++}.sig`;
    sessions.set(sid, user);
    return `${sessionName}=${encodeURIComponent(sid)}; Path=/; Expires=Thu, 01 Jan 2099 00:00:00 GMT; HttpOnly`;
  };

  const request = async (req: HedgeSyncHttpRequest): Promise<HedgeSyncHttpResponse> => {
    requests.push(req);
    const url = new URL(req.url);
    const form = new URLSearchParams(typeof req.body === 'string' ? req.body : '');
    if (req.method === 'POST' && url.pathname === '/login' && emailEnabled) {
      if (!form.get('email')?.includes('@') || !form.get('password')) return response(400, 'Bad Request');
      const ok = form.get('email') === 'me@example.com' && form.get('password') === 'hunter2';
      return response(302, 'Found', {
        location: '/',
        // Several cookies, the session one not first, as a joined header.
        'set-cookie': ['lang=en; Path=/', newSession(ok ? 'u1' : null)].join('\n'),
      });
    }
    if (req.method === 'POST' && url.pathname === '/auth/ldap' && ldapEnabled) {
      const ok = form.get('username') === 'me' && form.get('password') === 'hunter2';
      return response(302, 'Found', { location: '/', 'set-cookie': newSession(ok ? 'u1' : null) });
    }
    if (url.pathname === '/me') {
      const user = sessions.get(sidOf(req) ?? '');
      const body = user ? { status: 'ok', id: user, name: 'Me', photo: 'https://x/p.png' } : { status: 'forbidden' };
      return response(200, JSON.stringify(body), { 'content-type': 'application/json' });
    }
    if (url.pathname === '/config') {
      const token = sessions.get(sidOf(req) ?? '') ? 'tok-123' : '';
      return response(200, [
        "window.domain = 'md.example.com'",
        "window.urlpath = ''",
        'window.debug = false',
        "window.version = '1.10.0'",
        'window.allowedUploadMimeTypes = ["image/png"]',
        `window.userToken = '${token}'`,
      ].join('\n'), { 'content-type': 'application/javascript' });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/history')) {
      return url.searchParams.get('token') === 'tok-123' ? response(200) : response(403, 'Forbidden');
    }
    return response(404, 'Not Found');
  };
  return { request, requests };
}

describe('loginWithEmail', () => {
  test('returns the session cookie and the user', async () => {
    const server = fakeHedgeDoc();
    const result = await loginWithEmail({
      serverUrl: 'https://md.example.com/', email: 'me@example.com', password: 'hunter2', request: server.request,
    });
    expect(result.user).toEqual({ id: 'u1', name: 'Me', photo: 'https://x/p.png' });
    expect(result.cookie).toBe('lang=en; connect.sid=s%3Asid0.sig');
    expect(result.sessionId).toBe('s%3Asid0.sig');
    expect(server.requests[0].url).toBe('https://md.example.com/login');
    expect(server.requests[0].body).toBe('email=me%40example.com&password=hunter2');
  });

  test('a wrong password is an error, not a cookie', async () => {
    const server = fakeHedgeDoc();
    const attempt = loginWithEmail({
      serverUrl: 'https://md.example.com', email: 'me@example.com', password: 'wrong', request: server.request,
    });
    await expect(attempt).rejects.toThrow('Invalid email or password');
    await expect(attempt).rejects.toMatchObject({ statusCode: 401 });
  });

  test('a disabled provider gives a clear error', async () => {
    const server = fakeHedgeDoc({ emailEnabled: false });
    const attempt = loginWithEmail({
      serverUrl: 'https://md.example.com', email: 'me@example.com', password: 'hunter2', request: server.request,
    });
    await expect(attempt).rejects.toThrow('not enabled');
  });

  test('works with a custom session cookie name', async () => {
    const server = fakeHedgeDoc({ sessionName: 'hedgedoc.sid' });
    const result = await loginWithEmail({
      serverUrl: 'https://md.example.com', email: 'me@example.com', password: 'hunter2', request: server.request,
    });
    expect(result.cookie).toContain('hedgedoc.sid=');
    expect(result.user.id).toBe('u1');
  });

  test('times out', async () => {
    const attempt = loginWithEmail({
      serverUrl: 'https://md.example.com', email: 'a@b.c', password: 'x', timeout: 20,
      request: () => new Promise(() => {}),
    });
    await expect(attempt).rejects.toBeInstanceOf(AuthError);
  });
});

describe('loginWithLDAP', () => {
  test('logs in and rejects bad credentials', async () => {
    const server = fakeHedgeDoc();
    const ok = await loginWithLDAP({
      serverUrl: 'https://md.example.com', username: 'me', password: 'hunter2', request: server.request,
    });
    expect(ok.user.id).toBe('u1');
    expect(server.requests[0].url).toBe('https://md.example.com/auth/ldap');
    await expect(loginWithLDAP({
      serverUrl: 'https://md.example.com', username: 'me', password: 'nope', request: server.request,
    })).rejects.toThrow('Invalid username or password');
  });
});

describe('getSessionUser', () => {
  test('null for a logged-out cookie', async () => {
    const server = fakeHedgeDoc();
    expect(await getSessionUser({ serverUrl: 'https://md.example.com', cookie: 'abc', request: server.request })).toBeNull();
  });
});

describe('cookie helpers', () => {
  test('normalizeCookie', () => {
    expect(normalizeCookie('s%3Aabc.def')).toBe('connect.sid=s%3Aabc.def');
    expect(normalizeCookie('connect.sid=s%3Aabc; Path=/; HttpOnly')).toBe('connect.sid=s%3Aabc');
    expect(normalizeCookie('hedgedoc.sid=xyz')).toBe('hedgedoc.sid=xyz');
    expect(normalizeCookie('lang=en; connect.sid=v')).toBe('lang=en; connect.sid=v');
    expect(normalizeCookie('  ')).toBe('');
  });

  test('extractSessionId', () => {
    expect(extractSessionId('connect.sid=v; Path=/')).toBe('v');
    expect(extractSessionId('lang=en; connect.sid=v')).toBe('v');
    expect(extractSessionId('other.sid=w')).toBe('w');
    expect(extractSessionId('bare')).toBe('bare');
  });

  test('parseSetCookie handles joined headers and Expires commas', () => {
    const header = 'a=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT; Path=/, connect.sid=s%3Ax; HttpOnly';
    expect([...parseSetCookie(header)]).toEqual([['a', '1'], ['connect.sid', 's%3Ax']]);
    expect([...parseSetCookie(['a=1', 'a=; Max-Age=0'])]).toEqual([]);
  });
});

describe('HedgeDocAPI config and history deletes', () => {
  test('parseConfigScript reads the window.* script', () => {
    const config = parseConfigScript("window.domain = 'md.example.com'\nwindow.debug = true\nwindow.allowedUploadMimeTypes = [\"a\"]\nwindow.userToken = ''");
    expect(config.domain).toBe('md.example.com');
    expect(config.debug).toBe(true);
    expect(config.allowedUploadMimeTypes).toEqual(['a']);
    expect(config.userToken).toBe('');
  });

  test('history deletes send the delete token', async () => {
    const server = fakeHedgeDoc();
    const { cookie } = await loginWithEmail({
      serverUrl: 'https://md.example.com', email: 'me@example.com', password: 'hunter2', request: server.request,
    });
    const api = new HedgeDocAPI({ serverUrl: 'https://md.example.com', cookie, request: server.request });
    await api.deleteFromHistory('abc');
    await api.deleteHistory();
    const deletes = server.requests.filter(r => r.method === 'DELETE').map(r => r.url);
    expect(deletes).toEqual([
      'https://md.example.com/history/abc?token=tok-123',
      'https://md.example.com/history?token=tok-123',
    ]);
  });

  test('history deletes without a session fail clearly', async () => {
    const server = fakeHedgeDoc();
    const api = new HedgeDocAPI({ serverUrl: 'https://md.example.com', request: server.request });
    await expect(api.deleteHistory()).rejects.toThrow('Not logged in');
  });
});
