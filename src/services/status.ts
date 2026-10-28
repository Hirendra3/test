import { BridgeError, type BridgeClient } from '../bridge/client.js';
import type { BridgeHealth } from '../bridge/client.js';
import type { Config } from '../config.js';
import { buildDemoStatusResponse } from '../demo.js';
import { CheckoutError, normalizePgType } from './checkout.js';
import type { Diagnostic, PgType, StatusResult } from '../lib/types.js';

const SUCCESS_STATES = new Set([
  'COMPLETED',
  'COMPLETE',
  'SUCCESS',
  'SUCCESSFUL',
  'PAID',
  'CAPTURED',
  'TXN_SUCCESS',
  'PAYMENT_SUCCESS',
  'VERIFIED',
  'SETTLED',
]);

const FAILED_STATES = new Set([
  'FAILED',
  'FAILURE',
  'CANCELLED',
  'CANCELED',
  'USER_CANCELLED',
  'REJECTED',
  'DECLINED',
  'EXPIRED',
  'TXN_FAILURE',
  'PAYMENT_FAILED',
  'ERROR',
  'TIMEOUT',
]);

const PENDING_STATES = new Set([
  'PENDING',
  'INITIATED',
  'CREATED',
  'PROCESSING',
  'AWAITING',
  'IN_PROGRESS',
  'TXN_PENDING',
  'NOT_FOUND',
]);

function normKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function collectStrings(
  payload: unknown,
  wanted: Set<string>,
  depth = 0,
  path = '$',
): { value: string; path: string }[] {
  if (depth > 6) return [];
  const hits: { value: string; path: string }[] = [];
  if (Array.isArray(payload)) {
    payload.forEach((item, index) => hits.push(...collectStrings(item, wanted, depth + 1, `${path}[${index}]`)));
    return hits;
  }
  if (typeof payload !== 'object' || payload === null) return hits;
  for (const [key, child] of Object.entries(payload as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (typeof child === 'string' || typeof child === 'number') {
      if (wanted.has(normKey(key))) hits.push({ value: String(child), path: childPath });
    } else if (typeof child === 'object' && child !== null) {
      hits.push(...collectStrings(child, wanted, depth + 1, childPath));
    }
  }
  return hits;
}

const STATE_KEYS = new Set(
  ['state', 'status', 'transaction_state', 'payment_state', 'txn_status', 'payment_status', 'transaction_status'].map(
    normKey,
  ),
);

const AMOUNT_KEYS = new Set(
  [
    'amount',
    'amount_paisa',
    'amount_in_paise',
    'amount_in_paisa',
    'transaction_amount',
    'total_amount',
    'txn_amount',
  ].map(normKey),
);

export function normalizeStatus(raw: unknown): 'success' | 'failed' | 'pending' | 'unknown' {
  const states = collectStrings(raw, STATE_KEYS)
    .map((hit) => hit.value.trim().toUpperCase())
    .filter(Boolean);

  if (states.length === 0) {
    // Some payloads only carry a boolean `success`
    if (typeof raw === 'object' && raw !== null) {
      const flag = (raw as Record<string, unknown>).success;
      if (typeof flag === 'boolean') return flag ? 'success' : 'failed';
    }
    return 'unknown';
  }

  if (states.some((state) => SUCCESS_STATES.has(state))) return 'success';
  if (states.some((state) => FAILED_STATES.has(state))) return 'failed';
  if (states.some((state) => PENDING_STATES.has(state))) return 'pending';
  return 'unknown';
}

export function extractAmountPaisa(raw: unknown): number | null {
  const hits = collectStrings(raw, AMOUNT_KEYS);
  for (const hit of hits) {
    const key = normKey(hit.path.split('.').pop() ?? '');
    const numeric = Number(hit.value);
    if (!Number.isFinite(numeric) || numeric <= 0) continue;
    if (key.includes('paisa') || key.includes('paise')) return Math.round(numeric);
    if (Number.isInteger(numeric)) return numeric; // bridge contract: amount is paise
    return Math.round(numeric * 100); // gateway sending rupees with decimals
  }
  return null;
}

export interface StatusDeps {
  config: Config;
  bridge: BridgeClient;
  demo?: { reason: string } | null;
}

export async function fetchPaymentStatus(
  deps: StatusDeps,
  pgTxnId: string,
  pgTypeRaw: string | undefined,
  expectedAmountPaisa: number | null = null,
): Promise<StatusResult> {
  const pgType: PgType = normalizePgType(pgTypeRaw, deps.config.defaultPgType);
  const diagnostics: Diagnostic[] = [];

  let raw: unknown;
  let demo = false;

  try {
    raw = await deps.bridge.status(pgTxnId, pgType);
  } catch (error) {
    const fallbackToDemo =
      deps.config.demoMode === 'on' ||
      (deps.config.demoMode === 'auto' &&
        error instanceof BridgeError &&
        (error.code === 'BRIDGE_UNREACHABLE' ||
          error.code === 'BRIDGE_TIMEOUT' ||
          error.code === 'PG_NOT_CONFIGURED' ||
          (error.status !== null && error.status >= 500)));

    if (!fallbackToDemo) {
      if (error instanceof BridgeError) {
        throw new CheckoutError(error.code, error.message, error.status ?? 502, error.detail);
      }
      throw error;
    }
    demo = true;
    raw = buildDemoStatusResponse(pgTxnId, pgType);
    diagnostics.push({
      level: 'warn',
      code: 'DEMO_STATUS',
      message: `Live status check failed: ${(error as Error).message}`,
    });
  }

  const status = normalizeStatus(raw);
  const amountPaisa = extractAmountPaisa(raw);
  const amountMatches =
    expectedAmountPaisa !== null && amountPaisa !== null ? expectedAmountPaisa === amountPaisa : null;

  if (amountMatches === false) {
    diagnostics.push({
      level: 'error',
      code: 'AMOUNT_MISMATCH',
      message: `Paid amount ${amountPaisa} paise does not match the expected ${expectedAmountPaisa} paise.`,
    });
  }
  if (status === 'unknown') {
    diagnostics.push({
      level: 'warn',
      code: 'UNKNOWN_STATE',
      message: 'The gateway returned no recognisable state field; inspect raw_pg_response.',
    });
  }

  return {
    ok: true,
    pgType,
    txnId: pgTxnId,
    status,
    amountPaisa,
    amountMatches,
    raw,
    diagnostics,
    ...(demo ? { demo: true } : {}),
  };
}

export interface HealthReport {
  app: 'ok';
  version: string;
  bridge: {
    baseUrl: string;
    reachable: boolean;
    latencyMs: number | null;
    payload: BridgeHealth | null;
    error: string | null;
    missingGateways: string[];
  };
  demoMode: string;
  checkedAt: string;
}

let healthCache: { at: number; report: HealthReport } | null = null;

export async function bridgeHealth(config: Config, bridge: BridgeClient, maxAgeMs = 20_000): Promise<HealthReport> {
  if (healthCache && Date.now() - healthCache.at < maxAgeMs) return healthCache.report;

  const started = Date.now();
  let report: HealthReport;
  try {
    const payload = await bridge.health();
    const pgStatus = payload.pg_status ?? {};
    const missingGateways = Object.entries(pgStatus)
      .filter(([, enabled]) => enabled !== true)
      .map(([name]) => name);
    report = {
      app: 'ok',
      version: '1.0.0',
      bridge: {
        baseUrl: config.bridgeBaseUrl,
        reachable: true,
        latencyMs: Date.now() - started,
        payload,
        error: null,
        missingGateways,
      },
      demoMode: config.demoMode,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    report = {
      app: 'ok',
      version: '1.0.0',
      bridge: {
        baseUrl: config.bridgeBaseUrl,
        reachable: false,
        latencyMs: null,
        payload: null,
        error: error instanceof Error ? error.message : String(error),
        missingGateways: [],
      },
      demoMode: config.demoMode,
      checkedAt: new Date().toISOString(),
    };
  }

  healthCache = { at: Date.now(), report };
  return report;
}
