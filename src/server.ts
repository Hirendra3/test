import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import { loadConfig } from './config.js';
import { createBridgeClient } from './bridge/client.js';
import { createApiRouter, errorHandler } from './routes.js';

const config = loadConfig();
const bridge = createBridgeClient(config);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(express.json({ limit: '64kb' }));

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

// ---- static checkout UI ---------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../public');

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
app.get(['/', '/pay/:txnId', '/checkout', '/demo'], (_req, res, next) => {
  res.sendFile(indexFile, (error) => {
    if (error) next(error);
  });
});

app.use((_req, res) => {
  res.status(404).send('Not found');
});

app.use(errorHandler);

const server = app.listen(config.port, config.host, () => {
  console.log(`\n  Payment bridge checkout`);
  console.log(`  ├─ UI        http://localhost:${config.port}`);
  console.log(`  ├─ API       http://localhost:${config.port}/api`);
  console.log(`  ├─ Bridge    ${config.bridgeBaseUrl}${config.bridgeApiPrefix}`);
  console.log(`  └─ Demo mode ${config.demoMode}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n[server] ${signal} received, shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
