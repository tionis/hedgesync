/**
 * login / logout: obtain, save and discard session cookies.
 */

import { AuthError, loginWithEmail, loginWithLDAP, type AuthResult } from '../../auth.js';
import { defaultHedgeSyncRequest } from '../../http.js';
import { normalizeCookie } from '../../cookie.js';
import { parseServerUrl } from '../../url.js';
import { readStdin, type Command } from '../context.js';
import { cookieStorePath, getStoredSession, removeStoredSession, storeSession } from '../cookie-store.js';
import { CliError, c, eprint, print } from '../ui.js';

const METHODS = ['email', 'ldap'];
const BROWSER_ONLY = ['oidc', 'oauth', 'oauth2', 'oauth2-password', 'device-code-oidc', 'browser', 'github', 'gitlab', 'saml'];

export const login: Command = {
  name: 'login',
  summary: 'Log in (email/LDAP) and print or save a session cookie',
  options: [
    { name: 'method', short: 'm', type: 'value' },
    { name: 'username', short: 'u', type: 'value', aliases: ['user', 'email'] },
    { name: 'password-stdin', type: 'flag' },
    { name: 'password', short: 'p', type: 'value' }, // only to reject it with a useful message
    { name: 'save', type: 'flag' },
    { name: 'timeout', type: 'value' },
  ],
  help: () => `
${c('bold', 'hedgesync login')} - Log in and print or save a session cookie

${c('yellow', 'USAGE:')}
  hedgesync login [email|ldap] <server-url> -u <user> [options]

${c('yellow', 'METHODS:')}
  ${c('cyan', 'email')}              HedgeDoc email/password account (default)
  ${c('cyan', 'ldap')}               LDAP username/password

  Other providers (OAuth2, OIDC, GitHub, SAML, ...) are browser-only: sign in
  with a browser and copy the ${c('cyan', 'connect.sid')} cookie from its developer tools.

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-m, --method')}       email or ldap (alternative to the positional form)
  ${c('cyan', '-u, --username')}     Email address or LDAP username
  ${c('cyan', '--password-stdin')}   Read the password from stdin (first line)
  ${c('cyan', '--save')}             Save the cookie for this server instead of printing it;
                     later commands use it automatically
  ${c('cyan', '--timeout')} <s>      Request timeout in seconds (default: 30)
  ${c('cyan', '--json')}             Print the full result (cookie, user) as JSON
  ${c('cyan', '-q, --quiet')}        Suppress progress messages
  ${c('cyan', '-H, --header')}       Extra request header (e.g. for proxy auth)

  The password is taken from ${c('cyan', 'HEDGEDOC_PASSWORD')}, from stdin with
  --password-stdin, or prompted for on the terminal. It is never accepted as
  an argument, where other users could read it from the process list.

  The login is verified against ${c('cyan', '/me')}, so a wrong password is an error.
  Without --save, only the cookie goes to stdout; messages go to stderr.

  Saved cookies live in ${c('cyan', cookieStorePath())}
  (mode 0600; override with HEDGESYNC_COOKIE_FILE). --cookie and
  HEDGEDOC_COOKIE take precedence over a saved cookie.

${c('yellow', 'EXAMPLES:')}
  hedgesync login https://md.example.com -u me@example.com --save
  export HEDGEDOC_COOKIE="$(hedgesync login https://md.example.com -u me@example.com)"
  hedgesync login ldap https://md.example.com -u myuser --save
  pass show hedgedoc | hedgesync login https://md.example.com -u me@example.com --password-stdin --save
`,
  async run(ctx) {
    let method = (ctx.str('method') ?? 'email').toLowerCase();
    let urlIndex = 0;
    const first = ctx.positional[0]?.toLowerCase();
    if (first && (METHODS.includes(first) || BROWSER_ONLY.includes(first))) {
      method = first;
      urlIndex = 1;
    }
    if (BROWSER_ONLY.includes(method)) {
      throw new CliError(`'${method}' login is a browser redirect flow and cannot be done from the CLI`,
        'Sign in with a browser and copy the connect.sid cookie from its developer tools, then use --cookie or HEDGEDOC_COOKIE.');
    }
    if (!METHODS.includes(method)) {
      throw new CliError(`Unknown login method '${method}' (supported: ${METHODS.join(', ')})`);
    }
    const serverUrl = ctx.server(urlIndex, 'hedgesync login [email|ldap] <server-url> -u <user>');
    if (ctx.str('password') !== undefined) {
      throw new CliError('Passwords are not accepted as arguments', 'Use HEDGEDOC_PASSWORD, --password-stdin, or enter it at the prompt.');
    }
    const username = ctx.str('username');
    if (!username) throw new CliError(`${method === 'email' ? 'Email address' : 'Username'} required (-u)`);

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

    const save = ctx.flag('save');
    if (save) storeSession(serverUrl, { cookie: result.cookie, user: { id: result.user.id, name: result.user.name } });

    if (ctx.json) {
      ctx.result({
        method,
        serverUrl,
        cookie: result.cookie,
        sessionId: result.sessionId,
        user: result.user,
        saved: save,
        acquiredAt: result.acquiredAt.toISOString(),
      });
      return;
    }
    ctx.info(c('green', `✓ Logged in as ${result.user.name || result.user.id}`));
    if (save) {
      ctx.info(c('dim', `Cookie saved to ${cookieStorePath()}`));
    } else {
      print(result.cookie);
    }
  },
};

export const logout: Command = {
  name: 'logout',
  summary: 'End and forget a saved session',
  options: [],
  help: () => `
${c('bold', 'hedgesync logout')} - End and forget a saved session

${c('yellow', 'USAGE:')}
  hedgesync logout <server-url>

Ends the session on the server (GET /logout) and removes the cookie saved by
${c('cyan', 'hedgesync login --save')}. With --cookie or HEDGEDOC_COOKIE, ends that session
instead (nothing is removed from disk).
`,
  async run(ctx) {
    const serverUrl = ctx.server(0, 'hedgesync logout <server-url>');
    const explicit = ctx.str('cookie') || process.env.HEDGEDOC_COOKIE;
    const cookie = explicit || getStoredSession(serverUrl)?.cookie;
    if (!cookie) throw new CliError(`No saved session for ${serverUrl}`);

    let endedOnServer = false;
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
    const removed = explicit ? false : removeStoredSession(serverUrl);
    ctx.result({ action: 'logout', serverUrl, endedOnServer, removed }, () => {
      if (!endedOnServer) ctx.warn('Could not reach the server to end the session');
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
