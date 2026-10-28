import { context } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const outDir = 'public';
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
});

const shutdown = async () => {
  server.kill('SIGTERM');
  await ctx.dispose();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.on('exit', (code) => shutdown().then(() => process.exit(code ?? 0)));
