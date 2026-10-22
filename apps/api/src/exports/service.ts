import { billingEntitlementScope, billingEntitlementPredicate } from '@trading/config';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { CommandError } from '../http/problem.js';
import type { Transaction } from '../persistence/transactions.js';

export type ExportKind = 'personal_raw' | 'journal_analytics' | 'personal_archive';
export interface ExportFilters { from?: string; to?: string; asset?: string; strategy?: string; tags?: readonly string[] }
export interface ExportCommand extends ExportFilters { kind: ExportKind | 'personal_archive' }
export interface PrivateExportStorage { put(id: string, bytes: Uint8Array, attempt?: number, format?: 'csv' | 'json'): Promise<string>; read(key: string): Promise<Buffer>; delete(key: string): Promise<void> }
export interface PlanSnapshot { plan: string }
export type ResolvePlan = (tx: Transaction, userId: string, now?: Date) => Promise<PlanSnapshot>;
export interface ExportJobDto {
  id: string;
  kind: ExportKind;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'expired';
  downloadUrl: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  byteSize: number | null;
  failureCode: string | null;
}
export interface ExportPage { items: ExportJobDto[]; nextCursor: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_ASSETS = new Set(['stock', 'option', 'future']);
const VALID_STRATEGIES = new Set(['long', 'short', 'long_call', 'long_put', 'bull_call_debit', 'bear_put_debit', 'bull_put_credit', 'bear_call_credit']);
const MAX_PAGE = 50;
const MAX_FILTER_AGE_MS = 366 * 24 * 60 * 60 * 1000;

interface ExportRow {
  id: string; owner_user_id: string; kind: string; filters: Record<string, unknown>; status: string;
  object_key: string | null; expires_at: Date | string | null; created_at: Date | string; created_at_exact?: string; updated_at: Date | string;
  byte_size: number | string | null; failure_code: string | null;
}
function iso(value: Date | string): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function sha256(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function parseId(id: string): void { if (!UUID.test(id)) throw new CommandError(400, 'INVALID_ID', 'Export ID is invalid.'); }
function date(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new CommandError(422, 'EXPORT_FILTER_INVALID', `${name} must be an ISO date-time.`);
  const parsed = new Date(value);
  if (parsed.toISOString().slice(0, 10) !== value.slice(0, 10)) throw new CommandError(422, 'EXPORT_FILTER_INVALID', `${name} must be UTC in ISO format.`);
  return parsed.toISOString();
}
export function normalizeExportCommand(input: ExportCommand): { kind: ExportKind; filters: ExportFilters } {
  if (input.kind !== 'personal_raw' && input.kind !== 'journal_analytics' && input.kind !== 'personal_archive') throw new CommandError(422, 'EXPORT_KIND_INVALID', 'Choose a supported export kind.');
  const from = date(input.from, 'from'), to = date(input.to, 'to');
  if (from && to && Date.parse(from) > Date.parse(to)) throw new CommandError(422, 'EXPORT_FILTER_INVALID', 'from must be earlier than or equal to to.');
  if (from && to && Date.parse(to) - Date.parse(from) > MAX_FILTER_AGE_MS) throw new CommandError(422, 'EXPORT_FILTER_INVALID', 'Export ranges are limited to 366 days.');
  if (input.asset !== undefined && !VALID_ASSETS.has(input.asset)) throw new CommandError(422, 'EXPORT_FILTER_INVALID', 'The asset filter is invalid.');
  if (input.strategy !== undefined && !VALID_STRATEGIES.has(input.strategy)) throw new CommandError(422, 'EXPORT_FILTER_INVALID', 'The strategy filter is invalid.');
  const tags = input.tags === undefined ? undefined : [...new Set(input.tags.map(tag => tag.trim()).filter(Boolean))].sort();
  if (tags && (!tags.length || tags.some(tag => tag.length > 40) || tags.length > 20)) throw new CommandError(422, 'EXPORT_FILTER_INVALID', 'Choose between 1 and 20 tags of at most 40 characters.');
  const filters: ExportFilters = { ...(from ? { from } : {}), ...(to ? { to } : {}), ...(input.asset ? { asset: input.asset } : {}), ...(input.strategy ? { strategy: input.strategy } : {}), ...(tags ? { tags } : {}) };
  if ((input.kind === 'personal_raw' || input.kind === 'personal_archive') && Object.keys(filters).length) throw new CommandError(422, 'EXPORT_FILTERS_UNSUPPORTED', 'Personal exports include all eligible personal records.');
  return { kind: input.kind, filters };
}

function cursorDecode(cursor: string | undefined, ownerId: string): { createdAt: string; id: string } | undefined {
  if (!cursor) return undefined;
  if (cursor.length > 500) throw new CommandError(400, 'INVALID_CURSOR', 'Export cursor is invalid.');
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: number; ownerId?: string; createdAt?: string; id?: string };
    if (value.v !== 1 || value.ownerId !== ownerId || typeof value.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt)) || !value.id || !UUID.test(value.id)) throw new Error();
    return { createdAt: value.createdAt, id: value.id };
  } catch { throw new CommandError(400, 'INVALID_CURSOR', 'Export cursor is invalid.'); }
}
function cursorEncode(ownerId: string, row: Pick<ExportRow, 'created_at_exact' | 'id'>): string { return Buffer.from(JSON.stringify({ v: 1, ownerId, createdAt: row.created_at_exact, id: row.id })).toString('base64url'); }

export class ExportService {
  constructor(private readonly pool: Pool, private readonly storage: PrivateExportStorage, private readonly resolvePlan?: ResolvePlan) {}

  private async requirePro(tx: Transaction, userId: string): Promise<void> {
    const entitlement = this.resolvePlan
      ? await this.resolvePlan(tx, userId)
      : await this.fallbackPlan(tx, userId);
    if (entitlement.plan !== 'pro') throw new CommandError(403, 'PRO_REQUIRED', 'Journal analytics exports require an active Pro entitlement.');
  }
  private async hasPro(userId: string): Promise<boolean> {
    const entitlement = this.resolvePlan ? await this.resolvePlan(this.pool, userId) : await this.fallbackPlan(this.pool, userId);
    return entitlement.plan === 'pro';
  }
  private async fallbackPlan(tx: Transaction, userId: string): Promise<PlanSnapshot> {
    const result = await tx.query<{ plan: string }>(`SELECT plan FROM subscription_entitlement WHERE user_id=$1 AND valid_from<=now() AND (valid_until IS NULL OR valid_until>now()) AND ${billingEntitlementPredicate('',2)}`, [userId,...billingEntitlementScope(process.env)]);
    return { plan: result.rows[0]?.plan === 'pro' ? 'pro' : 'free' };
  }

  async request(ownerId: string, key: string, input: ExportCommand): Promise<ExportJobDto> {
    if (!/^[\x21-\x7e]{16,200}$/.test(key)) throw new CommandError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'A valid idempotency key is required.');
    const { kind, filters } = normalizeExportCommand(input);
    const route = '/exports'; const requestHash = sha256({ kind, filters }); const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`export:${ownerId}:${key}`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`private-workspace:${ownerId}`]);
      const account = await client.query(`SELECT 1 FROM user_account WHERE id=$1 AND status='active' AND email_verified=true`, [ownerId]);
      if (!account.rowCount) throw new CommandError(403, 'ACCOUNT_UNAVAILABLE', 'An active verified account is required for exports.');
      if (kind === 'journal_analytics') await this.requirePro({ query: client.query.bind(client) } as Transaction, ownerId);
      const prior = await client.query<{ request_hash: string; response_body: { id?: string } }>(`SELECT request_hash,response_body FROM idempotency_record WHERE actor_key=$1 AND route=$2 AND key=$3 AND expires_at>now()`, [ownerId, route, key]);
      if (prior.rowCount) {
        const priorRow = prior.rows[0];
        if (!priorRow || priorRow.request_hash !== requestHash) throw new CommandError(409, 'IDEMPOTENCY_CONFLICT', 'This retry key belongs to different export details.');
        const existing = await client.query<ExportRow>(`SELECT * FROM export_job WHERE id=$1 AND owner_user_id=$2`, [priorRow.response_body.id, ownerId]);
        if (!existing.rowCount) throw new CommandError(409, 'EXPORT_RETRY_UNAVAILABLE', 'This export request can no longer be retried.');
        const existingRow = existing.rows[0]; if (!existingRow) throw new CommandError(409, 'EXPORT_RETRY_UNAVAILABLE', 'This export request can no longer be retried.');
        await client.query('COMMIT');
        return this.dto(existingRow);
      }
      await client.query(`DELETE FROM idempotency_record WHERE actor_key=$1 AND route=$2 AND key=$3 AND expires_at<=now()`, [ownerId, route, key]);
      const active = await client.query(`SELECT count(*)::int AS count FROM export_job WHERE owner_user_id=$1 AND status IN ('pending','running')`, [ownerId]);
      if (Number(active.rows[0]?.count ?? 0) >= 3) throw new CommandError(429, 'EXPORT_QUEUE_LIMIT', 'You already have three exports in progress.');
      const id = randomUUID();
      const row = await client.query<ExportRow>(`INSERT INTO export_job(id,owner_user_id,kind,filters,status,created_at,updated_at,attempts)
        VALUES($1,$2,$3,$4::jsonb,'pending',now(),now(),0) RETURNING *`, [id, ownerId, kind, JSON.stringify(filters)]);
      const inserted = row.rows[0]; if (!inserted) throw new Error('Export insert returned no row');
      await client.query(`INSERT INTO outbox_event(id,event_type,aggregate_type,aggregate_id,revision,payload,status,available_at,attempts,created_at)
        VALUES($1,'export.generate','export_job',$2,1,$3::jsonb,'pending',now(),0,now()) ON CONFLICT(event_type,aggregate_type,aggregate_id,revision) DO NOTHING`, [randomUUID(), id, JSON.stringify({ jobId: id })]);
      const response = this.dto(inserted);
      await client.query(`INSERT INTO idempotency_record(id,actor_key,route,key,request_hash,response_status,response_body,resource_id,expires_at)
        VALUES($1,$2,$3,$4,$5,202,$6::jsonb,$7,now()+interval '24 hours')`, [randomUUID(), ownerId, route, key, requestHash, JSON.stringify(response), id]);
      await client.query('COMMIT'); return response;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); if (error instanceof CommandError) throw error; throw new CommandError(503, 'EXPORT_UNAVAILABLE', 'Export could not be queued. Retry with the same idempotency key.'); }
    finally { client.release(); }
  }

  async list(ownerId: string, cursor?: string, requestedLimit?: number): Promise<ExportPage> {
    const limit = requestedLimit === undefined ? 20 : Number(requestedLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new CommandError(400, 'INVALID_LIMIT', 'Export page size must be between 1 and 50.');
    const after = cursorDecode(cursor, ownerId);
    const result = await this.pool.query<ExportRow>(`SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_exact FROM export_job WHERE owner_user_id=$1
      AND ($2::timestamptz IS NULL OR created_at<$2::timestamptz OR (created_at=$2::timestamptz AND id<$3::uuid))
      ORDER BY created_at DESC,id DESC LIMIT $4`, [ownerId, after?.createdAt ?? null, after?.id ?? null, limit + 1]);
    const hasMore = result.rows.length > limit; const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    const canDownloadAnalytics = !rows.some(row => row.kind === 'journal_analytics') || await this.hasPro(ownerId);
    return { items: rows.map(row => this.dto(row, canDownloadAnalytics)), nextCursor: hasMore && last ? cursorEncode(ownerId, last) : null };
  }

  async get(ownerId: string, id: string): Promise<ExportJobDto> {
    parseId(id); const result = await this.pool.query<ExportRow>(`SELECT * FROM export_job WHERE id=$1 AND owner_user_id=$2`, [id, ownerId]);
    const row = result.rows[0];
    if (!row) throw new CommandError(404, 'EXPORT_NOT_FOUND', 'Export is unavailable.');
    return this.dto(row, row.kind !== 'journal_analytics' || await this.hasPro(ownerId));
  }

  async download(ownerId: string, id: string): Promise<{ bytes: Buffer; filename: string; kind: ExportKind }> {
    parseId(id);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<ExportRow>(`SELECT * FROM export_job WHERE id=$1 AND owner_user_id=$2 FOR UPDATE`, [id, ownerId]);
      const row = result.rows[0];
      if (!row) throw new CommandError(404, 'EXPORT_NOT_FOUND', 'Export is unavailable.');
      if (row.kind === 'journal_analytics') await this.requirePro({ query: client.query.bind(client) } as Transaction, ownerId);
      if (row.status !== 'succeeded' || !row.object_key || !row.expires_at || new Date(row.expires_at).getTime() <= Date.now()) throw new CommandError(404, 'EXPORT_NOT_FOUND', 'Export is unavailable or expired.');
      const bytes = await this.storage.read(row.object_key);
      await client.query('COMMIT');
      return { bytes, filename: row.kind === 'personal_archive' ? `personal-archive-${id}.json` : `journal-export-${id}.csv`, kind: row.kind as ExportKind };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); if (error instanceof CommandError) throw error; throw new CommandError(404, 'EXPORT_NOT_FOUND', 'Export is unavailable.'); }
    finally { client.release(); }
  }

  private dto(row: ExportRow, canDownloadAnalytics = true): ExportJobDto {
    const expired = row.expires_at !== null && new Date(row.expires_at).getTime() <= Date.now();
    const status = expired && row.status === 'succeeded' ? 'expired' : row.status as ExportJobDto['status'];
    const available = row.status === 'succeeded' && !expired && (row.kind !== 'journal_analytics' || canDownloadAnalytics);
    return { id: row.id, kind: row.kind as ExportKind, status, downloadUrl: available ? `/api/v1/exports/${row.id}/download` : null,
      expiresAt: row.expires_at ? iso(row.expires_at) : null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
      byteSize: row.byte_size === null ? null : Number(row.byte_size), failureCode: row.failure_code };
  }
}
