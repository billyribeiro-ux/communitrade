import assert from 'node:assert/strict';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import test from 'node:test';
import { createObjectStores, R2ExportStorage, R2Storage } from '../dist/index.js';

const endpoint = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';
const credentials = { endpoint, bucket: 'private-objects', accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-access-key-0123456789' };
const mediaId = '00000000-0000-4000-8000-000000000001';
const access = { actorUserId: 'owner', ownerUserId: 'owner', purpose: 'avatar', status: 'ready', attachedPublicAvatar: false };
const hash = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

function checkSignature(url, init, secret = credentials.secretAccessKey) {
  const headers = Object.fromEntries(Object.entries(init.headers).map(([key, value]) => [key.toLowerCase(), value]));
  const auth = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/auto\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(headers.authorization);
  if (!auth) return false;
  const signed = auth[3].split(';');
  const canonicalHeaders = signed.map(name => `${name}:${name === 'host' ? url.host : headers[name].trim().replace(/\s+/g, ' ')}\n`).join('');
  const canonical = `${init.method}\n${url.pathname}\n\n${canonicalHeaders}\n${auth[3]}\n${headers['x-amz-content-sha256']}`;
  const scope = `${auth[2]}/auto/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${headers['x-amz-date']}\n${scope}\n${hash(canonical)}`;
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, auth[2]), 'auto'), 's3'), 'aws4_request');
  const expected = createHmac('sha256', key).update(stringToSign).digest();
  return timingSafeEqual(expected, Buffer.from(auth[4], 'hex'));
}

function memoryR2({ tamper = false, fail = false } = {}) {
  const objects = new Map(); const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url: new URL(url), init: { ...init, headers: { ...init.headers } } });
    if (!checkSignature(url, init)) return new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 });
    if (tamper) {
      const altered = { ...init, headers: { ...init.headers, 'x-amz-content-sha256': '0'.repeat(64) } };
      if (checkSignature(url, altered)) throw new Error('tampered signed headers unexpectedly passed verification');
      return new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 });
    }
    if (fail) return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
    const key = decodeURIComponent(url.pathname.slice(('/private-objects/').length));
    if (init.method === 'PUT') {
      if (init.headers['if-none-match'] === '*' && objects.has(key)) return new Response('', { status: 412 });
      objects.set(key, Buffer.from(init.body)); return new Response('', { status: 200 });
    }
    if (init.method === 'GET') return objects.has(key) ? new Response(objects.get(key), { status: 200 }) : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    if (init.method === 'DELETE') { objects.delete(key); return new Response(null, { status: 204 }); }
    throw new Error(`unexpected method ${init.method}`);
  };
  return { fetch, objects, requests };
}

test('R2 media adapter keeps reads private and blocks quarantine or invalid keys before transport', async () => {
  const mock = memoryR2(); const storage = new R2Storage({ ...credentials, fetch: mock.fetch });
  const key = await storage.putQuarantined(mediaId, Buffer.from('original'));
  assert.equal(key, `${mediaId}/quarantine.bin`);
  await assert.rejects(storage.readAuthorized(key, access), /unavailable/);
  await assert.rejects(storage.readAuthorized(`${mediaId}/processed.webp`, { ...access, actorUserId: 'other' }), /unavailable/);
  await assert.rejects(storage.readAuthorized('../secret/processed.webp', access), /Invalid object key/);
  await assert.rejects(storage.readQuarantined('../secret'), /Invalid media identity/);
  assert.equal(mock.requests.length, 1, 'rejected access never reaches object storage');
  await storage.deleteObject(key);
  await storage.deleteObject(key);
  assert.equal(mock.objects.size, 0, 'missing-object deletes are idempotent');
});

test('R2 processed media permits public reads only for explicit ready attachments and writes immutably', async () => {
  const mock = memoryR2(); const storage = new R2Storage({ ...credentials, fetch: mock.fetch });
  const bytes = Buffer.from('processed webp bytes'); const key = await storage.putProcessed(mediaId, bytes);
  assert.equal(await storage.putImmutableProcessed(mediaId, bytes), key, 'identical retries are idempotent');
  await assert.rejects(storage.putImmutableProcessed(mediaId, Buffer.from('replacement')), /already exists/);
  const publicAvatar = { ...access, actorUserId: 'visitor', attachedPublicAvatar: true };
  assert.deepEqual(await storage.readAuthorized(key, publicAvatar), bytes);
  await assert.rejects(storage.readAuthorized(key, { ...publicAvatar, attachedPublicAvatar: false }), /unavailable/);
  assert.ok(mock.requests.every(({ url }) => url.protocol === 'https:' && !url.search && !url.hash));
  assert.ok(mock.requests.every(({ init }) => init.headers.authorization.startsWith('AWS4-HMAC-SHA256')));
});

test('R2 export objects are private keys, bounded, conditional, and retryable only for identical bytes', async () => {
  const mock = memoryR2(); const storage = new R2ExportStorage({ ...credentials, fetch: mock.fetch });
  const id = '00000000-0000-4000-8000-000000000002';
  const key = await storage.put(id, Buffer.from('private export'), 2, 'json');
  assert.equal(key, `${id}-a2.json`);
  assert.equal((await storage.read(key)).toString(), 'private export');
  assert.equal(await storage.put(id, Buffer.from('private export'), 2, 'json'), key);
  await assert.rejects(storage.put(id, Buffer.from('other'), 2, 'json'), /already exists/);
  await assert.rejects(storage.read('../public'), /Invalid object key/);
  await assert.rejects(storage.put(id, Buffer.alloc(50 * 1024 * 1024 + 1)), /configured bounds/);
  assert.ok(mock.requests.every(({ url }) => !url.href.includes('X-Amz-Signature')));
});

test('R2 validates production endpoint and bucket and rejects altered signed request fields', async () => {
  assert.throws(() => new R2Storage({ ...credentials, endpoint: 'http://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com', fetch: memoryR2().fetch }), /HTTPS/);
  assert.throws(() => new R2Storage({ ...credentials, endpoint: 'https://attacker.example', fetch: memoryR2().fetch }), /host is invalid/);
  assert.throws(() => new R2Storage({ ...credentials, bucket: '../objects', fetch: memoryR2().fetch }), /bucket name is invalid/);
  const mock = memoryR2({ tamper: true }); const storage = new R2Storage({ ...credentials, fetch: mock.fetch });
  await assert.rejects(storage.putProcessed(mediaId, Buffer.from('image')), /SignatureDoesNotMatch/);
  assert.equal(mock.requests.length, 1);
});

test('R2 provider failures and transport failures remain errors with bounded safe messages', async () => {
  const denied = new R2Storage({ ...credentials, fetch: memoryR2({ fail: true }).fetch });
  await assert.rejects(denied.readQuarantined(mediaId), /R2 request failed \(403: AccessDenied\)/);
  const offline = new R2Storage({ ...credentials, fetch: async () => { throw new Error('connection detail'); } });
  await assert.rejects(offline.readQuarantined(mediaId), error => error.message === 'R2 request failed' && error.cause.message === 'connection detail');
});

test('R2 retries transient deletes, treats missing keys as success, and does not retry writes', async () => {
  let deleteCalls = 0; let putCalls = 0;
  const fetch = async (url, init) => {
    assert.equal(checkSignature(url, init), true);
    if (init.method === 'DELETE' && deleteCalls++ === 0) return new Response('', { status: 503 });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    if (init.method === 'PUT' && putCalls++ === 0) return new Response('', { status: 503 });
    return new Response('', { status: 200 });
  };
  const storage = new R2Storage({ ...credentials, fetch });
  await storage.deleteObject(`${mediaId}/processed.webp`);
  assert.equal(deleteCalls, 2, 'transient delete is retried once');
  await assert.rejects(storage.putProcessed(mediaId, Buffer.from('bytes')), /R2 request failed \(503/);
  assert.equal(putCalls, 1, 'PUT is not retried after an uncertain provider response');
});

test('R2 object-store factory requires valid server-only account configuration', () => {
  const env = { R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', R2_BUCKET: 'private-objects', R2_ACCESS_KEY_ID: 'test-access-key', R2_SECRET_ACCESS_KEY: credentials.secretAccessKey };
  const stores = createObjectStores(env);
  assert.ok(stores.media instanceof R2Storage);
  assert.ok(stores.exportStorage instanceof R2ExportStorage);
  assert.throws(() => createObjectStores({ ...env, R2_ACCOUNT_ID: 'attacker.example' }), /R2_ACCOUNT_ID/);
  assert.throws(() => createObjectStores({ ...env, R2_TIMEOUT_MS: '0' }), /R2_TIMEOUT_MS/);
  assert.throws(() => createObjectStores({ ...env, R2_BUCKET: 'bad/../bucket' }), /bucket name is invalid/);
});
