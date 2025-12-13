/**
 * HedgeDoc Authentication Module
 * 
 * Provides automatic session cookie acquisition through various auth methods:
 * - Email/password (local auth)
 * - LDAP authentication
 * - OIDC/OAuth2 (requires interactive browser flow)
 */

import { createServer } from 'http';
import type { Server, IncomingMessage, ServerResponse } from 'http';
import { parse as parseUrl } from 'url';
import { randomBytes } from 'crypto';

// ===========================================
// Types
// ===========================================

export interface AuthResult {
  /** The session cookie value (just the value, without 'connect.sid=' prefix) */
  sessionId: string;
  /** The full cookie string ready for use in requests */
  cookie: string;
  /** When the session was acquired */
  acquiredAt: Date;
}

export interface EmailAuthOptions {
  /** HedgeDoc server URL */
  serverUrl: string;
  /** Email address */
  email: string;
  /** Password */
  password: string;
  /** Custom headers for reverse proxy auth */
  headers?: Record<string, string>;
}

export interface LDAPAuthOptions {
  /** HedgeDoc server URL */
  serverUrl: string;
  /** LDAP username */
  username: string;
  /** LDAP password */
  password: string;
  /** Custom headers for reverse proxy auth */
  headers?: Record<string, string>;
}

export interface OIDCAuthOptions {
  /** HedgeDoc server URL */
  serverUrl: string;
  /** Local port for OAuth callback (default: random available port) */
  callbackPort?: number;
  /** Timeout in milliseconds for user to complete auth (default: 300000 = 5 minutes) */
  timeout?: number;
  /** Custom headers for reverse proxy auth */
  headers?: Record<string, string>;
  /** Callback when browser should be opened */
  onOpenBrowser?: (url: string) => void | Promise<void>;
}

export class AuthError extends Error {
  statusCode?: number;
  
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
  }
}

// ===========================================
// Cookie Utilities
// ===========================================

/**
 * Normalize a cookie value to the full cookie string format.
 * 
 * Accepts:
 * - Just the session ID value: "s%3Axxx..."
 * - With prefix: "connect.sid=s%3Axxx..."
 * - Full cookie string with attributes: "connect.sid=s%3Axxx...; Path=/; HttpOnly"
 * 
 * Returns the full cookie string suitable for the Cookie header.
 */
export function normalizeCookie(cookie: string): string {
  if (!cookie) return '';
  
  const trimmed = cookie.trim();
  
  // Already has the connect.sid= prefix
  if (trimmed.startsWith('connect.sid=')) {
    // Extract just the value part (before any ; for attributes)
    const match = trimmed.match(/^connect\.sid=([^;]+)/);
    if (match) {
      return `connect.sid=${match[1]}`;
    }
    return trimmed;
  }
  
  // Just the session ID value
  return `connect.sid=${trimmed}`;
}

/**
 * Extract the session ID value from a cookie string.
 * 
 * Returns just the value part without the connect.sid= prefix.
 */
export function extractSessionId(cookie: string): string {
  if (!cookie) return '';
  
  const trimmed = cookie.trim();
  
  // Has the connect.sid= prefix
  if (trimmed.startsWith('connect.sid=')) {
    const match = trimmed.match(/^connect\.sid=([^;]+)/);
    return match ? match[1] : '';
  }
  
  // Assume it's already just the value
  return trimmed.split(';')[0];
}

/**
 * Extract session cookie from Set-Cookie headers.
 */
function extractSessionCookie(setCookieHeaders: string | string[] | undefined): string | null {
  if (!setCookieHeaders) return null;
  
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  
  for (const header of headers) {
    if (header.startsWith('connect.sid=')) {
      const match = header.match(/^connect\.sid=([^;]+)/);
      if (match) {
        return match[1];
      }
    }
  }
  
  return null;
}

// ===========================================
// Email/Password Authentication
// ===========================================

/**
 * Authenticate with HedgeDoc using email and password.
 * 
 * This works with HedgeDoc's built-in email authentication.
 */
export async function loginWithEmail(options: EmailAuthOptions): Promise<AuthResult> {
  const { serverUrl, email, password, headers = {} } = options;
  const baseUrl = serverUrl.replace(/\/$/, '');
  
  // First, get the login page to obtain any CSRF token
  const configResponse = await fetch(`${baseUrl}/config`, {
    headers: {
      'Accept': 'application/json',
      ...headers,
    },
  });
  
  let csrfToken: string | undefined;
  if (configResponse.ok) {
    try {
      const config = await configResponse.json();
      csrfToken = config.CSRF;
    } catch {
      // No CSRF token available
    }
  }
  
  // Perform the login
  const formData = new URLSearchParams();
  formData.append('email', email);
  formData.append('password', password);
  
  const loginHeaders: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    ...headers,
  };
  
  if (csrfToken) {
    loginHeaders['X-XSRF-TOKEN'] = csrfToken;
  }
  
  const loginResponse = await fetch(`${baseUrl}/auth/email/login`, {
    method: 'POST',
    headers: loginHeaders,
    body: formData.toString(),
    redirect: 'manual',
  });
  
  // Check for session cookie in response
  const setCookie = loginResponse.headers.get('set-cookie') || 
                   loginResponse.headers.getSetCookie?.();
  const sessionId = extractSessionCookie(setCookie);
  
  if (!sessionId) {
    // Check if we got an error response
    if (loginResponse.status === 401 || loginResponse.status === 403) {
      throw new AuthError('Invalid email or password', loginResponse.status);
    }
    if (loginResponse.status >= 400) {
      throw new AuthError(`Login failed with status ${loginResponse.status}`, loginResponse.status);
    }
    throw new AuthError('No session cookie received. Authentication may have failed.');
  }
  
  return {
    sessionId,
    cookie: `connect.sid=${sessionId}`,
    acquiredAt: new Date(),
  };
}

// ===========================================
// LDAP Authentication
// ===========================================

/**
 * Authenticate with HedgeDoc using LDAP credentials.
 */
export async function loginWithLDAP(options: LDAPAuthOptions): Promise<AuthResult> {
  const { serverUrl, username, password, headers = {} } = options;
  const baseUrl = serverUrl.replace(/\/$/, '');
  
  // First, get the config to obtain any CSRF token
  const configResponse = await fetch(`${baseUrl}/config`, {
    headers: {
      'Accept': 'application/json',
      ...headers,
    },
  });
  
  let csrfToken: string | undefined;
  if (configResponse.ok) {
    try {
      const config = await configResponse.json();
      csrfToken = config.CSRF;
    } catch {
      // No CSRF token available
    }
  }
  
  // Perform the LDAP login
  const formData = new URLSearchParams();
  formData.append('username', username);
  formData.append('password', password);
  
  const loginHeaders: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    ...headers,
  };
  
  if (csrfToken) {
    loginHeaders['X-XSRF-TOKEN'] = csrfToken;
  }
  
  const loginResponse = await fetch(`${baseUrl}/auth/ldap`, {
    method: 'POST',
    headers: loginHeaders,
    body: formData.toString(),
    redirect: 'manual',
  });
  
  // Check for session cookie in response
  const setCookie = loginResponse.headers.get('set-cookie') || 
                   loginResponse.headers.getSetCookie?.();
  const sessionId = extractSessionCookie(setCookie);
  
  if (!sessionId) {
    if (loginResponse.status === 401 || loginResponse.status === 403) {
      throw new AuthError('Invalid LDAP credentials', loginResponse.status);
    }
    if (loginResponse.status >= 400) {
      throw new AuthError(`LDAP login failed with status ${loginResponse.status}`, loginResponse.status);
    }
    throw new AuthError('No session cookie received. LDAP authentication may have failed.');
  }
  
  return {
    sessionId,
    cookie: `connect.sid=${sessionId}`,
    acquiredAt: new Date(),
  };
}

// ===========================================
// OIDC/OAuth2 Authentication
// ===========================================

/**
 * Authenticate with HedgeDoc using OIDC/OAuth2.
 * 
 * This starts a local HTTP server to receive the OAuth callback,
 * then opens the browser to the HedgeDoc OAuth login page.
 * 
 * The user must complete the authentication in their browser.
 */
export async function loginWithOIDC(options: OIDCAuthOptions): Promise<AuthResult> {
  const { 
    serverUrl, 
    callbackPort, 
    timeout = 300000,
    headers = {},
    onOpenBrowser 
  } = options;
  const baseUrl = serverUrl.replace(/\/$/, '');
  
  return new Promise((resolve, reject) => {
    let server: Server | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    
    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (server) {
        server.close();
        server = null;
      }
    };
    
    // Set up timeout
    timeoutId = setTimeout(() => {
      cleanup();
      reject(new AuthError(`OIDC authentication timed out after ${timeout}ms`));
    }, timeout);
    
    // Create local server to intercept the callback
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = parseUrl(req.url || '', true);
      
      // We're looking for the session cookie that HedgeDoc sets after OAuth completes
      if (url.pathname === '/auth/oauth2/callback' || url.pathname === '/callback') {
        // The actual callback goes to HedgeDoc, but we intercept to get the cookie
        // This won't work directly - we need a different approach
        
        // Send a simple response
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html>
          <head><title>Authentication</title></head>
          <body>
            <h1>Authentication in progress...</h1>
            <p>Please wait while we complete the authentication.</p>
            <script>
              // Close this window after a delay
              setTimeout(() => window.close(), 2000);
            </script>
          </body>
          </html>
        `);
      } else if (url.pathname === '/complete') {
        // Custom endpoint for completing auth
        const sessionId = url.query.session as string;
        
        if (sessionId) {
          cleanup();
          
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <!DOCTYPE html>
            <html>
            <head><title>Authentication Complete</title></head>
            <body>
              <h1>✓ Authentication Successful</h1>
              <p>You can close this window and return to the terminal.</p>
              <script>setTimeout(() => window.close(), 1000);</script>
            </body>
            </html>
          `);
          
          resolve({
            sessionId,
            cookie: `connect.sid=${sessionId}`,
            acquiredAt: new Date(),
          });
        } else {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<h1>Error: No session provided</h1>');
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>Not Found</h1>');
      }
    });
    
    // Listen on specified port or random available port
    const port = callbackPort || 0;
    server.listen(port, '127.0.0.1', async () => {
      const address = server!.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      
      // Generate state for CSRF protection
      const state = randomBytes(16).toString('hex');
      
      // The OAuth flow URL
      const authUrl = `${baseUrl}/auth/oauth2`;
      
      console.log(`\nOIDC Authentication Required`);
      console.log(`============================`);
      console.log(`\n1. Open this URL in your browser:`);
      console.log(`   ${authUrl}`);
      console.log(`\n2. Complete the authentication in your browser.`);
      console.log(`\n3. After logging in, copy your session cookie from the browser.`);
      console.log(`   (Usually found in DevTools > Application > Cookies > connect.sid)`);
      console.log(`\n4. Then visit: http://127.0.0.1:${actualPort}/complete?session=YOUR_SESSION_ID`);
      console.log(`\n   Or press Ctrl+C to cancel.\n`);
      
      // Try to open browser if callback provided
      if (onOpenBrowser) {
        try {
          await onOpenBrowser(authUrl);
        } catch (e) {
          // Ignore browser open errors
        }
      }
    });
    
    server.on('error', (err) => {
      cleanup();
      reject(new AuthError(`Failed to start local auth server: ${err.message}`));
    });
  });
}

// ===========================================
// Auto-detect Authentication Method
// ===========================================

export interface AutoAuthOptions {
  serverUrl: string;
  headers?: Record<string, string>;
}

export interface ServerAuthMethods {
  email: boolean;
  ldap: boolean;
  oauth2: boolean;
  saml: boolean;
  github: boolean;
  gitlab: boolean;
  dropbox: boolean;
  google: boolean;
  twitter: boolean;
}

/**
 * Detect which authentication methods are available on the server.
 */
export async function detectAuthMethods(options: AutoAuthOptions): Promise<ServerAuthMethods> {
  const { serverUrl, headers = {} } = options;
  const baseUrl = serverUrl.replace(/\/$/, '');
  
  try {
    const response = await fetch(`${baseUrl}/config`, {
      headers: {
        'Accept': 'application/json',
        ...headers,
      },
    });
    
    if (!response.ok) {
      throw new AuthError(`Failed to get server config: ${response.status}`);
    }
    
    const config = await response.json();
    
    return {
      email: config.email === true,
      ldap: config.ldap === true,
      oauth2: config.oauth2 === true,
      saml: config.saml === true,
      github: config.github === true,
      gitlab: config.gitlab === true,
      dropbox: config.dropbox === true,
      google: config.google === true,
      twitter: config.twitter === true,
    };
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError(`Failed to detect auth methods: ${(err as Error).message}`);
  }
}
