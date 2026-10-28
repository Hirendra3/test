#!/usr/bin/env node
/**
 * Mock bridge for offline development.
 *
 * Replays a real PhonePe "redirect"-mode collect response — encrypted token,
 * QR image that is only a checkout URL, no intent fields — so the checkout can be
 * exercised against the shape live traffic actually produces.
 *
 *   node scripts/mock-bridge.mjs            # http://localhost:4010/api/bridge/v1
 *   BRIDGE_BASE_URL=http://localhost:4010 npm run dev
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.MOCK_PORT ?? 4010);
const PREFIX = '/api/bridge/v1';
const fixture = JSON.parse(
  readFileSync(new URL('../tests/fixtures/live-phonepe-response.json', import.meta.url), 'utf8'),
);

const log = (...args) => console.log('[mock-bridge]', ...args);

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname.replace(PREFIX, '') || '/';
  log(req.method, url.pathname + url.search);

  if (path === '/health') {
    json(res, 200, {
      status: 'ok',
      version: '1.0.0',
      enabled_pgs: ['phonepe', 'phonepe_v2', 'easebuzz'],
      pg_status: { phonepe: true, phonepe_v2: true, easebuzz: true },
    });
    return;
  }

  if (path === '/collect' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      let txnId = 'ORDER_75781799';
      try {
        txnId = JSON.parse(body).txn_id ?? txnId;
      } catch {
        /* keep default */
      }
      json(res, 200, {
        ...fixture,
        custom_payment_url: `http://localhost:${PORT}/merchant/pay/${txnId}`,
        pg_transaction_id: txnId,
      });
    });
    return;
  }

  if (path === '/session') {
    json(res, 200, {
      txn_id: url.searchParams.get('txn_id') ?? 'ORDER_75781799',
      amount: 49900,
      payment_url: fixture.payment_url,
      token_url: fixture.token_url,
      qr_code: fixture.qr_code,
      mode: fixture.mode,
    });
    return;
  }

  if (path === '/status') {
    json(res, 200, {
      status: 'pending',
      pg_transaction_id: 'ORDER_75781799',
      amount: 49900,
      raw_pg_response: { state: 'PENDING', merchantOrderId: 'ORDER_75781799', amount: 49900 },
    });
    return;
  }

  // The merchant's own return page (referenced by custom_payment_url).
  if (path.startsWith('/merchant/pay/')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Merchant pay page</title><p>No UPI intent is rendered on this page.</p>');
    return;
  }

  json(res, 404, { error: `no mock route for ${req.method} ${url.pathname}` });
});

server.listen(PORT, '0.0.0.0', () => {
  log(`listening on http://localhost:${PORT}${PREFIX}`);
  log('replaying an encrypted-token PhonePe response (no intent fields)');
});
