import assert from 'node:assert/strict';
import test from 'node:test';
import { expireOpenPositions } from '../dist/position-expiry.js';

function poolWith(rows) {
  const calls = [];
  const client = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT p.id,p.plan')) return { rows };
      if (sql.startsWith('SELECT CURRENT_TIMESTAMP')) return { rows: [{ now: new Date('2026-10-20T15:00:00.000Z') }] };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return { calls, pool: { connect: async () => client } };
}

test('expiry sweep validates bounded batch size and performs no query for invalid limits', async () => {
  const { pool, calls } = poolWith([]);
  for (const limit of [0, -1, 101, 1.5]) await assert.rejects(expireOpenPositions(pool, { limit }), /between 1 and 100/);
  assert.equal(calls.length, 0);
});

test('expired open positions become unresolved without fabricating fills or changing remaining quantity', async () => {
  const { pool, calls } = poolWith([{
    id: '00000000-0000-4000-8000-000000000001',
    expiration: new Date('2026-10-20T14:00:00.000Z'),
    eligibility: 'eligible',
    exclusions: ['late_entry'],
    remaining_quantity: 2,
    revision: 4,
    public_publication_id: '00000000-0000-4000-8000-000000000002',
    publication_version_id: '00000000-0000-4000-8000-000000000005',
  }]);
  assert.equal(await expireOpenPositions(pool, { limit: 50 }), 1);
  const select = calls.find((call) => call.sql.startsWith('SELECT p.id,p.plan'));
  assert.match(select.sql, /state IN \('entered','partially_closed'\)/);
  assert.match(select.sql, /FOR UPDATE OF p SKIP LOCKED/);
  assert.match(select.sql, /LEFT JOIN publication pub ON pub.id=p.public_publication_id/);
  assert.match(select.sql, /pub.current_version_id AS publication_version_id/);
  assert.equal(select.values[0], 50);
  const event = calls.find((call) => call.sql.startsWith('INSERT INTO position_event'));
  assert.match(event.sql, /'exception'/);
  assert.equal(event.values[2], '2026-10-20T14:00:00.000Z');
  assert.equal(event.values[4], 'Contract expiry passed; settlement or assignment evidence is required.');
  assert.deepEqual(JSON.parse(event.values[5]), { system: 'claim_window_expired', exclusions: ['expired_unresolved'] });
  assert.match(event.sql, /NULL,NULL,NULL/);
  const update = calls.find((call) => call.sql.startsWith('UPDATE position'));
  assert.match(update.sql, /state='unresolved',revision=revision\+1/);
  assert.equal(update.sql.includes('remaining_quantity='), false);
  const outcome = calls.find((call) => call.sql.startsWith('INSERT INTO outcome_snapshot'));
  assert.match(outcome.sql, /publication_version_id,created_at/);
  assert.equal(outcome.values[3], 'eligible');
  assert.deepEqual(JSON.parse(outcome.values[4]), ['late_entry', 'expired_unresolved']);
  assert.equal(outcome.values[5], '00000000-0000-4000-8000-000000000005');
  assert.match(outcome.sql, /NULL,NULL,'incomplete'/);
});

test('expiry outcome remains retrospective when appropriate and falls back to excluded without prior eligibility', async () => {
  const { pool, calls } = poolWith([
    { id: '00000000-0000-4000-8000-000000000003', expiration: new Date('2026-10-20T14:00:00.000Z'), eligibility: 'retrospective', exclusions: [], publication_version_id: '00000000-0000-4000-8000-000000000006' },
    { id: '00000000-0000-4000-8000-000000000004', expiration: new Date('2026-10-20T14:00:00.000Z'), eligibility: null, exclusions: null, publication_version_id: null },
  ]);
  assert.equal(await expireOpenPositions(pool, { limit: 2 }), 2);
  const outcomes = calls.filter((call) => call.sql.startsWith('INSERT INTO outcome_snapshot'));
  assert.equal(outcomes[0].values[3], 'retrospective');
  assert.equal(outcomes[1].values[3], 'excluded');
  assert.deepEqual(JSON.parse(outcomes[0].values[4]), ['expired_unresolved']);
  assert.equal(outcomes[0].values[5], '00000000-0000-4000-8000-000000000006');
  assert.equal(outcomes[1].values[5], null);
});
