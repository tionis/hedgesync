import { describe, expect, test } from 'bun:test';
import { getMeta, getTags, readFrontMatter, setMeta } from '../../src/frontmatter.js';
import { diffStat, unifiedDiff } from '../../src/line-diff.js';

const doc = `---
title: My "Note"
tags: [work, 'two words']
breaks: false
slideOptions:
  theme: solarized
  transition: fade
# a comment
lang: de-de
---
# Heading
body
`;

describe('front matter', () => {
  test('reads scalars, flow and block lists, nested blocks', () => {
    expect(readFrontMatter(doc)).toEqual([
      { key: 'title', value: 'My "Note"', nested: false },
      { key: 'tags', value: ['work', 'two words'], nested: false },
      { key: 'breaks', value: 'false', nested: false },
      { key: 'slideOptions', value: '  theme: solarized\n  transition: fade', nested: true },
      { key: 'lang', value: 'de-de', nested: false },
    ]);
    expect(getTags('---\ntags:\n  - a\n  - "b"\n---\n')).toEqual(['a', 'b']);
    expect(getTags('---\ntags: a, b ,c\n---\n')).toEqual(['a', 'b', 'c']);
    expect(getTags('# no front matter')).toEqual([]);
    expect(readFrontMatter('---\nnot closed\n')).toEqual([]);
  });

  test('edits touch only the key, keep comments and body', () => {
    const changed = setMeta(doc, 'tags', ['work', 'idea']);
    expect(changed).toBe(doc.replace("tags: [work, 'two words']", 'tags: [work, idea]'));
    const nested = setMeta(doc, 'slideOptions', null);
    expect(nested).not.toContain('theme: solarized');
    expect(nested).toContain('# a comment\nlang: de-de');
    expect(getMeta(setMeta(doc, 'description', 'Has: colon'), 'description')?.value).toBe('Has: colon');
    expect(setMeta(doc, 'description', 'Has: colon')).toContain('description: "Has: colon"\n---\n# Heading');
  });

  test('creates and removes the block as needed', () => {
    expect(setMeta('# Hi\n', 'type', 'slide')).toBe('---\ntype: slide\n---\n# Hi\n');
    expect(setMeta('---\ntype: slide\n---\n# Hi\n', 'type', null)).toBe('# Hi\n');
    expect(setMeta('# Hi\n', 'type', null)).toBe('# Hi\n');
    expect(setMeta('---\r\na: 1\r\n---\r\nx', 'b', '2')).toBe('---\r\na: 1\r\nb: 2\r\n---\r\nx');
    expect(() => setMeta('', 'bad key', 'x')).toThrow('Invalid');
  });
});

describe('line diff', () => {
  test('unified hunks with context', () => {
    const a = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].join('\n');
    const b = ['1', '2', '3', '4', 'five', '6', '7', '8', '9', '10', '11'].join('\n');
    expect(unifiedDiff(a, b, 1)).toBe('@@ -4,3 +4,3 @@\n 4\n-5\n+five\n 6\n@@ -10,1 +10,2 @@\n 10\n+11');
    expect(unifiedDiff(a, a)).toBe('');
    expect(diffStat(a, b)).toEqual({ added: 2, removed: 1 });
  });
});
