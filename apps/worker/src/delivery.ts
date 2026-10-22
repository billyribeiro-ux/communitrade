import { billingEntitlementScope, billingEntitlementPredicate } from '@trading/config';
import { createHash, createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import { EmailDeliveryError, escapeHtml, isValidSingleMailboxAddress, safeInternalUrl, type EmailPort, type OutboundEmail } from './email.js';
import type { PublicSourceAuthorization } from './source-authorization.js';

export interface DeliveryJob { deliveryId: string }
export type QueueSender = (queue: string, data: DeliveryJob, options?: Record<string, unknown>) => Promise<unknown>;
export interface DeliveryPayload {
  version: 1;
  template: 'notification' | 'daily_digest' | 'transactional_security' | 'transactional_billing';
  recipientUserId: string;
  category: string;
  subject: string;
  title: string;
  body: string;
  internalUrl?: string | null;
  localDate?: string;
  timezone?: string;
  itemCount?: number;
}
export interface DeliveryConfig {
  appOrigin: string;
  sessionSecret: string;
  releaseMode: string;
  emailFrom: string;
  authorizeSource: (publicationId: string) => Promise<PublicSourceAuthorization>;
}
export interface DeliveryRecovery { requeued: number; failed: number; uncertain: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60_000;
const CLAIM_STALE_MS = 10 * 60_000;
const QUEUE_STALE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_RETRY_AGE_MS = DAY_MS;
const CHANNELS = new Set(['email', 'digest_email']);
const TEMPLATES = new Set(['notification', 'daily_digest', 'transactional_security', 'transactional_billing']);
let digestOwnerCursor: string | null = null;

interface ClaimedDelivery {
  id: string;
  channel: string;
  business_delivery_key: string;
  status: string;
  attempts: number;
  max_attempts: number;
  first_attempt_at: Date | string | null;
  owner_user_id: string | null;
  category: string | null;
  payload: unknown;
  claimed_at: Date | string;
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function boundedText(value: unknown, max: number): string {
  return typeof value === 'string'
    ? Array.from(value, char => { const code = char.charCodeAt(0); return code <= 31 || code === 127 ? ' ' : char; }).join('').trim().slice(0, max)
    : '';
}
function publicationSlug(value: string): string { return value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,140) || 'idea'; }
function digestAllowed(settings: Record<string, unknown>, category: string): boolean {
  const settingName: Record<string, string> = {
    publication: 'publicationNotices', reply: 'replyNotices', mention: 'mentionNotices',
    bookmark: 'bookmarkNotices', moderation: 'moderationNotices', account: 'accountNotices', billing: 'billingNotices',
  };
  const key = settingName[category];
  return key ? settings[key] !== false : true;
}
function delayForAttempt(attempt: number): number { return Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempt - 1)); }
function safeErrorCode(error: unknown): string {
  if (error instanceof EmailDeliveryError) return error.code;
  return 'EMAIL_DELIVERY_FAILED';
}
function messageId(deliveryId: string, from: string): string {
  const domain = from.split('@').at(-1)?.replace(/[^a-z0-9.-]/gi, '') || 'local.invalid';
  return `<${deliveryId}@${domain}>`;
}
function queueJobId(deliveryId: string, attempt: number): string {
  const bytes = createHash('sha256').update(`side-effect-delivery:v1:${deliveryId}:${attempt}`).digest().subarray(0,16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function unsubscribeToken(userId: string, secret: string, now: Date): string {
  const expires = Math.floor((now.getTime() + 365 * DAY_MS) / 1000);
  const signature = createHmac('sha256', secret).update(`digest-unsubscribe:v1:${userId}:${expires}`).digest('base64url');
  return `${userId}.${expires}.${signature}`;
}

class EmailDeferredError extends Error {
  constructor(readonly retryAt: Date) { super('EMAIL_DELIVERY_DEFERRED'); }
}

function checkPayload(value: unknown, ownerId: string | null): DeliveryPayload | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.template !== 'string' || !TEMPLATES.has(value.template) ||
      typeof value.recipientUserId !== 'string' || !UUID.test(value.recipientUserId) ||
      (ownerId !== null && ownerId !== value.recipientUserId) || typeof value.category !== 'string' ||
      typeof value.subject !== 'string' || typeof value.title !== 'string' || typeof value.body !== 'string') return null;
  return value as unknown as DeliveryPayload;
}

function htmlEmail(title: string, body: string, link: string | null, unsubscribe: string | null): string {
  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body).replace(/\n/g, '<br>');
  const linkMarkup = link ? `<p><a href="${escapeHtml(link)}">Open in Options Trade Ideas</a></p>` : '';
  const unsubscribeMarkup = unsubscribe ? `<p><a href="${escapeHtml(unsubscribe)}">Manage digest preferences</a></p>` : '';
  return `<!doctype html><html><body><main><h1>${safeTitle}</h1><p>${safeBody}</p>${linkMarkup}${unsubscribeMarkup}</main></body></html>`;
}

function plainEmail(title: string, body: string, link: string | null, unsubscribe: string | null): string {
  return [title, '', body, ...(link ? ['', `Open in Options Trade Ideas: ${link}`] : []), ...(unsubscribe ? ['', `Manage digest preferences: ${unsubscribe}`] : [])].join('\n');
}

function formatLocalParts(date: Date, timezone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

function localDateKey(parts: { year: number; month: number; day: number }): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function addLocalDays(dateKey: string, days: number): string {
  const [year = 0, month = 1, day = 1] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return localDateKey({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() });
}

/** Converts a local wall time to an instant while accounting for zone offset changes. */
export function zonedLocalTimeToUtc(dateKey: string, hour: number, minute: number, timezone: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new RangeError('INVALID_LOCAL_TIME');
  const [year = 0, month = 1, day = 1] = dateKey.split('-').map(Number);
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wanted;
  for (let i = 0; i < 5; i++) {
    const local = formatLocalParts(new Date(guess), timezone);
    const actual = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    const delta = wanted - actual;
    if (delta === 0) return new Date(guess);
    guess += delta;
  }
  // Quiet-hour end can land in a spring-forward gap. Move to the first valid minute after it.
  for (let minuteForward = 1; minuteForward <= 180; minuteForward++) {
    const target = wanted + minuteForward * 60_000;
    let candidate = guess + minuteForward * 60_000;
    for (let i = 0; i < 3; i++) {
      const local = formatLocalParts(new Date(candidate), timezone);
      const actual = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
      candidate += target - actual;
    }
    const local = formatLocalParts(new Date(candidate), timezone);
    if (Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) === target) return new Date(candidate);
  }
  throw new RangeError('UNRESOLVABLE_LOCAL_TIME');
}

function parseClock(value: unknown, fallback: string): { hour: number; minute: number } {
  const candidate = typeof value === 'string' ? value : fallback;
  const match = /^(\d{2}):(\d{2})$/.exec(candidate);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return parseClock(fallback, '22:00');
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function quietWindowContains(hour: number, minute: number, from: { hour: number; minute: number }, until: { hour: number; minute: number }): boolean {
  const point = hour * 60 + minute, start = from.hour * 60 + from.minute, end = until.hour * 60 + until.minute;
  if (start === end) return false;
  return start < end ? point >= start && point < end : point >= start || point < end;
}

function dueLocalTime(settings: Record<string, unknown>): { hour: number; minute: number; daysAfter: number } {
  const hour = 8;
  const minute = 0;
  const from = parseClock(settings.quietFrom, '22:00');
  const until = parseClock(settings.quietUntil, '08:00');
  if (!quietWindowContains(hour, minute, from, until)) return { hour, minute, daysAfter: 0 };
  const wraps = from.hour * 60 + from.minute > until.hour * 60 + until.minute;
  const configured = hour * 60 + minute;
  const crossesMidnight = wraps && configured >= from.hour * 60 + from.minute;
  return { hour: until.hour, minute: until.minute, daysAfter: crossesMidnight ? 1 : 0 };
}

export function digestDueInstant(settings: Record<string, unknown>, localDate: string, timezone: string): Date {
  const time = dueLocalTime(settings);
  return zonedLocalTimeToUtc(addLocalDays(localDate, time.daysAfter), time.hour, time.minute, timezone);
}

function validTimezone(value: unknown): string {
  const timezone = typeof value === 'string' ? value : 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); return timezone; } catch { return 'UTC'; }
}

async function publicSourceRights(pool: Pool, ownerId: string, publicationId: string): Promise<{ title: string; slug: string } | null> {
  const publication = await pool.query(`SELECT p.current_version_id,v.terms,v.chart,v.disclosures
    FROM publication p JOIN publication_version v ON v.id=p.current_version_id
    JOIN user_account author ON author.id=p.author_user_id AND author.status='active'
    WHERE p.id=$1 AND p.visibility='public' AND p.published_at IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM mute m WHERE m.user_id=$2 AND m.author_id=p.author_user_id)`, [publicationId,ownerId]);
  const row = publication.rows[0];
  if (!row) return null;
  const chart = isRecord(row.chart) ? row.chart : {};
  const terms = isRecord(row.terms) ? row.terms : {};
  const plan = isRecord(terms.plan) ? terms.plan : {};
  const ids = new Map<string, { version: number | null; chart: boolean }>();
  if (typeof chart.instrumentId === 'string' && UUID.test(chart.instrumentId)) {
    ids.set(chart.instrumentId, { version: Number.isInteger(chart.metadataVersion) ? Number(chart.metadataVersion) : null, chart: true });
  }
  if (Array.isArray(plan.legs)) for (const leg of plan.legs) {
    if (isRecord(leg) && typeof leg.instrumentId === 'string' && UUID.test(leg.instrumentId)) ids.set(leg.instrumentId, { version: null, chart: false });
  }
  const disclosures = isRecord(row.disclosures) ? row.disclosures : {};
  if (Array.isArray(disclosures.referenceVersions)) for (const reference of disclosures.referenceVersions) {
    if (isRecord(reference) && typeof reference.instrumentId === 'string' && UUID.test(reference.instrumentId)) {
      const current = ids.get(reference.instrumentId);
      ids.set(reference.instrumentId, { version: Number.isInteger(reference.metadataVersion) ? Number(reference.metadataVersion) : current?.version ?? null, chart: current?.chart ?? false });
    }
  }
  if (!ids.size) return null;
  for (const [instrumentId, reference] of ids) {
    const instrument = await pool.query(`SELECT i.vendor,i.asset,COALESCE((SELECT pm.dataset FROM provider_instrument_mapping pm
      WHERE pm.instrument_id=i.id AND pm.metadata_version=m.version AND pm.supplier=i.vendor AND pm.effective_at<=now()
        AND (pm.revoked_at IS NULL OR pm.revoked_at>now()) ORDER BY pm.effective_at DESC LIMIT 1),i.asset) AS dataset
      FROM instrument i JOIN instrument_metadata_version m ON m.instrument_id=i.id
      WHERE i.id=$1 AND ($2::int IS NULL OR m.version=$2)
      ORDER BY m.version DESC LIMIT 1`, [instrumentId,reference.version]);
    const found = instrument.rows[0];
    if (!found) return null;
    const required: Array<{ audience: 'public' | 'member'; purpose: string; flag: string }> = [
      { audience: 'public', purpose: 'display', flag: 'displayPublic' },
      { audience: 'public', purpose: 'snapshot', flag: 'retainSnapshot' },
      { audience: 'member', purpose: 'snapshot', flag: 'retainSnapshot' },
    ];
    if (reference.chart) required.push(
      { audience: 'public', purpose: 'chart', flag: 'retainBars' },
      { audience: 'member', purpose: 'chart', flag: 'retainBars' },
    );
    for (const capability of required) {
      const grant = await pool.query(`SELECT flags,revoked_at FROM data_capability
        WHERE supplier=$1 AND dataset=$2 AND audience=$3 AND purpose=$4 AND effective_at<=now()
        ORDER BY effective_at DESC,id DESC LIMIT 1`, [found.vendor,found.dataset,capability.audience,capability.purpose]);
      const flags = isRecord(grant.rows[0]?.flags) ? grant.rows[0].flags : {};
      if (grant.rows[0]?.revoked_at && new Date(grant.rows[0].revoked_at).getTime() <= Date.now() || flags[capability.flag] !== true) return null;
    }
  }
  const title = boundedText(terms.title, 120);
  const sourceSlug = boundedText(terms.slug, 140);
  return { title: title || 'New public idea', slug: sourceSlug && /^[a-z0-9-]{1,140}$/.test(sourceSlug) ? sourceSlug : publicationSlug(title) };
}

async function currentPreference(pool: Pool, ownerId: string): Promise<{ settings: Record<string, unknown>; email: string | null; active: boolean; verified: boolean } | null> {
  const result = await pool.query(`SELECT u.email,u.status,u.email_verified,p.settings FROM user_account u LEFT JOIN preference p ON p.user_id=u.id WHERE u.id=$1`, [ownerId]);
  const row = result.rows[0];
  if (!row) return null;
  const settings = isRecord(row.settings) ? row.settings : {};
  return { settings, email: typeof row.email === 'string' ? row.email : null, active: row.status === 'active', verified: row.email_verified === true };
}

/** One row per recipient/local date; all schedule calculations use the owner's IANA zone. */
export async function scheduleDailyDigests(pool: Pool, now = new Date(), limit = 500): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new RangeError('DIGEST_SCHEDULE_LIMIT_INVALID');
  const candidates = await pool.query(`SELECT u.id,p.settings FROM user_account u JOIN preference p ON p.user_id=u.id
    WHERE u.status='active' AND u.email_verified=true AND p.settings->>'digestEnabled'='true'
      AND NOT EXISTS(SELECT 1 FROM digest_suppression ds WHERE ds.owner_user_id=u.id AND ds.suppressed_at IS NOT NULL)
      AND ($1::uuid IS NULL OR u.id>$1::uuid)
    ORDER BY u.id LIMIT $2`, [digestOwnerCursor,limit]);
  if (candidates.rows.length < limit) digestOwnerCursor = null;
  else digestOwnerCursor = String(candidates.rows.at(-1)?.id);
  const pending: Array<{ key: string; ownerId: string; payload: DeliveryPayload }> = [];
  for (const row of candidates.rows) {
    const settings = isRecord(row.settings) ? row.settings : {};
    const timezone = validTimezone(settings.timezone);
    let parts: ReturnType<typeof formatLocalParts>;
    try { parts = formatLocalParts(now, timezone); } catch { continue; }
    const localDate = localDateKey(parts);
    const scheduled = dueLocalTime(settings);
    let due: Date | undefined;
    for (const sourceDate of [localDate, addLocalDays(localDate, -1)]) {
      const dueDate = addLocalDays(sourceDate, scheduled.daysAfter);
      if (dueDate !== localDate) continue;
      try { due = zonedLocalTimeToUtc(dueDate, scheduled.hour, scheduled.minute, timezone); } catch { continue; }
      if (now.getTime() >= due.getTime()) break;
      due = undefined;
    }
    if (!due) continue;
    const payload: DeliveryPayload = {
      version: 1, template: 'daily_digest', recipientUserId: String(row.id), category: 'digest',
      subject: 'Your daily Options Trade Ideas digest', title: 'Your daily trading ideas digest',
      body: 'Here are new public ideas related to the people and searches you follow.', localDate, timezone,
    };
    pending.push({ key: `digest:${row.id}:${localDate}`, ownerId: String(row.id), payload });
  }
  if (!pending.length) return 0;
  const inserted = await pool.query(`INSERT INTO side_effect_delivery
    (id,channel,business_delivery_key,status,payload,attempts,max_attempts,next_attempt_at,owner_user_id,category,created_at,updated_at)
    SELECT gen_random_uuid(),'digest_email',input.key,'pending',input.payload,0,$2,now(),input.owner_id,'digest',now(),now()
    FROM jsonb_to_recordset($1::jsonb) AS input(key text,owner_id uuid,payload jsonb)
    ON CONFLICT(channel,business_delivery_key) DO NOTHING RETURNING id`, [JSON.stringify(pending.map(item => ({ key:item.key,owner_id:item.ownerId,payload:item.payload }))),MAX_ATTEMPTS]);
  return inserted.rowCount ?? 0;
}

/** Crash-safe enqueue. A retry before DB acknowledgment reuses the deterministic queue job UUID. */
export async function dispatchSideEffectDeliveries(pool: Pool, send: QueueSender, limit = 25, now = new Date()): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('DELIVERY_DISPATCH_LIMIT_INVALID');
  const client = await pool.connect(); let tx = false; let count = 0;
  try {
    await client.query('BEGIN'); tx = true;
    const rows = await client.query(`SELECT id,channel,attempts FROM side_effect_delivery
      WHERE channel=ANY($1::text[]) AND status='pending' AND next_attempt_at<= $2
      ORDER BY next_attempt_at,created_at,id LIMIT $3 FOR UPDATE SKIP LOCKED`, [[...CHANNELS], now, limit]);
    for (const row of rows.rows) {
      const jobId = queueJobId(String(row.id), Number(row.attempts));
      try {
        await send('email.deliver', { deliveryId: String(row.id) }, {
          id: jobId,
          retryLimit: MAX_ATTEMPTS, retryDelay: 30, retryBackoff: true, expireInSeconds: 86_400,
        });
      } catch {
        await client.query(`UPDATE side_effect_delivery SET attempts=attempts+1,first_attempt_at=COALESCE(first_attempt_at,$2),
          status=CASE WHEN attempts+1>=max_attempts OR COALESCE(first_attempt_at,$2)<=$2::timestamptz-interval '24 hours' THEN 'failed' ELSE 'pending' END,
          last_error_code='QUEUE_ENQUEUE_FAILED',next_attempt_at=CASE WHEN attempts+1>=max_attempts THEN next_attempt_at ELSE $2::timestamptz+make_interval(secs=>LEAST(3600,30*(2^LEAST(attempts,6))::int)) END,updated_at=now()
          WHERE id=$1 AND status='pending'`, [row.id, now]);
        continue;
      }
      // Keep this outside the send catch: failure to persist the queue ACK must
      // roll back while preserving attempts, so replay uses the same stable ID.
      await client.query(`UPDATE side_effect_delivery SET status='queued',queue_job_id=$2,first_attempt_at=COALESCE(first_attempt_at,$3),updated_at=now()
        WHERE id=$1 AND status='pending'`, [row.id, jobId, now]);
      count++;
    }
    await client.query('COMMIT'); tx = false; return count;
  } catch (error) { if (tx) await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

/** Stale queue entries are safely redispatched; stale SMTP claims are quarantined as uncertain. */
export async function reconcileSideEffectDeliveries(pool: Pool, limit = 100, now = new Date()): Promise<DeliveryRecovery> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 250) throw new RangeError('DELIVERY_RECOVERY_LIMIT_INVALID');
  const client = await pool.connect(); let tx = false;
  try {
    await client.query('BEGIN'); tx = true;
    const stale = await client.query(`SELECT id,status,attempts,max_attempts,first_attempt_at FROM side_effect_delivery
      WHERE channel=ANY($1::text[]) AND ((status='queued' AND updated_at<=$2::timestamptz-($3::int*interval '1 millisecond'))
        OR (status='processing' AND claimed_at<=$2::timestamptz-($4::int*interval '1 millisecond')))
      ORDER BY updated_at,id LIMIT $5 FOR UPDATE SKIP LOCKED`, [[...CHANNELS], now, QUEUE_STALE_MS, CLAIM_STALE_MS, limit]);
    const result: DeliveryRecovery = { requeued: 0, failed: 0, uncertain: 0 };
    for (const row of stale.rows) {
      if (row.status === 'processing') {
        await client.query(`UPDATE side_effect_delivery SET status='uncertain',last_error_code='SMTP_ACK_UNCERTAIN',completed_at=now(),claimed_at=NULL,updated_at=now() WHERE id=$1 AND status='processing'`, [row.id]);
        result.uncertain++;
      } else if (Number(row.attempts) >= Number(row.max_attempts) || (row.first_attempt_at && now.getTime() - new Date(row.first_attempt_at).getTime() >= MAX_RETRY_AGE_MS)) {
        await client.query(`UPDATE side_effect_delivery SET status='failed',last_error_code='DELIVERY_RETRY_BUDGET_EXHAUSTED',completed_at=now(),updated_at=now() WHERE id=$1 AND status='queued'`, [row.id]);
        result.failed++;
      } else {
        await client.query(`UPDATE side_effect_delivery SET status='pending',attempts=attempts+1,queue_job_id=NULL,next_attempt_at=$2,updated_at=now() WHERE id=$1 AND status='queued'`, [row.id, now]);
        result.requeued++;
      }
    }
    await client.query('COMMIT'); tx = false; return result;
  } catch (error) { if (tx) await client.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { client.release(); }
}

async function digestPublications(pool: Pool, ownerId: string, from: Date): Promise<Array<{ id: string; title: string; slug: string }>> {
  const account = await currentPreference(pool, ownerId);
  if (!account?.active) return [];
  const entitlement = await pool.query(`SELECT 1 FROM subscription_entitlement WHERE user_id=$1 AND plan='pro' AND valid_from<=now() AND (valid_until IS NULL OR valid_until>now()) AND ${billingEntitlementPredicate('',2)}`, [ownerId,...billingEntitlementScope(process.env)]);
  const rows: Array<{ id: string; title: string; slug: string }> = [];
  if (account.settings.publicationNotices !== false) {
    const followed = await pool.query(`SELECT p.id FROM follow f
      JOIN publication p ON p.author_user_id=f.target_user_id AND p.visibility='public' AND p.published_at >= $2 AND p.published_at<=now()
      JOIN user_account author_account ON author_account.id=p.author_user_id AND author_account.status='active'
      JOIN publication_version v ON v.id=p.current_version_id
      WHERE f.follower_user_id=$1 AND f.target_user_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM mute m WHERE m.user_id=$1 AND m.author_id=p.author_user_id)
      ORDER BY p.published_at DESC,p.id DESC LIMIT 10`, [ownerId,from]);
    for (const row of followed.rows) {
      const safe = await publicSourceRights(pool, ownerId, String(row.id));
      if (safe) rows.push({ id: String(row.id), title: safe.title, slug: safe.slug });
    }
  }
  if (entitlement.rowCount) {
    const searches = await pool.query(`SELECT filters FROM saved_search WHERE owner_user_id=$1 ORDER BY created_at,id LIMIT 5`, [ownerId]);
    for (const search of searches.rows) {
      const filters = isRecord(search.filters) ? search.filters : {};
      const q = boundedText(filters.q, 200) || null;
      const author = boundedText(filters.author, 30) || null;
      const asset = boundedText(filters.asset, 20) || null;
      const strategy = boundedText(filters.strategy, 40) || null;
      const instrumentId = typeof filters.instrumentId === 'string' && UUID.test(filters.instrumentId) ? filters.instrumentId : null;
      const status = boundedText(filters.status, 24) || null;
      const found = await pool.query(`SELECT p.id,v.terms->>'title' AS title FROM publication p
        JOIN publication_version v ON v.id=p.current_version_id
        JOIN profile prof ON prof.user_id=p.author_user_id
        JOIN user_account author_account ON author_account.id=p.author_user_id AND author_account.status='active'
        JOIN instrument source_instrument ON source_instrument.id=COALESCE((v.terms->'plan'->>'instrumentId')::uuid,(v.chart->>'instrumentId')::uuid)
        LEFT JOIN position pos ON pos.public_publication_id=p.id AND pos.owner_user_id=p.author_user_id
        WHERE p.visibility='public' AND p.published_at>= $1 AND p.published_at<=now()
          AND ($2::text IS NULL OR (to_tsvector('simple',coalesce(v.terms->>'title','')||' '||coalesce(v.thesis,'')) @@ websearch_to_tsquery('simple',$2)
            OR to_tsvector('simple',coalesce(prof.display_name,'')||' '||coalesce(prof.handle,'')) @@ websearch_to_tsquery('simple',$2)))
          AND ($3::text IS NULL OR lower(prof.handle)=$3)
          AND ($4::text IS NULL OR COALESCE(v.terms->'plan'->>'asset',source_instrument.asset)=$4)
          AND ($5::text IS NULL OR v.terms->'plan'->>'strategy'=$5)
          AND ($6::uuid IS NULL OR COALESCE((v.terms->'plan'->>'instrumentId')::uuid,(v.chart->>'instrumentId')::uuid)=$6)
          AND ($7::text IS NULL OR COALESCE(pos.state,'pending')=$7)
          AND NOT EXISTS(SELECT 1 FROM mute m WHERE m.user_id=$8 AND m.author_id=p.author_user_id)
        ORDER BY p.published_at DESC,p.id DESC LIMIT 3`, [from,q,author,asset,strategy,instrumentId,status,ownerId]);
      for (const row of found.rows) {
        const safe = await publicSourceRights(pool, ownerId, String(row.id));
        if (safe) rows.push({ id: String(row.id), title: safe.title, slug: safe.slug });
      }
    }
  }
  const unique = new Map<string, { id: string; title: string; slug: string }>();
  for (const row of rows) unique.set(row.id, row);
  return Array.from(unique.values()).slice(0, 10);
}

async function buildMessage(pool: Pool, row: ClaimedDelivery, payload: DeliveryPayload, config: DeliveryConfig, from: string, now: Date): Promise<OutboundEmail | null> {
  const preference = await currentPreference(pool, payload.recipientUserId);
  if (!preference?.active || !preference.email || (payload.template === 'daily_digest' && !preference.verified)) return null;
  const suppression = await pool.query('SELECT 1 FROM email_suppression WHERE owner_user_id=$1 AND suppressed_at IS NOT NULL', [payload.recipientUserId]);
  if (suppression.rowCount) return null;
  if (payload.template === 'daily_digest') {
    if (preference.settings.digestEnabled !== true) return null;
    const suppressed = await pool.query('SELECT 1 FROM digest_suppression WHERE owner_user_id=$1 AND suppressed_at IS NOT NULL', [payload.recipientUserId]);
    if (suppressed.rowCount) return null;
    const timezone = validTimezone(preference.settings.timezone);
    const localNow = formatLocalParts(now, timezone);
    const localToday = localDateKey(localNow);
    if (payload.localDate !== localToday) return null;
    const dueAt = digestDueInstant(preference.settings, localToday, timezone);
    if (now.getTime() < dueAt.getTime()) throw new EmailDeferredError(dueAt);
    const quietFrom = parseClock(preference.settings.quietFrom, '22:00');
    const quietUntil = parseClock(preference.settings.quietUntil, '08:00');
    if (quietWindowContains(localNow.hour, localNow.minute, quietFrom, quietUntil)) {
      const wraps = quietFrom.hour * 60 + quietFrom.minute > quietUntil.hour * 60 + quietUntil.minute;
      const currentMinute = localNow.hour * 60 + localNow.minute;
      const endDate = wraps && currentMinute >= quietFrom.hour * 60 + quietFrom.minute ? addLocalDays(localToday,1) : localToday;
      if (endDate !== localToday) return null;
      throw new EmailDeferredError(zonedLocalTimeToUtc(endDate,quietUntil.hour,quietUntil.minute,timezone));
    }
    const pro = await pool.query(`SELECT 1 FROM subscription_entitlement WHERE user_id=$1 AND plan='pro' AND valid_from<=now() AND (valid_until IS NULL OR valid_until>now()) AND ${billingEntitlementPredicate('',2)}`, [payload.recipientUserId,...billingEntitlementScope(process.env)]);
    const createdAt = row.first_attempt_at ? new Date(row.first_attempt_at) : new Date();
    const items = await digestPublications(pool, payload.recipientUserId, new Date(createdAt.getTime() - DAY_MS));
    if (!items.length) return null;
    const authorizedItems: Array<{title:string;url:string}> = [];
    for (const item of items) {
      const authorized = await config.authorizeSource(item.id);
      if (authorized.available && authorized.title && authorized.url) authorizedItems.push({ title: boundedText(authorized.title,120) || 'New public idea', url: safeInternalUrl(authorized.url,config.appOrigin) ?? '' });
    }
    const visibleItems = authorizedItems.filter(item => item.url);
    if (!visibleItems.length) return null;
    const itemLines = visibleItems.map(item => `${item.title}: ${item.url}`);
    const body = pro.rowCount
      ? `New public ideas from people you follow and your saved searches.\n\n${itemLines.join('\n')}`
      : `New public ideas from people you follow.\n\n${itemLines.join('\n')}`;
    const token = unsubscribeToken(payload.recipientUserId, config.sessionSecret, now);
    const unsubscribe = safeInternalUrl(`/digest/unsubscribe?token=${encodeURIComponent(token)}`, config.appOrigin);
    return {
      to: preference.email, from, subject: payload.subject.slice(0, 160),
      text: plainEmail(payload.title, body, null, unsubscribe),
      html: htmlEmail(payload.title, body, null, unsubscribe),
      messageId: messageId(row.id, from),
    };
  }
  const transactional = payload.template === 'transactional_security' || payload.template === 'transactional_billing';
  const mandatoryCategory = ['account','billing','security'].includes(payload.category);
  if (!transactional && !mandatoryCategory && !digestAllowed(preference.settings, payload.category)) return null;
  let internalUrl = payload.internalUrl;
  const publicationPath = typeof internalUrl === 'string' ? /^\/ideas\/([0-9a-f-]{36})(?:\/|$)/i.exec(internalUrl) : null;
  if (publicationPath) {
    const authorization = await config.authorizeSource(publicationPath[1] ?? '');
    if (!authorization.available || !authorization.url) internalUrl = '/app/notifications';
    else internalUrl = authorization.url;
  }
  const link = safeInternalUrl(internalUrl, config.appOrigin);
  const title = boundedText(payload.title, 160) || (transactional ? 'Account notice' : 'Notification');
  const body = boundedText(payload.body, 1000);
  if (!body) return null;
  return {
    to: preference.email, from, subject: boundedText(payload.subject, 160) || title,
    text: plainEmail(title, body, link, null), html: htmlEmail(title, body, link, null), messageId: messageId(row.id, from),
  };
}

/** Consumer rechecks account, preference, unsubscribe and public visibility immediately before send. */
export async function processEmailDelivery(pool: Pool, email: EmailPort, payload: DeliveryJob, config: DeliveryConfig, now = new Date()): Promise<void> {
  if (!payload || typeof payload !== 'object' || Object.keys(payload).some(key => key !== 'deliveryId') || !UUID.test(String(payload.deliveryId))) throw new Error('INVALID_DELIVERY_JOB');
  const claimClient = await pool.connect(); let tx = false; let row: ClaimedDelivery | undefined;
  try {
    await claimClient.query('BEGIN'); tx = true;
    const selected = await claimClient.query(`SELECT id,channel,business_delivery_key,status,attempts,max_attempts,first_attempt_at,owner_user_id,category,payload,claimed_at
      FROM side_effect_delivery WHERE id=$1 AND channel=ANY($2::text[]) FOR UPDATE`, [payload.deliveryId,[...CHANNELS]]);
    row = selected.rows[0];
    if (!row || ['succeeded','failed','suppressed','uncertain'].includes(row.status)) { await claimClient.query('COMMIT'); tx = false; return; }
    if (row.status === 'processing') {
      if (row.claimed_at && new Date(row.claimed_at).getTime() > now.getTime() - CLAIM_STALE_MS) {
        await claimClient.query('COMMIT'); tx = false; return;
      }
      await claimClient.query(`UPDATE side_effect_delivery SET status='uncertain',last_error_code='SMTP_ACK_UNCERTAIN',completed_at=now(),claimed_at=NULL,updated_at=now() WHERE id=$1 AND status='processing'`, [row.id]);
      await claimClient.query('COMMIT'); tx = false; return;
    }
    if (!['pending','queued','processing'].includes(row.status)) { await claimClient.query('COMMIT'); tx = false; return; }
    const firstAttempt = row.first_attempt_at ? new Date(row.first_attempt_at) : now;
    if (Number(row.attempts) >= Math.min(MAX_ATTEMPTS, Number(row.max_attempts)) || now.getTime() - firstAttempt.getTime() >= MAX_RETRY_AGE_MS) {
      await claimClient.query(`UPDATE side_effect_delivery SET status='failed',last_error_code='DELIVERY_RETRY_BUDGET_EXHAUSTED',completed_at=now(),claimed_at=NULL,updated_at=now() WHERE id=$1`, [row.id]);
      await claimClient.query('COMMIT'); tx = false; return;
    }
    const payloadValue = checkPayload(row.payload, row.owner_user_id);
    if (!payloadValue) {
      await claimClient.query(`UPDATE side_effect_delivery SET status='failed',attempts=attempts+1,last_error_code='INVALID_DELIVERY_PAYLOAD',completed_at=now(),claimed_at=NULL,updated_at=now() WHERE id=$1`, [row.id]);
      await claimClient.query('COMMIT'); tx = false; return;
    }
    if ((row.channel === 'digest_email') !== (payloadValue.template === 'daily_digest')) {
      await claimClient.query(`UPDATE side_effect_delivery SET status='failed',attempts=attempts+1,last_error_code='DELIVERY_CHANNEL_TEMPLATE_MISMATCH',completed_at=now(),claimed_at=NULL,updated_at=now() WHERE id=$1`, [row.id]);
      await claimClient.query('COMMIT'); tx = false; return;
    }
    const attempt = Number(row.attempts) + 1;
    const claim = await claimClient.query(`UPDATE side_effect_delivery SET status='processing',attempts=$2,first_attempt_at=COALESCE(first_attempt_at,$3),last_attempt_at=$3,claimed_at=$3,updated_at=now(),last_error_code=NULL WHERE id=$1 RETURNING id`, [row.id,attempt,now]);
    if (!claim.rowCount) { await claimClient.query('COMMIT'); tx = false; return; }
    row = { ...row, status: 'processing', attempts: attempt, first_attempt_at: firstAttempt, claimed_at: now };
    await claimClient.query('COMMIT'); tx = false;
  } catch (error) { if (tx) await claimClient.query('ROLLBACK').catch(() => undefined); throw error; }
  finally { claimClient.release(); }
  if (!row) return;

  const payloadValue = checkPayload(row.payload, row.owner_user_id);
  if (!payloadValue) return;
  let message: OutboundEmail | null;
  let from: string;
  try {
    const fromValue = config.emailFrom.trim();
    if (!fromValue) throw new Error('EMAIL_FROM_MISSING');
    from = fromValue;
    message = await buildMessage(pool, row, payloadValue, config, from, now);
  } catch (error) {
    if (error instanceof EmailDeferredError) {
      await pool.query(`UPDATE side_effect_delivery SET status='pending',attempts=GREATEST(0,attempts-1),last_error_code='DIGEST_QUIET_HOURS',completed_at=NULL,claimed_at=NULL,next_attempt_at=$3,updated_at=now()
        WHERE id=$1 AND status='processing' AND attempts=$2`, [row.id,row.attempts,error.retryAt]);
      return;
    }
    const exhausted = Number(row.attempts) >= Math.min(MAX_ATTEMPTS, Number(row.max_attempts)) || now.getTime() - new Date(row.first_attempt_at ?? now).getTime() >= MAX_RETRY_AGE_MS;
    await pool.query(`UPDATE side_effect_delivery SET status=$3::varchar,last_error_code='DELIVERY_PREPARATION_FAILED',completed_at=CASE WHEN $3::varchar='failed' THEN now() ELSE NULL END,claimed_at=NULL,
      next_attempt_at=$4,updated_at=now() WHERE id=$1 AND status='processing' AND attempts=$2`, [row.id,row.attempts,exhausted?'failed':'pending',new Date(now.getTime()+delayForAttempt(Number(row.attempts)))]);
    return;
  }
  if (!message) {
    await pool.query(`UPDATE side_effect_delivery SET status='suppressed',last_error_code='CURRENT_PREFERENCE_OR_ACCOUNT_SUPPRESSED',completed_at=now(),claimed_at=NULL,updated_at=now() WHERE id=$1 AND status='processing' AND attempts=$2`, [row.id,row.attempts]);
    return;
  }

  if (!isValidSingleMailboxAddress(message.to)) {
    await pool.query(`UPDATE side_effect_delivery SET status='failed',last_error_code='INVALID_RECIPIENT_ADDRESS',completed_at=now(),claimed_at=NULL,updated_at=now() WHERE id=$1 AND status='processing' AND attempts=$2`, [row.id,row.attempts]);
    return;
  }

  if (!['public','production'].includes(config.releaseMode) && !/^[^@\s]+@[^@\s]+\.invalid$/i.test(message.to)) {
    await pool.query(`UPDATE side_effect_delivery SET status='suppressed',last_error_code='LOCAL_RECIPIENT_NOT_SYNTHETIC',completed_at=now(),claimed_at=NULL,updated_at=now() WHERE id=$1 AND status='processing' AND attempts=$2`, [row.id,row.attempts]);
    return;
  }
  let result: { messageId: string; accepted: boolean };
  try {
    result = await email.send(message);
    if (!result.accepted) throw new EmailDeliveryError('SMTP_NOT_ACCEPTED', false);
  } catch (error) {
    const code = safeErrorCode(error);
    const uncertain = error instanceof EmailDeliveryError && error.uncertain;
    const recipientRejected = code === 'SMTP_RECIPIENT_REJECTED';
    const permanent = recipientRejected || code === 'SMTP_REJECTED' || code === 'SMTP_AUTH_FAILED' || code === 'INVALID_RECIPIENT_ADDRESS';
    if (recipientRejected && row.owner_user_id) {
      await pool.query(`INSERT INTO email_suppression(owner_user_id,suppressed_at,reason,updated_at)
        VALUES($1,now(),'bounce',now()) ON CONFLICT(owner_user_id) DO UPDATE SET suppressed_at=now(),reason='bounce',updated_at=now()`, [row.owner_user_id]);
    }
    const exhausted = Number(row.attempts) >= Math.min(MAX_ATTEMPTS, Number(row.max_attempts)) || now.getTime() - new Date(row.first_attempt_at ?? now).getTime() >= MAX_RETRY_AGE_MS;
    const status = uncertain ? 'uncertain' : permanent || exhausted ? 'failed' : 'pending';
    const next = new Date(now.getTime() + delayForAttempt(Number(row.attempts)));
    await pool.query(`UPDATE side_effect_delivery SET status=$3::varchar,last_error_code=$4,completed_at=CASE WHEN $3::varchar IN ('failed','uncertain') THEN now() ELSE NULL END,
      claimed_at=NULL,next_attempt_at=$5,updated_at=now() WHERE id=$1 AND status='processing' AND attempts=$2`, [row.id,row.attempts,status,code,next]);
    return;
  }
  try {
    await pool.query(`UPDATE side_effect_delivery SET status='succeeded',provider_reference=$3,result=$4::jsonb,completed_at=now(),claimed_at=NULL,next_attempt_at=now(),updated_at=now()
      WHERE id=$1 AND status='processing' AND attempts=$2`, [row.id,row.attempts,result.messageId,JSON.stringify({ accepted: true })]);
  } catch {
    // SMTP accepted the message. Never retry it because the database acknowledgment failed.
    await pool.query(`UPDATE side_effect_delivery SET status='uncertain',last_error_code='SMTP_ACK_UNCERTAIN',completed_at=now(),claimed_at=NULL,updated_at=now()
      WHERE id=$1 AND status='processing' AND attempts=$2`, [row.id,row.attempts]).catch(() => undefined);
  }
}

export async function deliveryBacklogTelemetry(pool: Pool): Promise<{ pending: number; queued: number; processing: number; failed: number; uncertain: number; oldestPendingAt: string | null }> {
  const result = await pool.query(`SELECT count(*) FILTER(WHERE status='pending')::int AS pending,
    count(*) FILTER(WHERE status='queued')::int AS queued,count(*) FILTER(WHERE status='processing')::int AS processing,
    count(*) FILTER(WHERE status='failed')::int AS failed,count(*) FILTER(WHERE status='uncertain')::int AS uncertain,
    to_char(min(created_at) FILTER(WHERE status IN ('pending','queued','processing')) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS oldest_pending_at
    FROM side_effect_delivery WHERE channel=ANY($1::text[])`, [[...CHANNELS]]);
  const row = result.rows[0] ?? {};
  return { pending: Number(row.pending ?? 0), queued: Number(row.queued ?? 0), processing: Number(row.processing ?? 0), failed: Number(row.failed ?? 0), uncertain: Number(row.uncertain ?? 0), oldestPendingAt: row.oldest_pending_at ?? null };
}
