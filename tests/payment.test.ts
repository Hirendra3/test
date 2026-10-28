import assert from 'node:assert/strict';
import test from 'node:test';

import { base64UrlEncode, tryDecodeJson } from '../src/lib/base64.js';
import { analyzeToken, extractTokensFromUrl, mineCheckoutPage, walk } from '../src/lib/tokenDecoder.js';
import { buildPayPlan } from '../src/lib/planner.js';
import {
  amountToPaisa,
  buildAppLink,
  evaluateIntent,
  isUpiIntentUrl,
  parseIntent,
  sanitizeScrapedUrl,
} from '../src/lib/upi.js';
import { normalizeStatus, extractAmountPaisa } from '../src/services/status.js';
import { normalizePgType, normalizePhone } from '../src/services/checkout.js';
import { normalizeBase64 } from '../src/lib/base64.js';

const SIGN = 'MEUCIQDf3k8Zq1nS7m2v9pXc4hRt6Lb0yAq5oJw8uVzNxGkQIgJ0d2Wq8yT1rP6mH4sC9fKb3nLz7Xe5vUa2oYq8RtM=';
const TXN = 'ORDER_1001';

function signedIntent(overrides: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    pa: 'jayamani@ybl',
    pn: 'Jayamani Collections',
    tr: TXN,
    tn: `Order ${TXN}`,
    am: '499.00',
    cu: 'INR',
    mc: '5411',
    mode: '04',
    orgid: '159761',
    sign: SIGN,
    ...overrides,
  });
  return `upi://pay?${params.toString()}`;
}

function phonePeToken(intentUrl: string, extra: Record<string, unknown> = {}): string {
  return base64UrlEncode(
    JSON.stringify({
      merchantId: 'MERCHANT123',
      merchantTransactionId: TXN,
      amount: 49900,
      currency: 'INR',
      expireAt: Date.now() + 600_000,
      instrumentResponse: { type: 'UPI_INTENT', intentUrl, qrData: intentUrl },
      ...extra,
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* UPI primitives                                                             */
/* -------------------------------------------------------------------------- */

test('amount conversion respects paise precision', () => {
  assert.equal(amountToPaisa('499.00'), 49900);
  assert.equal(amountToPaisa('1'), 100);
  assert.equal(amountToPaisa('0.99'), 99);
  assert.equal(amountToPaisa('499.999'), null);
  assert.equal(amountToPaisa('abc'), null);
  assert.equal(amountToPaisa(''), null);
});

test('parseIntent keeps the raw query byte-for-byte', () => {
  const raw = signedIntent();
  const parsed = parseIntent(raw);
  assert.ok(parsed);
  assert.equal(parsed.scheme, 'upi');
  assert.equal(parsed.host, 'pay');
  assert.equal(`upi://pay?${parsed.rawQuery}`, raw);
  assert.equal(parsed.params.sign, SIGN);
});

test('app links only swap the scheme, never re-sign or re-encode', () => {
  const raw = signedIntent();
  const parsed = parseIntent(raw);
  assert.ok(parsed);

  const phonepe = buildAppLink(parsed, 'phonepe');
  const gpay = buildAppLink(parsed, 'gpay');
  const paytm = buildAppLink(parsed, 'paytm');

  assert.ok(phonepe.startsWith('ppe://pay?'));
  assert.ok(gpay.startsWith('tez://upi/pay?'));
  assert.ok(paytm.startsWith('paytmmp://pay?'));

  const query = (value: string): string => value.slice(value.indexOf('?') + 1);
  assert.equal(query(phonepe), parsed.rawQuery);
  assert.equal(query(gpay), parsed.rawQuery);
  assert.equal(query(paytm), parsed.rawQuery);
  assert.match(phonepe, /sign=/);
});

test('HTML-escaped markup URLs are repaired without touching params', () => {
  const messy = 'upi://pay?pa=a%40b&amp;tr=X1&amp;am=10.00&amp;sign=abc%2Bdef%3D';
  assert.equal(
    sanitizeScrapedUrl(messy),
    'upi://pay?pa=a%40b&tr=X1&am=10.00&sign=abc%2Bdef%3D',
  );
  assert.ok(isUpiIntentUrl(sanitizeScrapedUrl(messy)));
});

test('placeholder intents are rejected, signed intents accepted', () => {
  const broken = evaluateIntent(
    'upi://pay?pa=merchant@upi&pn=Merchant%20Name&tr=ORDER_1001&am=499.00&cu=INR',
    { source: 'bridge-intent-url', trusted: false, expectedAmountPaisa: 49900, expectedTxnId: TXN },
  );
  assert.ok(broken);
  assert.equal(broken.usable, false);
  assert.equal(broken.signed, false);
  assert.ok(broken.issues.some((i) => i.code === 'placeholder-vpa'));
  assert.ok(broken.issues.some((i) => i.code === 'unsigned-intent'));

  const good = evaluateIntent(signedIntent(), {
    source: 'token',
    trusted: true,
    expectedAmountPaisa: 49900,
    expectedTxnId: TXN,
  });
  assert.ok(good);
  assert.equal(good.usable, true);
  assert.equal(good.signed, true);
  assert.equal(good.amountPaisa, 49900);
  assert.equal(good.txnId, TXN);
});

test('amount mismatches are blocking', () => {
  const intent = evaluateIntent(signedIntent({ am: '1.00' }), {
    source: 'token',
    trusted: true,
    expectedAmountPaisa: 49900,
  });
  assert.ok(intent);
  assert.equal(intent.usable, false);
  assert.ok(intent.issues.some((i) => i.code === 'amount-mismatch'));
});

/* -------------------------------------------------------------------------- */
/* token decoding                                                             */
/* -------------------------------------------------------------------------- */

test('base64 normalisation handles url-safe and unpadded input', () => {
  const encoded = base64UrlEncode(JSON.stringify({ a: 1 }));
  assert.ok(normalizeBase64(encoded));
  assert.deepEqual(tryDecodeJson(encoded)?.value, { a: 1 });
  assert.equal(normalizeBase64('!!!not-base64!!!'), null);
});

test('analyzeToken walks nested base64 layers', () => {
  const inner = phonePeToken(signedIntent());
  const outer = base64UrlEncode(JSON.stringify({ payload: inner, merchantId: 'M1' }));

  const result = analyzeToken(outer);
  assert.equal(result.layers.length, 2, 'root + nested payload should both decode');
  assert.equal(result.intents.length, 1);
  const fieldKeys = result.fields.map((f) => f.key.toLowerCase());
  assert.ok(fieldKeys.includes('merchantid'));
  assert.ok(fieldKeys.includes('amount'));
});

test('tokens are extracted from a payment_url', () => {
  const token = phonePeToken(signedIntent());
  const url = `https://mercury-t2.phonepe.com/transact/pgv3?token=${token}`;
  const found = extractTokensFromUrl(url);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.token, token);

  const analysed = analyzeToken(found[0]!.token);
  assert.equal(analysed.intents[0]?.raw, signedIntent());
});

test('checkout pages are mined for escaped intents and tokens', () => {
  const intent = signedIntent();
  const token = phonePeToken(intent);
  const html = `
    <html><body>
      <script>window.__DATA__ = {"token":"${token}"}</script>
      <a href="${intent.replace(/&/g, '&amp;')}">pay</a>
    </body></html>`;

  const mined = mineCheckoutPage(html);
  assert.ok(mined.tokens.length >= 1);
  assert.ok(mined.intents.some((i) => i.raw === intent));
});

test('walk finds an intent nested in arrays', () => {
  const intent = signedIntent();
  const result = walk({ data: [{ links: [{ url: intent }] }] });
  assert.equal(result.intents[0]?.raw, intent);
  assert.equal(result.intents[0]?.path, '$.data[0].links[0].url');
});

/* -------------------------------------------------------------------------- */
/* planner                                                                    */
/* -------------------------------------------------------------------------- */

function collectPayload(options: { includeSignedToken?: boolean } = {}): Record<string, unknown> {
  const signed = signedIntent();
  const token = phonePeToken(options.includeSignedToken === false ? 'upi://pay?pa=x' : signed);
  const hosted = `https://mercury-t2.phonepe.com/transact/pgv3?token=${token}`;

  return {
    payment_url: hosted,
    pg_payment_url: hosted,
    token_url: hosted,
    custom_payment_url: `https://www.jayamanicollections.com/pay/${TXN}`,
    checkout_script: 'https://mercury.phonepe.com/web/bundle/checkout.js',
    // The classic broken field: templated payee, no signature.
    phonepe_intent_url: `upi://pay?pa=merchant@upi&pn=Merchant%20Name&tr=${TXN}&am=499.00&cu=INR`,
    upi_intent_url: `upi://pay?pa=merchant@upi&pn=Merchant%20Name&tr=${TXN}&am=499.00&cu=INR`,
    qr_string: `upi://pay?pa=merchant@upi&pn=Merchant%20Name&tr=${TXN}&am=499.00&cu=INR`,
    pg_transaction_id: TXN,
    mode: 'intent',
  };
}

test('planner prefers the signed intent decoded from the token', () => {
  const { plan } = buildPayPlan({
    pgType: 'phonepe',
    requestedPgType: 'phonepe',
    txnId: TXN,
    amountPaisa: 49900,
    collectPayload: collectPayload(),
    pages: [],
    sessionPayload: null,
    demo: false,
    demoReason: null,
  });

  assert.equal(plan.primary?.kind, 'intent');
  assert.equal(plan.primary?.url, signedIntent());
  const primaryIntent = plan.intents.find((i) => i.isPrimary);
  assert.equal(primaryIntent?.source, 'token');
  assert.equal(primaryIntent?.signed, true);

  // the templated bridge links are kept, but flagged
  const broken = plan.intents.filter((i) => !i.usable);
  assert.ok(broken.length >= 1);
  assert.ok(broken.every((i) => !i.signed));

  // a hosted checkout is always available as a second option
  assert.equal(plan.fallback?.kind, 'hosted');
  assert.match(plan.fallback?.url ?? '', /mercury-t2\.phonepe\.com/);

  // app links carry the signature through
  assert.match(plan.apps.find((a) => a.app === 'phonepe')?.url ?? '', /^ppe:\/\/pay\?.*sign=/);
  assert.match(plan.apps.find((a) => a.app === 'gpay')?.url ?? '', /^tez:\/\/upi\/pay\?.*sign=/);

  assert.equal(plan.qr?.source, 'token');
  assert.ok(plan.decode.sources.length >= 1);
  assert.ok(plan.decode.fields.some((f) => f.key === 'amount'));
});

test('planner never promotes an unsigned intent and falls back to hosted checkout', () => {
  const payload = {
    payment_url: 'https://pay.easebuzz.in/pay/ABC123',
    phonepe_intent_url: `upi://pay?pa=merchant@upi&pn=Merchant&tr=${TXN}&am=499.00&cu=INR`,
  };

  const { plan } = buildPayPlan({
    pgType: 'easebuzz',
    requestedPgType: 'easebuzz',
    txnId: TXN,
    amountPaisa: 49900,
    collectPayload: payload,
    pages: [],
    sessionPayload: null,
    demo: false,
    demoReason: null,
  });

  assert.equal(plan.primary?.kind, 'hosted');
  assert.equal(plan.fallback?.kind, 'hosted');
  assert.ok(plan.diagnostics.some((d) => d.code === 'INTENT_UNPAYABLE'));
  // A broken intent is never rendered as a QR either.
  assert.equal(plan.qr, null);
});

test('planner reads intents out of a fetched checkout page', () => {
  const html = `<script>var d={"intentUrl":"${signedIntent().replace(/&/g, '&amp;')}"}</script>`;
  const { plan } = buildPayPlan({
    pgType: 'phonepe',
    requestedPgType: 'phonepe',
    txnId: TXN,
    amountPaisa: 49900,
    collectPayload: { payment_url: 'https://mercury-t2.phonepe.com/transact/pgv3?token=abc' },
    pages: [{ url: 'https://mercury-t2.phonepe.com/x', finalUrl: 'https://mercury-t2.phonepe.com/x', status: 200, html, error: null }],
    sessionPayload: null,
    demo: false,
    demoReason: null,
  });

  assert.equal(plan.primary?.kind, 'intent');
  assert.equal(plan.intents.find((i) => i.isPrimary)?.source, 'payment-page');
});

test('planner still produces a usable plan for an empty payload', () => {
  const { plan } = buildPayPlan({
    pgType: 'phonepe',
    requestedPgType: 'phonepe',
    txnId: TXN,
    amountPaisa: 49900,
    collectPayload: {},
    pages: [],
    sessionPayload: null,
    demo: true,
    demoReason: 'bridge offline',
  });

  assert.equal(plan.primary, null);
  assert.ok(plan.diagnostics.some((d) => d.code === 'NO_PAY_ACTION'));
  assert.ok(plan.diagnostics.some((d) => d.code === 'DEMO_PLAN'));
});

/* -------------------------------------------------------------------------- */
/* status + helpers                                                           */
/* -------------------------------------------------------------------------- */

test('status normalisation understands both gateways', () => {
  assert.equal(normalizeStatus({ state: 'COMPLETED' }), 'success');
  assert.equal(normalizeStatus({ data: { transactionState: 'TXN_SUCCESS' } }), 'success');
  assert.equal(normalizeStatus({ status: 'TXN_FAILURE' }), 'failed');
  assert.equal(normalizeStatus({ state: 'PENDING' }), 'pending');
  assert.equal(normalizeStatus({ success: true }), 'success');
  assert.equal(normalizeStatus({}), 'unknown');
  assert.equal(normalizeStatus(null), 'unknown');
});

test('amount extraction understands paise and rupees', () => {
  assert.equal(extractAmountPaisa({ amount: 49900 }), 49900);
  assert.equal(extractAmountPaisa({ amount_paisa: 25000 }), 25000);
  assert.equal(extractAmountPaisa({ amount: 499.5 }), 49950);
  assert.equal(extractAmountPaisa({}), null);
});

test('pg type aliases and phone normalisation', () => {
  assert.equal(normalizePgType('phonepe_v2'), 'phonepe');
  assert.equal(normalizePgType('PhonePe'), 'phonepe');
  assert.equal(normalizePgType('easebuzz'), 'easebuzz');
  assert.equal(normalizePgType('paytm'), 'phonepe');

  assert.equal(normalizePhone('9876543210'), '9876543210');
  assert.equal(normalizePhone('+91 98765 43210'), '9876543210');
  assert.equal(normalizePhone('09876543210'), '9876543210');
  assert.equal(normalizePhone('12345'), null);
});

/* -------------------------------------------------------------------------- */
/* Live PhonePe "redirect" response (encrypted token + non-UPI QR)            */
/* -------------------------------------------------------------------------- */

import { readFileSync } from 'node:fs';
import { decodeQrDataUrl, decodeQrImage, parseImageDataUrl } from '../src/lib/qrDecode.js';
import { inspectToken } from '../src/lib/base64.js';

const liveResponse = JSON.parse(
  readFileSync(new URL('./fixtures/live-phonepe-response.json', import.meta.url), 'utf8'),
) as Record<string, string>;

const liveQrPng = readFileSync(new URL('./fixtures/qr.b64', import.meta.url), 'utf8');

test('live token is recognised as encrypted, not as broken JSON', () => {
  const token = new URL(liveResponse.payment_url!).searchParams.get('token')!;
  assert.ok(token.length > 400);

  const inspection = inspectToken(token);
  assert.ok(inspection);
  assert.equal(inspection.opaque, true, 'binary/AES token must be flagged opaque');
  assert.ok(inspection.bytes > 200);

  // it must not be mistaken for decodable JSON
  assert.equal(tryDecodeJson(token), null);

  const analysed = analyzeToken(token);
  assert.equal(analysed.intents.length, 0);
  assert.equal(analysed.layers.length, 0);
  assert.ok(analysed.warnings.some((w) => /encrypted/i.test(w)));
});

test('the bridge QR image decodes to the hosted checkout URL, not a UPI intent', () => {
  const image = parseImageDataUrl(`data:image/png;base64,${liveQrPng.trim()}`);
  assert.ok(image);

  const decoded = decodeQrImage(image);
  assert.ok(decoded, 'QR must decode');
  assert.equal(decoded.kind, 'checkout-url');
  assert.match(decoded.payload, /^https:\/\/mercury-t2\.phonepe\.com\/transact\/pgv3\?token=/);

  const viaDataUrl = decodeQrDataUrl(liveResponse.qr_code!);
  assert.equal(viaDataUrl?.payload, decoded.payload);
});

test('planner falls back to hosted checkout for the live redirect response', () => {
  const { plan } = buildPayPlan({
    pgType: 'phonepe',
    requestedPgType: 'phonepe',
    txnId: 'ORDER_75781799',
    amountPaisa: 49900,
    collectPayload: liveResponse,
    decodedQr: decodeQrDataUrl(liveResponse.qr_code!).kind === 'upi-intent'
      ? { payload: decodeQrDataUrl(liveResponse.qr_code!)!.payload, method: 'direct' }
      : {
          payload: decodeQrDataUrl(liveResponse.qr_code!)?.payload ?? '',
          method: 'resampled',
        },
    pages: [],
    sessionPayload: null,
    demo: false,
    demoReason: null,
  });

  // no intent anywhere -> the payable action is the hosted page, never a guess
  assert.equal(plan.primary?.kind, 'hosted');
  assert.equal(plan.primary?.url, liveResponse.payment_url);
  assert.equal(plan.intents.length, 0);
  assert.equal(plan.apps.length, 0);

  // the QR is kept, but described as a checkout QR
  assert.equal(plan.qr?.kind, 'checkout-url');
  assert.equal(plan.qr?.source, 'bridge-image');
  assert.ok(plan.qr?.bridgeImage?.startsWith('data:image/png'));

  // and the report explains exactly why there is no intent
  assert.ok(plan.diagnostics.some((d) => d.code === 'QR_IS_CHECKOUT_URL'));
  assert.ok(plan.diagnostics.some((d) => d.code === 'TOKEN_ENCRYPTED'));
  assert.ok(plan.diagnostics.some((d) => d.code === 'INTENT_ONLY_ON_PAGE'));
  assert.ok(plan.diagnostics.some((d) => d.code === 'NO_PAY_ACTION') === false);
});

test('a UPI intent inside the QR image is used when one exists', () => {
  const { plan } = buildPayPlan({
    pgType: 'phonepe',
    requestedPgType: 'phonepe',
    txnId: TXN,
    amountPaisa: 49900,
    collectPayload: { payment_url: `https://mercury-t2.phonepe.com/x?token=${phonePeToken(signedIntent())}` },
    decodedQr: { payload: signedIntent(), method: 'direct' },
    pages: [],
    sessionPayload: null,
    demo: false,
    demoReason: null,
  });

  assert.equal(plan.primary?.kind, 'intent');
  assert.equal(plan.qr?.kind, 'upi-intent');
  assert.ok(plan.intents.some((i) => i.source === 'qr-image' || i.source === 'token'));
});
