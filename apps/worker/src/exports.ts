import { billingEntitlementScope, billingEntitlementPredicate } from '@trading/config';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { FilesystemExportStorage } from '@trading/media';
import { decimal, formatDecimal, formatRatio, stateAtTime } from '@trading/domain';
import { csvLine } from './export-csv.js';
import { processPersonalArchive } from './privacy.js';

export interface ExportJobPayload { jobId: string }
export interface ExportWorkerStorage { put(id: string, bytes: Uint8Array, attempt?: number, format?: 'csv' | 'json'): Promise<string>; delete(key: string): Promise<void> }
export interface ExportRecoveryResult { requeued: number; failed: number }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RETRY_LIMIT = 5;
const STALE_AFTER_MS = 5 * 60_000;
const PAGE_SIZE = 500;
const MAX_EXPORT_BYTES = 50 * 1024 * 1024;

interface JobRow { id: string; owner_user_id: string; kind: string; filters: Record<string, unknown>; status: string; attempts: number; object_key: string | null; expires_at: Date | string | null; claimed_at: Date | string | null }
const RAW_HEADER = ['record_type','journal_entry_id','position_id','publication_id','created_at','updated_at','deleted_at','title','thesis','notes','tags','review','position_state','position_plan','remaining_quantity','initial_risk','calculation_version','leg_id','instrument_id','metadata_version_id','leg_side','leg_quantity','event_id','event_type','claimed_at','received_at','event_quantity','event_price','event_costs','event_reason','event_supersedes_id','event_details','outcome_snapshot_id','source_event_cutoff','publication_version_id','outcome_calculation_version','eligibility','exclusions','outcome_net','r_multiple','cost_coverage','outcome_created_at'];

function append(parts: Buffer[], line: Buffer, total: { bytes: number }): void {
  total.bytes += line.byteLength;
  if (total.bytes > MAX_EXPORT_BYTES) throw new Error('EXPORT_TOO_LARGE');
  parts.push(line);
}
function rawLine(type: string, fields: Record<string, unknown>): Buffer {
  return csvLine(RAW_HEADER.map(name => name === 'record_type' ? type : fields[name] ?? null));
}
function safeFailure(error: unknown): string { return error instanceof Error && error.message === 'EXPORT_TOO_LARGE' ? 'EXPORT_TOO_LARGE' : 'EXPORT_PROCESSING_FAILED'; }
function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left, b = right < 0n ? -right : right;
  while (b) { const next = a % b; a = b; b = next; }
  return a || 1n;
}
function meanExactRatios(values: Array<{ net: string; risk: string }>): string | null {
  if (!values.length) return null;
  let numerator = 0n, denominator = 1n;
  for (const value of values) {
    const n = decimal(value.net), d = decimal(value.risk);
    if (d <= 0n) continue;
    const common = gcd(denominator, d);
    numerator = numerator * (d / common) + n * (denominator / common);
    denominator *= d / common;
    const reduce = gcd(numerator, denominator); numerator /= reduce; denominator /= reduce;
  }
  denominator *= BigInt(values.length);
  return formatRatio(numerator, denominator, 10);
}

export async function processExportJob(pool: Pool, storage: ExportWorkerStorage, payload: ExportJobPayload, retryCount = 0, retryLimit = RETRY_LIMIT, now = new Date()): Promise<void> {
  if (!payload || typeof payload !== 'object' || !UUID.test(String(payload.jobId)) || Object.keys(payload).some(key => key !== 'jobId')) throw new Error('INVALID_EXPORT_JOB');
  const client = await pool.connect();
  let tx = false; let job: JobRow | undefined; let attemptToken = 0; let claimedAt = '';
  try {
    await client.query('BEGIN'); tx = true;
    const result = await client.query<JobRow>(`SELECT id,owner_user_id,kind,filters,status,attempts,object_key,expires_at,claimed_at FROM export_job WHERE id=$1 FOR UPDATE`, [payload.jobId]);
    job = result.rows[0];
    if (!job || ['succeeded','failed','expired'].includes(job.status)) { await client.query('COMMIT'); tx = false; return; }
    if (job.kind === 'personal_archive') {
      await client.query('COMMIT'); tx = false;
      return processPersonalArchive(pool, storage, payload, retryCount, retryLimit, now);
    }
    if (job.status === 'running' && job.claimed_at && new Date(job.claimed_at).getTime() > now.getTime() - STALE_AFTER_MS) { await client.query('COMMIT'); tx = false; return; }
    if (job.kind !== 'personal_raw' && job.kind !== 'journal_analytics') {
      await client.query(`UPDATE export_job SET status='failed',failure_code='EXPORT_KIND_UNAVAILABLE',claimed_at=NULL,updated_at=now() WHERE id=$1`, [job.id]);
      await client.query('COMMIT'); tx = false; return;
    }
    if (Number(job.attempts) >= retryLimit) {
      await client.query(`UPDATE export_job SET status='failed',failure_code='EXPORT_ATTEMPTS_EXHAUSTED',claimed_at=NULL,updated_at=now() WHERE id=$1`, [job.id]);
      await client.query('COMMIT'); tx = false; return;
    }
    const account = await client.query(`SELECT 1 FROM user_account WHERE id=$1 AND status='active' AND email_verified=true`, [job.owner_user_id]);
    if (!account.rowCount) {
      await client.query(`UPDATE export_job SET status='failed',failure_code='ACCOUNT_UNAVAILABLE',claimed_at=NULL,updated_at=now() WHERE id=$1`, [job.id]);
      await client.query('COMMIT'); tx = false; return;
    }
    if (job.kind === 'journal_analytics') {
      const entitlement = await client.query(`SELECT 1 FROM subscription_entitlement WHERE user_id=$1 AND plan='pro' AND valid_from<=now() AND (valid_until IS NULL OR valid_until>now()) AND ${billingEntitlementPredicate('',2)}`, [job.owner_user_id,...billingEntitlementScope(process.env)]);
      if (!entitlement.rowCount) {
        await client.query(`UPDATE export_job SET status='failed',failure_code='PRO_REQUIRED',claimed_at=NULL,updated_at=now() WHERE id=$1`, [job.id]);
        await client.query('COMMIT'); tx = false; return;
      }
    }
    if (job.expires_at && new Date(job.expires_at).getTime() <= now.getTime()) {
      await client.query(`UPDATE export_job SET status='expired',claimed_at=NULL,updated_at=now() WHERE id=$1`, [job.id]);
      await client.query('COMMIT'); tx = false; return;
    }
    attemptToken = Number(job.attempts) + 1; claimedAt = now.toISOString();
    await client.query(`UPDATE export_job SET status='running',attempts=$2,claimed_at=$3,updated_at=now(),failure_code=NULL WHERE id=$1`, [job.id, attemptToken, claimedAt]);
    await client.query('COMMIT'); tx = false;
  } catch (error) {
    if (tx) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { if (tx) await client.query('ROLLBACK').catch(() => undefined); client.release(); }
  if (!job || !attemptToken) return;

  let bytes: Buffer;
  const snapshot = await pool.connect();
  try {
    await snapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    bytes = job.kind === 'personal_raw' ? await buildRawExport(snapshot, job.owner_user_id) : await buildAnalyticsExport(snapshot, job.owner_user_id, job.filters);
    await snapshot.query('COMMIT');
  } catch (error) {
    await snapshot.query('ROLLBACK').catch(() => undefined);
    const status = retryCount < retryLimit ? 'pending' : 'failed';
    const failure = status === 'failed' ? safeFailure(error) : null;
    await pool.query(`UPDATE export_job SET status=$4,claimed_at=NULL,failure_code=$5,updated_at=now() WHERE id=$1 AND status='running' AND attempts=$2 AND claimed_at=$3`, [job.id, attemptToken, claimedAt, status, failure]);
    if (status === 'pending') throw error;
    return;
  } finally { snapshot.release(); }

  const finalize = await pool.connect(); let finalizeTx = false; let objectKey: string | undefined;
  try {
    await finalize.query('BEGIN'); finalizeTx = true;
    const current = await finalize.query(`SELECT status,owner_user_id,attempts,claimed_at FROM export_job WHERE id=$1 FOR UPDATE`, [job.id]);
    const row = current.rows[0];
    if (!row || row.status !== 'running' || Number(row.attempts) !== attemptToken || new Date(row.claimed_at).toISOString() !== claimedAt) {
      await finalize.query('ROLLBACK'); finalizeTx = false; return;
    }
    const account = await finalize.query(`SELECT 1 FROM user_account WHERE id=$1 AND status='active' AND email_verified=true`, [job.owner_user_id]);
    if (!account.rowCount) {
      await finalize.query(`UPDATE export_job SET status='failed',failure_code='ACCOUNT_UNAVAILABLE',claimed_at=NULL,updated_at=now() WHERE id=$1 AND attempts=$2 AND claimed_at=$3`, [job.id, attemptToken, claimedAt]);
      await finalize.query('COMMIT'); finalizeTx = false; return;
    }
    if (job.kind === 'journal_analytics') {
      const entitlement = await finalize.query(`SELECT 1 FROM subscription_entitlement WHERE user_id=$1 AND plan='pro' AND valid_from<=now() AND (valid_until IS NULL OR valid_until>now()) AND ${billingEntitlementPredicate('',2)}`, [job.owner_user_id,...billingEntitlementScope(process.env)]);
      if (!entitlement.rowCount) {
        await finalize.query(`UPDATE export_job SET status='failed',failure_code='PRO_REQUIRED',claimed_at=NULL,updated_at=now() WHERE id=$1 AND attempts=$2 AND claimed_at=$3`, [job.id, attemptToken, claimedAt]);
        await finalize.query('COMMIT'); finalizeTx = false; return;
      }
    }
    objectKey = await storage.put(job.id, bytes, attemptToken);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const expiry = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    const saved = await finalize.query(`UPDATE export_job SET status='succeeded',object_key=$4,expires_at=$5,byte_size=$6,checksum=$7,claimed_at=NULL,failure_code=NULL,updated_at=now()
      WHERE id=$1 AND status='running' AND attempts=$2 AND claimed_at=$3 AND owner_user_id=$8 RETURNING id`, [job.id, attemptToken, claimedAt, objectKey, expiry, bytes.byteLength, checksum, job.owner_user_id]);
    if (!saved.rowCount) {
      await storage.delete(objectKey).catch(() => undefined);
      objectKey = undefined;
    }
    await finalize.query('COMMIT'); finalizeTx = false;
  } catch (error) {
    if (finalizeTx) await finalize.query('ROLLBACK').catch(() => undefined);
    if (objectKey) await storage.delete(objectKey).catch(() => undefined);
    const status = retryCount < retryLimit ? 'pending' : 'failed';
    const failure = status === 'failed' ? 'EXPORT_PROCESSING_FAILED' : null;
    await pool.query(`UPDATE export_job SET status=$4,claimed_at=NULL,failure_code=$5,updated_at=now() WHERE id=$1 AND status='running' AND attempts=$2 AND claimed_at=$3`, [job.id, attemptToken, claimedAt, status, failure]).catch(() => undefined);
    if (status === 'pending') throw error;
  } finally { if (finalizeTx) await finalize.query('ROLLBACK').catch(() => undefined); finalize.release(); }
}

export async function buildRawExport(pool: Pick<PoolClient, 'query'>, ownerId: string): Promise<Buffer> {
  const parts: Buffer[] = []; const total = { bytes: 0 };
  append(parts, csvLine(RAW_HEADER), total);
  let after: { createdAt: string; id: string } | undefined;
  while (true) {
    const page = await pool.query(`SELECT id,publication_id,position_id,notes,tags,review,title,thesis,created_at,updated_at,deleted_at,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_exact,
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_exact,
      to_char(deleted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deleted_exact,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_cursor FROM journal_entry WHERE owner_user_id=$1
      AND ($2::text IS NULL OR created_at>$2::timestamptz OR (created_at=$2::timestamptz AND id>$3::uuid)) ORDER BY created_at,id LIMIT $4`, [ownerId, after?.createdAt ?? null, after?.id ?? null, PAGE_SIZE]);
    for (const row of page.rows) append(parts, rawLine('journal_entry', { journal_entry_id: row.id, position_id: row.position_id, publication_id: row.publication_id,
      created_at: row.created_exact, updated_at: row.updated_exact, deleted_at: row.deleted_exact, title: row.title, thesis: row.thesis,
      notes: row.notes, tags: row.tags, review: row.review }), total);
    if (page.rows.length < PAGE_SIZE) break;
    const last = page.rows[page.rows.length - 1]; after = { createdAt: String(last.created_cursor), id: last.id };
  }
  let afterPosition: string | undefined;
  while (true) {
    const page = await pool.query(`SELECT id,state,plan,instrument_id,metadata_version_id,remaining_quantity,initial_risk::text,calculation_version,private_journal_entry_id,public_publication_id,created_at,updated_at,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_exact,
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_exact
      FROM position WHERE owner_user_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3`, [ownerId, afterPosition ?? null, PAGE_SIZE]);
    for (const p of page.rows) {
      const jid = p.private_journal_entry_id ?? null;
      append(parts, rawLine('position', { journal_entry_id: jid, position_id: p.id, publication_id: p.public_publication_id, created_at: p.created_exact,
        updated_at: p.updated_exact, position_state: p.state, position_plan: p.plan, remaining_quantity: p.remaining_quantity,
        initial_risk: p.initial_risk, calculation_version: p.calculation_version, instrument_id: p.instrument_id,
        metadata_version_id: p.metadata_version_id }), total);
      const legs = await pool.query(`SELECT id,instrument_id,metadata_version_id,side,quantity FROM position_leg WHERE position_id=$1 ORDER BY id`, [p.id]);
      for (const l of legs.rows) append(parts, rawLine('position_leg', { journal_entry_id: jid, position_id: p.id, publication_id: p.public_publication_id,
        leg_id: l.id, instrument_id: l.instrument_id, metadata_version_id: l.metadata_version_id, leg_side: l.side, leg_quantity: l.quantity }), total);
      let eventAfter: { receivedAt: string; id: string } | undefined;
      while (true) {
        const events = await pool.query(`SELECT id,type,claimed_at,received_at,quantity,price::text,costs::text,reason,supersedes_id,details,
          to_char(claimed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS claimed_exact,
          to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS received_exact,
          to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS received_cursor FROM position_event
          WHERE position_id=$1 AND ($2::text IS NULL OR received_at>$2::timestamptz OR (received_at=$2::timestamptz AND id>$3::uuid)) ORDER BY received_at,id LIMIT $4`, [p.id, eventAfter?.receivedAt ?? null, eventAfter?.id ?? null, PAGE_SIZE]);
        for (const e of events.rows) append(parts, rawLine('position_event', { journal_entry_id: jid, position_id: p.id, publication_id: p.public_publication_id,
          event_id: e.id, event_type: e.type, claimed_at: e.claimed_exact, received_at: e.received_exact, event_quantity: e.quantity,
          event_price: e.price, event_costs: e.costs, event_reason: e.reason, event_supersedes_id: e.supersedes_id, event_details: e.details }), total);
        if (events.rows.length < PAGE_SIZE) break;
        const last = events.rows[events.rows.length - 1]; eventAfter = { receivedAt: String(last.received_cursor), id: last.id };
      }
      let snapshotAfter: { createdAt: string; id: string } | undefined;
      while (true) {
        const snapshots = await pool.query(`SELECT id,source_event_cutoff,publication_version_id,calculation_version,eligibility,exclusions,net::text,r_multiple::text,cost_coverage,created_at,
          to_char(source_event_cutoff AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff_exact,
          to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_exact,
          to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_cursor
          FROM outcome_snapshot WHERE position_id=$1 AND ($2::text IS NULL OR created_at>$2::timestamptz OR (created_at=$2::timestamptz AND id>$3::uuid)) ORDER BY created_at,id LIMIT $4`,
        [p.id, snapshotAfter?.createdAt ?? null, snapshotAfter?.id ?? null, PAGE_SIZE]);
        for (const outcome of snapshots.rows) append(parts, rawLine('outcome_snapshot', { position_id: p.id, outcome_snapshot_id: outcome.id,
          source_event_cutoff: outcome.cutoff_exact, publication_version_id: outcome.publication_version_id,
          outcome_calculation_version: outcome.calculation_version, eligibility: outcome.eligibility, exclusions: outcome.exclusions,
          outcome_net: outcome.net, r_multiple: outcome.r_multiple, cost_coverage: outcome.cost_coverage, outcome_created_at: outcome.created_exact }), total);
        if (snapshots.rows.length < PAGE_SIZE) break;
        const last = snapshots.rows[snapshots.rows.length - 1]; snapshotAfter = { createdAt: String(last.created_cursor), id: last.id };
      }
    }
    if (page.rows.length < PAGE_SIZE) break;
    afterPosition = String(page.rows[page.rows.length - 1].id);
  }
  return Buffer.concat(parts, total.bytes);
}

async function buildAnalyticsExport(pool: Pick<PoolClient, 'query'>, ownerId: string, filters: Record<string, unknown>): Promise<Buffer> {
  const from = typeof filters.from === 'string' ? filters.from : null;
  const to = typeof filters.to === 'string' ? filters.to : null;
  const asset = typeof filters.asset === 'string' ? filters.asset : null;
  const strategy = typeof filters.strategy === 'string' ? filters.strategy : null;
  const tags = Array.isArray(filters.tags) ? filters.tags.filter((tag): tag is string => typeof tag === 'string') : null;
  const result = await pool.query(`WITH selected AS (
      SELECT j.id,j.review,j.created_at,j.tags,j.position_id,p.plan,p.id AS posid,p.state,p.initial_risk
      FROM journal_entry j LEFT JOIN position p ON p.id=j.position_id AND p.owner_user_id=j.owner_user_id
      WHERE j.owner_user_id=$1 AND j.deleted_at IS NULL AND ($2::timestamptz IS NULL OR j.created_at >= $2::timestamptz)
        AND ($3::timestamptz IS NULL OR j.created_at < $3::timestamptz)
        AND ($4::text IS NULL OR p.plan->>'asset'=$4) AND ($5::text IS NULL OR p.plan->>'strategy'=$5)
        AND ($6::text[] IS NULL OR j.tags && $6::text[])
    ) SELECT s.id AS journal_id,s.review,s.posid,s.state,s.plan,s.initial_risk::text,o.eligibility,o.cost_coverage,o.net::text AS net,o.r_multiple::text AS r_multiple
      FROM selected s LEFT JOIN LATERAL (SELECT eligibility,cost_coverage,net,r_multiple FROM outcome_snapshot WHERE position_id=s.posid
        ORDER BY source_event_cutoff DESC,created_at DESC LIMIT 1) o ON true`, [ownerId, from, to, asset, strategy, tags]);
  const rows = result.rows;
  const ratios: Array<{ net: string; risk: string }> = [];
  let reviewEligible = 0, reviewed = 0, eligibleOutcomes = 0, incompleteCosts = 0, wins = 0, losses = 0, breakeven = 0;
  let openPositions = 0, closedPositions = 0, reportedPnl = 0n;
  const excluded: Record<string, number> = { educational: 0, unresolved: 0, open: 0, pending: 0, canceled: 0, never_entered: 0, retrospective: 0, ineligible: 0 };
  const asOf=new Date().toISOString();
  for (const row of rows) {
    if(row.posid)row.state=stateAtTime(row.plan,row.state,asOf);
    if (row.posid && ['entered', 'partially_closed'].includes(row.state)) openPositions++;
    if (row.posid && row.state === 'closed') closedPositions++;
    if (row.posid && ['closed', 'unresolved'].includes(row.state)) {
      reviewEligible++;
      const review = typeof row.review === 'string' ? row.review.trim() : '';
      if (review.length > 0) reviewed++;
    }
    if (!row.posid) { excluded.educational = (excluded.educational ?? 0) + 1; continue; }
    if (row.state === 'unresolved') { excluded.unresolved = (excluded.unresolved ?? 0) + 1; continue; }
    if (row.state === 'entered' || row.state === 'partially_closed') { excluded.open = (excluded.open ?? 0) + 1; continue; }
    if (row.state === 'pending') { excluded.pending = (excluded.pending ?? 0) + 1; continue; }
    if (row.state === 'canceled') { excluded.canceled = (excluded.canceled ?? 0) + 1; continue; }
    if (row.state === 'never_entered') { excluded.never_entered = (excluded.never_entered ?? 0) + 1; continue; }
    if (row.eligibility === 'retrospective') { excluded.retrospective = (excluded.retrospective ?? 0) + 1; continue; }
    if (row.eligibility !== 'eligible') { excluded.ineligible = (excluded.ineligible ?? 0) + 1; continue; }
    if (row.state !== 'closed') continue;
    if (row.cost_coverage !== 'complete' || row.net === null) { incompleteCosts++; continue; }
    const net = String(row.net); eligibleOutcomes++;
    const amount = decimal(net);
    reportedPnl += amount;
    if (amount > 0n) wins++; else if (amount < 0n) losses++; else breakeven++;
    if (row.initial_risk !== null && row.r_multiple !== null && decimal(String(row.initial_risk)) > 0n) ratios.push({ net, risk: String(row.initial_risk) });
  }
  const filtersText = JSON.stringify(filters);
  const metrics: unknown[][] = [
    ['plan', 'pro'], ['journal_entries', rows.length], ['open_positions', openPositions], ['closed_positions', closedPositions],
    ['review_eligible', reviewEligible], ['review_completed', reviewed], ['review_completion_rate', reviewEligible ? formatRatio(BigInt(reviewed), BigInt(reviewEligible), 10) : null],
    ['eligible_outcomes', eligibleOutcomes], ['incomplete_costs', incompleteCosts], ['wins', wins], ['losses', losses], ['breakeven', breakeven],
    ['mean_r', meanExactRatios(ratios)], ['r_denominator', ratios.length], ['reported_realized_pnl', eligibleOutcomes ? formatDecimal(reportedPnl) : null],
    ...Object.entries(excluded).map(([key, count]) => [`excluded_${key}`, count]), ['filters', filtersText], ['generated_at', new Date().toISOString()],
  ];
  return Buffer.concat([csvLine(['metric','value']), ...metrics.map(csvLine)]);
}

/** Requeues stale running jobs and pending jobs that lost their outbox event. */
export async function reconcileExportJobs(pool: Pool, { limit }: { limit: number }): Promise<ExportRecoveryResult> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Export recovery limit must be between 1 and 100');
  const client = await pool.connect(); let tx = false;
  try {
    await client.query('BEGIN'); tx = true;
    const rows = await client.query<JobRow>(`SELECT id,owner_user_id,kind,filters,status,attempts,object_key,expires_at,claimed_at FROM export_job j
      WHERE (j.status='running' AND j.claimed_at<=now()-($2::int*interval '1 millisecond'))
        OR (j.status='pending' AND j.updated_at<=now()-interval '2 minutes' AND NOT EXISTS (SELECT 1 FROM outbox_event e WHERE e.event_type='export.generate' AND e.aggregate_type='export_job' AND e.aggregate_id=j.id AND e.status='pending'))
      ORDER BY j.updated_at,j.id LIMIT $1 FOR UPDATE OF j SKIP LOCKED`, [limit, STALE_AFTER_MS]);
    const state: ExportRecoveryResult = { requeued: 0, failed: 0 };
    for (const job of rows.rows) {
      if (Number(job.attempts) >= RETRY_LIMIT) { await client.query(`UPDATE export_job SET status='failed',failure_code='EXPORT_ATTEMPTS_EXHAUSTED',claimed_at=NULL,updated_at=now() WHERE id=$1`, [job.id]); state.failed++; continue; }
      await client.query(`UPDATE export_job SET status='pending',claimed_at=NULL,failure_code=NULL,updated_at=now() WHERE id=$1`, [job.id]);
      const pending = await client.query(`SELECT 1 FROM outbox_event WHERE event_type='export.generate' AND aggregate_type='export_job' AND aggregate_id=$1 AND status='pending' LIMIT 1`, [job.id]);
      if (!pending.rowCount) await client.query(`INSERT INTO outbox_event(id,event_type,aggregate_type,aggregate_id,revision,payload,status,available_at,attempts,created_at)
        VALUES($1,'export.generate','export_job',$2,(SELECT COALESCE(MAX(revision),0)+1 FROM outbox_event WHERE event_type='export.generate' AND aggregate_type='export_job' AND aggregate_id=$2),$3::jsonb,'pending',now(),0,now()) ON CONFLICT(event_type,aggregate_type,aggregate_id,revision) DO NOTHING`, [randomUUID(), job.id, JSON.stringify({ jobId: job.id })]);
      state.requeued++;
    }
    await client.query('COMMIT'); tx = false; return state;
  } catch (error) { if (tx) await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

/** Dispatches export jobs from the transactional outbox with replay-safe queue options. */
export async function dispatchExportOutbox(pool: Pool, send: (queue: string, data: ExportJobPayload, options?: Record<string, unknown>) => Promise<unknown>): Promise<number> {
  const client = await pool.connect(); let tx = false; let count = 0;
  try {
    await client.query('BEGIN'); tx = true;
    const rows = await client.query(`SELECT id,aggregate_id FROM outbox_event WHERE event_type='export.generate' AND aggregate_type='export_job' AND status='pending' AND available_at<=now() ORDER BY created_at LIMIT 25 FOR UPDATE SKIP LOCKED`);
    for (const row of rows.rows) {
      try {
        await send('export.generate', { jobId: row.aggregate_id }, { id: String(row.id), retryLimit: RETRY_LIMIT, retryDelay: 5, retryBackoff: true, expireInSeconds: 86_400 });
        await client.query(`UPDATE outbox_event SET status='delivered',delivered_at=now(),attempts=attempts+1 WHERE id=$1`, [row.id]); count++;
      } catch {
        await client.query(`UPDATE outbox_event SET attempts=attempts+1,status=CASE WHEN attempts+1>=8 THEN 'failed' ELSE status END,
          available_at=CASE WHEN attempts+1>=8 THEN available_at ELSE now()+make_interval(secs=>LEAST(300,5*(2^LEAST(attempts,6))::int)) END WHERE id=$1`, [row.id]);
      }
    }
    await client.query('COMMIT'); tx = false; return count;
  } catch (error) { if (tx) await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

/** Deletes expired CSV objects and marks their jobs expired while preserving owner-visible status. */
export async function purgeExpiredExports(pool: Pool, storage: ExportWorkerStorage, { limit = 50 }: { limit?: number } = {}): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Export cleanup limit must be between 1 and 100');
  const client = await pool.connect(); let tx = false;
  try {
    await client.query('BEGIN'); tx = true;
    const rows = await client.query(`SELECT id,object_key FROM export_job WHERE status='succeeded' AND expires_at<=now() ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit]);
    let purged = 0;
    for (const row of rows.rows) {
      if (row.object_key) {
        try { await storage.delete(String(row.object_key)); } catch { continue; }
      }
      await client.query(`UPDATE export_job SET status='expired',object_key=NULL,claimed_at=NULL,updated_at=now() WHERE id=$1 AND status='succeeded' AND expires_at<=now()`, [row.id]);
      purged++;
    }
    await client.query('COMMIT'); tx = false; return purged;
  } catch (error) { if (tx) await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

export type WorkerExportStorage = Pick<FilesystemExportStorage,'put'|'read'|'delete'>;
