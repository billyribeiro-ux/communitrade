import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  executeIdempotentCommand, withActorTransaction, withTransaction, consumeQuota,
  reserveQuota, settleQuotaReservation, reviseOwnedDraft, lockOwnedDraft,
  appendOutbox, claimOutbox, finishOutbox,
} from '../dist/persistence/transactions.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = { skip: databaseUrl ? false : 'Set TEST_DATABASE_URL for real PostgreSQL transaction acceptance.' };

test('PostgreSQL: atomic idempotency, quotas, revision locks, owner privacy, rollback and outbox leases', integration, async (t) => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 20, connectionTimeoutMillis: 3000, query_timeout: 15000 });
  pool.on('error', () => {});
  const actor = randomUUID(), other = randomUUID(), unverified = randomUUID();
  const marker = randomUUID();
  const eventType = `p02.acceptance.${marker.replaceAll('-', '')}`;
  const createdDrafts = [];
  const request = (key, input = {}) => ({ actorUserId: actor, operation: 'p02.acceptance', idempotencyKey: `${marker}-${key}`, input });
  const createDraft = async (tx, title = 'Synthetic P02 transaction evidence') => {
    const id = randomUUID();
    await tx.query(`INSERT INTO draft(id,owner_user_id,kind,title,thesis,plan,revision,chart_revision,created_at,updated_at)
      VALUES($1,$2,'trade',$3,'Synthetic evidence only','{}',1,0,NOW(),NOW())`, [id, tx.actorUserId, title]);
    createdDrafts.push(id);
    return id;
  };
  try {
    for (const id of [actor, other, unverified]) {
      await pool.query(`INSERT INTO user_account(id,oidc_issuer,oidc_subject,status,email_verified,created_at,updated_at)
        VALUES($1::uuid,'https://synthetic.p02.invalid',$1::text,'active',$2,NOW(),NOW())`, [id, id !== unverified]);
    }
    await t.test('concurrent identical keys execute once and retain the original response', async () => {
      let executions = 0;
      const responses = await Promise.all(Array.from({ length: 12 }, () => executeIdempotentCommand(pool, request('same', { b: 2, a: 1 }), async tx => {
        executions++;
        const id = await createDraft(tx);
        await appendOutbox(tx, { eventType, aggregateType: 'draft', aggregateId: id, revision: 1, payload: { id } });
        return { status: 201, body: { id }, resourceId: id };
      })));
      assert.equal(executions, 1);
      assert.equal(new Set(responses.map(value => value.body.id)).size, 1);
      assert.equal(responses.filter(value => !value.replayed).length, 1);
      const replay = await executeIdempotentCommand(pool, request('same', { a: 1, b: 2 }), async () => { throw new Error('must not run'); });
      assert.equal(replay.replayed, true);
      await assert.rejects(executeIdempotentCommand(pool, request('same', { a: 2 }), async () => { throw new Error('must not run'); }), { code: 'IDEMPOTENCY_MISMATCH', status: 409 });
      const stored = await pool.query('SELECT expires_at-created_at AS retention FROM idempotency_record WHERE actor_key=$1', [actor]);
      assert.ok(stored.rows.length > 0);
      const retention = await pool.query("SELECT bool_and(expires_at>=created_at+interval '24 hours') AS valid FROM idempotency_record WHERE actor_key=$1", [actor]);
      assert.equal(retention.rows[0].valid, true);
    });
    await t.test('two dozen simultaneous creates cannot exceed an atomic UTC-month quota', async () => {
      const results = await Promise.allSettled(Array.from({ length: 24 }, (_, i) => executeIdempotentCommand(pool, request(`quota-${i}`), async tx => {
        await consumeQuota(tx, 'p02_race', 7);
        const id = await createDraft(tx);
        await appendOutbox(tx, { eventType, aggregateType: 'draft', aggregateId: id, revision: 1, payload: { id } });
        return { status: 201, body: { id } };
      })));
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 7);
      for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 'QUOTA_EXCEEDED');
      const row = await pool.query("SELECT count,reserved_count,EXTRACT(DAY FROM month_start AT TIME ZONE 'UTC') AS day FROM quota_bucket WHERE user_id=$1 AND metric='p02_race'", [actor]);
      assert.equal(row.rows[0].count, 7); assert.equal(row.rows[0].reserved_count, 0); assert.equal(Number(row.rows[0].day), 1);
    });
    await t.test('failure rolls back records, quota, response ledger and outbox together', async () => {
      const id = randomUUID();
      await assert.rejects(executeIdempotentCommand(pool, request('rollback'), async tx => {
        await consumeQuota(tx, 'p02_rollback', 1);
        await tx.query(`INSERT INTO draft(id,owner_user_id,kind,title,thesis,plan,revision,chart_revision,created_at,updated_at)
          VALUES($1,$2,'trade','Synthetic rollback','Rollback','{}',1,0,NOW(),NOW())`, [id, actor]);
        await appendOutbox(tx, { eventType, aggregateType: 'draft', aggregateId: id, revision: 1, payload: { id } });
        throw new Error('Intentional transaction failure');
      }));
      for (const [sql, params] of [
        ['SELECT id FROM draft WHERE id=$1', [id]],
        ["SELECT id FROM quota_bucket WHERE user_id=$1 AND metric='p02_rollback'", [actor]],
        ['SELECT id FROM outbox_event WHERE aggregate_id=$1', [id]],
        ['SELECT id FROM idempotency_record WHERE actor_key=$1 AND key=$2', [actor, request('rollback').idempotencyKey]],
      ]) assert.equal((await pool.query(sql, params)).rowCount, 0);
    });
    await t.test('reservations count toward limits and complete against their original bucket', async () => {
      const bucket = await withActorTransaction(pool, actor, tx => reserveQuota(tx, 'p02_reservation', 2, 2));
      await assert.rejects(withActorTransaction(pool, actor, tx => consumeQuota(tx, 'p02_reservation', 2)), { code: 'QUOTA_EXCEEDED' });
      await assert.rejects(withActorTransaction(pool, other, tx => settleQuotaReservation(tx, bucket.id, 1, true)), { code: 'RESERVATION_CONFLICT' });
      await withActorTransaction(pool, actor, tx => settleQuotaReservation(tx, bucket.id, 1, true));
      await withActorTransaction(pool, actor, tx => settleQuotaReservation(tx, bucket.id, 1, false));
      const rows = await pool.query('SELECT count,reserved_count FROM quota_bucket WHERE id=$1', [bucket.id]);
      assert.deepEqual(rows.rows[0], { count: 1, reserved_count: 0 });
    });
    await t.test('same revision concurrent writes yield one winner; foreign owner is indistinguishable from missing', async () => {
      const id = await withActorTransaction(pool, actor, createDraft);
      const updates = await Promise.allSettled(['first', 'second'].map(title => withActorTransaction(pool, actor, tx => reviseOwnedDraft(tx, id, 1, { title, plan: { entry: '100' } }))));
      assert.equal(updates.filter(result => result.status === 'fulfilled').length, 1);
      const loser = updates.find(result => result.status === 'rejected');
      assert.equal(loser.reason.code, 'STALE_REVISION');
      for (const privateId of [id, randomUUID()]) await assert.rejects(withActorTransaction(pool, other, tx => lockOwnedDraft(tx, privateId)), { status: 404, code: 'NOT_FOUND' });
      await assert.rejects(withActorTransaction(pool, unverified, tx => lockOwnedDraft(tx, id)), { status: 403, code: 'VERIFIED_EMAIL_REQUIRED' });
      await pool.query("UPDATE user_account SET status='suspended' WHERE id=$1", [actor]);
      await assert.rejects(executeIdempotentCommand(pool, request('same', { a: 1, b: 2 }), async () => ({ status: 200, body: {} })), { code: 'ACCOUNT_UNAVAILABLE' });
      await pool.query("UPDATE user_account SET status='active' WHERE id=$1", [actor]);
    });
    await t.test('SKIP LOCKED claims do not overlap and fencing rejects a stale acknowledgement', async () => {
      // Claim every currently available synthetic test event in two parallel consumers.
      const claims = await Promise.all([claimOutbox(pool, 100, [eventType]), claimOutbox(pool, 100, [eventType])]);
      const ids = claims.flat().map(event => event.id);
      assert.equal(new Set(ids).size, ids.length);
      const claim = claims.flat().find(event => createdDrafts.includes(event.aggregate_id));
      assert.ok(claim);
      await pool.query("UPDATE outbox_event SET available_at=NOW()-interval '1 second' WHERE id=$1", [claim.id]);
      const reclaimed = (await claimOutbox(pool, 100, [eventType])).find(event => event.id === claim.id);
      assert.ok(reclaimed); assert.equal(reclaimed.attempts, claim.attempts + 1);
      assert.equal(await finishOutbox(pool, claim, true), false);
      assert.equal(await finishOutbox(pool, reclaimed, true), true);
      assert.equal(await finishOutbox(pool, reclaimed, true), false);
      const final = await pool.query('SELECT status FROM outbox_event WHERE id=$1', [claim.id]);
      assert.equal(final.rows[0].status, 'delivered');
    });
    await t.test('outbox aggregate revisions are unique and retries stop after the eighth lease', async () => {
      const aggregateId = await withActorTransaction(pool, actor, createDraft);
      const event = { eventType, aggregateType: 'draft', aggregateId, revision: 1, payload: { id: aggregateId } };
      const id = await withActorTransaction(pool, actor, tx => appendOutbox(tx, event));
      await assert.rejects(withActorTransaction(pool, actor, tx => appendOutbox(tx, event)), { code: 'DUPLICATE_DOMAIN_EVENT' });
      await pool.query("UPDATE outbox_event SET status='processing',attempts=8,available_at=NOW()-interval '1 second' WHERE id=$1", [id]);
      assert.equal((await claimOutbox(pool, 100, [eventType])).some(claim => claim.id === id), false);
      assert.equal((await pool.query('SELECT status FROM outbox_event WHERE id=$1', [id])).rows[0].status, 'failed');
    });
    await t.test('SQL mutation rollback is real even outside command infrastructure', async () => {
      await assert.rejects(withTransaction(pool, async tx => { await tx.query('UPDATE user_account SET status=$2 WHERE id=$1', [actor, 'suspended']); throw new Error('Rollback'); }));
      assert.equal((await pool.query('SELECT status FROM user_account WHERE id=$1', [actor])).rows[0].status, 'active');
    });
  } finally {
    // Only mutable synthetic records from this test are removed; immutable evidence is untouched.
    await pool.query('DELETE FROM outbox_event WHERE aggregate_id=ANY($1::uuid[])', [createdDrafts]);
    await pool.query('DELETE FROM idempotency_record WHERE actor_key=ANY($1::text[])', [[actor, other, unverified]]);
    await pool.query('DELETE FROM quota_bucket WHERE user_id=ANY($1::uuid[])', [[actor, other, unverified]]);
    await pool.query('DELETE FROM draft WHERE owner_user_id=ANY($1::uuid[])', [[actor, other, unverified]]);
    await pool.query('DELETE FROM user_account WHERE id=ANY($1::uuid[])', [[actor, other, unverified]]);
    await pool.end();
  }
});
