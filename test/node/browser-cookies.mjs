/**
 * Reading browser cookies on Node (node:sqlite), against the built package:
 * `bun run build && node test/node/browser-cookies.mjs`. The unit tests run
 * on Bun, whose SQLite behaves differently: node:sqlite throws on integers
 * above 2^53, such as Chromium's timestamps (microseconds since 1601).
 */
import assert from 'node:assert/strict';
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readBrowserCookies } from '../../dist/browser-cookies.js';

const home = mkdtempSync(join(tmpdir(), 'hedgesync-node-cookies-'));
try {
  // Chromium (Brave): a v10 value and a real-sized last_access_utc.
  const chromeDir = join(home, '.config', 'BraveSoftware', 'Brave-Browser', 'Default', 'Network');
  mkdirSync(chromeDir, { recursive: true });
  const chrome = new DatabaseSync(join(chromeDir, 'Cookies'));
  chrome.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('version', '24');");
  chrome.exec('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, is_secure INTEGER, last_access_utc INTEGER)');
  const cipher = createCipheriv('aes-128-cbc', pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1'), Buffer.alloc(16, 0x20));
  const plain = Buffer.concat([createHash('sha256').update('md.example.com').digest(), Buffer.from('s%3Abrave')]);
  const encrypted = Buffer.concat([Buffer.from('v10'), cipher.update(plain), cipher.final()]);
  chrome.prepare("INSERT INTO cookies VALUES ('md.example.com', 'connect.sid', '', ?, '/', 1, 13439313041047507)").run(encrypted);
  chrome.close();
  const brave = await readBrowserCookies('brave', { serverUrl: 'https://md.example.com', home, platform: 'linux', env: {}, keyringPassword: () => null });
  assert.deepEqual(brave.map(c => c.header), ['connect.sid=s%3Abrave']);
  assert.equal(new Date(brave[0].lastAccessed).toISOString(), '2026-11-16T14:30:41.047Z');

  // Firefox.
  const ffDir = join(home, '.mozilla', 'firefox', 'abc.default');
  mkdirSync(ffDir, { recursive: true });
  const ff = new DatabaseSync(join(ffDir, 'cookies.sqlite'));
  ff.exec('CREATE TABLE moz_cookies (name TEXT, value TEXT, host TEXT, path TEXT, isSecure INTEGER, lastAccessed INTEGER, originAttributes TEXT)');
  ff.exec("INSERT INTO moz_cookies VALUES ('connect.sid', 's%3Afirefox', 'md.example.com', '/', 1, 1763303441047507, '')");
  ff.close();
  const firefox = await readBrowserCookies('firefox', { serverUrl: 'https://md.example.com', home, platform: 'linux', env: {} });
  assert.deepEqual(firefox.map(c => c.header), ['connect.sid=s%3Afirefox']);
  console.log('browser cookies on Node: ok');
} finally {
  rmSync(home, { recursive: true, force: true });
}
