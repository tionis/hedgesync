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
