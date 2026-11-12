import { describe, expect, test } from 'bun:test';
import { parseArgs, splitCommand, type OptionSpec } from '../../src/cli/args.js';
import { parseNoteUrl, parseServerUrl } from '../../src/url.js';

const specs: OptionSpec[] = [
  { name: 'json', type: 'flag' },
  { name: 'quiet', short: 'q', type: 'flag' },
  { name: 'output', short: 'o', type: 'value' },
  { name: 'exec', short: 'e', type: 'multi' },
  { name: 'all', short: 'a', type: 'flag', aliases: ['global'] },
];

describe('parseArgs', () => {
  test('flags never take the next argument', () => {
    const a = parseArgs('get', ['--json', 'https://x/y'], specs);
    expect(a.positional).toEqual(['https://x/y']);
    expect(a.options.json).toBe(true);
  });

  test('value options always do, even if the value starts with "-"', () => {
    expect(parseArgs('get', ['-o', '-'], specs).options.output).toBe('-');
    expect(parseArgs('get', ['--output=a=b'], specs).options.output).toBe('a=b');
    expect(parseArgs('get', ['-ofile'], specs).options.output).toBe('file');
  });

  test('short flags combine and aliases share values', () => {
    const a = parseArgs('x', ['-qa', '--global'], specs);
    expect(a.options).toMatchObject({ quiet: true, q: true, all: true, a: true, global: true });
  });

  test('multi options collect', () => {
    expect(parseArgs('macro', ['-e', 'one', '--exec', 'two'], specs).options.exec).toEqual(['one', 'two']);
  });

  test('negative numbers and "--" are positional', () => {
    const a = parseArgs('line', ['url', '-1', '--', '--json'], specs);
    expect(a.positional).toEqual(['url', '-1']);
    expect(a.rest).toEqual(['--json']);
    expect(a.options.json).toBeUndefined();
  });

  test('unknown options and missing values are errors', () => {
    expect(() => parseArgs('get', ['--nope'], specs)).toThrow('Unknown option --nope');
    expect(() => parseArgs('get', ['-z'], specs)).toThrow('Unknown option -z');
    expect(() => parseArgs('get', ['-o'], specs)).toThrow('needs a value');
    expect(() => parseArgs('get', ['--json=1'], specs)).toThrow('does not take a value');
  });

  test('splitCommand skips leading global options', () => {
    expect(splitCommand(['-o', 'f', 'get', 'u'], specs)).toEqual({ command: 'get', rest: ['-o', 'f', 'u'] });
    expect(splitCommand(['--json'], specs)).toEqual({ command: null, rest: ['--json'] });
  });
});

describe('note URLs', () => {
  const cases: [string, string, string][] = [
    ['https://md.example.com/abc123', 'https://md.example.com', 'abc123'],
    ['https://md.example.com/abc123/', 'https://md.example.com', 'abc123'],
    ['https://example.com/hedgedoc/abc123', 'https://example.com/hedgedoc', 'abc123'],
    ['https://md.example.com/abc123?both#heading', 'https://md.example.com', 'abc123'],
    ['https://md.example.com/abc123/publish', 'https://md.example.com', 'abc123'],
    ['https://md.example.com/abc123/slide', 'https://md.example.com', 'abc123'],
    ['https://md.example.com/s/shortid', 'https://md.example.com', 'shortid'],
    ['https://example.com/hedgedoc/p/shortid', 'https://example.com/hedgedoc', 'shortid'],
    ['https://md.example.com/my%20alias', 'https://md.example.com', 'my alias'],
  ];
  for (const [url, serverUrl, noteId] of cases) {
    test(url, () => expect(parseNoteUrl(url)).toEqual({ serverUrl, noteId }));
  }

  test('server URLs keep their path', () => {
    expect(parseServerUrl('https://md.example.com/')).toBe('https://md.example.com');
    expect(parseServerUrl('https://example.com/hedgedoc/')).toBe('https://example.com/hedgedoc');
    expect(() => parseNoteUrl('https://md.example.com/')).toThrow('does not contain a note ID');
  });
});

test('VERSION matches package.json', async () => {
  const { VERSION } = await import('../../src/version.js');
  const pkg = await Bun.file(new URL('../../package.json', import.meta.url)).json();
  expect(VERSION).toBe(pkg.version);
});
