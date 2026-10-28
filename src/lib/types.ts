/**
 * DTOs shared by the server and the browser bundle.
 * This file must stay free of runtime imports so esbuild can inline the types.
 */

export type PgType = 'phonepe' | 'phonepe_v2' | 'easebuzz';

export type Severity = 'block' | 'warn' | 'info';

export interface Issue {
  severity: Severity;
  code: string;
  message: string;
}

export type IntentSource =
  | 'direct-upi'
  | 'token'
  | 'payment-page'
  | 'session'
  | 'bridge-intent-url'
  | 'bridge-qr'
  | 'qr-image';

export interface IntentView {
  /** The URL exactly as it was found. Never rebuilt — signed intents must stay byte-identical. */
  raw: string;
  scheme: string;
  host: string;
  params: Record<string, string>;
  /** `sign` present => PhonePe/UPI signature params survived, so the intent is payable. */
  signed: boolean;
  /** true when no blocking issue was found. */
  usable: boolean;
  source: IntentSource;
  /** Where inside the payload it was found, e.g. `$.instrumentResponse.intentUrl`. */
  jsonPath: string;
  appLinks: Record<string, string>;
  issues: Issue[];
  /** Amount as declared by the intent itself (paise), if present. */
  amountPaisa: number | null;
  /** Transaction reference as declared by the intent, if present. */
  txnId: string | null;
  isPrimary: boolean;
}

export interface PayAction {
  kind: 'intent' | 'hosted';
  app: 'phonepe' | 'gpay' | 'paytm' | 'any' | 'web' | 'easebuzz';
  label: string;
  url: string;
  hint?: string;
}

export interface Diagnostic {
  level: 'ok' | 'info' | 'warn' | 'error';
  code: string;
  message: string;
}

export interface DecodedSource {
  label: string;
  /** Token source: which URL/field it was taken from. */
  origin: string;
  tokenPreview: string;
  tokenLength: number;
  layers: number;
  intents: number;
  fields: number;
  errors: string[];
}

export interface IndexedFieldView {
  path: string;
  key: string;
  value: string;
}

export interface DecodeReport {
  sources: DecodedSource[];
  fields: IndexedFieldView[];
  /** Everything that was discovered, flattened and de-duplicated. */
  discoveredIntents: string[];
  notes: string[];
}

export interface QrView {
  value: string;
  dataUrl: string | null;
  source: IntentSource | 'bridge-image';
  /** What scanning it actually does. */
  kind: 'upi-intent' | 'checkout-url' | 'text';
  /** Bridge-supplied QR image (e.g. PhonePe's own PNG), if any. */
  bridgeImage: string | null;
}

export interface PayPlan {
  ok: true;
  demo: boolean;
  demoReason?: string;
  pgType: PgType;
  txnId: string;
  amountPaisa: number;
  amountLabel: string;
  createdAt: string;
  /** Best payable action: a verified UPI intent, else the hosted checkout. */
  primary: PayAction | null;
  /** Always-safe second option (hosted PhonePe/Easebuzz checkout). */
  fallback: PayAction | null;
  intents: IntentView[];
  /** App-specific deep links for the primary intent (PhonePe / GPay / Paytm / any). */
  apps: PayAction[];
  /**
   * App-launch payment built from the merchant's own UPI ID, used when the
   * gateway only returns an encrypted redirect token and no extractable intent.
   */
  directUpi: {
    vpa: string;
    payeeName: string;
    value: string;
    apps: PayAction[];
    txnId: string;
    amountPaisa: number;
    warning: string;
  } | null;
  /** true when no UPI_VPA is configured, so direct app buttons cannot exist. */
  needsUpiVpa: boolean;
  qr: QrView | null;
  diagnostics: Diagnostic[];
  decode: DecodeReport;
  hosted: {
    paymentUrl: string | null;
    pgPaymentUrl: string | null;
    tokenUrl: string | null;
    customPaymentUrl: string | null;
    /** PhonePe's checkout.js — enables the in-page IFRAME modal. */
    checkoutScript: string | null;
    /** true when an in-page modal can be attempted (needs token + script). */
    canEmbed: boolean;
  };
}

export interface StatusResult {
  ok: true;
  demo?: boolean;
  pgType: PgType;
  txnId: string;
  status: 'success' | 'failed' | 'pending' | 'unknown';
  amountPaisa: number | null;
  amountMatches: boolean | null;
  raw: unknown;
  diagnostics: Diagnostic[];
}

export interface ApiError {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
