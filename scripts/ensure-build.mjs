import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const missing = !existsSync('dist/server.js') || !existsSync('public/index.html');

if (missing) {
  console.log('[start] build artefacts missing, building…');
  const result = spawnSync('npm', ['run', 'build'], {
    stdio: 'inherit',
    // npm is npm.cmd on Windows, which needs a shell to spawn.
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
