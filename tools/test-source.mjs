import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tests = [
  'server2/tools/bot-steering-unit.ts',
  'server2/tools/lobby-chat-unit.ts',
  'server2/tools/team-info-unit.ts',
  'html5/tools/contact-physics-unit.ts',
  'html5/tools/mouse-control-unit.ts',
];

for (const file of tests) {
  const result = spawnSync(process.execPath, ['--experimental-transform-types', file], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
