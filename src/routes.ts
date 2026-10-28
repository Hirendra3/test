import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { Config } from './config.js';
import { BridgeError, type BridgeClient } from './bridge/client.js';
import {
  CheckoutError,
  createPayPlan,
  isSupportedPgType,
  normalizePhone,
  resumePayPlan,
} from './services/checkout.js';
import { bridgeHealth, fetchPaymentStatus } from './services/status.js';
import { decodeArbitraryValue } from './services/decode.js';
import { readReturnHint, verifyReturn } from './services/verify.js';
import type { ApiError } from './lib/types.js';

export class ApiErrorResponse extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details: unknown = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(res: Response, status: number, code: string, message: string, details: unknown = null): void {
  const body: ApiError = { ok: false, error: { code, message, ...(details ? { details } : {}) } };
  res.status(status).json(body);
}

const paySchema = z.object({
  pg_type: z.string().trim().optional(),
  txn_id: z
    .string()
    .trim()
    .max(64)
    .regex(/^[A-Za-z0-9._:-]+$/, 'txn_id may only contain letters, digits, dot, dash, underscore, colon')
    .optional(),
  amount: z.union([z.number(), z.string()]),
  customer_email: z.string().trim().email('A valid customer_email is required'),
  customer_phone: z.union([z.string(), z.number()]),
  redirect_url: z.string().trim().url('redirect_url must be an absolute URL').optional(),
  payer_first_name: z.string().trim().max(60).optional(),
  payer_last_name: z.string().trim().max(60).optional(),
});

const statusSchema = z.object({
  pg_type: z.string().trim().optional(),
  pg_txn_id: z.string().trim().min(1),
  amount: z.union([z.number(), z.string()]).optional(),
});

const verifySchema = z
  .object({
    txn_id: z.union([z.string(), z.number()]).optional(),
    pg_txn_id: z.union([z.string(), z.number()]).optional(),
    pg_type: z.string().trim().optional(),
    amount: z.union([z.number(), z.string()]).optional(),
    status: z.string().trim().optional(),
  })
  .passthrough();

const decodeSchema = z.object({
  // Large enough for a base64 PNG data-URL from `qr_code`.
  url: z.string().trim().min(1).max(400_000),
});

function parseAmountPaisa(raw: number | string): number {
  const numeric = typeof raw === 'number' ? raw : Number(raw.trim());
  if (!Number.isFinite(numeric)) throw new ApiErrorResponse(400, 'INVALID_AMOUNT', 'amount must be a number in paise.');
  if (!Number.isInteger(numeric)) {
    throw new ApiErrorResponse(
      400,
      'INVALID_AMOUNT',
      'amount must be whole paise (₹499.00 = 49900). Decimals are not allowed.',
    );
  }
  if (numeric < 100) {
    throw new ApiErrorResponse(400, 'INVALID_AMOUNT', 'amount must be at least 100 paise (₹1.00).');
  }
  if (numeric > 100_000_000) {
    throw new ApiErrorResponse(400, 'INVALID_AMOUNT', 'amount exceeds the ₹10,00,000 per-order ceiling.');
  }
  return numeric;
}

function requireSupportedPg(pgType: string | undefined, config: Config): string {
  if (pgType && !isSupportedPgType(pgType)) {
    throw new ApiErrorResponse(
      400,
      'UNSUPPORTED_PG',
      `Unsupported or unconfigured PG type: ${pgType}. Use "phonepe" or "easebuzz".`,
    );
  }
  return pgType ?? config.defaultPgType;
}

export function createApiRouter(config: Config, bridge: BridgeClient): Router {
  const router = Router();

  router.get('/health', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(await bridgeHealth(config, bridge));
    } catch (error) {
      next(error);
    }
  });

  router.post('/pay', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = paySchema.safeParse(req.body);
      if (!parsed.success) {
        fail(res, 400, 'VALIDATION_ERROR', 'Invalid payment request.', parsed.error.flatten());
        return;
      }

      const data = parsed.data;
      const pgType = requireSupportedPg(data.pg_type, config);
      const phone = normalizePhone(String(data.customer_phone));
      if (!phone) {
        fail(res, 400, 'INVALID_PHONE', 'customer_phone must be a valid 10-digit Indian mobile number.');
        return;
      }

      const amount = parseAmountPaisa(data.amount);

      const result = await createPayPlan(
        { config, bridge },
        {
          pgType,
          txnId: data.txn_id,
          amount,
          email: data.customer_email,
          phone,
          redirectUrl: data.redirect_url,
          firstName: data.payer_first_name,
          lastName: data.payer_last_name,
        },
      );

      res.status(200).json(result.plan);
    } catch (error) {
      next(error);
    }
  });

  router.get('/pay/:txnId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const txnId = String(req.params.txnId ?? '').trim();
      if (!txnId) {
        fail(res, 400, 'MISSING_TXN', 'txn id is required.');
        return;
      }
      const amountRaw = typeof req.query.amount === 'string' ? req.query.amount : undefined;
      const amountHint = amountRaw ? parseAmountPaisa(amountRaw) : undefined;
      const result = await resumePayPlan(
        { config, bridge },
        txnId,
        typeof req.query.pg_type === 'string' ? req.query.pg_type : undefined,
        amountHint,
      );
      res.json(result.plan);
    } catch (error) {
      next(error);
    }
  });

  const handleStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.method === 'GET' ? { ...req.query, ...(req.params.pgTxnId ? { pg_txn_id: req.params.pgTxnId } : {}) } : req.body;
      const parsed = statusSchema.safeParse(body);
      if (!parsed.success) {
        fail(res, 400, 'VALIDATION_ERROR', 'pg_txn_id is required.', parsed.error.flatten());
        return;
      }
      const amount = parsed.data.amount !== undefined ? parseAmountPaisa(parsed.data.amount) : null;
      const result = await fetchPaymentStatus(
        { config, bridge },
        parsed.data.pg_txn_id,
        parsed.data.pg_type,
        amount,
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  };

  router.post('/status', handleStatus);
  router.get('/status/:pgTxnId', handleStatus);

  router.post('/decode', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = decodeSchema.safeParse(req.body);
      if (!parsed.success) {
        fail(res, 400, 'VALIDATION_ERROR', 'Send { "url": "<payment_url | token | upi intent>" }.', parsed.error.flatten());
        return;
      }
      const result = await decodeArbitraryValue(config, bridge, parsed.data.url);
      res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Re-verify a payment server-side. Accepts the gateway's own return payload
   * (query or form-encoded), ignores its claimed status, and answers from the
   * bridge. Safe to call from the browser after a redirect.
   */
  const handleVerify = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const merged: Record<string, unknown> = {
        ...(req.query as Record<string, unknown>),
        ...((req.body ?? {}) as Record<string, unknown>),
        ...(req.params.txnId ? { txn_id: req.params.txnId } : {}),
      };
      const parsed = verifySchema.safeParse(merged);
      if (!parsed.success) {
        fail(res, 400, 'VALIDATION_ERROR', 'Invalid verification payload.', parsed.error.flatten());
        return;
      }

      const hint = readReturnHint(parsed.data as Record<string, unknown>);
      if (!hint.txnId) {
        fail(res, 400, 'MISSING_TXN', 'No order reference (txn_id) supplied.');
        return;
      }
      const expectedAmountPaisa =
        parsed.data.amount !== undefined ? parseAmountPaisa(parsed.data.amount) : hint.amountPaisa;

      const result = await verifyReturn({ config, bridge }, { ...hint, expectedAmountPaisa });
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  };

  router.post('/verify', handleVerify);
  router.get('/verify/:txnId', handleVerify);
  router.post('/verify/:txnId', handleVerify);

  /**
   * Webhook receiver. Point `redirect_url`/server-to-server callbacks here.
   * The payload is treated as untrusted: only the order reference is read, the
   * state comes from the bridge, and a non-2xx tells the gateway to retry.
   */
  router.post('/webhook/:pgType?', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const hint = readReturnHint({ ...(req.query as Record<string, unknown>), ...body });
      if (!hint.txnId) {
        // 200 with ok:false so gateways don't retry forever on a malformed body.
        res.status(200).json({ ok: false, error: 'no txn_id in payload' });
        return;
      }
      if (!hint.pgType && typeof req.params.pgType === 'string') hint.pgType = req.params.pgType;

      const result = await verifyReturn(
        { config, bridge },
        { ...hint, expectedAmountPaisa: hint.amountPaisa },
      );
      console.log(
        `[webhook] ${result.txnId} claimed=${result.claimedStatus ?? '-'} gateway=${result.status} verified=${result.verified}`,
      );
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.use((req: Request, res: Response) => {
    fail(res, 404, 'NOT_FOUND', `No API route for ${req.method} ${req.originalUrl}.`);
  });

  return router;
}

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (res.headersSent) return;

  if (error instanceof ApiErrorResponse) {
    fail(res, error.status, error.code, error.message, error.details);
    return;
  }
  if (error instanceof CheckoutError) {
    fail(res, error.status, error.code, error.message, error.detail);
    return;
  }
  if (error instanceof BridgeError) {
    fail(res, error.status && error.status >= 400 ? 502 : 502, error.code, error.message, error.detail);
    return;
  }
  if (error instanceof SyntaxError && 'body' in (error as unknown as Record<string, unknown>)) {
    fail(res, 400, 'INVALID_JSON', 'Request body is not valid JSON.');
    return;
  }
  if (error instanceof Error && /private \/ loopback|Only http\(s\)/i.test(error.message)) {
    fail(res, 400, 'BLOCKED_URL', error.message);
    return;
  }

  const message = error instanceof Error ? error.message : 'Unexpected error';
  console.error('[api] unhandled error:', error);
  fail(res, 500, 'INTERNAL_ERROR', message);
}
