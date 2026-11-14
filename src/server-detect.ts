/**
 * Find out which HedgeDoc generation a server runs.
 *
 * - HedgeDoc 2 serves JSON at /api/private/config with a `version` object
 *   ({major, minor, patch, preRelease?, commit?}).
 * - HedgeDoc 1 serves a `window.* = ...` script at /config with
 *   `window.version = '1.x.y'`.
 */

import { parseConfigScript } from './hedgedoc-api.js';
import { defaultHedgeSyncRequest, type HedgeSyncHttpResponse, type HedgeSyncRequestFn } from './http.js';
import type { NoteProtocol } from './drivers/types.js';

export interface ServerInfo {
  /** Protocol family, or null if the server did not look like HedgeDoc. */
  protocol: NoteProtocol | null;
  /** Version string as reported by the server, when known. */
  version: string | null;
}

export interface DetectServerOptions {
  serverUrl: string;
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds (default: 10000). */
  timeout?: number;
  request?: HedgeSyncRequestFn;
}

interface HD2Version {
  major?: unknown;
  minor?: unknown;
  patch?: unknown;
  preRelease?: unknown;
}

export async function detectServer(options: DetectServerOptions): Promise<ServerInfo> {
  const base = options.serverUrl.replace(/\/+$/, '');
  const request = options.request ?? defaultHedgeSyncRequest;
  const timeout = options.timeout ?? 10000;
  const get = (path: string): Promise<HedgeSyncHttpResponse | null> =>
    withTimeout(request({ url: base + path, headers: options.headers, redirect: 'manual' }), timeout).catch(() => null);

  // HedgeDoc 1 has no /api/private/* routes (its note route only matches one
  // path segment), so a JSON answer with a version object means HedgeDoc 2.
  const hd2 = await get('/api/private/config');
  if (hd2 && hd2.status === 200) {
    try {
      const body = JSON.parse(await hd2.text()) as { version?: HD2Version | string };
      const v = body.version;
      if (typeof v === 'object' && v && typeof v.major === 'number') {
        const pre = typeof v.preRelease === 'string' && v.preRelease ? `-${v.preRelease}` : '';
        return { protocol: 'hedgedoc2', version: `${v.major}.${v.minor ?? 0}.${v.patch ?? 0}${pre}` };
      }
      if (typeof v === 'string' && /^2\./.test(v)) return { protocol: 'hedgedoc2', version: v };
    } catch {
      // not JSON: fall through
    }
  }

  const hd1 = await get('/config');
  if (hd1 && hd1.status === 200) {
    const script = await hd1.text().catch(() => '');
    if (/window\.\w+\s*=/.test(script)) {
      const version = parseConfigScript(script).version;
      return { protocol: 'hedgedoc1', version: typeof version === 'string' && version ? version : null };
    }
  }
  return { protocol: null, version: null };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Request timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
