import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import type { Config } from './config.js';
import type { BridgeClient } from './bridge/client.js';
import { createApiRouter, errorHandler } from './routes.js';
import { readReturnHint } from './services/verify.js';

export interface AppOptions {
  /** Directory with the built checkout UI (index.html, app.js, styles.css). */
  publicDir?: string;
}

const defaultPublicDir = (): string => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../public');
};

/**
 * Builds the Express app. Kept separate from `server.ts` so tests can mount it
 * against a stubbed bridge without opening a port.
 */
export function createApp(config: Config, bridge: BridgeClient, options: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(express.json({ limit: '64kb' }));
  // Gateways return form-encoded (Easebuzz) or query-string (PhonePe) payloads.
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  // CORS for the JSON API so any merchant site can call it directly.
  app.use('/api', (req, res, next) => {
    const origin = config.corsOrigin === '*' ? '*' : config.corsOrigin;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use('/api', createApiRouter(config, bridge));

  const publicDir = options.publicDir ?? defaultPublicDir();
  app.use(
    express.static(publicDir, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
        else res.setHeader('Cache-Control', 'public, max-age=300');
      },
    }),
  );

  const indexFile = path.join(publicDir, 'index.html');

  /**
   * Gateways POST their return payload here (Easebuzz always POSTs). We keep
   * only the order reference and bounce the browser to the SPA, which then
   * asks /api/verify for the authoritative answer.
   */
  const gatewayReturn = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const merged: Record<string, unknown> = {
        ...(req.query as Record<string, unknown>),
        ...((req.body ?? {}) as Record<string, unknown>),
      };
      const hint = readReturnHint(merged, typeof req.params.txnId === 'string' ? req.params.txnId : undefined);
      if (!hint.txnId) {
        // A bare GET /return is just the SPA page; a POST without a reference
        // is a malformed gateway callback, so send it to the start page.
        if (req.method === 'GET') next();
        else res.redirect(303, '/');
        return;
      }
      const params = new URLSearchParams({ verify: '1' });
      if (hint.pgType) params.set('pg_type', hint.pgType);
      res.redirect(303, `/pay/${encodeURIComponent(hint.txnId)}?${params.toString()}`);
    } catch (error) {
      next(error);
    }
  };

  app.post(['/pay/:txnId', '/return', '/payment/callback'], gatewayReturn);
  app.get(['/return', '/payment/callback'], gatewayReturn);

  app.get(['/', '/pay/:txnId', '/return', '/payment/callback', '/checkout', '/demo'], (_req, res, next) => {
    res.sendFile(indexFile, (error) => {
      if (error) next(error);
    });
  });

  app.use((_req, res) => {
    res.status(404).send('Not found');
  });

  app.use(errorHandler);

  return app;
}
