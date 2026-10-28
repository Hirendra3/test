/**
 * Demo payloads.
 *
 * Used only when DEMO_MODE allows it and the bridge is unreachable / a gateway
 * has no credentials. The shape is byte-for-byte what the real bridge returns
 * for PhonePe (nested base64url token containing a *signed* UPI intent), so the
 * decoder and the checkout UI are exercised end to end without live money.
 */

import { randomBytes } from 'node:crypto';
import { base64UrlEncode } from './lib/base64.js';
import type { CollectRequest } from './bridge/client.js';

function sign(): string {
  // 48 random bytes -> 64 base64url chars, same length/shape as a UPI signature.
  return base64UrlEncode(randomBytes(48));
}

function intent(params: Record<string, string>): string {
  return `upi://pay?${new URLSearchParams(params).toString()}`;
}

export function buildDemoCollectResponse(body: CollectRequest): Record<string, unknown> {
  const amount = (body.amount / 100).toFixed(2);
  const vpa = 'demo.store@ybl';

  const signedIntent = intent({
    pa: vpa,
    pn: 'Demo Store (SANDBOX)',
    tr: body.txn_id,
    tn: `Order ${body.txn_id}`,
    am: amount,
    cu: 'INR',
    mc: '5411',
    mode: '04',
    orgid: '159761',
    sign: sign(),
  });

  const tokenPayload = {
    merchantId: 'DEMOMERCHANT',
    merchantTransactionId: body.txn_id,
    amount: body.amount,
    currency: 'INR',
    expireAt: Date.now() + 10 * 60 * 1000,
    storeId: 'DEMOSTORE',
    terminalId: 'TERM01',
    instrumentResponse: {
      type: 'UPI_INTENT',
      intentUrl: signedIntent,
      qrData: signedIntent,
      redirectInfo: { url: body.redirect_url, method: 'GET' },
    },
    redirectUrl: body.redirect_url,
  };

  const token = base64UrlEncode(JSON.stringify(tokenPayload));
  const hostedUrl = `https://mercury-t2.phonepe.com/transact/pgv3?token=${token}`;

  if (body.pg_type === 'easebuzz') {
    return {
      demo: true,
      pg_type: 'easebuzz',
      pg_transaction_id: body.txn_id,
      payment_url: `https://pay.easebuzz.in/pay/DEMO${body.txn_id}`,
      custom_payment_url: `https://demo.local/pay/${encodeURIComponent(body.txn_id)}`,
      status: 'initiated',
    };
  }

  return {
    demo: true,
    pg_type: 'phonepe',
    pg_transaction_id: body.txn_id,
    payment_url: hostedUrl,
    pg_payment_url: hostedUrl,
    token_url: hostedUrl,
    custom_payment_url: `https://demo.local/pay/${encodeURIComponent(body.txn_id)}`,
    checkout_script: 'https://mercury.phonepe.com/web/bundle/checkout.js',
    qr_string: signedIntent,
    // Deliberately shows the failure mode this project documents: a hand-built
    // intent with placeholders instead of the gateway-signed one.
    phonepe_intent_url: intent({
      pa: 'merchant@upi',
      pn: 'Merchant Name',
      tr: body.txn_id,
      am: amount,
      cu: 'INR',
    }),
    upi_intent_url: signedIntent,
    mode: 'intent',
    sandbox: true,
  };
}

export function buildDemoStatusResponse(txnId: string, pgType: string): Record<string, unknown> {
  return {
    demo: true,
    status: 'pending',
    pg_transaction_id: txnId,
    pg_type: pgType,
    amount: null,
    raw_pg_response: {
      state: 'PENDING',
      merchantOrderId: txnId,
      note: 'Sandbox response — the live bridge is not reachable, so no real payment exists for this order.',
    },
  };
}
