import { describe, expect, test } from 'bun:test';
import { appendToSection, findSection, replaceSection, sections } from '../../src/note-sections.js';

const doc = '# Ops\n\nintro\n\n## Timeline\n\n- 14:02 alert\n\n## Notes\n\nfree text\n```sh\n# not a heading\n```\n';

describe('sections', () => {
  test('headings outside fences, with their extent', () => {
    expect(sections(doc).map(s => [s.heading, s.level])).toEqual([['Ops', 1], ['Timeline', 2], ['Notes', 2]]);
    const t = findSection(doc, 'timeline')!;
    expect(doc.slice(t.bodyStart, t.end)).toBe('\n- 14:02 alert\n\n');
    expect(findSection(doc, 'Ops')!.end).toBe(doc.length); // contains the level-2 sections
  });

  test('append goes after the last line of the section', () => {
    const out = appendToSection(doc, findSection(doc, 'Timeline')!, '- 14:05 alice: looking');
    expect(out).toContain('- 14:02 alert\n- 14:05 alice: looking\n\n## Notes');
  });

  test('append to the last section and to an empty one', () => {
    expect(appendToSection('# A\n\nx\n', findSection('# A\n\nx\n', 'A')!, 'y')).toBe('# A\n\nx\ny\n');
    expect(appendToSection('# A\n# B\n', findSection('# A\n# B\n', 'A')!, 'y')).toBe('# A\n\ny\n# B\n');
    expect(appendToSection('# A', findSection('# A', 'A')!, 'y')).toBe('# A\n\ny');
  });

  test('replace keeps the heading and the next section', () => {
    expect(replaceSection(doc, findSection(doc, 'Timeline')!, 'all clear\n')).toContain('## Timeline\n\nall clear\n\n## Notes');
  });
});
