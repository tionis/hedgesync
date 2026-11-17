import { describe, expect, test } from 'bun:test';
import { parseListen } from '../../src/cli/commands/mcp.js';
import { canonicalProfile, findRels, redirectMatches } from '../../src/cli/mcp/oauth.js';
import { outline, parseLineRange } from '../../src/cli/mcp/tools.js';

describe('IndieAuth helpers', () => {
  test('profile URLs are compared in canonical form', () => {
    expect(canonicalProfile('Example.COM')).toBe('https://example.com/');
    expect(canonicalProfile('https://example.com/me#x')).toBe('https://example.com/me');
    expect(canonicalProfile(' http://localhost:8080 ')).toBe('http://localhost:8080/');
  });

  test('rels from Link headers and HTML, header first', () => {
    const html = `<link rel="authorization_endpoint" href="/auth"><a rel='me indieauth-metadata' href=https://x.example/meta>`;
    const rels = findRels(html, '<https://h.example/meta>; rel="indieauth-metadata", </tok>; rel=token_endpoint', 'https://me.example/p/');
    expect(rels.get('indieauth-metadata')).toBe('https://h.example/meta');
    expect(rels.get('token_endpoint')).toBe('https://me.example/tok');
    expect(rels.get('authorization_endpoint')).toBe('https://me.example/auth');
    expect(rels.get('me')).toBe('https://x.example/meta');
  });

  test('redirect URIs match exactly, loopback on any port', () => {
    expect(redirectMatches('https://app.example/cb', 'https://app.example/cb')).toBe(true);
    expect(redirectMatches('https://app.example/cb', 'https://app.example/cb2')).toBe(false);
    expect(redirectMatches('http://127.0.0.1/cb', 'http://127.0.0.1:5555/cb')).toBe(true);
    expect(redirectMatches('http://localhost:1/cb', 'http://localhost:2/other')).toBe(false);
    expect(redirectMatches('http://app.example:1/cb', 'http://app.example:2/cb')).toBe(false);
  });
});

describe('mcp helpers', () => {
  test('--http values', () => {
    expect(parseListen('8788')).toEqual({ host: '127.0.0.1', port: 8788 });
    expect(parseListen('0.0.0.0:80')).toEqual({ host: '0.0.0.0', port: 80 });
    expect(parseListen('[::1]:9')).toEqual({ host: '::1', port: 9 });
    expect(() => parseListen('nope')).toThrow('Invalid --http');
  });

  test('line ranges and outlines', () => {
    expect(parseLineRange('3-5', 10)).toEqual({ from: 3, to: 5 });
    expect(parseLineRange('7-', 10)).toEqual({ from: 7, to: 10 });
    expect(parseLineRange('4', 10)).toEqual({ from: 4, to: 4 });
    expect(parseLineRange('8-99', 10)).toEqual({ from: 8, to: 10 });
    expect(() => parseLineRange('11', 10)).toThrow('past its end');
    expect(() => parseLineRange('5-2', 10)).toThrow('before the start');
    expect(outline('# A\ntext\n## B\n')).toBe('    1  # A\n    3  ## B');
  });
});
