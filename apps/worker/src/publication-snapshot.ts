import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { chromium, type Browser, type Page } from 'playwright';
import sharp from 'sharp';
import { type StoragePort, type MediaAccess } from '@trading/media';
import { PUBLICATION_RENDER_MAX_TTL_MS, signPublicationRenderToken } from '@trading/media/snapshot-token';

export interface PublicationSnapshotJob { jobId: string }
export interface PreparedPublicationSnapshot {
  jobId: string;
  ownerUserId: string;
  publicationVersionId: string;
  nonce: string;
  expiresAt: string;
}
export interface SnapshotPreparationBusy { busyUntil: string }
export interface SnapshotArtifact { objectKey: string; checksum: string; width: 1200; height: 760; mime: 'image/webp' }
export interface SnapshotRecoveryResult { requeued: number; failed: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CAPTURE_PNG_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_WEBP_BYTES = 4 * 1024 * 1024;
const RETRY_LIMIT = 5;
const STALE_PENDING_MS = 120_000;
const SNAPSHOT_WIDTH = 1200;
const SNAPSHOT_HEIGHT = 760;

export function assertSnapshotJob(value: unknown): asserts value is PublicationSnapshotJob {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1
      || Object.keys(value).some((key) => key !== 'jobId')
      || !UUID.test(String((value as Record<string, unknown>).jobId))) {
    throw new Error('INVALID_SNAPSHOT_JOB');
  }
}

export function configuredOrigin(value: string | undefined, expectedHost: string): URL {
  if (!value) throw new Error('SNAPSHOT_CONFIGURATION_MISSING');
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('SNAPSHOT_ORIGIN_INVALID');
  }
  if (expectedHost && url.hostname !== expectedHost) throw new Error('SNAPSHOT_ORIGIN_NOT_ALLOWED');
  return url;
}

export function assertPublicationSnapshotConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  configuredOrigin(env.PUBLICATION_RENDER_BASE_URL, 'web');
  configuredOrigin(env.PUBLICATION_API_BASE_URL, 'api');
  if (!env.PUBLICATION_RENDER_HMAC_SECRET || Buffer.byteLength(env.PUBLICATION_RENDER_HMAC_SECRET, 'utf8') < 32) {
    throw new Error('SNAPSHOT_CONFIGURATION_MISSING');
  }
}

interface SnapshotJobRow {
  id: string;
  owner_user_id: string;
  publication_version_id: string;
  draft_id: string;
  status: string;
  render_nonce_expires_at: Date | string;
  attempts: number;
  candidate: Record<string, unknown>;
}

async function failExhaustedSnapshotJob(client: Pick<import('pg').PoolClient, 'query'>, job: Pick<SnapshotJobRow, 'id' | 'draft_id' | 'owner_user_id' | 'candidate'>): Promise<void> {
  await client.query("UPDATE publication_job SET status='failed',failure_code='SNAPSHOT_ATTEMPTS_EXHAUSTED',render_claimed_at=NULL,updated_at=now() WHERE id=$1 AND status IN ('pending','running')", [job.id]);
  if (job.candidate.publishMode === 'correction') {
    await client.query("UPDATE correction_request SET status='requested' WHERE publication_job_id=$1 AND status='processing'", [job.id]);
  } else {
    await client.query("UPDATE draft SET plan=plan-'locked',revision=revision+1,updated_at=now() WHERE id=$1 AND owner_user_id=$2 AND plan->>'locked'='true'", [job.draft_id, job.owner_user_id]);
  }
}

async function queueSnapshotRecovery(client: Pick<import('pg').PoolClient, 'query'>, jobId: string): Promise<void> {
  const pending = await client.query(`SELECT id FROM outbox_event
    WHERE event_type='publication.snapshot' AND aggregate_type='publication_job' AND aggregate_id=$1 AND status='pending'
    LIMIT 1`, [jobId]);
  if (pending.rowCount) return;
  await client.query(`INSERT INTO outbox_event(id,event_type,aggregate_type,aggregate_id,revision,payload,status,available_at,attempts,created_at)
    VALUES($1,'publication.snapshot','publication_job',$2,
      (SELECT COALESCE(MAX(revision),0)+1 FROM outbox_event WHERE event_type='publication.snapshot' AND aggregate_type='publication_job' AND aggregate_id=$2),
      $3::jsonb,'pending',now(),0,now()) ON CONFLICT(event_type,aggregate_type,aggregate_id,revision) DO NOTHING`,
  [randomUUID(), jobId, JSON.stringify({ jobId })]);
}

/** Reconciles expired render leases and lost queue jobs without touching frozen candidates or public state. */
export async function reconcilePublicationSnapshotJobs(pool: Pool, { limit }: { limit: number }): Promise<SnapshotRecoveryResult> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Snapshot recovery limit must be between 1 and 100');
  const client = await pool.connect();
  let transaction = false;
  try {
    await client.query('BEGIN'); transaction = true;
    const result = await client.query<SnapshotJobRow>(`SELECT id,owner_user_id,publication_version_id,draft_id,status,render_nonce_expires_at,attempts,candidate
      FROM publication_job j
      WHERE (j.status='running' AND j.render_nonce_expires_at<=now())
        OR (j.status='pending' AND j.updated_at<=now()-($2::int * interval '1 millisecond')
          AND NOT EXISTS (SELECT 1 FROM outbox_event e WHERE e.event_type='publication.snapshot' AND e.aggregate_type='publication_job' AND e.aggregate_id=j.id AND e.status='pending'))
      ORDER BY j.updated_at,j.id LIMIT $1 FOR UPDATE OF j SKIP LOCKED`, [limit, STALE_PENDING_MS]);
    const recovered: SnapshotRecoveryResult = { requeued: 0, failed: 0 };
    for (const job of result.rows) {
      if (Number(job.attempts) >= RETRY_LIMIT) {
        await failExhaustedSnapshotJob(client, job);
        recovered.failed += 1;
        continue;
      }
      await client.query("UPDATE publication_job SET status='pending',render_nonce_expires_at=now(),render_claimed_at=NULL,failure_code=NULL,updated_at=now() WHERE id=$1 AND status IN ('pending','running')", [job.id]);
      await queueSnapshotRecovery(client, job.id);
      recovered.requeued += 1;
    }
    await client.query('COMMIT'); transaction = false;
    return recovered;
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/** Begins or resumes one expired/pending job and rotates its one-time render nonce under a row lock. */
export async function preparePublicationSnapshot(pool: Pool, jobId: string, now = new Date()): Promise<PreparedPublicationSnapshot | SnapshotPreparationBusy | null> {
  if (!UUID.test(jobId)) throw new Error('INVALID_SNAPSHOT_JOB');
  const client = await pool.connect();
  let transaction = false;
  try {
    await client.query('BEGIN'); transaction = true;
    const result = await client.query<SnapshotJobRow>(`SELECT id,owner_user_id,publication_version_id,draft_id,status,render_nonce_expires_at,attempts,candidate
      FROM publication_job WHERE id=$1 FOR UPDATE`, [jobId]);
    const job = result.rows[0];
    if (!job || !['pending', 'running'].includes(String(job.status))) {
      await client.query('COMMIT'); transaction = false; return null;
    }
    if (job.status === 'running' && new Date(job.render_nonce_expires_at).getTime() > now.getTime()) {
      const busyUntil = new Date(job.render_nonce_expires_at).toISOString();
      await client.query('COMMIT'); transaction = false; return { busyUntil };
    }
    if (Number(job.attempts) >= RETRY_LIMIT) {
      await failExhaustedSnapshotJob(client, job);
      await client.query('COMMIT'); transaction = false; return null;
    }
    const expiresAt = new Date(now.getTime() + Math.min(90_000, PUBLICATION_RENDER_MAX_TTL_MS - 1));
    const nonce = randomUUID();
    const updated = await client.query(`UPDATE publication_job SET status='running',render_nonce=$2,
      render_nonce_expires_at=$3,render_claimed_at=NULL,attempts=attempts+1,failure_code=NULL,updated_at=now()
      WHERE id=$1 AND status IN ('pending','running') RETURNING id`, [jobId, nonce, expiresAt.toISOString()]);
    if (!updated.rowCount) { await client.query('ROLLBACK'); transaction = false; return null; }
    await client.query('COMMIT'); transaction = false;
    return {
      jobId,
      ownerUserId: String(job.owner_user_id),
      publicationVersionId: String(job.publication_version_id),
      nonce,
      expiresAt: expiresAt.toISOString(),
    };
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export function snapshotRouteUrl(renderOrigin: URL, jobId: string, token: string): URL {
  if (!UUID.test(jobId) || token.length > 2048) throw new Error('INVALID_SNAPSHOT_ROUTE');
  const route = new URL(`/internal/publication-snapshots/${jobId}`, renderOrigin);
  route.searchParams.set('token', token);
  return route;
}

/** Allows only browser traffic to the configured local renderer origin. */
export async function installSnapshotResourceAllowlist(page: Page, renderOrigin: URL): Promise<void> {
  // Next 16.4.2 sends the development React Flight debug stream over HMR.
  // Permit only its binary debug chunks from this renderer's exact HMR route;
  // never relay hot updates, reload commands or client messages. Other sockets
  // stay inert without upstream access (closing triggers Next's reload loop).
  await page.routeWebSocket('**/*', (socket) => {
    socket.onMessage(() => undefined);
    const url = new URL(socket.url());
    const expected = new URL(renderOrigin);
    expected.protocol = 'ws:';
    if (url.origin !== expected.origin || url.pathname !== '/_next/hmr') return;
    const server = socket.connectToServer();
    server.onMessage((message) => {
      // REACT_DEBUG_CHUNK = 0; next byte is request-ID length, then ID/payload.
      if (!Buffer.isBuffer(message)) return;
      const requestIdLength = message[1];
      if (requestIdLength !== undefined && message.length >= 2 + requestIdLength && message[0] === 0) socket.send(message);
    });
    // A dev server disconnect must not reload/reclaim the one-use signed page.
    server.onClose(() => undefined);
  });
  await page.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url());
    const allowed = requestUrl.origin === renderOrigin.origin && requestUrl.protocol === 'http:'
      && ['GET', 'HEAD'].includes(route.request().method());
    if (allowed) await route.continue();
    else await route.abort('blockedbyclient');
  });
}

async function renderInBrowser(browser: Browser, renderOrigin: URL, jobId: string, token: string): Promise<Buffer> {
  const context = await browser.newContext({ viewport: { width: SNAPSHOT_WIDTH, height: SNAPSHOT_HEIGHT }, deviceScaleFactor: 1, serviceWorkers: 'block' });
  let renderStep = 'SNAPSHOT_PAGE_FAILED';
  try {
    const page = await context.newPage();
    let clientFailure:string|null=null;
    page.on?.('pageerror',()=>{clientFailure='SNAPSHOT_CLIENT_SCRIPT_FAILED';});
    page.on?.('response',response=>{try{const url=new URL(response.url());if(url.origin===renderOrigin.origin&&url.pathname.startsWith('/_next/')&&response.status()>=400)clientFailure='SNAPSHOT_CLIENT_ASSET_FAILED';}catch{/* Never retain browser URLs or messages. */}});
    renderStep = 'SNAPSHOT_ALLOWLIST_FAILED';
    await installSnapshotResourceAllowlist(page, renderOrigin);
    renderStep = 'SNAPSHOT_NAVIGATION_FAILED';
    const response = await page.goto(snapshotRouteUrl(renderOrigin, jobId, token).toString(), { waitUntil: 'domcontentloaded', timeout: 25_000 });
    if (response && !response.ok()) throw new Error(`SNAPSHOT_ROUTE_HTTP_${response.status()}`);
    renderStep = 'SNAPSHOT_READY_TIMEOUT';
    try{await page.locator('[data-publication-snapshot-ready="true"], [data-publication-snapshot-error]').waitFor({ state: 'attached', timeout: 20_000 });}catch(error){
      if(clientFailure)throw new Error(clientFailure);
      const stageMarker=page.locator('[data-publication-snapshot-stage]');
      const stage=await stageMarker.count()?await stageMarker.getAttribute('data-publication-snapshot-stage'):null;
      if(stage&&['hydrate','fonts','chart','paint'].includes(stage))throw new Error(`SNAPSHOT_READY_${stage.toUpperCase()}`);
      throw error;
    }
    renderStep = 'SNAPSHOT_MARKER_FAILED';
    const errorMarker = page.locator('[data-publication-snapshot-error]');
    const renderFailure = await errorMarker.count()
      ? await errorMarker.getAttribute('data-publication-snapshot-error')
      : null;
    if (renderFailure && /^[a-z-]{1,40}$/.test(renderFailure)) {
      throw new Error(`SNAPSHOT_RENDER_${renderFailure.replaceAll('-', '_').toUpperCase()}`);
    }
    renderStep = 'SNAPSHOT_CANVAS_CAPTURE_FAILED';
    let base64:string|undefined;
    let pendingCode='SNAPSHOT_CAPTURE_UNAVAILABLE';
    // Readiness can disappear between protocol round trips during a development remount.
    // Check the marker and invoke its paired callback atomically inside the browser.
    for(let attempt=0;attempt<50;attempt++){
      let captured:{base64?:string;error?:string;pending?:boolean};
      try{captured=await page.evaluate(() => {
        const snapshotWindow = window as Window & { __capturePublicationSnapshot?: () => string };
        if(document.querySelector('[data-publication-snapshot-error]'))return {error:'SNAPSHOT_RENDER_UNAVAILABLE'};
        if(!document.querySelector('[data-publication-snapshot-ready="true"]')||!snapshotWindow.__capturePublicationSnapshot)return {pending:true};
        try{return {base64:snapshotWindow.__capturePublicationSnapshot()};}
        catch(error){return {error:error instanceof Error&&/^SNAPSHOT_[A-Z0-9_]{1,60}$/.test(error.message)?error.message:'SNAPSHOT_CANVAS_CAPTURE_FAILED'};}
      });}catch{captured={pending:true};}
      if(captured.error&&!['SNAPSHOT_CANVAS_NOT_READY','SNAPSHOT_CAPTURE_UNAVAILABLE'].includes(captured.error))throw new Error(captured.error);
      if(captured.base64!==undefined){base64=captured.base64;break;}
      if(captured.error)pendingCode=captured.error;
      if(attempt<49)await new Promise<void>(resolve=>setTimeout(resolve,100));
    }
    if(base64===undefined)throw new Error(pendingCode);
    if (typeof base64 !== 'string' || base64.length > Math.ceil(MAX_CAPTURE_PNG_BYTES * 4 / 3)) throw new Error('SNAPSHOT_CAPTURE_TOO_LARGE');
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.byteLength < 100 || bytes.byteLength > MAX_CAPTURE_PNG_BYTES) throw new Error('SNAPSHOT_CAPTURE_INVALID');
    return bytes;
  } catch (error) {
    if(error instanceof Error&&/^[A-Z0-9_]{1,80}$/.test(error.message))throw error;
    // Stage codes are safe to expose; browser messages can contain signed URLs or private text.
    throw new Error(renderStep);
  } finally { await context.close(); }
}

async function createWebp(png: Buffer): Promise<{ bytes: Buffer; checksum: string }> {
  const image = sharp(png, { failOn: 'error', limitInputPixels: SNAPSHOT_WIDTH * SNAPSHOT_HEIGHT, animated: false });
  const meta = await image.metadata();
  if (meta.format !== 'png' || meta.width !== SNAPSHOT_WIDTH || meta.height !== SNAPSHOT_HEIGHT || (meta.pages ?? 1) !== 1) {
    throw new Error('SNAPSHOT_DIMENSIONS_INVALID');
  }
  const bytes = await image.webp({ quality: 88, effort: 5, smartSubsample: true }).toBuffer();
  if (bytes.byteLength < 100 || bytes.byteLength > MAX_SNAPSHOT_WEBP_BYTES) throw new Error('SNAPSHOT_WEBP_SIZE_INVALID');
  return { bytes, checksum: createHash('sha256').update(bytes).digest('hex') };
}

async function storeImmutableSnapshot(storage: StoragePort, prepared: PreparedPublicationSnapshot, bytes: Buffer, checksum: string): Promise<string> {
  const key = `${prepared.publicationVersionId}/processed.webp`;
  const access: MediaAccess = {
    actorUserId: prepared.ownerUserId,
    ownerUserId: prepared.ownerUserId,
    purpose: 'publication_attachment',
    status: 'ready',
    attachedPublicAvatar: false,
    attachedPublicPublication: true,
  };
  try {
    const existing = await storage.readAuthorized(key, access);
    const existingChecksum = createHash('sha256').update(existing).digest('hex');
    if (existingChecksum !== checksum) throw new Error('SNAPSHOT_IMMUTABILITY_CONFLICT');
    return key;
  } catch (error) {
    if (error instanceof Error && error.message === 'SNAPSHOT_IMMUTABILITY_CONFLICT') throw error;
    if (!error || typeof error !== 'object' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try { return await storage.putImmutableProcessed(prepared.publicationVersionId, bytes); }
  catch (error) {
    if (!error || typeof error !== 'object' || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const concurrent = await storage.readAuthorized(key, access);
    if (createHash('sha256').update(concurrent).digest('hex') !== checksum) throw new Error('SNAPSHOT_IMMUTABILITY_CONFLICT');
    return key;
  }
}

async function callApi(apiOrigin: URL, jobId: string, action: 'complete' | 'fail', token: string, body: unknown): Promise<void> {
  const response = await fetch(new URL(`/api/v1/internal/publication-snapshot-jobs/${jobId}/${action}`, apiOrigin), {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-publication-render-token': token },
    body: JSON.stringify(body), cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`SNAPSHOT_API_${action.toUpperCase()}_FAILED`);
}

export async function processPublicationSnapshot(
  pool: Pool,
  storage: StoragePort,
  payload: PublicationSnapshotJob,
  retryCount = 0,
  retryLimit = RETRY_LIMIT,
  options: { renderBaseUrl?: string; apiBaseUrl?: string; secret?: string; launch?: () => Promise<Browser> } = {},
): Promise<void> {
  assertSnapshotJob(payload);
  const renderOrigin = configuredOrigin(options.renderBaseUrl ?? process.env.PUBLICATION_RENDER_BASE_URL, 'web');
  const apiOrigin = configuredOrigin(options.apiBaseUrl ?? process.env.PUBLICATION_API_BASE_URL, 'api');
  const secret = options.secret ?? process.env.PUBLICATION_RENDER_HMAC_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) throw new Error('SNAPSHOT_CONFIGURATION_MISSING');
  const prepared = await preparePublicationSnapshot(pool, payload.jobId);
  if (!prepared) return;
  if ('busyUntil' in prepared) throw new Error('SNAPSHOT_JOB_BUSY');
  const token = signPublicationRenderToken(secret, {
    jobId: prepared.jobId, publicationVersionId: prepared.publicationVersionId,
    nonce: prepared.nonce, expiresAt: prepared.expiresAt,
  });
  let browser: Browser | undefined;
  let completed = false;
  let failureCode = 'SNAPSHOT_PROCESSING_FAILED';
  try {
    failureCode = 'SNAPSHOT_BROWSER_LAUNCH_FAILED';
    browser = await (options.launch ?? (() => chromium.launch({ headless: true })) )();
    failureCode = 'SNAPSHOT_RENDER_FAILED';
    const png = await renderInBrowser(browser, renderOrigin, payload.jobId, token);
    failureCode = 'SNAPSHOT_CONVERSION_FAILED';
    const webp = await createWebp(png);
    failureCode = 'SNAPSHOT_STORAGE_FAILED';
    const objectKey = await storeImmutableSnapshot(storage, prepared, webp.bytes, webp.checksum);
    const artifact: SnapshotArtifact = { objectKey, checksum: webp.checksum, width: SNAPSHOT_WIDTH, height: SNAPSHOT_HEIGHT, mime: 'image/webp' };
    failureCode = 'SNAPSHOT_COMPLETION_FAILED';
    await callApi(apiOrigin, payload.jobId, 'complete', token, artifact);
    completed = true;
  } catch (error) {
    failureCode = error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : failureCode;
    const retryable = retryCount < Math.min(retryLimit, RETRY_LIMIT);
    console.warn(JSON.stringify({event:'publication.snapshot.failed_attempt',code:failureCode,retryable}));
    try {
      await callApi(apiOrigin, payload.jobId, 'fail', token, { failureCode, retryable });
    } catch {
      throw new Error('SNAPSHOT_FAILURE_REPORT_FAILED');
    }
    if (retryable) throw new Error(failureCode);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (!completed) { /* job state and durable artifacts are reconciled through the signed API */ }
  }
}

/** Enqueues pending publication snapshot outbox rows before marking delivery. */
export async function dispatchPublicationSnapshotOutbox(
  pool: Pool,
  send: (queue: string, data: PublicationSnapshotJob, options?: Record<string, unknown>) => Promise<unknown>,
): Promise<number> {
  const client = await pool.connect();
  let delivered = 0;
  try {
    await client.query('BEGIN');
    const events = await client.query(`SELECT e.id,e.aggregate_id FROM outbox_event e
      JOIN publication_job j ON j.id=e.aggregate_id
      WHERE e.event_type='publication.snapshot' AND e.aggregate_type='publication_job' AND e.status='pending'
        AND e.available_at<=now() AND j.status='pending'
      ORDER BY e.created_at LIMIT 20 FOR UPDATE OF e SKIP LOCKED`);
    for (const event of events.rows) {
      try {
        // A stable queue job UUID makes an uncertain outbox retry idempotent. Without singletonSeconds,
        // a null return can only mean this exact outbox event ID already has a durable queue row.
        await send('publication.snapshot', { jobId: String(event.aggregate_id) }, {
          id: String(event.id),
          retryLimit: RETRY_LIMIT, retryDelay: 15, retryBackoff: true, expireInSeconds: 180,
        });
        await client.query("UPDATE outbox_event SET status='delivered',delivered_at=now(),attempts=attempts+1 WHERE id=$1", [event.id]);
        delivered += 1;
      } catch {
        await client.query(`UPDATE outbox_event SET attempts=attempts+1,
          available_at=now()+make_interval(secs=>LEAST(300,5*(2^LEAST(attempts,6))::int))
          WHERE id=$1`, [event.id]);
      }
    }
    await client.query('COMMIT');
    return delivered;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
