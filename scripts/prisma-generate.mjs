import { spawnSync } from 'node:child_process';

// Client generation does not connect. Never use this fallback for migrations/runtime.
const result = spawnSync('pnpm', ['exec', 'prisma', 'generate'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://generate:generate@localhost:5432/generate' },
});
process.exit(result.status ?? 1);
