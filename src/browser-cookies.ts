/**
 * Read a HedgeDoc session cookie from a local browser profile (Node/Bun/Deno only).
 *
 * For servers that log in through OIDC/OAuth2/SAML there is no way for a CLI
 * to obtain a session itself: you sign in with your browser, and this module
 * picks the resulting session cookie out of the browser's cookie database,
 * the same way yt-dlp's --cookies-from-browser works.
 *
 * Supported:
 * - Firefox and derivatives (LibreWolf, Zen): cookies.sqlite, unencrypted.
 * - Chromium family (Chrome, Chromium, Brave, Vivaldi, Edge) on Linux and
 *   macOS: the Cookies database, decrypted with the key from the OS keyring
 *   (libsecret via `secret-tool`, KWallet via `kwallet-query`, or the macOS
 *   Keychain via `security`). Windows' app-bound encryption is not supported.
 *
 * The cookie is the browser's own session: logging out in the browser ends it
 * for hedgesync too. HedgeDoc 1.x renews sessions on every request, so a
 * cookie stays valid as long as either side keeps using it.
 */

import { spawnSync } from 'node:child_process';
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, platform as osPlatform, tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { getSessionUser, type SessionUser } from './auth.js';
import type { HedgeSyncRequestFn } from './http.js';

export type FirefoxBrowser = 'firefox' | 'librewolf' | 'zen';
export type ChromiumBrowser = 'chrome' | 'chromium' | 'brave' | 'vivaldi' | 'edge';
export type BrowserName = FirefoxBrowser | ChromiumBrowser;

export const SUPPORTED_BROWSERS: BrowserName[] = ['firefox', 'librewolf', 'zen', 'chrome', 'chromium', 'brave', 'vivaldi', 'edge'];

export interface BrowserCookie {
  name: string;
  value: string;
  host: string;
  path: string;
  secure: boolean;
  /** Last used / created time, for picking the freshest of several sessions. */
  lastAccessed: number;
}

/** All cookies one browser profile (or container) holds for a server. */
export interface CookieCandidate {
  browser: BrowserName;
  /** Profile directory name (plus container, for Firefox containers). */
  profile: string;
  cookies: BrowserCookie[];
  /** Cookie request header built from `cookies`. */
  header: string;
  lastAccessed: number;
}

export interface BrowserCookieOptions {
  /** Server whose cookies to read, e.g. https://md.example.com/hedgedoc */
  serverUrl: string;
  /** Profile name or directory; default: every profile, freshest first. */
  profile?: string;
  /** Override the home directory (tests). */
  home?: string;
  /** Override the platform (tests). */
  platform?: NodeJS.Platform;
  /** Environment for APPDATA etc. (tests). */
  env?: Record<string, string | undefined>;
  /**
   * Look up the Chromium "Safe Storage" password from the OS keyring.
   * Defaults to secret-tool / kwallet-query / security.
   */
  keyringPassword?: (browser: ChromiumBrowser) => string | null;
}

export class BrowserCookieError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'BrowserCookieError';
  }
}

/** Read the cookies each profile of `browser` holds for the server, freshest first. */
export async function readBrowserCookies(browser: BrowserName, options: BrowserCookieOptions): Promise<CookieCandidate[]> {
  if (!SUPPORTED_BROWSERS.includes(browser)) {
    throw new BrowserCookieError(`Unsupported browser '${browser}'`, `Supported: ${SUPPORTED_BROWSERS.join(', ')}`);
  }
  const target = new URL(options.serverUrl);
  const candidates = isFirefox(browser)
    ? await readFirefox(browser, target, options)
    : await readChromium(browser as ChromiumBrowser, target, options);
  return candidates.sort((a, b) => b.lastAccessed - a.lastAccessed);
}

function isFirefox(browser: BrowserName): browser is FirefoxBrowser {
  return browser === 'firefox' || browser === 'librewolf' || browser === 'zen';
}

export interface BrowserSession {
  /** Cookie header that is logged in. */
  cookie: string;
  user: SessionUser;
  browser: BrowserName;
  profile: string;
}

/**
 * Find a logged-in HedgeDoc session in a browser: read each profile's cookies
 * for the server (freshest first) and return the first that `GET /me`
 * confirms is logged in.
 */
export async function sessionFromBrowser(
  browser: BrowserName,
  options: BrowserCookieOptions & { headers?: Record<string, string>; request?: HedgeSyncRequestFn; timeout?: number },
): Promise<BrowserSession> {
  const candidates = await readBrowserCookies(browser, options);
  if (candidates.length === 0) {
    throw new BrowserCookieError(`${browser} has no cookies for ${options.serverUrl}`,
      `Sign in to ${options.serverUrl} in ${browser} first${options.profile ? '' : ' (or pick a profile with --profile)'}.`);
  }
  for (const candidate of candidates) {
    const user = await getSessionUser({
      serverUrl: options.serverUrl,
      cookie: candidate.header,
      headers: options.headers,
      request: options.request,
      timeout: options.timeout,
    });
    if (user) return { cookie: candidate.header, user, browser, profile: candidate.profile };
  }
  const where = candidates.map(c => c.profile).join(', ');
  throw new BrowserCookieError(`The ${browser} cookies for ${options.serverUrl} are not logged in (checked: ${where})`,
    `Sign in to ${options.serverUrl} in ${browser} and try again.`);
}

// ---------------------------------------------------------------------------
// Cookie matching
// ---------------------------------------------------------------------------

/**
 * RFC 6265 domain and path matching. Secure cookies match only https URLs
 * (and loopback hosts, which browsers treat as secure contexts).
 */
export function cookieMatches(host: string, path: string, target: URL, secure = false): boolean {
  const hostname = target.hostname.toLowerCase();
  if (secure && target.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return false;
  const domain = host.toLowerCase();
  const domainOk = domain.startsWith('.')
    ? hostname === domain.slice(1) || hostname.endsWith(domain)
    : hostname === domain;
  if (!domainOk) return false;
  const targetPath = target.pathname.endsWith('/') ? target.pathname : target.pathname + '/';
  const cookiePath = path || '/';
  return targetPath.startsWith(cookiePath.endsWith('/') ? cookiePath : cookiePath + '/') || targetPath === cookiePath;
}

function toCandidate(browser: BrowserName, profile: string, cookies: BrowserCookie[]): CookieCandidate | null {
  if (cookies.length === 0) return null;
  // Longer paths first, as browsers send them (RFC 6265 5.4).
  const sorted = [...cookies].sort((a, b) => b.path.length - a.path.length);
  const seen = new Set<string>();
  const unique = sorted.filter(c => (seen.has(c.name) ? false : (seen.add(c.name), true)));
  return {
    browser,
    profile,
    cookies: unique,
    header: unique.map(c => `${c.name}=${c.value}`).join('; '),
    lastAccessed: Math.max(...unique.map(c => c.lastAccessed)),
  };
}

// ---------------------------------------------------------------------------
// SQLite access (bun:sqlite on Bun, node:sqlite on Node 22.5+ and Deno)
// ---------------------------------------------------------------------------

interface Sqlite {
  all(sql: string): Record<string, unknown>[];
  close(): void;
}

async function openSqlite(file: string): Promise<Sqlite> {
  const proc = process as unknown as { versions: Record<string, string | undefined> };
  if (proc.versions.bun) {
    const moduleName = 'bun:sqlite';
    const { Database } = await import(moduleName) as { Database: new (f: string, o: object) => any };
    const db = new Database(file, { readonly: true });
    return { all: sql => db.query(sql).all(), close: () => db.close() };
  }
  let mod: { DatabaseSync: new (f: string, o: object) => any };
  try {
    const moduleName = 'node:sqlite';
    mod = await import(moduleName);
  } catch {
    throw new BrowserCookieError('Reading browser cookies needs SQLite support', 'Use Bun, Deno, or Node.js 22.5 or newer.');
  }
  const db = new mod.DatabaseSync(file, { readOnly: true });
  return { all: sql => db.prepare(sql).all(), close: () => db.close() };
}

/**
 * Run `fn` on a private copy of a database (the browser keeps the original
 * locked while running). WAL and journal files are copied along.
 */
async function withDatabaseCopy<T>(file: string, fn: (db: Sqlite) => T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'hedgesync-cookies-'));
  try {
    const copy = join(dir, basename(file));
    copyFileSync(file, copy);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (existsSync(file + suffix)) copyFileSync(file + suffix, copy + suffix);
    }
    const db = await openSqlite(copy);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Firefox
// ---------------------------------------------------------------------------

function firefoxRoots(browser: FirefoxBrowser, home: string, platform: NodeJS.Platform, env: Record<string, string | undefined>): string[] {
  const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
  const mac = join(home, 'Library', 'Application Support');
  switch (browser) {
    case 'firefox':
      if (platform === 'darwin') return [join(mac, 'Firefox')];
      if (platform === 'win32') return [join(appData, 'Mozilla', 'Firefox')];
      return [
        join(home, '.mozilla', 'firefox'),
        join(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox'),
        join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
        join(home, '.config', 'mozilla', 'firefox'),
      ];
    case 'librewolf':
      if (platform === 'darwin') return [join(mac, 'librewolf')];
      if (platform === 'win32') return [join(appData, 'librewolf')];
      return [join(home, '.librewolf'), join(home, '.var', 'app', 'io.gitlab.librewolf-community', '.librewolf')];
    case 'zen':
      if (platform === 'darwin') return [join(mac, 'zen')];
      if (platform === 'win32') return [join(appData, 'zen')];
      return [join(home, '.zen'), join(home, '.var', 'app', 'app.zen_browser.zen', '.zen')];
  }
}

interface FirefoxProfile {
  name: string;
  dir: string;
}

/** Profiles listed in profiles.ini (falls back to scanning for cookies.sqlite). */
export function listFirefoxProfiles(root: string): FirefoxProfile[] {
  const profiles: FirefoxProfile[] = [];
  const ini = join(root, 'profiles.ini');
  if (existsSync(ini)) {
    let section: Record<string, string> | null = null;
    const flush = () => {
      if (section?.Path) {
        const relative = section.IsRelative !== '0';
        const dir = relative ? join(root, section.Path) : section.Path;
        profiles.push({ name: section.Name ?? basename(dir), dir });
      }
    };
    for (const raw of readFileSync(ini, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('[')) {
        flush();
        section = line.startsWith('[Profile') ? {} : null;
      } else if (section && line.includes('=')) {
        const i = line.indexOf('=');
        section[line.slice(0, i)] = line.slice(i + 1);
      }
    }
    flush();
  }
  if (profiles.length === 0 && existsSync(root)) {
    for (const entry of readdirSync(root)) {
      if (existsSync(join(root, entry, 'cookies.sqlite'))) profiles.push({ name: entry, dir: join(root, entry) });
    }
  }
  return profiles.filter(p => existsSync(join(p.dir, 'cookies.sqlite')));
}

function selectProfiles<T extends { name: string; dir: string }>(profiles: T[], wanted: string | undefined, browser: string): T[] {
  if (!wanted) return profiles;
  const matches = profiles.filter(p => p.name === wanted || basename(p.dir) === wanted || p.dir === wanted);
  if (matches.length === 0) {
    const known = profiles.map(p => p.name).join(', ') || 'none found';
    throw new BrowserCookieError(`No ${browser} profile '${wanted}'`, `Profiles: ${known}`);
  }
  return matches;
}

async function readFirefox(browser: FirefoxBrowser, target: URL, options: BrowserCookieOptions): Promise<CookieCandidate[]> {
  const home = options.home ?? homedir();
  const platform = options.platform ?? osPlatform();
  const env = options.env ?? process.env;

  let profiles: FirefoxProfile[];
  if (options.profile && isAbsolute(options.profile) && existsSync(join(options.profile, 'cookies.sqlite'))) {
    profiles = [{ name: basename(options.profile), dir: options.profile }];
  } else {
    const all = firefoxRoots(browser, home, platform, env).flatMap(listFirefoxProfiles);
    if (all.length === 0) throw new BrowserCookieError(`No ${browser} profile found`, `Looked in: ${firefoxRoots(browser, home, platform, env).join(', ')}`);
    profiles = selectProfiles(all, options.profile, browser);
  }

  const candidates: CookieCandidate[] = [];
  for (const profile of profiles) {
    const rows = await withDatabaseCopy(join(profile.dir, 'cookies.sqlite'), db =>
      db.all('SELECT name, value, host, path, isSecure, lastAccessed, originAttributes FROM moz_cookies'));
    // Group by container / partition (originAttributes), since each is a separate cookie jar.
    const jars = new Map<string, BrowserCookie[]>();
    for (const row of rows) {
      const host = String(row.host);
      const path = String(row.path ?? '/');
      if (!cookieMatches(host, path, target, Number(row.isSecure) === 1)) continue;
      const jar = String(row.originAttributes ?? '');
      if (!jars.has(jar)) jars.set(jar, []);
      jars.get(jar)!.push({
        name: String(row.name),
        value: String(row.value),
        host,
        path,
        secure: Number(row.isSecure) === 1,
        lastAccessed: Number(row.lastAccessed) / 1000, // microseconds -> ms
      });
    }
    for (const [jar, cookies] of jars) {
      const candidate = toCandidate(browser, jar ? `${profile.name} (${jar.replace(/^\^/, '')})` : profile.name, cookies);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Chromium
// ---------------------------------------------------------------------------

const CHROMIUM_INFO: Record<ChromiumBrowser, { linux: string; mac: string; keyringApp: string; safeStorage: string }> = {
  chrome: { linux: 'google-chrome', mac: 'Google/Chrome', keyringApp: 'chrome', safeStorage: 'Chrome Safe Storage' },
  chromium: { linux: 'chromium', mac: 'Chromium', keyringApp: 'chromium', safeStorage: 'Chromium Safe Storage' },
  brave: { linux: 'BraveSoftware/Brave-Browser', mac: 'BraveSoftware/Brave-Browser', keyringApp: 'brave', safeStorage: 'Brave Safe Storage' },
  vivaldi: { linux: 'vivaldi', mac: 'Vivaldi', keyringApp: 'vivaldi', safeStorage: 'Vivaldi Safe Storage' },
  edge: { linux: 'microsoft-edge', mac: 'Microsoft Edge', keyringApp: 'chromium', safeStorage: 'Microsoft Edge Safe Storage' },
};

interface ChromiumProfile {
  /** Directory name: Default, Profile 1, ... */
  name: string;
  /** Name shown in the browser's profile menu, from Local State. */
  display?: string;
  dir: string;
  cookies: string;
}

function chromiumProfiles(browser: ChromiumBrowser, home: string, platform: NodeJS.Platform, env: Record<string, string | undefined>): { root: string; profiles: ChromiumProfile[] } {
  if (platform === 'win32') {
    throw new BrowserCookieError(`Reading ${browser} cookies on Windows is not supported (app-bound encryption)`,
      'Use Firefox, or copy the connect.sid cookie from the browser\'s developer tools.');
  }
  const info = CHROMIUM_INFO[browser];
  const root = platform === 'darwin'
    ? join(home, 'Library', 'Application Support', info.mac)
    : join(env.XDG_CONFIG_HOME ?? join(home, '.config'), info.linux);
  const profiles: ChromiumProfile[] = [];
  if (existsSync(root)) {
    for (const entry of readdirSync(root)) {
      if (entry !== 'Default' && !/^Profile \d+$/.test(entry)) continue;
      for (const rel of [join('Network', 'Cookies'), 'Cookies']) {
        const file = join(root, entry, rel);
        if (existsSync(file)) {
          profiles.push({ name: entry, dir: join(root, entry), cookies: file });
          break;
        }
      }
    }
  }
  // Human-readable profile names from Local State, so --profile "Work" works.
  const localState = join(root, 'Local State');
  if (existsSync(localState)) {
    try {
      const info = JSON.parse(readFileSync(localState, 'utf8')).profile?.info_cache ?? {};
      for (const p of profiles) p.display = info[p.name]?.name;
    } catch {
      // Ignore a malformed Local State.
    }
  }
  return { root, profiles };
}

/** Default keyring lookup: secret-tool, kwallet-query (Linux) or security (macOS). */
export function defaultKeyringPassword(browser: ChromiumBrowser, platform: NodeJS.Platform = osPlatform()): string | null {
  const info = CHROMIUM_INFO[browser];
  const run = (cmd: string, args: string[]): string | null => {
    try {
      const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000 });
      return r.status === 0 && r.stdout ? r.stdout.replace(/\n$/, '') : null;
    } catch {
      return null;
    }
  };
  if (platform === 'darwin') return run('security', ['find-generic-password', '-w', '-s', info.safeStorage]);
  return run('secret-tool', ['lookup', 'application', info.keyringApp])
    ?? run('kwallet-query', ['--read-password', info.safeStorage, '--folder', `${info.safeStorage.replace(' Safe Storage', '')} Keys`, 'kdewallet']);
}

/** Decrypt a Chromium `encrypted_value` (Linux v10/v11, macOS v10). */
export function decryptChromiumValue(
  encrypted: Uint8Array,
  options: { platform: NodeJS.Platform; password: () => string | null; hostKey: string; dbVersion: number },
): string | null {
  const data = Buffer.from(encrypted);
  if (data.length === 0) return null;
  const prefix = data.subarray(0, 3).toString('latin1');
  let password: string | null;
  let iterations: number;
  if (options.platform === 'darwin') {
    if (prefix !== 'v10') return null;
    password = options.password();
    iterations = 1003;
  } else if (prefix === 'v10') {
    password = 'peanuts';
    iterations = 1;
  } else if (prefix === 'v11') {
    password = options.password();
    iterations = 1;
  } else {
    return null;
  }
  if (password === null) {
    throw new BrowserCookieError('Could not get the browser\'s cookie encryption key from the keyring',
      options.platform === 'darwin'
        ? 'Allow access to the "Safe Storage" Keychain item when macOS asks.'
        : 'Install secret-tool (libsecret-tools) or kwallet-query, and unlock your keyring.');
  }
  const key = pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1');
  let plain: Buffer;
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    plain = Buffer.concat([decipher.update(data.subarray(3)), decipher.final()]);
  } catch {
    return null; // wrong key (e.g. stale keyring entry)
  }
  // Since database version 24, values are prefixed with SHA-256(host_key).
  if (options.dbVersion >= 24 && plain.length >= 32) {
    const hash = createHash('sha256').update(options.hostKey).digest();
    if (plain.subarray(0, 32).equals(hash)) plain = plain.subarray(32);
  }
  return plain.toString('utf8');
}

async function readChromium(browser: ChromiumBrowser, target: URL, options: BrowserCookieOptions): Promise<CookieCandidate[]> {
  const home = options.home ?? homedir();
  const platform = options.platform ?? osPlatform();
  const env = options.env ?? process.env;
  const { root, profiles: all } = chromiumProfiles(browser, home, platform, env);
  if (all.length === 0) throw new BrowserCookieError(`No ${browser} profile found`, `Looked in: ${root}`);
  const profiles = options.profile
    ? all.filter(p => p.name === options.profile || p.display === options.profile || p.dir === options.profile)
    : all;
  if (profiles.length === 0) {
    throw new BrowserCookieError(`No ${browser} profile '${options.profile}'`,
      `Profiles: ${all.map(p => (p.display ? `${p.name} (${p.display})` : p.name)).join(', ')}`);
  }

  let cachedPassword: string | null | undefined;
  const password = () => {
    if (cachedPassword === undefined) cachedPassword = (options.keyringPassword ?? defaultKeyringPassword)(browser);
    return cachedPassword;
  };

  const candidates: CookieCandidate[] = [];
  for (const profile of profiles) {
    const { rows, dbVersion } = await withDatabaseCopy(profile.cookies, (db) => {
      let version = 0;
      try {
        version = Number(db.all("SELECT value FROM meta WHERE key = 'version'")[0]?.value ?? 0);
      } catch {
        version = 0;
      }
      return {
        dbVersion: version,
        rows: db.all('SELECT host_key, name, value, encrypted_value, path, is_secure, last_access_utc FROM cookies'),
      };
    });
    const cookies: BrowserCookie[] = [];
    for (const row of rows) {
      const host = String(row.host_key);
      const path = String(row.path ?? '/');
      if (!cookieMatches(host, path, target, Number(row.is_secure) === 1)) continue;
      let value = String(row.value ?? '');
      if (!value && row.encrypted_value) {
        value = decryptChromiumValue(row.encrypted_value as Uint8Array, { platform, password, hostKey: host, dbVersion }) ?? '';
      }
      if (!value) continue;
      cookies.push({
        name: String(row.name),
        value,
        host,
        path,
        secure: Number(row.is_secure) === 1,
        // Chromium time: microseconds since 1601-01-01.
        lastAccessed: Number(row.last_access_utc) / 1000 - 11644473600000,
      });
    }
    const candidate = toCandidate(browser, profile.display ?? profile.name, cookies);
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}
