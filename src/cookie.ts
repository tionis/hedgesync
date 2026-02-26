/**
 * Cookie utility helpers shared across runtime profiles.
 */

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
