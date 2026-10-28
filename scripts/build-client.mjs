import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const SOURCES = ['src/public/app.ts', 'src/public/index.html', 'src/public/styles.css'];
const outDir = 'public';

const missing = SOURCES.filter((file) => !existsSync(file));
if (missing.length > 0) {
  console.error('\n[build:client] Missing source file(s):');
  for (const file of missing) console.error(`  - ${file}`);
  console.error('\nRun `git ls-files src/public` — it should list these 3 files.\n');
  process.exit(1);
}

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
  await cp(`src/public/${file}`, `${outDir}/${file}`);
}

console.log('client build complete -> public/');
