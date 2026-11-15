import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cookieMatches,
  decryptChromiumValue,
  readBrowserCookies,
  sessionFromBrowser,
} from '../../src/browser-cookies.js';
import type { HedgeSyncHttpRequest } from '../../src/http.js';

const homes: string[] = [];
afterAll(() => homes.forEach(h => rmSync(h, { recursive: true, force: true })));
function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'hedgesync-browser-'));
  homes.push(home);
  return home;
}

interface Row { host: string; name: string; value: string; path?: string; lastAccessed?: number; originAttributes?: string }

function firefoxProfile(root: string, dir: string, rows: Row[]): void {
  mkdirSync(join(root, dir), { recursive: true });
  const db = new Database(join(root, dir, 'cookies.sqlite'));
  db.run(`CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT,
    host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER)`);
  for (const r of rows) {
    db.run('INSERT INTO moz_cookies (originAttributes, name, value, host, path, expiry, lastAccessed, isSecure) VALUES (?, ?, ?, ?, ?, 0, ?, 1)',
      [r.originAttributes ?? '', r.name, r.value, r.host, r.path ?? '/', (r.lastAccessed ?? 1) * 1000]);
  }
  db.close();
}

/** /me answers "ok" only for the listed session values. */
function fakeMe(valid: string[]) {
  const seen: string[] = [];
  const request = async (req: HedgeSyncHttpRequest) => {
    const cookie = req.headers?.Cookie ?? '';
    seen.push(cookie);
    const ok = valid.some(v => cookie.includes(`connect.sid=${v}`));
    const body = JSON.stringify(ok ? { status: 'ok', id: 'u1', name: 'Eric' } : { status: 'forbidden' });
    return { status: 200, headers: {}, text: async () => body, json: async () => JSON.parse(body), arrayBuffer: async () => new ArrayBuffer(0) };
  };
  return { request, seen };
}

describe('cookieMatches', () => {
  const t = new URL('https://md.example.com/hedgedoc');
  test('domain and path rules', () => {
    expect(cookieMatches('md.example.com', '/', t)).toBe(true);
    expect(cookieMatches('.example.com', '/', t)).toBe(true);
    expect(cookieMatches('example.com', '/', t)).toBe(false);
    expect(cookieMatches('evilmd.example.com', '/', t)).toBe(false);
    expect(cookieMatches('md.example.com', '/hedgedoc', t)).toBe(true);
    expect(cookieMatches('md.example.com', '/other', t)).toBe(false);
    expect(cookieMatches('md.example.com', '/hedge', t)).toBe(false);
  });
  test('secure cookies are never sent over plain http', () => {
    expect(cookieMatches('md.example.com', '/', t, true)).toBe(true);
    expect(cookieMatches('md.example.com', '/', new URL('http://md.example.com'), true)).toBe(false);
    expect(cookieMatches('md.example.com', '/', new URL('http://md.example.com'), false)).toBe(true);
    expect(cookieMatches('localhost', '/', new URL('http://localhost:3000'), true)).toBe(true);
  });
});

describe('Firefox', () => {
  function setup() {
    const home = fakeHome();
    const root = join(home, '.mozilla', 'firefox');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'profiles.ini'), [
      '[General]', 'StartWithLastProfile=1', '',
      '[Profile0]', 'Name=default-esr', 'IsRelative=1', 'Path=aaaa.default-esr', '',
      '[Profile1]', 'Name=work', 'IsRelative=1', 'Path=bbbb.work', 'Default=1', '',
    ].join('\n'));
    firefoxProfile(root, 'aaaa.default-esr', [
      { host: 'md.example.com', name: 'connect.sid', value: 's%3Astale', lastAccessed: 100 },
    ]);
    firefoxProfile(root, 'bbbb.work', [
      { host: 'md.example.com', name: 'connect.sid', value: 's%3Agood', lastAccessed: 50 },
      { host: '.example.com', name: 'lang', value: 'en', lastAccessed: 40 },
      { host: 'other.org', name: 'connect.sid', value: 'nope', lastAccessed: 999 },
      { host: 'md.example.com', name: 'connect.sid', value: 's%3Acontainer', lastAccessed: 10, originAttributes: '^userContextId=2' },
    ]);
    return home;
  }

  test('reads every profile and container, freshest first', async () => {
    const candidates = await readBrowserCookies('firefox', { serverUrl: 'https://md.example.com', home: setup(), platform: 'linux' });
    expect(candidates.map(c => [c.profile, c.header])).toEqual([
      ['default-esr', 'connect.sid=s%3Astale'],
      ['work', 'connect.sid=s%3Agood; lang=en'],
      ['work (userContextId=2)', 'connect.sid=s%3Acontainer'],
    ]);
  });

  test('sessionFromBrowser skips logged-out profiles', async () => {
    const me = fakeMe(['s%3Agood']);
    const session = await sessionFromBrowser('firefox', {
      serverUrl: 'https://md.example.com', home: setup(), platform: 'linux', request: me.request,
    });
    expect(session).toMatchObject({ cookie: 'connect.sid=s%3Agood; lang=en', profile: 'work', user: { name: 'Eric' } });
    expect(me.seen.length).toBe(2);
  });

  test('--profile limits the search and names unknown profiles', async () => {
    const home = setup();
    const only = await readBrowserCookies('firefox', { serverUrl: 'https://md.example.com', home, platform: 'linux', profile: 'default-esr' });
    expect(only.map(c => c.profile)).toEqual(['default-esr']);
    await expect(readBrowserCookies('firefox', { serverUrl: 'https://md.example.com', home, platform: 'linux', profile: 'x' }))
      .rejects.toThrow("No firefox profile 'x'");
  });

  test('clear errors when nothing is logged in', async () => {
    const home = setup();
    await expect(sessionFromBrowser('firefox', { serverUrl: 'https://md.example.com', home, platform: 'linux', request: fakeMe([]).request }))
      .rejects.toThrow('not logged in');
    await expect(sessionFromBrowser('firefox', { serverUrl: 'https://nothing.example.net', home, platform: 'linux', request: fakeMe([]).request }))
      .rejects.toThrow('has no cookies');
    await expect(readBrowserCookies('librewolf', { serverUrl: 'https://md.example.com', home, platform: 'linux' }))
      .rejects.toThrow('No librewolf profile found');
  });
});

describe('Chromium', () => {
  function encrypt(value: string, password: string, iterations: number, prefix: string, hostKey?: string): Buffer {
    const key = pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1');
    const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    const plain = hostKey ? Buffer.concat([createHash('sha256').update(hostKey).digest(), Buffer.from(value)]) : Buffer.from(value);
    return Buffer.concat([Buffer.from(prefix), cipher.update(plain), cipher.final()]);
  }

  function chromeProfile(root: string, dir: string, version: number, rows: { host: string; name: string; enc: Buffer; path?: string }[]) {
    mkdirSync(join(root, dir, 'Network'), { recursive: true });
    const db = new Database(join(root, dir, 'Network', 'Cookies'));
    db.run('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
    db.run("INSERT INTO meta VALUES ('version', ?)", [String(version)]);
    db.run(`CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
      is_secure INTEGER, last_access_utc INTEGER)`);
    for (const r of rows) {
      db.run('INSERT INTO cookies VALUES (?, ?, \'\', ?, ?, 1, 13300000000000000)', [r.host, r.name, r.enc, r.path ?? '/']);
    }
    db.close();
  }

  test('decrypts v10 (fixed key) and v11 (keyring) values, with the host hash prefix', async () => {
    const home = fakeHome();
    const root = join(home, '.config', 'google-chrome');
    chromeProfile(root, 'Default', 24, [
      { host: 'md.example.com', name: 'connect.sid', enc: encrypt('s%3Av10value', 'peanuts', 1, 'v10', 'md.example.com') },
    ]);
    chromeProfile(root, 'Profile 1', 18, [
      { host: 'md.example.com', name: 'connect.sid', enc: encrypt('s%3Av11value', 'keyring-secret', 1, 'v11') },
    ]);
    writeFileSync(join(root, 'Local State'), JSON.stringify({ profile: { info_cache: { 'Profile 1': { name: 'Work' } } } }));

    const asked: string[] = [];
    const candidates = await readBrowserCookies('chrome', {
      serverUrl: 'https://md.example.com', home, platform: 'linux', env: {},
      keyringPassword: (b) => { asked.push(b); return 'keyring-secret'; },
    });
    expect(candidates.map(c => c.header).sort()).toEqual(['connect.sid=s%3Av10value', 'connect.sid=s%3Av11value']);
    expect(candidates.map(c => c.profile).sort()).toEqual(['Default', 'Work']);
    expect(asked).toEqual(['chrome']); // keyring consulted once, only for v11
  });

  test('finds native and Flatpak Brave profiles, asking the keyring for "brave"', async () => {
    const home = fakeHome();
    chromeProfile(join(home, '.config', 'BraveSoftware', 'Brave-Browser'), 'Default', 24, [
      { host: 'md.example.com', name: 'connect.sid', enc: encrypt('s%3Anative', 'brave-key', 1, 'v11', 'md.example.com') },
    ]);
    chromeProfile(join(home, '.var', 'app', 'com.brave.Browser', 'config', 'BraveSoftware', 'Brave-Browser'), 'Default', 24, [
      { host: 'md.example.com', name: 'connect.sid', enc: encrypt('s%3Aflatpak', 'peanuts', 1, 'v10', 'md.example.com') },
    ]);
    const asked: string[] = [];
    const options = {
      serverUrl: 'https://md.example.com', home, platform: 'linux' as const, env: {},
      keyringPassword: (b: string) => { asked.push(b); return 'brave-key'; },
    };
    const candidates = await readBrowserCookies('brave', options);
    expect(candidates.map(c => [c.profile, c.header]).sort()).toEqual([
      ['Default (flatpak)', 'connect.sid=s%3Aflatpak'],
      ['Default', 'connect.sid=s%3Anative'],
    ]);
    expect(asked).toEqual(['brave']);
    const flatpakOnly = await readBrowserCookies('brave', { ...options, profile: 'Default (flatpak)' });
    expect(flatpakOnly.map(c => c.header)).toEqual(['connect.sid=s%3Aflatpak']);
  });

  test('macOS uses the Keychain password with 1003 iterations', () => {
    const enc = encrypt('mac-value', 'keychain-pw', 1003, 'v10');
    expect(decryptChromiumValue(enc, { platform: 'darwin', password: () => 'keychain-pw', hostKey: 'x', dbVersion: 0 })).toBe('mac-value');
  });

  test('a missing keyring password is a clear error', () => {
    const enc = encrypt('v', 'secret', 1, 'v11');
    expect(() => decryptChromiumValue(enc, { platform: 'linux', password: () => null, hostKey: 'x', dbVersion: 0 }))
      .toThrow('keyring');
  });

  test('Windows is reported as unsupported', async () => {
    await expect(readBrowserCookies('chrome', { serverUrl: 'https://md.example.com', home: fakeHome(), platform: 'win32', env: {} }))
      .rejects.toThrow('not supported');
  });
});
