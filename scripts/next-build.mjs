import { spawnSync } from 'node:child_process';

if (['production','public'].includes(process.env.RELEASE_MODE??'')) {
  const { assertReleaseReady } = await import('../apps/web/src/lib/policies.ts');
  assertReleaseReady();
}

// Compose development services export NODE_ENV=development. A production build
// must load React/Next's production runtime even when invoked from that shell.
const result = spawnSync('pnpm', ['exec', 'next', 'build'], {
  stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' },
});
process.exit(result.status ?? 1);
