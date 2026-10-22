import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { CommandError } from '../http/problem.js';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Transaction {
  query<R extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}
export interface CommandTransaction extends Transaction { readonly actorUserId: string }
export interface CommandResult<T extends Json = Json> { status: number; body: T; resourceId?: string }
export interface CommandRequest {
  /** Trusted server session identity, never a request-body/header user ID. */
  actorUserId: string;
  operation: string;
  idempotencyKey: string;
  input: Json;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuid(value: string): string {
  if (!UUID.test(value)) throw new CommandError(400, 'INVALID_ID');
  return value;
}

/** Sort object keys; reject values JSON would silently drop or coerce. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 30) throw new CommandError(400, 'INPUT_TOO_DEEP');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) throw new CommandError(400, 'INVALID_JSON_VALUE');
    if (Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).some(present => !present)) throw new CommandError(400, 'INVALID_JSON_VALUE');
    return `[${value.map(item => canonicalJson(item, depth + 1)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'))) throw new CommandError(400, 'INVALID_JSON_VALUE');
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`;
  }
  throw new CommandError(400, 'INVALID_JSON_VALUE');
}

export function requestHash(value: Json): string {
  const serialized = canonicalJson(value);
  if (Buffer.byteLength(serialized) > 512 * 1024) throw new CommandError(400, 'INPUT_TOO_LARGE');
  return createHash('sha256').update(serialized).digest('hex');
}

function persistenceError(error: unknown): unknown {
  if (error instanceof CommandError) return error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === '23505') return new CommandError(409, 'DUPLICATE_RECORD');
  if (code === '40001' || code === '40P01' || code === '55P03') return new CommandError(409, 'RETRY_CONFLICT');
  if (code === '55000') return new CommandError(409, 'IMMUTABLE_RECORD');
  if (code === '23503' || code === '23514' || code === '22003') return new CommandError(422, 'INVALID_RECORD');
  // No database messages, relation names, SQL or connection strings reach clients.
  if (typeof code === 'string' && (code.startsWith('08') || ['57P01', '57P02', '57P03', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(code))) return new CommandError(503, 'PERSISTENCE_UNAVAILABLE');
  return error;
}

/** Database-only unit of work. External effects are persisted to the outbox. */
export async function withTransaction<T>(pool: Pool, work: (tx: Transaction) => Promise<T>): Promise<T> {
  let client: PoolClient;
  try { client = await pool.connect(); } catch { throw new CommandError(503, 'PERSISTENCE_UNAVAILABLE'); }
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    const result = await work({ query: (sql, values) => client.query(sql, values) });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* broken connection is discarded on release below */ }
    throw persistenceError(error);
  } finally { client.release(); }
}

async function actorTransaction(tx: Transaction, actorUserId: string): Promise<CommandTransaction> {
  requireUuid(actorUserId);
  const actor = await tx.query<{ status: string; email_verified: boolean }>(
    'SELECT status,email_verified FROM user_account WHERE id=$1 FOR SHARE', [actorUserId]);
  if (!actor.rows[0]) throw new CommandError(401, 'AUTHENTICATION_REQUIRED');
  if (actor.rows[0].status !== 'active') throw new CommandError(403, 'ACCOUNT_UNAVAILABLE');
  if (!actor.rows[0].email_verified) throw new CommandError(403, 'VERIFIED_EMAIL_REQUIRED');
  return { ...tx, actorUserId };
}

export async function withActorTransaction<T>(pool: Pool, actorUserId: string, work: (tx: CommandTransaction) => Promise<T>): Promise<T> {
  return withTransaction(pool, async tx => work(await actorTransaction(tx, actorUserId)));
}

/** A committed command, quota effects, response and outbox records are atomic. */
export async function executeIdempotentCommand<T extends Json>(pool: Pool, request: CommandRequest,
  execute: (tx: CommandTransaction) => Promise<CommandResult<T>>): Promise<CommandResult<T> & { replayed: boolean }> {
  if (!/^[A-Za-z][A-Za-z0-9_.:/-]{0,199}$/.test(request.operation)
    || request.idempotencyKey.length < 16 || request.idempotencyKey.length > 200) throw new CommandError(400, 'INVALID_COMMAND_KEY');
  const hash = requestHash(request.input);
  return withActorTransaction(pool, request.actorUserId, async tx => {
    // A hash collision only serializes unrelated keys; the unique tuple is authoritative.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [JSON.stringify([request.actorUserId, request.operation, request.idempotencyKey])]);
    const tuple = [request.actorUserId, request.operation, request.idempotencyKey];
    await tx.query('DELETE FROM idempotency_record WHERE actor_key=$1 AND route=$2 AND key=$3 AND expires_at<=CURRENT_TIMESTAMP', tuple);
    const existing = await tx.query<{ request_hash: string; response_status: number; response_body: T; resource_id: string | null }>(
      'SELECT request_hash,response_status,response_body,resource_id FROM idempotency_record WHERE actor_key=$1 AND route=$2 AND key=$3', tuple);
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.request_hash !== hash) throw new CommandError(409, 'IDEMPOTENCY_MISMATCH');
      return { status: row.response_status, body: row.response_body, ...(row.resource_id ? { resourceId: row.resource_id } : {}), replayed: true };
    }
    const response = await execute(tx);
    if (!Number.isInteger(response.status) || response.status < 200 || response.status > 299) throw new CommandError(500, 'INVALID_COMMAND_RESULT');
    const body = canonicalJson(response.body);
    if (Buffer.byteLength(body) > 512 * 1024) throw new CommandError(500, 'COMMAND_RESULT_TOO_LARGE');
    await tx.query(`INSERT INTO idempotency_record
      (id,actor_key,user_id,route,key,request_hash,response_status,response_body,resource_id,expires_at,created_at)
      VALUES ($1,$2::text,$2::uuid,$3,$4,$5,$6,$7::jsonb,$8,CURRENT_TIMESTAMP+interval '24 hours',CURRENT_TIMESTAMP)`,
    [randomUUID(), ...tuple, hash, response.status, body, response.resourceId ?? null]);
    return { ...response, replayed: false };
  });
}

function quotaArgs(metric: string, limit: number, quantity: number) {
  if (!/^[a-z][a-z0-9_]{0,79}$/.test(metric) || !Number.isSafeInteger(limit) || limit < 0
    || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1_000_000) throw new CommandError(400, 'INVALID_QUOTA');
}

async function incrementQuota(tx: CommandTransaction, metric: string, limit: number, quantity: number, reserve: boolean) {
  quotaArgs(metric, limit, quantity);
  if (quantity > limit) throw new CommandError(403, 'QUOTA_EXCEEDED');
  const column = reserve ? 'reserved_count' : 'count'; // fixed identifiers, never request interpolation
  const result = await tx.query(`INSERT INTO quota_bucket(id,user_id,metric,month_start,count,reserved_count,created_at,updated_at)
    VALUES ($1,$2,$3,date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',$4,$5,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    ON CONFLICT(user_id,metric,month_start) DO UPDATE SET ${column}=quota_bucket.${column}+$6,updated_at=CURRENT_TIMESTAMP
    WHERE quota_bucket.count+quota_bucket.reserved_count+$6<=$7 RETURNING id,count,reserved_count,month_start`,
  [randomUUID(), tx.actorUserId, metric, reserve ? 0 : quantity, reserve ? quantity : 0, quantity, limit]);
  if (!result.rows[0]) throw new CommandError(403, 'QUOTA_EXCEEDED');
  return result.rows[0];
}
export const consumeQuota = (tx: CommandTransaction, metric: string, limit: number, quantity = 1) => incrementQuota(tx, metric, limit, quantity, false);
export const reserveQuota = (tx: CommandTransaction, metric: string, limit: number, quantity = 1) => incrementQuota(tx, metric, limit, quantity, true);

/** The reservation's original month is explicit: completion may cross UTC month-end. */
export async function settleQuotaReservation(tx: CommandTransaction, bucketId: string, quantity: number, commit: boolean) {
  requireUuid(bucketId);
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new CommandError(400, 'INVALID_QUOTA');
  const result = await tx.query(`UPDATE quota_bucket SET reserved_count=reserved_count-$3,count=count+$4,updated_at=CURRENT_TIMESTAMP
    WHERE id=$1 AND user_id=$2 AND reserved_count>=$3 RETURNING id`, [bucketId, tx.actorUserId, quantity, commit ? quantity : 0]);
  if (result.rowCount !== 1) throw new CommandError(409, 'RESERVATION_CONFLICT');
}

export function parseIfMatch(value: unknown): number {
  if (typeof value !== 'string' || !/^"[0-9]+"$/.test(value)) throw new CommandError(400, 'INVALID_REVISION');
  const revision = Number(value.slice(1, -1));
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= 2_147_483_647) throw new CommandError(400, 'INVALID_REVISION');
  return revision;
}

export async function lockOwnedDraft(tx: CommandTransaction, id: string) {
  requireUuid(id);
  const result = await tx.query<{ id: string; revision: number; title: string | null; thesis: string | null; plan: Json }>(
    'SELECT id,revision,title,thesis,plan FROM draft WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL FOR UPDATE', [id, tx.actorUserId]);
  if (!result.rows[0]) throw new CommandError(404, 'NOT_FOUND');
  return result.rows[0];
}

export async function reviseOwnedDraft(tx: CommandTransaction, id: string, expectedRevision: number,
  patch: { title?: string; thesis?: string; plan?: Record<string, Json> }) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= 2_147_483_647) throw new CommandError(400, 'INVALID_REVISION');
  if (Object.keys(patch).some(key => !['title', 'thesis', 'plan'].includes(key))
    || (patch.title !== undefined && (typeof patch.title !== 'string' || patch.title.length > 120))
    || (patch.thesis !== undefined && (typeof patch.thesis !== 'string' || patch.thesis.length > 10000))
    || (patch.plan !== undefined && (patch.plan === null || Array.isArray(patch.plan) || typeof patch.plan !== 'object'))) throw new CommandError(400, 'INVALID_DRAFT_PATCH');
  const draft = await lockOwnedDraft(tx, id);
  if (draft.revision !== expectedRevision) throw new CommandError(409, 'STALE_REVISION', 'Reload the current record before saving.');
  const result = await tx.query<{ id: string; revision: number }>(`UPDATE draft
    SET title=COALESCE($4,title),thesis=COALESCE($5,thesis),plan=plan||$6::jsonb,revision=revision+1,updated_at=CURRENT_TIMESTAMP
    WHERE id=$1 AND owner_user_id=$2 AND revision=$3 RETURNING id,revision`,
  [id, tx.actorUserId, expectedRevision, patch.title ?? null, patch.thesis ?? null, canonicalJson(patch.plan ?? {})]);
  if (!result.rows[0]) throw new CommandError(409, 'STALE_REVISION');
  return result.rows[0];
}

export async function appendOutbox(tx: Transaction, event: { eventType: string; aggregateType: string; aggregateId: string; revision: number; payload: Json }) {
  if (!/^[a-z][a-z0-9_.]{0,99}$/.test(event.eventType) || !/^[a-z][a-z0-9_]{0,79}$/.test(event.aggregateType)
    || !Number.isSafeInteger(event.revision) || event.revision < 1) throw new CommandError(400, 'INVALID_OUTBOX_EVENT');
  requireUuid(event.aggregateId);
  const payload = canonicalJson(event.payload);
  if (Buffer.byteLength(payload) > 64 * 1024) throw new CommandError(400, 'OUTBOX_PAYLOAD_TOO_LARGE');
  const result = await tx.query<{ id: string }>(`INSERT INTO outbox_event
    (id,event_type,aggregate_type,aggregate_id,revision,payload,status,available_at,attempts,created_at)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,'pending',CURRENT_TIMESTAMP,0,CURRENT_TIMESTAMP)
    ON CONFLICT(event_type,aggregate_type,aggregate_id,revision) DO NOTHING RETURNING id`,
  [randomUUID(), event.eventType, event.aggregateType, event.aggregateId, event.revision, payload]);
  if (!result.rows[0]) throw new CommandError(409, 'DUPLICATE_DOMAIN_EVENT');
  return result.rows[0].id;
}

export interface OutboxClaim { id: string; attempts: number; event_type: string; aggregate_id: string; payload: Json }
export async function claimOutbox(pool: Pool, limit = 20, eventTypes?: readonly string[]): Promise<OutboxClaim[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CommandError(400, 'INVALID_BATCH_LIMIT');
  if (eventTypes && (eventTypes.length < 1 || eventTypes.length > 100 || eventTypes.some(type => !/^[a-z][a-z0-9_.]{0,99}$/.test(type)))) throw new CommandError(400, 'INVALID_EVENT_FILTER');
  return withTransaction(pool, async tx => {
    await tx.query("UPDATE outbox_event SET status='failed' WHERE status='processing' AND available_at<=CURRENT_TIMESTAMP AND attempts>=8 AND ($1::text[] IS NULL OR event_type=ANY($1::text[]))", [eventTypes ?? null]);
    const result = await tx.query<OutboxClaim>(`WITH candidates AS (
      SELECT id FROM outbox_event WHERE attempts<8 AND available_at<=CURRENT_TIMESTAMP
      AND status IN ('pending','processing') AND ($2::text[] IS NULL OR event_type=ANY($2::text[])) ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $1
    ) UPDATE outbox_event e SET status='processing',attempts=e.attempts+1,available_at=CURRENT_TIMESTAMP+interval '60 seconds'
      FROM candidates c WHERE e.id=c.id RETURNING e.id,e.attempts,e.event_type,e.aggregate_id,e.payload`, [limit, eventTypes ?? null]);
    return result.rows;
  });
}

/** Attempts is a fencing token: an expired worker cannot acknowledge a newer lease. */
export async function finishOutbox(pool: Pool, claim: Pick<OutboxClaim, 'id' | 'attempts'>, succeeded: boolean): Promise<boolean> {
  requireUuid(claim.id);
  if (!Number.isInteger(claim.attempts) || claim.attempts < 1 || claim.attempts > 8) throw new CommandError(400, 'INVALID_OUTBOX_CLAIM');
  return withTransaction(pool, async tx => {
    const result = await tx.query(`UPDATE outbox_event SET
      status=$3,delivered_at=CASE WHEN $3='delivered' THEN CURRENT_TIMESTAMP ELSE NULL END,
      available_at=CURRENT_TIMESTAMP+($4*interval '1 second')
      WHERE id=$1 AND attempts=$2 AND status='processing' RETURNING id`,
    [claim.id, claim.attempts, succeeded ? 'delivered' : claim.attempts >= 8 ? 'failed' : 'pending', Math.min(300, 2 ** claim.attempts)]);
    return result.rowCount === 1;
  });
}
