import { describe, expect, test } from 'bun:test';
import { agentPreset } from '../../src/agents.js';
import { findRequests, formatReply } from '../../src/note-assistant.js';

describe('findRequests', () => {
  test('mentions, answered or not', () => {
    const doc = '# Plan\n\n@claude what is 2+2?\n\n> **claude:** 4\n\nAsk @Claude about the deadline\nplease\n\nmail@claude.example is no mention, nor @claudette\n';
    expect(findRequests(doc, 'claude').map(r => [r.text, r.answered])).toEqual([
      ['@claude what is 2+2?', true],
      ['Ask @Claude about the deadline\nplease', false],
    ]);
  });

  test('replies, code blocks and other names are not requests', () => {
    const doc = '> **claude:** see @claude docs\n\n```\n@claude in code\n\nstill code\n```\n\n@ai hello\n';
    expect(findRequests(doc, 'claude')).toEqual([]);
    expect(findRequests(doc, 'ai').map(r => r.text)).toEqual(['@ai hello']);
  });

  test('offsets point at the paragraph', () => {
    const doc = 'a\n\n@ai b\nc\n\nd';
    const [r] = findRequests(doc, 'ai');
    expect(doc.slice(r.start, r.end)).toBe('@ai b\nc');
  });
});

test('formatReply quotes every line', () => {
  expect(formatReply('claude', 'Four.\n\n- a\n- b\n')).toBe('> **claude:** Four.\n>\n> - a\n> - b');
  expect(formatReply('ai', '', '<!-- m --> ')).toBe('> **ai:** <!-- m --> …');
});

test('agent presets', () => {
  expect(agentPreset('claude')).toEqual({ command: 'claude -p', name: 'claude' });
  expect(agentPreset('ollama:llama3.2')).toEqual({ command: 'ollama run llama3.2', name: 'ai' });
  expect(agentPreset('./my-agent.sh')).toBeUndefined();
  expect(agentPreset('claude', 'haiku')).toEqual({ command: 'claude -p --model haiku', name: 'claude' });
  expect(agentPreset('llm', 'gpt-4o-mini')).toEqual({ command: 'llm -m gpt-4o-mini', name: 'ai' });
  expect(agentPreset('ollama', 'qwen3:8b')).toEqual({ command: 'ollama run qwen3:8b', name: 'ai' });
  expect(agentPreset('ollama:llama3.2', 'qwen3:8b')?.command).toBe('ollama run qwen3:8b');
  expect(() => agentPreset('claude', 'haiku; rm -rf ~')).toThrow();
  expect(agentPreset('claude', { model: 'haiku', noTools: true })?.command).toBe('claude -p --model haiku --tools "" --strict-mcp-config --no-session-persistence');
  expect(agentPreset('llm', { noTools: true })?.command).toBe('llm');
});

test.skipIf(process.platform === 'win32')('a command agent sees the chosen model as HEDGESYNC_MODEL', async () => {
  const { commandAgent } = await import('../../src/agents.js');
  const agent = commandAgent('cat >/dev/null; printf %s "$HEDGESYNC_MODEL"', { model: 'tiny-1' });
  let out = '';
  for await (const chunk of agent({ note: '', url: '', request: '', name: 'ai', signal: new AbortController().signal })) out += chunk;
  expect(out).toBe('tiny-1');
});
