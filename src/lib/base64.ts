/**
 * Base64 helpers that tolerate every flavour a payment gateway throws at us:
 * url-safe alphabet, missing padding, percent-encoded token, plus the
 * "double encoded" tokens some bridges produce.
 */

const BASE64_CHARSET = /^[A-Za-z0-9+/=_-]+$/;

export function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Turn any base64/base64url string into a padded standard base64 string. */
export function normalizeBase64(input: string): string | null {
  let s = input.trim().replace(/\s+/g, '');
  if (s.length === 0) return null;

  // A percent-encoded token (`%3D` padding etc.) is common in query strings.
  if (s.includes('%')) s = safeDecodeURIComponent(s);

  s = s.replace(/-/g, '+').replace(/_/g, '/');
  if (!BASE64_CHARSET.test(s)) return null;

  const remainder = s.length % 4;
  if (remainder === 1) return null;
  if (remainder !== 0) s += '='.repeat(4 - remainder);
  return s;
}

export function decodeBase64(input: string): Buffer | null {
  const normalized = normalizeBase64(input);
  if (!normalized) return null;
  try {
    const buffer = Buffer.from(normalized, 'base64');
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

export function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function looksLikeBase64(value: string, minLength = 16): boolean {
  return value.length >= minLength && BASE64_CHARSET.test(value);
}

export interface DecodedJson {
  value: unknown;
  text: string;
  buffer: Buffer;
}

/**
 * Decode a value that is *supposed* to contain JSON. Returns null when it is
 * not base64, not JSON, or decodes to a primitive (a bare number is never a
 * useful nested payload).
 */
export function tryDecodeJson(value: string): DecodedJson | null {
  if (!looksLikeBase64(value, 8)) return null;
  const buffer = decodeBase64(value);
  if (!buffer || buffer.length < 2) return null;

  const text = buffer.toString('utf8');
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;

  try {
    return { value: JSON.parse(trimmed), text, buffer };
  } catch {
    return null;
  }
}

/** Preview helper: never dump a 2 KB token into a log line or the UI. */
export function previewToken(token: string, head = 18, tail = 10): string {
  if (token.length <= head + tail + 3) return token;
  return `${token.slice(0, head)}...${token.slice(-tail)}`;
}
