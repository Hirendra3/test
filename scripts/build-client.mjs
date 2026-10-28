import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const outDir = 'public';

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({
  entryPoints: ['src/public/app.ts'],
  bundle: true,
  format: 'esm',
  target: ['es2020'],
  outfile: `${outDir}/app.js`,
  sourcemap: true,
  minify: process.env.NODE_ENV === 'production',
  logLevel: 'info',
});

for (const file of ['index.html', 'styles.css']) {
  const from = `src/public/${file}`;
  if (existsSync(from)) await cp(from, `${outDir}/${file}`);
}

console.log('client build complete -> public/');
