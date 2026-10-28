/**
 * DOM smoke test: boot the real checkout bundle inside jsdom, submit the form
 * against a stubbed API, and assert the pay button/QR/diagnostics render.
 * This catches runtime breakage that type-checking cannot see.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { base64UrlEncode } from '../src/lib/base64.js';
import { buildPayPlan } from '../src/lib/planner.js';

const SIGN = 'MEUCIQDf3k8Zq1nS7m2v9pXc4hRt6Lb0yAq5oJw8uVzNxGkQIgJ0d2Wq8yT1rP6mH4sC9fKb3nLz7Xe5vUa2oYq8RtM=';

function fixturePlan() {
  const txn = 'ORDER_UI_1';
  const intent = `upi://pay?${new URLSearchParams({
    pa: 'jayamani@ybl',
    pn: 'Jayamani Collections',
    tr: txn,
    am: '499.00',
    cu: 'INR',
    mc: '5411',
    orgid: '159761',
    sign: SIGN,
  }).toString()}`;

  const token = base64UrlEncode(
    JSON.stringify({
      merchantId: 'MERCHANT123',
      merchantTransactionId: txn,
      amount: 49900,
      instrumentResponse: { type: 'UPI_INTENT', intentUrl: intent },
    }),
  );

  const { plan } = buildPayPlan({
    pgType: 'phonepe',
    requestedPgType: 'phonepe',
    txnId: txn,
    amountPaisa: 49900,
    collectPayload: {
      payment_url: `https://mercury-t2.phonepe.com/transact/pgv3?token=${token}`,
      token_url: `https://mercury-t2.phonepe.com/transact/pgv3?token=${token}`,
      checkout_script: 'https://mercury.phonepe.com/web/bundle/checkout.js',
      phonepe_intent_url: `upi://pay?pa=merchant@upi&pn=Merchant&tr=${txn}&am=499.00&cu=INR`,
    },
    pages: [],
    sessionPayload: null,
    demo: false,
    demoReason: null,
  });

  // The HTTP layer renders the QR (qrcode.toDataURL); mirror that here.
  if (plan.qr) plan.qr.dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

  return plan;
}

test('checkout UI renders a working pay button from the decoded token', async () => {
  const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost:3000/', pretendToBeVisual: true });
  const { window } = dom;
  const plan = fixturePlan();

  // jsdom lacks these; the app uses them for smooth scrolling and storage.
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };

  const calls: string[] = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const json = (body: unknown): Response =>
      ({
        ok: true,
        status: 200,
        json: async () => body,
      }) as unknown as Response;

    if (url.startsWith('/api/health')) {
      return json({
        app: 'ok',
        bridge: {
          reachable: true,
          latencyMs: 120,
          error: null,
          payload: { enabled_pgs: ['phonepe', 'easebuzz'], pg_status: {} },
          missingGateways: [],
        },
        demoMode: 'off',
      });
    }
    if (url.startsWith('/api/pay')) return json(plan);
    if (url.startsWith('/api/verify')) {
      return json({
        ok: true,
        verified: true,
        txnId: plan.txnId,
        claimedStatus: 'success',
        status: 'success',
        amountPaisa: 49900,
        amountMatches: true,
        demo: false,
        message: 'Payment verified with the gateway.',
      });
    }
    if (url.startsWith('/api/status')) {
      return json({
        ok: true,
        pgType: 'phonepe',
        txnId: plan.txnId,
        status: 'success',
        amountPaisa: 49900,
        amountMatches: true,
        raw: {},
        diagnostics: [],
      });
    }
    return json({});
  };

  const define = (key: string, value: unknown): void => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };

  define('window', window);
  define('document', window.document);
  define('localStorage', storage);
  define('sessionStorage', storage);
  define('MutationObserver', window.MutationObserver);
  define('FormData', window.FormData);
  define('HTMLElement', window.HTMLElement);
  define('Element', window.Element);
  define('Event', window.Event);
  define('location', window.location);
  define('history', window.history);
  define('fetch', fakeFetch);

  await import('../src/public/app.js');
  await new Promise((resolve) => setTimeout(resolve, 20));

  const form = window.document.querySelector('#pay-form') as HTMLFormElement;
  assert.ok(form, 'form should exist');
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 60));

  const body = window.document.querySelector('#plan-body') as HTMLElement;
  assert.equal(body.hidden, false, 'plan panel should be visible');

  const payLink = body.querySelector('a.pay-btn') as HTMLAnchorElement;
  assert.ok(payLink, 'a pay button should be rendered');
  assert.match(payLink.getAttribute('href') ?? '', /^upi:\/\/pay\?/);
  assert.match(payLink.getAttribute('href') ?? '', /sign=/);

  assert.equal(body.querySelectorAll('.app-link').length, 4, 'four app buttons');
  assert.ok(body.querySelector('.qr-block img'), 'QR image should render');
  assert.match(body.textContent ?? '', /₹499\.00/);
  assert.ok(body.querySelectorAll('.diag[data-level="error"]').length >= 1, 'broken intent is reported');
  assert.ok(body.querySelectorAll('.tab-btn').length === 4);

  // in-page PhonePe modal button is offered when the plan allows embedding
  const embed = body.querySelector<HTMLButtonElement>('#embed-pay');
  assert.ok(embed, 'in-page checkout button should render when canEmbed is true');

  // tabs switch panels
  const intentsTab = [...body.querySelectorAll<HTMLButtonElement>('.tab-btn')].find(
    (button) => button.dataset.tab === 'intents',
  );
  intentsTab?.click();
  const intentsPanel = body.querySelector('.tab-panel[data-panel="intents"]') as HTMLElement;
  assert.equal(intentsPanel.hidden, false);
  assert.ok(intentsPanel.querySelectorAll('.intent-card').length >= 2);

  // copy buttons + status polling hooks are wired without throwing
  const copyButton = intentsPanel.querySelector<HTMLButtonElement>('[data-copy]');
  copyButton?.click();

  // form error path
  const fetchSpy = globalThis.fetch;
  define('fetch', async () =>
    ({
      ok: false,
      status: 503,
      json: async () => ({ ok: false, error: { code: 'PG_NOT_CONFIGURED', message: 'credentials missing' } }),
    }) as unknown as Response);
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 40));
  const errorBox = window.document.querySelector('#form-error') as HTMLElement;
  assert.equal(errorBox.hidden, false);
  assert.match(errorBox.textContent ?? '', /PG_NOT_CONFIGURED/);
  define('fetch', fetchSpy);

  // embed click with no PhonePe script available must degrade, not throw
  embed?.click();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const tracker = window.document.querySelector('#pay-tracker') as HTMLElement;
  assert.equal(tracker.hidden, false, 'tracker should report the embed attempt');
  assert.ok((tracker.textContent ?? '').length > 0);

  assert.ok(calls.some((call) => call.includes('/api/health')));
  window.close();
});

test('return URL renders a gateway-verified banner', async () => {
  const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8');
  const plan = fixturePlan();

  const dom = new JSDOM(html, {
    url: `http://localhost:3000/pay/${plan.txnId}?verify=1&status=success&pg_type=phonepe`,
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};

  const define = (key: string, value: unknown): void => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };

  define('window', window);
  define('document', window.document);
  define('location', window.location);
  define('history', window.history);
  define('MutationObserver', window.MutationObserver);
  define('FormData', window.FormData);
  define('HTMLElement', window.HTMLElement);
  define('Element', window.Element);
  define('Event', window.Event);
  define('fetch', async (input: string | URL | Request) => {
    const url = String(input);
    const json = (body: unknown): Response =>
      ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

    if (url.startsWith('/api/verify')) {
      return json({
        ok: true,
        verified: true,
        txnId: plan.txnId,
        claimedStatus: 'success',
        status: 'success',
        amountPaisa: 49900,
        amountMatches: true,
        demo: false,
        message: 'Payment verified with the gateway.',
      });
    }
    if (url.startsWith('/api/pay')) return json(plan);
    if (url.startsWith('/api/health')) {
      return json({
        app: 'ok',
        bridge: { reachable: true, latencyMs: 90, error: null, payload: {}, missingGateways: [] },
        demoMode: 'off',
      });
    }
    return json({});
  });

  await import('../src/public/app.js?return=1');
  await new Promise((resolve) => setTimeout(resolve, 80));

  const banner = window.document.querySelector('#verify-banner') as HTMLElement;
  assert.equal(banner.hidden, false, 'verification banner should be visible');
  assert.match(banner.textContent ?? '', /Payment verified/);
  assert.match(banner.textContent ?? '', /Redirect claimed/);
  assert.match(banner.textContent ?? '', /₹499\.00/);

  const tracker = window.document.querySelector('#pay-tracker') as HTMLElement;
  assert.equal(tracker.dataset.state, 'success');
  window.close();
});
