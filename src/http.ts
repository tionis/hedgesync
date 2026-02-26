/**
 * HTTP transport abstraction shared across runtime profiles.
 */

/** Supported runtime override modes. */
export type HedgeSyncRuntime = 'auto' | 'node' | 'browser';

/**
 * Generic HTTP request shape for pluggable transports.
 */
export interface HedgeSyncHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  redirect?: 'follow' | 'manual' | 'error';
  /**
   * Optional fetch-compatible credentials mode.
   * Custom transports may ignore this.
   */
  credentials?: 'omit' | 'same-origin' | 'include';
}

/**
 * Generic HTTP response shape for pluggable transports.
 */
export interface HedgeSyncHttpResponse {
  status: number;
  headers: Record<string, string>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Pluggable request function type. */
export type HedgeSyncRequestFn = (
  request: HedgeSyncHttpRequest
) => Promise<HedgeSyncHttpResponse>;

/**
 * Case-insensitive header lookup.
 */
export function getHeader(
  headers: Record<string, string>,
  name: string
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  return undefined;
}

/**
 * Default transport backed by global fetch.
 */
export async function defaultHedgeSyncRequest(
  request: HedgeSyncHttpRequest
): Promise<HedgeSyncHttpResponse> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: request.redirect,
    credentials: request.credentials,
  });

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  // Node/Bun may expose multiple Set-Cookie values through getSetCookie().
  const headersWithSetCookie = response.headers as unknown as {
    getSetCookie?: () => string[] | string | undefined;
  };
  if (typeof headersWithSetCookie.getSetCookie === 'function') {
    const cookies = headersWithSetCookie.getSetCookie();
    const cookieList = Array.isArray(cookies)
      ? cookies
      : (typeof cookies === 'string' && cookies ? [cookies] : []);
    if (cookieList.length > 0) {
      headers['set-cookie'] = cookieList.join('\n');
    }
  }

  return {
    status: response.status,
    headers,
    text: () => response.text(),
    json: <T = unknown>() => response.json() as Promise<T>,
    arrayBuffer: () => response.arrayBuffer(),
  };
}
