/**
 * Safe shell command construction and execution for macros (Node/Bun only).
 *
 * Macro commands are operator-written templates such as `llm "Summarize: {DOC}"`
 * or `echo {1} | tr a-z A-Z`, but the values substituted into them come from
 * the note, which anyone with write access controls. Splicing those values
 * into the command string would let collaborators run arbitrary commands.
 *
 * Instead, each placeholder is replaced by a reference to an environment
 * variable (`{1}` -> `${HS_1}`), quoted to suit its position in the template,
 * and the value is passed in the environment. The shell expands a variable
 * reference exactly once and never re-parses the result, so note content is
 * always data, never code.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

/** A command to run with `sh -c`, plus extra environment and stdin. */
export interface ShellCommand {
  command: string;
  env?: Record<string, string>;
  stdin?: string;
}

/** Environment variable that carries placeholder `name`. */
export function placeholderEnvName(name: string): string {
  return `HS_${name.toUpperCase()}`;
}

/**
 * Turn a template with `{NAME}` placeholders into a command plus environment.
 *
 * Only names present in `values` are replaced; other braces are left alone.
 * A backslash escapes the next character outside single quotes, as in sh.
 * Placeholders are rewritten per quoting context:
 *   bare      {1}   -> "${HS_1}"
 *   "..{1}.." {1}   -> ${HS_1}        (already inside double quotes)
 *   '..{1}..' {1}   -> '"${HS_1}"'    (close, insert quoted, reopen)
 */
export function renderShellTemplate(template: string, values: Record<string, string>): ShellCommand {
  const env: Record<string, string> = {};
  let out = '';
  let quote: 'none' | 'single' | 'double' = 'none';

  for (let i = 0; i < template.length; i++) {
    const ch = template[i];

    if (ch === '\\' && quote !== 'single' && i + 1 < template.length) {
      out += ch + template[i + 1];
      i++;
      continue;
    }
    if (ch === "'" && quote !== 'double') {
      quote = quote === 'single' ? 'none' : 'single';
      out += ch;
      continue;
    }
    if (ch === '"' && quote !== 'single') {
      quote = quote === 'double' ? 'none' : 'double';
      out += ch;
      continue;
    }
    if (ch === '{') {
      const m = /^\{([A-Za-z0-9_]+)\}/.exec(template.slice(i));
      if (m && Object.prototype.hasOwnProperty.call(values, m[1])) {
        const name = placeholderEnvName(m[1]);
        env[name] = values[m[1]];
        const ref = '${' + name + '}';
        out += quote === 'double' ? ref : quote === 'single' ? `'"${ref}"'` : `"${ref}"`;
        i += m[0].length - 1;
        continue;
      }
    }
    out += ch;
  }

  return { command: out, env };
}

/** Normalise a command builder result. */
export function toShellCommand(value: string | ShellCommand): ShellCommand {
  return typeof value === 'string' ? { command: value } : value;
}

export interface SpawnShellOptions {
  /** Kill the process after this many ms. */
  timeoutMs?: number;
}

/** Live commands; they run in their own process group, so clean up on exit. */
const live = new Set<ChildProcess>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const proc of live) killShell(proc);
  });
}

/** Start `sh -c command` with stdout/stderr piped. Writes stdin if given. */
export function spawnShell(cmd: ShellCommand, options: SpawnShellOptions = {}): ChildProcess & { exitCode$: Promise<number> } {
  const proc = spawn('sh', ['-c', cmd.command], {
    stdio: [cmd.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...cmd.env },
    // Own process group, so killShell() also stops the command's children.
    detached: process.platform !== 'win32',
  });
  installExitHook();
  live.add(proc);
  if (cmd.stdin !== undefined && proc.stdin) {
    proc.stdin.on('error', () => {}); // process may exit without reading stdin
    proc.stdin.end(cmd.stdin);
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (options.timeoutMs && options.timeoutMs > 0) {
    timer = setTimeout(() => killShell(proc), options.timeoutMs);
  }
  const exitCode$ = new Promise<number>((resolve) => {
    let settled = false;
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      live.delete(proc);
      if (timer) clearTimeout(timer);
      resolve(code);
    };
    proc.on('close', (code, signal) => done(code ?? (signal ? 128 : 1)));
    // Killed on Windows: a forked grandchild may survive taskkill and keep the
    // pipes open, so finish when the shell itself exits.
    proc.on('exit', (code, signal) => {
      if (process.platform !== 'win32' || !killed.has(proc)) return;
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      done(code ?? (signal ? 128 : 1));
    });
    proc.on('error', () => done(127));
  });
  return Object.assign(proc, { exitCode$ });
}

const killed = new WeakSet<ChildProcess>();

/** Terminate a process started by spawnShell, including its children. */
export function killShell(proc: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  killed.add(proc);
  try {
    if (proc.pid && process.platform === 'win32') {
      // No process groups: kill the tree, or children (sleep, curl, ...)
      // keep running and hold the output pipes open.
      spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    }
    if (proc.pid) {
      process.kill(-proc.pid, signal);
      return;
    }
  } catch {
    // Group already gone; fall back to the process itself.
  }
  proc.kill(signal);
}

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command to completion, collecting output. */
export async function runShell(cmd: ShellCommand, options: SpawnShellOptions = {}): Promise<ShellResult> {
  const proc = spawnShell(cmd, options);
  let stdout = '';
  let stderr = '';
  proc.stdout?.setEncoding('utf8');
  proc.stderr?.setEncoding('utf8');
  proc.stdout?.on('data', (d: string) => { stdout += d; });
  proc.stderr?.on('data', (d: string) => { stderr += d; });
  const code = await proc.exitCode$;
  return { code, stdout, stderr };
}
