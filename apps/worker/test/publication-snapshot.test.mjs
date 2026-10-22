import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {
  assertSnapshotJob,
  assertPublicationSnapshotConfiguration,
  configuredOrigin,
  dispatchPublicationSnapshotOutbox,
  installSnapshotResourceAllowlist,
  preparePublicationSnapshot,
  processPublicationSnapshot,
  reconcilePublicationSnapshotJobs,
  snapshotRouteUrl,
} from '../dist/publication-snapshot.js';

const JOB = '00000000-0000-4000-8000-000000000001';
const VERSION = '00000000-0000-4000-8000-000000000002';
const OWNER = '00000000-0000-4000-8000-000000000003';

function fakePool(job) {
  const calls = [];
  const client = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT id,owner_user_id')) return { rows: job ? [job] : [], rowCount: job ? 1 : 0 };
      if (sql.startsWith('UPDATE publication_job')) return { rows: [{ id: JOB }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release() { calls.push({ sql: 'RELEASE' }); },
  };
  return { calls, pool: { connect: async () => client } };
}

test('snapshot job boundary rejects malformed and extra client fields', () => {
  assert.throws(() => assertSnapshotJob({ jobId: 'not-a-uuid' }), /INVALID_SNAPSHOT_JOB/);
  assert.throws(() => assertSnapshotJob({ jobId: JOB, image: 'arbitrary-client-upload' }), /INVALID_SNAPSHOT_JOB/);
  assert.doesNotThrow(() => assertSnapshotJob({ jobId: JOB }));
});

test('render origin is pinned to configured internal service and route binds job plus short token', () => {
  assert.equal(configuredOrigin('http://web:3000', 'web').origin, 'http://web:3000');
  assert.throws(() => configuredOrigin('https://attacker.example', 'web'), /SNAPSHOT_ORIGIN_INVALID/);
  assert.throws(() => configuredOrigin('http://attacker.example', 'web'), /SNAPSHOT_ORIGIN_NOT_ALLOWED/);
  const route = snapshotRouteUrl(new URL('http://web:3000'), JOB, 'opaque-token');
  assert.equal(route.pathname, `/internal/publication-snapshots/${JOB}`);
  assert.equal(route.searchParams.get('token'), 'opaque-token');
});

test('worker refuses startup without both private service origins and a strong HMAC secret', () => {
  const env = { PUBLICATION_RENDER_BASE_URL: 'http://web:3000', PUBLICATION_API_BASE_URL: 'http://api:3001', PUBLICATION_RENDER_HMAC_SECRET: 'worker-and-route-shared-secret-at-least-32-bytes' };
  assert.doesNotThrow(() => assertPublicationSnapshotConfiguration(env));
  assert.throws(() => assertPublicationSnapshotConfiguration({ ...env, PUBLICATION_RENDER_BASE_URL: undefined }), /configuration/i);
  assert.throws(() => assertPublicationSnapshotConfiguration({ ...env, PUBLICATION_RENDER_HMAC_SECRET: 'short' }), /configuration/i);
});

test('job preparation locks and rotates nonce with a bounded expiry; active and completed work is inert', async () => {
  const now = new Date('2026-10-20T12:00:00.000Z');
  const { pool, calls } = fakePool({ id: JOB, owner_user_id: OWNER, publication_version_id: VERSION, status: 'pending', render_nonce_expires_at: now, attempts: 0 });
  const prepared = await preparePublicationSnapshot(pool, JOB, now);
  assert.equal(prepared.jobId, JOB);
  assert.equal(prepared.ownerUserId, OWNER);
  assert.equal(prepared.publicationVersionId, VERSION);
  assert.notEqual(prepared.nonce, undefined);
  assert.equal(Date.parse(prepared.expiresAt) - now.getTime(), 90_000);
  assert.ok(calls.some((call) => call.sql.includes('FOR UPDATE')));
  assert.ok(calls.some((call) => call.sql.includes('render_claimed_at=NULL')));
  assert.equal(await preparePublicationSnapshot(fakePool({ id: JOB, owner_user_id: OWNER, publication_version_id: VERSION, status: 'succeeded', render_nonce_expires_at: now, attempts: 0 }).pool, JOB, now), null);
  assert.deepEqual(await preparePublicationSnapshot(fakePool({ id: JOB, owner_user_id: OWNER, publication_version_id: VERSION, status: 'running', render_nonce_expires_at: new Date(now.getTime() + 10_000), attempts: 1 }).pool, JOB, now), { busyUntil: '2026-10-20T12:00:10.000Z' });
});

test('preparation terminalizes an expired exhausted lease and releases the initial draft lock', async () => {
  const now = new Date('2026-10-20T12:02:00.000Z');
  const { pool, calls } = fakePool({
    id: JOB, owner_user_id: OWNER, draft_id: '00000000-0000-4000-8000-000000000004',
    publication_version_id: VERSION, status: 'running', render_nonce_expires_at: new Date(now.getTime() - 1), attempts: 5,
    candidate: { publishMode: 'initial' },
  });
  assert.equal(await preparePublicationSnapshot(pool, JOB, now), null);
  assert.ok(calls.some((call) => call.sql.includes("status='failed',failure_code='SNAPSHOT_ATTEMPTS_EXHAUSTED'")));
  assert.ok(calls.some((call) => call.sql.startsWith('UPDATE draft SET plan=plan-')));
  assert.equal(calls.some((call) => call.sql.includes('UPDATE publication SET')), false);
});

test('bounded recovery requeues lost leases and stale pending jobs, but exhausts them without public side effects', async () => {
  const rows = [
    { id: JOB, owner_user_id: OWNER, publication_version_id: VERSION, draft_id: 'draft-initial', status: 'running', render_nonce_expires_at: new Date('2026-10-20T11:00:00Z'), attempts: 5, candidate: { publishMode: 'initial' } },
    { id: '00000000-0000-4000-8000-000000000007', owner_user_id: OWNER, publication_version_id: VERSION, draft_id: 'draft-correction', status: 'running', render_nonce_expires_at: new Date('2026-10-20T11:00:00Z'), attempts: 5, candidate: { publishMode: 'correction' } },
    { id: '00000000-0000-4000-8000-000000000008', owner_user_id: OWNER, publication_version_id: VERSION, draft_id: 'draft-retry', status: 'running', render_nonce_expires_at: new Date('2026-10-20T11:00:00Z'), attempts: 4, candidate: { publishMode: 'initial' } },
    { id: '00000000-0000-4000-8000-000000000009', owner_user_id: OWNER, publication_version_id: VERSION, draft_id: 'draft-lost', status: 'pending', render_nonce_expires_at: new Date('2026-10-20T11:00:00Z'), attempts: 1, candidate: { publishMode: 'initial' } },
  ];
  const calls = [];
  const client = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.includes('FROM publication_job j')) return { rows, rowCount: rows.length };
      if (sql.startsWith('SELECT id FROM outbox_event')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const result = await reconcilePublicationSnapshotJobs({ connect: async () => client }, { limit: 50 });
  assert.deepEqual(result, { requeued: 2, failed: 2 });
  assert.equal(calls.filter((call) => call.sql.includes("status='failed',failure_code='SNAPSHOT_ATTEMPTS_EXHAUSTED'")).length, 2);
  assert.equal(calls.filter((call) => call.sql.startsWith('UPDATE draft SET plan=plan-')).length, 1);
  assert.equal(calls.filter((call) => call.sql.startsWith('UPDATE correction_request SET status=')).length, 1);
  assert.equal(calls.filter((call) => call.sql.startsWith('INSERT INTO outbox_event')).length, 2);
  assert.equal(calls.filter((call) => call.sql.includes("status='pending',render_nonce_expires_at=now()")).length, 2);
  assert.equal(calls.some((call) => call.sql.includes('UPDATE publication SET')), false);
});

test('snapshot recovery enforces its small batch limit before connecting to the database', async () => {
  let connects = 0;
  const pool = { connect: async () => { connects += 1; throw new Error('should not connect'); } };
  await assert.rejects(reconcilePublicationSnapshotJobs(pool, { limit: 0 }), /between 1 and 100/);
  await assert.rejects(reconcilePublicationSnapshotJobs(pool, { limit: 101 }), /between 1 and 100/);
  assert.equal(connects, 0);
});

test('browser resource allowlist blocks realtime refresh, external and non-GET requests', async () => {
  const handler = { current: null, websocket: null };
  const page = {
    routeWebSocket: async (pattern, callback) => { assert.equal(pattern, '**/*'); handler.websocket = callback; },
    route: async (_pattern, callback) => { handler.current = callback; },
  };
  await installSnapshotResourceAllowlist(page, new URL('http://web:3000'));
  let discarded;
  await handler.websocket({
    url: () => 'wss://evil.example/_next/hmr',
    onMessage: (callback) => { discarded = callback; },
    connectToServer: () => { assert.fail('Frozen captures must never connect a WebSocket upstream'); },
    close: () => { assert.fail('Closing HMR would trigger development reconnect/reload'); },
    send: () => { assert.fail('Frozen captures must never receive realtime messages'); },
  });
  assert.equal(discarded('synthetic HMR message'), undefined);
  const received = [];
  let serverMessage;
  let disconnected;
  await handler.websocket({
    url: () => 'ws://web:3000/_next/hmr?id=synthetic',
    onMessage: () => {},
    connectToServer: () => ({
      onMessage: (callback) => { serverMessage = callback; },
      onClose: (callback) => { disconnected = callback; },
    }),
    send: (message) => received.push(message),
  });
  const debugChunk = Buffer.from([0, 2, 97, 98, 99]);
  serverMessage(debugChunk);
  serverMessage(JSON.stringify({ type: 'reloadPage' }));
  serverMessage(Buffer.from([1, 0, 99]));
  serverMessage(Buffer.from([0, 8, 99]));
  assert.deepEqual(received, [debugChunk]);
  assert.equal(disconnected(), undefined);
  const results = [];
  const route = (url, method = 'GET') => ({
    request: () => ({ url: () => url, method: () => method }),
    continue: async () => results.push('continue'),
    abort: async () => results.push('abort'),
  });
  await handler.current(route('http://web:3000/_next/static/chunk.js'));
  await handler.current(route('http://evil.example/steal'));
  await handler.current(route('http://web:3000/api/upload', 'POST'));
  assert.deepEqual(results, ['continue', 'abort', 'abort']);
});

test('outbox dispatch sends only publication job identifiers and commits delivery after queue acceptance', async () => {
  const calls = [];
  const client = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.includes('SELECT e.id,e.aggregate_id')) return { rows: [{ id: '00000000-0000-4000-8000-000000000011', aggregate_id: JOB }] };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const sent = [];
  const count = await dispatchPublicationSnapshotOutbox({ connect: async () => client }, async (queue, data, options) => {
    sent.push({ queue, data, options });
    return 'accepted';
  });
  assert.equal(count, 1);
  assert.deepEqual(sent[0].data, { jobId: JOB });
  assert.equal(sent[0].queue, 'publication.snapshot');
  assert.equal(sent[0].options.id, '00000000-0000-4000-8000-000000000011');
  assert.equal('singletonSeconds' in sent[0].options, false);
  assert.match(calls.find((call) => call.sql.includes('SELECT e.id,e.aggregate_id')).sql, /j\.status='pending'/);
  assert.ok(calls.some((call) => call.sql.includes("status='delivered'")));
});

test('outbox queue failures keep the publication pending and schedule bounded retry instead of orphaning it', async () => {
  const calls = [];
  const client = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.includes('SELECT e.id,e.aggregate_id')) return { rows: [{ id: 'event-2', aggregate_id: JOB }] };
      return { rows: [], rowCount: 1 };
    }, release() {},
  };
  const count = await dispatchPublicationSnapshotOutbox({ connect: async () => client }, async () => { throw new Error('queue unavailable'); });
  assert.equal(count, 0);
  const retry = calls.find((call) => call.sql.includes('UPDATE outbox_event SET attempts'));
  assert.match(retry.sql, /available_at=now\(\)\+make_interval/);
  assert.equal(retry.sql.includes("status='failed'"), false);
});

test('outbox retry uses the event UUID as the idempotent queue job ID and no time-bucket singleton', async () => {
  const calls = [];
  const client = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.includes('SELECT e.id,e.aggregate_id')) return { rows: [{ id: '00000000-0000-4000-8000-000000000010', aggregate_id: JOB }] };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const optionsSeen = [];
  const delivered = await dispatchPublicationSnapshotOutbox({ connect: async () => client }, async (_queue, _data, options) => {
    optionsSeen.push(options);
    return null; // duplicate deterministic ID means the same durable pg-boss job already exists
  });
  assert.equal(delivered, 1);
  assert.equal(optionsSeen[0].id, '00000000-0000-4000-8000-000000000010');
  assert.equal('singletonSeconds' in optionsSeen[0], false);
  assert.equal('singletonKey' in optionsSeen[0], false);
  assert.ok(calls.some((call) => call.sql.includes("status='delivered'")));
});

function capturePool() {
  const client = {
    query: async (sql) => {
      if (sql.startsWith('SELECT id,owner_user_id')) return { rows: [{ id: JOB, owner_user_id: OWNER, publication_version_id: VERSION, status: 'pending', render_nonce_expires_at: new Date(), attempts: 0 }] };
      return { rows: [{ id: JOB }], rowCount: 1 };
    }, release() {},
  };
  return { connect: async () => client };
}

function fakeBrowser({ png, failAt, captureError, captureDelay=0 } = {}) {
  const events = [];
  const page = {
    routeWebSocket: async () => {},
    route: async () => {},
    goto: async (_url, options) => {
      events.push('goto');
      events.push(`wait:${options.waitUntil}`);
      if (failAt === 'goto') throw new Error('SNAPSHOT_NAVIGATION_FAILED');
      if (failAt === 'http') return { ok: () => false, status: () => 404 };
      return { ok: () => true, status: () => 200 };
    },
    locator: (selector) => ({
      waitFor: async () => {
        events.push('ready');
        if (failAt === 'ready') throw new Error('SNAPSHOT_RENDER_TIMEOUT');
        if (selector.includes('snapshot-error') && failAt === 'render-error') return;
      },
      count: async () => selector.includes('snapshot-error') && failAt === 'render-error' ? 1 : 0,
      getAttribute: async () => {
        if (failAt !== 'render-error') throw new Error('Locator did not resolve; getAttribute would wait until timeout');
        return 'viewport';
      },
    }),
    evaluate: async () => {events.push('capture');if(captureDelay-->0)return{pending:true};return captureError ? {error:captureError} : {base64:png.toString('base64')};},
  };
  const context = { newPage: async () => page, close: async () => events.push('context-close') };
  const browser = { newContext: async () => context, close: async () => events.push('browser-close') };
  return { browser, events };
}

test('trusted worker captures, converts, stores immutable WebP, and completes the frozen version', async () => {
  const png = await sharp({ create: { width: 1200, height: 760, channels: 3, background: '#123456' } }).png().toBuffer();
  const { browser, events } = fakeBrowser({ png, captureDelay:1 });
  const apiCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    apiCalls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return { ok: true };
  };
  const stored = new Map();
  const storage = {
    readAuthorized: async (key) => { if (!stored.has(key)) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } return stored.get(key); },
    putImmutableProcessed: async (id, bytes) => { const key = `${id}/processed.webp`; if (stored.has(key)) { const error = new Error('exists'); error.code = 'EEXIST'; throw error; } stored.set(key, Buffer.from(bytes)); return key; },
  };
  try {
    await processPublicationSnapshot(capturePool(), storage, { jobId: JOB }, 0, 5, {
      renderBaseUrl: 'http://web:3000', apiBaseUrl: 'http://api:3001', secret: 'worker-and-route-shared-secret-at-least-32-bytes', launch: async () => browser,
    });
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(apiCalls.length, 1);
  assert.match(apiCalls[0].url, /\/complete$/);
  assert.equal(apiCalls[0].body.objectKey, `${VERSION}/processed.webp`);
  assert.equal(apiCalls[0].body.width, 1200);
  assert.equal(apiCalls[0].body.height, 760);
  assert.equal(apiCalls[0].body.mime, 'image/webp');
  assert.match(apiCalls[0].body.checksum, /^[a-f0-9]{64}$/);
  assert.equal((await sharp(stored.get(`${VERSION}/processed.webp`)).metadata()).format, 'webp');
  assert.ok(events.includes('context-close'));
  assert.ok(events.includes('browser-close'));
  assert.ok(events.includes('wait:domcontentloaded'));
});

test('capture failure closes browser resources and reports bounded retry state', async () => {
  const { browser, events } = fakeBrowser({ png: Buffer.alloc(0), failAt: 'goto' });
  const apiCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { apiCalls.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true }; };
  try {
    await assert.rejects(processPublicationSnapshot(capturePool(), {}, { jobId: JOB }, 0, 5, {
      renderBaseUrl: 'http://web:3000', apiBaseUrl: 'http://api:3001', secret: 'worker-and-route-shared-secret-at-least-32-bytes', launch: async () => browser,
    }), /SNAPSHOT_NAVIGATION_FAILED/);
  } finally { globalThis.fetch = originalFetch; }
  assert.match(apiCalls[0].url, /\/fail$/);
  assert.equal(apiCalls[0].body.retryable, true);
  assert.equal(apiCalls[0].body.failureCode, 'SNAPSHOT_NAVIGATION_FAILED');
  assert.ok(events.includes('context-close'));
  assert.ok(events.includes('browser-close'));
});

test('worker surfaces a safe internal route HTTP status through the signed failure callback', async () => {
  const { browser, events } = fakeBrowser({ png: Buffer.alloc(0), failAt: 'http' });
  const apiCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { apiCalls.push(JSON.parse(init.body)); return { ok: true }; };
  try {
    await assert.rejects(processPublicationSnapshot(capturePool(), {}, { jobId: JOB }, 0, 5, {
      renderBaseUrl: 'http://web:3000', apiBaseUrl: 'http://api:3001', secret: 'worker-and-route-shared-secret-at-least-32-bytes', launch: async () => browser,
    }), /SNAPSHOT_ROUTE_HTTP_404/);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(apiCalls[0].failureCode, 'SNAPSHOT_ROUTE_HTTP_404');
  assert.ok(events.includes('browser-close'));
});

test('worker reports the renderer init stage instead of waiting for its ready timeout', async () => {
  const { browser } = fakeBrowser({ png: Buffer.alloc(0), failAt: 'render-error' });
  const apiCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { apiCalls.push(JSON.parse(init.body)); return { ok: true }; };
  try {
    await assert.rejects(processPublicationSnapshot(capturePool(), {}, { jobId: JOB }, 0, 5, {
      renderBaseUrl: 'http://web:3000', apiBaseUrl: 'http://api:3001', secret: 'worker-and-route-shared-secret-at-least-32-bytes', launch: async () => browser,
    }), /SNAPSHOT_RENDER_VIEWPORT/);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(apiCalls[0].failureCode, 'SNAPSHOT_RENDER_VIEWPORT');
});

for (const [name, failFetch] of [
  ['API outage', async () => { throw new Error('connection refused'); }],
  ['expired render token', async () => ({ ok: false, status: 409 })],
]) {
  test(`final capture attempt surfaces a failed /fail callback after ${name}`, async () => {
    const { browser, events } = fakeBrowser({ png: Buffer.alloc(0), failAt: 'goto' });
    let callbackBody;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => { callbackBody = JSON.parse(init.body); return failFetch(); };
    try {
      await assert.rejects(processPublicationSnapshot(capturePool(), {}, { jobId: JOB }, 5, 5, {
        renderBaseUrl: 'http://web:3000', apiBaseUrl: 'http://api:3001', secret: 'worker-and-route-shared-secret-at-least-32-bytes', launch: async () => browser,
      }), /SNAPSHOT_FAILURE_REPORT_FAILED/);
    } finally { globalThis.fetch = originalFetch; }
    assert.equal(callbackBody.retryable, false);
    assert.ok(events.includes('context-close'));
    assert.ok(events.includes('browser-close'));
  });
}

test('unexpected snapshot SDK errors expose only their safe stage to the API and queue',async()=>{
 const originalFetch=globalThis.fetch,calls=[];globalThis.fetch=async(_url,init)=>{calls.push(JSON.parse(init.body));return{ok:true};};
 try{
  await assert.rejects(processPublicationSnapshot(capturePool(),{},{jobId:JOB},0,5,{renderBaseUrl:'http://web:3000',apiBaseUrl:'http://api:3001',secret:'worker-and-route-shared-secret-at-least-32-bytes',launch:async()=>{throw new Error('private renderer URL ?token=SECRET_SENTINEL');}}),error=>error.message==='SNAPSHOT_BROWSER_LAUNCH_FAILED');
  assert.deepEqual(calls,[{failureCode:'SNAPSHOT_BROWSER_LAUNCH_FAILED',retryable:true}]);
 }finally{globalThis.fetch=originalFetch;}
});


test('structured canvas readiness failures retain safe error codes across the browser bridge',async()=>{
 const {browser}=fakeBrowser({captureError:'SNAPSHOT_CANVAS_NOT_READY'}),calls=[],originalFetch=globalThis.fetch;globalThis.fetch=async(_url,init)=>{calls.push(JSON.parse(init.body));return{ok:true};};
 try{await assert.rejects(processPublicationSnapshot(capturePool(),{},{jobId:JOB},0,5,{renderBaseUrl:'http://web:3000',apiBaseUrl:'http://api:3001',secret:'worker-and-route-shared-secret-at-least-32-bytes',launch:async()=>browser}),{message:'SNAPSHOT_CANVAS_NOT_READY'});assert.equal(calls[0].failureCode,'SNAPSHOT_CANVAS_NOT_READY');}
 finally{globalThis.fetch=originalFetch;}
});
