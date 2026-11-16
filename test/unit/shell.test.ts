import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderShellTemplate, runShell } from '../../src/shell.js';

const canaryDir = mkdtempSync(join(tmpdir(), 'hedgesync-shell-'));
const canary = join(canaryDir, 'pwned');

/** Payloads that would execute `touch canary` if spliced into a command. */
const payloads = [
  `$(touch ${canary})`,
  `\`touch ${canary}\``,
  `"; touch ${canary}; echo "`,
  `'; touch ${canary}; echo '`,
  `x' "$(touch ${canary})" '`,
  `\\"; touch ${canary} #`,
  `a\nb; touch ${canary}`,
  `*`,
  `\${HOME}`,
];

describe('renderShellTemplate', () => {
  for (const [label, template] of [
    ['bare', 'printf %s {1}'],
    ['double-quoted', 'printf %s "{1}"'],
    ['single-quoted', "printf %s '{1}'"],
  ] as const) {
    test(`${label} placeholder passes payloads through literally`, async () => {
      for (const payload of payloads) {
        const result = await runShell(renderShellTemplate(template, { '1': payload }));
        expect(result.code).toBe(0);
        expect(result.stdout).toBe(payload);
        expect(existsSync(canary)).toBe(false);
      }
    });
  }

  test('surrounding text inside quotes is kept', async () => {
    const cmd = renderShellTemplate('printf %s "pre {1} post" \'and {1}\'', { '1': '$(id)' });
    const result = await runShell(cmd);
    expect(result.stdout).toBe('pre $(id) postand $(id)');
  });

  test('each placeholder is exactly one argument', async () => {
    const cmd = renderShellTemplate('printf "<%s>" {1} {DOC}', { '1': 'a b  c', DOC: '' });
    expect((await runShell(cmd)).stdout).toBe('<a b  c><>');
  });

  test('escaped and unknown placeholders stay literal', async () => {
    const cmd = renderShellTemplate('printf %s \\{1} {2} {x-y}', { '1': 'one' });
    expect((await runShell(cmd)).stdout).toBe('{1}{2}{x-y}');
  });

  test('values travel in the environment, not the command', () => {
    const cmd = renderShellTemplate('echo {DOC}', { DOC: 'secret text' });
    expect(cmd.command).not.toContain('secret');
    expect(cmd.env).toEqual({ HS_DOC: 'secret text' });
  });
});

describe('runShell', () => {
  test('reports exit code and stderr', async () => {
    const result = await runShell({ command: 'echo out; echo err >&2; exit 3' });
    expect(result).toEqual({ code: 3, stdout: 'out\n', stderr: 'err\n' });
  });

  test('passes stdin', async () => {
    expect((await runShell({ command: 'sort', stdin: 'b\na\n' })).stdout).toBe('a\nb\n');
  });

  test('large stderr does not deadlock', async () => {
    const result = await runShell({ command: 'head -c 300000 /dev/zero >&2; echo done' });
    expect(result.stdout).toBe('done\n');
  });

  test('timeout kills the command', async () => {
    const started = Date.now();
    const result = await runShell({ command: 'sleep 5' }, { timeoutMs: 100 });
    expect(result.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('timeout ends a command whose shell forked a child', async () => {
    // Not the last command, so the shell forks for sleep instead of exec'ing it.
    const started = Date.now();
    const result = await runShell({ command: 'echo start; sleep 5; echo end' }, { timeoutMs: 500 });
    expect(result.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

process.on('exit', () => rmSync(canaryDir, { recursive: true, force: true }));
