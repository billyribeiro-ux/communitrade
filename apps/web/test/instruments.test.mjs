import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usesLocalSessionCookie } from '../src/lib/runtime-policy.ts';
import { instrumentFailure } from '../src/lib/instrument-errors.ts';
import { getExpirationStatus } from '../src/lib/instrument-dates.ts';
import { optionStrategies, orderOptionLegs, strategyDefinition, validContractSelection } from '../src/lib/option-strategies.ts';

test('public and production releases use the secure session cookie even under a development Node mode', () => {
  assert.equal(usesLocalSessionCookie('public', 'development'), false);
  assert.equal(usesLocalSessionCookie('production', 'development'), false);
  assert.equal(usesLocalSessionCookie('local', 'production'), true);
  assert.equal(usesLocalSessionCookie(undefined, 'development'), true);
  assert.equal(usesLocalSessionCookie(undefined, 'production'), false);
});

test('option catalog exposes exactly the six supported strategies and their actual contract counts', () => {
  assert.deepEqual(optionStrategies.map(({ id }) => id), ['long_call', 'long_put', 'bull_call_debit', 'bear_put_debit', 'bull_put_credit', 'bear_call_credit']);
  assert.equal(strategyDefinition('long_call').contracts, 1);
  assert.equal(strategyDefinition('long_put').optionType, 'put');
  for (const id of ['bull_call_debit', 'bear_put_debit', 'bull_put_credit', 'bear_call_credit']) assert.equal(strategyDefinition(id).contracts, 2);
  assert.equal(strategyDefinition('iron_condor'), undefined);
});

test('server validation is called only with the exact number of distinct actual contract UUIDs', () => {
  const first = '10000000-0000-4000-8000-000000000001';
  const second = '10000000-0000-4000-8000-000000000002';
  assert.equal(validContractSelection([first], 1), true);
  assert.equal(validContractSelection([first, second], 2), true);
  assert.equal(validContractSelection([first, first], 2), false);
  assert.equal(validContractSelection([first], 2), false);
  assert.equal(validContractSelection(['call-at-100'], 1), false);
});

test('vertical contract ordering assigns the intended long and short legs regardless of click order', () => {
  const high = { id: 'high', strike: '105' };
  const low = { id: 'low', strike: '100' };
  const check = (strategy, expected) => assert.deepEqual(orderOptionLegs(strategy, [high, low]).map(({ contract, side }) => [contract.id, side]), expected);
  check('bull_call_debit', [['low', 'long'], ['high', 'short']]);
  check('bear_put_debit', [['high', 'long'], ['low', 'short']]);
  check('bull_put_credit', [['high', 'short'], ['low', 'long']]);
  check('bear_call_credit', [['low', 'short'], ['high', 'long']]);
});

test('instrument errors keep malformed, license-denied, and provider-outage states distinct', () => {
  assert.notEqual(instrumentFailure(400, 'Catalog').title, instrumentFailure(403, 'Catalog').title);
  assert.notEqual(instrumentFailure(403, 'Catalog').title, instrumentFailure(503, 'Catalog').title);
  assert.match(instrumentFailure(400, 'Catalog').message, /Check the search/);
  assert.match(instrumentFailure(403, 'Catalog').message, /permissions/);
  assert.match(instrumentFailure(503, 'Catalog').message, /temporarily unavailable/);
});

test('expiration status uses UTC calendar days and marks past, near, and distant contracts', () => {
  const now = new Date('2026-10-20T22:30:00Z');
  assert.deepEqual(getExpirationStatus('2026-10-19', now), { expired: true, days: -1 });
  assert.deepEqual(getExpirationStatus('2026-10-27', now), { expired: false, days: 7 });
  assert.equal(getExpirationStatus('2026-10-28', now), undefined);
  assert.equal(getExpirationStatus('bad-date', now), undefined);
  assert.equal(getExpirationStatus('2026-02-31', now), undefined);
});
