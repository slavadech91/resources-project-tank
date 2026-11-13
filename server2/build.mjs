// Сборка server2: проверка типов (tsc из html5/node_modules) и esbuild в dist/server2.mjs + dist/bcrypt-worker.mjs
// (+ dist/bcrypt-check.mjs — самопроверка bcrypt на целевой машине)
// под Node 18 (Debian i686 — без встроенного TypeScript). Зависимостей у server2 нет: инструменты берутся из html5.
// Запуск: node server2/build.mjs [--no-check]
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML5 = path.resolve(HERE, '..', 'html5');
// esbuild лежит в pnpm-хранилище html5 — достаём его через vite, который от него зависит
const requireFromVite = createRequire(realpathSync(path.join(HTML5, 'node_modules', 'vite', 'package.json')));
const esbuild = requireFromVite('esbuild');

if (!process.argv.includes('--no-check')) {
  const tsc = path.join(HTML5, 'node_modules', 'typescript', 'bin', 'tsc');
  try {
    execFileSync(process.execPath, [tsc, '-p', path.join(HERE, 'tsconfig.json')], { stdio: 'inherit' });
  } catch {
    console.error('[build] ошибки типов');
    process.exit(1);
  }
}

const result = await esbuild.build({
  entryPoints: {
    server2: path.join(HERE, 'src', 'main.ts'),
    'bcrypt-worker': path.join(HERE, 'src', 'auth', 'bcrypt-worker.ts'),
    'bcrypt-check': path.join(HERE, 'tools', 'bcrypt-check.ts'),
  },
  outdir: path.join(HERE, 'dist'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  sourcemap: 'linked',
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
});
for (const [file, info] of Object.entries(result.metafile.outputs)) {
  if (file.endsWith('.mjs')) console.log(`[build] ${path.relative(HERE, file)} — ${(info.bytes / 1024).toFixed(1)} КБ`);
}
