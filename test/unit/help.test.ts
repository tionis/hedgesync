/**
 * The CLI documents itself: every command has help, and every option a
 * command accepts is mentioned in it.
 */
import { expect, test } from 'bun:test';
import { allCommands } from '../../src/cli/main.js';

process.env.NO_COLOR = '1';
const GLOBAL = new Set(['help', 'json', 'quiet', 'no-color', 'debug', 'cookie', 'header', 'no-reconnect']);

test.each(allCommands.map(cmd => [cmd.name, cmd] as const))('%s documents its options', (_name, cmd) => {
  const help = typeof cmd.help === 'function' ? cmd.help() : String(cmd.help ?? '');
  expect(help).toContain(`hedgesync ${cmd.name}`);
  const undocumented = (cmd.options ?? []).map(o => o.name).filter(n => !GLOBAL.has(n) && !help.includes(`--${n}`));
  expect(undocumented).toEqual([]);
});
