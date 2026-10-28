/**
 * Turns "whatever the bridge returned" into one honest payment plan.
 *
 * Ranking rule: a token/page-derived, signature-bearing, amount-matching UPI
 * intent wins. A hand-templated intent link (the usual cause of a failing
 * `intent_url`) is kept for inspection but never promoted to the pay button.
 * When nothing is provably payable we fall back to the hosted checkout URL,
 * which always works in a browser.
 */

import { inspectToken, tryDecodeJson } from './base64.js';
import { fitsInQr } from './qr.js';
import {
  analyzeToken,
  extractTokensFromUrl,
  mergeWalkResults,
  mineCheckoutPage,
  walk,
  type ExtractedIntent,
  type IndexedField,
  type TokenSource,
  type WalkResult,
} from './tokenDecoder.js';
import {
  buildAppLinks,
  buildDirectIntent,
  evaluateIntent,
  isUpiIntentUrl as isUpiIntent,
  paisaToAmount,
  parseIntent,
} from './upi.js';
import { hostOf } from './url.js';
import type {
  DecodedSource,
  Diagnostic,
  IntentSource,
  IntentView,
  PayAction,
  PayPlan,
  PgType,
  QrView,
} from './types.js';

export interface PageSnapshot {
  url: string;
  finalUrl: string;
  status: number;
  html: string;
  error: string | null;
}

export function mergeHostedUrls(primary: HostedUrls | null, secondary: HostedUrls | null): HostedUrls {
  const pick = (a: string | null, b: string | null): string | null => a ?? b;
  return {
    paymentUrl: pick(primary?.paymentUrl ?? null, secondary?.paymentUrl ?? null),
    tokenUrl: pick(primary?.tokenUrl ?? null, secondary?.tokenUrl ?? null),
    pgPaymentUrl: pick(primary?.pgPaymentUrl ?? null, secondary?.pgPaymentUrl ?? null),
    customPaymentUrl: pick(primary?.customPaymentUrl ?? null, secondary?.customPaymentUrl ?? null),
    checkoutScript: pick(primary?.checkoutScript ?? null, secondary?.checkoutScript ?? null),
    qrString: pick(primary?.qrString ?? null, secondary?.qrString ?? null),
    qrCode: pick(primary?.qrCode ?? null, secondary?.qrCode ?? null),
  };
}

export interface PlanInput {
  pgType: PgType;
  requestedPgType: string;
  txnId: string;
  amountPaisa: number;
  collectPayload: unknown;
  /** Payload recovered from the bridge's QR *image* (data URL decoded upstream). */
  decodedQr?: { payload: string; method: string } | null;
  /** Merchant VPA used to build an app-launch intent when the gateway gives none. */
  directUpi?: { vpa: string; payeeName: string | null } | null;
  pages: PageSnapshot[];
  sessionPayload: unknown | null;
  demo: boolean;
  demoReason: string | null;
}

interface CandidateIntent extends ExtractedIntent {
  source: IntentSource;
}

const SOURCE_SCORE: Record<IntentSource, number> = {
  'direct-upi': 10,
  token: 60,
  'payment-page': 50,
  session: 40,
  'qr-image': 30,
  'bridge-intent-url': 20,
  'bridge-qr': 5,
};

const SOURCE_RANK: Record<IntentSource, number> = {
  'direct-upi': 0,
  token: 6,
  'payment-page': 5,
  session: 4,
  'qr-image': 3,
  'bridge-intent-url': 2,
  'bridge-qr': 1,
};

const SOURCE_LABEL: Record<IntentSource, string> = {
  token: 'PhonePe token payload',
  'payment-page': 'Hosted checkout page',
  session: 'Active session API',
  'qr-image': 'Decoded QR image',
  'bridge-intent-url': 'Bridge response field',
  'bridge-qr': 'Bridge QR string',
  'direct-upi': 'Direct UPI ID (no gateway)',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

interface FieldHit {
  key: string;
  value: string;
  path: string;
}

/** Depth-limited recursive scan for scalar fields with matching (normalized) keys. */
function findFields(payload: unknown, wanted: Set<string>, limit = 40): FieldHit[] {
  const hits: FieldHit[] = [];
  const visit = (node: unknown, path: string, depth: number): void => {
    if (hits.length >= limit || depth > 6) return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, child] of Object.entries(node)) {
      const childPath = `${path}.${key}`;
      if (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean') {
        if (wanted.has(normalizeKey(key))) hits.push({ key, value: String(child), path: childPath });
      } else {
        visit(child, childPath, depth + 1);
      }
    }
  };
  visit(payload, '$', 0);
  return hits;
}

function firstField(payload: unknown, ...names: string[]): string | null {
  const hits = findFields(payload, new Set(names.map(normalizeKey)), 5);
  const hit = hits.find((h) => h.value.trim() !== '');
  return hit ? hit.value.trim() : null;
}

export interface HostedUrls {
  paymentUrl: string | null;
  tokenUrl: string | null;
  pgPaymentUrl: string | null;
  customPaymentUrl: string | null;
  checkoutScript: string | null;
  qrString: string | null;
  qrCode: string | null;
}

export function extractHostedUrls(payload: unknown): HostedUrls {
  const clean = (value: string | null): string | null => {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed || /^(null|undefined|none)$/i.test(trimmed)) return null;
    return trimmed;
  };

  return {
    paymentUrl: clean(firstField(payload, 'payment_url', 'paymentUrl')),
    tokenUrl: clean(firstField(payload, 'token_url', 'tokenUrl')),
    pgPaymentUrl: clean(firstField(payload, 'pg_payment_url', 'pgPaymentUrl')),
    customPaymentUrl: clean(firstField(payload, 'custom_payment_url', 'customPaymentUrl')),
    checkoutScript: clean(firstField(payload, 'checkout_script', 'checkoutScript')),
    qrString: clean(firstField(payload, 'qr_string', 'qrString', 'qr_data', 'qrData')),
    qrCode: clean(firstField(payload, 'qr_code', 'qrCode')),
  };
}

function bestHostedUrl(urls: HostedUrls): string | null {
  const candidates = [urls.paymentUrl, urls.pgPaymentUrl, urls.tokenUrl, urls.customPaymentUrl];
  return candidates.find((candidate): candidate is string => Boolean(candidate && isHttpUrl(candidate))) ?? null;
}

function collectCandidates(input: PlanInput, urls: HostedUrls): {
  candidates: CandidateIntent[];
  tokens: { source: TokenSource; label: string }[];
  walkResults: WalkResult[];
  notes: string[];
} {
  const candidates: CandidateIntent[] = [];
  const tokens: { source: TokenSource; label: string }[] = [];
  const walkResults: WalkResult[] = [];
  const notes: string[] = [];

  const addCandidates = (intents: ExtractedIntent[], source: IntentSource): void => {
    for (const intent of intents) {
      if (!isUpiIntent(intent.raw)) continue;
      const existing = candidates.find((c) => c.raw === intent.raw);
      if (existing) {
        // Same link seen twice: remember the most trustworthy place it came from.
        if (SOURCE_RANK[source] > SOURCE_RANK[existing.source]) {
          existing.source = source;
          existing.path = intent.path;
        }
        continue;
      }
      candidates.push({ raw: intent.raw, path: intent.path, source });
    }
  };

  const addTokens = (found: TokenSource[], label: string): void => {
    for (const token of found) {
      if (tokens.some((t) => t.source.token === token.token)) continue;
      tokens.push({ source: token, label });
      const analysed = analyzeToken(token.token);
      walkResults.push(analysed);
      addCandidates(analysed.intents, 'token');
    }
  };

  // 1. direct intents sitting in the bridge response
  const collectWalk = walk(input.collectPayload, '$');
  walkResults.push(collectWalk);
  const direct = collectWalk.intents.filter((i) => !i.path.includes('<decoded>'));
  addCandidates(direct, 'bridge-intent-url');
  // intents that appeared inside a decoded token found while walking the body
  const nested = collectWalk.intents.filter((i) => i.path.includes('<decoded>'));
  addCandidates(nested, 'token');

  if (urls.qrString && isUpiIntent(urls.qrString)) {
    addCandidates([{ raw: urls.qrString, path: '$.qr_string' }], 'bridge-qr');
  }

  // The gateway may ship an encrypted (non-JSON) token: flag it explicitly so
  // "no intent" is explained instead of looking like a decoder failure.
  for (const url of [urls.paymentUrl, urls.pgPaymentUrl, urls.tokenUrl]) {
    if (!url) continue;
    let token: string | null = null;
    try {
      const parsed = new URL(url);
      token = parsed.searchParams.get('token') ?? parsed.searchParams.get('txnToken');
    } catch {
      token = null;
    }
    if (!token || tryDecodeJson(token)) continue;
    const inspection = inspectToken(token);
    if (!inspection?.opaque) continue;
    notes.push(
      `The token in ${hostOf(url)} is ${inspection.bytes} bytes of binary (encrypted), not base64 JSON.`,
    );
    break;
  }
  if (input.decodedQr && isUpiIntent(input.decodedQr.payload)) {
    addCandidates([{ raw: input.decodedQr.payload, path: '$.qr_code<image>' }], 'qr-image');
    notes.push(`Decoded qr_code image (${input.decodedQr.method}) into a UPI intent.`);
  } else if (input.decodedQr) {
    notes.push(
      `Decoded qr_code image (${input.decodedQr.method}); it contains ${
        /^https?:\/\//i.test(input.decodedQr.payload) ? 'a checkout URL' : 'plain text'
      }, not a UPI intent.`,
    );
  }

  // 2. tokens inside the hosted URLs
  for (const url of new Set([urls.paymentUrl, urls.tokenUrl, urls.pgPaymentUrl]) ) {
    if (!url) continue;
    const found = extractTokensFromUrl(url);
    if (found.length > 0) {
      addTokens(found, `token_url (${hostOf(url)})`);
      notes.push(`Found ${found.length} encoded token(s) in ${hostOf(url)} URL.`);
    }
  }

  // 3. tokens the bridge disclosed directly (rare but cheap to support)
  for (const key of ['token', 'txnToken', 'transactionToken']) {
    const value = firstField(input.collectPayload, key);
    if (value && value.length > 24) addTokens([{ token: value, origin: `response field "${key}"` }], key);
  }

  // 4. the hosted checkout page itself
  for (const page of input.pages) {
    if (!page.html) continue;
    const mined = mineCheckoutPage(page.html);
    walkResults.push(mined);
    addCandidates(mined.intents, 'payment-page');
    const pageHost = hostOf(page.finalUrl || page.url);
    addTokens(mined.tokens, `checkout page (${pageHost})`);
    notes.push(
      `Read checkout page ${pageHost} (HTTP ${page.status}, ${Math.round(page.html.length / 1024)} KB).`,
    );
  }

  // 5. the session API
  if (input.sessionPayload) {
    const sessionWalk = walk(input.sessionPayload, '$.session');
    walkResults.push(sessionWalk);
    addCandidates(
      sessionWalk.intents.filter((i) => !i.path.includes('<decoded>')),
      'session',
    );
    addCandidates(
      sessionWalk.intents.filter((i) => i.path.includes('<decoded>')),
      'token',
    );
  }

  if (input.pages.length > 0) {
    const failed = input.pages.filter((p) => p.error);
    for (const page of failed) notes.push(`Could not read ${page.url}: ${page.error}`);
  }

  return { candidates, tokens, walkResults, notes };
}

function scoreIntent(intent: IntentView, expectedAmountPaisa: number): number {
  let score = SOURCE_SCORE[intent.source];
  if (intent.usable) score += 1000;
  if (intent.signed) score += 200;
  if (expectedAmountPaisa > 0 && intent.amountPaisa === expectedAmountPaisa) score += 30;
  if (Object.keys(intent.params).length > 4) score += 5;
  return score;
}

function summarizeIssues(intent: IntentView): string {
  const blocks = intent.issues.filter((i) => i.severity === 'block');
  const list = blocks.length > 0 ? blocks : intent.issues;
  return list
    .slice(0, 3)
    .map((i) => i.message)
    .join(' ');
}

export function formatInr(paisa: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
  }).format(paisa / 100);
}

function buildAppActions(intent: IntentView): PayAction[] {
  const apps: { key: 'phonepe' | 'gpay' | 'paytm' | 'any'; label: string }[] = [
    { key: 'phonepe', label: 'Pay with PhonePe' },
    { key: 'gpay', label: 'Pay with Google Pay' },
    { key: 'paytm', label: 'Pay with Paytm' },
    { key: 'any', label: 'Pay with any UPI app' },
  ];
  const actions: PayAction[] = [];
  for (const app of apps) {
    const url = intent.appLinks[app.key];
    if (!url) continue;
    actions.push({ kind: 'intent', app: app.key, label: app.label, url });
  }
  return actions;
}

export interface PlanResult {
  plan: PayPlan;
  /** Extra app buttons derived from the primary intent (used by the UI). */
  appActions: PayAction[];
}

export function buildPayPlan(input: PlanInput): PlanResult {
  const urls = mergeHostedUrls(
    extractHostedUrls(input.collectPayload),
    input.sessionPayload ? extractHostedUrls(input.sessionPayload) : null,
  );
  const { candidates, tokens, walkResults, notes } = collectCandidates(input, urls);

  const evaluated: IntentView[] = [];
  for (const candidate of candidates) {
    const view = evaluateIntent(candidate.raw, {
      source: candidate.source,
      trusted: candidate.source === 'token' || candidate.source === 'payment-page' || candidate.source === 'session',
      expectedAmountPaisa: input.amountPaisa,
      expectedTxnId: input.txnId,
    });
    if (!view) continue;
    view.jsonPath = candidate.path;
    view.isPrimary = false;
    evaluated.push(view);
  }

  const ranked = [...evaluated].sort(
    (a, b) => scoreIntent(b, input.amountPaisa) - scoreIntent(a, input.amountPaisa),
  );

  const primaryIntent = ranked.find((intent) => intent.usable) ?? null;
  if (primaryIntent) primaryIntent.isPrimary = true;

  // ---- direct UPI app-launch intent (merchant VPA) ------------------------
  let directUpi: PayPlan['directUpi'] = null;
  const directApps: PayAction[] = [];

  if (!primaryIntent && input.directUpi?.vpa) {
    const directRaw = buildDirectIntent({
      vpa: input.directUpi.vpa,
      payeeName: input.directUpi.payeeName,
      txnId: input.txnId,
      amountPaisa: input.amountPaisa,
      note: `Order ${input.txnId}`,
    });
    const view = evaluateIntent(directRaw, {
      source: 'direct-upi',
      trusted: false,
      allowUnsigned: true,
      expectedAmountPaisa: input.amountPaisa,
      expectedTxnId: input.txnId,
    });
    if (view) {
      view.jsonPath = 'config.UPI_VPA';
      view.isPrimary = true;
      ranked.push(view);

      const parsedDirect = parseIntent(directRaw);
      const apps = parsedDirect ? buildAppLinks(parsedDirect) : null;
      directUpi = {
        vpa: input.directUpi.vpa,
        payeeName: input.directUpi.payeeName ?? 'Merchant',
        value: directRaw,
        txnId: input.txnId,
        amountPaisa: input.amountPaisa,
        apps: apps
          ? buildAppActions({
              raw: directRaw,
              appLinks: apps,
            } as IntentView)
          : [],
        warning:
          'Pays your UPI ID directly (no gateway signature). The money reaches you, but the bridge will not see this payment — reconcile with your bank/UPI statement.',
      };
      directApps.push(...directUpi.apps);
    }
  }

  const hostedUrl = bestHostedUrl(urls);
  const fallback: PayAction | null = hostedUrl
    ? {
        kind: 'hosted',
        app: input.pgType === 'easebuzz' ? 'easebuzz' : 'web',
        label:
          input.pgType === 'easebuzz'
            ? 'Pay on Easebuzz secure checkout'
            : 'Pay on PhonePe secure checkout',
        url: hostedUrl,
        hint: 'Opens the gateway-hosted page in this browser. No UPI app needed.',
      }
    : null;

  const primary: PayAction | null = primaryIntent
    ? {
        kind: 'intent',
        app: 'any',
        label: 'Pay with UPI app',
        url: primaryIntent.appLinks.any ?? primaryIntent.raw,
        hint: 'Signed by the gateway — the amount and payee are locked.',
      }
    : directUpi
      ? {
          kind: 'intent',
          app: 'any',
          label: 'Pay with UPI app',
          url: directUpi.value,
          hint: 'Opens PhonePe / GPay / Paytm on your phone.',
        }
      : fallback;

  // ---- diagnostics -------------------------------------------------------
  const diagnostics: Diagnostic[] = [];

  if (input.demo) {
    diagnostics.push({
      level: 'warn',
      code: 'DEMO_PLAN',
      message: `Demo plan: ${input.demoReason ?? 'the live bridge was not used'}. No money can move.`,
    });
  }

  const tokenLayers = tokens.reduce((sum, t) => sum + analyzeToken(t.source.token).layers.length, 0);
  if (tokens.length > 0) {
    diagnostics.push({
      level: 'ok',
      code: 'TOKEN_DECODED',
      message: `Decoded ${tokens.length} gateway token(s) across ${tokenLayers} nesting layer(s).`,
    });
  }

  if (primaryIntent) {
    diagnostics.push({
      level: 'ok',
      code: 'SIGNED_INTENT',
      message: `Using the signed intent recovered from ${SOURCE_LABEL[primaryIntent.source]} (${primaryIntent.signed ? 'sign present' : 'no signature'}).`,
    });
  }

  const brokenIntents = evaluated.filter((i) => !i.usable);
  if (brokenIntents.length > 0) {
    const worst = brokenIntents[0];
    if (worst) {
      diagnostics.push({
        level: 'error',
        code: 'INTENT_UNPAYABLE',
        message: `${brokenIntents.length} intent link(s) in the payload cannot be paid: ${summarizeIssues(worst)}`,
      });
    }
  }

  if (!primaryIntent && !fallback) {
    diagnostics.push({
      level: 'error',
      code: 'NO_PAY_ACTION',
      message:
        'Neither a payable UPI intent nor a hosted checkout URL could be found. Ask the bridge to return payment_url / token_url.',
    });
  }

  const declaredAmount = Number(
    firstField(walkResults.find((w) => w.layers.length > 0)?.layers[0]?.json, 'amount') ?? NaN,
  );
  if (Number.isFinite(declaredAmount) && declaredAmount > 0 && declaredAmount !== input.amountPaisa) {
    diagnostics.push({
      level: 'warn',
      code: 'TOKEN_AMOUNT_MISMATCH',
      message: `The gateway token says ${declaredAmount} paise but the order is ${input.amountPaisa} paise.`,
    });
  }

  if (input.requestedPgType !== input.pgType) {
    diagnostics.push({
      level: 'info',
      code: 'PG_ALIAS',
      message: `pg_type "${input.requestedPgType}" was mapped to "${input.pgType}".`,
    });
  }

  // ---- why is there no intent? -------------------------------------------
  const tokenWarnings = tokens.flatMap(({ source }) => analyzeToken(source.token).warnings);
  const encryptedNote =
    tokenWarnings.find((warning) => /encrypted/i.test(warning)) ??
    notes.find((note) => /encrypted/i.test(note));
  if (encryptedNote && !primaryIntent) {
    diagnostics.push({
      level: 'warn',
      code: 'TOKEN_ENCRYPTED',
      message: `${encryptedNote} Only PhonePe's checkout page can read it, so no intent can be extracted here.`,
    });
  }
  if (!primaryIntent && encryptedNote) {
    diagnostics.push({
      level: 'info',
      code: 'INTENT_ONLY_ON_PAGE',
      message:
        'The UPI intent lives inside the encrypted token, which only PhonePe\'s checkout page can read. ' +
        'Use the hosted payment_url (or the in-page modal) — an intent link cannot be derived from this ' +
        'response without the merchant UPI ID + signing key.',
    });
  }

  // ---- QR ----------------------------------------------------------------
  // Priority: the signed intent -> a UPI QR found in the payload -> the
  // gateway's own QR image (which on PhonePe redirect mode is just a link to
  // their hosted page, so we label it honestly instead of saying "scan to pay").
  let qr: QrView | null = null;
  const bridgeQrImage = urls.qrCode && urls.qrCode.startsWith('data:image/') ? urls.qrCode : null;
  const upiQrString = urls.qrString && isUpiIntent(urls.qrString) ? urls.qrString : null;
  const decodedQrIsIntent = input.decodedQr ? isUpiIntent(input.decodedQr.payload) : false;

  if (primaryIntent) {
    qr = {
      value: primaryIntent.raw,
      dataUrl: null,
      source: primaryIntent.source,
      kind: 'upi-intent',
      bridgeImage: bridgeQrImage,
    };
  } else if (decodedQrIsIntent && input.decodedQr) {
    qr = {
      value: input.decodedQr.payload,
      dataUrl: null,
      source: 'qr-image',
      kind: 'upi-intent',
      bridgeImage: bridgeQrImage,
    };
  } else if (upiQrString) {
    qr = { value: upiQrString, dataUrl: null, source: 'bridge-qr', kind: 'upi-intent', bridgeImage: bridgeQrImage };
  } else if (input.decodedQr && /^https?:\/\//i.test(input.decodedQr.payload)) {
    // The bridge's QR encodes its hosted checkout page: still useful (scan it on
    // a phone to finish there), but it is not a "scan to pay" UPI code.
    qr = {
      value: input.decodedQr.payload,
      dataUrl: bridgeQrImage,
      source: 'bridge-image',
      kind: 'checkout-url',
      bridgeImage: bridgeQrImage,
    };
    diagnostics.push({
      level: 'info',
      code: 'QR_IS_CHECKOUT_URL',
      message:
        'The bridge QR code contains the hosted checkout URL, not a UPI intent: scanning it opens ' +
        `${hostOf(input.decodedQr.payload)} rather than a payment app.`,
    });
  } else if (bridgeQrImage) {
    qr = { value: hostedUrl ?? '', dataUrl: bridgeQrImage, source: 'bridge-image', kind: 'checkout-url', bridgeImage: bridgeQrImage };
  }

  if (qr && !qr.dataUrl && !fitsInQr(qr.value)) {
    diagnostics.push({
      level: 'warn',
      code: 'QR_TOO_LONG',
      message: 'The intent is too long to encode as a scannable QR code; the hosted checkout is used instead.',
    });
  }

  // ---- decode report -----------------------------------------------------
  const merged = mergeWalkResults(...walkResults);
  const sources: DecodedSource[] = tokens.map(({ source, label }) => {
    const analysed = analyzeToken(source.token);
    return {
      label,
      origin: source.origin,
      tokenPreview: analysed.layers[0] ? `${source.token.slice(0, 18)}…${source.token.slice(-8)}` : source.token,
      tokenLength: source.token.length,
      layers: analysed.layers.length,
      intents: analysed.intents.length,
      fields: analysed.fields.length,
      errors: analysed.warnings,
    };
  });

  const fields: IndexedField[] = merged.fields.slice(0, 24);

  const plan: PayPlan = {
    ok: true,
    demo: input.demo,
    ...(input.demo && input.demoReason ? { demoReason: input.demoReason } : {}),
    pgType: input.pgType,
    txnId: input.txnId,
    amountPaisa: input.amountPaisa,
    amountLabel: formatInr(input.amountPaisa),
    createdAt: new Date().toISOString(),
    primary,
    fallback,
    intents: ranked,
    apps: primaryIntent ? buildAppActions(primaryIntent) : directApps,
    directUpi,
    needsUpiVpa: !input.directUpi?.vpa,
    qr,
    diagnostics,
    decode: {
      sources,
      fields,
      discoveredIntents: [...new Set(candidates.map((c) => c.raw))].slice(0, 12),
      notes,
    },
    hosted: {
      paymentUrl: urls.paymentUrl,
      pgPaymentUrl: urls.pgPaymentUrl,
      tokenUrl: urls.tokenUrl,
      customPaymentUrl: urls.customPaymentUrl,
      checkoutScript: urls.checkoutScript,
      canEmbed: Boolean(
        urls.checkoutScript &&
          (urls.tokenUrl ?? urls.paymentUrl) &&
          input.pgType !== 'easebuzz' &&
          !input.demo,
      ),
    },
  };

  return { plan, appActions: primaryIntent ? buildAppActions(primaryIntent) : [] };
}

export { paisaToAmount };
