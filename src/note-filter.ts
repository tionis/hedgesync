/**
 * Filters for one-way mirrors: derive a note for another audience by
 * removing marked parts (a GM's secrets, internal remarks, solutions).
 *
 *   <!-- gm -->           block: removed with its marker lines
 *   secret
 *   <!-- /gm -->
 *   Visible ::gm hidden:: text.      inline span: removed
 *
 * They fail closed, since keeping things secret is the point: a block that is
 * not closed (yet) hides everything after it, and so does any HTML comment
 * that is still being typed (`<!-- g`), whose text would otherwise show up
 * before it becomes a marker. An unclosed inline span hides the rest of its
 * line.
 */

import { spawnSync } from 'node:child_process';

export type TextFilter = (text: string) => string;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function checkName(name: string): string {
  if (!/^[\w-]+$/.test(name)) throw new Error(`Invalid marker name "${name}" (letters, digits, _ and - only)`);
  return name;
}

/** Cut the text at the first HTML comment without its `-->`, keeping what is before it. */
function cutUnterminatedComment(text: string): string {
  let at = 0;
  for (;;) {
    const open = text.indexOf('<!--', at);
    if (open < 0) return text;
    const close = text.indexOf('-->', open + 4);
    if (close < 0) return dropTrailingPartialLine(text.slice(0, open));
    at = close + 3;
  }
}

/** After cutting mid-line, drop that line's start if only whitespace is left of it. */
function dropTrailingPartialLine(text: string): string {
  return text.replace(/[ \t]+$/, '');
}

interface Block {
  /** Where the opening marker (with its line, if alone on it) starts. */
  start: number;
  /** Where the content starts and ends. */
  contentStart: number;
  contentEnd: number;
  /** Where the closing marker (with its line, if alone on it) ends; text.length if unclosed. */
  end: number;
}

/** Find `<!-- name -->` ... `<!-- /name -->` blocks (outermost; nesting counted). */
function findBlocks(text: string, name: string): Block[] {
  const re = new RegExp(`<!--\\s*(/?)${escape(name)}\\s*-->`, 'g');
  const blocks: Block[] = [];
  let depth = 0;
  let current: Partial<Block> = {};
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const closing = m[1] === '/';
    const lineStart = text.lastIndexOf('\n', m.index - 1) + 1;
    const nl = text.indexOf('\n', m.index + m[0].length);
    const lineEnd = nl < 0 ? text.length : nl;
    const alone = text.slice(lineStart, m.index).trim() === '' && text.slice(m.index + m[0].length, lineEnd).trim() === '';
    if (!closing) {
      if (depth++ === 0) {
        current = {
          start: alone ? lineStart : m.index,
          contentStart: alone ? Math.min(text.length, lineEnd + 1) : m.index + m[0].length,
        };
      }
    } else if (depth > 0 && --depth === 0) {
      blocks.push({
        ...current,
        contentEnd: alone ? lineStart : m.index,
        end: alone ? Math.min(text.length, lineEnd + 1) : m.index + m[0].length,
      } as Block);
    }
  }
  if (depth > 0) blocks.push({ ...current, contentEnd: text.length, end: text.length } as Block);
  return blocks;
}

/** Remove `<!-- name -->` blocks and `::name ...::` spans. */
export function stripMarked(text: string, name: string): string {
  checkName(name);
  let out = '';
  let at = 0;
  for (const b of findBlocks(text, name)) {
    out += text.slice(at, b.start);
    at = b.end;
  }
  out += text.slice(at);
  // Inline spans, within a line; an unclosed one hides the rest of the line.
  out = out.replace(new RegExp(`[ \\t]?::${escape(name)}(?=[\\s:])[^\\n]*?(::|$)`, 'gm'), '');
  return cutUnterminatedComment(out);
}

/** Keep only the content of `<!-- name -->` blocks (and `::name ...::` spans), separated by blank lines. */
export function onlyMarked(text: string, name: string): string {
  checkName(name);
  const parts = findBlocks(text, name).map(b => cutUnterminatedComment(text.slice(b.contentStart, b.contentEnd)).replace(/\n+$/, ''));
  const spans = [...text.matchAll(new RegExp(`::${escape(name)}\\s+([^\\n]*?)::`, 'g'))].map(m => m[1]);
  const kept = [...parts, ...spans].filter(p => p.trim() !== '');
  return kept.length ? kept.join('\n\n') + '\n' : '';
}

/** Remove sections whose heading matches, up to the next heading of the same or a higher level. Code fences are skipped. */
export function stripSections(text: string, heading: RegExp): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  let skipping = 0; // level of the section being removed, 0 if none
  for (const line of lines) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0].repeat(f[1].length);
      else if (line.trim().startsWith(fence)) fence = null;
    }
    const h = !fence && !f ? /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line) : null;
    if (h) {
      const level = h[1].length;
      if (skipping && level <= skipping) skipping = 0;
      if (!skipping && heading.test(h[2])) skipping = level;
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

/** Parse `/pattern/flags=replacement` (the replacement may use $1, $&). */
export function parseReplace(spec: string): TextFilter {
  const m = /^\/((?:\\.|[^/\\])+)\/([a-z]*)=([\s\S]*)$/.exec(spec);
  if (!m) throw new Error(`Invalid --replace "${spec}" (expected /pattern/flags=replacement)`);
  let re: RegExp;
  try {
    re = new RegExp(m[1], m[2].includes('g') ? m[2] : m[2] + 'g');
  } catch (err) {
    throw new Error(`Invalid --replace pattern: ${(err as Error).message}`);
  }
  return text => text.replace(re, m[3]);
}

/** Run a shell command with the text on stdin; its stdout is the result. Throws (so nothing is written) if it fails. */
export function commandFilter(command: string, timeoutMs = 10_000): TextFilter {
  return (text) => {
    const shell = process.platform === 'win32' ? ['cmd', '/c'] : ['sh', '-c'];
    const r = spawnSync(shell[0], [shell[1], command], { input: text, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    if (r.error) throw new Error(`--filter failed: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`--filter exited with ${r.status}${r.stderr ? `: ${r.stderr.trim().split('\n')[0]}` : ''}`);
    return r.stdout;
  };
}

export interface FilterOptions {
  strip?: string[];
  only?: string[];
  stripHeading?: string[];
  replace?: string[];
  filter?: string[];
}

/** Compose the filters in a fixed order: only, strip, strip-heading, replace, then commands. Undefined if none. */
export function createFilter(options: FilterOptions): TextFilter | undefined {
  const steps: TextFilter[] = [];
  for (const name of options.only ?? []) steps.push(t => onlyMarked(t, name));
  for (const name of options.strip ?? []) steps.push(t => stripMarked(t, name));
  for (const h of options.stripHeading ?? []) {
    let re: RegExp;
    try {
      re = new RegExp(h, 'i');
    } catch (err) {
      throw new Error(`Invalid --strip-heading pattern: ${(err as Error).message}`);
    }
    steps.push(t => stripSections(t, re));
  }
  for (const r of options.replace ?? []) steps.push(parseReplace(r));
  for (const cmd of options.filter ?? []) steps.push(commandFilter(cmd));
  if (steps.length === 0) return undefined;
  for (const name of [...(options.only ?? []), ...(options.strip ?? [])]) checkName(name);
  return text => steps.reduce((t, step) => step(t), text);
}
