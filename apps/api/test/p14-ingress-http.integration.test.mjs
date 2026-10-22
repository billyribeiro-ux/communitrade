import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { signIngress } from '@trading/config/ingress';
import { CommandError } from '../dist/http/problem.js';
import { createApp } from '../dist/app.js';
import { SupportService } from '../dist/support/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = { skip: databaseUrl ? false : 'Set TEST_DATABASE_URL with migration 025 applied for P14 trusted ingress HTTP acceptance.' };
const secret = 'p14-ingress-test-secret-with-at-least-32-bytes';
const sessionSecret = 'p14-ingress-support-ip-hash-secret-with-at-least-32-bytes';
const origin = 'http://localhost:3000';

function signedHeaders({ method, path, body, nonce = randomUUID().replaceAll('-', ''), clientIp = '198.51.100.80', contentType = 'application/json', extra = {} }) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signIngress(secret, { method, path, timestamp, nonce, principal: 'web', body, clientIp });
  return {
    Origin: origin,
    'Content-Type': contentType,
    'x-trusted-ingress-timestamp': timestamp,
    'x-trusted-ingress-nonce': nonce,
    'x-trusted-ingress-signature': signature,
    'x-trusted-ingress-principal': 'web',
    'x-trusted-ingress-client-ip': clientIp,
    // Browser-supplied forwarding values must not choose the address used by APIs.
    'x-forwarded-for': '203.0.113.250',
    ...extra,
  };
}

function nonceConsumer(pool) {
  return async (nonce, expiresAt) => {
    const result = await pool.query(`INSERT INTO trusted_ingress_nonce(nonce,expires_at) VALUES($1,$2)
      ON CONFLICT(nonce) DO UPDATE SET expires_at=EXCLUDED.expires_at
      WHERE trusted_ingress_nonce.expires_at<=now() RETURNING nonce`, [nonce, expiresAt]);
    return result.rowCount === 1;
  };
}

function contactBody(message) {
  return Buffer.from(JSON.stringify({ email: 'p14-ingress@example.invalid', category: 'other', subject: 'P14 ingress test', message, consent: true }));
}

function supportHash(ip) {
  return createHmac('sha256', sessionSecret).update(ip).digest('hex');
}

test('P14 signed ingress survives two API instances, binds raw transports, uses trusted IP buckets, and leaves OIDC logout verification in place', integration, async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 12, connectionTimeoutMillis: 3000, query_timeout: 15000 });
  pool.on('error', () => {});
  const savedEnv = Object.fromEntries(['RELEASE_MODE', 'TRUSTED_INGRESS_SECRET'].map(key => [key, process.env[key]]));
  process.env.RELEASE_MODE = 'production';
  process.env.TRUSTED_INGRESS_SECRET = secret;

  const nonceIds = new Set();
  const keys = new Set();
  const tickets = new Set();
  const expectedMessages = new Map();
const ipBase = Number.parseInt(randomUUID().replaceAll('-', '').slice(0, 2), 16) % 180 + 20;
const ips = [`198.51.100.${ipBase}`, `198.51.100.${ipBase + 1}`];
  const support = new SupportService(pool, sessionSecret, origin);
  const auth = {
    optionalActor:async()=>null,
    validateBackchannelLogout: async () => { throw new CommandError(401, 'INVALID_LOGOUT_TOKEN'); },
  };
  const appA = await createApp({ $queryRaw: async () => [] }, support, { auth }, { consumeNonce: nonceConsumer(pool) });
  const appB = await createApp({ $queryRaw: async () => [] }, support, { auth }, { consumeNonce: nonceConsumer(pool) });
  try {
    await Promise.all([appA.listen(0, '127.0.0.1'), appB.listen(0, '127.0.0.1')]);
    const urlA = await appA.getUrl(), urlB = await appB.getUrl();
    async function post(base, body, options = {}) {
      const path = options.path ?? '/api/v1/support';
      const key = options.key ?? randomUUID();
      keys.add(key);
      const nonce = options.nonce ?? randomUUID().replaceAll('-', '');
      nonceIds.add(nonce);
      const headers = signedHeaders({
        method: 'POST', path, body, nonce,
        clientIp: options.clientIp ?? ips[0],
        contentType: options.contentType ?? 'application/json',
        extra: { 'Idempotency-Key': key },
      });
      return fetch(`${base}${path}`, { method: 'POST', headers, body });
    }

    // The same signed nonce sent concurrently to separate Nest processes has one winner.
    const raceBody = contactBody('same nonce from two API instances');
    const raceNonce = randomUUID().replaceAll('-', '');
    nonceIds.add(raceNonce);
    const raceKey = randomUUID();
    keys.add(raceKey);
    const racePath = '/api/v1/support';
    const raceHeaders = signedHeaders({ method: 'POST', path: racePath, body: raceBody, nonce: raceNonce, clientIp: ips[0], extra: { 'Idempotency-Key': raceKey } });
    const race = await Promise.all([
      fetch(`${urlA}${racePath}`, { method: 'POST', headers: raceHeaders, body: raceBody }),
      fetch(`${urlB}${racePath}`, { method: 'POST', headers: raceHeaders, body: raceBody }),
    ]);
    assert.deepEqual(race.map(response => response.status).sort(), [201, 403]);
    for (const response of race) {
      assert.match(response.headers.get('cache-control') ?? '', /no-store/);
      if (response.status === 201) {
        const receipt = await response.json();
        tickets.add(receipt.id);
        expectedMessages.set(receipt.id, 'same nonce from two API instances');
      }
      else await response.arrayBuffer();
    }

    // A forged forwarding header is ignored. The signed provider address is used
    // for shared support rate limits: three requests pass, then the fourth is held.
    for (let i = 0; i < 2; i++) {
      const response = await post(i % 2 ? urlB : urlA, contactBody(`signed IP one ${i}`), { clientIp: ips[0] });
      assert.equal(response.status, 201);
      assert.match(response.headers.get('cache-control') ?? '', /no-store/);
      const receipt = await response.json();
      tickets.add(receipt.id);
      expectedMessages.set(receipt.id, `signed IP one ${i}`);
    }
    const limited = await post(urlA, contactBody('signed IP one over limit'), { clientIp: ips[0] });
    assert.equal(limited.status, 429);
    assert.match(limited.headers.get('cache-control') ?? '', /no-store/);
    await limited.arrayBuffer();
    const otherAddress = await post(urlB, contactBody('separate signed address bucket'), { clientIp: ips[1] });
    assert.equal(otherAddress.status, 201);
    const otherReceipt = await otherAddress.json();
    tickets.add(otherReceipt.id);
    expectedMessages.set(otherReceipt.id, 'separate signed address bucket');

    const bucketRows = await pool.query(`SELECT principal_hash,counter FROM rate_limit_bucket WHERE route='/support' AND principal_hash=ANY($1::text[])`, [ips.map(supportHash)]);
    assert.equal(bucketRows.rowCount, 2, 'each authenticated ingress client IP maps to its own support bucket');
    const byPrincipal = new Map(bucketRows.rows.map(row => [row.principal_hash, row.counter]));
    assert.equal(byPrincipal.get(supportHash(ips[0])), 3, 'the rolled-back rate-limit attempt does not persist a fourth counter');
    assert.equal(byPrincipal.get(supportHash(ips[1])), 1);

    // Invalid/missing signatures, malformed/expired timestamps, and method/path/body
    // edits are stopped before the support controller sees the request.
    const goodBody = contactBody('forgery cases');
    const goodPath = '/api/v1/support';
    const baseNonce = randomUUID().replaceAll('-', '');
    const signed = signedHeaders({ method: 'POST', path: goodPath, body: goodBody, nonce: baseNonce });
    for (const [label, headers, path, alteredBody] of [
      ['missing-signature', Object.fromEntries(Object.entries(signed).filter(([name]) => name !== 'x-trusted-ingress-signature')), goodPath, goodBody],
      ['invalid-nonce', { ...signed, 'x-trusted-ingress-nonce': 'bad nonce' }, goodPath, goodBody],
      ['expired-timestamp', { ...signed, 'x-trusted-ingress-timestamp': String(Math.floor(Date.now() / 1000) - 61) }, goodPath, goodBody],
      ['altered-path', signed, '/api/v1/support?altered=1', goodBody],
      ['altered-body', signed, goodPath, contactBody('edited after signing')],
    ]) {
      const response = await fetch(`${urlA}${path}`, { method: 'POST', headers, body: alteredBody });
      assert.equal(response.status, 403, label);
      assert.match(response.headers.get('cache-control') ?? '', /no-store/, label);
      await response.arrayBuffer();
    }

    // URL-encoded form and raw image bytes use the same exact-body signature path.
    // The endpoint rejects their business DTOs, which proves ingress accepted the
    // signatures and the API parser retained its normal transport behavior.
    const formPath = '/api/v1/support';
    const form = Buffer.from('email=p14%40example.invalid&category=other&subject=Form&message=bound&consent=true');
    const formResponse = await post(urlB, form, { path: formPath, contentType: 'application/x-www-form-urlencoded' });
    assert.notEqual(formResponse.status, 403, 'correctly signed form reaches its DTO validation');
    assert.match(formResponse.headers.get('cache-control') ?? '', /no-store/);
    await formResponse.arrayBuffer();
    const imagePath = '/api/v1/support';
    const imageBody = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
    const imageResponse = await post(urlA, imageBody, { path: imagePath, contentType: 'image/png' });
    assert.notEqual(imageResponse.status, 403, 'correctly signed raw image reaches its DTO validation');
    assert.match(imageResponse.headers.get('cache-control') ?? '', /no-store/);
    await imageResponse.arrayBuffer();

    // OIDC logout is an explicit bypass from ingress only; the endpoint still calls
    // the provider-token verifier, which rejects this unsigned/invalid logout token.
    const logoutBody = Buffer.from('logout_token=not-a-provider-token');
    const logout = await fetch(`${urlA}/api/v1/webhooks/oidc/logout`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: logoutBody,
    });
    assert.equal(logout.status, 401);
    assert.match(logout.headers.get('cache-control') ?? '', /no-store/);
    await logout.arrayBuffer();

    const created = await pool.query('SELECT id FROM support_ticket WHERE id=ANY($1::uuid[])', [[...tickets]]);
    assert.equal(created.rowCount, tickets.size);
    const storedMessages = await pool.query(`SELECT ticket_id,body FROM support_message WHERE ticket_id=ANY($1::uuid[]) AND visibility='requester'`, [[...tickets]]);
    assert.equal(storedMessages.rowCount, expectedMessages.size);
    for (const row of storedMessages.rows) assert.equal(row.body, expectedMessages.get(row.ticket_id), 'the controller receives parsed request text unchanged');
  } finally {
    try {
      await pool.query("DELETE FROM side_effect_delivery WHERE channel='support_email' AND payload->>'ticketId'=ANY($1::text[])", [[...tickets]]);
      await pool.query('DELETE FROM support_message WHERE ticket_id=ANY($1::uuid[])', [[...tickets]]);
      await pool.query('DELETE FROM support_ticket WHERE id=ANY($1::uuid[])', [[...tickets]]);
      await pool.query("DELETE FROM idempotency_record WHERE route='/support' AND key=ANY($1::text[])", [[...keys]]);
      await pool.query('DELETE FROM trusted_ingress_nonce WHERE nonce=ANY($1::text[])', [[...nonceIds]]);
      await pool.query("DELETE FROM rate_limit_bucket WHERE route='/support' AND principal_hash=ANY($1::text[])", [ips.map(supportHash)]);
    } finally {
      await Promise.all([appA.close(), appB.close()]);
      await pool.end();
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
});
