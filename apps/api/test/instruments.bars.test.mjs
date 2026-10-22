import assert from 'node:assert/strict';
import test from 'node:test';
import { InstrumentService } from '../dist/instruments/service.js';
import { CommandError } from '../dist/http/problem.js';

const stockId = '00000000-0000-4000-8000-000000000201';
const futureId = '00000000-0000-4000-8000-000000000202';
const optionId = '00000000-0000-4000-8000-000000000221';
const flags = (overrides = {}) => ({ displayPublic: true, displayMember: true, retainBars: true, retainSnapshot: true, exportImage: true, exportPersonalRecord: true, newPublishing: true, ...overrides });
const grantRows = (overrides = {}) => ['public', 'member'].flatMap(audience => ['display', 'chart', 'snapshot', 'export', 'personal_record', 'publishing'].map(purpose => ({
  supplier: 'synthetic', dataset: 'stock', audience, purpose, effective_at: new Date(0), revoked_at: null,
  flags: flags(overrides[`${audience}:${purpose}`]),
})));

function service({ asset = 'stock', capabilityOverrides = {}, dataEnvelope, failBars } = {}) {
  const id = asset === 'future' ? futureId : asset === 'option' ? optionId : stockId;
  const row = { id, asset, vendor: 'synthetic', vendor_id: asset === 'stock' ? 'SYN-XYZ' : 'SYN-ESZ26', venue: asset === 'future' ? 'CME_GLOBEX' : 'NYSE', version: 1, provider_dataset: 'stock' };
  const pool = { query: async sql => sql.includes('SELECT i.id,i.asset') ? { rows: [row] } : { rows: grantRows(capabilityOverrides) } };
  const provider = {
    getCapabilities: async (_id, audience, purpose) => {
      const override = capabilityOverrides[`${audience}:${purpose}`] ?? {};
      return { data: flags(override) };
    },
    getBars: async () => {
      if (failBars) throw failBars;
      return dataEnvelope ?? { data: { items: [], nextCursor: null }, providerReference: 'Synthetic Demo data', asOf: null, delaySeconds: 0, freshness: 'missing', metadataVersion: 1, capabilities: flags(), demo: true };
    },
  };
  return { instance: new InstrumentService(pool, provider, 'fixture', true), provider };
}
const query = { interval: '1m', from: '2026-10-20T13:30:00.000Z', to: '2026-10-20T13:35:00.000Z' };

test('bars require both audience display permission and retained-bars permission', async () => {
  const noPublicBars = service({ capabilityOverrides: { 'public:chart': { retainBars: false } } });
  await assert.rejects(() => noPublicBars.instance.bars(stockId, query, 'public'), error => error instanceof CommandError && error.status === 403 && error.code === 'DATA_BARS_NOT_LICENSED');
  const noMemberDisplay = service({ capabilityOverrides: { 'member:display': { displayMember: false } } });
  await assert.rejects(() => noMemberDisplay.instance.bars(stockId, query, 'member'), error => error instanceof CommandError && error.status === 403 && error.code === 'DATA_DISPLAY_NOT_LICENSED');
  const allowed = service();
  const result = await allowed.instance.bars(stockId, query, 'public');
  assert.equal(result.instrumentId, stockId);
  assert.equal(result.meta.capabilities.retainBars, true);
  const memberOnly = service({ capabilityOverrides: { 'public:display': { displayPublic: false, displayMember: false } } });
  await assert.rejects(() => memberOnly.instance.bars(stockId, query, 'public'), error => error instanceof CommandError && error.status === 403 && error.code === 'DATA_DISPLAY_NOT_LICENSED');
  assert.equal((await memberOnly.instance.bars(stockId, query, 'member')).instrumentId, stockId, 'Member-specific rights remain independent from public rights');
});

test('bars reject option premiums and asset-mismatched sessions explicitly', async () => {
  const option = service({ asset: 'option' });
  await assert.rejects(() => option.instance.bars(optionId, query, 'public'), error => error instanceof CommandError && error.status === 400 && error.code === 'OPTION_PREMIUM_HISTORY_UNSUPPORTED');
  const stock = service();
  await assert.rejects(() => stock.instance.bars(stockId, { ...query, session: 'exchange' }, 'public'), error => error instanceof CommandError && error.status === 400 && error.code === 'UNSUPPORTED_SESSION');
  const future = service({ asset: 'future' });
  await assert.rejects(() => future.instance.bars(futureId, { ...query, session: 'regular' }, 'public'), error => error instanceof CommandError && error.status === 400 && error.code === 'UNSUPPORTED_SESSION');
});

test('bars validate UTC range, horizon and page-size bounds before provider access', async () => {
  const fixture = service({ failBars: new Error('provider should not be reached') });
  for (const invalid of [
    { ...query, from: 'yesterday' },
    { ...query, to: query.from },
    { ...query, to: '2027-01-19T13:30:00.000Z' },
    { ...query, limit: '10001' },
  ]) await assert.rejects(() => fixture.instance.bars(stockId, invalid, 'public'), error => error instanceof CommandError && error.status === 400);
  await assert.rejects(() => fixture.instance.bars(stockId, { ...query, cursor: 'bad-cursor' }, 'public'), error => error instanceof CommandError && error.status === 400);
});

test('provider outage maps to a safe 503 while missing and stale envelopes stay explicit', async () => {
  const failure = service({ failBars: new Error('private provider response detail') });
  await assert.rejects(() => failure.instance.bars(stockId, query, 'public'), error => error instanceof CommandError && error.status === 503 && error.code === 'MARKET_DATA_UNAVAILABLE' && !error.message.includes('private provider'));
  const missing = service();
  assert.equal((await missing.instance.bars(stockId, query, 'public')).meta.freshness, 'missing');
  const stale = service({ dataEnvelope: { data: { items: [], nextCursor: null }, providerReference: 'Synthetic Demo data', asOf: '2026-10-20T13:35:00.000Z', delaySeconds: 900, freshness: 'stale', metadataVersion: 1, capabilities: flags(), demo: true } });
  assert.equal((await stale.instance.bars(stockId, query, 'public')).meta.freshness, 'stale');
  const wrongReference = service({ dataEnvelope: { data: { items: [], nextCursor: null }, providerReference: 'Synthetic Demo data', asOf: null, delaySeconds: 900, freshness: 'missing', metadataVersion: 2, capabilities: flags(), demo: true } });
  await assert.rejects(() => wrongReference.instance.bars(stockId, query, 'public'), error => error instanceof CommandError && error.status === 503, 'A provider reference mismatch cannot be relabeled as the current catalog version');
});
