/**
 * Thin client for the Payment Bridge API.
 * Nothing here knows about UPI — it only moves JSON and never throws raw fetch errors.
 */

import type { Config } from '../config.js';
import { BROWSER_UA, HttpError, fetchWithTimeout, readJsonSafe, readTextLimited } from '../lib/http.js';
import type { PgType } from '../lib/types.js';

export class BridgeError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly detail: unknown;

  constructor(code: string, message: string, status: number | null = null, detail: unknown = null) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export interface CollectRequest {
  pg_type: PgType;
  txn_id: string;
  amount: number;
  customer_email: string;
  customer_phone: string;
  redirect_url: string;
  payer_first_name?: string;
  payer_last_name?: string;
}

export interface BridgeHealth {
  status: string;
  version?: string;
  enabled_pgs?: string[];
  pg_status?: Record<string, boolean>;
}

export interface PageResult {
  url: string;
  finalUrl: string;
  status: number;
  html: string;
  error: string | null;
}

export interface BridgeClient {
  readonly config: Config;
  health(timeoutMs?: number): Promise<BridgeHealth>;
  collect(body: CollectRequest): Promise<unknown>;
  session(txnId: string, pgType: PgType): Promise<unknown>;
  status(pgTxnId: string, pgType: PgType): Promise<unknown>;
  fetchPage(url: string): Promise<PageResult>;
}

function normalizeBase(base: string, prefix: string): string {
  return `${base.replace(/\/+$/, '')}${prefix}`;
}

export function createBridgeClient(config: Config): BridgeClient {
  const apiBase = normalizeBase(config.bridgeBaseUrl, config.bridgeApiPrefix);

  const headers = (): Record<string, string> => {
    const result: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (config.bridgeApiKey) result['x-api-key'] = config.bridgeApiKey;
    return result;
  };

  const request = async (
    path: string,
    init: RequestInit,
    method: string,
    timeoutMs = config.bridgeTimeoutMs,
  ): Promise<unknown> => {
    const url = `${apiBase}${path}`;
    let response: Response;
    try {
      response = await fetchWithTimeout(
        url,
        { ...init, method, headers: { ...headers(), ...(init.headers as Record<string, string> | undefined) } },
        timeoutMs,
      );
    } catch (error) {
      if (error instanceof HttpError) {
        throw new BridgeError(
          error.code === 'timeout' ? 'BRIDGE_TIMEOUT' : 'BRIDGE_UNREACHABLE',
          error.message,
          error.status,
        );
      }
      throw error;
    }

    const body = await readJsonSafe(response);

    if (!response.ok) {
      const message =
        (typeof body === 'object' && body !== null
          ? String(
              (body as Record<string, unknown>).error ??
                (body as Record<string, unknown>).message ??
                '',
            )
          : '') || `Bridge responded ${response.status} ${response.statusText}`;
      const code = response.status === 503 ? 'PG_NOT_CONFIGURED' : response.status === 400 ? 'BAD_REQUEST' : 'BRIDGE_ERROR';
      throw new BridgeError(code, message, response.status, body);
    }

    if (body === null || body === '') {
      throw new BridgeError('BRIDGE_EMPTY', 'The bridge returned an empty body.', response.status);
    }
    return body;
  };

  return {
    config,

    async health(timeoutMs) {
      const body = await request('/health', {}, 'GET', Math.min(timeoutMs ?? config.bridgeTimeoutMs, 5_000));
      return body as BridgeHealth;
    },

    async collect(body) {
      return request('/collect', { body: JSON.stringify(body) }, 'POST');
    },

    async session(txnId, pgType) {
      const query = new URLSearchParams({ txn_id: txnId, pg_type: pgType });
      return request(`/session?${query.toString()}`, {}, 'GET');
    },

    async status(pgTxnId, pgType) {
      try {
        return await request('/status', { body: JSON.stringify({ pg_type: pgType, pg_txn_id: pgTxnId }) }, 'POST');
      } catch (error) {
        // Bridges that only expose the GET form.
        if (error instanceof BridgeError && (error.status === 404 || error.status === 405)) {
          const query = new URLSearchParams({ pg_type: pgType });
          return request(`/status/${encodeURIComponent(pgTxnId)}?${query.toString()}`, {}, 'GET');
        }
        throw error;
      }
    },

    async fetchPage(url) {
      try {
        const response = await fetchWithTimeout(
          url,
          {
            method: 'GET',
            redirect: 'follow',
            headers: {
              'User-Agent': BROWSER_UA,
              Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-IN,en;q=0.9',
            },
          },
          config.pageTimeoutMs,
        );
        const html = await readTextLimited(response, 768 * 1024);
        return {
          url,
          finalUrl: response.url || url,
          status: response.status,
          html,
          error: response.ok ? null : `Checkout page returned HTTP ${response.status}.`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { url, finalUrl: url, status: 0, html: '', error: message };
      }
    },
  };
}
