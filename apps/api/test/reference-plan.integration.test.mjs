import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { hydrateTradePlan } from '../dist/domain/reference-plan.js';
import { calculatePosition } from '@trading/domain';
import { createDatabase } from '../dist/database.js';
import { assertNoProductionFixtures } from '../dist/persistence/release-guard.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
test('PostgreSQL seeded catalog hydrates all futures roots and each option family from stored metadata', {
  skip: databaseUrl ? false : 'Set TEST_DATABASE_URL to verify database reference hydration.',
}, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const database = createDatabase(databaseUrl);
  try {
    const result = await pool.query(`SELECT i.id,i.asset,i.vendor_id AS symbol,i.currency,i.enabled,i.underlying_id,
      m.id AS metadata_id,m.version,m.multiplier::text,m.tick_size::text,m.expiry,m.strike::text,m.option_type,m.root,m.contract_month,m.contract_year,m.adjusted
      FROM instrument i JOIN instrument_metadata_version m ON m.instrument_id=i.id AND m.version=1
      WHERE i.vendor='synthetic-fixture' ORDER BY i.id`);
    // P05 enriches the catalog while preserving the original P02 identities and
    // v1 snapshots. Hydration must continue to work as more contracts are added.
    const baselineIds = [201,202,203,204,205,221,222,223,224].map(id => `00000000-0000-4000-8000-000000000${id}`);
    assert.ok(baselineIds.every(id => result.rows.some(row => row.id === id)));
    const references = new Map(result.rows.map(row => [row.id, { ...row, underlyingId: row.underlying_id, metadata: {
      id: row.metadata_id, version: row.version, multiplier: row.multiplier, tickSize: row.tick_size,
      expiry: row.expiry?.toISOString(), strike: row.strike, optionType: row.option_type, root: row.root,
      contractMonth: row.contract_month, contractYear: row.contract_year, adjusted: row.adjusted,
    } }]));
    const base = { entryFrom: '2026-10-19T13:00:00Z', entryUntil: '2026-10-19T14:00:00Z', entryCondition: 'Demo data', timeframe: 'intraday', exitRules: 'Synthetic fixture', conflicts: 'Demo data', quantity: 1 };
    for (const root of ['ES', 'MES', 'NQ', 'MNQ']) {
      const reference = [...references.values()].find(item => item.metadata.root === root);
      assert.ok(reference);
      const { plan } = hydrateTradePlan({ ...base, asset: 'future', strategy: 'long', instrumentId: reference.id, legs: [], priceKind: 'futures', entryPrice: '5000', initialStopPrice: '4999' }, references, '2026-10-19T12:00:00Z');
      const outcome = calculatePosition({ plan, entryCosts: { amount: '0' }, exits: [{ quantity: 1, price: '5001', costs: { amount: '0' } }] });
      assert.equal(Number(outcome.grossRealized), { ES: 50, MES: 5, NQ: 20, MNQ: 2 }[root]);
    }
    const stock = [...references.values()].find(item => item.asset === 'stock');
    const leg = (type, strike, side) => ({ instrumentId: [...references.values()].find(item => item.metadata.optionType === type && Number(item.metadata.strike) === strike).id, side, quantity: 1 });
    const cases = [
      ['long_call', [leg('call', 100, 'buy')]], ['long_put', [leg('put', 100, 'buy')]],
      ['bull_call_debit', [leg('call', 100, 'buy'), leg('call', 105, 'sell')]],
      ['bear_put_debit', [leg('put', 105, 'buy'), leg('put', 100, 'sell')]],
      ['bull_put_credit', [leg('put', 105, 'sell'), leg('put', 100, 'buy')]],
      ['bear_call_credit', [leg('call', 100, 'sell'), leg('call', 105, 'buy')]],
    ];
    for (const [strategy, legs] of cases) {
      const { plan, referenceVersions } = hydrateTradePlan({ ...base, asset: 'option', strategy, instrumentId: stock.id, legs, entryPrice: '1.50', priceKind: strategy.endsWith('debit') ? 'spread_debit' : strategy.endsWith('credit') ? 'spread_credit' : 'option_premium' }, references, '2026-10-19T12:00:00Z');
      assert.equal(referenceVersions.length, legs.length + 1);
      assert.ok(calculatePosition({ plan, entryCosts: { amount: '0' }, exits: [] }).initialRisk);
    }
    await assert.rejects(assertNoProductionFixtures(database, { RELEASE_MODE: 'production' }));
  } finally { await pool.end(); await database.$disconnect(); }
});
