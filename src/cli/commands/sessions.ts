/**
 * sessions: list saved sessions, keep them alive, and install a systemd
 * user timer that does so daily.
 *
 * HedgeDoc 1 sessions are rolling (express-session `rolling: true`, store
 * with touch): any request that carries the session cookie extends it to
 * now + sessionLife (14 days by default). A daily GET /me is therefore
 * enough to keep a session alive. /status would not do: it bypasses the
 * session middleware.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { getSessionUser } from '../../auth.js';
import { BrowserCookieError, sessionFromBrowser, SUPPORTED_BROWSERS, type BrowserName } from '../../browser-cookies.js';
import type { Command, Context } from '../context.js';
import { cookieStorePath, listStoredSessions, updateStoredSession, type StoredSession } from '../cookie-store.js';
import { CliError, c, print } from '../ui.js';

const UNIT = 'hedgesync-refresh';

function relative(iso: string | undefined): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  for (const [size, name] of [[86400, 'day'], [3600, 'hour'], [60, 'minute']] as const) {
    if (s >= size) {
      const n = Math.floor(s / size);
      return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

function describeSource(session: StoredSession): string {
  const src = session.source;
  if (!src) return 'unknown';
  if (src.method === 'browser') return `${src.browser}${src.profile ? `, profile ${src.profile}` : ''}`;
  return `${src.method} login`;
}

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

type RefreshResult = {
  server: string;
  user: string | null;
  result: 'alive' | 'reimported' | 'expired' | 'unreachable';
  detail?: string;
};

/** Re-import a dead browser session, insisting on the same account as before. */
async function reimport(ctx: Context, server: string, session: StoredSession): Promise<{ cookie: string; user: { id: string; name: string }; profile: string } | string> {
  const browser = session.source?.browser as BrowserName | undefined;
  if (!browser || !SUPPORTED_BROWSERS.includes(browser)) return 'unknown browser';
  const attempt = async (profile?: string) => sessionFromBrowser(browser, { serverUrl: server, profile, headers: ctx.headers(), timeout: 30000 });
  let found;
  try {
    found = await attempt(session.source?.profile);
  } catch (err) {
    // The stored label may not select a profile any more (renamed, container); try them all.
    if (!(err instanceof BrowserCookieError) || !session.source?.profile) return (err as Error).message;
    try {
      found = await attempt();
    } catch (err2) {
      return (err2 as Error).message;
    }
  }
  if (session.user && found.user.id !== session.user.id) {
    return `${browser} is logged in as ${found.user.name || found.user.id}, not ${session.user.name || session.user.id}`;
  }
  return { cookie: found.cookie, user: { id: found.user.id, name: found.user.name }, profile: found.profile };
}

async function refreshAll(ctx: Context, onlyServer: string | undefined, reimportDead: boolean): Promise<RefreshResult[]> {
  const results: RefreshResult[] = [];
  for (const [server, session] of listStoredSessions()) {
    if (onlyServer && server !== onlyServer) continue;
    const now = new Date().toISOString();
    const name = session.user ? session.user.name || session.user.id : null;
    let user;
    try {
      user = await getSessionUser({ serverUrl: server, cookie: session.cookie, headers: ctx.headers(), timeout: 30000 });
    } catch (err) {
      const detail = (err as Error).message;
      updateStoredSession(server, { checkedAt: now, status: 'unreachable', error: detail });
      results.push({ server, user: name, result: 'unreachable', detail });
      continue;
    }
    if (user) {
      updateStoredSession(server, { checkedAt: now, status: 'ok', user: { id: user.id, name: user.name } });
      results.push({ server, user: user.name || user.id, result: 'alive' });
      continue;
    }
    if (reimportDead && session.source?.method === 'browser') {
      const outcome = await reimport(ctx, server, session);
      if (typeof outcome !== 'string') {
        updateStoredSession(server, {
          cookie: outcome.cookie, user: outcome.user, checkedAt: now, status: 'ok',
          source: { ...session.source, profile: outcome.profile },
        });
        results.push({ server, user: outcome.user.name || outcome.user.id, result: 'reimported', detail: `from ${session.source.browser}` });
        continue;
      }
      updateStoredSession(server, { checkedAt: now, status: 'expired', error: `re-import failed: ${outcome}` });
      results.push({ server, user: name, result: 'expired', detail: `re-import failed: ${outcome}` });
      continue;
    }
    updateStoredSession(server, { checkedAt: now, status: 'expired' });
    results.push({ server, user: name, result: 'expired', detail: session.source?.method === 'browser' ? undefined : 'log in again' });
  }
  return results;
}

// ---------------------------------------------------------------------------
// systemd user timer
// ---------------------------------------------------------------------------

function unitDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');
}

/** systemctl, overridable for tests. */
function systemctl(...args: string[]): { ok: boolean; output: string } {
  const bin = process.env.HEDGESYNC_SYSTEMCTL || 'systemctl';
  const r = spawnSync(bin, ['--user', ...args], { encoding: 'utf8' });
  if (r.error) return { ok: false, output: r.error.message };
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/** The command that runs this hedgesync: the compiled binary, or runtime + script. */
function selfCommand(): string[] {
  const bunMain = (globalThis as { Bun?: { main?: string } }).Bun?.main;
  const compiled = typeof bunMain === 'string' && bunMain.startsWith('/$bunfs/');
  return compiled || !process.argv[1] ? [process.execPath] : [process.execPath, resolve(process.argv[1])];
}

/** Quote one ExecStart word for systemd (and escape its specifiers). */
function systemdWord(word: string): string {
  const escaped = word.replace(/%/g, '%%');
  return /^[\w/.@:+-]+$/.test(escaped) ? escaped : `"${escaped.replace(/(["\\])/g, '\\$1')}"`;
}

export function timerUnits(exec: string[], cookieFile: string): { service: string; timer: string } {
  const service = `[Unit]
Description=Keep hedgesync's saved HedgeDoc sessions alive
Documentation=https://github.com/tionis/hedgesync

[Service]
Type=oneshot
ExecStart=${[...exec, 'sessions', 'refresh', '-q'].map(systemdWord).join(' ')}
Environment=NO_COLOR=1
Environment=${systemdWord(`HEDGESYNC_COOKIE_FILE=${cookieFile}`)}
`;
  const timer = `[Unit]
Description=Refresh hedgesync's HedgeDoc sessions daily

[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=1h

[Install]
WantedBy=timers.target
`;
  return { service, timer };
}

function timerState(): string | null {
  if (!existsSync(join(unitDir(), `${UNIT}.timer`))) return null;
  const enabled = systemctl('is-enabled', `${UNIT}.timer`);
  return enabled.ok ? 'enabled' : `installed, ${enabled.output || 'not enabled'}`;
}

// ---------------------------------------------------------------------------
// command
// ---------------------------------------------------------------------------

export const sessions: Command = {
  name: 'sessions',
  summary: 'List saved sessions, keep them alive (refresh, install-timer)',
  options: [
    { name: 'no-reimport', type: 'flag' },
    { name: 'exec', type: 'value' },
    { name: 'no-enable', type: 'flag' },
  ],
  help: () => `
${c('bold', 'hedgesync sessions')} - List saved sessions and keep them alive

${c('yellow', 'USAGE:')}
  hedgesync sessions                       List saved sessions
  hedgesync sessions refresh [server-url]  Check every (or one) saved session
  hedgesync sessions install-timer         Refresh daily via a systemd user timer
  hedgesync sessions uninstall-timer       Remove the timer

HedgeDoc sessions expire after two weeks without use (by default), and every
request renews them. ${c('cyan', 'refresh')} asks each server who you are (GET /me), which
renews a live session. A session that has expired is re-imported from the
browser it came from (${c('cyan', 'login --from-browser')}), as long as that browser is still
logged in as the same account; password logins have to be repeated by hand.
refresh exits with status 1 if a session needs attention.

Browser-imported sessions are shared with the browser: refreshing keeps the
browser logged in too.

${c('yellow', 'TIMER:')}
  install-timer writes ${c('cyan', `~/.config/systemd/user/${UNIT}.{service,timer}`)}
  (daily, catching up after suspend or downtime) and enables it. It runs
  the hedgesync you installed it with, so reinstall it if you move the binary.
  Logs: ${c('cyan', `journalctl --user -u ${UNIT}`)}

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '--no-reimport')}      refresh: do not re-import expired browser sessions
  ${c('cyan', '--exec')} <path>      install-timer: hedgesync binary to run (default: this one)
  ${c('cyan', '--no-enable')}        install-timer: only write the unit files
  ${c('cyan', '--json')}             JSON output
`,
  async run(ctx) {
    const action = ctx.positional[0] ?? 'list';
    switch (action) {
      case 'list':
      case 'ls': {
        const list = listStoredSessions();
        const timer = timerState();
        ctx.result({ action: 'sessions', file: cookieStorePath(), timer, sessions: list.map(([server, s]) => ({ server, ...s, cookie: undefined })) }, () => {
          if (list.length === 0) {
            print(c('dim', 'No saved sessions. Save one with: hedgesync login <server-url> --from-browser <browser> --save'));
          }
          for (const [server, s] of list) {
            const state = s.status === 'ok' ? c('green', 'ok') : s.status === 'expired' ? c('red', 'expired') : s.status === 'unreachable' ? c('yellow', 'unreachable') : c('dim', 'unchecked');
            print(`${c('bold', server)}  ${state}`);
            print(`  ${c('cyan', 'account:')} ${s.user ? s.user.name || s.user.id : c('dim', 'unknown')}`);
            print(`  ${c('cyan', 'source:')}  ${describeSource(s)}`);
            print(`  ${c('cyan', 'checked:')} ${relative(s.checkedAt)}${s.error ? c('dim', ` (${s.error})`) : ''}`);
          }
          print();
          print(c('dim', `Auto-refresh: ${timer ?? 'off (hedgesync sessions install-timer)'}`));
        });
        return;
      }

      case 'refresh': {
        const only = ctx.positional[1] ? ctx.server(1, 'hedgesync sessions refresh [server-url]') : undefined;
        const results = await refreshAll(ctx, only, !ctx.flag('no-reimport'));
        if (only && results.length === 0) throw new CliError(`No saved session for ${only}`);
        const attention = results.filter(r => r.result === 'expired');
        ctx.result({ action: 'refresh', results }, () => {
          if (results.length === 0) ctx.info(c('dim', 'No saved sessions'));
          for (const r of results) {
            const who = r.user ? ` (${r.user})` : '';
            const line = {
              alive: c('green', `✓ ${r.server}${who}: alive, renewed`),
              reimported: c('green', `✓ ${r.server}${who}: had expired, re-imported ${r.detail}`),
              expired: c('red', `✗ ${r.server}${who}: expired${r.detail ? ` (${r.detail})` : ''}`),
              unreachable: c('yellow', `! ${r.server}${who}: could not check (${r.detail})`),
            }[r.result];
            // Under the timer (-q) only problems are worth a log line.
            if (r.result === 'expired' || r.result === 'unreachable') ctx.warn(line);
            else ctx.info(line);
          }
        });
        if (attention.length) process.exitCode = 1;
        return;
      }

      case 'install-timer': {
        if (process.platform !== 'linux') {
          throw new CliError('install-timer uses systemd and only works on Linux',
            'Elsewhere, run "hedgesync sessions refresh -q" daily from cron or launchd.');
        }
        const exec = ctx.str('exec') ? [resolve(ctx.str('exec')!)] : selfCommand();
        const { service, timer } = timerUnits(exec, cookieStorePath());
        const dir = unitDir();
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${UNIT}.service`), service);
        writeFileSync(join(dir, `${UNIT}.timer`), timer);
        let enabled = false;
        if (!ctx.flag('no-enable')) {
          const reload = systemctl('daemon-reload');
          const enable = reload.ok ? systemctl('enable', '--now', `${UNIT}.timer`) : reload;
          if (!enable.ok) {
            throw new CliError(`Wrote the units to ${dir}, but systemctl failed: ${enable.output}`,
              `Enable them yourself: systemctl --user daemon-reload && systemctl --user enable --now ${UNIT}.timer`);
          }
          enabled = true;
        }
        ctx.result({ action: 'install-timer', dir, exec, enabled }, () => {
          ctx.info(c('green', `✓ Wrote ${UNIT}.service and ${UNIT}.timer to ${dir}`));
          ctx.info(enabled
            ? c('green', `✓ Enabled: saved sessions are refreshed daily (logs: journalctl --user -u ${UNIT})`)
            : c('dim', `Enable with: systemctl --user daemon-reload && systemctl --user enable --now ${UNIT}.timer`));
        });
        return;
      }

      case 'uninstall-timer': {
        const dir = unitDir();
        const files = [`${UNIT}.timer`, `${UNIT}.service`].map(f => join(dir, f));
        if (!files.some(f => existsSync(f))) throw new CliError('The timer is not installed');
        systemctl('disable', '--now', `${UNIT}.timer`);
        for (const f of files) rmSync(f, { force: true });
        systemctl('daemon-reload');
        ctx.result({ action: 'uninstall-timer', dir }, () => ctx.info(c('green', '✓ Timer removed')));
        return;
      }

      default:
        throw new CliError(`Unknown action '${action}'`, 'Use: list, refresh, install-timer, uninstall-timer');
    }
  },
};
