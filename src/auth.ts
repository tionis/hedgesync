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
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
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
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
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

/**
 * Options for OAuth2 Resource Owner Password Credentials (ROPC) flow.
 * This is useful for bot/service account automation with OIDC providers like Authentik.
 * 
 * @deprecated ROPC is removed in OAuth 2.1. Consider using:
 * - Client Credentials flow for pure M2M (no user context)
 * - Device Authorization Grant for CLI tools that need user authorization
 */
export interface OAuth2PasswordOptions {
  /** HedgeDoc server URL */
  serverUrl: string;
  /** OAuth2 token endpoint URL (e.g., https://authentik.example.com/application/o/token/) */
  tokenUrl: string;
  /** OAuth2 client ID */
  clientId: string;
  /** OAuth2 client secret (optional for public clients) */
  clientSecret?: string;
  /** Username for authentication */
  username: string;
  /** Password or service account token */
  password: string;
  /** OAuth2 scopes to request (default: openid profile email) */
  scopes?: string[];
  /** Custom headers for reverse proxy auth */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * Options for OAuth2 Client Credentials flow (OAuth 2.1 compliant).
 * 
 * This is the recommended flow for machine-to-machine (M2M) authentication
 * where no user context is needed. The client authenticates with its own
 * credentials (client_id + client_secret) to get an access token.
 * 
 * Use cases:
 * - Backend services communicating with APIs
 * - Automated scripts/bots
 * - CI/CD pipelines
 */
export interface OAuth2ClientCredentialsOptions {
  /** HedgeDoc server URL */
  serverUrl: string;
  /** OAuth2 token endpoint URL */
  tokenUrl: string;
  /** OAuth2 client ID */
  clientId: string;
  /** OAuth2 client secret */
  clientSecret: string;
  /** OAuth2 scopes to request */
  scopes?: string[];
  /** Custom headers for reverse proxy auth */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * Options for OAuth2 Device Authorization Grant (RFC 8628).
 * 
 * This is the recommended flow for CLI tools and headless devices that
 * need user authorization but can't easily open a browser or handle redirects.
 * 
 * Flow:
 * 1. Client requests a device code from the authorization server
 * 2. User visits a URL and enters the code on a separate device
 * 3. Client polls for the token until user completes authorization
 */
export interface OAuth2DeviceCodeOptions {
  /** HedgeDoc server URL */
  serverUrl: string;
  /** OAuth2 device authorization endpoint URL */
  deviceAuthUrl: string;
  /** OAuth2 token endpoint URL */
  tokenUrl: string;
  /** OAuth2 client ID */
  clientId: string;
  /** OAuth2 client secret (optional, some providers require it) */
  clientSecret?: string;
  /** OAuth2 scopes to request */
  scopes?: string[];
  /** Custom headers for reverse proxy auth */
  headers?: Record<string, string>;
  /** Timeout in milliseconds for user to complete auth (default: 300000 = 5 minutes) */
  timeout?: number;
  /** Callback when user code is ready to be displayed */
  onUserCode?: (info: DeviceCodeInfo) => void | Promise<void>;
}

/**
 * Information returned from device authorization request
 */
export interface DeviceCodeInfo {
  /** The device verification code */
  deviceCode: string;
  /** The end-user verification code to display */
  userCode: string;
  /** The verification URI the user should visit */
  verificationUri: string;
  /** Optional URI with user code pre-filled */
  verificationUriComplete?: string;
  /** Lifetime in seconds of the device_code and user_code */
  expiresIn: number;
  /** Minimum interval in seconds between polling requests */
  interval: number;
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
  const { serverUrl, email, password, headers = {}, timeout = 30000 } = options;
  const baseUrl = serverUrl.replace(/\/$/, '');
  
  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    // First, get the login page to obtain any CSRF token
    const configResponse = await fetch(`${baseUrl}/config`, {
      headers: {
        'Accept': 'application/json',
        ...headers,
      },
      signal: controller.signal,
    });
    
    let csrfToken: string | undefined;
    if (configResponse.ok) {
      try {
        const config = await configResponse.json() as Record<string, unknown>;
        csrfToken = config.CSRF as string | undefined;
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
      signal: controller.signal,
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
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AuthError(`Login request timed out after ${timeout}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ===========================================
// LDAP Authentication
// ===========================================

/**
 * Authenticate with HedgeDoc using LDAP credentials.
 */
export async function loginWithLDAP(options: LDAPAuthOptions): Promise<AuthResult> {
  const { serverUrl, username, password, headers = {}, timeout = 30000 } = options;
  const baseUrl = serverUrl.replace(/\/$/, '');
  
  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    // First, get the config to obtain any CSRF token
    const configResponse = await fetch(`${baseUrl}/config`, {
      headers: {
        'Accept': 'application/json',
        ...headers,
      },
      signal: controller.signal,
    });
    
    let csrfToken: string | undefined;
    if (configResponse.ok) {
      try {
        const config = await configResponse.json() as Record<string, unknown>;
        csrfToken = config.CSRF as string | undefined;
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
      signal: controller.signal,
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
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AuthError(`LDAP login request timed out after ${timeout}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
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
  
  return new Promise(async (resolve, reject) => {
    let server: Server | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let hedgedocSessionCookie: string | null = null;
    let originalCallbackUrl: string = '';
    
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
    
    try {
      // Step 1: Hit HedgeDoc's /auth/oauth2 to get the OAuth redirect URL and session cookie
      const initResponse = await fetch(`${baseUrl}/auth/oauth2`, {
        redirect: 'manual',
        headers: {
          'Accept': 'text/html',
          ...headers,
        },
      });
      
      // Extract the session cookie HedgeDoc creates
      const setCookieHeader = initResponse.headers.get('set-cookie') || '';
      const cookieMatch = setCookieHeader.match(/connect\.sid=([^;]+)/);
      if (cookieMatch) {
        hedgedocSessionCookie = cookieMatch[1];
      }
      
      if (!hedgedocSessionCookie) {
        throw new AuthError('HedgeDoc did not return a session cookie');
      }
      
      // Get the OAuth authorization URL from the redirect
      const oauthRedirectUrl = initResponse.headers.get('location');
      if (!oauthRedirectUrl) {
        throw new AuthError('HedgeDoc did not redirect to OAuth provider. Is OAuth2 enabled?');
      }
      
      // Parse the OAuth URL to extract the original redirect_uri
      const oauthUrl = new URL(oauthRedirectUrl);
      originalCallbackUrl = oauthUrl.searchParams.get('redirect_uri') || `${baseUrl}/auth/oauth2/callback`;
      
      // Create local server to intercept the callback
      server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const reqUrl = parseUrl(req.url || '', true);
        
        // Handle the OAuth callback
        if (reqUrl.pathname === '/callback' || reqUrl.pathname === '/auth/oauth2/callback') {
          const code = reqUrl.query.code as string;
          const returnedState = reqUrl.query.state as string;
          const error = reqUrl.query.error as string;
          
          if (error) {
            cleanup();
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
              <!DOCTYPE html>
              <html>
              <head><title>Authentication Failed</title></head>
              <body>
                <h1>❌ Authentication Failed</h1>
                <p>Error: ${error}</p>
                <p>${reqUrl.query.error_description || ''}</p>
              </body>
              </html>
            `);
            reject(new AuthError(`OAuth authentication failed: ${error}`));
            return;
          }
          
          if (!code) {
            cleanup();
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h1>Error: No authorization code received</h1>');
            reject(new AuthError('No authorization code received from OAuth provider'));
            return;
          }
          
          try {
            // Forward the callback to HedgeDoc with the original session cookie
            // Build the callback URL with the code and state
            const hedgedocCallbackUrl = new URL(originalCallbackUrl);
            hedgedocCallbackUrl.searchParams.set('code', code);
            if (returnedState) {
              hedgedocCallbackUrl.searchParams.set('state', returnedState);
            }
            
            const hedgedocCallback = await fetch(hedgedocCallbackUrl.toString(), {
              redirect: 'manual',
              headers: {
                'Cookie': `connect.sid=${hedgedocSessionCookie}`,
                'Accept': 'text/html',
                ...headers,
              },
            });
            
            // Check if we got a new session cookie (some setups refresh it)
            const newSetCookie = hedgedocCallback.headers.get('set-cookie') || '';
            const newCookieMatch = newSetCookie.match(/connect\.sid=([^;]+)/);
            const finalSessionId = newCookieMatch ? newCookieMatch[1] : hedgedocSessionCookie!;
            
            // Verify the session is actually authenticated
            const verifyResponse = await fetch(`${baseUrl}/me`, {
              headers: {
                'Cookie': `connect.sid=${finalSessionId}`,
                'Accept': 'application/json',
                ...headers,
              },
            });
            
            const verifyData = await verifyResponse.json() as Record<string, unknown>;
            
            if (verifyData.status === 'forbidden' || (!verifyData.id && !verifyData.name && verifyData.status !== 'ok')) {
              throw new AuthError('OAuth authentication completed but session is not authenticated. The IdP may have rejected the redirect_uri.');
            }
            
            cleanup();
            
            // Send success response to browser
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`
              <!DOCTYPE html>
              <html>
              <head><title>Authentication Successful</title></head>
              <body>
                <h1>✓ Authentication Successful</h1>
                <p>You can close this window and return to the terminal.</p>
                <script>setTimeout(() => window.close(), 1500);</script>
              </body>
              </html>
            `);
            
            resolve({
              sessionId: finalSessionId,
              cookie: `connect.sid=${finalSessionId}`,
              acquiredAt: new Date(),
            });
          } catch (err) {
            cleanup();
            res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
            const errorMessage = err instanceof Error ? err.message : String(err);
            res.end(`<h1>Error completing authentication</h1><p>${errorMessage}</p>`);
            reject(err instanceof AuthError ? err : new AuthError(`Failed to complete OAuth: ${err}`));
          }
        } else {
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>Not Found</h1>');
        }
      });
      
      // Listen on specified port or random available port
      const port = callbackPort || 0;
      server.listen(port, '127.0.0.1', async () => {
        const address = server!.address();
        const actualPort = typeof address === 'object' && address ? address.port : port;
        
        // Create local callback URL
        const localCallbackUrl = `http://127.0.0.1:${actualPort}/callback`;
        
        // Modify the OAuth URL to redirect to our local server
        // Note: This will only work if the IdP allows localhost redirects
        oauthUrl.searchParams.set('redirect_uri', localCallbackUrl);
        const modifiedOAuthUrl = oauthUrl.toString();
        
        console.log(`\nOpening browser for authentication...`);
        console.log(`\nIf the browser doesn't open, visit:`);
        console.log(`  ${modifiedOAuthUrl}`);
        console.log(`\nNote: Your IdP must allow localhost redirects for this to work.`);
        console.log(`If authentication fails, you may need to add http://127.0.0.1:${actualPort}/callback`);
        console.log(`to your IdP's allowed redirect URIs.\n`);
        
        // Try to open browser
        if (onOpenBrowser) {
          try {
            await onOpenBrowser(modifiedOAuthUrl);
          } catch (e) {
            // Ignore browser open errors
          }
        }
      });
      
      server.on('error', (err) => {
        cleanup();
        reject(new AuthError(`Failed to start local auth server: ${err.message}`));
      });
      
    } catch (err) {
      cleanup();
      reject(err instanceof AuthError ? err : new AuthError(`OIDC initialization failed: ${err}`));
    }
  });
}

// ===========================================
// OAuth2 Password Grant (for bot/service accounts)
// ===========================================

/**
 * Authenticate using OAuth2 Resource Owner Password Credentials (ROPC) flow.
 * 
 * This is designed for bot/service account automation with OIDC providers like Authentik.
 * 
 * The flow:
 * 1. Get an OAuth2 access token from the IdP using username/password + client credentials
 * 2. Use that token to authenticate with HedgeDoc's OAuth2 endpoint
 * 3. Return the HedgeDoc session cookie
 * 
 * Note: This requires the OIDC provider to support the password grant type.
 * For Authentik, you can create a service account and use its token.
 * 
 * @example
 * // With Authentik service account
 * const result = await loginWithOAuth2Password({
 *   serverUrl: 'https://hedgedoc.example.com',
 *   tokenUrl: 'https://authentik.example.com/application/o/token/',
 *   clientId: 'hedgedoc',
 *   clientSecret: 'your-client-secret',
 *   username: 'my-service-account',
 *   password: 'my-service-account-token',
 *   scopes: ['openid', 'profile', 'email']
 * });
 */
export async function loginWithOAuth2Password(options: OAuth2PasswordOptions): Promise<AuthResult> {
  const { 
    serverUrl, 
    tokenUrl, 
    clientId, 
    clientSecret,
    username, 
    password, 
    scopes = ['openid', 'profile', 'email'],
    headers = {},
    timeout = 30000 
  } = options;
  
  const baseUrl = serverUrl.replace(/\/$/, '');
  
  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    // Step 1: Get OAuth2 access token from the IdP
    const tokenParams = new URLSearchParams();
    tokenParams.append('grant_type', 'password');
    tokenParams.append('client_id', clientId);
    if (clientSecret) {
      tokenParams.append('client_secret', clientSecret);
    }
    tokenParams.append('username', username);
    tokenParams.append('password', password);
    tokenParams.append('scope', scopes.join(' '));
    
    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        ...headers,
      },
      body: tokenParams.toString(),
      signal: controller.signal,
    });
    
    if (!tokenResponse.ok) {
      const errorBody = await tokenResponse.text();
      let errorMessage = `OAuth2 token request failed with status ${tokenResponse.status}`;
      try {
        const errorJson = JSON.parse(errorBody) as Record<string, unknown>;
        if (errorJson.error_description) {
          errorMessage = `OAuth2 error: ${errorJson.error_description}`;
        } else if (errorJson.error) {
          errorMessage = `OAuth2 error: ${errorJson.error}`;
        }
      } catch {
        // Use default error message
      }
      throw new AuthError(errorMessage, tokenResponse.status);
    }
    
    const tokenData = await tokenResponse.json() as Record<string, unknown>;
    const accessToken = tokenData.access_token as string;
    
    if (!accessToken) {
      throw new AuthError('No access token received from OAuth2 provider');
    }
    
    // Step 2: Use the access token to authenticate with HedgeDoc
    // HedgeDoc's OAuth2 flow expects us to start from /auth/oauth2, but for API access
    // we need to exchange the token. Unfortunately, HedgeDoc 1.x doesn't have a direct
    // token exchange endpoint, so we need to use a workaround.
    
    // Try to call HedgeDoc's /me endpoint with the token to see if it accepts it
    // This works if HedgeDoc is configured to accept Bearer tokens
    const meResponse = await fetch(`${baseUrl}/me`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
        ...headers,
      },
      redirect: 'manual',
      signal: controller.signal,
    });
    
    // Check if we got a session cookie from this request
    let setCookie = meResponse.headers.get('set-cookie') || 
                   meResponse.headers.getSetCookie?.();
    let sessionId = extractSessionCookie(setCookie);
    
    if (sessionId) {
      return {
        sessionId,
        cookie: `connect.sid=${sessionId}`,
        acquiredAt: new Date(),
      };
    }
    
    // If that didn't work, try the callback URL approach
    // Some HedgeDoc setups with reverse proxy auth might accept tokens differently
    const callbackResponse = await fetch(`${baseUrl}/auth/oauth2/callback`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'text/html,application/json',
        ...headers,
      },
      redirect: 'manual',
      signal: controller.signal,
    });
    
    setCookie = callbackResponse.headers.get('set-cookie') || 
               callbackResponse.headers.getSetCookie?.();
    sessionId = extractSessionCookie(setCookie);
    
    if (sessionId) {
      return {
        sessionId,
        cookie: `connect.sid=${sessionId}`,
        acquiredAt: new Date(),
      };
    }
    
    // As a fallback, return the access token itself
    // This can be used with custom header authentication
    // The user can use -H "Authorization: Bearer <token>" instead
    throw new AuthError(
      'OAuth2 authentication successful but HedgeDoc did not return a session cookie. ' +
      'You may need to use the access token directly with -H "Authorization: Bearer <token>" ' +
      'if your reverse proxy supports it.\n\nAccess Token: ' + accessToken
    );
    
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AuthError(`OAuth2 login request timed out after ${timeout}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ===========================================
// OAuth2 Client Credentials Flow (OAuth 2.1)
// ===========================================

/**
 * Authenticate using OAuth2 Client Credentials flow (OAuth 2.1 compliant).
 * 
 * This is for pure machine-to-machine (M2M) authentication where no user
 * context is needed. The client authenticates with its own credentials.
 * 
 * Note: This gets an access token from the IdP, then attempts to exchange
 * it for a HedgeDoc session. If HedgeDoc doesn't accept the token directly,
 * you may need to use the token with -H "Authorization: Bearer <token>".
 * 
 * @example
 * const result = await loginWithClientCredentials({
 *   serverUrl: 'https://hedgedoc.example.com',
 *   tokenUrl: 'https://auth.example.com/oauth/token',
 *   clientId: 'my-service',
 *   clientSecret: 'my-secret',
 *   scopes: ['openid', 'profile']
 * });
 */
export async function loginWithClientCredentials(options: OAuth2ClientCredentialsOptions): Promise<AuthResult> {
  const { 
    serverUrl, 
    tokenUrl, 
    clientId, 
    clientSecret,
    scopes = [],
    headers = {},
    timeout = 30000 
  } = options;
  
  const baseUrl = serverUrl.replace(/\/$/, '');
  
  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    // Request access token using client credentials
    const tokenParams = new URLSearchParams();
    tokenParams.append('grant_type', 'client_credentials');
    tokenParams.append('client_id', clientId);
    tokenParams.append('client_secret', clientSecret);
    if (scopes.length > 0) {
      tokenParams.append('scope', scopes.join(' '));
    }
    
    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        ...headers,
      },
      body: tokenParams.toString(),
      signal: controller.signal,
    });
    
    if (!tokenResponse.ok) {
      const errorBody = await tokenResponse.text();
      let errorMessage = `Client credentials request failed with status ${tokenResponse.status}`;
      try {
        const errorJson = JSON.parse(errorBody) as Record<string, unknown>;
        if (errorJson.error_description) {
          errorMessage = `OAuth2 error: ${errorJson.error_description}`;
        } else if (errorJson.error) {
          errorMessage = `OAuth2 error: ${errorJson.error}`;
        }
      } catch {
        // Use default error message
      }
      throw new AuthError(errorMessage, tokenResponse.status);
    }
    
    const tokenData = await tokenResponse.json() as Record<string, unknown>;
    const accessToken = tokenData.access_token as string;
    
    if (!accessToken) {
      throw new AuthError('No access token received from OAuth2 provider');
    }
    
    // Try to use the access token to get a HedgeDoc session
    const sessionResult = await exchangeTokenForSession(baseUrl, accessToken, headers, controller.signal);
    
    if (sessionResult) {
      return sessionResult;
    }
    
    // Return the access token info if we couldn't get a session
    throw new AuthError(
      'Client credentials authentication successful but HedgeDoc did not return a session cookie. ' +
      'You may need to use the access token directly with -H "Authorization: Bearer <token>" ' +
      'if your reverse proxy supports it.\n\nAccess Token: ' + accessToken
    );
    
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AuthError(`Client credentials request timed out after ${timeout}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ===========================================
// OAuth2 Device Authorization Grant (RFC 8628)
// ===========================================

/**
 * Authenticate using OAuth2 Device Authorization Grant (RFC 8628).
 * 
 * This is ideal for CLI tools where the user can authorize on a separate
 * device (like their phone or another browser).
 * 
 * Flow:
 * 1. Request device code from authorization server
 * 2. Display user code and verification URL to user
 * 3. Poll for token until user completes authorization
 * 
 * @example
 * const result = await loginWithDeviceCode({
 *   serverUrl: 'https://hedgedoc.example.com',
 *   deviceAuthUrl: 'https://auth.example.com/oauth/device/code',
 *   tokenUrl: 'https://auth.example.com/oauth/token',
 *   clientId: 'my-cli-app',
 *   scopes: ['openid', 'profile'],
 *   onUserCode: (info) => {
 *     console.log(`Visit ${info.verificationUri} and enter code: ${info.userCode}`);
 *   }
 * });
 */
export async function loginWithDeviceCode(options: OAuth2DeviceCodeOptions): Promise<AuthResult> {
  const { 
    serverUrl, 
    deviceAuthUrl,
    tokenUrl, 
    clientId, 
    clientSecret,
    scopes = [],
    headers = {},
    timeout = 300000, // 5 minutes default
    onUserCode
  } = options;
  
  const baseUrl = serverUrl.replace(/\/$/, '');
  
  // Step 1: Request device code
  const deviceParams = new URLSearchParams();
  deviceParams.append('client_id', clientId);
  if (clientSecret) {
    deviceParams.append('client_secret', clientSecret);
  }
  if (scopes.length > 0) {
    deviceParams.append('scope', scopes.join(' '));
  }
  
  const deviceResponse = await fetch(deviceAuthUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      ...headers,
    },
    body: deviceParams.toString(),
  });
  
  if (!deviceResponse.ok) {
    const errorBody = await deviceResponse.text();
    let errorMessage = `Device authorization request failed with status ${deviceResponse.status}`;
    try {
      const errorJson = JSON.parse(errorBody) as Record<string, unknown>;
      if (errorJson.error_description) {
        errorMessage = `OAuth2 error: ${errorJson.error_description}`;
      } else if (errorJson.error) {
        errorMessage = `OAuth2 error: ${errorJson.error}`;
      }
    } catch {
      // Use default error message
    }
    throw new AuthError(errorMessage, deviceResponse.status);
  }
  
  const deviceData = await deviceResponse.json() as Record<string, unknown>;
  
  const deviceCodeInfo: DeviceCodeInfo = {
    deviceCode: deviceData.device_code as string,
    userCode: deviceData.user_code as string,
    verificationUri: deviceData.verification_uri as string,
    verificationUriComplete: deviceData.verification_uri_complete as string | undefined,
    expiresIn: (deviceData.expires_in as number) || 600,
    interval: (deviceData.interval as number) || 5,
  };
  
  if (!deviceCodeInfo.deviceCode || !deviceCodeInfo.userCode || !deviceCodeInfo.verificationUri) {
    throw new AuthError('Invalid device authorization response from server');
  }
  
  // Step 2: Display user code to user
  if (onUserCode) {
    await onUserCode(deviceCodeInfo);
  } else {
    // Default display
    console.log('\n' + '='.repeat(50));
    console.log('Device Authorization Required');
    console.log('='.repeat(50));
    console.log(`\n1. Visit: ${deviceCodeInfo.verificationUriComplete || deviceCodeInfo.verificationUri}`);
    console.log(`2. Enter code: ${deviceCodeInfo.userCode}`);
    console.log(`\nWaiting for authorization (expires in ${deviceCodeInfo.expiresIn} seconds)...\n`);
  }
  
  // Step 3: Poll for token
  const startTime = Date.now();
  const pollInterval = deviceCodeInfo.interval * 1000; // Convert to ms
  
  while (Date.now() - startTime < timeout) {
    // Wait for the specified interval
    await new Promise(resolve => setTimeout(resolve, pollInterval));
    
    // Check if we've exceeded the device code expiry
    if (Date.now() - startTime > deviceCodeInfo.expiresIn * 1000) {
      throw new AuthError('Device code expired. Please try again.');
    }
    
    // Poll for token
    const tokenParams = new URLSearchParams();
    tokenParams.append('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');
    tokenParams.append('device_code', deviceCodeInfo.deviceCode);
    tokenParams.append('client_id', clientId);
    if (clientSecret) {
      tokenParams.append('client_secret', clientSecret);
    }
    
    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        ...headers,
      },
      body: tokenParams.toString(),
    });
    
    const tokenData = await tokenResponse.json() as Record<string, unknown>;
    
    // Check for pending/slow_down errors (user hasn't authorized yet)
    if (tokenData.error === 'authorization_pending') {
      continue; // Keep polling
    }
    
    if (tokenData.error === 'slow_down') {
      // Increase poll interval and continue
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      continue;
    }
    
    if (tokenData.error === 'expired_token') {
      throw new AuthError('Device code expired. Please try again.');
    }
    
    if (tokenData.error === 'access_denied') {
      throw new AuthError('Authorization was denied by the user.');
    }
    
    if (tokenData.error) {
      throw new AuthError(`OAuth2 error: ${tokenData.error_description || tokenData.error}`);
    }
    
    // Success! We have an access token
    const accessToken = tokenData.access_token as string;
    
    if (!accessToken) {
      throw new AuthError('No access token received from OAuth2 provider');
    }
    
    // Try to exchange the token for a HedgeDoc session
    const sessionResult = await exchangeTokenForSession(baseUrl, accessToken, headers);
    
    if (sessionResult) {
      return sessionResult;
    }
    
    // HedgeDoc doesn't support Bearer token auth - it requires the full OAuth browser flow
    // Return the access token so it can potentially be used with a reverse proxy that supports it
    throw new AuthError(
      'Device authorization successful, but HedgeDoc does not support exchanging OAuth2 access tokens ' +
      'for session cookies. HedgeDoc requires the full browser-based OAuth2 Authorization Code flow.\n\n' +
      'Options:\n' +
      '  1. Use "hedgesync login oidc" for interactive browser-based authentication\n' +
      '  2. Configure your reverse proxy to validate Bearer tokens and set session cookies\n' +
      '  3. Log in via browser and copy the connect.sid cookie manually\n\n' +
      'Access Token (for reverse proxy use): ' + accessToken
    );
  }
  
  throw new AuthError(`Device authorization timed out after ${timeout / 1000} seconds`);
}

/**
 * Helper function to exchange an OAuth2 access token for a HedgeDoc session cookie.
 */
async function exchangeTokenForSession(
  baseUrl: string, 
  accessToken: string, 
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<AuthResult | null> {
  // Try to call HedgeDoc's /me endpoint with the token
  const meResponse = await fetch(`${baseUrl}/me`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
      ...headers,
    },
    redirect: 'manual',
    signal,
  });
  
  // Check if we got a session cookie
  let setCookie = meResponse.headers.get('set-cookie') || 
                 meResponse.headers.getSetCookie?.();
  let sessionId = extractSessionCookie(setCookie);
  
  if (sessionId) {
    // Verify this session is actually authenticated by checking /me
    const verifyResponse = await fetch(`${baseUrl}/me`, {
      headers: {
        'Cookie': `connect.sid=${sessionId}`,
        'Accept': 'application/json',
        ...headers,
      },
      signal,
    });
    
    if (verifyResponse.ok) {
      const data = await verifyResponse.json() as Record<string, unknown>;
      // HedgeDoc returns {status: "forbidden"} for unauthenticated or {status: "ok", ...} for authenticated
      if (data.status === 'ok' || data.id || data.name) {
        return {
          sessionId,
          cookie: `connect.sid=${sessionId}`,
          acquiredAt: new Date(),
        };
      }
    }
  }
  
  // Try the OAuth2 callback URL approach
  const callbackResponse = await fetch(`${baseUrl}/auth/oauth2/callback`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'text/html,application/json',
      ...headers,
    },
    redirect: 'manual',
    signal,
  });
  
  setCookie = callbackResponse.headers.get('set-cookie') || 
             callbackResponse.headers.getSetCookie?.();
  sessionId = extractSessionCookie(setCookie);
  
  if (sessionId) {
    // Verify this session is actually authenticated
    const verifyResponse = await fetch(`${baseUrl}/me`, {
      headers: {
        'Cookie': `connect.sid=${sessionId}`,
        'Accept': 'application/json',
        ...headers,
      },
      signal,
    });
    
    if (verifyResponse.ok) {
      const data = await verifyResponse.json() as Record<string, unknown>;
      if (data.status === 'ok' || data.id || data.name) {
        return {
          sessionId,
          cookie: `connect.sid=${sessionId}`,
          acquiredAt: new Date(),
        };
      }
    }
  }
  
  return null;
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
    
    const config = await response.json() as Record<string, unknown>;
    
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
