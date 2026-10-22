import assert from 'node:assert/strict';
import test from 'node:test';
import { csvCell } from '../dist/export-csv.js';
import { buildRawExport, processExportJob, purgeExpiredExports } from '../dist/exports.js';

const id = '00000000-0000-4000-8000-000000000001';

test('CSV cells neutralize formulas after leading whitespace and control characters', () => {
  for (const input of ['=1+1', '  =1+1', '\t=HYPERLINK("x")', '\u0000\r@SUM(1,1)', '\u00a0-5']) {
    assert.ok(csvCell(input).startsWith('"\''), `unsafe prefix: ${JSON.stringify(input)}`);
  }
  assert.equal(csvCell('plain text'), '"plain text"');
  assert.equal(csvCell('a"b'), '"a""b"');
});

test('raw export includes journal text, tags, review, position legs, and every event row', async () => {
  const calls = [];
  const db = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('FROM journal_entry')) return { rows: [{ id, publication_id: null, position_id: id, notes: '\t=2+2', tags: ['focus'], review: '@unsafe', title: 'Trade', thesis: 'Test', created_at: new Date('2026-01-01T00:00:00Z'), updated_at: new Date('2026-01-02T00:00:00Z'), created_exact: '2026-01-01T00:00:00.000001Z', updated_exact: '2026-01-02T00:00:00.000001Z', deleted_exact: null, created_cursor: '2026-01-01T00:00:00.000001Z' }] };
    if (sql.includes('FROM position WHERE')) return { rows: [{ id, state: 'closed', plan: { strategy: 'long_call' }, instrument_id: 'instrument', metadata_version_id: 'metadata', remaining_quantity: 0, initial_risk: '25.00', calculation_version: 'v1', private_journal_entry_id: id, public_publication_id: null, created_at: new Date('2026-01-01T00:00:00Z'), updated_at: new Date('2026-01-02T00:00:00Z'), created_exact: '2026-01-01T00:00:00.000001Z', updated_exact: '2026-01-02T00:00:00.000001Z' }] };
    if (sql.includes('FROM position_leg')) return { rows: [{ id: 'leg-1', instrument_id: 'instrument', metadata_version_id: 'metadata', side: 'long', quantity: 1 }] };
    if (sql.includes('FROM position_event')) return { rows: [
      { id: 'event-1', type: 'entry', claimed_at: new Date('2026-01-01T00:00:00Z'), received_at: new Date('2026-01-01T00:01:00Z'), claimed_exact: '2026-01-01T00:00:00.000001Z', received_exact: '2026-01-01T00:01:00.000001Z', received_cursor: '2026-01-01T00:01:00.000001Z', quantity: 1, price: '2.00', costs: null, reason: null, supersedes_id: null, details: {} },
      { id: 'event-2', type: 'final_exit', claimed_at: new Date('2026-01-02T00:00:00Z'), received_at: new Date('2026-01-02T00:01:00Z'), claimed_exact: '2026-01-02T00:00:00.000001Z', received_exact: '2026-01-02T00:01:00.000001Z', received_cursor: '2026-01-02T00:01:00.000001Z', quantity: 1, price: '3.00', costs: '1.00', reason: '=unsafe', supersedes_id: null, details: { netResult: '99.00' } },
    ] };
    if (sql.includes('FROM outcome_snapshot')) return { rows: [] };
    throw new Error(`unexpected query: ${sql}`);
  } };
  const bytes = await buildRawExport(db, 'owner'); const csv = bytes.toString('utf8');
  assert.match(csv, /journal_entry/); assert.match(csv, /position_leg/); assert.match(csv, /position_event/);
  assert.ok(csv.includes(`"'\t=2+2"`)); assert.match(csv, /"'@unsafe"/); assert.match(csv, /event-1/); assert.match(csv, /event-2/);
  const positionRow = csv.split('\r\n').find(line => line.startsWith('"position",'));
  assert.ok(positionRow); assert.match(positionRow, /"instrument","metadata"/);
  assert.ok(calls.some(call => call.sql.includes('position_event')));
});

test('completed replay is a no-op and cannot overwrite the generated object', async () => {
  const queries = []; let writes = 0;
  const client = { query: async (sql) => { queries.push(sql); if (sql.startsWith('SELECT id,owner_user_id')) return { rows: [{ id, owner_user_id: 'owner', kind: 'personal_raw', filters: {}, status: 'succeeded', attempts: 1, object_key: `${id}-a1.csv`, expires_at: new Date(Date.now() + 60_000), claimed_at: null }] }; return { rows: [] }; }, release() {} };
  const pool = { connect: async () => client, query: async () => ({ rows: [] }) };
  await processExportJob(pool, { put: async () => { writes++; return `${id}.csv`; }, delete: async () => {} }, { jobId: id });
  assert.equal(writes, 0); assert.ok(queries.includes('COMMIT'));
});

test('analytical worker rechecks current Pro entitlement before reading journal data', async () => {
  const updates = []; const queries = [];
  const client = { query: async (sql) => {
    queries.push(sql);
    if (sql.startsWith('SELECT id,owner_user_id')) return { rows: [{ id, owner_user_id: 'owner', kind: 'journal_analytics', filters: {}, status: 'pending', attempts: 0, object_key: null, expires_at: null, claimed_at: null }] };
    if (sql.includes('FROM user_account')) return { rows: [{ ok: 1 }], rowCount: 1 };
    if (sql.includes('FROM subscription_entitlement')) return { rows: [], rowCount: 0 };
    if (sql.includes("failure_code='PRO_REQUIRED'")) updates.push(sql);
    return { rows: [] };
  }, release() {} };
  const pool = { connect: async () => client, query: async () => { throw new Error('private rows must not be read'); } };
  let writes = 0;
  await processExportJob(pool, { put: async () => { writes++; return ''; }, delete: async () => {} }, { jobId: id });
  assert.equal(writes, 0); assert.ok(updates.length); assert.ok(queries.includes('COMMIT'));
});

test('unsupported legacy export kinds fail explicitly instead of falling through to analytics', async () => {
  const updates = [];
  const client = { query: async sql => {
    if (sql.startsWith('SELECT id,owner_user_id')) return { rows: [{ id, owner_user_id: 'owner', kind: 'legacy_archive', filters: {}, status: 'pending', attempts: 0, object_key: null, expires_at: null, claimed_at: null }] };
    if (sql.includes("failure_code='EXPORT_KIND_UNAVAILABLE'")) updates.push(sql);
    return { rows: [] };
  }, release() {} };
  const pool = { connect: async () => client, query: async () => { throw new Error('unsupported data must not be read'); } };
  await processExportJob(pool, { put: async () => { throw new Error('unsupported data must not be stored'); }, delete: async () => {} }, { jobId: id });
  assert.equal(updates.length, 1);
});

test('expired export cleanup removes its object and records expired status', async () => {
  const queries = []; const deleted = [];
  const key = `${id}-a1.csv`;
  const client = { query: async (sql) => { queries.push(sql); if (sql.includes('SELECT id,object_key FROM export_job')) return { rows: [{ id, object_key: key }] }; return { rowCount: 1, rows: [] }; }, release() {} };
  const count = await purgeExpiredExports({ connect: async () => client }, { delete: async value => deleted.push(value) });
  assert.equal(count, 1); assert.deepEqual(deleted, [key]); assert.ok(queries.some(sql => sql.includes("status='expired'")));
});

test('expired cleanup retains the database object key when storage deletion fails', async () => {
  const queries = [];
  const client = { query: async sql => { queries.push(sql); if (sql.includes('SELECT id,object_key FROM export_job')) return { rows: [{ id, object_key: `${id}-a2.csv` }] }; return { rows: [] }; }, release() {} };
  const count = await purgeExpiredExports({ connect: async () => client }, { delete: async () => { throw new Error('object store unavailable'); } });
  assert.equal(count, 0); assert.ok(!queries.some(sql => sql.includes("status='expired'")));
});
