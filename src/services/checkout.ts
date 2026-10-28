import { randomBytes } from 'node:crypto';
import type { Config } from '../config.js';
import { BridgeError, type BridgeClient, type CollectRequest } from '../bridge/client.js';
import { buildDemoCollectResponse } from '../demo.js';
import { buildPayPlan, extractHostedUrls, type PageSnapshot, type PlanResult } from '../lib/planner.js';
import { renderQr } from '../lib/qr.js';
import { decodeQrDataUrl } from '../lib/qrDecode.js';
import type { PgType } from '../lib/types.js';

export class CheckoutError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: unknown;

  constructor(code: string, message: string, status = 502, detail: unknown = null) {
    super(message);
    this.name = 'CheckoutError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export interface CreatePaymentInput {
  /**
   * Origin the customer's browser is actually on (`http://192.168.1.5:3000`,
   * `https://3000-xxx.e2b.app`, …). Used for redirect_url unless the caller
   * supplies one, so mobile/LAN/preview access returns to a reachable host.
   */
  baseUrl?: string;
  pgType: string;
  txnId?: string;
  amount: number;
  email: string;
  phone: string;
  redirectUrl?: string;
  firstName?: string;
  lastName?: string;
}

export function normalizePgType(raw: string | undefined | null, fallback: PgType = 'phonepe'): PgType {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'phonepe' || value === 'phonepe_v2' || value === 'phonepev2' || value === 'phonepe-v2') {
    return 'phonepe';
  }
  if (value === 'easebuzz' || value === 'easebuzz_pg') return 'easebuzz';
  return fallback;
}

export function isSupportedPgType(raw: string | undefined | null): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return ['phonepe', 'phonepe_v2', 'phonepev2', 'phonepe-v2', 'easebuzz', 'easebuzz_pg'].includes(value);
}

/** Accepts "+91 98765 43210", "09876543210", "9876543210" and returns the bare 10 digits. */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  const local = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  const normalized = local.length === 11 && local.startsWith('0') ? local.slice(1) : local;
  return /^[6-9]\d{9}$/.test(normalized) ? normalized : null;
}

export function generateTxnId(prefix = 'ORD'): string {
  const stamp = Date.now().toString(36).toUpperCase();
  const random = randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${stamp}-${random}`;
}

function demoAllowed(config: Config, error: unknown): boolean {
  if (config.demoMode === 'on') return true;
  if (config.demoMode === 'off') return false;
  if (!(error instanceof BridgeError)) return false;
  if (error.code === 'BRIDGE_UNREACHABLE' || error.code === 'BRIDGE_TIMEOUT' || error.code === 'PG_NOT_CONFIGURED') {
    return true;
  }
  return error.status !== null && error.status >= 500;
}

export interface CheckoutDeps {
  config: Config;
  bridge: BridgeClient;
}

export async function createPayPlan(
  deps: CheckoutDeps,
  input: CreatePaymentInput,
): Promise<PlanResult> {
  const { config, bridge } = deps;
  const requestedPgType = input.pgType;
  const pgType = normalizePgType(requestedPgType, config.defaultPgType);
  const txnId = input.txnId?.trim() || generateTxnId();
  const baseUrl = (input.baseUrl ?? config.publicBaseUrl).replace(/\/+$/, '');
  const redirectUrl = input.redirectUrl?.trim() || `${baseUrl}/pay/${encodeURIComponent(txnId)}`;

  const collectBody: CollectRequest = {
    pg_type: pgType,
    txn_id: txnId,
    amount: input.amount,
    customer_email: input.email,
    customer_phone: input.phone,
    redirect_url: redirectUrl,
    ...(input.firstName ? { payer_first_name: input.firstName } : {}),
    ...(input.lastName ? { payer_last_name: input.lastName } : {}),
  };

  let collectPayload: unknown;
  let demo = false;
  let demoReason: string | null = null;

  try {
    collectPayload = await bridge.collect(collectBody);
  } catch (error) {
    if (demoAllowed(config, error)) {
      demo = true;
      demoReason =
        error instanceof BridgeError ? error.message : `Bridge call failed: ${(error as Error).message}`;
      collectPayload = buildDemoCollectResponse(collectBody);
    } else if (error instanceof BridgeError) {
      throw new CheckoutError(error.code, error.message, error.status ?? 502, error.detail);
    } else {
      throw error;
    }
  }

  const urls = extractHostedUrls(collectPayload);

  // Read the hosted page (that is where PhonePe keeps the real, signed intent)
  // and hit the session API in parallel — both are best-effort.
  const pagesPromise: Promise<PageSnapshot[]> = (async () => {
    if (!config.fetchPaymentPage || demo) return [];
    // The gateway page holds the token; `custom_payment_url` is the merchant's
    // own /pay/<id> page, which sometimes renders the intent or QR itself.
    const targets = [urls.paymentUrl ?? urls.pgPaymentUrl, urls.customPaymentUrl]
      .filter((url): url is string => typeof url === 'string' && /^https?:\/\//i.test(url))
      .filter((url, index, all) => all.indexOf(url) === index)
      .slice(0, 2);
    if (targets.length === 0) return [];
    const results = await Promise.all(targets.map((url) => bridge.fetchPage(url)));
    return results.map((result) => ({
      url: result.url,
      finalUrl: result.finalUrl,
      status: result.status,
      html: result.html,
      error: result.error,
    }));
  })();

  const sessionPromise: Promise<unknown | null> = (async () => {
    if (demo) return null;
    try {
      return await bridge.session(txnId, pgType);
    } catch {
      return null;
    }
  })();

  const [pages, sessionPayload] = await Promise.all([pagesPromise, sessionPromise]);

  // A bridge may hand back a QR *image* instead of an intent string. Decode it:
  // on PhonePe redirect mode it is only their hosted URL, but on intent flows it
  // can hold the signed intent, so it is always worth reading.
  const qrImage = urls.qrCode;
  const decodedQr =
    qrImage && qrImage.startsWith('data:image/')
      ? await (async () => {
          const result = decodeQrDataUrl(qrImage);
          return result ? { payload: result.payload, method: result.method } : null;
        })()
      : null;

  const result = buildPayPlan({
    pgType,
    requestedPgType,
    txnId,
    amountPaisa: input.amount,
    collectPayload,
    decodedQr,
    pages,
    sessionPayload,
    demo,
    demoReason,
  });

  if (result.plan.qr && !result.plan.qr.dataUrl) {
    result.plan.qr.dataUrl = await renderQr(result.plan.qr.value);
  }

  return result;
}

/**
 * Rebuild a plan for an order that already exists (page refresh, shared link,
 * or "fetch active session" usage) without creating a second transaction.
 */
export async function resumePayPlan(
  deps: CheckoutDeps,
  txnId: string,
  pgTypeRaw: string | undefined,
  amountHint?: number,
): Promise<PlanResult> {
  const { config, bridge } = deps;
  const pgType = normalizePgType(pgTypeRaw, config.defaultPgType);

  let sessionPayload: unknown;
  try {
    sessionPayload = await bridge.session(txnId, pgType);
  } catch (error) {
    if (error instanceof BridgeError) {
      const unreachable = error.code === 'BRIDGE_UNREACHABLE' || error.code === 'BRIDGE_TIMEOUT';
      throw new CheckoutError(
        unreachable ? error.code : 'SESSION_UNAVAILABLE',
        unreachable
          ? error.message
          : `No active session for ${txnId}. Start the payment again from the checkout form.`,
        unreachable ? 502 : (error.status ?? 404),
        error.detail,
      );
    }
    throw error;
  }

  const urls = extractHostedUrls(sessionPayload);
  const pages: PageSnapshot[] = [];
  if (config.fetchPaymentPage) {
    const target = urls.paymentUrl ?? urls.pgPaymentUrl;
    if (target && /^https?:\/\//i.test(target)) {
      const result = await bridge.fetchPage(target);
      pages.push({
        url: result.url,
        finalUrl: result.finalUrl,
        status: result.status,
        html: result.html,
        error: result.error,
      });
    }
  }

  const amountFromSession = (() => {
    const candidate = sessionPayload as Record<string, unknown> | null;
    const raw = candidate && typeof candidate === 'object' ? candidate.amount ?? candidate.amount_paisa : null;
    const numeric = Number(raw);
    return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : null;
  })();

  const qrImage = urls.qrCode;
  const decodedQr =
    qrImage && qrImage.startsWith('data:image/')
      ? await (async () => {
          const decoded = decodeQrDataUrl(qrImage);
          return decoded ? { payload: decoded.payload, method: decoded.method } : null;
        })()
      : null;

  const result = buildPayPlan({
    pgType,
    requestedPgType: pgTypeRaw ?? pgType,
    txnId,
    amountPaisa: amountHint ?? amountFromSession ?? 0,
    collectPayload: sessionPayload,
    decodedQr,
    pages,
    sessionPayload,
    demo: false,
    demoReason: null,
  });

  if (result.plan.qr && !result.plan.qr.dataUrl) {
    result.plan.qr.dataUrl = await renderQr(result.plan.qr.value);
  }

  return result;
}
