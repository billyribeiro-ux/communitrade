import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { MarketDataPort } from '@trading/domain';
import { CommandError } from '../http/problem.js';
import { parseIfMatch, requestHash } from '../persistence/transactions.js';

type JsonObject = Record<string, any>;
type CapabilityProvider = Pick<MarketDataPort, 'getCapabilities'>;
type DraftRow = { [key: string]: any; id: string; kind: string; title: string | null; thesis: string | null; plan: JsonObject; attachment_ids?: string[]; revision: number; chart_revision: number; updated_at: Date; deleted_at: Date | null; publication_status?: string | null; publication_job_id?: string | null; publication_id?: string | null };
type ChartState = JsonObject & { instrumentId: string; metadataVersion: number; interval: string; timezone: string; session: string; adjustment: string; viewport: { from: string; to: string }; provenance: { provider: string; asOf: string; delaySeconds: number; demo: boolean }; drawings: JsonObject[] };

const MAX_REVISION = 2_147_483_646;
const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const obj = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const decimal = /^-?[0-9]{1,18}(?:\.[0-9]{1,10})?$/;

function nextRevision(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= MAX_REVISION) throw new CommandError(409, 'REVISION_EXHAUSTED', 'This draft can no longer be changed.');
  return value + 1;
}

function project(row: DraftRow) {
  const plan = { ...obj(row.plan) };
  // Lock/publication bookkeeping is represented by the explicit draft status
  // fields below, never by undocumented keys inside canonical TradePlan.
  delete plan.locked;
  delete plan.published;
  const rawStatus = row.publication_status;
  const publicationStatus = rawStatus === 'pending' || rawStatus === 'running' ? 'processing'
    : rawStatus === 'succeeded' ? 'published' : rawStatus === 'failed' ? 'failed' : 'draft';
  return {
    id: row.id,
    kind: row.kind,
    revision: Number(row.revision),
    chartRevision: Number(row.chart_revision),
    title: row.title ?? '',
    thesis: row.thesis ?? '',
    plan,
    attachmentIds: Array.isArray(row.attachment_ids) ? row.attachment_ids : [],
    publicationStatus,
    publicationJobId: row.publication_job_id ?? null,
    publicationId: rawStatus === 'succeeded' ? row.publication_id ?? null : null,
    updatedAt: iso(row.updated_at),
  };
}

function parseCursor(input: unknown): { updatedAt: string; id: string } | undefined {
  if (input === undefined || input === '') return undefined;
  if (typeof input !== 'string' || input.length > 500) throw new CommandError(400, 'INVALID_CURSOR', 'The draft cursor is invalid.');
  try {
    const decoded = JSON.parse(Buffer.from(input, 'base64url').toString('utf8')) as { v?: unknown; updatedAt?: unknown; id?: unknown };
    if (decoded.v !== 1 || typeof decoded.updatedAt !== 'string' || !Number.isFinite(Date.parse(decoded.updatedAt)) || new Date(decoded.updatedAt).toISOString() !== decoded.updatedAt || typeof decoded.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(decoded.id)) throw new Error();
    return { updatedAt: decoded.updatedAt, id: decoded.id };
  } catch { throw new CommandError(400, 'INVALID_CURSOR', 'The draft cursor is invalid.'); }
}

function cursorFor(row: DraftRow) {
  return Buffer.from(JSON.stringify({ v: 1, updatedAt: iso(row.updated_at), id: row.id })).toString('base64url');
}

function validTimezone(timezone: string) {
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); return true; } catch { return false; }
}

export function validateChartSemantics(state: ChartState) {
  if (!validTimezone(state.timezone)) throw new CommandError(422, 'INVALID_CHART_TIMEZONE', 'Choose a valid IANA time zone.');
  const from = Date.parse(state.viewport.from), to = Date.parse(state.viewport.to), asOf = Date.parse(state.provenance.asOf);
  if (!(Number.isFinite(from) && Number.isFinite(to) && from < to)) throw new CommandError(422, 'INVALID_CHART_VIEWPORT', 'The chart viewport must have an increasing time range.');
  if (!Number.isFinite(asOf) || asOf > Date.now() + 60_000) throw new CommandError(422, 'INVALID_CHART_PROVENANCE', 'The chart source timestamp is invalid.');
  const ids = new Set<string>();
  const periods = new Set<number>();
  for (const indicator of state.indicators) {
    if (periods.has(indicator.period)) throw new CommandError(422, 'DUPLICATE_INDICATOR_PERIOD', 'Each moving average period can appear only once.');
    periods.add(indicator.period);
  }
  const planFields = new Set<string>();
  for (const drawing of state.drawings) {
    if (ids.has(drawing.id)) throw new CommandError(422, 'DUPLICATE_DRAWING_ID', 'Drawing identifiers must be unique.');
    ids.add(drawing.id);
    if (drawing.planField) {
      if (planFields.has(drawing.planField)) throw new CommandError(422, 'DUPLICATE_PLAN_OVERLAY', 'Each linked plan level can appear only once.');
      planFields.add(drawing.planField);
    }
    for (const anchor of drawing.anchors ?? []) if (!decimal.test(String(anchor.price))) throw new CommandError(422, 'INVALID_CHART_PRICE', 'Drawing prices must be decimal strings.');
  }
}

function linkedLevels(drawings: JsonObject[]) {
  const levels: JsonObject = {};
  const targets: string[] = [];
  for (const drawing of drawings) {
    const field = drawing.planField;
    if (typeof field !== 'string') continue;
    const price = String(drawing.anchors[0].price);
    if (field === 'entryUnderlying') levels.entry = price;
    else if (field === 'invalidationUnderlying') levels.invalidation = price;
    else if (/^targetUnderlying[123]$/.test(field)) targets[Number(field.at(-1)) - 1] = price;
  }
  if (targets.some(value => value !== undefined)) {
    // Array.prototype.some skips sparse holes, so materialize each index before
    // deciding whether targets were supplied contiguously (1, 2, 3).
    if (Array.from(targets).some(value => value === undefined)) throw new CommandError(422, 'PLAN_TARGET_GAP', 'Linked targets must be numbered in order.');
    levels.targets = targets;
  }
  return levels;
}

function overlayFromLevel(field: string, price: string, from: string, index: number): JsonObject {
  const type = field === 'entryUnderlying' ? 'entry' : field === 'invalidationUnderlying' ? 'invalidation' : 'target';
  const color = type === 'entry' ? '#16865d' : type === 'invalidation' ? '#cf3c47' : '#4678d4';
  return { id: randomUUID(), type, anchors: [{ time: from, price }], style: { color, lineWidth: 1, lineStyle: 'dashed', fillOpacity: 0 }, planField: field, ...(type === 'target' ? { text: `Target ${index + 1}` } : {}) };
}

function reconcileOverlays(state: ChartState, levels: JsonObject): ChartState {
  const next = state.drawings.filter(drawing => typeof drawing.planField !== 'string');
  if (typeof levels.entry === 'string') next.push(overlayFromLevel('entryUnderlying', levels.entry, state.viewport.from, 0));
  if (typeof levels.invalidation === 'string') next.push(overlayFromLevel('invalidationUnderlying', levels.invalidation, state.viewport.from, 0));
  if (Array.isArray(levels.targets)) levels.targets.forEach((value: unknown, index: number) => {
    if (typeof value === 'string') next.push(overlayFromLevel(`targetUnderlying${index + 1}`, value, state.viewport.from, index));
  });
  if (next.length > 50) throw new CommandError(422, 'CHART_OBJECT_LIMIT', 'A chart can contain no more than 50 drawings.');
  return { ...state, drawings: next };
}

async function lockDraft(client: PoolClient, ownerId: string, id: string): Promise<DraftRow> {
  const result = await client.query<DraftRow>('SELECT id,kind,title,thesis,plan,attachment_ids,revision,chart_revision,updated_at,deleted_at FROM draft WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL FOR UPDATE', [id, ownerId]);
  if (!result.rows[0]) throw new CommandError(404, 'DRAFT_NOT_FOUND', 'Draft is unavailable.');
  return result.rows[0];
}

async function selectEditableReference(client: PoolClient, draft: DraftRow, state: ChartState, forWrite: boolean, provider: CapabilityProvider) {
    const result = await client.query(`SELECT i.id,i.asset,i.vendor,i.vendor_id,i.enabled,m.version,m.session,
      COALESCE((SELECT pm.dataset FROM provider_instrument_mapping pm WHERE pm.instrument_id=i.id AND pm.metadata_version=m.version AND pm.supplier=i.vendor AND pm.effective_at<=now() AND (pm.revoked_at IS NULL OR pm.revoked_at>now()) ORDER BY pm.effective_at DESC LIMIT 1),i.asset) AS dataset
    FROM instrument i JOIN instrument_metadata_version m ON m.instrument_id=i.id AND m.version=$2
      AND m.version=(SELECT MAX(mx.version) FROM instrument_metadata_version mx WHERE mx.instrument_id=i.id)
    WHERE i.id=$1 FOR SHARE OF i,m`, [state.instrumentId, state.metadataVersion]);
  const ref = result.rows[0];
  if (!ref) throw new CommandError(422, 'CHART_REFERENCE_UNAVAILABLE', 'The selected instrument metadata is unavailable.');
  if (forWrite && !ref.enabled) throw new CommandError(409, 'CHART_REFERENCE_DISABLED', 'This chart source is no longer available for new edits.');
  if (state.provenance.provider !== ref.vendor || state.provenance.demo !== /synthetic|fixture/i.test(ref.vendor)) throw new CommandError(422, 'CHART_PROVENANCE_MISMATCH', 'Chart provenance does not match the selected instrument source.');
  if (state.adjustment !== 'unadjusted' || state.session !== (ref.asset === 'future' ? 'exchange' : 'regular') || ref.asset === 'option') throw new CommandError(422, 'CHART_SERIES_MISMATCH', 'The chart session or adjustment does not match a supported underlying series.');
  const plan = obj(draft.plan);
  const planAsset = plan.asset;
  if (plan.instrumentId && plan.instrumentId !== state.instrumentId) throw new CommandError(409, 'CHART_INSTRUMENT_MISMATCH', 'The chart and draft must use the same underlying instrument.');
  if (planAsset === 'future' && ref.asset !== 'future' || (planAsset === 'stock' || planAsset === 'option') && ref.asset !== 'stock') throw new CommandError(422, 'CHART_ASSET_MISMATCH', 'Select the chart series that matches the draft asset.');
  if (forWrite) {
    const cap = await client.query(`SELECT purpose,flags FROM data_capability WHERE supplier=$1 AND dataset=$2 AND audience='member' AND purpose IN ('display','chart') AND effective_at<=now() AND (revoked_at IS NULL OR revoked_at>now()) ORDER BY purpose,effective_at DESC FOR SHARE`, [ref.vendor, ref.dataset]);
    const displayCaps = cap.rows.filter(row => row.purpose === 'display').map(row => obj(row.flags));
    const chartCaps = cap.rows.filter(row => row.purpose === 'chart').map(row => obj(row.flags));
    const databaseAllowsDisplay = displayCaps.length > 0 && displayCaps.every(flags => flags.displayMember === true);
    const databaseAllowsRetention = chartCaps.length > 0 && chartCaps.every(flags => flags.retainBars === true);
    if (!databaseAllowsDisplay || !databaseAllowsRetention) throw new CommandError(403, 'DATA_BARS_NOT_LICENSED', 'Chart edits require current member display and bar retention rights.');
    let providerAllowsChart = false;
    try {
      const [providerDisplay, providerChart] = await Promise.all([
        provider.getCapabilities(state.instrumentId, 'member', 'display'),
        provider.getCapabilities(state.instrumentId, 'member', 'chart'),
      ]);
      providerAllowsChart = providerDisplay.data.displayMember === true && providerChart.data.retainBars === true;
    } catch {
      throw new CommandError(503, 'MARKET_DATA_UNAVAILABLE', 'Market data permissions are temporarily unavailable.');
    }
    if (!providerAllowsChart) throw new CommandError(403, 'DATA_BARS_NOT_LICENSED', 'Chart edits require current member display and bar retention rights.');
  }
  return ref;
}

async function withTx<T>(pool: Pool, ownerId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient;
  try { client = await pool.connect(); } catch { throw new CommandError(503, 'PERSISTENCE_UNAVAILABLE'); }
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    const actor = await client.query('SELECT status,email_verified,onboarding_version FROM user_account WHERE id=$1 FOR SHARE', [ownerId]);
    if (!actor.rows[0]) throw new CommandError(401, 'AUTHENTICATION_REQUIRED');
    if (actor.rows[0].status !== 'active') throw new CommandError(403, 'ACCOUNT_UNAVAILABLE');
    if (!actor.rows[0].email_verified) throw new CommandError(403, 'EMAIL_VERIFICATION_REQUIRED');
    if (!actor.rows[0].onboarding_version) throw new CommandError(403, 'ONBOARDING_REQUIRED');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof CommandError) throw error;
    const code = (error as { code?: string })?.code;
    if (code === '23514' || code === '23503' || code === '22003') throw new CommandError(422, 'INVALID_DRAFT');
    if (code === '55P03' || code === '40P01' || code === '40001') throw new CommandError(409, 'RETRY_CONFLICT');
    if (code?.startsWith('08') || ['57P01','57P02','57P03','ECONNREFUSED','ECONNRESET','ETIMEDOUT'].includes(code ?? '')) throw new CommandError(503, 'PERSISTENCE_UNAVAILABLE');
    throw new CommandError(503, 'DRAFT_UNAVAILABLE', 'The draft could not be saved. Retry.');
  } finally { client.release(); }
}

export class DraftService {
  constructor(private readonly pool: Pool, private readonly provider: CapabilityProvider) {}

  async create(ownerId: string, key: string, input: { kind: string; asset?: string }) {
    return withTx(this.pool, ownerId, async client => {
      const route = 'POST /drafts';
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${ownerId}:${route}:${key}`]);
      const hash = requestHash(input as any);
      const previous = await client.query('SELECT request_hash,response_body FROM idempotency_record WHERE actor_key=$1 AND route=$2 AND key=$3 AND expires_at>now()', [ownerId, route, key]);
      if (previous.rows[0]) {
        if (previous.rows[0].request_hash !== hash) throw new CommandError(409, 'IDEMPOTENCY_MISMATCH', 'This key was already used for different draft details.');
        return previous.rows[0].response_body;
      }
      await client.query('DELETE FROM idempotency_record WHERE actor_key=$1 AND route=$2 AND key=$3 AND expires_at<=now()', [ownerId, route, key]);
      const id = randomUUID();
      const plan = input.asset ? { asset: input.asset } : {};
      const result = await client.query<DraftRow>(`INSERT INTO draft(id,owner_user_id,kind,plan,revision,chart_revision,created_at,updated_at)
        VALUES($1,$2,$3,$4::jsonb,1,0,now(),now()) RETURNING id,kind,title,thesis,plan,revision,chart_revision,updated_at,deleted_at`, [id, ownerId, input.kind, JSON.stringify(plan)]);
      const inserted = result.rows[0];
      if (!inserted) throw new CommandError(503, 'DRAFT_UNAVAILABLE', 'The draft could not be created. Retry.');
      const body = project(inserted);
      await client.query(`INSERT INTO idempotency_record(id,actor_key,user_id,route,key,request_hash,response_status,response_body,resource_id,expires_at,created_at)
        VALUES($1,$2,$3::uuid,$4,$5,$6,201,$7::jsonb,$8,now()+interval '24 hours',now())`, [randomUUID(), ownerId, ownerId, route, key, hash, JSON.stringify(body), id]);
      await rateLimitDraftWrite(client, ownerId, '/drafts');
      return body;
    });
  }

  async list(ownerId: string, cursorInput: unknown, limitInput: unknown) {
    const cursor = parseCursor(cursorInput);
    const limit = Number(limitInput ?? 20);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new CommandError(400, 'INVALID_LIMIT', 'Draft limit must be between 1 and 50.');
    const result = await this.pool.query<DraftRow>(`SELECT d.id,d.kind,d.title,d.thesis,d.plan,d.attachment_ids,d.revision,d.chart_revision,d.updated_at,d.deleted_at,
        job.id AS publication_job_id,job.status AS publication_status,job.publication_id
      FROM draft d LEFT JOIN LATERAL (SELECT id,status,publication_id FROM publication_job WHERE draft_id=d.id ORDER BY created_at DESC,id DESC LIMIT 1) job ON true
      WHERE d.owner_user_id=$1 AND d.deleted_at IS NULL AND ($2::timestamptz IS NULL OR (d.updated_at,d.id)<($2,$3::uuid))
      ORDER BY d.updated_at DESC,d.id DESC LIMIT $4`, [ownerId, cursor?.updatedAt ?? null, cursor?.id ?? null, limit + 1]);
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    return { items: rows.map(project), nextCursor: hasMore ? cursorFor(rows.at(-1)!) : null };
  }

  async get(ownerId: string, id: string) {
    const result = await this.pool.query<DraftRow>(`SELECT d.id,d.kind,d.title,d.thesis,d.plan,d.attachment_ids,d.revision,d.chart_revision,d.updated_at,d.deleted_at,
      job.id AS publication_job_id,job.status AS publication_status,job.publication_id
      FROM draft d LEFT JOIN LATERAL (SELECT id,status,publication_id FROM publication_job WHERE draft_id=d.id ORDER BY created_at DESC,id DESC LIMIT 1) job ON true
      WHERE d.id=$1 AND d.owner_user_id=$2 AND d.deleted_at IS NULL`, [id, ownerId]);
    if (!result.rows[0]) throw new CommandError(404, 'DRAFT_NOT_FOUND', 'Draft is unavailable.');
    return project(result.rows[0]);
  }

  async patch(ownerId: string, id: string, expectedRevision: number, input: JsonObject) {
    return withTx(this.pool, ownerId, async client => {
      const draft = await lockDraft(client, ownerId, id);
      if (Number(draft.revision) !== expectedRevision) throw new CommandError(409, 'REVISION_CONFLICT', 'Draft changed. Reload before saving.');
      if (obj(draft.plan).published === true || obj(draft.plan).locked === true) throw new CommandError(409, 'DRAFT_LOCKED', 'This draft is locked.');
      const attachmentIds = input.attachmentIds === undefined ? (draft.attachment_ids ?? []) : input.attachmentIds;
      if (!Array.isArray(attachmentIds) || attachmentIds.length > 3 || attachmentIds.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) || new Set(attachmentIds).size !== attachmentIds.length) {
        throw new CommandError(422, 'INVALID_DRAFT_ATTACHMENTS', 'Choose up to three unique completed image uploads.');
      }
      if (attachmentIds.length) {
        const ready = await client.query<{ id: string }>(`SELECT id FROM media WHERE id=ANY($1::uuid[]) AND owner_user_id=$2
          AND purpose='publication_attachment' AND resource_type='draft' AND resource_id=$3 AND status='ready' AND processed_key IS NOT NULL FOR SHARE`, [attachmentIds, ownerId, id]);
        if (ready.rowCount !== attachmentIds.length) throw new CommandError(422, 'DRAFT_ATTACHMENT_NOT_READY', 'Every attachment must be a processed image assigned to this draft.');
      }
      const nextPlan = { ...obj(draft.plan), ...(input.plan ? obj(input.plan) : {}) };
      let chart: { id: string; state: ChartState; revision: number } | undefined;
      if (input.plan && (Object.hasOwn(obj(input.plan), 'underlyingChartLevels') || Object.hasOwn(obj(input.plan), 'instrumentId') || Object.hasOwn(obj(input.plan), 'asset'))) {
        const chartRow = await client.query<{ id: string; state: ChartState; revision: number }>('SELECT id,state,revision FROM chart_state WHERE draft_id=$1 FOR UPDATE', [id]);
        if (chartRow.rows[0]) {
          chart = chartRow.rows[0];
          if (input.plan.instrumentId && input.plan.instrumentId !== chart.state.instrumentId) throw new CommandError(409, 'CHART_INSTRUMENT_MISMATCH', 'Create a new draft to change the chart instrument.');
          if (input.plan.asset && obj(draft.plan).asset && input.plan.asset !== obj(draft.plan).asset) throw new CommandError(409, 'CHART_ASSET_LOCKED', 'Create a new draft to change the chart asset after chart initialization.');
          const reconciled = reconcileOverlays(chart.state, obj(nextPlan.underlyingChartLevels));
          validateChartSemantics(reconciled);
          await selectEditableReference(client, { ...draft, plan: nextPlan }, reconciled, true, this.provider);
          chart = { ...chart, state: reconciled, revision: nextRevision(Number(chart.revision)) };
          await client.query('UPDATE chart_state SET state=$2::jsonb,provenance=$3::jsonb,schema_version=$4,revision=$5 WHERE id=$1', [chart.id, JSON.stringify(reconciled), JSON.stringify(reconciled.provenance), reconciled.schemaVersion, chart.revision]);
        }
      }
      const nextDraftRevision = nextRevision(Number(draft.revision));
      const saved = await client.query<DraftRow>(`UPDATE draft SET title=$3,thesis=$4,plan=$5::jsonb,attachment_ids=$6::jsonb,revision=$7,chart_revision=$8,updated_at=now()
        WHERE id=$1 AND owner_user_id=$2 AND revision=$9 RETURNING id,kind,title,thesis,plan,attachment_ids,revision,chart_revision,updated_at,deleted_at`,
      [id, ownerId, input.title ?? draft.title, input.thesis ?? draft.thesis, JSON.stringify(nextPlan), JSON.stringify(attachmentIds), nextDraftRevision, chart ? chart.revision : draft.chart_revision, expectedRevision]);
      if (!saved.rows[0]) throw new CommandError(409, 'REVISION_CONFLICT', 'Draft changed. Reload before saving.');
      await rateLimitDraftWrite(client, ownerId, '/drafts/write');
      return project(saved.rows[0]);
    });
  }

  async delete(ownerId: string, id: string, expectedRevision: number) {
    return withTx(this.pool, ownerId, async client => {
      const draft = await lockDraft(client, ownerId, id);
      if (Number(draft.revision) !== expectedRevision) throw new CommandError(409, 'REVISION_CONFLICT', 'Draft changed. Reload before deleting.');
      if (obj(draft.plan).published === true || obj(draft.plan).locked === true) throw new CommandError(409, 'DRAFT_LOCKED', 'This draft is locked.');
      await client.query('UPDATE draft SET deleted_at=now(),revision=$2,updated_at=now() WHERE id=$1 AND revision=$3', [id, nextRevision(Number(draft.revision)), expectedRevision]);
      await rateLimitDraftWrite(client, ownerId, '/drafts/write');
    });
  }

  async getChart(ownerId: string, id: string) {
    const draft = await this.getRow(ownerId, id);
    const result = await this.pool.query<{ state: ChartState; revision: number }>('SELECT state,revision FROM chart_state WHERE draft_id=$1', [id]);
    if (!result.rows[0]) throw new CommandError(404, 'CHART_NOT_INITIALIZED', 'This draft has no saved chart yet.');
    if (Number(result.rows[0].revision) !== Number(draft.chart_revision)) throw new CommandError(409, 'CHART_REVISION_INCONSISTENT', 'Chart revisions are inconsistent. Reload the draft.');
    // A chart that lost current rights stays readable by its owner.
    await selectEditableReferenceOnRead(this.pool, draft, result.rows[0].state);
    return { revision: Number(result.rows[0].revision), state: result.rows[0].state };
  }

  async saveChart(ownerId: string, id: string, expectedRevision: number, state: ChartState) {
    validateChartSemantics(state);
    return withTx(this.pool, ownerId, async client => {
      const draft = await lockDraft(client, ownerId, id);
      if (obj(draft.plan).published === true || obj(draft.plan).locked === true) throw new CommandError(409, 'DRAFT_LOCKED', 'This draft is locked.');
      const existing = await client.query<{ id: string; revision: number; state: ChartState }>('SELECT id,revision,state FROM chart_state WHERE draft_id=$1 FOR UPDATE', [id]);
      const currentRevision = existing.rows[0] ? Number(existing.rows[0].revision) : 0;
      if (expectedRevision !== currentRevision || expectedRevision !== Number(draft.chart_revision)) throw new CommandError(409, 'REVISION_CONFLICT', 'Chart changed. Reload before saving.');
      if (existing.rows[0] && existing.rows[0].state.instrumentId !== state.instrumentId) throw new CommandError(409, 'CHART_INSTRUMENT_MISMATCH', 'Create a new draft to change the chart instrument.');
      await selectEditableReference(client, draft, state, true, this.provider);
      const levels = linkedLevels(state.drawings);
      const nextPlan = { ...obj(draft.plan), underlyingChartLevels: levels };
      const chartRevision = nextRevision(currentRevision);
      const draftRevision = nextRevision(Number(draft.revision));
      if (existing.rows[0]) {
        await client.query('UPDATE chart_state SET state=$2::jsonb,provenance=$3::jsonb,schema_version=$4,revision=$5 WHERE id=$1 AND publication_version_id IS NULL', [existing.rows[0].id, JSON.stringify(state), JSON.stringify(state.provenance), state.schemaVersion, chartRevision]);
      } else {
        await client.query(`INSERT INTO chart_state(id,owner_user_id,draft_id,publication_version_id,schema_version,state,provenance,revision,created_at)
          VALUES($1,$2,$3,NULL,$4,$5::jsonb,$6::jsonb,$7,now())`, [randomUUID(), ownerId, id, state.schemaVersion, JSON.stringify(state), JSON.stringify(state.provenance), chartRevision]);
      }
      const saved = await client.query('UPDATE draft SET plan=$2::jsonb,revision=$3,chart_revision=$4,updated_at=now() WHERE id=$1 RETURNING id', [id, JSON.stringify(nextPlan), draftRevision, chartRevision]);
      if (!saved.rows[0]) throw new CommandError(409, 'REVISION_CONFLICT', 'Draft changed. Reload before saving.');
      await rateLimitDraftWrite(client, ownerId, '/drafts/chart');
      return { revision: chartRevision, state };
    });
  }

  private async getRow(ownerId: string, id: string) {
    const result = await this.pool.query<DraftRow>('SELECT id,kind,title,thesis,plan,attachment_ids,revision,chart_revision,updated_at,deleted_at FROM draft WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL', [id, ownerId]);
    if (!result.rows[0]) throw new CommandError(404, 'DRAFT_NOT_FOUND', 'Draft is unavailable.');
    return result.rows[0];
  }
}

async function selectEditableReferenceOnRead(pool: Pool, draft: DraftRow, state: ChartState) {
  const result = await pool.query(`SELECT i.id,i.asset,i.vendor,i.enabled,m.version FROM instrument i JOIN instrument_metadata_version m ON m.instrument_id=i.id AND m.version=$2 WHERE i.id=$1`, [state.instrumentId, state.metadataVersion]);
  const ref = result.rows[0];
  if (!ref || state.provenance.provider !== ref.vendor || state.provenance.demo !== /synthetic|fixture/i.test(ref.vendor) || state.adjustment !== 'unadjusted' || ref.asset === 'option') throw new CommandError(404, 'CHART_NOT_FOUND', 'Chart is unavailable.');
  const plan = obj(draft.plan);
  if (plan.instrumentId && plan.instrumentId !== state.instrumentId) throw new CommandError(404, 'CHART_NOT_FOUND', 'Chart is unavailable.');
}

async function rateLimitDraftWrite(client: PoolClient, ownerId: string, route: string) {
  const principalHash = createHash('sha256').update(ownerId).digest('hex');
  const result = await client.query(`INSERT INTO rate_limit_bucket(id,principal_hash,route,window_start,counter,expires_at)
    VALUES($1,$2,$3,date_bin('1 minute',now(),TIMESTAMPTZ '2000-01-01'),1,now()+interval '2 minutes')
    ON CONFLICT(principal_hash,route,window_start) DO UPDATE SET counter=rate_limit_bucket.counter+1 RETURNING counter`, [randomUUID(), principalHash, route]);
  if (Number(result.rows[0].counter) > 60) throw new CommandError(429, 'DRAFT_RATE_LIMIT', 'Too many draft changes were submitted. Try again in a minute.');
}

export { parseIfMatch };
