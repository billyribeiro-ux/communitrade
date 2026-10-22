import type { components } from '@trading/contracts';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { validateOptionStrategy, type MarketDataPort, type MarketCapabilities, type MarketDataEnvelope, type MarketAudience, type MarketPurpose, type OptionStrategySelection } from '@trading/domain';
import type { Actor } from '../auth/service.js';
import { CommandError } from '../http/problem.js';
import { executeIdempotentCommand, type Json, type Transaction } from '../persistence/transactions.js';
type Row = Record<string, any>;
type Queryable = Transaction;
type Caps = MarketCapabilities;
const NO_CAPS: Caps = {
  displayPublic: false,
  displayMember: false,
  retainBars: false,
  retainSnapshot: false,
  exportImage: false,
  exportPersonalRecord: false,
  newPublishing: false
};
const CAP_KEYS = Object.keys(NO_CAPS) as (keyof Caps)[];
const failProvider = () => new CommandError(503, 'MARKET_DATA_UNAVAILABLE', 'Market data is temporarily unavailable.');
const badRequest = (code: string, detail: string) => new CommandError(400, code, detail);
const safeBool = (v: unknown) => v === true;
const capFlags = (value: unknown): Caps => {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return Object.fromEntries(CAP_KEYS.map(key => [key, safeBool(source[key])])) as unknown as Caps;
};
const latestCaps = (rows: Row[], supplier: string, dataset: string, audience: MarketAudience, purpose: MarketPurpose): Caps => {
  const now = Date.now();
  const applicable = rows.filter(r => r.supplier === supplier && r.dataset === dataset && r.audience === audience && r.purpose === purpose && new Date(r.effective_at).getTime() <= now && (!r.revoked_at || new Date(r.revoked_at).getTime() > now));
  // Multiple active agreements for the same scope can only narrow permission.
  // Purpose-specific composition happens later, so unrelated purposes never intersect.
  return applicable.length ? applicable.map(r => capFlags(r.flags)).reduce((a, b) => Object.fromEntries(CAP_KEYS.map(k => [k, a[k] && b[k]])) as unknown as Caps) : NO_CAPS;
};
const intersect = (a: Caps, b: Caps): Caps => Object.fromEntries(CAP_KEYS.map(k => [k, a[k] && b[k]])) as unknown as Caps;
const cursorEncode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const cursorDecode = (cursor?: string): {
  symbol?: string;
  id: string;
  sort?: unknown[];
} | undefined => {
  if (!cursor) return;
  try {
    const x = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as Row;
    if (typeof x.id === 'string' && /^[0-9a-f-]{36}$/i.test(x.id) && (typeof x.symbol === 'string' && !Array.isArray(x.sort) || Array.isArray(x.sort) && x.sort.length === 4 && x.sort.every(v => typeof v === 'string' || typeof v === 'number'))) return {
      id: x.id,
      ...(typeof x.symbol === 'string' ? {
        symbol: x.symbol
      } : {}),
      ...(Array.isArray(x.sort) ? {
        sort: x.sort
      } : {})
    };
  } catch {}
  throw badRequest('INVALID_CURSOR', 'The pagination cursor is invalid.');
};
const limitValue = (value: unknown, defaultValue = 20) => {
  if (value === undefined) return defaultValue;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 50) throw badRequest('INVALID_PAGE_SIZE', 'Page size must be from 1 through 50.');
  return n;
};
const barsLimitValue = (value: unknown) => {
  if (value === undefined) return 100;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 10_000) throw badRequest('INVALID_PAGE_SIZE', 'Bar page size must be from 1 through 10000.');
  return n;
};
const barRangeError = (interval: string, from: string, to: string) => {
  if (!['1m', '5m', '15m', '1h', '1d'].includes(interval)) return 'Bar interval is unsupported.';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(from) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(to) || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to)) || Date.parse(to) <= Date.parse(from)) return 'Bars require an increasing UTC date range.';
  const start = new Date(from), end = new Date(to), max = new Date(start);
  if (interval === '1d') max.setUTCFullYear(max.getUTCFullYear() + 1);
  else max.setUTCDate(max.getUTCDate() + 90);
  if (end > max) return interval === '1d' ? 'Daily history is limited to one calendar year.' : 'Intraday history is limited to 90 calendar days.';
  return null;
};
const barCursorError = (cursor: unknown, from: string, to: string) => {
  if (cursor === undefined) return null;
  if (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > 500) return 'The bar pagination cursor is invalid.';
  if (/^\d+$/.test(cursor)) return Number.isSafeInteger(Number(cursor)) ? null : 'The bar pagination cursor is invalid.';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(cursor)) return 'The bar pagination cursor is invalid.';
  const time = Date.parse(cursor);
  return Number.isFinite(time) && time >= Date.parse(from) && time < Date.parse(to) ? null : 'The bar pagination cursor is outside the requested range.';
};
const assetValue = (value: unknown): string | undefined => {
  if (value === undefined) return;
  if (!['stock', 'option', 'future'].includes(String(value))) throw badRequest('INVALID_ASSET_CLASS', 'Asset class must be stock, option, or future.');
  return String(value);
};
const iso = (value: Date | string | null | undefined) => value === null || value === undefined ? null : new Date(value).toISOString();
const sessionValue = (value: unknown): string | null => typeof value === 'string' ? value : value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Row).label === 'string' ? (value as Row).label : null;
const calendarVenue = (row: Row) => {
  const session = sessionValue(row.session)?.toUpperCase();
  if (session === 'US_EQUITY') return 'US_EQUITY';
  if (session === 'CME_GLOBEX') return 'CME_GLOBEX';
  if (row.asset === 'stock') return 'US_EQUITY';
  if (row.asset === 'future') return 'CME_GLOBEX';
  return String(row.venue);
};
const responseMeta = (reference: string, version: number, caps: Caps, source: string, freshness: 'fresh' | 'stale' | 'missing' | 'unavailable' = 'missing', delaySeconds = 0, asOf: string | null | undefined = null) => ({
  provider: source,
  providerReference: reference,
  asOf: asOf ?? null,
  delaySeconds,
  freshness,
  demo: /synthetic|fixture/i.test(source),
  metadataVersion: version,
  capabilities: caps
});
export class InstrumentService {
  constructor(private readonly pool: Pool, private readonly provider: MarketDataPort, private readonly mode: string, private readonly configured: boolean) {}
  private async capRows(queryable: Queryable = this.pool): Promise<Row[]> {
    return (await queryable.query('SELECT supplier,agreement_id,dataset,audience,purpose,effective_at,revoked_at,flags FROM data_capability')).rows;
  }
  private async row(id: string, version?: number, queryable: Queryable = this.pool): Promise<Row> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new CommandError(404, 'INSTRUMENT_NOT_FOUND', 'The instrument was not found.');
    const result = await queryable.query(`SELECT i.id,i.asset,i.vendor,i.vendor_id,i.underlying_id,i.venue,i.currency,i.enabled,m.version,m.multiplier,m.tick_size,m.strike,m.expiry,m.root,m.contract_month,m.contract_year,m.option_type,m.adjusted,m.session,m.source_id,
      ARRAY(SELECT mv.version FROM instrument_metadata_version mv WHERE mv.instrument_id=i.id ORDER BY mv.version) AS metadata_versions,
      (SELECT json_agg(json_build_object('metadataVersion',mv.version,'sourceId',mv.source_id) ORDER BY mv.version) FROM instrument_metadata_version mv WHERE mv.instrument_id=i.id) AS versions,
      COALESCE((SELECT pm.dataset FROM provider_instrument_mapping pm WHERE pm.instrument_id=i.id AND pm.metadata_version=m.version AND pm.supplier=i.vendor AND pm.effective_at<=now() AND (pm.revoked_at IS NULL OR pm.revoked_at>now()) ORDER BY pm.effective_at DESC LIMIT 1),i.asset) AS provider_dataset
      FROM instrument i JOIN instrument_metadata_version m ON m.instrument_id=i.id
      WHERE i.id=$1 AND ($2::int IS NULL OR m.version=$2) ${version === undefined ? 'AND m.version=(SELECT MAX(mx.version) FROM instrument_metadata_version mx WHERE mx.instrument_id=i.id)' : ''}`, [id, version ?? null]);
    const row = result.rows[0];
    if (!row) throw new CommandError(404, 'INSTRUMENT_NOT_FOUND', 'The instrument was not found.');
    return row;
  }
  private async caps(row: Row, audience: MarketAudience, purpose: MarketPurpose, queryable: Queryable = this.pool, cachedRows?: Row[]): Promise<Caps> {
    const rows = cachedRows ?? await this.capRows(queryable);
    const db = latestCaps(rows, row.vendor, row.provider_dataset ?? row.asset, audience, purpose);
    const needed: Record<MarketPurpose, keyof Caps> = {
      display: audience === 'public' ? 'displayPublic' : 'displayMember',
      chart: 'retainBars',
      snapshot: 'retainSnapshot',
      export: 'exportImage',
      personal_record: 'exportPersonalRecord',
      publishing: 'newPublishing'
    };
    if (!db[needed[purpose]]) return NO_CAPS;
    // The adapter's rights are an independent upper bound; supplier responses cannot grant platform rights.
    try {
      const p = await this.provider.getCapabilities(this.providerId(row), audience, purpose);
      return intersect(db, p.data);
    } catch {
      throw failProvider();
    }
  }
  private async effectiveCapabilities(row: Row, audience: MarketAudience, queryable: Queryable = this.pool): Promise<Caps> {
    // One SQL read per capability projection; provider checks may then run in
    // parallel without scheduling concurrent queries on a transaction client.
    const rows = await this.capRows(queryable);
    const display = await this.caps(row, audience, 'display', queryable, rows);
    if (!(audience === 'public' ? display.displayPublic : display.displayMember)) return NO_CAPS;
    const [chart, snapshot, exportCaps, personal, publishing] = await Promise.all([this.caps(row, audience, 'chart', queryable, rows), this.caps(row, audience, 'snapshot', queryable, rows), this.caps(row, audience, 'export', queryable, rows), this.caps(row, audience, 'personal_record', queryable, rows), this.caps(row, audience, 'publishing', queryable, rows)]);
    return {
      displayPublic: display.displayPublic,
      displayMember: display.displayMember,
      retainBars: chart.retainBars,
      retainSnapshot: snapshot.retainSnapshot,
      exportImage: exportCaps.exportImage,
      exportPersonalRecord: personal.exportPersonalRecord,
      newPublishing: publishing.newPublishing
    };
  }
  // Provider-facing UUIDs resolve through explicit synthetic fixture metadata or the
  // production adapter's instrumentMap. Never infer dataset/symbol from a caller ID.
  private providerId(row: Row): string {
    return row.id;
  }
  private async displayEnvelope(row: Row, audience: MarketAudience) {
    try {
      return await this.provider.getCapabilities(this.providerId(row), audience, 'display');
    } catch {
      throw failProvider();
    }
  }
  private async visible(row: Row, audience: MarketAudience): Promise<Caps> {
    const c = await this.caps(row, audience, 'display');
    if (audience === 'public' && !c.displayPublic || audience === 'member' && !c.displayMember) throw new CommandError(403, 'DATA_DISPLAY_NOT_LICENSED', 'This data is not licensed for display to this audience.');
    return c;
  }
  private mapSummary(row: Row, caps: Caps = NO_CAPS, meta?: MarketDataEnvelope<unknown>) {
    const versions = Array.isArray(row.versions) ? row.versions : row.metadata_versions?.map((metadataVersion: number) => ({
      metadataVersion,
      sourceId: metadataVersion === row.version ? row.source_id : null
    })) ?? [{
      metadataVersion: row.version,
      sourceId: row.source_id ?? null
    }];
    return {
      id: row.id,
      asset: row.asset,
      symbol: row.vendor_id,
      name: row.vendor_id,
      venue: row.venue,
      currency: row.currency,
      metadataVersion: row.version,
      availableMetadataVersions: versions.map((v: Row) => v.metadataVersion),
      versions,
      multiplier: String(row.multiplier),
      tickSize: String(row.tick_size),
      enabled: Boolean(row.enabled),
      ...(row.underlying_id ? {
        underlyingId: row.underlying_id
      } : {}),
      ...(row.expiry ? {
        expiration: iso(row.expiry)
      } : {}),
      ...(row.option_type ? {
        optionType: row.option_type
      } : {}),
      ...(row.strike !== null ? {
        strike: String(row.strike)
      } : {}),
      ...(row.root ? {
        root: row.root
      } : {}),
      ...(row.contract_month && row.contract_year ? {
        contractMonth: `${row.contract_year}-${String(row.contract_month).padStart(2, '0')}`
      } : {}),
      adjusted: Boolean(row.adjusted),
      session: sessionValue(row.session),
      source: row.vendor,
      meta: responseMeta(meta?.providerReference ?? `catalog:${row.vendor}:${row.vendor_id}`, row.version, caps, row.vendor, meta?.freshness ?? 'missing', meta?.delaySeconds ?? 0, meta?.asOf)
    };
  }
  private mapDetail(row: Row, caps: Caps = NO_CAPS, meta?: MarketDataEnvelope<unknown>) {
    return this.mapSummary(row, caps, meta);
  }
  async search(query: string, assetClass: unknown, rootInput: unknown, cursor: unknown, limit: unknown, audience: MarketAudience) {
    const q = String(query ?? '').trim();
    if (q.length > 200) throw badRequest('INVALID_QUERY', 'Search is limited to 200 characters.');
    let asset = assetValue(assetClass);
    const root = rootInput === undefined ? undefined : String(rootInput);
    if (root !== undefined && !['ES', 'MES', 'NQ', 'MNQ'].includes(root)) throw badRequest('INVALID_FUTURES_ROOT', 'Supported futures roots are ES, MES, NQ, and MNQ.');
    if (root !== undefined && asset !== undefined && asset !== 'future') throw badRequest('INVALID_ASSET_ROOT_FILTER', 'Futures root cannot be combined with another asset class.');
    if (root !== undefined) asset = 'future';
    const count = limitValue(limit);
    let after = cursorDecode(typeof cursor === 'string' ? cursor : undefined);
    if (after?.sort) throw badRequest('INVALID_CURSOR', 'The pagination cursor does not match this endpoint.');
    const items = [] as Row[];
    let hasMore = false;
    // Scan past rows that lack audience rights so pagination cannot silently skip later visible symbols.
    while (items.length <= count) {
      const result = await this.pool.query(`SELECT i.id,i.asset,i.vendor,i.vendor_id,i.underlying_id,i.venue,i.currency,i.enabled,m.version,m.multiplier,m.tick_size,m.strike,m.expiry,m.root,m.contract_month,m.contract_year,m.option_type,m.adjusted,m.session,m.source_id,
      COALESCE((SELECT pm.dataset FROM provider_instrument_mapping pm WHERE pm.instrument_id=i.id AND pm.metadata_version=m.version AND pm.supplier=i.vendor AND pm.effective_at<=now() AND (pm.revoked_at IS NULL OR pm.revoked_at>now()) ORDER BY pm.effective_at DESC LIMIT 1),i.asset) AS provider_dataset
      FROM instrument i JOIN instrument_metadata_version m ON m.instrument_id=i.id AND m.version=(SELECT MAX(mx.version) FROM instrument_metadata_version mx WHERE mx.instrument_id=i.id)
      WHERE ($1::text IS NULL OR i.asset=$1) AND ($2='' OR i.vendor_id ILIKE '%'||$2||'%') AND ($5::text IS NULL OR m.root=$5)
      AND ($3::text IS NULL OR (i.vendor_id,i.id)>($3,$4::uuid)) ORDER BY i.vendor_id,i.id LIMIT 100`, [asset ?? null, q, after?.symbol ?? null, after?.id ?? null, root ?? null]);
      if (!result.rows.length) break;
      for (const row of result.rows) {
        after = {
          symbol: row.vendor_id,
          id: row.id
        };
        const effective = await this.effectiveCapabilities(row, audience);
        if (!(audience === 'public' ? effective.displayPublic : effective.displayMember)) continue;
        const provider = await this.displayEnvelope(row, audience);
        items.push(this.mapSummary(row, effective, provider));
        if (items.length > count) {
          hasMore = true;
          break;
        }
      }
      if (hasMore || result.rows.length < 100) break;
    }
    const visible = items.slice(0, count),
      last = visible.at(-1);
    return {
      items: visible,
      nextCursor: hasMore && last ? cursorEncode({
        symbol: last.symbol,
        id: last.id
      }) : null
    };
  }
  /** Display-only catalog summaries for an already owner-authorized watchlist.
   * One reference query and one capability read replace one HTTP call per item.
   * No quote/bar payload is fetched and revoked display rights omit the label. */
  async workspaceSummaries(ids: string[], queryable: Queryable = this.pool): Promise<components['schemas']['Instrument'][]> {
    if (!ids.length) return [];
    if (ids.length > 100 || ids.some(id => !/^[0-9a-f-]{36}$/i.test(id))) throw badRequest('INVALID_INSTRUMENT_IDS', 'Invalid watchlist references.');
    const result = await queryable.query(`SELECT i.id,i.asset,i.vendor,i.vendor_id,i.underlying_id,i.venue,i.currency,i.enabled,m.version,m.multiplier,m.tick_size,m.strike,m.expiry,m.root,m.contract_month,m.contract_year,m.option_type,m.adjusted,m.session,m.source_id,
      COALESCE((SELECT pm.dataset FROM provider_instrument_mapping pm WHERE pm.instrument_id=i.id AND pm.metadata_version=m.version AND pm.supplier=i.vendor AND pm.effective_at<=now() AND (pm.revoked_at IS NULL OR pm.revoked_at>now()) ORDER BY pm.effective_at DESC LIMIT 1),i.asset) AS provider_dataset
      FROM instrument i JOIN instrument_metadata_version m ON m.instrument_id=i.id AND m.version=(SELECT MAX(mx.version) FROM instrument_metadata_version mx WHERE mx.instrument_id=i.id)
      WHERE i.id=ANY($1::uuid[]) ORDER BY i.vendor_id,i.id`, [ids]);
    const capabilityRows = await this.capRows(queryable), items: components['schemas']['Instrument'][] = [];
    for (const row of result.rows) {
      const display = await this.caps(row, 'member', 'display', queryable, capabilityRows);
      if (display.displayMember) items.push(this.mapSummary(row, display) as components['schemas']['Instrument']);
    }
    return items;
  }
  async get(id: string, versionInput: unknown, audience: MarketAudience, queryable: Queryable = this.pool) {
    const version = versionInput === undefined ? undefined : Number(versionInput);
    if (versionInput !== undefined && (!Number.isInteger(version) || version! < 1)) throw badRequest('INVALID_METADATA_VERSION', 'Metadata version must be a positive integer.');
    const row = await this.row(id, version, queryable);
    const caps = await this.effectiveCapabilities(row, audience, queryable);
    if (!(audience === 'public' ? caps.displayPublic : caps.displayMember)) throw new CommandError(403, 'DATA_DISPLAY_NOT_LICENSED', 'This data is not licensed for display to this audience.');
    const envelope = await this.displayEnvelope(row, audience);
    return this.mapDetail(row, caps, envelope);
  }
  async optionContracts(underlyingId: string, expiration: unknown, optionType: unknown, cursor: unknown, limit: unknown, audience: MarketAudience) {
    const under = await this.row(underlyingId);
    if (under.asset !== 'stock') throw new CommandError(422, 'INVALID_OPTION_UNDERLYING', 'Options require a supported stock or ETF underlying.');
    const count = limitValue(limit);
    const after = cursorDecode(typeof cursor === 'string' ? cursor : undefined);
    const date = expiration === undefined ? null : String(expiration);
    if (date !== null && (!/^\d{4}-\d{2}-\d{2}T/.test(date) || !Number.isFinite(Date.parse(date)))) throw badRequest('INVALID_EXPIRATION', 'Expiration must be an ISO date or timestamp.');
    if (optionType !== undefined && !['call', 'put'].includes(String(optionType))) throw badRequest('INVALID_OPTION_TYPE', 'Option type must be call or put.');
    let sort = after?.sort;
    if (after && (!sort || sort.length !== 4 || typeof sort[0] !== 'string' || !Number.isFinite(Date.parse(sort[0])) || new Date(sort[0]).toISOString() !== sort[0] || !['call', 'put'].includes(String(sort[1])) || typeof sort[2] !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(sort[2]) || typeof sort[3] !== 'string' || !/^[0-9a-f-]{36}$/i.test(sort[3]) || sort[3] !== after.id)) throw badRequest('INVALID_CURSOR', 'The option pagination cursor is invalid.');
    const items = [] as Row[],
      visibleRows: Row[] = [];
    let hasMore = false;
    while (items.length <= count) {
      const result = await this.pool.query(`SELECT i.id,i.asset,i.vendor,i.vendor_id,i.underlying_id,i.venue,i.currency,i.enabled,m.version,m.multiplier,m.tick_size,m.strike,m.expiry,m.root,m.contract_month,m.contract_year,m.option_type,m.adjusted,m.session,m.source_id,
      COALESCE((SELECT pm.dataset FROM provider_instrument_mapping pm WHERE pm.instrument_id=i.id AND pm.metadata_version=m.version AND pm.supplier=i.vendor AND pm.effective_at<=now() AND (pm.revoked_at IS NULL OR pm.revoked_at>now()) ORDER BY pm.effective_at DESC LIMIT 1),i.asset) AS provider_dataset
      FROM instrument i JOIN instrument_metadata_version m ON m.instrument_id=i.id AND m.version=(SELECT MAX(mx.version) FROM instrument_metadata_version mx WHERE mx.instrument_id=i.id)
      WHERE i.asset='option' AND i.underlying_id=$1 AND ($2::timestamptz IS NULL OR m.expiry=$2) AND ($3::text IS NULL OR m.option_type=$3)
      AND ($4::timestamptz IS NULL OR (m.expiry,m.option_type,m.strike,i.id)>($4,$5,$6::numeric,$7::uuid))
      ORDER BY m.expiry,m.option_type,m.strike,i.id LIMIT 100`, [underlyingId, date, String(optionType ?? '') || null, sort?.[0] ?? null, sort?.[1] ?? null, sort?.[2] ?? null, sort?.[3] ?? null]);
      if (!result.rows.length) break;
      for (const row of result.rows) {
        sort = [iso(row.expiry), row.option_type, String(row.strike), row.id];
        const caps = await this.caps(row, audience, 'display');
        if (!(audience === 'public' ? caps.displayPublic : caps.displayMember)) continue;
        const provider = await this.displayEnvelope(row, audience);
        items.push(this.mapSummary(row, await this.effectiveCapabilities(row, audience), provider));
        visibleRows.push(row);
        if (items.length > count) {
          hasMore = true;
          break;
        }
      }
      if (hasMore || result.rows.length < 100) break;
    }
    const visible = items.slice(0, count),
      last = visibleRows[count - 1];
    return {
      items: visible,
      nextCursor: hasMore && last ? cursorEncode({
        sort: [iso(last.expiry), last.option_type, String(last.strike), last.id],
        id: last.id
      }) : null
    };
  }
  async futuresContracts(rootInput: unknown, contractMonth: unknown, cursor: unknown, limit: unknown, audience: MarketAudience) {
    const rootInputValue = rootInput === undefined ? null : String(rootInput);
    if (rootInputValue !== null && !['ES', 'MES', 'NQ', 'MNQ'].includes(rootInputValue)) throw badRequest('INVALID_FUTURES_ROOT', 'Supported futures roots are ES, MES, NQ, and MNQ.');
    const root = rootInputValue;
    const month = contractMonth === undefined ? null : String(contractMonth);
    if (month !== null && !/^\d{4}-(03|06|09|12)$/.test(month)) throw badRequest('INVALID_CONTRACT_MONTH', 'Futures contract month must be a quarterly YYYY-MM month.');
    const count = limitValue(limit),
      after = cursorDecode(typeof cursor === 'string' ? cursor : undefined);
    let sort = after?.sort;
    if (after && (!sort || sort.length !== 4 || !['ES', 'MES', 'NQ', 'MNQ'].includes(String(sort[0])) || !Number.isInteger(Number(sort[1])) || Number(sort[1]) < 1900 || Number(sort[1]) > 9999 || !Number.isInteger(Number(sort[2])) || ![3, 6, 9, 12].includes(Number(sort[2])) || typeof sort[3] !== 'string' || !/^[0-9a-f-]{36}$/i.test(sort[3]) || sort[3] !== after.id)) throw badRequest('INVALID_CURSOR', 'The futures pagination cursor is invalid.');
    const items = [] as Row[],
      visibleRows: Row[] = [];
    let hasMore = false;
    while (items.length <= count) {
      const result = await this.pool.query(`SELECT i.id,i.asset,i.vendor,i.vendor_id,i.underlying_id,i.venue,i.currency,i.enabled,m.version,m.multiplier,m.tick_size,m.strike,m.expiry,m.root,m.contract_month,m.contract_year,m.option_type,m.adjusted,m.session,m.source_id,COALESCE((SELECT pm.dataset FROM provider_instrument_mapping pm WHERE pm.instrument_id=i.id AND pm.metadata_version=m.version AND pm.supplier=i.vendor AND pm.effective_at<=now() AND (pm.revoked_at IS NULL OR pm.revoked_at>now()) ORDER BY pm.effective_at DESC LIMIT 1),i.asset) AS provider_dataset FROM instrument i JOIN instrument_metadata_version m ON m.instrument_id=i.id AND m.version=(SELECT MAX(mx.version) FROM instrument_metadata_version mx WHERE mx.instrument_id=i.id) WHERE i.asset='future' AND ($1::text IS NULL OR m.root=$1) AND ($2::text IS NULL OR (m.contract_year::text||'-'||LPAD(m.contract_month::text,2,'0'))=$2) AND ($3::text IS NULL OR (m.root,m.contract_year,m.contract_month,i.id)>($3,$4::int,$5::int,$6::uuid)) ORDER BY m.root,m.contract_year,m.contract_month,i.id LIMIT 100`, [root, month, sort?.[0] ?? null, sort?.[1] ?? null, sort?.[2] ?? null, sort?.[3] ?? null]);
      if (!result.rows.length) break;
      for (const row of result.rows) {
        sort = [row.root, row.contract_year, row.contract_month, row.id];
        const caps = await this.caps(row, audience, 'display');
        if (!(audience === 'public' ? caps.displayPublic : caps.displayMember)) continue;
        const provider = await this.displayEnvelope(row, audience);
        items.push(this.mapSummary(row, await this.effectiveCapabilities(row, audience), provider));
        visibleRows.push(row);
        if (items.length > count) {
          hasMore = true;
          break;
        }
      }
      if (hasMore || result.rows.length < 100) break;
    }
    const visible = items.slice(0, count),
      last = visibleRows[count - 1];
    return {
      items: visible,
      nextCursor: hasMore && last ? cursorEncode({
        sort: [last.root, last.contract_year, last.contract_month, last.id],
        id: last.id
      }) : null
    };
  }
  async calendar(venue: unknown, from: unknown, to: unknown, cursor: unknown, limit: unknown, audience: MarketAudience) {
    const v = String(venue ?? '');
    const f = String(from ?? ''),
      t = String(to ?? '');
    if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t) || t < f) throw badRequest('INVALID_CALENDAR_RANGE', 'Calendar requires venue and an inclusive increasing ISO date range.');
    try {
      const envelope = await this.provider.getCalendar({
        venue: v,
        from: f,
        to: t,
        ...(typeof cursor === 'string' ? {
          cursor
        } : {}),
        limit: limitValue(limit)
      });
      const rows = await this.capRows(),
        supplier = this.mode === 'synthetic' ? 'synthetic-fixture' : 'databento',
        grant = latestCaps(rows, supplier, 'calendar', audience, 'display'),
        caps = intersect(grant, envelope.capabilities);
      if (!(audience === 'public' ? caps.displayPublic : caps.displayMember)) throw new CommandError(403, 'DATA_DISPLAY_NOT_LICENSED', 'Calendar reference data is not licensed for this audience.');
      return {
        items: envelope.data.items.map(item => ({ venue: v, ...item })),
        nextCursor: envelope.data.nextCursor,
        meta: responseMeta(envelope.providerReference, envelope.metadataVersion, caps, supplier, envelope.freshness, envelope.delaySeconds, envelope.asOf)
      };
    } catch (e) {
      if (e instanceof CommandError) throw e;
      if (e instanceof RangeError) throw badRequest('INVALID_CALENDAR_RANGE', e.message);
      throw failProvider();
    }
  }
  private async providerInstrument(id: string, queryable: Queryable = this.pool) {
    const r = await this.row(id, undefined, queryable);
    return {
      row: r,
      providerId: this.providerId(r)
    };
  }
  private async assertDisplayAndCapabilities(row: Row, audience: MarketAudience, purpose: MarketPurpose) {
    const display = await this.visible(row, audience),
      market = await this.caps(row, audience, purpose);
    return intersect(display, market);
  }
  async quote(id: string, audience: MarketAudience) {
    const {
      row,
      providerId
    } = await this.providerInstrument(id);
    const caps = await this.effectiveCapabilities(row, audience);
    if (!(audience === 'public' ? caps.displayPublic : caps.displayMember)) throw new CommandError(403, 'DATA_DISPLAY_NOT_LICENSED', 'Quote snapshots are not licensed for this audience.');
    if (!caps.retainSnapshot) throw new CommandError(403, 'DATA_SNAPSHOT_NOT_LICENSED', 'Quote snapshots are not licensed for this audience.');
    try {
      const data = await this.provider.getQuoteSnapshot(providerId);
      const effective = intersect(caps, data.capabilities);
      if (!(audience === 'public' ? effective.displayPublic : effective.displayMember) || !effective.retainSnapshot) throw new CommandError(403, 'DATA_DISPLAY_NOT_LICENSED', 'Quote snapshots are not licensed for this audience.');
      return {
        instrumentId: id,
        bid: data.data.bid,
        ask: data.data.ask,
        last: data.data.last,
        meta: responseMeta(data.providerReference, row.version, effective, row.vendor, data.freshness, data.delaySeconds, data.asOf ?? undefined)
      };
    } catch (e) {
      if (e instanceof CommandError) throw e;
      throw failProvider();
    }
  }
  async bars(id: string, query: Row, audience: MarketAudience, queryable: Queryable = this.pool) {
    const {
        row,
        providerId
      } = await this.providerInstrument(id, queryable),
      caps = await this.effectiveCapabilities(row, audience, queryable);
    if (!(audience === 'public' ? caps.displayPublic : caps.displayMember)) throw new CommandError(403, 'DATA_DISPLAY_NOT_LICENSED', 'Bars are not licensed for this audience.');
    if (row.asset === 'option') throw badRequest('OPTION_PREMIUM_HISTORY_UNSUPPORTED', 'Historical option-premium bars are not available in Phase 1.');
    if (!caps.retainBars) throw new CommandError(403, 'DATA_BARS_NOT_LICENSED', 'Historical bars are not licensed for this audience.');
    const interval = String(query.interval ?? ''),
      session = String(query.session ?? (row.asset === 'future' ? 'exchange' : 'regular'));
    const rangeError = barRangeError(interval, String(query.from ?? ''), String(query.to ?? ''));
    if (rangeError) throw badRequest('INVALID_BARS_QUERY', rangeError);
    const cursorError = barCursorError(query.cursor, String(query.from), String(query.to));
    if (cursorError) throw badRequest('INVALID_CURSOR', cursorError);
    if ((row.asset === 'stock' && session !== 'regular') || (row.asset === 'future' && session !== 'exchange')) throw badRequest('UNSUPPORTED_SESSION', row.asset === 'stock' ? 'Stocks support regular-session bars only.' : 'Futures support exchange-session bars only.');
    if (query.adjustment !== undefined && query.adjustment !== 'unadjusted') throw badRequest('UNSUPPORTED_ADJUSTMENT', 'Only unadjusted market bars are currently supported.');
    try {
      const providerSession = row.asset === 'future' ? 'all' : 'regular';
      const data = await this.provider.getBars({
        instrumentId: providerId,
        venue: String(row.venue),
        interval: interval as any,
        from: String(query.from),
        to: String(query.to),
        session: providerSession,
        adjustment: 'raw',
        ...(typeof query.cursor === 'string' ? {
          cursor: query.cursor
        } : {}),
        limit: barsLimitValue(query.limit)
      });
      if (data.metadataVersion !== row.version) throw failProvider();
      const effective = intersect(caps, data.capabilities);
      if (!(audience === 'public' ? effective.displayPublic : effective.displayMember) || !effective.retainBars) throw new CommandError(403, 'DATA_BARS_NOT_LICENSED', 'Historical bars are not licensed for this audience.');
      return {
        instrumentId: id,
        interval,
        session,
        adjustment: 'unadjusted',
        meta: responseMeta(data.providerReference, row.version, effective, row.vendor, data.freshness, data.delaySeconds, data.asOf),
        bars: data.data.items,
        nextCursor: data.data.nextCursor
      };
    } catch (e) {
      if (e instanceof CommandError) throw e;
      if (e instanceof RangeError) throw badRequest('INVALID_BARS_QUERY', e.message);
      throw failProvider();
    }
  }
  async validateStrategy(body: Row, audience: MarketAudience) {
    const strategy = String(body.strategy ?? '');
    if (!['long_call', 'long_put', 'bull_call_debit', 'bear_put_debit', 'bull_put_credit', 'bear_call_credit'].includes(strategy)) throw badRequest('INVALID_OPTION_STRATEGY', 'Choose a supported option strategy.');
    const underlying = await this.row(String(body.underlyingInstrumentId ?? ''));
    if (underlying.asset !== 'stock') throw new CommandError(422, 'INVALID_OPTION_UNDERLYING', 'Options require a supported stock or ETF underlying.');
    const ids = Array.isArray(body.optionContractIds) ? body.optionContractIds.map(String) : [];
    const count = Number(body.quantity);
    const issues: {
      code: string;
      message: string;
    }[] = [];
    const add = (code: string, message: string) => {
      if (!issues.some(x => x.code === code)) issues.push({
        code,
        message
      });
    };
    if (new Set(ids).size !== ids.length) add('duplicate_contract', 'An option contract cannot be selected more than once.');
    const result = ids.length ? await this.pool.query(`SELECT i.id,i.vendor,i.vendor_id,i.underlying_id,i.enabled,m.version,m.multiplier,m.strike,m.expiry,m.option_type,m.adjusted,
      COALESCE((SELECT pm.dataset FROM provider_instrument_mapping pm WHERE pm.instrument_id=i.id AND pm.metadata_version=m.version AND pm.supplier=i.vendor AND pm.effective_at<=now() AND (pm.revoked_at IS NULL OR pm.revoked_at>now()) ORDER BY pm.effective_at DESC LIMIT 1),i.asset) AS provider_dataset
      FROM instrument i JOIN instrument_metadata_version m ON m.instrument_id=i.id AND m.version=(SELECT MAX(x.version) FROM instrument_metadata_version x WHERE x.instrument_id=i.id) WHERE i.id=ANY($1::uuid[]) AND i.asset='option'`, [ids]) : {
      rows: []
    };
    const byId = new Map(result.rows.map((r: Row) => [r.id, r]));
    if (result.rows.length !== ids.length) add('contract_id', 'Every option leg must identify an actual listed contract.');
    const contractRows = ids.map(id => byId.get(id)).filter((r): r is Row => Boolean(r));
    const displayCaps = await this.effectiveCapabilities(underlying, audience);
    let canPublish = Boolean(underlying.enabled && displayCaps.newPublishing && displayCaps.retainSnapshot && displayCaps.retainBars && (audience === 'public' ? displayCaps.displayPublic : displayCaps.displayMember));
    if (!underlying.enabled) add('instrument_disabled', 'Underlying is disabled for new publishing.');
    if (!canPublish) add('data_capability', 'Current underlying data rights do not permit new publishing.');
    const selectionLegs: OptionStrategySelection['legs'] = [];
    let freshness: 'fresh' | 'stale' | 'missing' | 'unavailable' = 'fresh';
    let delaySeconds = 0;
    let quoteAsOf: string | null = null;
    let sourceReference = `catalog:${underlying.vendor}:${underlying.vendor_id}`;
    const requestedLegs = Array.isArray(body.legs) ? body.legs as Row[] : [];
    if (requestedLegs.length !== ids.length) add('leg_count', 'Provide one side and quantity for every selected contract.');
    for (let index = 0; index < ids.length; index++) {
      const row = byId.get(ids[index]!);
      if (!row) continue;
      const leg = requestedLegs[index] ?? {};
      if (row.underlying_id !== underlying.id) add('contract_underlying', 'Every contract must use the selected underlying.');
      if (!row.enabled) add('instrument_disabled', 'An option contract is disabled for new publishing.');
      if (!row.expiry || new Date(row.expiry).getTime() <= Date.now()) add('contract_expired', 'Expired option contracts cannot be newly published.');
      const effective = await this.effectiveCapabilities(row, audience);
      if (!effective.newPublishing || !effective.retainSnapshot || !(audience === 'public' ? effective.displayPublic : effective.displayMember)) {
        canPublish = false;
        add('data_capability', 'Current contract data rights do not permit new publishing.');
      }
      const contract = {
        id: row.id,
        symbol: row.vendor_id,
        underlyingId: row.underlying_id,
        expiration: iso(row.expiry) ?? '',
        strike: String(row.strike),
        right: row.option_type,
        multiplier: String(row.multiplier),
        adjusted: Boolean(row.adjusted),
        metadataVersion: row.version,
        source: row.vendor
      };
      let quote: MarketDataEnvelope<{
        instrumentId: string;
        bid: string | null;
        ask: string | null;
        last: string | null;
        bidSize: string | null;
        askSize: string | null;
        marketSession: 'open' | 'closed' | 'unknown';
      }> | undefined;
      const snapshotCaps = await this.caps(row, audience, 'snapshot');
      if (!snapshotCaps.retainSnapshot) {
        add('data_capability', 'Option quote snapshots are not licensed for this audience.');
        canPublish = false;
        continue;
      }
      try {
        quote = (await this.provider.getQuoteSnapshot(row.id)) as typeof quote;
      } catch {}
      const premium = quote ? leg.side === 'long' ? quote.data.ask : leg.side === 'short' ? quote.data.bid : null : null;
      if (!quote || !premium || quote.freshness !== 'fresh' || !(audience === 'public' ? quote.capabilities.displayPublic : quote.capabilities.displayMember) || !quote.capabilities.retainSnapshot) {
        add('quote_unavailable', 'A fresh licensed option premium is unavailable for one or more legs.');
        freshness = quote?.freshness ?? 'unavailable';
        canPublish = false;
        continue;
      }
      delaySeconds = Math.max(delaySeconds, quote.delaySeconds);
      sourceReference = quote.providerReference;
      if (quote.asOf && (!quoteAsOf || Date.parse(quote.asOf) < Date.parse(quoteAsOf))) quoteAsOf = quote.asOf;
      selectionLegs.push({
        contract,
        side: String(leg.side) as 'long' | 'short',
        quantity: Number(leg.quantity),
        premium
      });
    }
    let validation: {
      valid: boolean;
      issues: {
        code: string;
        message: string;
      }[];
      netPrice: string | null;
      netKind: 'debit' | 'credit' | null;
    } = {
      valid: false,
      issues,
      netPrice: null,
      netKind: null
    };
    if (selectionLegs.length === ids.length && result.rows.length === ids.length) {
      validation = validateOptionStrategy({
        strategy: strategy as OptionStrategySelection['strategy'],
        underlyingId: underlying.id,
        quantity: count,
        legs: selectionLegs
      }, contractRows.map((r: Row) => ({
        id: r.id,
        symbol: r.vendor_id,
        underlyingId: r.underlying_id,
        expiration: iso(r.expiry) ?? '',
        strike: String(r.strike),
        right: r.option_type,
        multiplier: String(r.multiplier),
        adjusted: Boolean(r.adjusted),
        metadataVersion: r.version,
        source: r.vendor
      })));
      for (const issue of validation.issues) add(issue.code, issue.message);
    }
    if (contractRows.length === ids.length && ids.length) {
      const to = iso(contractRows[0]?.expiry)?.slice(0, 10) ?? '',
        from = new Date().toISOString().slice(0, 10),
        calendarSupplier = this.mode === 'synthetic' ? 'synthetic-fixture' : 'databento',
        calendarRows = await this.capRows(),
        calendarGrant = latestCaps(calendarRows, calendarSupplier, 'calendar', audience, 'display');
      try {
        const calendar = await this.provider.getCalendar({
          venue: calendarVenue(underlying),
          from,
          to,
          limit: 100
        });
        const licensed = intersect(calendarGrant, calendar.capabilities);
        if (calendar.freshness !== 'fresh' || !(audience === 'public' ? licensed.displayPublic : licensed.displayMember) || calendar.data.items.some(x => !x.authoritative && this.mode !== 'synthetic')) {
          canPublish = false;
          add('calendar_unavailable', 'Current licensed exchange calendar data is unavailable.');
        }
      } catch {
        canPublish = false;
        add('calendar_unavailable', 'Current licensed exchange calendar data is unavailable.');
      }
    }
    const valid = validation.valid && canPublish && issues.length === 0;
    return {
      valid,
      strategy,
      underlyingInstrumentId: underlying.id,
      optionContractIds: ids,
      netPrice: valid ? validation.netPrice : null,
      netKind: valid ? validation.netKind : null,
      validationIssues: issues,
      meta: responseMeta(sourceReference, underlying.version, displayCaps, underlying.vendor, freshness, delaySeconds, quoteAsOf)
    };
  }
  async adminList(query: string, assetClass: unknown, cursor: unknown, limit: unknown) {
    const q = String(query ?? '').trim();
    const asset = assetValue(assetClass);
    const count = limitValue(limit);
    const after = cursorDecode(typeof cursor === 'string' ? cursor : undefined);
    if (after?.sort) throw badRequest('INVALID_CURSOR', 'The pagination cursor does not match this endpoint.');
    const result = await this.pool.query(`SELECT i.id,i.asset,i.vendor,i.vendor_id,i.underlying_id,i.venue,i.currency,i.enabled,m.version,m.multiplier,m.tick_size,m.strike,m.expiry,m.root,m.contract_month,m.contract_year,m.option_type,m.adjusted,m.session,m.source_id,COALESCE((SELECT pm.dataset FROM provider_instrument_mapping pm WHERE pm.instrument_id=i.id AND pm.metadata_version=m.version AND pm.supplier=i.vendor AND pm.effective_at<=now() AND (pm.revoked_at IS NULL OR pm.revoked_at>now()) ORDER BY pm.effective_at DESC LIMIT 1),i.asset) AS provider_dataset FROM instrument i JOIN instrument_metadata_version m ON m.instrument_id=i.id AND m.version=(SELECT MAX(mx.version) FROM instrument_metadata_version mx WHERE mx.instrument_id=i.id) WHERE ($1::text IS NULL OR i.asset=$1) AND ($2='' OR i.vendor_id ILIKE '%'||$2||'%') AND ($3::text IS NULL OR (i.vendor_id,i.id)>($3,$4::uuid)) ORDER BY i.vendor_id,i.id LIMIT $5`, [asset ?? null, q, after?.symbol ?? null, after?.id ?? null, count + 1]);
    const rows = result.rows.slice(0, count);
    const items = rows.map(r => this.mapDetail(r));
    const last = rows.at(-1);
    return {
      items,
      nextCursor: result.rows.length > count && last ? cursorEncode({
        symbol: last.vendor_id,
        id: last.id
      }) : null
    };
  }
  async adminData() {
    const grants = (await this.pool.query('SELECT supplier,agreement_id,dataset,audience,purpose,effective_at,revoked_at,flags FROM data_capability ORDER BY supplier,dataset,audience,purpose,effective_at DESC')).rows as Row[];
    const now = Date.now(),
      active = grants.filter(r => new Date(r.effective_at).getTime() <= now && (!r.revoked_at || new Date(r.revoked_at).getTime() > now));
    let mapped: Array<{
      asset: string;
      dataset: string;
      supplier: string;
      instrument_id: string;
    }>;
    if (this.mode === 'databento') mapped = (await this.pool.query(`SELECT DISTINCT ON(i.asset,p.dataset) i.asset,p.dataset,p.supplier,p.instrument_id FROM provider_instrument_mapping p JOIN instrument i ON i.id=p.instrument_id JOIN instrument_metadata_version m ON m.instrument_id=i.id AND m.version=p.metadata_version WHERE p.supplier='databento' AND p.effective_at<=now() AND (p.revoked_at IS NULL OR p.revoked_at>now()) AND m.version=(SELECT MAX(mx.version) FROM instrument_metadata_version mx WHERE mx.instrument_id=i.id) ORDER BY i.asset,p.dataset,i.id`)).rows;else mapped = (await this.pool.query(`SELECT DISTINCT ON(i.asset) i.asset,i.asset AS dataset,i.vendor AS supplier,i.id AS instrument_id FROM instrument i JOIN instrument_metadata_version m ON m.instrument_id=i.id AND m.version=(SELECT MAX(mx.version) FROM instrument_metadata_version mx WHERE mx.instrument_id=i.id) WHERE i.vendor ILIKE '%synthetic%' ORDER BY i.asset,i.id`)).rows;
    const items: Row[] = [];
    for (const map of mapped) {
      const rows = active.filter(r => r.supplier === map.supplier && r.dataset === map.dataset && !/^synthetic|placeholder|fixture|test$/i.test(String(r.agreement_id)));
      const allRows = active.filter(r => r.supplier === map.supplier && r.dataset === map.dataset);
      const capabilityList = allRows.map(r => ({
        audience: r.audience,
        purpose: r.purpose,
        ...capFlags(r.flags)
      }));
      const required: [string, string, string][] = [];
      for (const audience of ['public', 'member']) {
        required.push([audience, 'display', audience === 'public' ? 'displayPublic' : 'displayMember'], [audience, 'snapshot', 'retainSnapshot'], [audience, 'publishing', 'newPublishing']);
        if (map.asset !== 'option') required.push([audience, 'chart', 'retainBars']);
      }
      const licensed = rows.length > 0 && required.every(([audience, purpose, flag]) => latestCaps(rows, map.supplier, map.dataset, audience as MarketAudience, purpose as MarketPurpose)[flag as keyof Caps] === true);
      let freshness: 'fresh' | 'stale' | 'missing' | 'unavailable' = 'unavailable',
        asOf: string | null = null,
        delaySeconds = 0,
        providerReference: string | null = null;
      try {
        const quote = await this.provider.getQuoteSnapshot(map.instrument_id);
        freshness = quote.freshness;
        asOf = quote.asOf;
        delaySeconds = quote.delaySeconds;
        providerReference = quote.providerReference;
      } catch {}
      const agreement = rows[0]?.agreement_id ?? null;
      items.push({
        provider: this.mode === 'synthetic' ? 'Demo data (synthetic)' : 'Databento',
        status: freshness === 'fresh' ? 'healthy' : freshness === 'stale' ? 'stale' : 'unavailable',
        freshness,
        asOf,
        delaySeconds,
        providerReference,
        licensed,
        asset: map.asset,
        dataset: map.dataset,
        agreementId: agreement,
        capabilities: capabilityList
      });
    }
    // Calendar rights and feed health are reported independently of the market datasets.
    const calendarRows = active.filter(r => r.supplier === (this.mode === 'synthetic' ? 'synthetic-fixture' : 'databento') && r.dataset === 'calendar' && !/^synthetic|placeholder|fixture|test$/i.test(String(r.agreement_id)));
    const calendarCaps = calendarRows.map(r => ({
        audience: r.audience,
        purpose: r.purpose,
        ...capFlags(r.flags)
      })),
      calendarLicensed = calendarRows.length > 0 && ['public', 'member'].every(a => latestCaps(calendarRows, this.mode === 'synthetic' ? 'synthetic-fixture' : 'databento', 'calendar', a as MarketAudience, 'display')[a === 'public' ? 'displayPublic' : 'displayMember']);
    let calendarFreshness: 'fresh' | 'stale' | 'missing' | 'unavailable' = 'unavailable',
      calendarAsOf: string | null = null,
      calendarDelay = 0,
      calendarReference: string | null = null;
    try {
      const result = await this.provider.getCalendar({
        venue: this.mode === 'synthetic' ? 'NYSE' : 'CME_GLOBEX',
        from: new Date().toISOString().slice(0, 10),
        to: new Date().toISOString().slice(0, 10),
        limit: 1
      });
      calendarFreshness = result.freshness;
      calendarAsOf = result.asOf;
      calendarDelay = result.delaySeconds;
      calendarReference = result.providerReference;
    } catch {}
    const calendarStatus = calendarFreshness === 'fresh' ? 'healthy' : calendarFreshness === 'stale' ? 'stale' : 'unavailable';
    items.push({
      provider: this.mode === 'synthetic' ? 'Demo data (synthetic)' : 'Exchange calendar',
      status: calendarStatus,
      freshness: calendarFreshness,
      asOf: calendarAsOf,
      delaySeconds: calendarDelay,
      providerReference: calendarReference,
      licensed: calendarLicensed,
      asset: 'calendar',
      dataset: 'calendar',
      agreementId: calendarRows.find(r => !/^synthetic|placeholder|fixture|test$/i.test(String(r.agreement_id)))?.agreement_id ?? null,
      capabilities: calendarCaps
    });
    return {
      items,
      configured: this.configured,
      productionReady: this.mode === 'databento' && this.configured && items.length >= 4 && items.every(x => x.licensed && x.freshness === 'fresh')
    };
  }
  async adminAction(actor: Actor, id: string, action: unknown, reason: unknown, idempotencyKey: unknown): Promise<Row> {
    if (!['enable', 'disable'].includes(String(action))) throw badRequest('INVALID_INSTRUMENT_ACTION', 'Unsupported instrument action.');
    const safeReason = String(reason ?? '').trim();
    if (safeReason.length < 1 || safeReason.length > 2000) throw new CommandError(422, 'REASON_REQUIRED', 'Provide an administrative reason.');
    const key = String(idempotencyKey ?? '');
    if (!/^[A-Za-z0-9._:-]{16,200}$/.test(key)) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required.');
    const operation = `POST:/admin/instruments/${id}/actions`,
      input = {
        id,
        action: String(action),
        reason: safeReason
      };
    const result = await executeIdempotentCommand(this.pool, {
      actorUserId: actor.userId,
      operation,
      idempotencyKey: key,
      input: input as Json
    }, async tx => {
      const locked = await tx.query<{
        id: string;
      }>('SELECT id FROM instrument WHERE id=$1 FOR UPDATE', [id]);
      if (!locked.rows[0]) throw new CommandError(404, 'INSTRUMENT_NOT_FOUND', 'The instrument was not found.');
      const enabled = action === 'enable';
      await tx.query('UPDATE instrument SET enabled=$2 WHERE id=$1', [id, enabled]);
      const auditId = randomUUID();
      await tx.query(`INSERT INTO audit_event(id,actor,resource_type,resource_id,action,reason,metadata) VALUES($1,$2,'instrument',$3,$4,$5,$6)`, [auditId, actor.userId, id, String(action), safeReason, {
        enabled
      }]);
      const response = {
        id: auditId,
        actorId: actor.userId,
        action: String(action),
        resourceType: 'instrument',
        resourceId: id,
        reason: safeReason,
        createdAt: new Date().toISOString()
      };
      return {
        status: 201,
        body: response,
        resourceId: id
      };
    });
    return result.body as Row;
  }
}
