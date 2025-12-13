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

import { normalizeCookie } from './auth.js';

// ===========================================
// Types
// ===========================================

/** Note information returned by /{note}/info */
export interface NoteMetadata {
  id: string;
  alias?: string;
  title: string;
  description: string;
  tags: string[];
  viewcount: number;
  createtime: string;
  updatetime: string;
  permission: NotePermission;
}

/** Note permission levels */
export type NotePermission = 
  | 'freely'      // Anyone can edit
  | 'editable'    // Logged-in users can edit
  | 'limited'     // Logged-in users can edit (limited)
  | 'locked'      // Only owner can edit
  | 'private'     // Only owner can view/edit
  | 'protected';  // Only owner can edit, others can view

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

/** Config from /config (includes CSRF token) */
export interface ServerConfig {
  domain: string;
  urlPath: string;
  debug: boolean;
  version: string;
  CSRF?: string;  // CSRF token for authenticated operations
  [key: string]: unknown;
}

/** API client options */
export interface HedgeDocAPIOptions {
  /** Base URL of the HedgeDoc server (e.g., https://md.example.com) */
  serverUrl: string;
  /** Session cookie for authentication (e.g., "connect.sid=...") */
  cookie?: string;
  /** Custom headers to include in all requests (for reverse proxy authentication, etc.) */
  headers?: Record<string, string>;
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
  private csrfToken: string | null = null;
  
  constructor(options: HedgeDocAPIOptions) {
    this.serverUrl = options.serverUrl.replace(/\/$/, '');
    this.cookie = options.cookie ? normalizeCookie(options.cookie) : null;
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
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.serverUrl}${path}`;
    
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      ...this.customHeaders,
      ...(options.headers as Record<string, string> || {}),
    };
    
    if (this.cookie) {
      headers['Cookie'] = this.cookie;
    }
    
    const response = await fetch(url, {
      ...options,
      headers,
      redirect: 'manual', // Don't auto-follow redirects
    });
    
    // Handle redirects (some HedgeDoc endpoints redirect)
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location');
      if (location) {
        // Extract note ID from redirect URL if creating a note
        return { redirect: location } as T;
      }
    }
    
    if (!response.ok && response.status !== 302) {
      const text = await response.text().catch(() => '');
      throw new HedgeDocAPIError(
        `HTTP ${response.status}: ${response.statusText}${text ? ` - ${text}` : ''}`,
        response.status
      );
    }
    
    const contentType = response.headers.get('Content-Type') || '';
    
    if (contentType.includes('application/json') || contentType.includes('text/json')) {
      return response.json() as Promise<T>;
    }
    
    // Return text for non-JSON responses
    return response.text() as unknown as T;
  }
  
  /**
   * Fetch CSRF token from /config endpoint (needed for some operations)
   */
  async getCSRFToken(): Promise<string | null> {
    if (this.csrfToken) {
      return this.csrfToken;
    }
    
    try {
      const config = await this.getConfig();
      this.csrfToken = config.CSRF || null;
      return this.csrfToken;
    } catch {
      return null;
    }
  }
  
  // ===========================================
  // Server Info
  // ===========================================
  
  /**
   * Get server configuration (includes CSRF token when logged in)
   */
  async getConfig(): Promise<ServerConfig> {
    return this.request<ServerConfig>('/config');
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
    if (content !== undefined) {
      // POST with content
      const result = await this.request<{ redirect: string } | string>('/new', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/markdown',
        },
        body: content,
      });
      
      // Extract note ID from redirect
      if (typeof result === 'object' && 'redirect' in result) {
        const match = result.redirect.match(/\/([^/]+)$/);
        return match ? match[1] : result.redirect;
      }
      return String(result);
    }
    
    // GET to create empty note
    const result = await this.request<{ redirect: string }>('/new');
    if (typeof result === 'object' && 'redirect' in result) {
      const match = result.redirect.match(/\/([^/]+)$/);
      return match ? match[1] : result.redirect;
    }
    throw new HedgeDocAPIError('Failed to create note: no redirect received');
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
      const match = result.redirect.match(/\/([^/]+)$/);
      return match ? match[1] : alias;
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
   * Get the publish URL for a note
   * @param noteId Note ID or alias
   * @returns The published note URL
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
    
    const response = await fetch(url, { headers });
    
    if (!response.ok) {
      throw new HedgeDocAPIError(`Failed to download export: ${response.statusText}`, response.status);
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
   * Requires authentication via cookie and CSRF token (since HedgeDoc 1.10.4)
   */
  async deleteHistory(): Promise<void> {
    const token = await this.getCSRFToken();
    const url = token ? `/history?token=${encodeURIComponent(token)}` : '/history';
    
    await this.request(url, {
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
    await this.request(`/history/${encodeURIComponent(noteId)}`, {
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
