/**
 * HedgeDoc HTTP API Client
 * 
 * This module provides HTTP API access to HedgeDoc for operations that don't
 * require real-time Socket.IO connections, such as:
 * - Creating and deleting notes
 * - Downloading note content
 * - Managing note permissions
 * - User profile and history management
 * - Fetching note revisions
 * - Server status
 */

import { normalizeCookie } from './cookie.js';
import {
  HedgeSyncRequestFn,
  defaultHedgeSyncRequest,
  getHeader,
} from './http.js';
import { buildNoteUrl, parseNoteUrl } from './url.js';

// ===========================================
// Types
// ===========================================

/**
 * Note information returned by /{note}/info (HedgeDoc 1: lib/web/note/actions.js).
 * Tags and permission are not part of it: tags live in the front matter
 * (see frontmatter.ts), the permission comes with the realtime connection.
 */
export interface NoteMetadata {
  /** Front matter title, or the title derived from the first heading. */
  title: string;
  /** Front matter description, or one generated from the text. */
  description: string | null;
  viewcount: number;
  createtime: string;
  updatetime: string;
}

/** Note permission levels */
export type NotePermission =
  | 'freely'      // Anyone can view and edit
  | 'editable'    // Anyone can view, signed-in users can edit
  | 'limited'     // Signed-in users can view and edit
  | 'locked'      // Anyone can view, only the owner can edit
  | 'protected'   // Signed-in users can view, only the owner can edit
  | 'private';    // Only the owner can view and edit

/** Shareable links of a note. */
export interface NoteLinks {
  /** Editor (the note URL). */
  edit: string;
  /** Read-only view in the app (?view) and split view (?both). */
  view: string;
  both: string;
  /** Published page (/s/<alias or shortid>). */
  publish: string;
  /** Slide mode (/p/<alias or shortid>). */
  slide: string;
  /** Raw Markdown. */
  download: string;
}

/** User profile from /me */
export interface UserProfile {
  status: 'ok' | 'forbidden';
  id?: string;
  name?: string;
  photo?: string;
}

/** History entry from /history */
export interface HistoryEntry {
  id: string;
  text: string;
  time: number;
  tags: string[];
  pinned: boolean;
}

/** Revision info from /{note}/revision */
export interface RevisionInfo {
  time: number;
  length: number;
}

/** Full revision from /{note}/revision/{id} */
export interface Revision {
  content: string;
  authorship: number[][];
  patch: string[];
}

/** Server status from /status */
export interface ServerStatus {
  onlineNotes: number;
  onlineUsers: number;
  distinctOnlineUsers: number;
  notesCount: number;
  registeredUsers: number;
  onlineRegisteredUsers: number;
  distinctOnlineRegisteredUsers: number;
  isConnectionBusy: boolean;
  connectionSocketQueueLength: number;
  isDisconnectBusy: boolean;
  disconnectSocketQueueLength: number;
}

/**
 * Client config from /config. HedgeDoc serves this as a script of
 * `window.<key> = <value>` lines; the values are parsed out of it.
 */
export interface ServerConfig {
  domain: string;
  urlpath: string;
  debug: boolean;
  version: string;
  /**
   * The logged-in user's delete token, needed to delete history entries.
   * Empty when not logged in.
   */
  userToken: string;
  [key: string]: unknown;
}

/** Rich note reference returned by createNoteRef() */
export interface CreatedNoteRef {
  noteId: string;
  url: string;
  serverUrl: string;
}

/** API client options */
export interface HedgeDocAPIOptions {
  /** Base URL of the HedgeDoc server (e.g., https://md.example.com) */
  serverUrl: string;
  /** Session cookie for authentication (e.g., "connect.sid=...") */
  cookie?: string;
  /** Custom HTTP transport for all API requests. Falls back to fetch. */
  request?: HedgeSyncRequestFn;
  /** Custom headers to include in all requests (for reverse proxy authentication, etc.) */
  headers?: Record<string, string>;
}

interface HedgeDocAPIRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  redirect?: 'follow' | 'manual' | 'error';
}

// ===========================================
// Error Types
// ===========================================

export class HedgeDocAPIError extends Error {
  statusCode?: number;
  
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'HedgeDocAPIError';
    this.statusCode = statusCode;
  }
}

// ===========================================
// HedgeDocAPI Class
// ===========================================

/**
 * HTTP API client for HedgeDoc
 * 
 * Provides access to HedgeDoc's REST API for operations that don't require
 * real-time collaboration (Socket.IO).
 */
export class HedgeDocAPI {
  private serverUrl: string;
  private cookie: string | null;
  private customHeaders: Record<string, string>;
  private requestFn: HedgeSyncRequestFn;
  private deleteToken: string | null = null;
  
  constructor(options: HedgeDocAPIOptions) {
    this.serverUrl = options.serverUrl.replace(/\/$/, '');
    this.cookie = options.cookie ? normalizeCookie(options.cookie) : null;
    this.requestFn = options.request || defaultHedgeSyncRequest;
    this.customHeaders = options.headers || {};
  }
  
  // ===========================================
  // Internal Helpers
  // ===========================================
  
  /**
   * Make an HTTP request to the HedgeDoc API
   */
  private async request<T>(
    path: string,
    options: HedgeDocAPIRequestOptions = {}
  ): Promise<T> {
    const url = `${this.serverUrl}${path}`;
    
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      ...this.customHeaders,
      ...(options.headers || {}),
    };
    
    if (this.cookie) {
      headers['Cookie'] = this.cookie;
    }
    
    const response = await this.requestFn({
      url,
      method: options.method,
      headers,
      body: options.body,
      redirect: options.redirect ?? 'manual',
    });
    
    // Handle redirects (some HedgeDoc endpoints redirect)
    if (response.status >= 300 && response.status < 400) {
      const location = getHeader(response.headers, 'location');
      if (location) {
        // Extract note ID from redirect URL if creating a note
        return { redirect: location } as T;
      }
    }
    
    if ((response.status < 200 || response.status >= 300) && response.status !== 302) {
      const text = await response.text().catch(() => '');
      throw new HedgeDocAPIError(
        `HTTP ${response.status}${text ? ` - ${text}` : ''}`,
        response.status
      );
    }
    
    const contentType = getHeader(response.headers, 'content-type') || '';
    
    if (contentType.includes('application/json') || contentType.includes('text/json')) {
      return response.json() as Promise<T>;
    }
    
    // Return text for non-JSON responses
    return response.text() as unknown as T;
  }
  
  private extractNoteIdFromRedirect(redirect: string): string | null {
    if (!redirect) {
      return null;
    }

    try {
      return parseNoteUrl(redirect).noteId;
    } catch {
      // Continue - redirects are commonly relative paths.
    }

    try {
      const absolute = new URL(redirect, this.serverUrl).toString();
      return parseNoteUrl(absolute).noteId;
    } catch {
      // Fall back to regex parsing.
    }

    const match = redirect.match(/\/([^/?#]+)(?:[?#].*)?$/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  /**
   * Upload an image (POST /uploadimage) and return its URL. HedgeDoc accepts
   * jpeg, png, gif, svg and similar types; whether anonymous uploads are
   * allowed depends on the server configuration.
   */
  async uploadImage(data: ArrayBuffer | Uint8Array, filename: string, contentType = guessImageType(filename)): Promise<string> {
    const boundary = `----hedgesync${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
    const safeName = filename.replace(/["\r\n\\]/g, '_');
    const head = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${safeName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    );
    const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head, 0);
    body.set(bytes, head.length);
    body.set(tail, head.length + bytes.length);

    const result = await this.request<{ link?: string } | string>('/uploadimage', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: body.buffer,
    });
    const parsed = typeof result === 'string' ? safeJson(result) : result;
    const link = (parsed as { link?: string } | null)?.link;
    if (!link) throw new HedgeDocAPIError('Upload failed: the server did not return a link', 500);
    return link;
  }

  /** The session's delete token (from /config), required by history deletes. */
  private async getDeleteToken(): Promise<string> {
    if (this.deleteToken) return this.deleteToken;
    const token = (await this.getConfig()).userToken;
    if (!token) {
      throw new HedgeDocAPIError('Not logged in: deleting history requires a valid session cookie', 403);
    }
    this.deleteToken = token;
    return token;
  }

  // ===========================================
  // Server Info
  // ===========================================
  
  /**
   * Get the client configuration from /config (includes the delete token
   * when logged in).
   */
  async getConfig(): Promise<ServerConfig> {
    const script = await this.request<string | Record<string, unknown>>('/config');
    if (typeof script !== 'string') return script as ServerConfig;
    return parseConfigScript(script);
  }
  
  /**
   * Get server status (online users, note counts, etc.)
   */
  async getStatus(): Promise<ServerStatus> {
    return this.request<ServerStatus>('/status');
  }
  
  // ===========================================
  // Note Operations
  // ===========================================
  
  /**
   * Create a new note with random ID
   * @param content Optional initial content (defaults to server template)
   * @returns The new note's ID
   */
  async createNote(content?: string): Promise<string> {
    const result = content !== undefined
      ? await this.request<{ redirect: string } | string>('/new', {
        method: 'POST',
        headers: { 'Content-Type': 'text/markdown' },
        body: content,
      })
      : await this.request<{ redirect: string } | string>('/new');
    return this.noteIdFromCreateResponse(result);
  }

  /**
   * HedgeDoc answers note creation with a redirect to the new note. Anything
   * else (typically the editor page, when the HTTP transport followed the
   * redirect itself) does not tell us the note id.
   */
  private noteIdFromCreateResponse(result: { redirect: string } | string): string {
    if (typeof result === 'object' && result && 'redirect' in result) {
      const noteId = this.extractNoteIdFromRedirect(result.redirect);
      if (noteId) return noteId;
      throw new HedgeDocAPIError(`Failed to create note: unexpected redirect to ${result.redirect}`);
    }
    throw new HedgeDocAPIError(
      'Failed to create note: the server did not answer with a redirect to the new note. '
      + 'If you pass a custom request function, it must not follow redirects (request.redirect is "manual").',
    );
  }

  /**
   * Create a new note and return a rich reference object.
   * @param content Optional initial content (defaults to server template)
   */
  async createNoteRef(content?: string): Promise<CreatedNoteRef> {
    const noteId = await this.createNote(content);
    return {
      noteId,
      url: buildNoteUrl(this.serverUrl, noteId),
      serverUrl: this.serverUrl,
    };
  }
  
  /**
   * Create a new note with a specific alias (requires FreeURL mode)
   * @param alias The alias/name for the note
   * @param content The initial content
   * @returns The note ID (same as alias if successful)
   */
  async createNoteWithAlias(alias: string, content: string = ''): Promise<string> {
    const result = await this.request<{ redirect: string } | string>(`/new/${encodeURIComponent(alias)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/markdown',
      },
      body: content,
    });
    
    if (typeof result === 'object' && 'redirect' in result) {
      const noteId = this.extractNoteIdFromRedirect(result.redirect);
      return noteId ?? alias;
    }
    return alias;
  }
  
  /**
   * Download note content as raw markdown
   * @param noteId Note ID or alias
   */
  async downloadNote(noteId: string): Promise<string> {
    return this.request<string>(`/${encodeURIComponent(noteId)}/download`, {
      headers: {
        'Accept': 'text/markdown, text/plain, */*',
      },
    });
  }
  
  /**
   * Get note metadata (title, description, viewcount, etc.)
   * @param noteId Note ID or alias
   */
  async getNoteInfo(noteId: string): Promise<NoteMetadata> {
    return this.request<NoteMetadata>(`/${encodeURIComponent(noteId)}/info`);
  }
  
  /**
   * The note's shareable links. The publish and slide URLs use the note's
   * short id, which only the server knows, so they are read from the
   * redirects of /{note}/publish and /{note}/slide (which never create notes).
   */
  async getNoteLinks(noteId: string): Promise<NoteLinks> {
    const edit = buildNoteUrl(this.serverUrl, noteId);
    const resolve = async (action: string): Promise<string> => {
      const result = await this.request<{ redirect?: string } | string>(`/${encodeURIComponent(noteId)}/${action}`);
      const redirect = typeof result === 'object' ? result.redirect : undefined;
      if (!redirect) throw new HedgeDocAPIError(`No ${action} link for ${noteId} (does the note exist?)`, 404);
      return new URL(redirect, this.serverUrl + '/').toString();
    };
    const [publish, slide] = await Promise.all([resolve('publish'), resolve('slide')]);
    // A missing note redirects /publish back to the editor (HedgeDoc's default action).
    if (!/\/s\/[^/]+\/?$/.test(new URL(publish).pathname)) {
      throw new HedgeDocAPIError(`Note not found: ${noteId}`, 404);
    }
    return { edit, view: `${edit}?view`, both: `${edit}?both`, publish, slide, download: `${edit}/download` };
  }

  /**
   * The /{note}/publish URL, which redirects to the published page.
   * See getNoteLinks() for the final URL.
   */
  getPublishUrl(noteId: string): string {
    return `${this.serverUrl}/${encodeURIComponent(noteId)}/publish`;
  }
  
  /**
   * Get the slide URL for a note
   * @param noteId Note ID or alias
   */
  getSlideUrl(noteId: string): string {
    return `${this.serverUrl}/${encodeURIComponent(noteId)}/slide`;
  }
  
  // ===========================================
  // Note Revisions
  // ===========================================
  
  /**
   * List available revisions for a note
   * @param noteId Note ID or alias
   */
  async listRevisions(noteId: string): Promise<{ revision: RevisionInfo[] }> {
    return this.request<{ revision: RevisionInfo[] }>(`/${encodeURIComponent(noteId)}/revision`);
  }
  
  /**
   * Get a specific revision
   * @param noteId Note ID or alias
   * @param revisionId Revision timestamp
   */
  async getRevision(noteId: string, revisionId: number | string): Promise<Revision> {
    return this.request<Revision>(`/${encodeURIComponent(noteId)}/revision/${revisionId}`);
  }
  
  // ===========================================
  // User Profile (requires authentication)
  // ===========================================
  
  /**
   * Get current user's profile
   * Requires authentication via cookie
   */
  async getProfile(): Promise<UserProfile> {
    const result = await this.request<UserProfile>('/me');
    if (result.status === 'forbidden') {
      throw new HedgeDocAPIError('Not authenticated', 403);
    }
    return result;
  }
  
  /**
   * Export all notes as a zip archive
   * Requires authentication via cookie
   * @returns URL to download the export (you need to fetch it separately)
   */
  getExportUrl(): string {
    return `${this.serverUrl}/me/export`;
  }
  
  /**
   * Download export archive
   * Requires authentication via cookie
   * @returns The zip archive as an ArrayBuffer
   */
  async downloadExport(): Promise<ArrayBuffer> {
    const url = `${this.serverUrl}/me/export`;
    const headers: Record<string, string> = { ...this.customHeaders };
    if (this.cookie) {
      headers['Cookie'] = this.cookie;
    }
    
    const response = await this.requestFn({
      url,
      method: 'GET',
      headers,
    });
    
    if (response.status < 200 || response.status >= 300) {
      const text = await response.text().catch(() => '');
      throw new HedgeDocAPIError(
        `Failed to download export${text ? `: ${text}` : ''}`,
        response.status
      );
    }
    
    return response.arrayBuffer();
  }
  
  // ===========================================
  // History Management (requires authentication)
  // ===========================================
  
  /**
   * Get user's note history
   * Requires authentication via cookie
   */
  async getHistory(): Promise<{ history: HistoryEntry[] }> {
    const result = await this.request<{ history: HistoryEntry[] } | { status: string }>('/history');
    if (typeof result === 'object' && 'status' in result && result.status === 'forbidden') {
      throw new HedgeDocAPIError('Not authenticated', 403);
    }
    return result as { history: HistoryEntry[] };
  }
  
  /**
   * Replace entire history
   * Requires authentication via cookie
   * @param history Array of history entries
   */
  async setHistory(history: HistoryEntry[]): Promise<void> {
    await this.request('/history', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `history=${encodeURIComponent(JSON.stringify(history))}`,
    });
  }
  
  /**
   * Delete entire history
   * Requires authentication via cookie (uses the session's delete token)
   */
  async deleteHistory(): Promise<void> {
    const token = await this.getDeleteToken();
    await this.request(`/history?token=${encodeURIComponent(token)}`, {
      method: 'DELETE',
    });
  }
  
  /**
   * Toggle pinned status of a note in history
   * Requires authentication via cookie
   * @param noteId Note ID or alias
   * @param pinned Whether to pin or unpin
   */
  async setHistoryPinned(noteId: string, pinned: boolean): Promise<void> {
    await this.request(`/history/${encodeURIComponent(noteId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `pinned=${pinned}`,
    });
  }
  
  /**
   * Delete a note from history
   * Requires authentication via cookie
   * @param noteId Note ID or alias
   */
  async deleteFromHistory(noteId: string): Promise<void> {
    const token = await this.getDeleteToken();
    await this.request(`/history/${encodeURIComponent(noteId)}?token=${encodeURIComponent(token)}`, {
      method: 'DELETE',
    });
  }
  
  // ===========================================
  // Note Permission Management
  // ===========================================
  
  /**
   * Change note permission
   * This requires using the Socket.IO API, not HTTP.
   * The permission change is done via the 'permission' socket event.
   * 
   * Note: HedgeDoc doesn't expose permission changes via HTTP API.
   * Use HedgeDocClient.setPermission() instead for real-time permission changes.
   */
  
  // ===========================================
  // Note Deletion
  // ===========================================
  
  /**
   * Delete a note
   * Note: HedgeDoc doesn't expose note deletion via HTTP API.
   * Deletion is done via the 'delete' socket event.
   * Use HedgeDocClient.deleteNote() instead.
   */
}

export default HedgeDocAPI;

/** Parse the `window.<key> = <value>` script HedgeDoc serves at /config. */
export function parseConfigScript(script: string): ServerConfig {
  const config: Record<string, unknown> = {};
  for (const line of script.split('\n')) {
    const m = /^\s*window\.(\w+)\s*=\s*(.*?)\s*;?\s*$/.exec(line);
    if (!m) continue;
    const raw = m[2];
    if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
      config[m[1]] = raw.slice(1, -1);
      continue;
    }
    try {
      config[m[1]] = JSON.parse(raw);
    } catch {
      config[m[1]] = raw;
    }
  }
  return {
    domain: '',
    urlpath: '',
    debug: false,
    version: '',
    userToken: '',
    ...config,
  } as ServerConfig;
}

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', jpe: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
};

function guessImageType(filename: string): string {
  return IMAGE_TYPES[filename.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
