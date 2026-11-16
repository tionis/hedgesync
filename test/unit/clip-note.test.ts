import { describe, expect, test } from 'bun:test';
import { addClipEntry, CLIP_TEMPLATE, clipLabel, parseClipNote } from '../../src/clip-note.js';

describe('clipboard note', () => {
  test('the first entry creates the note body; later ones go on top', () => {
    let doc = addClipEntry('', 'first', 'a');
    expect(doc).toBe(`${CLIP_TEMPLATE}\n## a\n\n\`\`\`\nfirst\n\`\`\`\n`);
    doc = addClipEntry(doc, 'second\nline', 'b');
    expect(parseClipNote(doc).map(e => [e.label, e.text])).toEqual([['b', 'second\nline'], ['a', 'first']]);
  });

  test('text with fences and headings is kept exactly', () => {
    const text = '## not a heading\n```js\nx\n```\n';
    const doc = addClipEntry('', text, 'a');
    expect(parseClipNote(doc)).toHaveLength(1);
    expect(parseClipNote(doc)[0].text).toBe(text);
  });

  test('entries written by hand, without a fence', () => {
    const doc = `${CLIP_TEMPLATE}\n## from my phone\n\nhello there\n\n## a\n\n\`\`\`\nold\n\`\`\`\n`;
    expect(parseClipNote(doc).map(e => e.text)).toEqual(['hello there', 'old']);
  });

  test('keeps at most `keep` entries', () => {
    let doc = '';
    for (let i = 1; i <= 5; i++) doc = addClipEntry(doc, `t${i}`, `l${i}`, 3);
    expect(parseClipNote(doc).map(e => e.text)).toEqual(['t5', 't4', 't3']);
    expect(doc.startsWith(CLIP_TEMPLATE)).toBe(true);
  });

  test('a note without entries keeps its text above the first one', () => {
    expect(addClipEntry('# Mine\n', 'x', 'a')).toBe('# Mine\n\n## a\n\n```\nx\n```\n');
  });

  test('image entries are not fenced, and are recognised', async () => {
    const { clipImage } = await import('../../src/clip-note.js');
    const doc = addClipEntry('', '![shot](https://md.example.com/uploads/a.png)', 'a', 50, { raw: true });
    expect(doc).toContain('## a\n\n![shot](https://md.example.com/uploads/a.png)\n');
    const [entry] = parseClipNote(doc);
    expect(clipImage(entry.text)).toEqual({ name: 'shot', url: 'https://md.example.com/uploads/a.png' });
    expect(clipImage('text with ![x](y) inside')).toBeUndefined();
  });

  test('label', () => {
    expect(clipLabel('laptop', new Date(2026, 10, 16, 9, 5))).toBe('2026-11-16 09:05 · laptop');
  });
});

test('password manager entries are recognised', async () => {
  const { isConcealed } = await import('../../src/system-clipboard.js');
  expect(isConcealed(['text/plain', 'x-kde-passwordManagerHint'])).toBe(true);
  expect(isConcealed(['org.nspasteboard.ConcealedType'])).toBe(true);
  expect(isConcealed(['ExcludeClipboardContentFromMonitorProcessing', 'UnicodeText'])).toBe(true);
  expect(isConcealed(['text/plain', 'UTF8_STRING'])).toBe(false);
  expect(isConcealed(['public.utf8-plain-text', 'NSStringPboardType'])).toBe(false);
});

// The real clipboard, where the platform has one without a display server (CI runs these).
test.skipIf(!['darwin', 'win32'].includes(process.platform))('system clipboard round trip, with non-ASCII text', async () => {
  const { systemClipboard, isConcealed } = await import('../../src/system-clipboard.js');
  const board = systemClipboard({})!;
  expect(board).not.toBeNull();
  const text = 'héllo wörld ✓ 日本\nsecond line';
  board.copy(text);
  expect(board.paste()?.replace(/\r\n/g, '\n')).toBe(text);
  const types = board.types();
  expect(types?.length).toBeGreaterThan(0);
  expect(isConcealed(types!)).toBe(false);
});
