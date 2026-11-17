/**
 * Agents for NoteAssistant: a command that reads the prompt on stdin and
 * prints the answer (Claude Code, llm, ollama, any script), or an
 * OpenAI-compatible chat completions API (OpenAI, OpenRouter, Ollama, LM
 * Studio, vLLM, Anthropic's compatibility endpoint, ...). Both stream.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent, AgentRequest } from './note-assistant.js';
import { killShell, spawnShell } from './shell.js';

export function systemPrompt(name: string): string {
  return `You are ${name}, an assistant writing in a shared Markdown note (HedgeDoc) that people are editing at the same time. `
    + 'Someone mentioned you with a request. Answer it: your answer is inserted right below the request, as a quote. '
    + 'Write Markdown. Be concise, do not repeat the request, and do not wrap the whole answer in a code block. '
    + 'Earlier quotes in the note that start with your name are your previous answers.';
}

export function userPrompt(req: AgentRequest): string {
  return `The note (${req.url}):\n\n<note>\n${req.note}\n</note>\n\nThe request${req.user ? `, from ${req.user}` : ''}:\n\n${req.request}`;
}

/** Model names safe to put in a command line as they are. */
const SAFE_MODEL = /^[\w.:/@-]+$/;

/**
 * Commands for well-known agent CLIs, by name. `model` picks the model:
 * `claude -p --model <m>` (aliases such as haiku, sonnet, opus work),
 * `llm -m <m>`, and for Ollama either `ollama:<model>` or `model`.
 */
export function agentPreset(spec: string, model?: string): { command: string; name: string } | undefined {
  if (model !== undefined && !SAFE_MODEL.test(model)) {
    throw new Error(`Unexpected characters in model name '${model}'`);
  }
  if (spec === 'claude') return { command: model ? `claude -p --model ${model}` : 'claude -p', name: 'claude' };
  if (spec === 'llm') return { command: model ? `llm -m ${model}` : 'llm', name: 'ai' };
  if (spec === 'ollama' && model) return { command: `ollama run ${model}`, name: 'ai' };
  const ollama = /^ollama:(.+)$/.exec(spec);
  if (ollama) {
    if (!SAFE_MODEL.test(ollama[1])) throw new Error(`Unexpected characters in model name '${ollama[1]}'`);
    return { command: `ollama run ${model ?? ollama[1]}`, name: 'ai' };
  }
  return undefined;
}

/**
 * A shell command as the agent. The prompt (instructions, the note, the
 * request) goes to stdin; stdout is the answer, streamed. The request is also
 * in the environment: HEDGESYNC_NOTE_URL, HEDGESYNC_NOTE_FILE (the note's
 * text), HEDGESYNC_REQUEST, HEDGESYNC_REQUEST_USER, HEDGESYNC_ASSISTANT_NAME,
 * and HEDGESYNC_MODEL when a model was chosen.
 */
export function commandAgent(command: string, options: { timeoutMs?: number; model?: string } = {}): Agent {
  return async function* (req) {
    const dir = mkdtempSync(join(tmpdir(), 'hedgesync-agent-'));
    const noteFile = join(dir, 'note.md');
    writeFileSync(noteFile, req.note);
    const proc = spawnShell({
      command,
      stdin: `${req.system ?? systemPrompt(req.name)}\n\n${req.prompt ?? userPrompt(req)}\n`,
      env: {
        HEDGESYNC_NOTE_URL: req.url,
        HEDGESYNC_NOTE_FILE: noteFile,
        HEDGESYNC_REQUEST: req.request,
        HEDGESYNC_REQUEST_USER: req.user ?? '',
        HEDGESYNC_ASSISTANT_NAME: req.name,
        ...(options.model ? { HEDGESYNC_MODEL: options.model } : {}),
      },
    }, { timeoutMs: options.timeoutMs });
    const onAbort = () => killShell(proc);
    req.signal.addEventListener('abort', onAbort);
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });
    try {
      proc.stdout!.setEncoding('utf8');
      for await (const chunk of proc.stdout!) yield chunk as string;
      const code = await proc.exitCode$;
      if (code !== 0 && !req.signal.aborted) {
        const why = stderr.trim().split('\n').pop();
        throw new Error(`The agent (${command}) failed with exit code ${code}${why ? `: ${why}` : ''}`);
      }
    } finally {
      req.signal.removeEventListener('abort', onAbort);
      killShell(proc);
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** An OpenAI-compatible chat completions endpoint, streamed (server-sent events). */
export function openAiAgent(options: { baseUrl: string; model: string; apiKey?: string; timeoutMs?: number }): Agent {
  const url = options.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  return async function* (req) {
    const signal = options.timeoutMs ? AbortSignal.any([req.signal, AbortSignal.timeout(options.timeoutMs)]) : req.signal;
    const res = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) },
      body: JSON.stringify({
        model: options.model,
        stream: true,
        messages: [
          { role: 'system', content: req.system ?? systemPrompt(req.name) },
          { role: 'user', content: req.prompt ?? userPrompt(req) },
        ],
      }),
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      let message = body.slice(0, 300);
      try {
        message = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? message;
      } catch {
        // Not JSON.
      }
      throw new Error(`${url} answered ${res.status}${message ? `: ${message}` : ''}`);
    }
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          const delta = (JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // A keep-alive or a line we don't understand.
        }
      }
    }
  };
}
