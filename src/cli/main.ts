/**
 * hedgesync command-line interface.
 */

import { parseArgs, splitCommand, type OptionSpec } from './args.js';
import { Context, globalOptions, toCliError, type Command } from './context.js';
import { documentCommands } from './commands/document.js';
import { watch } from './commands/watch.js';
import { info, users, authors } from './commands/info.js';
import { transform } from './commands/transform.js';
import { macro } from './commands/macro.js';
import { mirror } from './commands/mirror.js';
import { exec } from './commands/exec.js';
import { terminal } from './commands/terminal.js';
import { bridge } from './commands/bridge.js';
import { editor } from './commands/editor.js';
import { edit } from './commands/edit.js';
import { create, download, exportNotes, history, historyDelete, me, pin, status, unpin } from './commands/api.js';
import { revisions } from './commands/revisions.js';
import { meta, publish } from './commands/settings.js';
import { login, logout } from './commands/login.js';
import { sessions } from './commands/sessions.js';
import { deleteNote, list, permission, search, upload } from './commands/notes.js';
import { CliError, c, eprint, print, printJson, setColor } from './ui.js';
import { VERSION } from '../version.js';

const realtimeCommands: Command[] = [
  edit, ...documentCommands, watch, info, users, authors, meta, permission, deleteNote, transform, macro, mirror, exec, terminal, bridge,
];
const httpCommands: Command[] = [
  list, search, download, create, upload, publish, revisions, me, exportNotes, history, pin, unpin, historyDelete, status, login, logout, sessions,
];
const setupCommands: Command[] = [editor];
const commands = new Map<string, Command>([...realtimeCommands, ...httpCommands, ...setupCommands]
  .flatMap(cmd => [cmd.name, ...(cmd.aliases ?? [])].map(name => [name, cmd] as const)));

function overview(): string {
  const row = (cmd: Command) => `  ${c('green', cmd.name.padEnd(15))} ${cmd.summary}`;
  return `
${c('bold', 'hedgesync')} - HedgeDoc command-line client

${c('yellow', 'USAGE:')}
  hedgesync <command> <url> [options]
  hedgesync help <command>

${c('yellow', 'NOTE COMMANDS:')} ${c('dim', '(realtime connection to a note URL)')}
${realtimeCommands.map(row).join('\n')}

${c('yellow', 'HTTP COMMANDS:')}
${httpCommands.map(row).join('\n')}

${c('yellow', 'SETUP COMMANDS:')}
${setupCommands.map(row).join('\n')}

${c('yellow', 'GLOBAL OPTIONS:')}
  ${c('cyan', '-c, --cookie')} <cookie>  Session cookie (default: HEDGEDOC_COOKIE, then a cookie
                         saved with ${c('cyan', 'hedgesync login --save')})
  ${c('cyan', '-H, --header')} <header>  Extra HTTP header, "Name: value" (repeatable)
  ${c('cyan', '--json')}                 Machine-readable output
  ${c('cyan', '-q, --quiet')}            Suppress progress messages
  ${c('cyan', '--no-color')}             Disable colours (also NO_COLOR=1)
  ${c('cyan', '--no-reconnect')}         Do not reconnect dropped realtime sessions
  ${c('cyan', '--debug')}                Show stack traces on errors

${c('yellow', 'ENVIRONMENT:')}
  ${c('cyan', 'HEDGEDOC_COOKIE')}        Session cookie (same as --cookie)
  ${c('cyan', 'HEDGEDOC_HEADERS')}       Extra headers, as JSON or "Name: value; Name2: value"
  ${c('cyan', 'HEDGEDOC_PASSWORD')}      Password for ${c('cyan', 'login')}
  ${c('cyan', 'HEDGESYNC_COOKIE_FILE')}  Where ${c('cyan', 'login --save')} stores cookies

${c('yellow', 'EXAMPLES:')}
  hedgesync get https://md.example.com/abc123 > note.md
  hedgesync set https://md.example.com/abc123 -f note.md
  echo "- $(date): done" | hedgesync append https://md.example.com/abc123
  hedgesync replace https://md.example.com/abc123 "old" "new" --all
  hedgesync login https://md.example.com -u me@example.com --save
`;
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes('--no-color')) setColor(false);
  const { command: name, rest } = splitCommand(argv, globalOptions);

  if (name === 'version' || (!name && (argv.includes('--version') || argv.includes('-V')))) {
    print(VERSION);
    return 0;
  }

  if (!name || name === 'help') {
    const topic = name === 'help' ? rest.find(a => !a.startsWith('-')) : undefined;
    const cmd = topic ? commands.get(topic) : undefined;
    if (topic && !cmd) {
      eprint(c('red', `Unknown command: ${topic}`));
      return 1;
    }
    print(cmd ? cmd.help() : overview());
    return 0;
  }
  const cmd = commands.get(name);
  if (!cmd) {
    eprint(c('red', `Unknown command: ${name}`));
    eprint(c('dim', 'Run hedgesync help for a list of commands.'));
    return 1;
  }

  const specs: OptionSpec[] = [...globalOptions, ...cmd.options];
  let json = argv.includes('--json');
  let debug = argv.includes('--debug');
  try {
    const args = parseArgs(name, rest, specs);
    json = args.options.json === true;
    debug = args.options.debug === true;
    if (args.options.help === true) {
      print(cmd.help());
      return 0;
    }
    await cmd.run(new Context(args));
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch (err) {
    const error = toCliError(err);
    if (json) {
      printJson({ success: false, error: error.message, ...(error.hint ? { hint: error.hint } : {}), ...error.details });
    } else {
      eprint(c('red', `Error: ${error.message}`));
      if (error.hint) eprint(c('dim', error.hint));
    }
    if (debug && err instanceof Error && !(err instanceof CliError)) eprint(err.stack);
    return 1;
  }
}

/** Run the CLI and exit with its status (after output has drained). */
export function run(argv: string[] = process.argv.slice(2)): void {
  main(argv).then(
    (code) => {
      process.exitCode = code;
      // Realtime sockets and timers may keep the loop alive; leave once output is flushed.
      process.stdout.write('', () => process.exit(code));
    },
    (err) => {
      eprint(String(err?.stack ?? err));
      process.exit(1);
    },
  );
}
