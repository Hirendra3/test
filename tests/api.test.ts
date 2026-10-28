/**
 * HTTP-level tests: exercises the real Express app against a stubbed bridge,
 * so route wiring, validation, error mapping and return verification are all
 * covered without network access.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { BridgeError, type BridgeClient, type CollectRequest, type PageResult } from '../src/bridge/client.js';
import { base64UrlEncode } from '../src/lib/base64.js';

const SIGN = 'MEUCIQDf3k8Zq1nS7m2v9pXc4hRt6Lb0yAq5oJw8uVzNxGkQIgJ0d2Wq8yT1rP6mH4sC9fKb3nLz7Xe5vUa2oYq8RtM=';

function signedIntent(txn: string, amount = '499.00'): string {
  return `upi://pay?${new URLSearchParams({
    pa: 'jayamani@ybl',
    pn: 'Jayamani Collections',
    tr: txn,
    am: amount,
    cu: 'INR',
    mc: '5411',
    orgid: '159761',
    sign: SIGN,
  }).toString()}`;
}

function tokenFor(txn: string, amount = '499.00'): string {
  return base64UrlEncode(
    JSON.stringify({
      merchantId: 'MERCHANT123',
      merchantTransactionId: txn,
      amount: Number(amount.replace('.', '')),
      instrumentResponse: { type: 'UPI_INTENT', intentUrl: signedIntent(txn, amount) },
    }),
  );
}

interface StubOptions {
  collect?: (body: CollectRequest) => unknown;
  status?: (txnId: string) => unknown;
  session?: (txnId: string) => unknown;
  page?: PageResult;
}

function stubBridge(options: StubOptions = {}): BridgeClient {
  const config = loadConfig({});
  return {
    config,
    health: async () => ({
      status: 'ok',
      version: '1.0.0',
      enabled_pgs: ['phonepe', 'easebuzz'],
      pg_status: { phonepe: true, easebuzz: true },
    }),
    collect:
      options.collect ??
      (async (body: CollectRequest) => {
        const token = tokenFor(body.txn_id);
        return {
          payment_url: `https://mercury-t2.phonepe.com/transact/pgv3?token=${token}`,
          token_url: `https://mercury-t2.phonepe.com/transact/pgv3?token=${token}`,
          custom_payment_url: `https://example.test/pay/${body.txn_id}`,
          checkout_script: 'https://mercury.phonepe.com/web/bundle/checkout.js',
          phonepe_intent_url: `upi://pay?pa=merchant@upi&pn=Merchant&tr=${body.txn_id}&am=499.00&cu=INR`,
          pg_transaction_id: body.txn_id,
        };
      }),
    session:
      options.session ??
      (async (txnId: string) => ({
        txn_id: txnId,
        amount: 49900,
        payment_url: `https://mercury-t2.phonepe.com/transact/pgv3?token=${tokenFor(txnId)}`,
      })),
    status:
      options.status ??
      (async (txnId: string) => ({
        status: 'success',
        pg_transaction_id: txnId,
        amount: 49900,
        raw_pg_response: { state: 'COMPLETED', merchantOrderId: txnId, amount: 49900 },
      })),
    fetchPage:
      async (url: string) =>
        options.page ?? { url, finalUrl: url, status: 200, html: '<html></html>', error: null },
  };
}

function makeApp(overrides: StubOptions = {}, env: Record<string, string> = {}) {
  // Public dir needs an index.html for the SPA routes.
  const dir = mkdtempSync(path.join(tmpdir(), 'pb-app-'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>checkout</title>');

  const config = loadConfig({ DEMO_MODE: 'off', ...env });
  return createApp(config, stubBridge(overrides), { publicDir: dir });
}

const validOrder = {
  pg_type: 'phonepe',
  amount: 49900,
  customer_email: 'customer@example.com',
  customer_phone: '9876543210',
  payer_first_name: 'Rahul',
};

/* -------------------------------------------------------------------------- */

test('GET /api/health reports bridge + gateway status', async () => {
  const response = await request(makeApp()).get('/api/health').expect(200);
  assert.equal(response.body.app, 'ok');
  assert.equal(response.body.bridge.reachable, true);
  assert.deepEqual(response.body.bridge.payload.enabled_pgs, ['phonepe', 'easebuzz']);
});

test('POST /api/pay returns a signed intent as the primary action', async () => {
  const response = await request(makeApp())
    .post('/api/pay')
    .send({ ...validOrder, txn_id: 'ORDER_HTTP_1' })
    .expect(200);

  const plan = response.body;
  assert.equal(plan.ok, true);
  assert.equal(plan.txnId, 'ORDER_HTTP_1');
  assert.equal(plan.amountPaisa, 49900);
  assert.equal(plan.primary.kind, 'intent');
  assert.match(plan.primary.url, /^upi:\/\/pay\?/);
  assert.match(plan.primary.url, /sign=/);
  assert.equal(plan.hosted.canEmbed, true);
  assert.equal(plan.apps.length, 4);
  assert.ok(plan.qr.dataUrl?.startsWith('data:image/png;base64,'));
  assert.ok(plan.intents.some((i: { usable: boolean }) => !i.usable), 'templated link stays flagged');
  // never leak the templated intent as the pay button
  assert.doesNotMatch(plan.primary.url, /pa=merchant%40upi/);
});

test('POST /api/pay rejects bad input with field-level detail', async () => {
  const app = makeApp();

  const email = await request(app).post('/api/pay').send({ ...validOrder, customer_email: 'nope' }).expect(400);
  assert.equal(email.body.error.code, 'VALIDATION_ERROR');
  assert.ok(email.body.error.details.fieldErrors.customer_email);

  const phone = await request(app).post('/api/pay').send({ ...validOrder, customer_phone: '12345' }).expect(400);
  assert.equal(phone.body.error.code, 'INVALID_PHONE');

  const decimal = await request(app).post('/api/pay').send({ ...validOrder, amount: 499.5 }).expect(400);
  assert.equal(decimal.body.error.code, 'INVALID_AMOUNT');

  const tooSmall = await request(app).post('/api/pay').send({ ...validOrder, amount: 10 }).expect(400);
  assert.equal(tooSmall.body.error.code, 'INVALID_AMOUNT');

  const pg = await request(app).post('/api/pay').send({ ...validOrder, pg_type: 'paytm' }).expect(400);
  assert.equal(pg.body.error.code, 'UNSUPPORTED_PG');
  assert.match(pg.body.error.message, /paytm/);

  const json = await request(app)
    .post('/api/pay')
    .set('Content-Type', 'application/json')
    .send('{"amount":')
    .expect(400);
  assert.equal(json.body.error.code, 'INVALID_JSON');
});

test('POST /api/pay normalises phone numbers and derives a redirect_url', async () => {
  let captured: CollectRequest | null = null;
  const app = makeApp({
    collect: async (body) => {
      captured = body;
      return { payment_url: `https://mercury-t2.phonepe.com/x?token=${tokenFor(body.txn_id)}` };
    },
  });

  await request(app)
    .post('/api/pay')
    .send({ ...validOrder, customer_phone: '+91 98765 43210', txn_id: 'ORDER_HTTP_2' })
    .expect(200);

  assert.ok(captured);
  assert.equal(captured!.customer_phone, '9876543210');
  assert.equal(captured!.pg_type, 'phonepe');
  // supertest's default host is 127.0.0.1:<ephemeral>, so the derived origin
  // follows the request rather than a hardcoded localhost.
  assert.match(captured!.redirect_url, /^http:\/\/127\.0\.0\.1:\d+\/pay\/ORDER_HTTP_2$/);
});

test('POST /api/pay maps gateway failures to API errors', async () => {
  const app = makeApp({
    collect: async () => {
      throw new BridgeError('PG_NOT_CONFIGURED', 'PG type phonepe credentials are missing or unavailable.', 503);
    },
  });

  const response = await request(app).post('/api/pay').send(validOrder).expect(503);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error.code, 'PG_NOT_CONFIGURED');
  assert.match(response.body.error.message, /credentials/);
});

test('POST /api/pay falls back to a demo plan only when DEMO_MODE=auto', async () => {
  const failing = async () => {
    throw new BridgeError('BRIDGE_UNREACHABLE', 'Could not reach bridge.');
  };

  const auto = await request(makeApp({ collect: failing }, { DEMO_MODE: 'auto' }))
    .post('/api/pay')
    .send(validOrder)
    .expect(200);
  assert.equal(auto.body.demo, true);
  assert.equal(auto.body.primary.kind, 'intent');

  const off = await request(makeApp({ collect: failing }, { DEMO_MODE: 'off' }))
    .post('/api/pay')
    .send(validOrder)
    .expect(502);
  assert.equal(off.body.error.code, 'BRIDGE_UNREACHABLE');
});

test('GET /api/pay/:txnId resumes from the session API without a new order', async () => {
  let collected = 0;
  const app = makeApp({
    collect: async () => {
      collected += 1;
      throw new Error('collect must not be called when resuming');
    },
  });

  const response = await request(app).get('/api/pay/ORDER_RESUME_1?pg_type=phonepe').expect(200);
  assert.equal(collected, 0);
  assert.equal(response.body.txnId, 'ORDER_RESUME_1');
  assert.equal(response.body.primary.kind, 'intent');
  assert.equal(response.body.primary.url, signedIntent('ORDER_RESUME_1'));
});

test('GET /api/status normalises state and flags amount mismatches', async () => {
  const app = makeApp();

  const ok = await request(app).get('/api/status/ORDER_HTTP_1?pg_type=phonepe&amount=49900').expect(200);
  assert.equal(ok.body.status, 'success');
  assert.equal(ok.body.amountPaisa, 49900);
  assert.equal(ok.body.amountMatches, true);

  const mismatch = await request(app).get('/api/status/ORDER_HTTP_1?pg_type=phonepe&amount=1000').expect(200);
  assert.equal(mismatch.body.amountMatches, false);
  assert.ok(mismatch.body.diagnostics.some((d: { code: string }) => d.code === 'AMOUNT_MISMATCH'));

  const missing = await request(app).post('/api/status').send({ pg_type: 'phonepe' }).expect(400);
  assert.equal(missing.body.error.code, 'VALIDATION_ERROR');
});

test('POST /api/verify trusts the gateway, not the redirect claim', async () => {
  const app = makeApp({
    status: async (txnId) => ({ state: 'PENDING', merchantOrderId: txnId, amount: 49900 }),
  });

  const response = await request(app)
    .post('/api/verify')
    .send({ txn_id: 'ORDER_CLAIM_1', status: 'success', amount: 49900 })
    .expect(200);

  assert.equal(response.body.status, 'pending');
  assert.equal(response.body.verified, false);
  assert.match(response.body.message, /redirect claims "success"/);
});

test('POST /api/verify confirms a real success and amount', async () => {
  const response = await request(makeApp())
    .post('/api/verify')
    .send({ txn_id: 'ORDER_CONFIRM_1', pg_type: 'phonepe', amount: 49900 })
    .expect(200);

  assert.equal(response.body.verified, true);
  assert.equal(response.body.status, 'success');
  assert.equal(response.body.amountMatches, true);
  assert.match(response.body.message, /verified/i);
});

test('GET /api/verify/:txnId works for browser returns', async () => {
  const response = await request(makeApp())
    .get('/api/verify/ORDER_GET_1?status=success&pg_type=phonepe')
    .expect(200);
  assert.equal(response.body.txnId, 'ORDER_GET_1');
  assert.equal(response.body.verified, true);
});

test('POST /api/webhook/:pgType reads form-encoded gateway payloads', async () => {
  const response = await request(makeApp())
    .post('/api/webhook/easebuzz')
    .type('form')
    .send({ txnid: 'ORDER_HOOK_1', status: 'success', amount: '49900' })
    .expect(200);

  assert.equal(response.body.txnId, 'ORDER_HOOK_1');
  assert.equal(response.body.status, 'success');
  assert.equal(response.body.verified, true);

  const noTxn = await request(makeApp()).post('/api/webhook').send({}).expect(200);
  assert.equal(noTxn.body.ok, false);
});

test('gateway POST return redirects into the SPA with a verify flag', async () => {
  const response = await request(makeApp())
    .post('/pay/ORDER_RETURN_1')
    .type('form')
    .send({ txnid: 'ORDER_RETURN_1', status: 'success' })
    .expect(303);

  assert.equal(response.headers.location, '/pay/ORDER_RETURN_1?verify=1');
});

test('POST /api/decode explains a broken intent link', async () => {
  const response = await request(makeApp())
    .post('/api/decode')
    .send({ url: 'upi://pay?pa=merchant@upi&pn=Merchant%20Name&tr=ORDER_1001&am=499.00&cu=INR' })
    .expect(200);

  const intent = response.body.intents[0];
  assert.equal(intent.usable, false);
  assert.equal(intent.signed, false);
  assert.ok(intent.issues.some((i: { code: string }) => i.code === 'placeholder-vpa'));
  assert.ok(intent.issues.some((i: { code: string }) => i.code === 'unsigned-intent'));
});

test('POST /api/decode recovers the intent from a raw token', async () => {
  const response = await request(makeApp())
    .post('/api/decode')
    .send({ url: tokenFor('ORDER_TOKEN_1') })
    .expect(200);

  assert.equal(response.body.kind, 'token');
  assert.equal(response.body.intents[0].usable, true);
  assert.equal(response.body.intents[0].signed, true);
});

test('unknown API routes get a JSON 404 and CORS is present', async () => {
  const response = await request(makeApp()).get('/api/nope').expect(404);
  assert.equal(response.body.error.code, 'NOT_FOUND');
  assert.equal(response.headers['access-control-allow-origin'], '*');

  const preflight = await request(makeApp()).options('/api/pay').expect(204);
  assert.match(preflight.headers['access-control-allow-methods'] ?? '', /POST/);
});

test('SPA routes serve the checkout shell', async () => {
  for (const route of ['/', '/pay/ORDER_X', '/return', '/checkout']) {
    const response = await request(makeApp()).get(route).expect(200);
    assert.match(response.text, /checkout/);
  }
});

test('POST /api/decode explains an encrypted token instead of failing silently', async () => {
  const live = JSON.parse(
    readFileSync(new URL('./fixtures/live-phonepe-response.json', import.meta.url), 'utf8'),
  ) as Record<string, string>;
  const token = new URL(live.payment_url!).searchParams.get('token')!;

  const response = await request(makeApp()).post('/api/decode').send({ url: token }).expect(200);
  const codes = response.body.diagnostics.map((d: { code: string }) => d.code);
  assert.ok(codes.includes('TOKEN_ENCRYPTED'), `expected TOKEN_ENCRYPTED, got ${codes.join(',')}`);
  assert.equal(response.body.intents.length, 0);
  assert.match(
    response.body.diagnostics.find((d: { code: string }) => d.code === 'TOKEN_ENCRYPTED').message,
    /encrypted/i,
  );
});

test('POST /api/decode reads the bridge QR image and reports it is not a UPI QR', async () => {
  const live = JSON.parse(
    readFileSync(new URL('./fixtures/live-phonepe-response.json', import.meta.url), 'utf8'),
  ) as Record<string, string>;

  const response = await request(makeApp()).post('/api/decode').send({ url: live.qr_code }).expect(200);
  const codes = response.body.diagnostics.map((d: { code: string }) => d.code);
  assert.ok(codes.includes('QR_NOT_UPI'));
  assert.match(response.body.fields[0].value, /^https:\/\/mercury-t2\.phonepe\.com\/transact\/pgv3\?token=/);
  assert.equal(response.body.intents.length, 0);
});

test('redirect_url follows the host the browser used (LAN / mobile / preview)', async () => {
  let captured: CollectRequest | null = null;
  const app = makeApp({
    collect: async (body) => {
      captured = body;
      return { payment_url: `https://mercury-t2.phonepe.com/x?token=${tokenFor(body.txn_id)}` };
    },
  });

  await request(app)
    .post('/api/pay')
    .set('Host', '192.168.1.24:3000')
    .send({ ...validOrder, txn_id: 'ORDER_LAN_1' })
    .expect(200);
  assert.equal(captured!.redirect_url, 'http://192.168.1.24:3000/pay/ORDER_LAN_1');

  // behind a TLS proxy (the hosted preview) the scheme must be https
  await request(app)
    .post('/api/pay')
    .set('X-Forwarded-Host', '3000-abc123.e2b.app')
    .set('X-Forwarded-Proto', 'https')
    .send({ ...validOrder, txn_id: 'ORDER_PREVIEW_1' })
    .expect(200);
  assert.equal(captured!.redirect_url, 'https://3000-abc123.e2b.app/pay/ORDER_PREVIEW_1');
});

test('an explicit PUBLIC_BASE_URL still wins over the request host', async () => {
  let captured: CollectRequest | null = null;
  const app = makeApp(
    {
      collect: async (body) => {
        captured = body;
        return { payment_url: `https://mercury-t2.phonepe.com/x?token=${tokenFor(body.txn_id)}` };
      },
    },
    { PUBLIC_BASE_URL: 'https://shop.example.com' },
  );

  await request(app)
    .post('/api/pay')
    .set('Host', '192.168.1.24:3000')
    .send({ ...validOrder, txn_id: 'ORDER_FIXED_1' })
    .expect(200);

  assert.equal(captured!.redirect_url, 'https://shop.example.com/pay/ORDER_FIXED_1');
});
