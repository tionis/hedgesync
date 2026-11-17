/**
 * rules: an AI agent keeps the note following rules ("pirate speak only",
 * "no work is ever scheduled for Eric"), rewriting what people write.
 *
 * Kept fast and cheap by working on paragraphs: once a victim pauses, each
 * paragraph they touched goes to the agent on its own (with some of the note
 * around it for context), and the answer is applied as a minimal diff, but
 * only if the paragraph hasn't changed in the meantime. Otherwise it is
 * tried again at the next pause.
 */

import { diffToOperation } from '../diff.js';
import type { Agent } from '../note-assistant.js';
import { TextOperation } from '../text-operation.js';
import type { Anchor, Prank, PrankApi, PrankUser } from './engine.js';

export interface RulesOptions {
  rules: string[];
  agent: Agent;
  /** Note URL, passed on to command agents. */
  url?: string;
  /** Pause in a victim's typing before their paragraphs are checked (default 1500 ms). */
  settleMs?: number;
  /** Characters of note around the paragraph sent as context (default 3000). */
  contextChars?: number;
  /** Paragraphs checked at the same time (default 2). */
  concurrency?: number;
}

/** The paragraph (block between blank lines) around `index`. */
export function paragraphAt(doc: string, index: number): { start: number; end: number } {
  const blank = /\n[ \t]*\n/g;
  let start = 0;
  let end = doc.length;
  for (let m: RegExpExecArray | null; (m = blank.exec(doc));) {
    const gapStart = m.index;
    const gapEnd = m.index + m[0].length;
    if (gapEnd <= index) start = gapEnd;
    else if (gapStart >= index) {
      end = gapStart;
      break;
    } else {
      // Inside the blank gap itself: the gap is no paragraph.
      return { start: index, end: index };
    }
    blank.lastIndex = gapEnd - 1;
  }
  return { start, end };
}

export function rulesSystemPrompt(rules: string[]): string {
  return 'You enforce rules on a shared Markdown note (HedgeDoc) while people are writing it.\n'
    + `The rules:\n${rules.map(r => `- ${r}`).join('\n')}\n\n`
    + 'You are given one paragraph of the note (and some of the note around it, for context only). '
    + 'Reply with that paragraph rewritten so it follows the rules. Change as little as needed and keep the '
    + 'Markdown formatting and line breaks. If it already follows the rules, reply with it unchanged. '
    + 'Reply with the paragraph only: no explanation, no quotes, no code fences.';
}

export function rulesUserPrompt(before: string, paragraph: string, after: string): string {
  return `<context-before>\n${before}\n</context-before>\n\n<paragraph>\n${paragraph}\n</paragraph>\n\n`
    + `<context-after>\n${after}\n</context-after>\n\nThe paragraph, following the rules:`;
}

/** Strip what models wrap answers in despite being told not to. */
export function cleanAnswer(answer: string, original: string): string {
  let text = answer.replace(/^\s*<paragraph>\n?/, '').replace(/\n?<\/paragraph>\s*$/, '');
  const fence = /^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/.exec(text);
  if (fence && !original.trimStart().startsWith('```')) text = fence[1];
  // Keep the original's surrounding whitespace.
  const lead = /^\s*/.exec(original)![0];
  const trail = /\s*$/.exec(original)![0];
  return lead + text.trim() + trail;
}

export function rulesKeeper(options: RulesOptions): Prank {
  const { rules, agent, url = '', settleMs = 1500, contextChars = 3000, concurrency = 2 } = options;
  const system = rulesSystemPrompt(rules);
  let api: PrankApi;
  /** Points where victims edited since the last check. */
  let dirty: { at: Anchor; user?: PrankUser }[] = [];
  let cancelSettle: (() => void) | undefined;
  let running = 0;
  const queue: { range: Anchor; text: string; user?: PrankUser }[] = [];
  const controller = { abort: new AbortController() };

  const check = () => {
    const doc = api.document();
    const seen = new Set<number>();
    for (const { at, user } of dirty) {
      const { start, end } = paragraphAt(doc, at.start);
      api.release(at);
      if (seen.has(start) || !doc.slice(start, end).trim()) continue;
      seen.add(start);
      queue.push({ range: api.anchor(start, end), text: doc.slice(start, end), user });
    }
    dirty = [];
    pump();
  };

  const pump = () => {
    while (running < concurrency && queue.length > 0) {
      const job = queue.shift()!;
      running++;
      rewrite(job).catch(err => api.report({ prank: 'rules', message: `agent error: ${(err as Error).message}` }))
        .finally(() => {
          running--;
          api.release(job.range);
          pump();
        });
    }
  };

  const rewrite = async (job: { range: Anchor; text: string; user?: PrankUser }) => {
    const doc = api.document();
    const before = doc.slice(Math.max(0, job.range.start - contextChars), job.range.start);
    const after = doc.slice(job.range.end, job.range.end + contextChars);
    let answer = '';
    for await (const chunk of agent({
      note: doc, url, request: job.text, user: job.user?.name, name: 'rules',
      signal: controller.abort.signal,
      system, prompt: rulesUserPrompt(before, job.text, after),
    })) answer += chunk;
    const fixed = cleanAnswer(answer, job.text);
    if (fixed === job.text || !fixed.trim()) return;

    const now = api.document();
    if (!job.range.alive || now.slice(job.range.start, job.range.end) !== job.text) {
      // They kept writing: look again at the next pause.
      markDirty(job.range.start, job.user);
      return;
    }
    if (api.apply(buildOp(now.length, job.range.start, job.text, fixed))) {
      api.report({ prank: 'rules', user: job.user, message: `rewrote ${JSON.stringify(preview(job.text))} -> ${JSON.stringify(preview(fixed))}` });
    }
  };

  const markDirty = (index: number, user?: PrankUser) => {
    dirty.push({ at: api.anchor(index), user });
    cancelSettle?.();
    cancelSettle = api.later(check, settleMs);
  };

  return {
    name: 'rules',
    start(a) {
      api = a;
      controller.abort = new AbortController();
    },
    stop() {
      controller.abort.abort();
      dirty = [];
      queue.length = 0;
    },
    react(pieces, ctx) {
      // Positions here are in the document as just edited, which is the current one.
      for (const p of pieces) markDirty(p.index, ctx.user);
      return [];
    },
  };
}

/** The operation turning `text` at `start` into `fixed`, in a document of `length`. */
function buildOp(length: number, start: number, text: string, fixed: string): TextOperation {
  const inner = diffToOperation(text, fixed);
  const op = new TextOperation().retain(start);
  for (const o of inner.ops) {
    if (typeof o === 'string') op.insert(o);
    else if (o > 0) op.retain(o);
    else op.delete(-o);
  }
  return op.retain(length - start - text.length);
}

const preview = (t: string) => {
  const s = t.trim().replace(/\s+/g, ' ');
  return s.length > 50 ? s.slice(0, 47) + '...' : s;
};
