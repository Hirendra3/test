import process from 'node:process';

import { loadConfig } from './config.js';
import { createBridgeClient } from './bridge/client.js';
import { createApp } from './app.js';

const config = loadConfig();
const bridge = createBridgeClient(config);
const app = createApp(config, bridge);

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
