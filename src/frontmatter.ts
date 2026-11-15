/**
 * Reading and editing a note's YAML front matter, where HedgeDoc 1 keeps
 * per-note settings (title, tags, description, type: slide, slideOptions,
 * lang, dir, breaks, robots, GA, disqus, opengraph).
 *
 * This is deliberately not a YAML library: it understands top-level keys,
 * scalars and simple lists, which covers HedgeDoc's settings. Nested values
 * (slideOptions, opengraph) are kept and reported verbatim, and edits only
 * touch the lines of the key being changed, so formatting and comments
 * elsewhere survive.
 */

export type MetaValue = string | string[];

export interface MetaEntry {
  key: string;
  /** Parsed value; for nested mappings the raw YAML of the block. */
  value: MetaValue;
  /** True when the value is a nested mapping kept as raw text. */
  nested: boolean;
}

interface Block {
  /** Character offsets of the whole front matter, delimiters included. */
  start: number;
  end: number;
  lines: string[];
  newline: string;
}

const OPEN = /^---[ \t]*\r?\n/;
const CLOSE = /^(?:---|\.\.\.)[ \t]*$/;
const KEY_LINE = /^([A-Za-z_][\w.-]*)[ \t]*:(?:[ \t]+|$)(.*)$/;

function findBlock(doc: string): Block | null {
  const open = OPEN.exec(doc);
  if (!open) return null;
  const newline = open[0].endsWith('\r\n') ? '\r\n' : '\n';
  const lines: string[] = [];
  let pos = open[0].length;
  while (pos <= doc.length) {
    const nl = doc.indexOf('\n', pos);
    const lineEnd = nl === -1 ? doc.length : nl;
    const line = doc.slice(pos, lineEnd).replace(/\r$/, '');
    if (CLOSE.test(line)) {
      return { start: 0, end: nl === -1 ? doc.length : nl + 1, lines, newline };
    }
    lines.push(line);
    if (nl === -1) break;
    pos = nl + 1;
  }
  return null; // no closing delimiter: not front matter
}

/** Split the block into top-level keys, each with its continuation lines. */
function splitKeys(lines: string[]): { key: string; first: number; last: number }[] {
  const keys: { key: string; first: number; last: number }[] = [];
  lines.forEach((line, i) => {
    const m = KEY_LINE.exec(line);
    if (m) keys.push({ key: m[1], first: i, last: i });
    // Indented lines continue the previous key; blank lines and column-0
    // comments stand on their own.
    else if (keys.length && /^\s/.test(line) && line.trim() !== '') keys[keys.length - 1].last = i;
  });
  return keys;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t);
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t.replace(/\s+#.*$/, '');
}

function splitFlow(inner: string): string[] {
  const items: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      items.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') items.push(current);
  return items.map(unquote).filter(item => item !== '');
}

function parseEntry(lines: string[], first: number, last: number): MetaEntry {
  const m = KEY_LINE.exec(lines[first])!;
  const key = m[1];
  const inline = m[2].trim();
  const rest = lines.slice(first + 1, last + 1).filter(l => l.trim() !== '' && !l.trimStart().startsWith('#'));
  if (inline.startsWith('[') && inline.endsWith(']')) return { key, value: splitFlow(inline.slice(1, -1)), nested: false };
  if (inline !== '' && !/^[|>]/.test(inline)) return { key, value: unquote(inline), nested: false };
  if (rest.length && rest.every(l => /^\s*-(\s|$)/.test(l))) {
    return { key, value: rest.map(l => unquote(l.replace(/^\s*-\s?/, ''))), nested: false };
  }
  if (/^[|>]/.test(inline)) {
    const indent = Math.min(...rest.map(l => l.length - l.trimStart().length));
    return { key, value: rest.map(l => l.slice(indent)).join(inline.startsWith('>') ? ' ' : '\n'), nested: false };
  }
  return { key, value: lines.slice(first + 1, last + 1).join('\n'), nested: rest.length > 0 };
}

/** All top-level front matter entries, in document order. */
export function readFrontMatter(doc: string): MetaEntry[] {
  const block = findBlock(doc);
  if (!block) return [];
  return splitKeys(block.lines).map(k => parseEntry(block.lines, k.first, k.last));
}

export function getMeta(doc: string, key: string): MetaEntry | undefined {
  return readFrontMatter(doc).find(e => e.key === key);
}

/** Tags as HedgeDoc reads them: a list, or a comma-separated string. */
export function getTags(doc: string): string[] {
  const value = getMeta(doc, 'tags')?.value;
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : value.split(',');
  return list.map(t => t.trim()).filter(Boolean);
}

const PLAIN = /^[^\s\-?:,[\]{}#&*!|>'"%@`][^#]*$/;

function yamlScalar(value: string): string {
  if (value === '') return "''";
  // Keep booleans and numbers as typed (breaks: false, GA: UA-...).
  if (PLAIN.test(value) && !/:\s|\s$/.test(value)) return value;
  return JSON.stringify(value);
}

function serialize(key: string, value: MetaValue): string {
  if (Array.isArray(value)) return `${key}: [${value.map(yamlScalar).join(', ')}]`;
  return `${key}: ${yamlScalar(value)}`;
}

/**
 * Return `doc` with `key` set to `value` (or removed when `value` is null).
 * Creates the front matter if needed and removes it when it becomes empty.
 */
export function setMeta(doc: string, key: string, value: MetaValue | null): string {
  if (!/^[A-Za-z_][\w.-]*$/.test(key)) throw new Error(`Invalid front matter key: ${key}`);
  const block = findBlock(doc);
  if (!block) {
    if (value === null) return doc;
    return `---\n${serialize(key, value)}\n---\n${doc}`;
  }
  const lines = [...block.lines];
  const existing = splitKeys(lines).find(k => k.key === key);
  if (existing) {
    const replacement = value === null ? [] : [serialize(key, value)];
    lines.splice(existing.first, existing.last - existing.first + 1, ...replacement);
  } else if (value !== null) {
    // Insert after the last non-blank line, keeping trailing blank lines in place.
    let at = lines.length;
    while (at > 0 && lines[at - 1].trim() === '') at--;
    lines.splice(at, 0, serialize(key, value));
  } else {
    return doc;
  }
  const rest = doc.slice(block.end);
  if (lines.every(l => l.trim() === '')) return rest;
  const nl = block.newline;
  return `---${nl}${lines.map(l => l + nl).join('')}---${nl}${rest}`;
}
