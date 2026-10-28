import { context } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const SOURCES = ['src/public/app.ts', 'src/public/index.html', 'src/public/styles.css'];
const outDir = 'public';

const missing = SOURCES.filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error('\n[dev] Missing source file(s):');
  for (const file of missing) console.error(`  - ${file}`);
  console.error(
    '\nIf you cloned this repo, these files should exist. If they are missing, your\n' +
      'checkout is incomplete or a .gitignore rule excluded them:\n' +
      '  git ls-files src/public     # should list 3 files\n\n',
  );
  process.exit(1);
}

await mkdir(outDir, { recursive: true });

const ctx = await context({
  entryPoints: ['src/public/app.ts'],
  bundle: true,
  format: 'esm',
  target: ['es2020'],
  outfile: `${outDir}/app.js`,
  sourcemap: true,
  logLevel: 'info',
});
await ctx.watch();

for (const file of ['index.html', 'styles.css']) {
  await cp(`src/public/${file}`, `${outDir}/${file}`);
}

const server = spawn('npx', ['tsx', 'watch', '--clear-screen=false', 'src/server.ts'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'development' },
  shell: process.platform === 'win32',
});

let shuttingDown = false;
const shutdown = async (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.kill();
  await ctx.dispose().catch(() => undefined);
  process.exit(code);
};

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
server.on('error', (error) => {
  console.error('[dev] could not start the server:', error.message);
  void shutdown(1);
});
server.on('exit', (code) => void shutdown(code ?? 0));
