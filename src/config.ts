import process from 'node:process';

export type DemoMode = 'auto' | 'on' | 'off';

export interface Config {
  port: number;
  host: string;
  publicBaseUrl: string;
  /** true when PUBLIC_BASE_URL was set explicitly (otherwise per-request host is used). */
  publicBaseUrlExplicit: boolean;
  corsOrigin: string;
  bridgeBaseUrl: string;
  bridgeApiPrefix: string;
  bridgeApiKey: string | null;
  bridgeTimeoutMs: number;
  pageTimeoutMs: number;
  fetchPaymentPage: boolean;
  demoMode: DemoMode;
  defaultPgType: 'phonepe' | 'easebuzz';
  /** Merchant UPI ID used to build a direct app-launch intent when needed. */
  upiVpa: string | null;
  upiPayeeName: string | null;
  demoAmountPaise: number;
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const explicitBase = env.PUBLIC_BASE_URL?.trim();
  const publicBaseUrl = (explicitBase && explicitBase.length > 0
    ? explicitBase
    : `http://localhost:${env.PORT ?? 3000}`
  ).replace(/\/+$/, '');
  const demoRaw = (env.DEMO_MODE ?? 'auto').toLowerCase();

  return {
    port: num(env.PORT, 3000),
    host: env.HOST ?? '0.0.0.0',
    publicBaseUrl,
    publicBaseUrlExplicit: Boolean(explicitBase && explicitBase.length > 0),
    corsOrigin: env.CORS_ORIGIN ?? '*',
    bridgeBaseUrl: (env.BRIDGE_BASE_URL ?? 'https://www.jayamanicollections.com').replace(/\/+$/, ''),
    bridgeApiPrefix: `/${(env.BRIDGE_API_PREFIX ?? '/api/bridge/v1').replace(/^\/+|\/+$/g, '')}`,
    bridgeApiKey: env.BRIDGE_API_KEY?.trim() ? env.BRIDGE_API_KEY.trim() : null,
    bridgeTimeoutMs: num(env.BRIDGE_TIMEOUT_MS, 15_000),
    pageTimeoutMs: num(env.PAGE_TIMEOUT_MS, 8_000),
    fetchPaymentPage: bool(env.FETCH_PAYMENT_PAGE, true),
    demoMode: demoRaw === 'on' || demoRaw === 'off' ? demoRaw : 'auto',
    defaultPgType: env.DEFAULT_PG_TYPE === 'easebuzz' ? 'easebuzz' : 'phonepe',
    upiVpa: env.UPI_VPA?.trim() ? env.UPI_VPA.trim() : null,
    upiPayeeName: env.UPI_PAYEE_NAME?.trim() ? env.UPI_PAYEE_NAME.trim() : null,
    demoAmountPaise: num(env.DEMO_AMOUNT_PAISE, 49_900),
  };
}
