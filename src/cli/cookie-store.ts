/**
 * Per-server session cookies saved by `hedgesync login --save`.
 *
 * Stored as JSON in $XDG_CONFIG_HOME/hedgesync/cookies.json (or
 * ~/.config/hedgesync/cookies.json), readable only by the user. The location
 * can be overridden with HEDGESYNC_COOKIE_FILE.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface StoredSession {
  cookie: string;
  user?: { id: string; name: string };
  /** Where the cookie came from, so `login --from-browser` can be repeated. */
  source?: { method: string; browser?: string; profile?: string };
  savedAt: string;
  /** Last time `sessions refresh` (or login) asked the server about this session. */
  checkedAt?: string;
  /** Result of that check. */
  status?: 'ok' | 'expired' | 'unreachable';
  /** Error detail for status 'unreachable' or a failed re-import. */
  error?: string;
}

interface StoreFile {
  version: 1;
  servers: Record<string, StoredSession>;
}

export function cookieStorePath(): string {
  if (process.env.HEDGESYNC_COOKIE_FILE) return process.env.HEDGESYNC_COOKIE_FILE;
  const base = process.env.XDG_CONFIG_HOME
    || (process.platform === 'win32' && process.env.APPDATA)
    || join(homedir(), '.config');
  return join(base, 'hedgesync', 'cookies.json');
}

/** Canonical key for a server URL: lower-case origin plus path, no trailing slash. */
export function serverKey(serverUrl: string): string {
  try {
    const url = new URL(serverUrl);
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return serverUrl.replace(/\/+$/, '');
  }
}

function load(): StoreFile {
  const path = cookieStorePath();
  if (!existsSync(path)) return { version: 1, servers: {} };
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoreFile>;
    return { version: 1, servers: data.servers ?? {} };
  } catch {
    return { version: 1, servers: {} };
  }
}

function save(store: StoreFile): void {
  const path = cookieStorePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function getStoredSession(serverUrl: string): StoredSession | undefined {
  return load().servers[serverKey(serverUrl)];
}

export function storeSession(serverUrl: string, session: Omit<StoredSession, 'savedAt'>): void {
  const store = load();
  store.servers[serverKey(serverUrl)] = { ...session, savedAt: new Date().toISOString() };
  save(store);
}

/** All saved sessions, keyed by server URL. */
export function listStoredSessions(): [string, StoredSession][] {
  return Object.entries(load().servers);
}

/**
 * Merge `patch` into a saved session (keeping savedAt unless the cookie
 * changes). Re-reads the file first, so a concurrent `login --save` for
 * another server is not lost.
 */
export function updateStoredSession(serverUrl: string, patch: Partial<StoredSession>): void {
  const store = load();
  const key = serverKey(serverUrl);
  const current = store.servers[key];
  if (!current) return;
  const savedAt = patch.cookie && patch.cookie !== current.cookie ? new Date().toISOString() : current.savedAt;
  const next: StoredSession = { ...current, ...patch, savedAt };
  if (next.status === 'ok') delete next.error;
  store.servers[key] = next;
  save(store);
}

/** Remove a saved session; returns whether one existed. */
export function removeStoredSession(serverUrl: string): boolean {
  const store = load();
  const key = serverKey(serverUrl);
  if (!(key in store.servers)) return false;
  delete store.servers[key];
  save(store);
  return true;
}
