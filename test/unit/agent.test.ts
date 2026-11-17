import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GENERATED, renderSkillModule } from '../../scripts/gen-skill.js';
import { mcpConfig, skillDir } from '../../src/cli/commands/agent.js';
import { inspectInstall, installPlugin } from '../../src/cli/commands/editor.js';
import { SKILL_FILES } from '../../src/cli/skill.generated.js';

describe('the agent skill', () => {
  test('the embedded copy is current (bun run gen:skill)', () => {
    expect(readFileSync(GENERATED, 'utf8')).toBe(renderSkillModule());
  });

  test('follows the Agent Skills format', () => {
    const skill = SKILL_FILES['SKILL.md'];
    const front = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(skill);
    expect(front).not.toBeNull();
    const field = (name: string) => new RegExp(`^${name}: (.*)$`, 'm').exec(front![1])?.[1];
    const name = field('name')!;
    expect(name).toBe('hedgesync'); // must match the directory
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(name).not.toMatch(/anthropic|claude/);
    const description = field('description')!;
    expect(description.length).toBeGreaterThan(50);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(front![2].split('\n').length).toBeLessThan(500);
    // Every referenced file is bundled.
    for (const [, path] of skill.matchAll(/\]\((references\/[^)]+)\)/g)) expect(SKILL_FILES[path]).toBeDefined();
  });

  test('installs, notices edits, updates', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'hedgesync-skill-')), 'hedgesync');
    try {
      expect(installPlugin(dir, { files: SKILL_FILES }).state).toBe('current');
      writeFileSync(join(dir, 'SKILL.md'), 'mine');
      expect(inspectInstall(dir, SKILL_FILES).edited).toEqual(['SKILL.md']);
      expect(() => installPlugin(dir, { files: SKILL_FILES })).toThrow('local changes');
      expect(installPlugin(dir, { files: SKILL_FILES, force: true }).state).toBe('current');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('skill locations', () => {
    expect(skillDir('claude', '/repo')).toBe(join('/repo', '.claude', 'skills', 'hedgesync'));
    expect(skillDir('agents', '/repo')).toBe(join('/repo', '.agents', 'skills', 'hedgesync'));
    expect(skillDir('claude', undefined, { CLAUDE_CONFIG_DIR: '/cfg' })).toBe(join('/cfg', 'skills', 'hedgesync'));
  });
});

describe('the Claude Code plugin', () => {
  test('its version follows package.json, and it registers the MCP server', async () => {
    const pkg = await Bun.file(join(import.meta.dir, '../../package.json')).json();
    const plugin = await Bun.file(join(import.meta.dir, '../../plugin/.claude-plugin/plugin.json')).json();
    expect(plugin.version).toBe(pkg.version);
    expect(plugin.license).toBe(pkg.license);
    expect(plugin.mcpServers.hedgesync.args.slice(0, 1)).toEqual(['mcp']);
    const market = await Bun.file(join(import.meta.dir, '../../.claude-plugin/marketplace.json')).json();
    expect(market.plugins[0]).toMatchObject({ name: 'hedgesync', source: './plugin' });
  });
});

describe('MCP client configs', () => {
  const args = ['--server', 'https://md.example.com'];
  test('per client', () => {
    expect(mcpConfig('claude', args).text).toBe('claude mcp add hedgesync -- hedgesync mcp --server https://md.example.com');
    expect(mcpConfig('codex', args).text).toBe('[mcp_servers.hedgesync]\ncommand = "hedgesync"\nargs = ["mcp","--server","https://md.example.com"]');
    expect(JSON.parse(mcpConfig('vscode', args).text)).toEqual({ servers: { hedgesync: { type: 'stdio', command: 'hedgesync', args: ['mcp', ...args] } } });
    expect(JSON.parse(mcpConfig('cursor', []).text).mcpServers.hedgesync.args).toEqual(['mcp']);
    expect(() => mcpConfig('emacs', [])).toThrow('Unknown client');
  });
});
