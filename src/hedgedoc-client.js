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
 */
export class HedgeDocClient extends EventEmitter {
  /**
   * Create a new HedgeDoc client
   * @param {Object} options - Configuration options
   * @param {string} options.serverUrl - The HedgeDoc server URL (e.g., 'https://hedgedoc.example.com')
   * @param {string} options.noteId - The note ID or alias to connect to
   * @param {string} [options.cookie] - Optional session cookie for authentication
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
    return new Promise(async (resolve, reject) => {
      try {
        // First, get a session cookie if we don't have one
        const cookie = await this._getSessionCookie();
        
        const socketOptions = {
          query: {
            noteId: this.noteId
          },
          // Use polling first - it handles custom headers better for auth
          transports: ['polling', 'websocket'],
          withCredentials: true,
          extraHeaders: {
            Cookie: cookie
          }
        };

        this.socket = io(this.serverUrl, socketOptions);

      // Connection events
      this.socket.on('connect', () => {
        this.connected = true;
        this.emit('connect');
      });

      this.socket.on('disconnect', (reason) => {
        this.connected = false;
        this.ready = false;
        this.emit('disconnect', reason);
      });

      this.socket.on('connect_error', (error) => {
        reject(error);
        this.emit('error', error);
      });

      // Document received - this is when we're fully initialized
      this.socket.on('doc', (data) => {
        this._handleDoc(data);
        // Request note info immediately to get permissions
        this.socket.emit('refresh');
        this.ready = true;
        resolve();
        this.emit('ready', {
          document: this.document,
          revision: this.revision
        });
      });

      // Server info/error messages
      this.socket.on('info', (data) => {
        if (data.code === 403) {
          const error = new Error('Access forbidden');
          error.code = 403;
          reject(error);
          this.emit('error', error);
        } else if (data.code === 404) {
          const error = new Error('Note not found');
          error.code = 404;
          reject(error);
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
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the server
   */
  disconnect() {
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

  _applyClientOperation(operation) {
    // Apply locally
    this.document = operation.apply(this.document);
    
    // Send to server via OT client
    if (this.otClient) {
      this.otClient.applyClient(operation);
    }
    
    this.emit('document', this.document);
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
    this.hedgeDocClient.emit('document', this.hedgeDocClient.document);
  }

  getOperations(base, head) {
    if (this.hedgeDocClient.socket && this.hedgeDocClient.connected) {
      this.hedgeDocClient.socket.emit('get_operations', base, head);
    }
  }
}
