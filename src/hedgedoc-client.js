import { EventEmitter } from 'events';
import { io } from 'socket.io-client';
import { TextOperation } from './text-operation.js';
import { OTClient } from './ot-client.js';

/**
 * HedgeDocClient - Connect to a HedgeDoc server and sync documents in real-time
 * 
 * This is the main entry point for the hedgesync library. It provides:
 * - Connection management to HedgeDoc servers
 * - Real-time document synchronization using Operational Transformation
 * - High-level editing API (insert, delete, replace)
 * - Event emission for document changes
 * - Rate limiting, reconnection handling, and batch operations
 */
export class HedgeDocClient extends EventEmitter {
  /**
   * Create a new HedgeDoc client
   * @param {Object} options - Configuration options
   * @param {string} options.serverUrl - The HedgeDoc server URL (e.g., 'https://hedgedoc.example.com')
   * @param {string} options.noteId - The note ID or alias to connect to
   * @param {string} [options.cookie] - Optional session cookie for authentication
   * @param {number} [options.operationTimeout=5000] - Timeout for operations (ms)
   * @param {Object} [options.rateLimit] - Rate limiting options
   * @param {number} [options.rateLimit.minInterval=50] - Minimum ms between operations
   * @param {number} [options.rateLimit.maxBurst=10] - Max operations in burst
   * @param {number} [options.rateLimit.burstWindow=1000] - Burst window in ms
   * @param {Object} [options.reconnect] - Reconnection options
   * @param {boolean} [options.reconnect.enabled=true] - Enable auto-reconnection
   * @param {number} [options.reconnect.maxAttempts=10] - Max reconnection attempts
   * @param {number} [options.reconnect.initialDelay=1000] - Initial delay before reconnect (ms)
   * @param {number} [options.reconnect.maxDelay=30000] - Maximum delay between reconnects (ms)
   * @param {number} [options.reconnect.backoffFactor=2] - Exponential backoff multiplier
   */
  constructor(options = {}) {
    super();
    
    if (!options.serverUrl) {
      throw new Error('serverUrl is required');
    }
    if (!options.noteId) {
      throw new Error('noteId is required');
    }

    this.serverUrl = options.serverUrl.replace(/\/$/, ''); // Remove trailing slash
    this.noteId = options.noteId;
    this.cookie = options.cookie || null;
    
    this.socket = null;
    this.document = '';
    this.revision = 0;
    this.connected = false;
    this.ready = false;
    
    // OT client for handling operations
    this.otClient = null;
    
    // Note metadata
    this.noteInfo = {
      title: '',
      permission: '',
      owner: null,
      authors: {},
      createtime: null,
      updatetime: null
    };
    
    // Online users
    this.users = new Map();
    
    // Session cookie obtained from server
    this._sessionCookie = null;
    
    // Track if user is logged in (for permission checking)
    this._isLoggedIn = false;
    
    // Pending operation tracking for timeout detection
    this._pendingOperation = null;
    this._operationTimeout = null;
    this._operationTimeoutMs = options.operationTimeout || 5000;

    // ============================================
    // Rate Limiting
    // ============================================
    this._rateLimit = {
      minInterval: options.rateLimit?.minInterval ?? 50,
      maxBurst: options.rateLimit?.maxBurst ?? 10,
      burstWindow: options.rateLimit?.burstWindow ?? 1000,
      enabled: options.rateLimit?.enabled ?? true
    };
    this._lastOperationTime = 0;
    this._operationTimes = []; // Timestamps for burst detection
    this._operationQueue = []; // Queue for rate-limited operations
    this._processingQueue = false;

    // ============================================
    // Reconnection Handling
    // ============================================
    this._reconnect = {
      enabled: options.reconnect?.enabled ?? true,
      maxAttempts: options.reconnect?.maxAttempts ?? 10,
      initialDelay: options.reconnect?.initialDelay ?? 1000,
      maxDelay: options.reconnect?.maxDelay ?? 30000,
      backoffFactor: options.reconnect?.backoffFactor ?? 2
    };
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._intentionalDisconnect = false;
    this._pendingOperationsDuringDisconnect = [];

    // ============================================
    // Batch Operations
    // ============================================
    this._batchMode = false;
    this._batchOperations = [];

    // ============================================
    // Undo/Redo Stack
    // ============================================
    this._undoStack = [];
    this._redoStack = [];
    this._undoMaxSize = options.undoMaxSize ?? 100;
    this._trackUndo = options.trackUndo ?? true;
    this._lastUndoTimestamp = 0;
    this._undoGroupInterval = options.undoGroupInterval ?? 500; // Group rapid edits
  }

  /**
   * Check if the current user can edit the note based on permissions
   * @returns {boolean} True if the user can edit
   */
  canEdit() {
    const permission = this.noteInfo.permission;
    
    switch (permission) {
      case 'freely':
        // Anyone can edit
        return true;
      case 'editable':
      case 'limited':
        // Only logged-in users can edit
        return this._isLoggedIn;
      case 'locked':
      case 'private':
      case 'protected':
        // Only owner can edit - we can't easily check this without knowing our user ID
        // For safety, assume we can't edit unless logged in
        return this._isLoggedIn;
      default:
        // Unknown permission, be conservative
        return false;
    }
  }

  /**
   * Get a human-readable explanation of why editing is not allowed
   * @returns {string|null} Error message or null if editing is allowed
   */
  _getPermissionError() {
    const permission = this.noteInfo.permission;
    
    if (this.canEdit()) {
      return null;
    }
    
    switch (permission) {
      case 'editable':
      case 'limited':
        return `This note requires login to edit (permission: ${permission}). Please provide an authenticated session cookie.`;
      case 'locked':
      case 'private':
      case 'protected':
        return `This note can only be edited by its owner (permission: ${permission}).`;
      default:
        return `Cannot edit this note (permission: ${permission}).`;
    }
  }

  /**
   * Fetch a session cookie from the HedgeDoc server
   * HedgeDoc requires a valid session cookie even for anonymous access
   * @returns {Promise<string>} The session cookie
   */
  async _getSessionCookie() {
    if (this.cookie) {
      return this.cookie;
    }

    // Make a request to the note page to get a session cookie
    const response = await fetch(`${this.serverUrl}/${this.noteId}`, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'Accept': 'text/html'
      }
    });

    // Extract set-cookie header using getSetCookie (Node.js 18+)
    let cookies = [];
    if (response.headers.getSetCookie) {
      cookies = response.headers.getSetCookie();
    } else {
      // Fallback for older Node.js
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) {
        cookies = [setCookie];
      }
    }

    // Parse the cookies - we need the session cookie (usually 'connect.sid')
    const sessionCookies = [];
    for (const cookie of cookies) {
      // Get just the cookie name=value part (before any attributes like Path, HttpOnly)
      const cookiePart = cookie.split(';')[0];
      if (cookiePart) {
        sessionCookies.push(cookiePart);
      }
    }
    
    if (sessionCookies.length > 0) {
      this._sessionCookie = sessionCookies.join('; ');
      return this._sessionCookie;
    }

    throw new Error('Failed to obtain session cookie from server');
  }

  /**
   * Connect to the HedgeDoc server
   * @returns {Promise<void>} Resolves when connected and document is received
   */
  connect() {
    this._intentionalDisconnect = false;
    this._reconnectAttempts = 0;
    
    return new Promise(async (resolve, reject) => {
      try {
        await this._doConnect(resolve, reject);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Internal connection logic (supports reconnection)
   * @private
   */
  async _doConnect(resolve, reject) {
    try {
      // First, get a session cookie if we don't have one
      const cookie = await this._getSessionCookie();
      
      // Detect if we're running in Bun
      const isBun = typeof Bun !== 'undefined';
      
      const socketOptions = {
        query: {
          noteId: this.noteId
        },
        // Bun doesn't support XHR polling well, use websocket only
        // Node.js/browsers can use polling first for better auth handling
        transports: isBun ? ['websocket'] : ['polling', 'websocket'],
        withCredentials: true,
        extraHeaders: {
          Cookie: cookie
        },
        // Disable socket.io's built-in reconnection, we handle it ourselves
        reconnection: false
      };

      this.socket = io(this.serverUrl, socketOptions);

      // Connection events
      this.socket.on('connect', () => {
        this.connected = true;
        this._reconnectAttempts = 0; // Reset on successful connect
        this.emit('connect');
        
        // Replay any operations that were queued during disconnect
        if (this._pendingOperationsDuringDisconnect.length > 0) {
          this.emit('reconnect:replaying', this._pendingOperationsDuringDisconnect.length);
          // Operations will be resent when we receive 'doc' event
        }
      });

      this.socket.on('disconnect', (reason) => {
        const wasReady = this.ready;
        this.connected = false;
        this.ready = false;
        this.emit('disconnect', reason);
        
        // Handle reconnection
        if (!this._intentionalDisconnect && this._reconnect.enabled && wasReady) {
          this._scheduleReconnect();
        }
      });

      this.socket.on('connect_error', (error) => {
        if (!this.ready) {
          // Initial connection failed
          reject(error);
        }
        this.emit('error', error);
        
        // Try to reconnect if enabled
        if (!this._intentionalDisconnect && this._reconnect.enabled) {
          this._scheduleReconnect();
        }
      });

      // Document received - this is when we're fully initialized
      this.socket.on('doc', (data) => {
        this._handleDoc(data);
        // Request note info immediately to get permissions
        this.socket.emit('refresh');
        this.ready = true;
        
        if (resolve) {
          resolve();
          resolve = null; // Only resolve once
        }
        
        this.emit('ready', {
          document: this.document,
          revision: this.revision
        });
        
        // Clear any pending operations from disconnect
        this._pendingOperationsDuringDisconnect = [];
      });

      // Server info/error messages
      this.socket.on('info', (data) => {
        if (data.code === 403) {
          const error = new Error('Access forbidden');
          error.code = 403;
          if (reject) {
            reject(error);
            reject = null;
          }
          this.emit('error', error);
        } else if (data.code === 404) {
          const error = new Error('Note not found');
          error.code = 404;
          if (reject) {
            reject(error);
            reject = null;
          }
          this.emit('error', error);
        } else {
          this.emit('info', data);
        }
      });

      // Note metadata refresh
      this.socket.on('refresh', (data) => {
        this._handleRefresh(data);
      });

      // OT events
      this.socket.on('ack', (revision) => {
        this._handleAck(revision);
      });

      this.socket.on('operation', (clientId, revision, operation, selection) => {
        this._handleOperation(clientId, revision, operation, selection);
      });

      this.socket.on('operations', (head, operations) => {
        this._handleOperations(head, operations);
      });

      // User events
      this.socket.on('online users', (data) => {
        this._handleOnlineUsers(data);
      });

      this.socket.on('user status', (user) => {
        this._handleUserStatus(user);
      });

      this.socket.on('cursor focus', (user) => {
        this.emit('cursor:focus', user);
      });

      this.socket.on('cursor activity', (user) => {
        this.emit('cursor:activity', user);
      });

      this.socket.on('cursor blur', (data) => {
        this.emit('cursor:blur', data);
      });

      this.socket.on('client_left', (clientId) => {
        this.users.delete(clientId);
        this.emit('user:left', clientId);
      });

      // Permission changes
      this.socket.on('permission', (data) => {
        this.noteInfo.permission = data.permission;
        this.emit('permission', data.permission);
      });

      // Note deleted
      this.socket.on('delete', () => {
        this.emit('delete');
        this.disconnect();
      });

      // Version info
      this.socket.on('version', (data) => {
        this.emit('version', data);
      });
      
    } catch (error) {
      if (reject) reject(error);
      else throw error;
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   * @private
   */
  _scheduleReconnect() {
    if (this._reconnectTimer) {
      return; // Already scheduled
    }
    
    if (this._reconnectAttempts >= this._reconnect.maxAttempts) {
      this.emit('reconnect:failed', {
        attempts: this._reconnectAttempts,
        maxAttempts: this._reconnect.maxAttempts
      });
      return;
    }
    
    const delay = Math.min(
      this._reconnect.initialDelay * Math.pow(this._reconnect.backoffFactor, this._reconnectAttempts),
      this._reconnect.maxDelay
    );
    
    this._reconnectAttempts++;
    
    this.emit('reconnect:scheduled', {
      attempt: this._reconnectAttempts,
      maxAttempts: this._reconnect.maxAttempts,
      delay
    });
    
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      
      this.emit('reconnect:attempting', {
        attempt: this._reconnectAttempts,
        maxAttempts: this._reconnect.maxAttempts
      });
      
      try {
        // Clean up old socket
        if (this.socket) {
          this.socket.removeAllListeners();
          this.socket.disconnect();
          this.socket = null;
        }
        
        // Try to reconnect
        await this._doConnect(
          () => this.emit('reconnect:success', { attempts: this._reconnectAttempts }),
          (error) => {
            this.emit('reconnect:error', { error, attempt: this._reconnectAttempts });
            if (this._reconnect.enabled && !this._intentionalDisconnect) {
              this._scheduleReconnect();
            }
          }
        );
      } catch (error) {
        this.emit('reconnect:error', { error, attempt: this._reconnectAttempts });
        if (this._reconnect.enabled && !this._intentionalDisconnect) {
          this._scheduleReconnect();
        }
      }
    }, delay);
  }

  /**
   * Cancel any pending reconnection attempt
   * @private
   */
  _cancelReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  /**
   * Disconnect from the server
   * @param {boolean} [intentional=true] - Whether this is an intentional disconnect
   */
  disconnect(intentional = true) {
    this._intentionalDisconnect = intentional;
    this._cancelReconnect();
    
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.connected = false;
    this.ready = false;
  }

  /**
   * Get the current document content
   * @returns {string} The document content
   */
  getDocument() {
    return this.document;
  }

  /**
   * Get the current revision number
   * @returns {number} The revision number
   */
  getRevision() {
    return this.revision;
  }

  /**
   * Get note information
   * @returns {Object} Note metadata
   */
  getNoteInfo() {
    return { ...this.noteInfo };
  }

  /**
   * Get online users
   * @returns {Array} Array of online users
   */
  getOnlineUsers() {
    return Array.from(this.users.values());
  }

  /**
   * Get document content with authorship information
   * Returns the document along with information about who wrote each part.
   * 
   * @returns {Object} Object containing:
   *   - content: The full document text
   *   - authors: Object mapping userId to author profile (name, color, photo)
   *   - authorship: Array of authorship spans, each containing:
   *     - userId: The author's user ID (null for anonymous)
   *     - start: Start position in document
   *     - end: End position in document
   *     - text: The actual text in this span
   *     - author: The author's profile (name, color, photo) or null
   *     - createdAt: When this span was created
   *     - updatedAt: When this span was last modified
   */
  getDocumentWithAuthorship() {
    const content = this.document;
    const authors = this.noteInfo.authors || {};
    const rawAuthorship = this.noteInfo.authorship || [];
    
    // Transform authorship into a more useful format
    const authorship = rawAuthorship.map(([userId, start, end, createdAt, updatedAt]) => ({
      userId: userId || null,
      start,
      end,
      text: content.substring(start, end),
      author: userId ? (authors[userId] || null) : null,
      createdAt: createdAt ? new Date(createdAt) : null,
      updatedAt: updatedAt ? new Date(updatedAt) : null
    }));
    
    return {
      content,
      authors,
      authorship,
      // Helper: get text by author
      getTextByAuthor: (authorId) => {
        return authorship
          .filter(span => span.userId === authorId)
          .map(span => span.text)
          .join('');
      },
      // Helper: get author at position
      getAuthorAtPosition: (position) => {
        for (const span of authorship) {
          if (position >= span.start && position < span.end) {
            return span.author;
          }
        }
        return null;
      }
    };
  }

  /**
   * Get authors who have contributed to this document
   * @returns {Array} Array of author objects with userId, name, color, photo
   */
  getAuthors() {
    const authors = this.noteInfo.authors || {};
    return Object.entries(authors).map(([userId, profile]) => ({
      userId,
      name: profile.name || 'Anonymous',
      color: profile.color || '#888888',
      photo: profile.photo || null
    }));
  }

  /**
   * Insert text at a position
   * @param {number} position - Position to insert at
   * @param {string} text - Text to insert
   * @throws {Error} If client not ready, position invalid, or no write permission
   */
  insert(position, text) {
    if (!this.ready) {
      throw new Error('Client not ready. Wait for connection to complete.');
    }
    const permError = this._getPermissionError();
    if (permError) {
      throw new Error(permError);
    }
    if (position < 0 || position > this.document.length) {
      throw new Error('Position out of bounds');
    }
    
    const op = new TextOperation();
    if (position > 0) {
      op.retain(position);
    }
    op.insert(text);
    if (position < this.document.length) {
      op.retain(this.document.length - position);
    }
    
    this._applyClientOperation(op);
  }

  /**
   * Delete text at a position
   * @param {number} position - Start position
   * @param {number} length - Number of characters to delete
   * @throws {Error} If client not ready, position invalid, or no write permission
   */
  delete(position, length) {
    if (!this.ready) {
      throw new Error('Client not ready. Wait for connection to complete.');
    }
    const permError = this._getPermissionError();
    if (permError) {
      throw new Error(permError);
    }
    if (position < 0 || position + length > this.document.length) {
      throw new Error('Position out of bounds');
    }
    if (length <= 0) return;
    
    const op = new TextOperation();
    if (position > 0) {
      op.retain(position);
    }
    op.delete(length);
    if (position + length < this.document.length) {
      op.retain(this.document.length - position - length);
    }
    
    this._applyClientOperation(op);
  }

  /**
   * Replace text in a range
   * @param {number} position - Start position
   * @param {number} length - Number of characters to replace
   * @param {string} text - Replacement text
   * @throws {Error} If client not ready, position invalid, or no write permission
   */
  replace(position, length, text) {
    if (!this.ready) {
      throw new Error('Client not ready. Wait for connection to complete.');
    }
    const permError = this._getPermissionError();
    if (permError) {
      throw new Error(permError);
    }
    if (position < 0 || position + length > this.document.length) {
      throw new Error('Position out of bounds');
    }
    
    const op = new TextOperation();
    if (position > 0) {
      op.retain(position);
    }
    if (length > 0) {
      op.delete(length);
    }
    if (text) {
      op.insert(text);
    }
    if (position + length < this.document.length) {
      op.retain(this.document.length - position - length);
    }
    
    this._applyClientOperation(op);
  }

  /**
   * Set the entire document content
   * @param {string} content - New document content
   * @throws {Error} If client not ready or no write permission
   */
  setContent(content) {
    if (!this.ready) {
      throw new Error('Client not ready. Wait for connection to complete.');
    }
    const permError = this._getPermissionError();
    if (permError) {
      throw new Error(permError);
    }
    
    const op = new TextOperation();
    if (this.document.length > 0) {
      op.delete(this.document.length);
    }
    if (content) {
      op.insert(content);
    }
    
    this._applyClientOperation(op);
  }

  /**
   * Apply a raw TextOperation
   * @param {TextOperation} operation - The operation to apply
   * @throws {Error} If client not ready or no write permission
   */
  applyOperation(operation) {
    if (!this.ready) {
      throw new Error('Client not ready. Wait for connection to complete.');
    }
    const permError = this._getPermissionError();
    if (permError) {
      throw new Error(permError);
    }
    this._applyClientOperation(operation);
  }

  // ============================================
  // Advanced Editing Methods
  // ============================================

  /**
   * Replace all matches of a pattern with a replacement string
   * @param {RegExp|string} pattern - Pattern to match (string or RegExp)
   * @param {string|Function} replacement - Replacement string or function
   * @returns {number} Number of replacements made
   * @throws {Error} If client not ready or no write permission
   */
  replaceRegex(pattern, replacement) {
    if (!this.ready) {
      throw new Error('Client not ready. Wait for connection to complete.');
    }
    const permError = this._getPermissionError();
    if (permError) {
      throw new Error(permError);
    }

    const doc = this.document;
    const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'g');
    
    // Ensure global flag for counting all matches
    const globalRegex = regex.global ? regex : new RegExp(regex.source, regex.flags + 'g');
    
    // Find all matches with their positions
    const matches = [];
    let match;
    while ((match = globalRegex.exec(doc)) !== null) {
      matches.push({
        index: match.index,
        length: match[0].length,
        match: match[0],
        groups: match.slice(1)
      });
    }
    
    if (matches.length === 0) {
      return 0;
    }

    // Apply replacements from end to start to preserve positions
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      let replaceText;
      
      if (typeof replacement === 'function') {
        replaceText = replacement(m.match, ...m.groups, m.index, doc);
      } else {
        // Handle $1, $2, etc. in replacement string
        replaceText = replacement.replace(/\$(\d+)/g, (_, n) => m.groups[n - 1] || '');
        replaceText = replaceText.replace(/\$&/g, m.match);
      }
      
      this.replace(m.index, m.length, replaceText);
    }
    
    return matches.length;
  }

  /**
   * Replace the first match of a pattern
   * @param {RegExp|string} pattern - Pattern to match
   * @param {string|Function} replacement - Replacement string or function
   * @returns {boolean} True if a replacement was made
   */
  replaceFirst(pattern, replacement) {
    if (!this.ready) {
      throw new Error('Client not ready. Wait for connection to complete.');
    }
    const permError = this._getPermissionError();
    if (permError) {
      throw new Error(permError);
    }

    const doc = this.document;
    const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    const match = doc.match(regex);
    
    if (!match) {
      return false;
    }
    
    let replaceText;
    if (typeof replacement === 'function') {
      replaceText = replacement(match[0], ...match.slice(1), match.index, doc);
    } else {
      replaceText = replacement.replace(/\$(\d+)/g, (_, n) => match[n] || '');
      replaceText = replaceText.replace(/\$&/g, match[0]);
    }
    
    this.replace(match.index, match[0].length, replaceText);
    return true;
  }

  // ============================================
  // Line-based Operations
  // ============================================

  /**
   * Get the document split into lines
   * @returns {string[]} Array of lines (without line endings)
   */
  getLines() {
    return this.document.split('\n');
  }

  /**
   * Get a specific line (0-indexed)
   * @param {number} lineNum - Line number (0-indexed)
   * @returns {string|null} Line content or null if out of bounds
   */
  getLine(lineNum) {
    const lines = this.getLines();
    if (lineNum < 0 || lineNum >= lines.length) {
      return null;
    }
    return lines[lineNum];
  }

  /**
   * Get the number of lines in the document
   * @returns {number} Number of lines
   */
  getLineCount() {
    return this.getLines().length;
  }

  /**
   * Get the character position where a line starts
   * @param {number} lineNum - Line number (0-indexed)
   * @returns {number} Character position, or -1 if out of bounds
   */
  getLineStart(lineNum) {
    if (lineNum < 0) return -1;
    const lines = this.getLines();
    if (lineNum >= lines.length) return -1;
    
    let pos = 0;
    for (let i = 0; i < lineNum; i++) {
      pos += lines[i].length + 1; // +1 for newline
    }
    return pos;
  }

  /**
   * Get the character position where a line ends (before newline)
   * @param {number} lineNum - Line number (0-indexed)
   * @returns {number} Character position, or -1 if out of bounds
   */
  getLineEnd(lineNum) {
    const start = this.getLineStart(lineNum);
    if (start === -1) return -1;
    const line = this.getLine(lineNum);
    return start + line.length;
  }

  /**
   * Replace the content of a specific line
   * @param {number} lineNum - Line number (0-indexed)
   * @param {string} content - New line content (without newline)
   * @throws {Error} If line number out of bounds
   */
  setLine(lineNum, content) {
    const start = this.getLineStart(lineNum);
    if (start === -1) {
      throw new Error(`Line ${lineNum} out of bounds`);
    }
    const oldLine = this.getLine(lineNum);
    this.replace(start, oldLine.length, content);
  }

  /**
   * Insert a new line at the specified position
   * @param {number} lineNum - Line number to insert at (0-indexed)
   * @param {string} content - Line content (without newline)
   */
  insertLine(lineNum, content) {
    if (!this.ready) {
      throw new Error('Client not ready. Wait for connection to complete.');
    }
    const permError = this._getPermissionError();
    if (permError) {
      throw new Error(permError);
    }

    const lines = this.getLines();
    
    if (lineNum <= 0) {
      // Insert at beginning
      this.insert(0, content + '\n');
    } else if (lineNum >= lines.length) {
      // Insert at end
      this.insert(this.document.length, '\n' + content);
    } else {
      // Insert in middle
      const pos = this.getLineStart(lineNum);
      this.insert(pos, content + '\n');
    }
  }

  /**
   * Delete a specific line
   * @param {number} lineNum - Line number to delete (0-indexed)
   * @throws {Error} If line number out of bounds
   */
  deleteLine(lineNum) {
    if (!this.ready) {
      throw new Error('Client not ready. Wait for connection to complete.');
    }
    const permError = this._getPermissionError();
    if (permError) {
      throw new Error(permError);
    }

    const lines = this.getLines();
    if (lineNum < 0 || lineNum >= lines.length) {
      throw new Error(`Line ${lineNum} out of bounds`);
    }
    
    const start = this.getLineStart(lineNum);
    const line = lines[lineNum];
    
    if (lines.length === 1) {
      // Only line - just clear it
      this.delete(0, line.length);
    } else if (lineNum === lines.length - 1) {
      // Last line - delete including preceding newline
      this.delete(start - 1, line.length + 1);
    } else {
      // Middle or first line - delete including trailing newline
      this.delete(start, line.length + 1);
    }
  }

  /**
   * Replace lines matching a pattern
   * @param {RegExp|string} pattern - Pattern to match against line content
   * @param {string|Function} replacement - Replacement string or function(line, lineNum, match)
   * @returns {number} Number of lines replaced
   */
  replaceLines(pattern, replacement) {
    if (!this.ready) {
      throw new Error('Client not ready. Wait for connection to complete.');
    }
    const permError = this._getPermissionError();
    if (permError) {
      throw new Error(permError);
    }

    const lines = this.getLines();
    const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    let count = 0;
    
    // Process from end to start to preserve line numbers
    for (let i = lines.length - 1; i >= 0; i--) {
      const match = lines[i].match(regex);
      if (match) {
        let newContent;
        if (typeof replacement === 'function') {
          newContent = replacement(lines[i], i, match);
        } else {
          newContent = lines[i].replace(regex, replacement);
        }
        this.setLine(i, newContent);
        count++;
      }
    }
    
    return count;
  }

  // ============================================
  // Smart Update Methods
  // ============================================

  /**
   * Update document content using minimal diff operations
   * More efficient than setContent for small changes
   * @param {string} newContent - New document content
   * @returns {number} Number of operations applied
   */
  updateContent(newContent) {
    if (!this.ready) {
      throw new Error('Client not ready. Wait for connection to complete.');
    }
    const permError = this._getPermissionError();
    if (permError) {
      throw new Error(permError);
    }

    const oldContent = this.document;
    if (oldContent === newContent) {
      return 0;
    }

    // Simple diff: find common prefix and suffix
    let prefixLen = 0;
    const minLen = Math.min(oldContent.length, newContent.length);
    
    while (prefixLen < minLen && oldContent[prefixLen] === newContent[prefixLen]) {
      prefixLen++;
    }
    
    let suffixLen = 0;
    while (
      suffixLen < minLen - prefixLen &&
      oldContent[oldContent.length - 1 - suffixLen] === newContent[newContent.length - 1 - suffixLen]
    ) {
      suffixLen++;
    }
    
    const deleteLen = oldContent.length - prefixLen - suffixLen;
    const insertText = newContent.slice(prefixLen, newContent.length - suffixLen);
    
    if (deleteLen > 0 || insertText.length > 0) {
      this.replace(prefixLen, deleteLen, insertText);
      return 1;
    }
    
    return 0;
  }

  /**
   * Request a refresh of note metadata
   */
  refresh() {
    if (this.socket && this.connected) {
      this.socket.emit('refresh');
    }
  }

  /**
   * Request online users
   */
  requestOnlineUsers() {
    if (this.socket && this.connected) {
      this.socket.emit('online users');
    }
  }

  /**
   * Request version info
   */
  requestVersion() {
    if (this.socket && this.connected) {
      this.socket.emit('version');
    }
  }

  // ============================================
  // Rate Limiting Control
  // ============================================

  /**
   * Enable or disable rate limiting
   * @param {boolean} enabled
   */
  setRateLimitEnabled(enabled) {
    this._rateLimit.enabled = enabled;
  }

  /**
   * Check if rate limiting is enabled
   * @returns {boolean}
   */
  isRateLimitEnabled() {
    return this._rateLimit.enabled;
  }

  /**
   * Configure rate limiting
   * @param {Object} options
   * @param {number} [options.minInterval] - Minimum ms between operations
   * @param {number} [options.maxBurst] - Max operations in burst window
   * @param {number} [options.burstWindow] - Burst window in ms
   */
  configureRateLimit(options) {
    if (options.minInterval !== undefined) {
      this._rateLimit.minInterval = options.minInterval;
    }
    if (options.maxBurst !== undefined) {
      this._rateLimit.maxBurst = options.maxBurst;
    }
    if (options.burstWindow !== undefined) {
      this._rateLimit.burstWindow = options.burstWindow;
    }
  }

  /**
   * Get the current rate limit configuration
   * @returns {Object}
   */
  getRateLimitConfig() {
    return { ...this._rateLimit };
  }

  /**
   * Get the number of operations currently queued
   * @returns {number}
   */
  getQueuedOperationCount() {
    return this._operationQueue.length;
  }

  // ============================================
  // Reconnection Control
  // ============================================

  /**
   * Enable or disable auto-reconnection
   * @param {boolean} enabled
   */
  setReconnectEnabled(enabled) {
    this._reconnect.enabled = enabled;
    if (!enabled) {
      this._cancelReconnect();
    }
  }

  /**
   * Check if auto-reconnection is enabled
   * @returns {boolean}
   */
  isReconnectEnabled() {
    return this._reconnect.enabled;
  }

  /**
   * Configure reconnection
   * @param {Object} options
   * @param {number} [options.maxAttempts] - Maximum reconnection attempts
   * @param {number} [options.initialDelay] - Initial delay in ms
   * @param {number} [options.maxDelay] - Maximum delay in ms
   * @param {number} [options.backoffFactor] - Backoff multiplier
   */
  configureReconnect(options) {
    if (options.maxAttempts !== undefined) {
      this._reconnect.maxAttempts = options.maxAttempts;
    }
    if (options.initialDelay !== undefined) {
      this._reconnect.initialDelay = options.initialDelay;
    }
    if (options.maxDelay !== undefined) {
      this._reconnect.maxDelay = options.maxDelay;
    }
    if (options.backoffFactor !== undefined) {
      this._reconnect.backoffFactor = options.backoffFactor;
    }
  }

  /**
   * Get the current reconnection configuration
   * @returns {Object}
   */
  getReconnectConfig() {
    return {
      ...this._reconnect,
      attempts: this._reconnectAttempts,
      scheduled: this._reconnectTimer !== null
    };
  }

  /**
   * Manually trigger a reconnection
   * @returns {Promise<void>}
   */
  async reconnect() {
    this._intentionalDisconnect = false;
    this._reconnectAttempts = 0;
    
    // Disconnect first if connected
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    
    return this.connect();
  }

  // Private methods

  _handleDoc(data) {
    this.document = data.str || '';
    this.revision = data.revision || 0;
    
    // Initialize OT client
    this.otClient = new OTClientImpl(this, this.revision);
    
    // Process existing clients
    if (data.clients) {
      for (const [id, user] of Object.entries(data.clients)) {
        this.users.set(id, user);
      }
    }
    
    // If force refresh, emit document change
    if (data.force) {
      this.emit('document', this.document);
    }
  }

  _handleRefresh(data) {
    this.noteInfo = {
      title: data.title || '',
      permission: data.permission || '',
      owner: data.owner || null,
      ownerprofile: data.ownerprofile || null,
      lastchangeuser: data.lastchangeuser || null,
      lastchangeuserprofile: data.lastchangeuserprofile || null,
      authors: data.authors || {},
      authorship: data.authorship || [],
      createtime: data.createtime || null,
      updatetime: data.updatetime || null,
      docmaxlength: data.docmaxlength || null
    };
    this.emit('refresh', this.noteInfo);
  }

  _handleAck(revision) {
    if (this.otClient) {
      this.otClient.serverAck(revision);
    }
  }

  _handleOperation(clientId, revision, operation, selection) {
    if (this.otClient) {
      const op = TextOperation.fromJSON(operation);
      this.otClient.applyServer(revision, op);
    }
  }

  _handleOperations(head, operations) {
    if (this.otClient) {
      this.otClient.applyOperations(head, operations);
    }
  }

  _handleOnlineUsers(data) {
    this.users.clear();
    if (data.users) {
      for (const user of data.users) {
        this.users.set(user.id, user);
      }
    }
    this.emit('users', this.getOnlineUsers());
  }

  _handleUserStatus(user) {
    if (user && user.id) {
      this.users.set(user.id, user);
      this.emit('user:status', user);
    }
  }

  // ============================================
  // Rate Limiting
  // ============================================

  /**
   * Check if we're within rate limits
   * @returns {boolean} True if operation can proceed
   * @private
   */
  _checkRateLimit() {
    if (!this._rateLimit.enabled) {
      return true;
    }
    
    const now = Date.now();
    
    // Check minimum interval
    if (now - this._lastOperationTime < this._rateLimit.minInterval) {
      return false;
    }
    
    // Check burst limit
    const windowStart = now - this._rateLimit.burstWindow;
    this._operationTimes = this._operationTimes.filter(t => t > windowStart);
    
    if (this._operationTimes.length >= this._rateLimit.maxBurst) {
      return false;
    }
    
    return true;
  }

  /**
   * Record an operation for rate limiting
   * @private
   */
  _recordOperation() {
    const now = Date.now();
    this._lastOperationTime = now;
    this._operationTimes.push(now);
  }

  /**
   * Process the operation queue
   * @private
   */
  async _processOperationQueue() {
    if (this._processingQueue || this._operationQueue.length === 0) {
      return;
    }
    
    this._processingQueue = true;
    
    while (this._operationQueue.length > 0) {
      if (!this._checkRateLimit()) {
        // Wait until we can send
        const waitTime = this._rateLimit.minInterval - (Date.now() - this._lastOperationTime);
        await new Promise(resolve => setTimeout(resolve, Math.max(waitTime, 10)));
        continue;
      }
      
      const operation = this._operationQueue.shift();
      
      // Verify the operation is still valid for the current document
      if (operation.baseLength !== this.document.length) {
        // Operation is stale - skip it
        // This can happen if remote operations came in while this was queued
        console.error(`Skipping stale operation: baseLength ${operation.baseLength} != doc length ${this.document.length}`);
        continue;
      }
      
      this._executeOperation(operation);
    }
    
    this._processingQueue = false;
  }

  /**
   * Execute an operation immediately
   * @private
   */
  _executeOperation(operation) {
    // Apply locally
    const oldDocument = this.document;
    this.document = operation.apply(this.document);
    
    // Track for undo
    if (this._trackUndo) {
      this._pushUndo(operation, oldDocument);
    }
    
    // Record for rate limiting
    this._recordOperation();
    
    // Send to server via OT client
    if (this.otClient) {
      this.otClient.applyClient(operation);
    }
    
    this.emit('document', this.document);
    this.emit('change', { type: 'local', operation });
  }

  _applyClientOperation(operation) {
    // If in batch mode, queue the operation
    if (this._batchMode) {
      this._batchOperations.push(operation);
      return;
    }
    
    // If rate limiting is enabled and we're over limit, queue it
    if (this._rateLimit.enabled && !this._checkRateLimit()) {
      this._operationQueue.push(operation);
      this._processOperationQueue();
      return;
    }
    
    // Execute immediately
    this._executeOperation(operation);
  }

  // ============================================
  // Batch Operations
  // ============================================

  /**
   * Start a batch of operations that will be applied together
   * Operations made during batch mode are queued and combined
   * @returns {HedgeDocClient} this for chaining
   */
  startBatch() {
    this._batchMode = true;
    this._batchOperations = [];
    return this;
  }

  /**
   * End the batch and apply all queued operations as one
   * @returns {TextOperation|null} The combined operation, or null if empty
   */
  endBatch() {
    this._batchMode = false;
    
    if (this._batchOperations.length === 0) {
      return null;
    }
    
    // Compose all operations into one
    let combined = this._batchOperations[0];
    for (let i = 1; i < this._batchOperations.length; i++) {
      combined = combined.compose(this._batchOperations[i]);
    }
    
    this._batchOperations = [];
    
    // Apply the combined operation
    this._executeOperation(combined);
    
    return combined;
  }

  /**
   * Discard the current batch without applying
   */
  cancelBatch() {
    this._batchMode = false;
    this._batchOperations = [];
  }

  /**
   * Check if currently in batch mode
   * @returns {boolean}
   */
  isBatchMode() {
    return this._batchMode;
  }

  /**
   * Execute a function within a batch
   * @param {Function} fn - Function to execute
   * @returns {TextOperation|null} The combined operation
   */
  batch(fn) {
    this.startBatch();
    try {
      fn();
      return this.endBatch();
    } catch (error) {
      this.cancelBatch();
      throw error;
    }
  }

  // ============================================
  // Undo/Redo
  // ============================================

  /**
   * Push an operation to the undo stack
   * @private
   */
  _pushUndo(operation, oldDocument) {
    const now = Date.now();
    
    // Group rapid edits together
    if (this._undoStack.length > 0 && 
        now - this._lastUndoTimestamp < this._undoGroupInterval) {
      // Compose with the last entry
      const last = this._undoStack[this._undoStack.length - 1];
      last.operation = last.operation.compose(operation);
      last.newDocument = this.document;
    } else {
      // Create new undo entry
      this._undoStack.push({
        operation: operation,
        oldDocument: oldDocument,
        newDocument: this.document,
        timestamp: now
      });
      
      // Trim stack if too large
      while (this._undoStack.length > this._undoMaxSize) {
        this._undoStack.shift();
      }
    }
    
    this._lastUndoTimestamp = now;
    
    // Clear redo stack on new edit
    this._redoStack = [];
  }

  /**
   * Check if undo is available
   * @returns {boolean}
   */
  canUndo() {
    return this._trackUndo && this._undoStack.length > 0;
  }

  /**
   * Check if redo is available
   * @returns {boolean}
   */
  canRedo() {
    return this._trackUndo && this._redoStack.length > 0;
  }

  /**
   * Undo the last operation
   * @returns {boolean} True if undo was performed
   */
  undo() {
    if (!this.canUndo()) {
      return false;
    }
    
    const entry = this._undoStack.pop();
    
    // We need to revert to oldDocument
    // Create an operation that does this
    this._trackUndo = false; // Temporarily disable to avoid recursion
    try {
      this.updateContent(entry.oldDocument);
      
      // Push to redo stack
      this._redoStack.push({
        operation: entry.operation,
        oldDocument: entry.oldDocument,
        newDocument: entry.newDocument,
        timestamp: Date.now()
      });
      
      this.emit('undo', entry);
    } finally {
      this._trackUndo = true;
    }
    
    return true;
  }

  /**
   * Redo the last undone operation
   * @returns {boolean} True if redo was performed
   */
  redo() {
    if (!this.canRedo()) {
      return false;
    }
    
    const entry = this._redoStack.pop();
    
    // Apply the operation to get to newDocument
    this._trackUndo = false;
    try {
      this.updateContent(entry.newDocument);
      
      // Push back to undo stack
      this._undoStack.push({
        operation: entry.operation,
        oldDocument: entry.oldDocument,
        newDocument: entry.newDocument,
        timestamp: Date.now()
      });
      
      this.emit('redo', entry);
    } finally {
      this._trackUndo = true;
    }
    
    return true;
  }

  /**
   * Clear the undo/redo history
   */
  clearHistory() {
    this._undoStack = [];
    this._redoStack = [];
  }

  /**
   * Get the undo stack size
   * @returns {number}
   */
  getUndoStackSize() {
    return this._undoStack.length;
  }

  /**
   * Get the redo stack size
   * @returns {number}
   */
  getRedoStackSize() {
    return this._redoStack.length;
  }
}

/**
 * Internal OT client implementation that bridges to socket
 */
class OTClientImpl extends OTClient {
  constructor(hedgeDocClient, revision) {
    super(revision);
    this.hedgeDocClient = hedgeDocClient;
  }

  sendOperation(revision, operation) {
    if (this.hedgeDocClient.socket && this.hedgeDocClient.connected) {
      this.hedgeDocClient.socket.emit('operation', revision, operation.toJSON(), null);
    }
  }

  applyOperation(operation) {
    // Apply the server's operation to our document
    this.hedgeDocClient.document = operation.apply(this.hedgeDocClient.document);
    
    // Transform any queued operations against this server operation
    // This is critical - queued operations were created against the old document state
    if (this.hedgeDocClient._operationQueue && this.hedgeDocClient._operationQueue.length > 0) {
      const transformedQueue = [];
      let serverOp = operation;
      
      for (const queuedOp of this.hedgeDocClient._operationQueue) {
        try {
          // Transform the queued operation against the server operation
          const [transformedQueued, transformedServer] = TextOperation.transform(queuedOp, serverOp);
          transformedQueue.push(transformedQueued);
          serverOp = transformedServer;
        } catch (err) {
          // If transformation fails, skip this operation
          console.error('Failed to transform queued operation:', err.message);
        }
      }
      
      this.hedgeDocClient._operationQueue = transformedQueue;
    }
    
    this.hedgeDocClient.emit('document', this.hedgeDocClient.document);
    this.hedgeDocClient.emit('change', { type: 'remote', operation });
  }

  getOperations(base, head) {
    if (this.hedgeDocClient.socket && this.hedgeDocClient.connected) {
      this.hedgeDocClient.socket.emit('get_operations', base, head);
    }
  }
}
