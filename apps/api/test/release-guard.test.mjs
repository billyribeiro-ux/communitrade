import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { assertNoProductionFixtures } from '../dist/persistence/release-guard.js';

test('synthetic seed fails before connecting in either production mode', () => {
  for (const mode of [{ NODE_ENV: 'production', RELEASE_MODE: 'local' }, { NODE_ENV: 'development', RELEASE_MODE: 'production' }]) {
    const result = spawnSync(process.execPath, ['apps/api/dist/seed.js'], {
      env: { ...process.env, ...mode, DATABASE_URL: 'not-a-database-url' }, encoding: 'utf8', timeout: 5000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Synthetic seed data is disabled in production/);
  }
});
test('production API startup rejects seeded fixtures and fails closed on unknown probe result', async () => {
  const configuredProduction = { RELEASE_MODE:'production', MARKET_DATA_PROVIDER:'databento', DATABENTO_API_KEY:'test-only-placeholder', DATABENTO_APPROVED_CAPABILITIES:'{}', DATABENTO_CALENDAR_CONFIG:'{}', DATABENTO_DELAY_SECONDS:'900' };
  await assertNoProductionFixtures({ $queryRaw: async () => { throw new Error('local must not query'); } }, { RELEASE_MODE: 'local' });
  await assert.rejects(assertNoProductionFixtures({ $queryRaw: async () => [{ synthetic: true }] }, { NODE_ENV: 'production' }));
  await assert.rejects(assertNoProductionFixtures({ $queryRaw: async () => [] }, { RELEASE_MODE: 'production' }));
  await assertNoProductionFixtures({ $queryRaw: async () => [{ synthetic: false }] }, configuredProduction);
});
