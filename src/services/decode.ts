/**
 * "Why does my intent link fail?" as an API.
 * Paste a payment_url, a token, a checkout page URL, or an intent link and get
 * back every intent inside it, decoded and judged.
 */

import type { Config } from '../config.js';
import type { BridgeClient } from '../bridge/client.js';
import { tryDecodeJson } from '../lib/base64.js';
import { mineCheckoutPage, walk, analyzeToken, type IndexedField } from '../lib/tokenDecoder.js';
import { evaluateIntent, isUpiIntentUrl } from '../lib/upi.js';
import { inspectToken } from '../lib/base64.js';
import { decodeQrDataUrl } from '../lib/qrDecode.js';
import type { Diagnostic, IntentView } from '../lib/types.js';

export interface DecodeResult {
  kind: 'intent' | 'token' | 'page';
  input: string;
  intents: IntentView[];
  fields: IndexedField[];
  notes: string[];
  diagnostics: Diagnostic[];
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** Very light SSRF guard for the public debug endpoint. */
export function assertFetchableUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http(s) URLs can be inspected.');
  }
  const host = url.hostname.toLowerCase();
  const blocked =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '[::1]' ||
    host === '::1';
  if (blocked) throw new Error('Private / loopback addresses are not allowed.');
  return url;
}

export async function decodeArbitraryValue(
  config: Config,
  bridge: BridgeClient,
  input: string,
): Promise<DecodeResult> {
  const value = input.trim();
  const diagnostics: Diagnostic[] = [];
  const notes: string[] = [];

  if (!value) throw new Error('Provide a URL, token, or raw intent string.');

  // 1. a bare UPI intent
  if (isUpiIntentUrl(value)) {
    const intent = evaluateIntent(value, { source: 'bridge-intent-url', trusted: false });
    if (!intent) throw new Error('Could not parse that UPI intent.');
    intent.jsonPath = 'input';
    notes.push('Parsed as a UPI intent link.');
    if (!intent.usable) {
      diagnostics.push({
        level: 'error',
        code: 'INTENT_UNPAYABLE',
        message: 'This intent would fail in a UPI app — see the issue list.',
      });
    }
    return { kind: 'intent', input: value, intents: [intent], fields: [], notes, diagnostics };
  }

  // 2. a QR image (data URL or raw base64 PNG) — decode what it actually holds
  const qrImage = value.startsWith('data:image/') ? value : null;
  if (qrImage) {
    const decoded = decodeQrDataUrl(qrImage);
    if (!decoded) {
      diagnostics.push({
        level: 'error',
        code: 'QR_UNREADABLE',
        message: 'The QR image could not be decoded (too small, blurred, or not a QR).',
      });
      return { kind: 'intent', input: value.slice(0, 64) + '…', intents: [], fields: [], notes, diagnostics };
    }

    const isIntent = isUpiIntentUrl(decoded.payload);
    const intent = isIntent
      ? evaluateIntent(decoded.payload, { source: 'qr-image', trusted: true })
      : null;
    if (intent) intent.jsonPath = 'qr_code<image>';

    notes.push(`Decoded the QR image (${decoded.method}) into ${decoded.kind}.`);
    if (!isIntent) {
      diagnostics.push({
        level: 'warn',
        code: 'QR_NOT_UPI',
        message:
          decoded.kind === 'checkout-url'
            ? 'The QR contains a checkout URL, not a UPI intent — scanning it opens the gateway page, not a payment app.'
            : 'The QR contains plain text, not a UPI intent.',
      });
    }

    return {
      kind: 'intent',
      input: 'qr-image',
      intents: intent ? [intent] : [],
      fields: [{ path: 'qr_code<image>', key: 'qr_payload', value: decoded.payload }],
      notes,
      diagnostics,
    };
  }

  // 3. an encoded token
  if (!isHttpUrl(value) && value.length > 16) {
    const decoded = tryDecodeJson(value);
    if (decoded) {
      const analysed = analyzeToken(value);
      const intents = analysed.intents
        .map((i) => {
          const evaluated = evaluateIntent(i.raw, { source: 'token', trusted: true });
          if (evaluated) evaluated.jsonPath = i.path;
          return evaluated;
        })
        .filter((i): i is IntentView => i !== null);
      notes.push(`Decoded ${analysed.layers.length} token layer(s).`);
      if (analysed.layers.length === 0) {
        const inspection = inspectToken(value);
        diagnostics.push({
          level: 'warn',
          code: inspection?.opaque ? 'TOKEN_ENCRYPTED' : 'TOKEN_NOT_JSON',
          message: inspection?.opaque
            ? `This token is ${inspection.bytes} bytes of binary (AES-encrypted by the gateway), not base64 JSON. ` +
              'Its intent can only be read by the gateway checkout page.'
            : analysed.warnings[0] ?? 'The token is not base64url JSON.',
        });
      }
      if (intents.length === 0) {
        diagnostics.push({
          level: 'warn',
          code: 'NO_INTENT_IN_TOKEN',
          message: 'The token decoded fine but carries no UPI intent (it may be an intent-less checkout token).',
        });
      }
      return { kind: 'token', input: value, intents, fields: analysed.fields.slice(0, 24), notes, diagnostics };
    }
  }

  // 3b. base64-ish but not JSON: an encrypted / opaque token
  if (!isHttpUrl(value) && value.length > 16) {
    const inspection = inspectToken(value);
    if (inspection) {
      diagnostics.push({
        level: 'warn',
        code: inspection.opaque ? 'TOKEN_ENCRYPTED' : 'TOKEN_NOT_JSON',
        message: inspection.opaque
          ? `This token is ${inspection.bytes} bytes of binary (AES-encrypted by the gateway), not base64 JSON. ` +
            'Its intent can only be read by the gateway checkout page.'
          : 'This value is base64 but does not decode to JSON, so it holds no readable payload.',
      });
      return {
        kind: 'token',
        input: value.slice(0, 48) + '…',
        intents: [],
        fields: [
          { path: '$', key: 'bytes', value: String(inspection.bytes) },
          { path: '$', key: 'first_bytes', value: inspection.firstBytesHex },
        ],
        notes: ['Treated as an opaque token.'],
        diagnostics,
      };
    }
  }

  // 4. a URL: fetch the page (or decode the token inside it)
  if (isHttpUrl(value)) {
    const url = assertFetchableUrl(value);
    const page = await bridge.fetchPage(url.toString());
    const mined = mineCheckoutPage(page.html);
    const walked = walk({ url: value }, '$');
    void walked;

    const intents = mined.intents
      .map((i) => {
        const evaluated = evaluateIntent(i.raw, { source: 'payment-page', trusted: true });
        if (evaluated) evaluated.jsonPath = i.path;
        return evaluated;
      })
      .filter((i): i is IntentView => i !== null);

    for (const token of mined.tokens) {
      for (const intent of analyzeToken(token.token).intents) {
        const evaluated = evaluateIntent(intent.raw, { source: 'token', trusted: true });
        if (evaluated) evaluated.jsonPath = intent.path;
        if (evaluated && !intents.some((i) => i.raw === evaluated.raw)) intents.push(evaluated);
      }
    }

    notes.push(
      `Fetched ${page.status === 0 ? 'nothing' : `HTTP ${page.status}`} from ${page.finalUrl} (${Math.round(
        page.html.length / 1024,
      )} KB).`,
    );
    if (page.error) {
      diagnostics.push({ level: 'warn', code: 'PAGE_FETCH', message: page.error });
    }
    if (mined.tokens.length === 0) {
      notes.push('No PhonePe token was found on that page.');
    }
    if (intents.length === 0) {
      diagnostics.push({
        level: 'error',
        code: 'NO_INTENT',
        message: 'No UPI intent could be recovered from that page or URL.',
      });
    }

    return {
      kind: 'page',
      input: value,
      intents,
      fields: mined.fields.slice(0, 24),
      notes,
      diagnostics,
    };
  }

  throw new Error(
    `Unrecognised input. Expected a UPI intent (upi://pay?...), a PhonePe token, or an http(s) URL. Timeout ${config.pageTimeoutMs} ms.`,
  );
}
