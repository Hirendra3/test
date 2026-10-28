/**
 * UPI intent handling.
 *
 * The one rule this file exists to enforce:
 *
 *   A signed intent is immutable. You may change the scheme (upi:// -> ppe://),
 *   but the query string must be forwarded byte-for-byte. Re-encoding it,
 *   re-ordering it, or "fixing" `tr`/`am` invalidates `sign` and the UPI app
 *   answers with "payment failed" / "invalid merchant".
 *
 * Everything else here is validation: is this intent actually payable, or is it
 * a template the bridge filled with `pa=...` placeholders?
 */

import type { IntentSource, IntentView, Issue, Severity } from './types.js';

export const KNOWN_UPI_SCHEMES = new Set([
  'upi',
  'ppe',
  'phonepe',
  'tez',
  'gpay',
  'paytmmp',
  'paytm',
  'bhim',
  'credpay',
  'amazonpay',
  'navi',
  'kiwi',
  'slice',
  'fampay',
  'jupiter',
  'supermoney',
  'whatsapp',
  'mobikwik',
  'freecharge',
  'airtel',
  'myjio',
  'dbs',
  'icici',
  'hdfcbank',
  'sbi',
  'axis',
  'kotak',
  'yesbank',
  'fbl',
  'rblbank',
  'equitas',
  'ujjivan',
  'aubank',
  'federal',
  'idfc',
  'bandhan',
  'pnb',
  'bob',
  'unionbank',
  'canara',
  'indus',
]);

const INTENT_RE = /^([A-Za-z][A-Za-z0-9+.\-]*):\/\/([^?#]*)(\?[^#]*)?(#.*)?$/;

export interface RawParam {
  key: string;
  rawValue: string;
  value: string;
}

export interface ParsedIntent {
  raw: string;
  scheme: string;
  /** first segment after `scheme://`, e.g. `pay` in `upi://pay?...` */
  host: string;
  /** remaining path, e.g. `/pay` in `tez://upi/pay?...` */
  path: string;
  /** query string without the leading `?`, exactly as it appeared */
  rawQuery: string;
  hash: string;
  rawParams: RawParam[];
  params: Record<string, string>;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Remove HTML entities / JSON escapes that leak in when a URL is scraped from markup. */
export function sanitizeScrapedUrl(raw: string): string {
  let s = raw.trim();
  s = s.replace(/\\u0026/gi, '&').replace(/\\u003d/gi, '=').replace(/\\\//g, '/').replace(/\\/g, '');
  s = s
    .replace(/&amp;/gi, '&')
    .replace(/&#0*38;/g, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
  // trailing punctuation from surrounding prose / JSON
  s = s.replace(/[)\]"'>,;.]+$/g, '');
  return s;
}

export function isUpiIntentUrl(raw: string): boolean {
  const match = INTENT_RE.exec(raw.trim());
  if (!match) return false;
  const scheme = (match[1] ?? '').toLowerCase();
  if (KNOWN_UPI_SCHEMES.has(scheme)) return true;
  // Unknown scheme: accept it only if it carries UPI payload params.
  const query = match[3] ?? '';
  return /(^|&)(pa|vpa)=/i.test(query.slice(1)) && /(^|&)(am|tr)=/i.test(query);
}

export function parseIntent(raw: string): ParsedIntent | null {
  const cleaned = sanitizeScrapedUrl(raw);
  const match = INTENT_RE.exec(cleaned);
  if (!match) return null;

  const scheme = (match[1] ?? '').toLowerCase();
  const authority = match[2] ?? '';
  const rawQuery = (match[3] ?? '').replace(/^\?/, '');
  const slash = authority.indexOf('/');
  const host = (slash === -1 ? authority : authority.slice(0, slash)).toLowerCase();
  const path = slash === -1 ? '' : authority.slice(slash);

  const rawParams: RawParam[] = [];
  const params: Record<string, string> = {};
  if (rawQuery) {
    for (const chunk of rawQuery.split('&')) {
      if (!chunk) continue;
      const eq = chunk.indexOf('=');
      const rawKey = eq === -1 ? chunk : chunk.slice(0, eq);
      const rawValue = eq === -1 ? '' : chunk.slice(eq + 1);
      const key = safeDecode(rawKey);
      const value = safeDecode(rawValue);
      rawParams.push({ key, rawValue, value });
      if (!(key in params)) params[key] = value;
    }
  }

  return { raw: cleaned, scheme, host, path, rawQuery, hash: match[4] ?? '', rawParams, params };
}

/**
 * Build an app-specific deep link. Only the scheme (and, for Google Pay, the
 * authority) changes — the query string is forwarded untouched so `sign` keeps
 * verifying.
 */
export function buildAppLink(intent: ParsedIntent, app: 'phonepe' | 'paytm' | 'gpay' | 'any'): string {
  const query = intent.rawQuery ? `?${intent.rawQuery}` : '';
  switch (app) {
    case 'phonepe':
      // PhonePe accepts both ppe:// and phonepe://; ppe:// has the widest support.
      return `ppe://${intent.host || 'pay'}${intent.path}${query}`;
    case 'paytm':
      return `paytmmp://${intent.host || 'pay'}${intent.path}${query}`;
    case 'gpay':
      // Google Pay insists on tez://upi/pay, even when the source says upi://pay.
      return `tez://upi${intent.path || '/pay'}${query}`;
    case 'any':
    default:
      return `upi://${intent.host || 'pay'}${intent.path}${query}`;
  }
}

export function buildAppLinks(intent: ParsedIntent): Record<string, string> {
  return {
    any: buildAppLink(intent, 'any'),
    phonepe: buildAppLink(intent, 'phonepe'),
    gpay: buildAppLink(intent, 'gpay'),
    paytm: buildAppLink(intent, 'paytm'),
  };
}

/** "499.00" -> 49900. Rejects >2 decimals, NaN, and empty strings. */
export function amountToPaisa(value: string | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  const s = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [rupeesPart, fractionPart = ''] = s.split('.');
  const rupees = Number(rupeesPart);
  const fraction = Number((fractionPart + '00').slice(0, 2));
  const paisa = rupees * 100 + fraction;
  return Number.isSafeInteger(paisa) ? paisa : null;
}

export function paisaToAmount(paisa: number): string {
  return (paisa / 100).toFixed(2);
}

const PLACEHOLDER_PATTERNS = [
  /^\.{2,}$/,
  /\.\.\./,
  /^\{\{.*\}\}$/,
  /^<.*>$/,
  /\byour[_-]?(upi|vpa|pa)\b/i,
  /\bmerchant[_-]?vpa\b/i,
  /^(pa|vpa|amount|txn|tr|example|test)$/i,
  /^x{3,}$/i,
  /^(undefined|null|nan|none|n\/a|-)$/i,
];

/**
 * Payee handles that only ever come out of template code. `@upi` is nobody's
 * real PSP handle, and `merchant@...` is the placeholder from the API docs.
 */
const VPA_PLACEHOLDERS = [
  /@(upi|vpa|example|test|sample)$/i,
  /^(merchant|test|example|sample|yourstore|yourmerchant|yourbusiness)@/i,
  /^pa@/i,
];

/** `merchant@ybl` is a valid-looking handle; `merchant` alone is not. */
function looksLikeVpa(value: string): boolean {
  return /^[a-zA-Z0-9._\-]{2,64}@[a-zA-Z][a-zA-Z0-9.\-]{1,32}$/.test(value);
}

export function isPlaceholder(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim();
  if (v === '') return true;
  return PLACEHOLDER_PATTERNS.some((re) => re.test(v));
}

export interface EvaluateOptions {
  source: IntentSource;
  /** Intents recovered from a real gateway token/page are more trustworthy. */
  trusted: boolean;
  expectedAmountPaisa?: number | null;
  expectedTxnId?: string | null;
}

function issue(severity: Severity, code: string, message: string): Issue {
  return { severity, code, message };
}

export function evaluateIntent(raw: string, options: EvaluateOptions): IntentView | null {
  const intent = parseIntent(raw);
  if (!intent) return null;

  const issues: Issue[] = [];
  const vpa = intent.params.pa ?? intent.params.vpa;
  const payeeName = intent.params.pn;
  const rawAmount = intent.params.am;
  const txnId = intent.params.tr ?? intent.params.tid ?? null;

  // --- payee ---------------------------------------------------------------
  if (vpa === undefined || vpa === '') {
    issues.push(issue('block', 'missing-vpa', 'Intent has no pa= (payee VPA), so no UPI app can route it.'));
  } else if (isPlaceholder(vpa) || !looksLikeVpa(vpa) || VPA_PLACEHOLDERS.some((re) => re.test(vpa))) {
    issues.push(
      issue(
        'block',
        'placeholder-vpa',
        `Intent payee is the literal placeholder "${vpa}" instead of a real VPA — this URL was templated by the bridge, not issued by PhonePe.`,
      ),
    );
  }

  if (payeeName !== undefined && isPlaceholder(payeeName)) {
    issues.push(issue('block', 'placeholder-pn', `Intent payee name is a placeholder ("${payeeName}").`));
  }

  // --- amount --------------------------------------------------------------
  const amountPaisa = amountToPaisa(rawAmount);
  if (rawAmount === undefined || rawAmount === '') {
    issues.push(issue('block', 'missing-amount', 'Intent has no am= (amount), UPI apps reject such an intent.'));
  } else if (isPlaceholder(rawAmount)) {
    issues.push(issue('block', 'placeholder-amount', `Intent amount is a placeholder ("${rawAmount}").`));
  } else if (amountPaisa === null) {
    issues.push(
      issue('block', 'invalid-amount', `Intent amount "${rawAmount}" is not a valid UPI amount (needs up to 2 decimals).`),
    );
  } else if (
    options.expectedAmountPaisa !== null &&
    options.expectedAmountPaisa !== undefined &&
    options.expectedAmountPaisa > 0 &&
    amountPaisa !== options.expectedAmountPaisa
  ) {
    issues.push(
      issue(
        'block',
        'amount-mismatch',
        `Intent charges ₹${paisaToAmount(amountPaisa)} but the order is ₹${paisaToAmount(options.expectedAmountPaisa)}.`,
      ),
    );
  }

  // --- transaction reference -----------------------------------------------
  if (txnId === null || txnId === '') {
    issues.push(issue('block', 'missing-txn', 'Intent has no tr= (transaction reference), the payment cannot be reconciled.'));
  } else if (isPlaceholder(txnId)) {
    issues.push(issue('block', 'placeholder-txn', `Intent transaction reference is a placeholder ("${txnId}").`));
  } else if (options.expectedTxnId && txnId !== options.expectedTxnId) {
    issues.push(
      issue('warn', 'txn-mismatch', `Intent references "${txnId}" while the order is "${options.expectedTxnId}".`),
    );
  }

  // --- currency / merchant category ---------------------------------------
  const currency = intent.params.cu;
  if (currency !== undefined && currency.toUpperCase() !== 'INR') {
    issues.push(issue('block', 'non-inr', `Intent currency is ${currency}; this integration only settles INR.`));
  } else if (currency === undefined) {
    issues.push(issue('warn', 'missing-currency', 'Intent has no cu=INR; most apps default to INR but it is not guaranteed.'));
  }

  if (intent.params.mc === undefined) {
    issues.push(
      issue('info', 'missing-mc', 'No mc= (merchant category code). PhonePe normally adds it; some apps are stricter without it.'),
    );
  }

  // --- signature -----------------------------------------------------------
  const sign = intent.params.sign;
  const signed = sign !== undefined && sign !== '';
  if (!signed) {
    issues.push(
      issue(
        options.trusted ? 'warn' : 'block',
        'unsigned-intent',
        options.trusted
          ? 'No sign= parameter. Fine for a plain VPA transfer, rejected by UPI apps for registered-merchant checkout flows.'
          : 'No sign= parameter: this intent was assembled by hand, so UPI apps reject it as an unregistered merchant intent.',
      ),
    );
  } else if (sign.length < 20 || isPlaceholder(sign)) {
    issues.push(issue('block', 'weak-sign', 'The sign= parameter is too short / a placeholder to be a valid UPI signature.'));
  } else if (!/[+/_=-]/.test(sign) && sign.length < 40) {
    issues.push(issue('warn', 'short-sign', 'The sign= parameter looks truncated; the UPI app may reject it.'));
  }

  const usable = !issues.some((i) => i.severity === 'block');

  return {
    raw: intent.raw,
    scheme: intent.scheme,
    host: intent.host,
    params: intent.params,
    signed,
    usable,
    source: options.source,
    jsonPath: '',
    appLinks: buildAppLinks(intent),
    issues,
    amountPaisa,
    txnId,
    isPrimary: false,
  };
}
