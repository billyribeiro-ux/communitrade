import type { Pool } from 'pg';
import { DatabentoMarketDataAdapter, SyntheticMarketDataAdapter, type AssetClass, type BarInterval, type CalendarQuery, type CalendarSession, type Instrument, type MarketCapabilities, type MarketDataEnvelope, type OptionContract } from '@trading/domain';
type Env = Readonly<Record<string, string | undefined>>;
type Row = Record<string, any>;
export interface MarketDataRuntime {
  adapter: DatabentoMarketDataAdapter | SyntheticMarketDataAdapter;
  mode: 'synthetic' | 'databento';
  configured: boolean;
}
const assets: AssetClass[] = ['stock', 'option', 'future'];
const capKeys: (keyof MarketCapabilities)[] = ['displayPublic', 'displayMember', 'retainBars', 'retainSnapshot', 'exportImage', 'exportPersonalRecord', 'newPublishing'];
const json = (env: Env, name: string): any => {
  try {
    return JSON.parse(env[name] ?? '');
  } catch {
    throw new Error(`${name} must contain valid JSON.`);
  }
};
const validCaps = (value: unknown): value is MarketCapabilities => !!value && typeof value === 'object' && !Array.isArray(value) && capKeys.every(key => typeof (value as Record<string, unknown>)[key] === 'boolean');
const iso = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) && v.endsWith('Z');
function calendarPort(raw: unknown) {
  const input = raw as {
    provider?: unknown;
    asOf?: unknown;
    delaySeconds?: unknown;
    validFrom?: unknown;
    validThrough?: unknown;
    validUntil?: unknown;
    sessions?: unknown;
  };
  if (!input || typeof input.provider !== 'string' || !input.provider.trim() || /demo|synthetic|fixture|test/i.test(input.provider) || !iso(input.asOf) || Date.parse(String(input.asOf)) > Date.now() || !iso(input.validUntil) || !/^\d{4}-\d{2}-\d{2}$/.test(String(input.validFrom)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(input.validThrough)) || String(input.validThrough) < String(input.validFrom) || !Number.isInteger(input.delaySeconds) || Number(input.delaySeconds) < 0 || !Array.isArray(input.sessions) || input.sessions.length === 0) throw new Error('DATABENTO_CALENDAR_CONFIG must contain a verified provider, UTC asOf, validFrom/validThrough/validUntil, delaySeconds, and calendar sessions.');
  const sessions = input.sessions as (CalendarSession & {
    venue: string;
  })[];
  const sessionKeys = new Set<string>();
  for (const session of sessions) {
    const key = `${session.venue}:${session.tradingDate}`;
    if (!session.venue || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(session.tradingDate) || session.tradingDate < String(input.validFrom) || session.tradingDate > String(input.validThrough) || !iso(session.open) || !iso(session.close) || Date.parse(session.open) >= Date.parse(session.close) || typeof session.timezone !== 'string' || !session.timezone || !['open', 'closed', 'early_close'].includes(session.status) || session.authoritative !== true || sessionKeys.has(key)) throw new Error('DATABENTO_CALENDAR_CONFIG contains an invalid or non-authoritative session.');
    sessionKeys.add(key);
  }
  const timestamp = String(input.asOf),
    delay = Number(input.delaySeconds),
    caps: MarketCapabilities = {
      displayPublic: true,
      displayMember: true,
      retainBars: false,
      retainSnapshot: false,
      exportImage: false,
      exportPersonalRecord: false,
      newPublishing: false
    };
  return {
    getCalendar: async (query: CalendarQuery): Promise<MarketDataEnvelope<{
      items: CalendarSession[];
      nextCursor: string | null;
    }>> => {
      if (query.to < query.from || Date.parse(`${query.to}T00:00:00Z`) - Date.parse(`${query.from}T00:00:00Z`) > 366 * 86400000) throw new RangeError('Calendar range is invalid or exceeds one year.');
      const limit = query.limit ?? 50,
        offset = query.cursor === undefined ? 0 : Number(query.cursor);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new RangeError('Calendar pagination is invalid.');
      const filtered = sessions.filter(x => x.venue.toLowerCase() === query.venue.toLowerCase() && x.tradingDate >= query.from && x.tradingDate <= query.to).sort((a, b) => a.tradingDate.localeCompare(b.tradingDate));
      const items = filtered.slice(offset, offset + limit),
        covered = query.from >= String(input.validFrom) && query.to <= String(input.validThrough),
        known = new Set(filtered.map(x => x.tradingDate));
      let holes = false;
      for (let day = Date.parse(`${query.from}T00:00:00Z`); day <= Date.parse(`${query.to}T00:00:00Z`); day += 86400000) if (!known.has(new Date(day).toISOString().slice(0, 10))) holes = true;
      const freshness = !covered || holes ? 'missing' : Date.now() > Date.parse(String(input.validUntil)) ? 'stale' : 'fresh';
      return {
        data: {
          items,
          nextCursor: offset + items.length < filtered.length ? String(offset + items.length) : null
        },
        providerReference: `${input.provider}:exchange-calendar`,
        asOf: timestamp,
        delaySeconds: delay,
        freshness,
        metadataVersion: 1,
        capabilities: caps,
        demo: false
      };
    }
  };
}
async function syntheticAdapter(pool: Pool) {
  const result = await pool.query(`SELECT i.id,i.vendor_id,i.asset,i.underlying_id,i.venue,i.currency,i.enabled,m.expiry,m.strike,m.option_type,m.multiplier,m.tick_size,m.root,m.contract_month,m.contract_year,m.adjusted,m.session,m.version FROM instrument i JOIN instrument_metadata_version m ON m.instrument_id=i.id AND m.version=(SELECT MAX(x.version) FROM instrument_metadata_version x WHERE x.instrument_id=i.id) WHERE i.vendor='synthetic-fixture' ORDER BY i.asset,i.vendor_id`);
  const instrumentIds: Record<string, string> = {};
  const instruments: Instrument[] = [];
  const options: OptionContract[] = [];
  for (const row of result.rows as Row[]) {
    if (row.asset === 'stock' || row.asset === 'future') {
      instrumentIds[row.vendor_id] = row.id;
      const contractMonth = row.asset === 'future' && row.contract_year !== null && row.contract_month !== null ? `${row.contract_year}-${String(row.contract_month).padStart(2, '0')}` : undefined;
      instruments.push({
        id: row.id,
        symbol: row.vendor_id,
        name: row.vendor_id,
        assetClass: row.asset,
        exchange: row.venue,
        currency: row.currency,
        isEnabledForNewPublishing: Boolean(row.enabled),
        metadataVersion: row.version,
        source: 'Demo data',
        ...(row.multiplier !== null ? { multiplier: String(row.multiplier) } : {}),
        ...(row.tick_size !== null ? { tickSize: String(row.tick_size) } : {}),
        ...(typeof row.session === 'string' ? { session: row.session } : row.session && typeof row.session.label === 'string' ? { session: row.session.label } : {}),
        ...(row.asset === 'future' && row.root ? { root: row.root } : {}),
        ...(contractMonth ? { contractMonth } : {}),
        ...(row.expiry ? { expiration: new Date(row.expiry).toISOString() } : {})
      } as Instrument);
    }
    if (row.asset === 'option') options.push({
      id: row.id,
      symbol: row.vendor_id,
      underlyingId: row.underlying_id,
      expiration: new Date(row.expiry).toISOString(),
      strike: String(row.strike),
      right: row.option_type,
      multiplier: String(row.multiplier),
      adjusted: Boolean(row.adjusted),
      metadataVersion: row.version,
      source: 'Demo data'
    });
  }
  return new SyntheticMarketDataAdapter({
    instrumentIds,
    instrumentFixtures: instruments,
    optionContracts: options
  });
}
export async function createMarketDataRuntime(pool: Pool, env: Env): Promise<MarketDataRuntime> {
  const production = env.NODE_ENV === 'production' || ['production', 'public'].includes((env.RELEASE_MODE ?? '').toLowerCase());
  const mode = (env.MARKET_DATA_PROVIDER ?? (production ? '' : 'synthetic')).toLowerCase();
  if (mode === 'synthetic') {
    if (production) throw new Error('Synthetic market data is disabled in public and production releases.');
    return {
      adapter: await syntheticAdapter(pool),
      mode,
      configured: true
    };
  }
  if (mode !== 'databento') throw new Error('MARKET_DATA_PROVIDER must be synthetic or databento.');
  if (production && !env.DATABENTO_API_KEY) throw new Error('DATABENTO_API_KEY is required for a production adapter.');
  const schemas = json(env, 'DATABENTO_SCHEMAS') as Partial<Record<AssetClass, Partial<Record<BarInterval, string>>>>;
  const approvals = json(env, 'DATABENTO_APPROVED_CAPABILITIES') as Partial<Record<AssetClass, MarketCapabilities>>;
  if (assets.some(a => !validCaps(approvals[a]))) throw new Error('DATABENTO_APPROVED_CAPABILITIES must define all seven explicit permissions for stock, option, and future.');
  const delaySeconds = Number(env.DATABENTO_DELAY_SECONDS ?? (production ? '' : '900'));
  if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 86400) throw new Error('DATABENTO_DELAY_SECONDS must be an integer from 1 through 86400.');
  const datasetNames: Record<AssetClass, string | undefined> = {
    stock: env.DATABENTO_STOCK_DATASET,
    option: env.DATABENTO_OPTION_DATASET,
    future: env.DATABENTO_FUTURE_DATASET
  };
  const datasets = Object.fromEntries(assets.map(asset => [asset, {
    dataset: datasetNames[asset] ?? '',
    schemaByInterval: schemas[asset] ?? {},
    metadataVersion: 1,
    capabilities: approvals[asset] ?? {}
  }])) as Record<AssetClass, {
    dataset: string;
    schemaByInterval: Partial<Record<BarInterval, string>>;
    metadataVersion: number;
    capabilities: Partial<MarketCapabilities>;
  }>;
  const expected: Record<BarInterval, string> = {
    '1m': 'ohlcv-1m',
    '5m': 'ohlcv-1m',
    '15m': 'ohlcv-1m',
    '1h': 'ohlcv-1h',
    '1d': 'ohlcv-1d'
  };
  if (assets.some(a => !datasets[a].dataset) || (['stock', 'future'] as AssetClass[]).some(a => Object.keys(expected).some(k => schemas[a]?.[k as BarInterval] !== expected[k as BarInterval])) || Object.keys(schemas.option ?? {}).length > 0) throw new Error('Provider datasets must be configured for stock, option, and future; historical schemas are required only for stock and future P1 bars.');
  const mappings = await pool.query(`SELECT p.instrument_id,p.dataset,p.raw_symbol,p.metadata_version,i.asset FROM provider_instrument_mapping p JOIN instrument i ON i.id=p.instrument_id JOIN instrument_metadata_version m ON m.instrument_id=p.instrument_id AND m.version=p.metadata_version WHERE p.supplier='databento' AND p.effective_at<=now() AND (p.revoked_at IS NULL OR p.revoked_at>now()) AND p.metadata_version=(SELECT MAX(mx.version) FROM instrument_metadata_version mx WHERE mx.instrument_id=p.instrument_id)`);
  const instrumentMap: Record<string, {
    assetClass: AssetClass;
    rawSymbol: string;
    metadataVersion: number;
  }> = {};
  for (const row of mappings.rows as Row[]) {
    if (datasetNames[row.asset as AssetClass] !== row.dataset) continue;
    instrumentMap[row.instrument_id] = {
      assetClass: row.asset,
      rawSymbol: row.raw_symbol,
      metadataVersion: row.metadata_version
    };
  }
  if (production && assets.some(a => !Object.values(instrumentMap).some(x => x.assetClass === a))) throw new Error('Production requires active provider symbol mappings for each supported asset class.');
  const calendar = calendarPort(json(env, 'DATABENTO_CALENDAR_CONFIG'));
  const adapter = new DatabentoMarketDataAdapter({
    ...(env.DATABENTO_API_KEY ? {
      apiKey: env.DATABENTO_API_KEY
    } : {}),
    datasets,
    approvedCapabilities: approvals,
    instrumentMap,
    delaySeconds,
    calendarPort: calendar
  });
  // Validate each configured dataset and capability set without making supplier calls.
  for (const asset of assets) {
    const mapping = Object.entries(instrumentMap).find(([, value]) => value.assetClass === asset);
    if (mapping) await adapter.getCapabilities(mapping[0], 'public', 'display');
  }
  return {
    adapter,
    mode: 'databento',
    configured: Boolean(env.DATABENTO_API_KEY && assets.every(a => Boolean(datasets[a].dataset)) && (['stock', 'future'] as AssetClass[]).every(a => Object.keys(expected).every(k => schemas[a]?.[k as BarInterval] === expected[k as BarInterval])) && assets.every(a => Object.values(instrumentMap).some(x => x.assetClass === a)))
  };
}
void capKeys;
