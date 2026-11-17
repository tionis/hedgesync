/**
 * `hedgesync mcp --http`: the MCP server over Streamable HTTP, at /mcp.
 *
 * Three ways in:
 * - no authentication, only on a loopback address (other local programs can
 *   connect; browsers can't, thanks to host and origin checks),
 * - a fixed bearer token (--token), for scripts and single-user setups,
 * - OAuth 2.1 (--owner), with people signing in through IndieAuth; the
 *   token's scopes pick the tool groups an agent gets.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import {
  type AuthInfo, createMcpHandler, getOAuthProtectedResourceMetadataUrl, hostHeaderValidationResponse,
  localhostAllowedHostnames, oauthMetadataResponse, originValidationResponse, requireBearerAuth,
} from '@modelcontextprotocol/server';
import { OAuthServer } from './oauth.js';
import { buildServer } from './server.js';
import type { HedgeDocTools } from './tools.js';

export interface HttpOptions {
  host: string;
  port: number;
  /** Where clients reach the server (an origin); default http://<host>:<port>. */
  publicUrl?: string;
  /** A fixed bearer token. */
  token?: string;
  /** IndieAuth profile URLs allowed to sign in (turns on OAuth). */
  owners?: string[];
  /** Tool groups on offer (the OAuth scopes). */
  groups: string[];
  /** Token store, for tests. */
  oauthStorePath?: string;
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

export const isLoopback = (host: string) => host === 'localhost' || host === '::1' || /^127\./.test(host);

/** Node's request as a fetch Request (aborted when the client goes away). */
function toRequest(req: IncomingMessage, res: ServerResponse, origin: string): Request {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else if (v !== undefined) headers.set(k, v);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(new URL(req.url ?? '/', origin).href, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream) : undefined,
    signal: controller.signal,
    // Required by Node for streamed bodies.
    ...(hasBody ? { duplex: 'half' } : {}),
  } as RequestInit);
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key === 'set-cookie') headers[key] = [...((headers[key] as string[]) ?? []), value];
    else headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  res.on('close', () => void reader.cancel().catch(() => undefined));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {
    // The client went away.
  }
  res.end();
}

/** The fetch handler: discovery documents, the authorization server, and /mcp. */
export function mcpHttpHandler(tools: HedgeDocTools, options: HttpOptions): { fetch: (req: Request) => Promise<Response>; publicUrl: string } {
  const publicUrl = (options.publicUrl ?? `http://${options.host.includes(':') ? `[${options.host}]` : options.host}:${options.port}`).replace(/\/+$/, '');
  const base = new URL(publicUrl);
  if (base.pathname !== '/' || base.search) throw new Error('--public-url must be an origin, such as https://mcp.example.com (no path)');
  const resource = new URL('/mcp', base);
  const allowedHosts = [...new Set([...localhostAllowedHostnames(), base.hostname, options.host])];

  const handler = createMcpHandler(({ era, authInfo }) => buildServer(tools, { era }, {
    http: true,
    groups: authInfo ? authInfo.scopes : options.groups,
  }), { onerror: (err) => options.log?.(`MCP error: ${err.message}`) });
  tools.onNoteChange((url) => void handler.notify.resourceUpdated(url));

  let oauth: OAuthServer | undefined;
  let gate: ((req: Request) => Promise<AuthInfo | Response>) | undefined;
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resource);
  if (options.owners?.length) {
    oauth = new OAuthServer({
      issuer: base.origin, resource: resource.href, owners: options.owners, scopes: options.groups,
      storePath: options.oauthStorePath, fetch: options.fetch,
      // Local client ids only for a server that is itself local (development).
      allowLocalClients: base.protocol === 'http:' && isLoopback(base.hostname),
    });
    gate = requireBearerAuth({ verifier: oauth, resourceMetadataUrl, expectedResource: resource });
  } else if (options.token) {
    const expected = Buffer.from(options.token);
    gate = async (req) => {
      const given = Buffer.from(/^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? '');
      if (given.length === expected.length && timingSafeEqual(given, expected)) {
        return { token: options.token!, clientId: 'token', scopes: options.groups, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
      }
      return new Response(JSON.stringify({ error: 'invalid_token', error_description: 'Pass the server\'s token as a bearer token' }), {
        status: 401, headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer error="invalid_token"' },
      });
    };
  }

  const fetchHandler = async (req: Request): Promise<Response> => {
    // Without authentication, a web page could reach a loopback server via
    // DNS rebinding or a cross-site request: only our own host names and origins.
    if (!gate) {
      const rejected = hostHeaderValidationResponse(req, allowedHosts) ?? originValidationResponse(req, allowedHosts);
      if (rejected) return rejected;
    }
    const { pathname } = new URL(req.url);
    if (oauth) {
      const meta = oauthMetadataResponse(req, {
        oauthMetadata: oauth.metadata() as never,
        resourceServerUrl: resource,
        scopesSupported: options.groups,
        resourceName: 'HedgeDoc notes (hedgesync)',
        dangerouslyAllowInsecureIssuerUrl: base.protocol === 'http:' && isLoopback(base.hostname),
      });
      if (meta) return meta;
      const routed = await oauth.route(req);
      if (routed) return routed;
    }
    if (pathname === '/mcp') {
      let authInfo: AuthInfo | undefined;
      if (gate) {
        const result = await gate(req);
        if (result instanceof Response) return result;
        authInfo = result;
      }
      return handler.fetch(req, { authInfo });
    }
    if (pathname === '/' && req.method === 'GET') {
      return new Response(`hedgesync MCP server. Connect your agent to ${resource.href}\n`, { headers: { 'content-type': 'text/plain' } });
    }
    return new Response('Not found\n', { status: 404 });
  };
  return { fetch: fetchHandler, publicUrl };
}

/** Serves until the process is stopped; resolves once listening. */
export async function serveHttp(tools: HedgeDocTools, options: HttpOptions): Promise<{ close: () => Promise<void>; url: string; port: number }> {
  let app: ReturnType<typeof mcpHttpHandler>;
  const server = createServer((req, res) => {
    const origin = `http://${req.headers.host ?? `${options.host}:${options.port}`}`;
    app.fetch(toRequest(req, res, origin)).then(r => send(res, r), (err) => {
      options.log?.(`HTTP error: ${(err as Error).message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  try {
    app = mcpHttpHandler(tools, { ...options, port });
  } catch (err) {
    server.close();
    throw err;
  }
  return {
    port,
    url: `${app.publicUrl}/mcp`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
