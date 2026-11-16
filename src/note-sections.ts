/**
 * Sections of a Markdown note: a heading and everything up to the next
 * heading of the same or a higher level. Headings inside code fences don't
 * count.
 */

export interface Section {
  /** The heading's text, as written. */
  heading: string;
  level: number;
  /** Where the heading line starts. */
  start: number;
  /** Where the section's content starts (after the heading line). */
  bodyStart: number;
  /** Where the section ends (the next heading of the same or higher level, or the end). */
  end: number;
}

export function sections(doc: string): Section[] {
  const heads: { heading: string; level: number; start: number; bodyStart: number }[] = [];
  let fence: string | null = null;
  let at = 0;
  for (const line of doc.split('\n')) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (line.trim().startsWith(fence) && /^[`~]+$/.test(line.trim())) fence = null;
    } else if (!fence) {
      const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (h) heads.push({ heading: h[2], level: h[1].length, start: at, bodyStart: Math.min(doc.length, at + line.length + 1) });
    }
    at += line.length + 1;
  }
  return heads.map((h, i) => {
    const next = heads.slice(i + 1).find(n => n.level <= h.level);
    return { ...h, end: next ? next.start : doc.length };
  });
}

/** The first section whose heading matches (case-insensitive, exact text), if any. */
export function findSection(doc: string, heading: string): Section | undefined {
  const wanted = heading.trim().toLowerCase();
  return sections(doc).find(s => s.heading.toLowerCase() === wanted);
}

/** Where to append to a section: after its last non-blank content, before the blank lines that separate it from the next heading. */
export function sectionAppendPoint(doc: string, section: Section): number {
  let end = section.end;
  while (end > section.bodyStart && doc[end - 1] === '\n') end--;
  return end;
}

/** `doc` with `text` added as new lines at the end of `section`. */
export function appendToSection(doc: string, section: Section, text: string): string {
  const at = sectionAppendPoint(doc, section);
  // An empty section gets a blank line under its heading.
  const lead = at === section.bodyStart ? (doc[at - 1] === '\n' ? '\n' : '\n\n') : '\n';
  const insert = lead + text.replace(/\n+$/, '');
  // Keep a newline before a following heading.
  const after = at < doc.length && doc[at] !== '\n' ? '\n' : '';
  return doc.slice(0, at) + insert + after + doc.slice(at);
}

/** `doc` with the content of `section` replaced (the heading stays). */
export function replaceSection(doc: string, section: Section, text: string): string {
  const body = text.replace(/\n+$/, '');
  const tail = section.end < doc.length ? '\n\n' : '\n';
  const head = doc.slice(0, section.bodyStart);
  return (head.endsWith('\n') ? head : head + '\n') + '\n' + body + tail + doc.slice(section.end);
}
