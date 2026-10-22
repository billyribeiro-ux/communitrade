import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

// Explicit local acceptance drill: stops/restarts services, preserves all volumes.
const env = parseEnv(readFileSync('.env.local', 'utf8'));
const api = `http://127.0.0.1:${env.API_PORT ?? '3001'}/api/v1/health`;
function compose(args, input) {
  const result = spawnSync('docker', ['compose', '--env-file', '.env.local', ...args], {
    encoding: 'utf8', timeout: 120_000, input, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('Local Compose operation failed (output suppressed).');
  return result.stdout.trim();
}
function sql(query, identity = false) {
  const user = identity ? 'IDENTITY_DB_USER' : 'APP_DB_USER';
  const db = identity ? 'IDENTITY_DB_NAME' : 'APP_DB_NAME';
  return compose(['exec', '-T', 'postgres', 'sh', '-c', `exec psql -X -qAt -v ON_ERROR_STOP=1 -U "$${user}" -d "$${db}"`], query);
}
async function ready() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(`${api}/ready`, { signal: AbortSignal.timeout(3000) })).ok) return; } catch { /* bounded retry */ }
    await sleep(1000);
  }
  throw new Error('API did not recover.');
}
await ready();
// Warm the application's pg service pool as well as Prisma readiness: an idle
// pooled connection must survive its server disappearing without a process crash.
assert.equal((await fetch(new URL('/api/v1/instruments?limit=1', api), {signal:AbortSignal.timeout(5000)})).status,200);
try {
  compose(['stop', 'postgres']);
  const live = await fetch(`${api}/live`, { signal: AbortSignal.timeout(5000) });
  assert.equal(live.status, 200);
  const unavailable = await fetch(`${api}/ready`, { signal: AbortSignal.timeout(5000) });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { status: 'not_ready', version: '0.1.0' });
  assert.equal(unavailable.headers.get('cache-control'), 'no-store');
  console.log('PASS DB-down: live 200, ready 503, minimal uncached response');
} finally {
  compose(['start', 'postgres']);
}
await ready();
console.log('PASS database recovery without API restart');

const marker = randomUUID();
sql(`INSERT INTO foundation_probe(id,label) VALUES ('persistence-check','${marker}') ON CONFLICT(id) DO UPDATE SET label=EXCLUDED.label;`);
const realmBefore = sql("SELECT id FROM realm WHERE name='master';", true);
assert.ok(realmBefore.length > 0, 'master realm exists');
compose(['stop', 'worker']);
const workerLogs = compose(['logs', '--tail=20', 'worker']);
assert.match(workerLogs, /Worker stopped\./);
console.log('PASS graceful worker stop');
compose(['down']);
compose(['up', '-d']);
await ready();
assert.equal(sql("SELECT label FROM foundation_probe WHERE id='persistence-check';"), marker);
assert.equal(sql("SELECT id FROM realm WHERE name='master';", true), realmBefore);
console.log('PASS full Compose down/up preserves app record and identity realm ID');
console.log('Services restarted. Run pnpm test:local to check web, identity and worker recovery.');
