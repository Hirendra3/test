/**
 * PhonePe checkout tokens are nested, base64url-encoded JSON blobs. The signed
 * UPI intent (`intentUrl`) lives *inside* that payload, which is why a bridge
 * that only forwards `payment_url` forces clients to invent an intent link —
 * and invented links always fail.
 *
 * This module decodes the token(s) out of a `payment_url`, a checkout page, or
 * a raw JSON body, walks the whole tree (following nested base64 payloads),
 * and harvests every UPI intent plus the useful scalar fields (amount, order
 * id, expiry...). It never mutates the URLs it finds.
 */

import { looksLikeBase64, previewToken, tryDecodeJson } from './base64.js';
import { isUpiIntentUrl, sanitizeScrapedUrl } from './upi.js';

export interface ExtractedIntent {
  raw: string;
  path: string;
}

export interface DecodedLayer {
  path: string;
  token: string;
  json: unknown;
}

export interface IndexedField {
  path: string;
  key: string;
  value: string;
}

export interface WalkResult {
  layers: DecodedLayer[];
  intents: ExtractedIntent[];
  fields: IndexedField[];
  warnings: string[];
}

export interface TokenSource {
  token: string;
  origin: string;
}

const MAX_DEPTH = 8;
const MAX_NODES = 20_000;

/** Keys worth surfacing to the UI so a merchant can eyeball the real order data. */
const INTERESTING_KEYS = new Set(
  [
    'merchantid',
    'merchanttransactionid',
    'transactionid',
    'pgtransactionid',
    'orderid',
    'amount',
    'amountpaisa',
    'currency',
    'expireat',
    'expiry',
    'state',
    'status',
    'mobilenumber',
    'payername',
    'storeid',
    'terminalid',
    'instrumenttype',
    'intenturl',
    'qrdata',
    'redirecturl',
  ].map((k) => k.toLowerCase()),
);

const TOKEN_PARAM_NAMES = [
  'token',
  'txntoken',
  'transactiontoken',
  'encpayload',
  'payload',
  'data',
  'checkouttoken',
];

function emptyResult(): WalkResult {
  return { layers: [], intents: [], fields: [], warnings: [] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pushUnique<T>(target: T[], item: T, keyOf: (value: T) => string): void {
  const key = keyOf(item);
  if (!target.some((existing) => keyOf(existing) === key)) target.push(item);
}

function addIntent(target: ExtractedIntent[], raw: string, path: string): void {
  const clean = sanitizeScrapedUrl(raw);
  if (!isUpiIntentUrl(clean)) return;
  pushUnique(target, { raw: clean, path }, (i) => i.raw);
}

/**
 * Walk any JSON-ish value, following nested base64 payloads and collecting
 * intents/fields. Recursion is depth- and node-budgeted.
 */
export function walk(value: unknown, rootPath = '$', result: WalkResult = emptyResult()): WalkResult {
  let nodes = 0;
  const seenStrings = new Set<string>();

  const visit = (node: unknown, path: string, depth: number): void => {
    if (nodes++ > MAX_NODES || depth > MAX_DEPTH) return;

    if (typeof node === 'string') {
      if (seenStrings.has(node)) return;
      seenStrings.add(node);

      if (isUpiIntentUrl(node)) {
        addIntent(result.intents, node, path);
        return;
      }

      // An intent embedded in markup or a JSON string ("upi://pay?...&sign=..")
      const embedded = node.match(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>\\]+/gi);
      if (embedded) {
        for (const candidate of embedded) addIntent(result.intents, candidate, `${path}#embedded`);
      }

      // Nested base64 payload (PhonePe often wraps the request one level deeper)
      if (looksLikeBase64(node, 16)) {
        const decoded = tryDecodeJson(node);
        if (decoded) {
          result.layers.push({ path, token: node, json: decoded.value });
          visit(decoded.value, `${path}<decoded>`, depth + 1);
        }
      }
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }

    if (isPlainObject(node)) {
      for (const [key, child] of Object.entries(node)) {
        const childPath = `${path}.${key}`;
        const lowerKey = key.toLowerCase();

        if (typeof child === 'string' && isUpiIntentUrl(child)) {
          addIntent(result.intents, child, childPath);
          continue;
        }

        if (INTERESTING_KEYS.has(lowerKey)) {
          if (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean') {
            pushUnique(
              result.fields,
              { path: childPath, key, value: String(child) },
              (f) => `${f.key}=${f.value}`,
            );
          }
        }

        visit(child, childPath, depth + 1);
      }
    }
  };

  visit(value, rootPath, 0);
  return result;
}

/** Decode one token and walk it. `layers` includes the root layer. */
export function analyzeToken(token: string): WalkResult {
  const decoded = tryDecodeJson(token);
  if (!decoded) {
    return {
      ...emptyResult(),
      warnings: [
        `Token could not be decoded as base64url JSON (${token.length} chars, ${previewToken(token)}).`,
      ],
    };
  }

  const result: WalkResult = {
    layers: [{ path: '$', token, json: decoded.value }],
    intents: [],
    fields: [],
    warnings: [],
  };
  return walk(decoded.value, '$', result);
}

/**
 * Pull every candidate token out of a payment URL: named query params first,
 * then any long base64-ish param, then a token hiding in the path.
 */
export function extractTokensFromUrl(url: string): TokenSource[] {
  const found: TokenSource[] = [];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return found;
  }

  for (const [name, value] of parsed.searchParams) {
    if (!value) continue;
    const lower = name.toLowerCase();
    const named = TOKEN_PARAM_NAMES.some((n) => lower.includes(n));
    const tokenish = looksLikeBase64(value, 24) && tryDecodeJson(value) !== null;
    if (!named && !tokenish) continue;
    if (!tryDecodeJson(value)) continue;

    pushUnique(found, { token: value, origin: `url query "${name}"` }, (s) => s.token);
  }

  // Token stuffed into the path, e.g. /pay/<token>
  const segments = parsed.pathname.split('/').filter(Boolean);
  for (const segment of segments) {
    if (segment.length < 40 || !looksLikeBase64(segment, 40)) continue;
    if (!tryDecodeJson(segment)) continue;
    pushUnique(found, { token: segment, origin: 'url path' }, (s) => s.token);
  }

  return found;
}

function htmlDecode(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&#0*38;/g, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

/**
 * Mine a hosted checkout page (PhonePe's mercury page or the bridge's own
 * /pay/<id> page) for tokens and intents embedded in markup / inline scripts.
 */
export function mineCheckoutPage(html: string): WalkResult & { tokens: TokenSource[] } {
  const result: WalkResult & { tokens: TokenSource[] } = {
    ...emptyResult(),
    tokens: [],
  };
  if (!html) return result;

  const decodedHtml = htmlDecode(html);

  // 1. intents anywhere in the markup (href, data attributes, inline JS)
  const intentMatches = decodedHtml.match(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>\\]+/gi) ?? [];
  for (const candidate of intentMatches) {
    if (isUpiIntentUrl(candidate)) addIntent(result.intents, candidate, 'page');
  }

  // 2. named tokens: "token":"...", data-token="...", token: '...'
  const tokenPatterns = [
    /"token"\s*:\s*"([^"\\]{16,})"/gi,
    /'token'\s*:\s*'([^'\\]{16,})'/gi,
    /data-token\s*=\s*["']([^"']{16,})["']/gi,
    /\btoken["']?\s*[:=]\s*["']([A-Za-z0-9_\-+/=%]{16,})["']/gi,
    /[?&](?:token|txnToken|transactionToken)=([A-Za-z0-9_\-+/=%]{16,})/gi,
  ];
  for (const pattern of tokenPatterns) {
    for (const match of decodedHtml.matchAll(pattern)) {
      const token = match[1];
      if (!token) continue;
      if (!tryDecodeJson(token)) continue;
      pushUnique(result.tokens, { token, origin: 'page markup' }, (s) => s.token);
    }
  }

  // 3. inline JSON script blobs that hold their own base64 payloads
  for (const match of decodedHtml.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = match[1] ?? '';
    if (!body.trim()) continue;
    if (body.trim().startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(body.trim());
        walk(parsed, '$.inlineScript', result);
      } catch {
        /* not JSON, fall through to blob scanning */
      }
    }
    for (const blob of body.matchAll(/[A-Za-z0-9_-]{40,}/g)) {
      const candidate = blob[0];
      if (!candidate || !tryDecodeJson(candidate)) continue;
      pushUnique(result.tokens, { token: candidate, origin: 'inline script' }, (s) => s.token);
    }
  }

  // 4. decode every mined token and merge what it contains
  for (const source of result.tokens) {
    const analysed = analyzeToken(source.token);
    result.layers.push(...analysed.layers);
    result.warnings.push(...analysed.warnings);
    for (const intent of analysed.intents) addIntent(result.intents, intent.raw, intent.path);
    for (const field of analysed.fields) {
      pushUnique(result.fields, field, (f) => `${f.key}=${f.value}`);
    }
  }

  return result;
}

export function mergeWalkResults(...results: WalkResult[]): WalkResult {
  const merged = emptyResult();
  for (const result of results) {
    merged.warnings.push(...result.warnings);
    for (const layer of result.layers) {
      pushUnique(merged.layers, layer, (l) => l.path + l.token.slice(0, 32));
    }
    for (const intent of result.intents) addIntent(merged.intents, intent.raw, intent.path);
    for (const field of result.fields) {
      pushUnique(merged.fields, field, (f) => `${f.key}=${f.value}`);
    }
  }
  return merged;
}
