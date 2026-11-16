/**
 * assistant: answer `@name ...` requests in a note with an agent of your
 * choice (see src/note-assistant.ts and src/agents.ts).
 */

import { agentPreset, commandAgent, openAiAgent } from '../../agents.js';
import { NoteAssistant, type Agent } from '../../note-assistant.js';
import { assertEditable, connectionOptions, type Command } from '../context.js';
import { CliError, c } from '../ui.js';

function seconds(value: string | undefined, fallback: number, option: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new CliError(`${option} must be a number of seconds, got '${value}'`);
  return n;
}

export const assistant: Command = {
  name: 'assistant',
  summary: 'Answer @mentions in a note with an AI agent (any CLI or API)',
  options: [
    ...connectionOptions,
    { name: 'agent', short: 'a', type: 'value' },
    { name: 'api', type: 'value' },
    { name: 'model', short: 'm', type: 'value' },
    { name: 'api-key-env', type: 'value' },
    { name: 'name', type: 'value' },
    { name: 'allow', type: 'multi' },
    { name: 'timeout', type: 'value' },
    { name: 'settle', type: 'value' },
    { name: 'answer-existing', type: 'flag' },
  ],
  help: () => `
${c('bold', 'hedgesync assistant')} - Answer @mentions in a note with an AI agent

${c('yellow', 'USAGE:')}
  hedgesync assistant <url> --agent <preset | command> [--name <name>] [options]
  hedgesync assistant <url> --api <base-url> --model <model> [--name <name>] [options]

Watches the note. When someone writes a paragraph mentioning ${c('cyan', '@<name>')} and
pauses typing, the agent is asked, and its answer streams in right below the
request as a quote, with the assistant's cursor following along:

  @claude summarise the decisions above

  > **claude:** Two decisions: ...

The agent sees the whole note, so follow-up questions work. A request is
answered when a reply quote follows it: delete the reply to ask again.
Requests already in the note at start are left alone (--answer-existing).

${c('yellow', 'AGENTS:')}
  ${c('cyan', '--agent claude')}         Claude Code (claude -p), name "claude"
  ${c('cyan', '--agent llm')}            Simon Willison's llm, with its default model
  ${c('cyan', '--agent ollama:<model>')} A local model through Ollama
  ${c('cyan', '--agent "<command>"')}    Any command: the prompt arrives on stdin, stdout is
                         the answer. Also set: HEDGESYNC_NOTE_URL, HEDGESYNC_NOTE_FILE,
                         HEDGESYNC_REQUEST, HEDGESYNC_REQUEST_USER, HEDGESYNC_ASSISTANT_NAME
  ${c('cyan', '--api <base-url>')}       An OpenAI-compatible API (…/v1), with --model:
                         OpenAI, OpenRouter, Ollama (http://localhost:11434/v1),
                         LM Studio, vLLM, Anthropic (https://api.anthropic.com/v1)

${c('yellow', 'OPTIONS:')}
  ${c('cyan', '-a, --agent <a>')}        The agent (see above)
  ${c('cyan', '--api <url>')}            OpenAI-compatible base URL
  ${c('cyan', '-m, --model <m>')}        The model, for --api
  ${c('cyan', '--api-key-env <var>')}    Environment variable with the API key (default
                         OPENAI_API_KEY; none is sent if it is unset)
  ${c('cyan', '--name <name>')}          The name to mention (default: claude for --agent
                         claude, else ai)
  ${c('cyan', '--allow <user>')}         Only answer requests by this user (repeatable;
                         HedgeDoc display names)
  ${c('cyan', '--timeout <s>')}          Give up on an answer after this long (default 300)
  ${c('cyan', '--settle <s>')}           Pause in typing before a request is taken (default 2)
  ${c('cyan', '--answer-existing')}      Also answer requests already in the note

Everyone who can edit the note can use your agent (and your API credits),
and the agent sees the whole note. With a note anyone can edit, pass --allow.
An agent command such as Claude Code may use tools, as configured for it.

${c('yellow', 'EXAMPLES:')}
  hedgesync assistant https://md.example.com/abc --agent claude
  hedgesync assistant https://md.example.com/abc --api https://openrouter.ai/api/v1 \\
    --model anthropic/claude-sonnet-4.5 --api-key-env OPENROUTER_API_KEY --name ai
  hedgesync assistant https://md.example.com/abc --agent ollama:llama3.2 --allow alice
`,
  async run(ctx) {
    const usage = 'hedgesync assistant <url> (--agent <preset | command> | --api <url> --model <m>)';
    const { url } = ctx.note(0, usage);
    const agentSpec = ctx.str('agent');
    const api = ctx.str('api');
    if (!agentSpec === !api) throw new CliError('Which agent?', `Pass either --agent or --api. Usage: ${usage}`);
    const timeoutMs = seconds(ctx.str('timeout'), 300, '--timeout') * 1000;
    let agent: Agent;
    let defaultName = 'ai';
    let described: string;
    if (api) {
      const model = ctx.str('model');
      if (!model) throw new CliError('--api needs --model');
      const keyVar = ctx.str('api-key-env') ?? 'OPENAI_API_KEY';
      agent = openAiAgent({ baseUrl: api, model, apiKey: process.env[keyVar], timeoutMs });
      described = `${model} at ${api}${process.env[keyVar] ? '' : ` (no ${keyVar})`}`;
    } else {
      const preset = agentPreset(agentSpec!);
      agent = commandAgent(preset?.command ?? agentSpec!, { timeoutMs });
      if (preset) defaultName = preset.name;
      described = preset?.command ?? agentSpec!;
    }
    const name = ctx.str('name') ?? defaultName;
    if (!/^[\w-]+$/.test(name)) throw new CliError(`Invalid name "${name}" (letters, digits, _ and - only)`);
    const allowed = ctx.list('allow').map(a => a.toLowerCase());

    const client = await ctx.connect(0);
    try {
      assertEditable(client);
    } catch (err) {
      client.disconnect();
      throw err;
    }
    const permission = client.getNoteInfo().permission;
    if (!allowed.length && (permission === 'freely' || permission === 'editable')) {
      ctx.warn(`The note is "${permission}": anyone who can open it can use your agent. Consider --allow <user>.`);
    }

    const assistantInstance = new NoteAssistant(client, {
      name,
      agent,
      url,
      settleMs: seconds(ctx.str('settle'), 2, '--settle') * 1000,
      answerExisting: ctx.flag('answer-existing'),
      allow: allowed.length ? user => !!user && allowed.includes(user.toLowerCase()) : undefined,
    });
    const log = (msg: string) => ctx.info(`${c('dim', new Date().toLocaleTimeString())} ${msg}`);
    const preview = (t: string) => JSON.stringify(t.length > 60 ? t.slice(0, 57) + '...' : t);
    assistantInstance.on('request', e => log(`${c('cyan', 'asked')} ${preview(e.request)}${e.user ? ` by ${e.user}` : ''}`));
    assistantInstance.on('answered', e => log(`${c('green', 'answered')} (${e.length} characters)`));
    assistantInstance.on('refused', e => log(`${c('yellow', 'ignored')} ${preview(e.request)} by ${e.user ?? 'an unknown user'} (not in --allow)`));
    assistantInstance.on('cancelled', () => log(`${c('yellow', 'cancelled')}: the reply was deleted`));
    assistantInstance.on('error', (err: Error) => log(`${c('red', 'agent error')}: ${err.message}`));
    assistantInstance.start();
    ctx.info(`${c('green', '✓ Listening for')} @${name} ${c('dim', `(${described}; Ctrl+C stops)`)}`);

    await new Promise<void>((resolve) => {
      const stop = async () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        assistantInstance.stop();
        await client.flush().catch(() => undefined);
        client.disconnect();
        resolve();
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      client.on('delete', stop);
    });
  },
};
