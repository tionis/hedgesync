/**
 * A note as a clipboard history: entries under `## ` headings, newest first.
 *
 *   # Clipboard
 *
 *   Newest first. ...
 *
 *   ## 2026-11-16 14:02 · laptop
 *
 *   ```
 *   copied text
 *   ```
 *
 * Text is stored in a code fence, so it is kept exactly and can be copied
 * from the browser with one click. Entries people write by hand (a heading
 * and plain text, e.g. typed on a phone) work too.
 */

export interface ClipEntry {
  label: string;
  text: string;
  /** Offsets of the entry in the note (heading line to the next entry). */
  start: number;
  end: number;
}

export const CLIP_TEMPLATE = '# Clipboard\n\nNewest first. To add an entry by hand, write a `## ` heading above the others with the text below it.\n';

/** Offsets of lines starting with `## ` outside code fences. */
function entryHeadings(doc: string): { at: number; label: string }[] {
  const out: { at: number; label: string }[] = [];
  let fence: string | null = null;
  let at = 0;
  for (const line of doc.split('\n')) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (line.trim().startsWith(fence) && line.trim().replace(/[`~]/g, '') === '') fence = null;
    } else if (!fence && /^##\s/.test(line)) {
      out.push({ at, label: line.replace(/^##\s+/, '').trim() });
    }
    at += line.length + 1;
  }
  return out;
}

/** The text of an entry body: unwrapped if it is one code fence, else trimmed of blank lines around it. */
function bodyText(body: string): string {
  const trimmed = body.replace(/^\s*\n/, '').replace(/\n\s*$/, '').replace(/^\n+|\n+$/g, '');
  const m = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?\1[ \t]*$/.exec(trimmed);
  if (m && !m[2].split('\n').some(l => l.trim() === m[1])) return m[2];
  return trimmed;
}

export function parseClipNote(doc: string): ClipEntry[] {
  const heads = entryHeadings(doc);
  return heads.map((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].at : doc.length;
    const bodyStart = Math.min(end, doc.indexOf('\n', h.at) < 0 ? end : doc.indexOf('\n', h.at) + 1);
    return { label: h.label, text: bodyText(doc.slice(bodyStart, end)), start: h.at, end };
  });
}

/** A fence that the text cannot close. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(m => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Add an entry at the top, keeping at most `keep` entries. `raw` text (an image) is not put in a fence, so it renders. */
export function addClipEntry(doc: string, text: string, label: string, keep = 50, options: { raw?: boolean } = {}): string {
  const fence = fenceFor(text);
  const entry = options.raw ? `## ${label}\n\n${text}\n\n` : `## ${label}\n\n${fence}\n${text}\n${fence}\n\n`;
  const entries = parseClipNote(doc);
  let base = doc;
  if (entries.length >= keep) base = doc.slice(0, entries[Math.max(0, keep - 1)].start).replace(/\n*$/, '\n\n');
  const first = parseClipNote(base)[0];
  if (first) return base.slice(0, first.start) + entry + base.slice(first.start);
  const head = base === '' ? CLIP_TEMPLATE : base;
  return head.replace(/\n*$/, '\n\n') + entry.replace(/\n+$/, '\n');
}

/** "2026-11-16 14:02 · laptop" in local time. */
export function clipLabel(device: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())} · ${device}`;
}

/** The image URL if an entry is just an image (`![name](url)`). */
export function clipImage(text: string): { name: string; url: string } | undefined {
  const m = /^!\[([^\]]*)\]\((\S+?)(?:\s+"[^"]*")?\)$/.exec(text.trim());
  return m ? { name: m[1], url: m[2] } : undefined;
}
