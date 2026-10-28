/**
 * Gateway return / webhook handling.
 *
 * A redirect back from PhonePe or Easebuzz is a *hint*, never proof: the
 * customer's browser (or anyone with curl) controls every query parameter.
 * So we throw the incoming payload away except for the order reference, then
 * ask the bridge for the authoritative status and compare the amount.
 */

import type { Config } from '../config.js';
import type { BridgeClient } from '../bridge/client.js';
import { fetchPaymentStatus } from './status.js';
import type { StatusResult } from '../lib/types.js';

export interface ReturnHint {
  txnId: string | null;
  pgType: string | null;
  claimedStatus: string | null;
  amountPaisa: number | null;
}

const TXN_KEYS = [
  'txn_id',
  'txnid',
  'txnId',
  'order_id',
  'orderid',
  'merchantTransactionId',
  'merchant_order_id',
  'pg_txn_id',
  'pgTransactionId',
  'transaction_id',
  'txn_id_pg',
];

const TYPE_KEYS = ['pg_type', 'pgtype', 'pg', 'gateway'];

const STATUS_KEYS = ['status', 'state', 'txn_status', 'payment_status', 'result', 'status_message'];

const AMOUNT_KEYS = ['amount', 'txn_amount', 'amount_paisa', 'amountPaisa', 'total_amount'];

function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value) && value.length > 0) return asString(value[0]);
  return null;
}

function firstOf(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = asString(source[key]);
    if (value) return value;
  }
  // Case-insensitive fallback: gateways are inconsistent about casing.
  const lowerMap = new Map(Object.keys(source).map((key) => [key.toLowerCase(), key]));
  for (const key of keys) {
    const actual = lowerMap.get(key.toLowerCase());
    if (!actual) continue;
    const value = asString(source[actual]);
    if (value) return value;
  }
  return null;
}

function parseAmount(value: string | null): number | null {
  if (!value) return null;
  const numeric = Number(value.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Number.isInteger(numeric) ? numeric : Math.round(numeric * 100);
}

export function readReturnHint(payload: Record<string, unknown>, pathTxnId?: string): ReturnHint {
  return {
    txnId: firstOf(payload, TXN_KEYS) ?? pathTxnId ?? null,
    pgType: firstOf(payload, TYPE_KEYS),
    claimedStatus: firstOf(payload, STATUS_KEYS),
    amountPaisa: parseAmount(firstOf(payload, AMOUNT_KEYS)),
  };
}

export interface VerifyResult {
  ok: true;
  verified: boolean;
  txnId: string;
  claimedStatus: string | null;
  status: StatusResult['status'];
  amountPaisa: number | null;
  amountMatches: boolean | null;
  demo: boolean;
  checkedAt: string;
  /** What to tell the customer. Never derived from the redirect alone. */
  message: string;
}

const TERMINAL = new Set(['success', 'failed']);

export async function verifyReturn(
  deps: { config: Config; bridge: BridgeClient },
  hint: ReturnHint & { expectedAmountPaisa?: number | null },
): Promise<VerifyResult> {
  if (!hint.txnId) {
    throw new Error('No order reference (txn_id) in the return payload.');
  }

  const result = await fetchPaymentStatus(
    deps,
    hint.txnId,
    hint.pgType ?? undefined,
    hint.expectedAmountPaisa ?? null,
  );

  const verified = TERMINAL.has(result.status) && result.amountMatches !== false;
  const demo = Boolean(result.demo);

  let message: string;
  if (result.status === 'success' && result.amountMatches === false) {
    message = 'The gateway reports success, but the paid amount does not match this order. Do not fulfil.';
  } else if (result.status === 'success') {
    message = 'Payment verified with the gateway.';
  } else if (result.status === 'failed') {
    message = 'The gateway reports this payment as failed or cancelled.';
  } else if (result.status === 'pending') {
    message = 'The gateway has not confirmed this payment yet. Keep polling.';
  } else {
    message = 'The gateway returned an unrecognised state. Check raw_pg_response.';
  }

  if (hint.claimedStatus) {
    const claimed = hint.claimedStatus.toLowerCase();
    const claimedSuccess = /success|completed|paid/.test(claimed);
    const claimedFailure = /fail|cancel|reject|drop/.test(claimed);
    if (claimedSuccess && result.status !== 'success') {
      message = `The redirect claims "${hint.claimedStatus}" but the gateway says ${result.status}. Trust the gateway.`;
    } else if (claimedFailure && result.status === 'success') {
      message = `The redirect claims "${hint.claimedStatus}" but the gateway confirms success. Trust the gateway.`;
    }
  }

  return {
    ok: true,
    verified,
    txnId: hint.txnId,
    claimedStatus: hint.claimedStatus,
    status: result.status,
    amountPaisa: result.amountPaisa,
    amountMatches: result.amountMatches,
    demo,
    checkedAt: new Date().toISOString(),
    message,
  };
}
