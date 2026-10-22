import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../dist/app.js';

test('real Nest HTTP liveness stays up while readiness tracks DB/schema failure without leaking errors', async () => {
  let available = true;
  const app = await createApp({ $queryRaw: async () => {
    if (!available) throw new Error('postgresql://user:private@secret-host/db');
    return [];
  } });
  await app.listen(0, '127.0.0.1');
  try {
    const origin = await app.getUrl();
    let response = await fetch(`${origin}/api/v1/health/ready`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).status, 'ok');
    available = false;
    response = await fetch(`${origin}/api/v1/health/ready`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: 'not_ready', version: '0.1.0' });
    response = await fetch(`${origin}/api/v1/health/live`);
    assert.equal(response.status, 200);
  } finally { await app.close(); }
});
