import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import apiFixtures from '../src/fixtures/domain-personas.json' with { type: 'json' };
import calculations from '../../../contracts/fixtures/domain-calculations.json' with { type: 'json' };

test('synthetic API fixture cases stay synchronized with the canonical calculation manifest', () => {
  assert.equal(apiFixtures.synthetic, true);
  assert.equal(apiFixtures.personas.length, 7);
  assert.deepEqual(apiFixtures.financialCases, calculations.cases);
  assert.deepEqual(apiFixtures.personas.find((persona) => persona.plan === 'free').limits, { watchlists: 1, itemsPerWatchlist: 25, savedLayouts: 1, newJournalEntriesPerMonth: 30 });
  assert.deepEqual(apiFixtures.personas.find((persona) => persona.plan === 'pro').limits, { watchlists: 10, itemsPerWatchlist: 100, savedLayouts: 10, newJournalEntriesPerMonth: 1000 });
  assert.deepEqual(apiFixtures.personas.filter((persona) => persona.role).map((persona) => persona.role), ['moderator', 'admin']);
});

const { Client } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL;

test('PostgreSQL domain schema enforces ownership, uniqueness, immutable history, nullable costs, and rollback', {
  skip: databaseUrl ? false : 'Set TEST_DATABASE_URL to run the PostgreSQL schema integration test.',
}, async () => {
  const client = new Client({ connectionString: databaseUrl });
  const userA = randomUUID();
  const userB = randomUUID();
  const draftId = randomUUID();
  const positionId = randomUUID();
  const journalId = randomUUID();
  const journalOtherId = randomUUID();
  const instrumentOtherId = randomUUID();
  const metadataOtherId = randomUUID();
  const instrumentId = randomUUID();
  const metadataId = randomUUID();
  const eventId = randomUUID();
  const publicationId = randomUUID();
  const versionId = randomUUID();
  const chartId = randomUUID();
  let savepoint = 0;
  const expectRejected = async (sql, args, pattern) => {
    const name = `expected_failure_${++savepoint}`;
    await client.query(`SAVEPOINT ${name}`);
    await assert.rejects(client.query(sql, args), pattern);
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    await client.query(`RELEASE SAVEPOINT ${name}`);
  };
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(`INSERT INTO user_account (id, oidc_issuer, oidc_subject, email_verified, status, updated_at) VALUES
      ($1, 'urn:test', $3, true, 'active',now()), ($2, 'urn:test', $4, true, 'active',now())`, [userA, userB, randomUUID(), randomUUID()]);
    await client.query("INSERT INTO draft (id, owner_user_id, kind, plan, updated_at) VALUES ($1,$2,'trade','{}',now())", [draftId, userA]);

    await expectRejected(
      "INSERT INTO draft (id, owner_user_id, kind, plan, updated_at) VALUES ($1,$2,'trade','{}',now())", [randomUUID(), randomUUID()],
      /draft_owner_user_id_fkey/,
    );

    const quotaId = randomUUID();
    await client.query("INSERT INTO quota_bucket (id,user_id,metric,month_start,updated_at) VALUES ($1,$2,'drafts','2026-10-01T00:00:00Z',now())", [quotaId,userA]);
    await expectRejected(
      "INSERT INTO quota_bucket (id,user_id,metric,month_start,updated_at) VALUES ($1,$2,'drafts','2026-10-01T00:00:00Z',now())", [randomUUID(),userA],
      /quota_bucket_user_id_metric_month_start_key/,
    );

    await client.query("INSERT INTO journal_entry (id,owner_user_id,updated_at) VALUES ($1,$2,now())", [journalId,userA]);
    await client.query("INSERT INTO instrument (id,asset,vendor,vendor_id,venue,currency) VALUES ($1,'stock','synthetic','schema-test','SYN','USD')", [instrumentId]);
    await client.query("INSERT INTO instrument (id,asset,vendor,vendor_id,venue,currency) VALUES ($1,'stock','synthetic','schema-test-other','SYN','USD')", [instrumentOtherId]);
    await client.query("INSERT INTO instrument_metadata_version (id,instrument_id,version,multiplier,tick_size) VALUES ($1,$2,1,1,0.01)", [metadataId,instrumentId]);
    await client.query("INSERT INTO instrument_metadata_version (id,instrument_id,version,multiplier,tick_size) VALUES ($1,$2,1,1,0.01)", [metadataOtherId,instrumentOtherId]);
    await client.query("INSERT INTO journal_entry (id,owner_user_id,updated_at) VALUES ($1,$2,now())", [journalOtherId,userB]);
    await client.query("INSERT INTO position (id,owner_user_id,private_journal_entry_id,instrument_id,state,plan,metadata_version_id,remaining_quantity,initial_risk,calculation_version) VALUES ($1,$2,$3,$4,'entered','{}',$5,1,1,'fixture-v1')", [positionId,userA,journalId,instrumentId,metadataId]);
    await expectRejected("INSERT INTO position (id,owner_user_id,private_journal_entry_id,instrument_id,state,plan,metadata_version_id,remaining_quantity,initial_risk,calculation_version) VALUES ($1,$2,$3,$4,'entered','{}',$5,1,1,'fixture-v1')", [randomUUID(),userA,journalOtherId,instrumentId,metadataId], /position owner must own private journal source/);
    await client.query("INSERT INTO position_event (id,position_id,type,quantity,price,costs) VALUES ($1,$2,'entry',1,1.25,NULL)", [eventId,positionId]);
    const nullableCost = await client.query('SELECT costs FROM position_event WHERE id=$1', [eventId]);
    assert.equal(nullableCost.rows[0].costs, null, 'unknown costs must remain NULL');
    await expectRejected("UPDATE position_event SET price=2 WHERE id=$1", [eventId], /append-only/);
    await expectRejected("UPDATE instrument_metadata_version SET multiplier=2 WHERE id=$1", [metadataId], /append-only/);
    await expectRejected("UPDATE draft SET revision=0 WHERE id=$1", [draftId], /draft_revision_positive/);
    await expectRejected("UPDATE position SET initial_risk=2 WHERE id=$1", [positionId], /frozen initial risk cannot be changed/);
    // Even a state change cannot unlock an already established denominator.
    await client.query("UPDATE position SET state='pending' WHERE id=$1", [positionId]);
    await expectRejected("UPDATE position SET initial_risk=2 WHERE id=$1", [positionId], /frozen initial risk cannot be changed/);
    await client.query("UPDATE position SET state='entered' WHERE id=$1", [positionId]);

    await client.query("INSERT INTO publication (id,author_user_id,kind,visibility) VALUES ($1,$2,'trade','private')", [publicationId,userA]);
    await client.query("INSERT INTO publication_version (id,publication_id,sequence,terms) VALUES ($1,$2,1,'{}')", [versionId,publicationId]);
    await client.query("UPDATE publication SET current_version_id=$1 WHERE id=$2", [versionId,publicationId]);
    await client.query("INSERT INTO chart_state (id,publication_version_id,schema_version,state,provenance) VALUES ($1,$2,1,'{}','{}')", [chartId,versionId]);
    await expectRejected("UPDATE chart_state SET state='{}' WHERE id=$1", [chartId], /published chart snapshots are immutable/);

    const idemId = randomUUID();
    await client.query("INSERT INTO idempotency_record (id,actor_key,route,key,request_hash,expires_at) VALUES ($1,'synthetic','POST /drafts','same-key','hash-a',now()+interval '1 day')", [idemId]);
    await expectRejected(
      "INSERT INTO idempotency_record (id,actor_key,route,key,request_hash,expires_at) VALUES ($1,'synthetic','POST /drafts','same-key','hash-a',now()+interval '1 day')", [randomUUID()],
      /idempotency_record_actor_key_route_key_key/,
    );

    await client.query('ROLLBACK');
    const rolledBack = await client.query('SELECT 1 FROM user_account WHERE id=$1', [userA]);
    assert.equal(rolledBack.rowCount, 0, 'fixture transaction should leave no records behind');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    await client.end();
  }
});
