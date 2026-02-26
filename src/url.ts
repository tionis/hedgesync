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

/**
 * Parse a full note URL into server URL and note ID.
 *
 * Supports subpath deployments such as:
 * - https://example.com/hedgedoc/abc123
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
  if (pathParts.length === 0) {
    throw new Error(`URL does not contain a note ID: ${url}`);
  }

  const rawNoteId = pathParts[pathParts.length - 1];
  const noteId = decodeURIComponent(rawNoteId);
  const basePath = pathParts.length > 1 ? `/${pathParts.slice(0, -1).join('/')}` : '';
  const serverUrl = `${parsed.protocol}//${parsed.host}${basePath}`;

  return { serverUrl, noteId };
}

