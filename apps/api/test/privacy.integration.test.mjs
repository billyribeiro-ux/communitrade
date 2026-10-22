import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { CommandError } from '../dist/http/problem.js';
import { PrivacyService } from '../dist/privacy/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = { skip: databaseUrl ? false : 'Set TEST_DATABASE_URL for API privacy PostgreSQL acceptance.' };

test('PostgreSQL admin hold/process race is serialized, auditable, and idempotent', integration, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 3000, query_timeout: 15000 });
  pool.on('error', () => {});
  const owner = randomUUID();
  const admin = randomUUID();
  const session = randomUUID();
  const request = randomUUID();
  const issuer = `https://p13-admin.${randomUUID()}.invalid`;
  const service = new PrivacyService(pool);
  const base = { actorUserId: admin, sessionId: session, requestId: request };
  try {
    for (const [id, label] of [[owner, 'owner'], [admin, 'admin']]) {
      await pool.query(`INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,created_at,updated_at)
        VALUES($1,$2,$3,$4,true,'active',now(),now())`, [id, issuer, `${label}-${id}`, `${label}-${id}@example.invalid`]);
    }
    await pool.query(`INSERT INTO role_grant(id,user_id,role,grantor_user_id,reason,granted_at)
      VALUES($1,$2,'admin',$2,'P13 privacy integration',now())`, [randomUUID(), admin]);
    await pool.query(`INSERT INTO app_session(id,token_hash,user_id,issued_at,last_seen_at,expires_at,mfa_at,assurance)
      VALUES($1,$2,$3,now(),now(),now()+interval '1 hour',now(),'2')`, [session, createHash('sha256').update(randomUUID()).digest('hex'), admin]);
    await pool.query(`INSERT INTO privacy_request(id,owner_user_id,type,status,requested_at,due_at,stage,progress,created_at,updated_at)
      VALUES($1,$2,'deletion','requested',now(),now()+interval '30 days','queued','{}'::jsonb,now(),now())`, [request, owner]);

    const until = new Date(Date.now() + 60 * 60_000).toISOString();
    const holdKey = `${randomUUID()}-hold-key`;
    const processKey = `${randomUUID()}-process-key`;
    const results = await Promise.allSettled([
      service.adminAction({ ...base, requestTraceId: randomUUID(), idempotencyKey: holdKey, action: 'hold', reason: 'Preserve records for review', holdUntil: until }),
      service.adminAction({ ...base, requestTraceId: randomUUID(), idempotencyKey: processKey, action: 'process', reason: 'Process after review window' }),
    ]);
    const hold = results[0];
    assert.equal(hold.status, 'fulfilled');
    assert.equal(hold.value.status, 'held');
    if (results[1].status === 'rejected') {
      assert.ok(results[1].reason instanceof CommandError);
      assert.equal(results[1].reason.code, 'PRIVACY_REQUEST_HELD');
    } else assert.equal(results[1].value.status, 'queued');

    const persisted = await pool.query(`SELECT status,hold_reason,hold_until FROM privacy_request WHERE id=$1`, [request]);
    assert.equal(persisted.rows[0].status, 'held');
    assert.equal(persisted.rows[0].hold_reason, 'Preserve records for review');
    assert.ok(new Date(persisted.rows[0].hold_until) > new Date());
    const audit = await pool.query(`SELECT action,reason FROM audit_event WHERE resource_type='privacy_request' AND resource_id=$1`, [request]);
    assert.ok(audit.rows.some(row => row.action === 'privacy.hold' && row.reason === 'Preserve records for review'));

    const replay = await service.adminAction({ ...base, requestTraceId: randomUUID(), idempotencyKey: holdKey, action: 'hold', reason: 'Preserve records for review', holdUntil: until });
    assert.equal(replay.status, 'held');
    const released = await service.adminAction({ ...base, requestTraceId: randomUUID(), idempotencyKey: `${randomUUID()}-release-key`, action: 'release_hold', reason: 'Release after review' });
    assert.equal(released.status, 'queued');
    assert.equal(released.hold, null);
  } finally {
    await pool.query(`DELETE FROM outbox_event WHERE aggregate_type='privacy_request' AND aggregate_id=$1`, [request]).catch(() => {});
    await pool.query(`DELETE FROM idempotency_record WHERE actor_key=$1`, [admin]).catch(() => {});
    await pool.query(`DELETE FROM audit_event WHERE resource_type='privacy_request' AND resource_id=$1`, [request]).catch(() => {});
    await pool.query(`DELETE FROM privacy_request WHERE id=$1`, [request]).catch(() => {});
    await pool.query(`DELETE FROM app_session WHERE id=$1`, [session]).catch(() => {});
    await pool.query(`DELETE FROM role_grant WHERE user_id=$1`, [admin]).catch(() => {});
    await pool.query(`DELETE FROM user_account WHERE id=ANY($1::uuid[])`, [[owner, admin]]).catch(() => {});
    await pool.end();
  }
});
