/**
 * terminal: a shared shell session inside a note.
 */

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { NoteTerminal, type TerminalCommandEvent, type TerminalDoneEvent, type TerminalRefusedEvent } from '../../terminal.js';
import type { UserInfo } from '../../hedgedoc-client.js';
import { assertEditable, connectionOptions, type Command } from '../context.js';
import { CliError, c, eprint, print } from '../ui.js';

export const terminal: Command = {
  name: 'terminal',
  aliases: ['term'],
  summary: 'Share a shell session through a note',
  options: [
    ...connectionOptions,
    { name: 'allow-user', short: 'u', type: 'multi' },
    { name: 'anyone', type: 'flag' },
    { name: 'shell', type: 'value' },
    { name: 'cwd', type: 'value' },
    { name: 'block', type: 'value' },
    { name: 'timeout', type: 'value' },
    { name: 'max-output', type: 'value' },
  ],
  help: () => `
${c('bold', 'hedgesync terminal')} - Share a shell session through a note

${c('yellow', 'USAGE:')}
  hedgesync terminal <url> [options]

Turns a code block in the note into a terminal. Type a command after the
${c('cyan', '$')} prompt and press Enter: hedgesync runs it on this machine, streams the
output into the note and adds a new prompt. One shell runs for the whole
session, so ${c('cyan', 'cd')}, variables and functions persist.

  ${c('dim', '```terminal')}
  ${c('dim', '$ uname -a')}
  ${c('dim', 'Linux box 6.12.0 x86_64 GNU/Linux')}
  ${c('dim', '$ ')}
  ${c('dim', '```')}

The block is added at the end of the note if it has none. Multi-line input
(heredocs, pasted scripts) runs once it ends in an empty line. Commands get
no input (stdin is /dev/null) and no TTY, so interactive programs such as
editors, pagers and password prompts do not work.

${c('yellow', 'SECURITY:')}
  Whoever may run commands gets a shell on this machine as you. By default
  only your own account (from the session cookie) may; input that anyone
  else edited is refused, not run. Without a signed-in session you must say
  who may run commands.

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-u, --allow-user')} <id>  Account id allowed to run commands (repeatable;
                         replaces the default of your own account). See ids
                         with: hedgesync users <url> --json
  ${c('cyan', '--anyone')}               Let everyone who can edit the note run commands
  ${c('cyan', '--shell')} <shell>        POSIX shell to use (default: bash, else sh)
  ${c('cyan', '--cwd')} <dir>            Directory the shell starts in
  ${c('cyan', '--block')} <name>         Info string of the terminal block (default: terminal)
  ${c('cyan', '--timeout')} <s>          Kill commands after this many seconds (restarts the
                         shell, so its state is lost)
  ${c('cyan', '--max-output')} <chars>   Output shown per command (default: 20000)

Ctrl+C stops the session and marks the block ${c('dim', '[terminal closed]')}.

${c('yellow', 'EXAMPLES:')}
  hedgesync terminal https://md.example.com/ops
  hedgesync terminal https://md.example.com/ops --cwd ~/project --timeout 300
  hedgesync terminal https://md.example.com/demo --shell sh -u 7f3c...
`,
  async run(ctx) {
    const { serverUrl } = ctx.note(0, 'hedgesync terminal <url> [options]');
    const anyone = ctx.flag('anyone');
    let allowed: string[] | null = ctx.list('allow-user');
    if (anyone && allowed.length > 0) throw new CliError('Use either --anyone or --allow-user, not both');

    const timeout = ctx.str('timeout');
    const timeoutMs = timeout === undefined ? 0 : Math.round(Number(timeout) * 1000);
    if (timeout !== undefined && !(timeoutMs > 0)) throw new CliError(`--timeout must be a number of seconds, got '${timeout}'`);
    const maxOutput = ctx.int('max-output', 20000);
    if (maxOutput < 1) throw new CliError('--max-output must be positive');
    const cwdArg = ctx.str('cwd');
    const cwd = cwdArg ? resolve(cwdArg) : undefined;
    if (cwd && !(existsSync(cwd) && statSync(cwd).isDirectory())) throw new CliError(`Not a directory: ${cwdArg}`);

    if (anyone) {
      allowed = null;
    } else if (allowed.length === 0) {
      const profile = ctx.cookieFor(serverUrl)
        ? await ctx.api(serverUrl).getProfile().catch(() => null)
        : null;
      if (!profile?.id) {
        throw new CliError('Not signed in, so there is no account to limit commands to',
          'Sign in (hedgesync login <server> --save), name accounts with --allow-user <id>, or pass --anyone.');
      }
      allowed = [profile.id];
      ctx.info(c('dim', `Only ${profile.name ?? profile.id} may run commands`));
    }

    const client = await ctx.connect(0);
    try {
      assertEditable(client);
    } catch (err) {
      client.disconnect();
      throw err;
    }
    if (anyone) {
      const permission = client.getNoteInfo().permission;
      ctx.warn(`Anyone who can edit this note (permission: ${permission || 'unknown'}) can run commands as you.`);
    }

    const term = new NoteTerminal(client, {
      blockName: ctx.str('block'),
      shell: ctx.str('shell'),
      cwd,
      env: { HEDGESYNC_NOTE: ctx.positional[0] },
      allowedUserIds: allowed,
      timeoutMs,
      maxOutput,
    });

    const who = (user: UserInfo | null) => user?.name || (user ? 'anonymous' : 'unknown');
    const log = (record: Record<string, unknown>, human: string) => {
      if (ctx.json) print(JSON.stringify({ time: new Date().toISOString(), ...record }));
      else if (!ctx.quiet) eprint(human);
    };
    term.on('command', (e: TerminalCommandEvent) => {
      log({ event: 'command', command: e.command, user: e.user?.name ?? null, userid: e.user?.userid ?? null },
        `${c('dim', `[${who(e.user)}]`)} ${c('cyan', '$')} ${e.command.split('\n')[0]}${e.command.includes('\n') ? c('dim', ' …') : ''}`);
    });
    term.on('done', (e: TerminalDoneEvent) => {
      const status = e.timedOut ? 'timed out' : e.code === null ? 'killed' : `exit ${e.code}`;
      log({ event: 'done', command: e.command, code: e.code, timedOut: e.timedOut, durationMs: e.durationMs },
        c(e.code === 0 ? 'dim' : 'yellow', `  ${status}, ${(e.durationMs / 1000).toFixed(1)}s`));
    });
    term.on('refused', (e: TerminalRefusedEvent) => {
      log({ event: 'refused', command: e.command, users: e.users.map(u => ({ name: u.name ?? null, userid: u.userid ?? null })) },
        c('red', `  refused (edited by ${e.users.map(u => who(u)).join(', ')}): ${e.command.split('\n')[0]}`));
    });
    term.on('warning', (message: string) => ctx.warn(message));
    term.on('error', (err: Error) => eprint(c('red', `Terminal error: ${err.message}`)));

    term.start();
    ctx.info(c('cyan', `Terminal running in the \`\`\`${term.blockName} block (shell: ${term.shell}). Ctrl+C to stop.`));

    await new Promise<void>((done) => {
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        term.stop();
        try {
          await client.flush(5000);
        } catch {
          // Leaving anyway.
        }
        client.disconnect();
        ctx.info(c('cyan', 'Terminal closed.'));
        done();
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      client.once('delete', () => {
        ctx.warn('Note was deleted');
        void stop();
      });
    });
  },
};
