/**
 * HedgeDoc note URL helpers.
 */

export interface ParsedNoteUrl {
  serverUrl: string;
  noteId: string;
}

/**
 * Build a note URL from server base URL and note ID.
 */
export function buildNoteUrl(serverUrl: string, noteId: string): string {
  if (!serverUrl) {
    throw new Error('serverUrl is required');
  }
  if (!noteId) {
    throw new Error('noteId is required');
  }

  return `${serverUrl.replace(/\/$/, '')}/${encodeURIComponent(noteId)}`;
}

/** Path suffixes HedgeDoc serves for a note (e.g. /abc123/publish). */
const NOTE_SUFFIXES = new Set(['publish', 'slide', 'download', 'info', 'revision', 'pdf', 'gist']);
/** Prefixes for published and slide short links (/s/<shortid>, /p/<shortid>). */
const SHORT_PREFIXES = new Set(['s', 'p']);

/**
 * Parse a note URL into server URL and note ID.
 *
 * Handles sub-path deployments (https://example.com/hedgedoc/abc123),
 * published/slide links (/s/<id>, /p/<id>), action suffixes
 * (/abc123/publish, /abc123/slide, /abc123/download, ...), and ignores
 * query strings and fragments.
 */
export function parseNoteUrl(url: string): ParsedNoteUrl {
  if (!url) {
    throw new Error('url is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  const pathParts = parsed.pathname.split('/').filter(Boolean);
  if (pathParts.length >= 2 && NOTE_SUFFIXES.has(pathParts[pathParts.length - 1])) {
    pathParts.pop();
  }
  if (pathParts.length === 0) {
    throw new Error(`URL does not contain a note ID: ${url}`);
  }

  const noteId = decodeURIComponent(pathParts.pop()!);
  if (pathParts.length > 0 && SHORT_PREFIXES.has(pathParts[pathParts.length - 1])) {
    pathParts.pop();
  }
  const basePath = pathParts.length > 0 ? `/${pathParts.join('/')}` : '';
  const serverUrl = `${parsed.protocol}//${parsed.host}${basePath}`;

  return { serverUrl, noteId };
}

/**
 * Normalise a server URL (as given by the user) to origin plus path, without
 * a trailing slash, query or fragment.
 */
export function parseServerUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
}
