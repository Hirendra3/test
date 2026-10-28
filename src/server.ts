import process from 'node:process';
import os from 'node:os';

import { loadConfig } from './config.js';
import { createBridgeClient } from './bridge/client.js';
import { createApp } from './app.js';

const config = loadConfig();
const bridge = createBridgeClient(config);
const app = createApp(config, bridge);

/** IPv4 addresses other devices (phone on the same Wi-Fi) can reach. */
function lanAddresses(): string[] {
  const found: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address);
    }
  }
  return found;
}

const server = app.listen(config.port, config.host, () => {
  const addresses = lanAddresses();

  console.log(`\n  Payment bridge checkout`);
  console.log(`  ├─ Local      http://localhost:${config.port}`);
  for (const address of addresses) {
    console.log(`  ├─ Network    http://${address}:${config.port}   ← open this on your phone`);
  }
  if (addresses.length === 0) {
    console.log(`  ├─ Network    (no LAN address detected — use a tunnel or the hosted preview URL)`);
  }
  console.log(`  ├─ API        /api  (CORS: ${config.corsOrigin})`);
  console.log(`  ├─ Bridge     ${config.bridgeBaseUrl}${config.bridgeApiPrefix}`);
  console.log(`  ├─ Demo mode  ${config.demoMode}`);
  console.log(
    `  └─ redirect   ${
      config.publicBaseUrlExplicit
        ? config.publicBaseUrl
        : 'per-request host (LAN / preview / localhost all work)'
    }\n`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n[server] ${signal} received, shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
