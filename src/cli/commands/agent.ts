/**
 * agent: set AI agents up to work with HedgeDoc notes.
 *
 *   hedgesync agent install | status | path | uninstall   the bundled skill
 *   hedgesync agent config <client>                      MCP server config
 *
 * The skill (plugin/skills/hedgesync, the Agent Skills format) is embedded at build
 * time like the Neovim plugin, and installed the same way: a marker records
 * what was written, so updates replace it and local edits are kept.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { VERSION } from '../../version.js';
import type { Command, Context } from '../context.js';
import { SKILL_FILES } from '../skill.generated.js';
import { CliError, c, print } from '../ui.js';
import { inspectInstall, installPlugin, uninstallPlugin } from './editor.js';

export const SKILL_TARGETS = ['claude', 'agents'] as const;
export type SkillTarget = typeof SKILL_TARGETS[number];

/** Where a target's skills live: Claude Code reads .claude/skills, Codex and others .agents/skills. */
export function skillDir(target: SkillTarget, project: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (project) return join(project, target === 'claude' ? '.claude' : '.agents', 'skills', 'hedgesync');
  if (target === 'claude') return join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'skills', 'hedgesync');
  return join(homedir(), '.agents', 'skills', 'hedgesync');
}

/** The targets to use when --for is not given: those that look set up here. */
export function detectTargets(project: string | undefined, env: NodeJS.ProcessEnv = process.env): SkillTarget[] {
  const base = project ?? homedir();
  const found: SkillTarget[] = [];
  if (existsSync(project ? join(base, '.claude') : env.CLAUDE_CONFIG_DIR || join(base, '.claude'))) found.push('claude');
  if (existsSync(join(base, '.agents')) || (!project && existsSync(join(base, '.codex')))) found.push('agents');
  return found;
}

/** MCP server registration for a client, as the text to paste or the command to run. */
export function mcpConfig(client: string, args: string[]): { file?: string; text: string } {
  const command = 'hedgesync';
  const all = ['mcp', ...args];
  const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
  switch (client) {
    case 'claude':
      return { text: `claude mcp add hedgesync -- ${command} ${all.map(quote).join(' ')}` };
    case 'codex':
      return { file: '~/.codex/config.toml', text: `[mcp_servers.hedgesync]\ncommand = "${command}"\nargs = ${JSON.stringify(all)}` };
    case 'cursor':
      return { file: '.cursor/mcp.json (or ~/.cursor/mcp.json)', text: JSON.stringify({ mcpServers: { hedgesync: { command, args: all } } }, null, 2) };
    case 'gemini':
      return { file: '~/.gemini/settings.json', text: JSON.stringify({ mcpServers: { hedgesync: { command, args: all } } }, null, 2) };
    case 'vscode':
      return { file: '.vscode/mcp.json', text: JSON.stringify({ servers: { hedgesync: { type: 'stdio', command, args: all } } }, null, 2) };
    case 'json':
      return { text: JSON.stringify({ mcpServers: { hedgesync: { command, args: all } } }, null, 2) };
    default:
      throw new CliError(`Unknown client: ${client}`, 'One of: claude, codex, cursor, gemini, vscode, json');
  }
}

const ACTIONS = ['install', 'status', 'path', 'uninstall', 'config'];

export const agent: Command = {
  name: 'agent',
  summary: 'Set up AI agents for HedgeDoc notes (skill, MCP config)',
  options: [
    { name: 'for', type: 'multi' },
    { name: 'project', type: 'flag' },
    { name: 'dir', type: 'value' },
    { name: 'force', type: 'flag' },
    { name: 'server', short: 's', type: 'value' },
    { name: 'read-only', type: 'flag' },
    { name: 'note', type: 'multi' },
  ],
  help: () => `
hedgesync agent - Set up AI agents for HedgeDoc notes

USAGE:
  hedgesync agent install    [--for claude|agents] [--project] [--dir <path>] [--force]
  hedgesync agent status     [--for ...] [--project] [--dir <path>]
  hedgesync agent path       [--for ...] [--project]
  hedgesync agent uninstall  [--for ...] [--project] [--dir <path>] [--force]
  hedgesync agent config <claude|codex|cursor|gemini|vscode|json> [--server <url>] [--read-only] [--note <url>...]

THE SKILL:
  An Agent Skill (SKILL.md) that teaches agents to read and edit HedgeDoc
  notes with hedgesync: when to use it, the commands, how to edit safely
  while people type, and how to set up the MCP server. It ships inside this
  binary, so the installed copy matches it; run install again after updating.

  Targets:
    claude   ~/.claude/skills/hedgesync      (Claude Code; CLAUDE_CONFIG_DIR respected)
    agents   ~/.agents/skills/hedgesync      (Codex and other agents that read .agents)
  Without --for, every target that looks set up here (~/.claude, ~/.agents
  or ~/.codex exists). --project installs into ./.claude or ./.agents of the
  current directory instead, to share it with a repository. Copies you
  edited are not overwritten or removed without --force.

  The skill is also in the repository (plugin/skills/hedgesync). Claude Code
  users can install it as a plugin, which also registers the MCP server:
    claude plugin marketplace add tionis/hedgesync
    claude plugin install hedgesync@hedgesync

MCP CONFIG:
  config prints how to register "hedgesync mcp" with a client: a command to
  run (claude) or the snippet for its config file. --server, --read-only and
  --note are passed on to hedgesync mcp.

OPTIONS:
  --for <target>   claude or agents (repeatable; default: detected)
  --project        The current directory's .claude / .agents, not your home
  --dir <path>     Install exactly here (one target)
  --force          Overwrite or remove local changes
  -s, --server <url>  config: default server for the MCP server
  --read-only      config: only the read tools
  --note <url>     config: only this note (repeatable)

EXAMPLES:
  hedgesync agent install
  hedgesync agent install --for claude --project
  hedgesync agent config codex --server https://md.example.com >> ~/.codex/config.toml
`,
  async run(ctx: Context) {
    const usage = 'hedgesync agent <install|status|path|uninstall|config> [options]';
    const action = ctx.need(0, 'Action', usage);
    if (!ACTIONS.includes(action)) throw new CliError(`Unknown action: ${action}`, `Usage: ${usage}`);

    if (action === 'config') {
      const client = ctx.need(1, 'Client (claude, codex, cursor, gemini, vscode or json)', usage);
      const args: string[] = [];
      const server = ctx.str('server');
      if (server) args.push('--server', server);
      if (ctx.flag('read-only')) args.push('--read-only');
      for (const note of ctx.list('note')) args.push('--note', note);
      const { file, text } = mcpConfig(client, args);
      ctx.result({ client, file, config: text }, () => {
        if (file) ctx.info(c('dim', `# Add to ${file}:`));
        print(text);
      });
      return;
    }

    const project = ctx.flag('project') ? process.cwd() : undefined;
    const custom = ctx.str('dir');
    let targets = ctx.list('for') as SkillTarget[];
    for (const t of targets) {
      if (!SKILL_TARGETS.includes(t)) throw new CliError(`Unknown --for: ${t}`, `One of: ${SKILL_TARGETS.join(', ')}`);
    }
    if (targets.length === 0) targets = detectTargets(project);
    if (targets.length === 0 && !custom) {
      if (action !== 'install') targets = [...SKILL_TARGETS];
      else throw new CliError('No agent found to install the skill for', 'Pass --for claude or --for agents (or --dir <path>).');
    }
    if (custom && targets.length > 1) throw new CliError('--dir takes a single target', 'Add --for claude or --for agents.');
    const dirs = custom ? [{ target: targets[0] ?? 'custom', dir: resolve(custom) }] : targets.map(t => ({ target: t, dir: skillDir(t, project) }));

    switch (action) {
      case 'path':
        ctx.result({ installs: dirs }, () => dirs.forEach(d => print(d.dir)));
        return;

      case 'status': {
        const infos = dirs.map(d => ({ ...d, ...inspectInstall(d.dir, SKILL_FILES) }));
        ctx.result({ binaryVersion: VERSION, installs: infos }, () => {
          for (const info of infos) {
            const line = {
              missing: c('yellow', 'not installed'),
              unmanaged: c('yellow', 'present, but not installed by hedgesync'),
              current: c('green', `installed, matches this binary (${VERSION})`),
              outdated: info.edited.length || info.missing.length
                ? c('yellow', `installed by ${info.version ?? 'an unknown version'}, with local changes`)
                : c('yellow', `installed by ${info.version ?? 'an unknown version'}, this binary bundles a different copy (${VERSION})`),
            }[info.state];
            print(`${c('cyan', `${info.target}:`)} ${line} ${c('dim', info.dir)}`);
          }
        });
        if (infos.some(i => i.state !== 'current')) process.exitCode = 1;
        return;
      }

      case 'install':
        for (const { target, dir } of dirs) {
          const before = inspectInstall(dir, SKILL_FILES);
          installPlugin(dir, { force: ctx.flag('force'), files: SKILL_FILES });
          const done = before.state === 'missing' ? 'installed' : before.state === 'current' ? 'unchanged' : 'updated';
          ctx.result({ action: done, target, dir, version: VERSION }, () => {
            ctx.info(c('green', `✓ hedgesync skill ${done} for ${target} (${VERSION})`) + c('dim', ` in ${dir}`));
          });
        }
        return;

      case 'uninstall':
        for (const { target, dir } of dirs) {
          if (!existsSync(dir) && !custom && ctx.list('for').length === 0) continue;
          uninstallPlugin(dir, { force: ctx.flag('force') });
          ctx.result({ action: 'uninstalled', target, dir }, () => ctx.info(c('green', `✓ Removed the hedgesync skill from ${dir}`)));
        }
        return;
    }
  },
};
