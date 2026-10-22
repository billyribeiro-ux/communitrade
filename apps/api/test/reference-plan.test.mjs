import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hydrateTradePlan } from '../dist/domain/reference-plan.js';
import { calculatePosition } from '@trading/domain';

const primary = { id: 'underlying', asset: 'stock', symbol: 'SYN-XYZ', currency: 'USD', enabled: true,
  metadata: { id: 'underlying-v1', version: 1, multiplier: '1', tickSize: '0.01' } };
const option = (id, strike) => ({ id, asset: 'option', symbol: `SYN-${id}`, underlyingId: primary.id, currency: 'USD', enabled: true,
  metadata: { id: `${id}-v1`, version: 1, multiplier: '100', tickSize: '0.01', strike, optionType: 'call', expiry: '2030-12-20T21:00:00Z', adjusted: false } });
const refs = new Map([primary, option('lower', '100'), option('upper', '105')].map(value => [value.id, value]));
const input = { asset: 'option', strategy: 'bull_call_debit', instrumentId: primary.id,
  legs: [{ instrumentId: 'upper', side: 'sell', quantity: 1 }, { instrumentId: 'lower', side: 'buy', quantity: 1 }],
  quantity: 1, entryPrice: '1.50', priceKind: 'spread_debit', entryFrom: '2026-10-19T13:00:00Z', entryUntil: '2026-10-19T14:00:00Z',
  entryCondition: 'Synthetic fixture', timeframe: 'intraday', exitRules: 'Synthetic fixture', conflicts: 'Synthetic data only' };
test('canonical API contracts hydrate from trusted references, normalize legs and preserve version identities', () => {
  const result = hydrateTradePlan(input, refs, '2026-10-19T12:00:00Z');
  assert.equal(result.plan.legs[0].strike, '100');
  assert.deepEqual(result.referenceVersions.map(value => value.metadataVersionId), ['underlying-v1', 'lower-v1', 'upper-v1']);
  const calculation = calculatePosition({ plan: result.plan, entryCosts: { amount: '0' }, exits: [] });
  assert.equal(calculation.maxLoss, '150.0000000000');
  assert.equal(calculation.maxProfit, '350.0000000000');
});
test('reference hydration rejects wrong price units, foreign underlying, duplicate/disabled and adjusted contracts', () => {
  assert.throws(() => hydrateTradePlan({ ...input, priceKind: 'underlying' }, refs, '2026-10-19T12:00:00Z'), { code: 'PRICE_KIND_MISMATCH' });
  const foreign = new Map(refs); foreign.set('lower', { ...option('lower', '100'), underlyingId: 'other' });
  assert.throws(() => hydrateTradePlan(input, foreign, '2026-10-19T12:00:00Z'), { code: 'INVALID_OPTION_CONTRACT' });
  const adjusted = new Map(refs); adjusted.set('lower', { ...option('lower', '100'), metadata: { ...option('lower', '100').metadata, adjusted: true } });
  assert.throws(() => hydrateTradePlan(input, adjusted, '2026-10-19T12:00:00Z'), { code: 'INVALID_TRADE_PLAN' });
  assert.throws(() => hydrateTradePlan({ ...input, legs: [input.legs[0], input.legs[0]] }, refs, '2026-10-19T12:00:00Z'), { code: 'DUPLICATE_OPTION_CONTRACT' });
});
