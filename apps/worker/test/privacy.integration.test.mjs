import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { applyRestoreSuppression, processPersonalArchive, readSuppressionLedger, runPrivacySweep } from '../dist/privacy.js';
import { isDeletionSuppressed } from '../../api/dist/privacy/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = { skip: databaseUrl ? false : 'Set TEST_DATABASE_URL for privacy PostgreSQL lifecycle acceptance.' };

test('PostgreSQL privacy deletion recovers a failed object stage and suppresses a restored identity', integration, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 3000, query_timeout: 15000 });
  pool.on('error', () => {});
  const key = 'p13-integration-suppression-key-32-bytes-minimum';
  const issuer = `https://p13.${randomUUID()}.invalid`;
  const subject = randomUUID();
  const owner = randomUUID();
  const restored = randomUUID();
  const requestId = randomUUID();
  const anonymousTicket = randomUUID();
  const unrelatedTicket = randomUUID();
  const objectKey = `${randomUUID()}-a1.json`;
  const exportId = randomUUID();
  let archiveBytes;
  const blocker = await pool.connect();
  let blocked = false;
  try {
    await pool.query(`INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,true,'active',now(),now())`, [owner, issuer, subject, `${owner}@example.invalid`]);
    await pool.query(`INSERT INTO export_job(id,owner_user_id,kind,filters,status,created_at,updated_at,attempts)
      VALUES($1,$2,'personal_archive','{}'::jsonb,'pending',now(),now(),0)`, [exportId, owner]);
    await pool.query(`INSERT INTO support_ticket(id,category,status,visibility,requester_email,subject,consent_version,consent_at)
      VALUES($1,'account','open','private',$2,'Owned anonymous request','test',now()),($3,'account','open','private',$4,'Unrelated anonymous request','test',now())`,
      [anonymousTicket, `${owner}@example.invalid`, unrelatedTicket, `other-${owner}@example.invalid`]);
    await pool.query(`INSERT INTO support_message(id,ticket_id,body,visibility) VALUES($1,$2,'private receipt content','requester')`, [randomUUID(), anonymousTicket]);
    await pool.query(`INSERT INTO side_effect_delivery(id,channel,business_delivery_key,status,payload,next_attempt_at,category)
      VALUES($1,'support_email',$2,'pending',$3::jsonb,now(),'account')`,
      [randomUUID(), `support-receipt:${anonymousTicket}`, JSON.stringify({ ticketId: anonymousTicket })]);
    await pool.query(`INSERT INTO idempotency_record(id,actor_key,route,key,request_hash,response_status,response_body,resource_id,expires_at)
      VALUES($1,$2,'/support','retry-key','hash',201,$3::jsonb,$4,now()+interval '24 hours')`,
      [randomUUID(), `anonymous-${owner}`, JSON.stringify({ message: 'private receipt content' }), anonymousTicket]);
    await processPersonalArchive(pool, {
      put: async (id, bytes, attempt, format) => {
        assert.equal(id, exportId); assert.equal(format, 'json'); archiveBytes = Buffer.from(bytes);
        return `${id}-a${attempt}.json`;
      },
      delete: async () => {},
    }, { jobId: exportId });
    const archive = JSON.parse(archiveBytes.toString('utf8'));
    assert.equal(archive.sections.account.email, `${owner}@example.invalid`);
    assert.ok(archive.sections.privacy_requests);
    const exported = await pool.query(`SELECT status,object_key,expires_at FROM export_job WHERE id=$1`, [exportId]);
    assert.equal(exported.rows[0].status, 'succeeded');
    assert.equal(exported.rows[0].object_key, `${exportId}-a1.json`);
    assert.ok(new Date(exported.rows[0].expires_at).getTime() <= Date.now() + 24 * 60 * 60_000);
    await pool.query(`INSERT INTO privacy_request(id,owner_user_id,type,status,requested_at,due_at,stage,progress,created_at,updated_at)
      VALUES($1,$2,'deletion','requested',now(),now(),'queued','{}'::jsonb,now(),now())`, [requestId, owner]);
    await pool.query(`INSERT INTO privacy_deletion_object(request_id,object_kind,object_key)
      VALUES($1,'export',$2)`, [requestId, objectKey]);
    await blocker.query('BEGIN');
    blocked = true;
    await blocker.query('SELECT id FROM privacy_request WHERE id<>$1 FOR UPDATE', [requestId]);

    const failed = await runPrivacySweep(pool, {
      deleteExport: async () => { throw new Error('temporary storage outage'); },
      deleteMedia: async () => { throw new Error('unexpected media object'); },
    }, { suppressionKey: key, limit: 1 });
    assert.equal(failed.failed, 1);
    const checkpoint = await pool.query(`SELECT status,failed_stage,stage FROM privacy_request WHERE id=$1`, [requestId]);
    assert.equal(checkpoint.rows[0].status, 'failed');
    assert.equal(checkpoint.rows[0].failed_stage, 'objects');
    assert.equal(checkpoint.rows[0].stage, 'objects');

    const recovered = await runPrivacySweep(pool, {
      deleteExport: async value => assert.ok([objectKey, `${exportId}-a1.json`].includes(value)),
      deleteMedia: async () => { throw new Error('unexpected media object'); },
    }, { suppressionKey: key, limit: 1 });
    assert.equal(recovered.processed, 1);
    assert.equal(recovered.failed, 0);
    const completed = await pool.query(`SELECT status,stage,request_reason FROM privacy_request WHERE id=$1`, [requestId]);
    assert.deepEqual(completed.rows[0], { status: 'completed', stage: 'complete', request_reason: null });
    assert.equal(await isDeletionSuppressed(pool, key, issuer, subject), true);
    assert.equal((await pool.query(`SELECT 1 FROM support_ticket WHERE id=$1`, [anonymousTicket])).rowCount, 0);
    assert.equal((await pool.query(`SELECT 1 FROM idempotency_record WHERE route='/support' AND resource_id=$1`, [anonymousTicket])).rowCount, 0);
    assert.equal((await pool.query(`SELECT 1 FROM side_effect_delivery WHERE payload->>'ticketId'=$1`, [anonymousTicket])).rowCount, 0);
    assert.equal((await pool.query(`SELECT 1 FROM support_ticket WHERE id=$1`, [unrelatedTicket])).rowCount, 1);

    // Simulate a restored backup: its old provider identity must be found and queued for normal erasure.
    await pool.query(`INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,true,'active',now(),now())`, [restored, issuer, subject, `${restored}@example.invalid`]);
    const ledger = (await readSuppressionLedger(pool)).filter(entry => entry.requestId === requestId);
    assert.equal(ledger.length, 1);
    const restore = await applyRestoreSuppression(pool, ledger, { key, limit: 10 });
    assert.deepEqual(restore, { matched: 1, queued: 1 });
    assert.deepEqual(await applyRestoreSuppression(pool, ledger, { key, limit: 10 }), { matched: 0, queued: 0 });
    const restoredRequest = await pool.query(`SELECT status FROM privacy_request WHERE owner_user_id=$1 AND type='deletion' ORDER BY requested_at DESC LIMIT 1`, [restored]);
    assert.equal(restoredRequest.rows[0].status, 'queued');
  } finally {
    if (blocked) await blocker.query('ROLLBACK').catch(() => {});
    blocker.release();
    await pool.query(`DELETE FROM privacy_deletion_suppression WHERE request_id IN (SELECT id FROM privacy_request WHERE owner_user_id=ANY($1::uuid[]))`, [[owner, restored]]).catch(() => {});
    await pool.query(`DELETE FROM privacy_deletion_object WHERE request_id IN (SELECT id FROM privacy_request WHERE owner_user_id=ANY($1::uuid[]))`, [[owner, restored]]).catch(() => {});
    await pool.query(`DELETE FROM audit_event WHERE resource_type='privacy_request' AND resource_id IN (SELECT id FROM privacy_request WHERE owner_user_id=ANY($1::uuid[]))`, [[owner, restored]]).catch(() => {});
    await pool.query(`DELETE FROM privacy_request WHERE owner_user_id=ANY($1::uuid[])`, [[owner, restored]]).catch(() => {});
    await pool.query(`DELETE FROM idempotency_record WHERE resource_id=ANY($1::uuid[])`, [[anonymousTicket, unrelatedTicket]]).catch(() => {});
    await pool.query(`DELETE FROM side_effect_delivery WHERE payload->>'ticketId'=ANY($1::text[])`, [[anonymousTicket, unrelatedTicket]]).catch(() => {});
    await pool.query(`DELETE FROM support_ticket WHERE id=ANY($1::uuid[])`, [[anonymousTicket, unrelatedTicket]]).catch(() => {});
    await pool.query(`DELETE FROM user_account WHERE id=ANY($1::uuid[])`, [[owner, restored]]).catch(() => {});
    await pool.end();
  }
});
