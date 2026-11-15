/**
 * login / logout: obtain, save and discard session cookies.
 */

import { AuthError, loginWithEmail, loginWithLDAP, type AuthResult, type SessionUser } from '../../auth.js';
import { BrowserCookieError, SUPPORTED_BROWSERS, sessionFromBrowser, type BrowserName } from '../../browser-cookies.js';
import { defaultHedgeSyncRequest } from '../../http.js';
import { extractSessionId, normalizeCookie } from '../../cookie.js';
import { parseServerUrl } from '../../url.js';
import { readStdin, type Command, type Context } from '../context.js';
import { cookieStorePath, getStoredSession, removeStoredSession, storeSession } from '../cookie-store.js';
import { CliError, c, eprint, print } from '../ui.js';

const METHODS = ['email', 'ldap'];
const BROWSER_ONLY = ['oidc', 'oauth', 'oauth2', 'oauth2-password', 'device-code-oidc', 'browser', 'github', 'gitlab', 'saml'];

interface LoginOutcome {
  method: string;
  cookie: string;
  user: SessionUser;
  sessionId?: string;
  browser?: string;
  profile?: string;
}

export const login: Command = {
  name: 'login',
  summary: 'Log in (email/LDAP or from a browser) and print or save a session cookie',
  options: [
    { name: 'method', short: 'm', type: 'value' },
    { name: 'username', short: 'u', type: 'value', aliases: ['user', 'email'] },
    { name: 'password-stdin', type: 'flag' },
    { name: 'password', short: 'p', type: 'value' }, // only to reject it with a useful message
    { name: 'from-browser', short: 'b', type: 'value' },
    { name: 'profile', type: 'value' },
    { name: 'save', type: 'flag' },
    { name: 'timeout', type: 'value' },
  ],
  help: () => `
${c('bold', 'hedgesync login')} - Log in and print or save a session cookie

${c('yellow', 'USAGE:')}
  hedgesync login <server-url> --from-browser <browser> [--profile <name>] [options]
  hedgesync login [email|ldap] <server-url> -u <user> [options]

${c('yellow', 'METHODS:')}
  ${c('cyan', '--from-browser')}     Reuse the session of a browser you are signed in with.
                     Works with every provider (OIDC, OAuth2, GitHub, SAML, ...)
  ${c('cyan', 'email')}              HedgeDoc email/password account (default)
  ${c('cyan', 'ldap')}               LDAP username/password

${c('yellow', 'BROWSER OPTIONS:')}
  ${c('cyan', '-b, --from-browser')} ${SUPPORTED_BROWSERS.join(', ')}
  ${c('cyan', '--profile')} <name>   Only look in this profile (name or directory; default:
                     every profile, freshest session first)

  Sign in to the server in that browser first. hedgesync reads the browser's
  cookie database (a copy, so the browser may stay open), and keeps the first
  cookie set that ${c('cyan', '/me')} accepts. Chromium-based browsers on Linux may need
  the desktop keyring (secret-tool or kwallet-query); on macOS the Keychain
  asks for permission. Windows Chromium cookies are not supported.

${c('yellow', 'PASSWORD OPTIONS:')}
  ${c('cyan', '-m, --method')}       email or ldap (alternative to the positional form)
  ${c('cyan', '-u, --username')}     Email address or LDAP username
  ${c('cyan', '--password-stdin')}   Read the password from stdin (first line)

  The password is taken from ${c('cyan', 'HEDGEDOC_PASSWORD')}, from stdin with
  --password-stdin, or prompted for on the terminal. It is never accepted as
  an argument, where other users could read it from the process list.

${c('yellow', 'COMMON OPTIONS:')}
  ${c('cyan', '--save')}             Save the cookie for this server instead of printing it;
                     later commands use it automatically
  ${c('cyan', '--timeout')} <s>      Request timeout in seconds (default: 30)
  ${c('cyan', '--json')}             Print the full result (cookie, user) as JSON
  ${c('cyan', '-q, --quiet')}        Suppress progress messages
  ${c('cyan', '-H, --header')}       Extra request header (e.g. for proxy auth)

  Every login is verified against ${c('cyan', '/me')}, so a wrong password or a logged-out
  browser is an error. Without --save, only the cookie goes to stdout;
  messages go to stderr.

  Saved cookies live in ${c('cyan', cookieStorePath())}
  (mode 0600; override with HEDGESYNC_COOKIE_FILE). --cookie and
  HEDGEDOC_COOKIE take precedence over a saved cookie. HedgeDoc sessions
  expire after two weeks without use; run the same login again to refresh.

${c('yellow', 'EXAMPLES:')}
  hedgesync login https://md.example.com --from-browser firefox --save
  hedgesync login https://md.example.com -b chromium --profile Work --save
  hedgesync login https://md.example.com -u me@example.com --save
  export HEDGEDOC_COOKIE="$(hedgesync login https://md.example.com -u me@example.com)"
  hedgesync login ldap https://md.example.com -u myuser --save
  pass show hedgedoc | hedgesync login https://md.example.com -u me@example.com --password-stdin --save
`,
  async run(ctx) {
    const browser = ctx.str('from-browser');
    const outcome = browser ? await loginFromBrowser(ctx, browser) : await loginWithPassword(ctx);
    const { serverUrl } = outcome;

    const save = ctx.flag('save');
    if (save) {
      storeSession(serverUrl, {
        cookie: outcome.cookie,
        user: { id: outcome.user.id, name: outcome.user.name },
        source: { method: outcome.method, browser: outcome.browser, profile: outcome.profile },
        checkedAt: new Date().toISOString(),
        status: 'ok',
      });
    }

    if (ctx.json) {
      ctx.result({
        method: outcome.method,
        serverUrl,
        cookie: outcome.cookie,
        sessionId: outcome.sessionId ?? extractSessionId(outcome.cookie),
        user: outcome.user,
        browser: outcome.browser,
        profile: outcome.profile,
        saved: save,
        acquiredAt: new Date().toISOString(),
      });
      return;
    }
    const from = outcome.browser ? ` (from ${outcome.browser}, profile ${outcome.profile})` : '';
    ctx.info(c('green', `✓ Logged in as ${outcome.user.name || outcome.user.id}${from}`));
    if (save) {
      ctx.info(c('dim', `Cookie saved to ${cookieStorePath()}`));
    } else {
      print(outcome.cookie);
    }
  },
};

async function loginFromBrowser(ctx: Context, browserArg: string): Promise<LoginOutcome & { serverUrl: string }> {
  const browser = browserArg.toLowerCase() as BrowserName;
  if (!SUPPORTED_BROWSERS.includes(browser)) {
    throw new CliError(`Unsupported browser '${browserArg}'`, `Supported: ${SUPPORTED_BROWSERS.join(', ')}`);
  }
  if (ctx.str('username') || ctx.flag('password-stdin') || ctx.str('method')) {
    throw new CliError('--from-browser cannot be combined with -u, -m or --password-stdin');
  }
  const serverUrl = ctx.server(0, 'hedgesync login <server-url> --from-browser <browser>');
  const profile = ctx.str('profile');
  ctx.info(c('dim', `Looking for a ${serverUrl} session in ${browser}${profile ? ` (profile ${profile})` : ''}...`));
  try {
    const session = await sessionFromBrowser(browser, {
      serverUrl,
      profile,
      headers: ctx.headers(),
      timeout: ctx.int('timeout', 30) * 1000,
    });
    return { method: 'browser', serverUrl, cookie: session.cookie, user: session.user, browser, profile: session.profile };
  } catch (err) {
    if (err instanceof BrowserCookieError) throw new CliError(err.message, err.hint);
    throw err;
  }
}

async function loginWithPassword(ctx: Context): Promise<LoginOutcome & { serverUrl: string }> {
  if (ctx.str('profile')) throw new CliError('--profile only applies to --from-browser');
  let method = (ctx.str('method') ?? 'email').toLowerCase();
  let urlIndex = 0;
  const first = ctx.positional[0]?.toLowerCase();
  if (first && (METHODS.includes(first) || BROWSER_ONLY.includes(first))) {
    method = first;
    urlIndex = 1;
  }
  if (BROWSER_ONLY.includes(method)) {
    throw new CliError(`'${method}' login is a browser redirect flow and cannot be done from the CLI`,
      'Sign in with a browser, then import its session: hedgesync login <server-url> --from-browser firefox --save');
  }
  if (!METHODS.includes(method)) {
    throw new CliError(`Unknown login method '${method}' (supported: ${METHODS.join(', ')}, or --from-browser)`);
  }
  const serverUrl = ctx.server(urlIndex, 'hedgesync login [email|ldap] <server-url> -u <user>');
  if (ctx.str('password') !== undefined) {
    throw new CliError('Passwords are not accepted as arguments', 'Use HEDGEDOC_PASSWORD, --password-stdin, or enter it at the prompt.');
  }
  const username = ctx.str('username');
  if (!username) {
    throw new CliError(`${method === 'email' ? 'Email address' : 'Username'} required (-u)`,
      method === 'email' ? 'For OIDC/OAuth/SAML servers use --from-browser <browser> instead.' : undefined);
  }

  let password: string;
  if (ctx.flag('password-stdin')) {
    password = (await readStdin('Pipe the password into --password-stdin')).split(/\r?\n/)[0];
  } else if (process.env.HEDGEDOC_PASSWORD) {
    password = process.env.HEDGEDOC_PASSWORD;
  } else if (process.stdin.isTTY && process.stderr.isTTY) {
    password = await promptHidden(`Password for ${username}: `);
  } else {
    throw new CliError('No password given', 'Use HEDGEDOC_PASSWORD or --password-stdin when not running on a terminal.');
  }
  if (!password) throw new CliError('Empty password');

  const timeout = ctx.int('timeout', 30) * 1000;
  const headers = ctx.headers();
  ctx.info(c('dim', `Logging in to ${serverUrl} as ${username} (${method})...`));

  let result: AuthResult;
  try {
    result = method === 'email'
      ? await loginWithEmail({ serverUrl, email: username, password, headers, timeout })
      : await loginWithLDAP({ serverUrl, username, password, headers, timeout });
  } catch (err) {
    if (err instanceof AuthError) throw new CliError(err.message, undefined, { statusCode: err.statusCode });
    throw err;
  }
  return { method, serverUrl, cookie: result.cookie, user: result.user, sessionId: result.sessionId };
}

export const logout: Command = {
  name: 'logout',
  summary: 'End and forget a saved session',
  options: [{ name: 'end-session', type: 'flag' }],
  help: () => `
${c('bold', 'hedgesync logout')} - End and forget a saved session

${c('yellow', 'USAGE:')}
  hedgesync logout <server-url> [--end-session]

Ends the session on the server (GET /logout) and removes the cookie saved by
${c('cyan', 'hedgesync login --save')}. With --cookie or HEDGEDOC_COOKIE, ends that session
instead (nothing is removed from disk).

A session imported with ${c('cyan', '--from-browser')} is the browser's own session, so ending it
would log the browser out too. For those, logout only forgets the cookie,
unless --end-session is given.

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '--end-session')}      Also end a browser-imported session on the server
`,
  async run(ctx) {
    const serverUrl = ctx.server(0, 'hedgesync logout <server-url>');
    const explicit = ctx.str('cookie') || process.env.HEDGEDOC_COOKIE;
    const stored = explicit ? undefined : getStoredSession(serverUrl);
    const cookie = explicit || stored?.cookie;
    if (!cookie) throw new CliError(`No saved session for ${serverUrl}`);

    const sharedWithBrowser = stored?.source?.method === 'browser';
    const endOnServer = !sharedWithBrowser || ctx.flag('end-session');
    let endedOnServer = false;
    if (endOnServer) {
      try {
        const res = await defaultHedgeSyncRequest({
          url: `${parseServerUrl(serverUrl)}/logout`,
          headers: { ...ctx.headers(), Cookie: normalizeCookie(cookie) },
          redirect: 'manual',
        });
        endedOnServer = res.status >= 200 && res.status < 400;
      } catch {
        endedOnServer = false;
      }
    }
    const removed = explicit ? false : removeStoredSession(serverUrl);
    ctx.result({ action: 'logout', serverUrl, endedOnServer, removed }, () => {
      if (endOnServer && !endedOnServer) ctx.warn('Could not reach the server to end the session');
      if (!endOnServer) {
        ctx.info(c('green', '✓ Forgot the saved cookie'));
        ctx.info(c('dim', `The session belongs to ${stored!.source!.browser}, which stays logged in. Use --end-session to log out there too.`));
        return;
      }
      ctx.info(c('green', removed ? '✓ Logged out and removed the saved cookie' : '✓ Logged out'));
    });
  },
};

/** Prompt on stderr and read a line from the terminal without echoing it. */
function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const finish = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      eprint();
      if (err) reject(err);
      else resolvePromise(value);
    };
    const onData = (data: string) => {
      for (const ch of data) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish();
        if (ch === '\u0003') return finish(new CliError('Cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
