import { describe, expect, test } from 'bun:test';
import { commandFilter, createFilter, onlyMarked, parseReplace, stripMarked, stripSections } from '../../src/note-filter.js';

describe('stripMarked', () => {
  test('removes blocks with their marker lines, and inline spans', () => {
    const gm = 'The party reaches the mill.\n\n<!-- gm -->\nThe miller is the cult leader.\n<!-- /gm -->\n\nThe door is locked. ::gm A key is under the mat.::\nEnd.\n';
    expect(stripMarked(gm, 'gm')).toBe('The party reaches the mill.\n\n\nThe door is locked.\nEnd.\n');
  });

  test('inline markers in a line, and nested blocks', () => {
    expect(stripMarked('a <!-- gm -->b<!-- /gm --> c', 'gm')).toBe('a  c');
    expect(stripMarked('x\n<!-- gm -->\n1\n<!-- gm -->\n2\n<!-- /gm -->\n3\n<!-- /gm -->\ny', 'gm')).toBe('x\ny');
  });

  test('other markers and closed comments stay', () => {
    expect(stripMarked('a <!-- note --> b ::other x:: c', 'gm')).toBe('a <!-- note --> b ::other x:: c');
    expect(stripMarked('use ::gmail:: here', 'gm')).toBe('use ::gmail:: here');
  });

  test('fails closed: an unclosed block hides everything after it', () => {
    expect(stripMarked('public\n<!-- gm -->\nsecret\nmore secret\n', 'gm')).toBe('public\n');
  });

  test('fails closed: a comment still being typed hides what follows', () => {
    expect(stripMarked('public\n<!-- g\nsecret\n', 'gm')).toBe('public\n');
    expect(stripMarked('public <!-- gm', 'gm')).toBe('public');
  });

  test('an unclosed inline span hides the rest of its line only', () => {
    expect(stripMarked('a ::gm secret\nb', 'gm')).toBe('a\nb');
  });
});

describe('onlyMarked', () => {
  test('keeps block contents and spans', () => {
    expect(onlyMarked('x\n<!-- dec -->\nShip Friday\n<!-- /dec -->\ny ::dec Use Bun:: z\n', 'dec')).toBe('Ship Friday\n\nUse Bun\n');
    expect(onlyMarked('nothing', 'dec')).toBe('');
  });
});

describe('stripSections', () => {
  test('removes a section and its subsections, not code fence lines', () => {
    const text = '# Plan\nintro\n## Internal\nsecret\n### Deeper\nalso\n## Public\nok\n```sh\n# Internal comment\n```\n';
    expect(stripSections(text, /^internal$/i)).toBe('# Plan\nintro\n## Public\nok\n```sh\n# Internal comment\n```\n');
  });
});

test('parseReplace', () => {
  expect(parseReplace('/alice|bob/i=someone')('Alice met bob')).toBe('someone met someone');
  expect(parseReplace('/(\\d+) €/=EUR $1')('5 € and 7 €')).toBe('EUR 5 and EUR 7');
  expect(() => parseReplace('nope')).toThrow(/Invalid --replace/);
});

test.skipIf(process.platform === 'win32')('commandFilter: stdout replaces the text; failure throws', () => {
  expect(commandFilter('tr a-z A-Z')('abc')).toBe('ABC');
  expect(() => commandFilter('exit 3')('abc')).toThrow(/exited with 3/);
});

test('createFilter composes in order, or is undefined', () => {
  expect(createFilter({})).toBeUndefined();
  const f = createFilter({ strip: ['gm'], replace: ['/Bob/=B.'] })!;
  expect(f('Bob ::gm is a spy:: waves.')).toBe('B. waves.');
  expect(() => createFilter({ strip: ['bad name'] })).toThrow(/Invalid marker name/);
});

test('mirror warns when the source is as readable as the target', async () => {
  const { audienceWarning } = await import('../../src/cli/commands/mirror.js');
  expect(audienceWarning('private', 'freely')).toBeUndefined();
  expect(audienceWarning('limited', 'freely')).toBeUndefined();
  expect(audienceWarning('limited', 'limited')).toContain('hides nothing');
  expect(audienceWarning('freely', 'private')).toContain('hides nothing');
});
