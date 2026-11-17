/**
 * --agent / --api / --model / --api-key-env / --timeout, shared by the
 * commands that talk to an AI agent.
 */

import { agentPreset, commandAgent, openAiAgent } from '../agents.js';
import type { Agent } from '../note-assistant.js';
import type { Context } from './context.js';
import type { OptionSpec } from './args.js';
import { CliError } from './ui.js';

export const agentOptions: OptionSpec[] = [
  { name: 'agent', short: 'a', type: 'value' },
  { name: 'api', type: 'value' },
  { name: 'model', short: 'm', type: 'value' },
  { name: 'api-key-env', type: 'value' },
  { name: 'timeout', type: 'value' },
];

export function seconds(value: string | undefined, fallback: number, option: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new CliError(`${option} must be a number of seconds, got '${value}'`);
  return n;
}

export interface AgentChoice {
  agent: Agent;
  /** For display. */
  described: string;
  /** The preset's mention name, when --agent named a preset. */
  presetName?: string;
}

/** The agent picked with --agent or --api, or an error saying which is missing. */
export function agentFromOptions(ctx: Context, usage: string, defaultTimeoutSeconds: number): AgentChoice {
  const agentSpec = ctx.str('agent');
  const api = ctx.str('api');
  if (!agentSpec === !api) throw new CliError('Which agent?', `Pass either --agent or --api. Usage: ${usage}`);
  const timeoutMs = seconds(ctx.str('timeout'), defaultTimeoutSeconds, '--timeout') * 1000;
  if (api) {
    const model = ctx.str('model');
    if (!model) throw new CliError('--api needs --model');
    const keyVar = ctx.str('api-key-env') ?? 'OPENAI_API_KEY';
    return {
      agent: openAiAgent({ baseUrl: api, model, apiKey: process.env[keyVar], timeoutMs }),
      described: `${model} at ${api}${process.env[keyVar] ? '' : ` (no ${keyVar})`}`,
    };
  }
  const preset = agentPreset(agentSpec!);
  return {
    agent: commandAgent(preset?.command ?? agentSpec!, { timeoutMs }),
    described: preset?.command ?? agentSpec!,
    presetName: preset?.name,
  };
}
