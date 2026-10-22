import {JournalService} from '../../api/dist/journal/service.js';
import { cleanupP08Fixtures } from '../../api/scripts/p08-fixture-cleanup.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { FilesystemExportStorage } from '../../../packages/media/dist/index.js';
import { createApp } from '../../api/dist/app.js';
import { ExportService } from '../../api/dist/exports/service.js';
import { effectivePlan } from '../../api/dist/workspace/entitlements.js';
import { CommandError } from '../../api/dist/http/problem.js';
import { processExportJob, purgeExpiredExports } from '../dist/exports.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = { skip: databaseUrl ? false : 'Set TEST_DATABASE_URL for API and worker export PostgreSQL acceptance.' };
const iso = value => new Date(value).toISOString();

test('PostgreSQL API and worker: owner-only raw/Pro jobs, analytics, replay, HTTP cache privacy and expiry purge', integration, async t => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 3000, query_timeout: 15000 }); pool.on('error', () => {});
  const suffix = randomUUID(), owner = randomUUID(), staff = randomUUID(), instrumentId = randomUUID(), metadataId = randomUUID();
  const journalIds = [], positionIds = [], snapshotIds = [], exportIds = [], entitlementId = randomUUID();
  const issuer = `https://p10.exports.${suffix}.invalid`; const storageRoot = await mkdtemp(path.join(tmpdir(), 'p10-export-'));
  const storage = new FilesystemExportStorage(storageRoot); await storage.initialize();
  const service = new ExportService(pool, storage, effectivePlan);
  let app;
  const user = id => pool.query(`INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,created_at,updated_at)
    VALUES($1,$2,$3,$4,true,'active',now(),now())`, [id, issuer, id, `${id}@example.invalid`]);
  const addJournal = async (id, title, { review = '', tag = 'export' } = {}) => {
    await pool.query(`INSERT INTO journal_entry(id,owner_user_id,title,thesis,notes,tags,review,revision,created_at,updated_at)
      VALUES($1,$2,$3,'private thesis',$4,$5,$6::jsonb,1,now(),now())`, [id, owner, title, '\t=1+1 private notes', [tag], JSON.stringify(review)]);
    journalIds.push(id);
  };
  const addPosition = async (journalId, state, { eligibility = 'eligible', costCoverage = 'complete', net = '5.00', r = '0.5000000000', risk = '10.00', expiration } = {}) => {
    const id = randomUUID(); positionIds.push(id);
    await pool.query(`INSERT INTO position(id,owner_user_id,private_journal_entry_id,state,plan,instrument_id,metadata_version_id,remaining_quantity,initial_risk,calculation_version,revision,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,'p10-test',1,now(),now())`, [id, owner, journalId, state,
      JSON.stringify({ asset: expiration?'option':'stock', strategy: expiration?'long_call':'long', quantity: 1, entryPrice: '10', ...(expiration?{expiration}:{}) }), instrumentId, metadataId, state === 'closed' ? 0 : 1, risk]);
    await pool.query(`UPDATE journal_entry SET position_id=$2 WHERE id=$1`, [journalId, id]);
    const leg = randomUUID();
    await pool.query(`INSERT INTO position_leg(id,position_id,instrument_id,metadata_version_id,side,quantity) VALUES($1,$2,$3,$4,'long',1)`, [leg, id, instrumentId, metadataId]);
    if (state === 'closed') {
      const snapshotId = randomUUID(); snapshotIds.push(snapshotId);
      await pool.query(`INSERT INTO outcome_snapshot(id,position_id,source_event_cutoff,calculation_version,eligibility,exclusions,net,r_multiple,cost_coverage,created_at)
        VALUES($1,$2,now(),'p10-test',$3,'{}'::jsonb,$4,$5,$6,now())`, [snapshotId, id, eligibility, net, r, costCoverage]);
    }
    return id;
  };
  try {
    await user(owner); await user(staff);
    await pool.query("INSERT INTO role_grant(id,user_id,role,grantor_user_id,reason,granted_at) VALUES($1,$2,'admin',$2,'Synthetic export isolation',now())",[randomUUID(),staff]);
    await pool.query(`INSERT INTO instrument(id,asset,vendor,vendor_id,venue,currency,enabled) VALUES($1,'stock','p10-export',$2,'TEST','USD',true)`, [instrumentId, suffix]);
    await pool.query(`INSERT INTO instrument_metadata_version(id,instrument_id,version,multiplier,tick_size,source_id) VALUES($1,$2,1,1,0.01,'p10-export')`, [metadataId, instrumentId]);
    await pool.query(`INSERT INTO subscription_entitlement(id,user_id,plan,limits,valid_from,valid_until) VALUES($1,$2,'pro','{}'::jsonb,now(),NULL)`, [entitlementId, owner]);
    const rawJournalId = randomUUID(); await addJournal(rawJournalId, '=raw title', { review: '@review' });
    const rawPositionId = await addPosition(rawJournalId, 'closed');
    const now = Date.now();
    await pool.query(`INSERT INTO position_event(id,position_id,type,received_at,claimed_at,quantity,price,details)
      VALUES($1,$2,'entry',$3,$3,1,10,'{}'::jsonb),($4,$2,'final_exit',$5,$5,1,15,'{}'::jsonb)`,
    [randomUUID(), rawPositionId, iso(now - 1000), randomUUID(), iso(now)]);

    const raw = await service.request(owner, `${suffix}-raw-export-key`, { kind: 'personal_raw' }); exportIds.push(raw.id);
    const replay = await service.request(owner, `${suffix}-raw-export-key`, { kind: 'personal_raw' }); assert.equal(replay.id, raw.id);
    await assert.rejects(service.request(owner, `${suffix}-raw-export-key`, { kind: 'journal_analytics' }), error => error instanceof CommandError && error.status === 409);
    await processExportJob(pool, storage, { jobId: raw.id });
    const downloaded = await service.download(owner, raw.id); const csv = downloaded.bytes.toString('utf8');
    assert.match(csv, /'\t=1\+1 private notes/); assert.match(csv, /'@review/); assert.match(csv, /position_leg/);
    assert.match(csv, /position_event/); assert.match(csv, /outcome_snapshot/);
    await assert.rejects(service.get(staff, raw.id), error => error instanceof CommandError && error.status === 404);
    await assert.rejects(service.download(staff, raw.id), error => error instanceof CommandError && error.status === 404);

    const completed = await service.get(owner, raw.id); assert.equal(completed.status, 'succeeded'); assert.ok(completed.expiresAt);
    const keyRow = await pool.query('SELECT object_key FROM export_job WHERE id=$1', [raw.id]); const objectKey = keyRow.rows[0].object_key;

    await t.test('analytical CSV matches journal outcome and review denominators', async () => {
      const jIncomplete = randomUUID(), jRetrospective = randomUUID(), jOpen = randomUUID(), jEducational = randomUUID();
      await addJournal(jIncomplete, 'incomplete'); await addPosition(jIncomplete, 'closed', { costCoverage: 'incomplete', net: null, r: null });
      await addJournal(jRetrospective, 'retrospective'); await addPosition(jRetrospective, 'closed', { eligibility: 'retrospective' });
      await addJournal(jOpen, 'open', { review: 'Reviewed while open' }); await addPosition(jOpen, 'entered');
      await addJournal(jEducational, 'educational');
      const job = await service.request(owner, `${suffix}-analytics-key`, { kind: 'journal_analytics', tags: ['export'] }); exportIds.push(job.id);
      await processExportJob(pool, storage, { jobId: job.id });
      const result = (await service.download(owner, job.id)).bytes.toString('utf8');
      assert.match(result, /"eligible_outcomes","1"/); assert.match(result, /"incomplete_costs","1"/);
      assert.match(result, /"wins","1"/); assert.match(result, /"mean_r","0\.5000000000"/); assert.match(result, /"r_denominator","1"/);
      assert.match(result, /"review_eligible","3"/); assert.match(result, /"review_completed","1"/);
      assert.match(result, /"excluded_educational","1"/); assert.match(result, /"excluded_retrospective","1"/);

      const emptyJob = await service.request(owner, `${suffix}-empty-analytics-key`, { kind: 'journal_analytics', tags: ['no-matching-tag'] }); exportIds.push(emptyJob.id);
      await processExportJob(pool, storage, { jobId: emptyJob.id });
      const emptyResult = (await service.download(owner, emptyJob.id)).bytes.toString('utf8');
      assert.match(emptyResult, /"eligible_outcomes","0"/);
      assert.match(emptyResult, /"reported_realized_pnl",""/);
    });

    await t.test('expired entered positions project unresolved consistently in journal and exported analysis',async()=>{
      const id=randomUUID();await addJournal(id,'Expired private option',{tag:'expired'});
      await addPosition(id,'entered',{expiration:new Date(Date.now()-86400000).toISOString()});
      const view=await new JournalService(pool).analytics(owner,{tag:'expired'});
      assert.equal(view.openPositions,0);assert.equal(view.excluded.unresolved,1);assert.equal(view.reviewEligible,1);
      const job=await service.request(owner,`${suffix}-expired-analysis-key`,{kind:'journal_analytics',tags:['expired']});exportIds.push(job.id);
      await processExportJob(pool,storage,{jobId:job.id});
      const csv=(await service.download(owner,job.id)).bytes.toString();assert.match(csv,/"excluded_unresolved","1"/);assert.match(csv,/"r_denominator","0"/);
    });

    await t.test('job pagination is bounded and cursors are owner-bound', async () => {
      const page = await service.list(owner, undefined, 1);
      assert.equal(page.items.length, 1); assert.ok(page.nextCursor);
      const next = await service.list(owner, page.nextCursor, 1);
      assert.equal(next.items.length, 1); assert.notEqual(next.items[0].id, page.items[0].id);
      await assert.rejects(service.list(staff, page.nextCursor, 1), error => error instanceof CommandError && error.status === 400);
      await assert.rejects(service.list(owner, undefined, 51), error => error instanceof CommandError && error.status === 400);
    });

    await t.test('authenticated HTTP download is no-store and refuses another owner', async () => {
      const auth = { authenticate: async req => ({ userId: req.headers['x-test-user'] }), assertCsrf: async () => {} };
      app = await createApp({ query: (...args) => pool.query(...args) }, null, { auth, exports: service });
      await app.listen(0, '127.0.0.1'); const address = app.getHttpServer().address();
      const base = `http://127.0.0.1:${address.port}/api/v1/exports/${raw.id}`;
      const own = await fetch(base, { headers: { 'x-test-user': owner } });
      assert.equal(own.status, 200); assert.equal(own.headers.get('cache-control'), 'no-store');
      const denied = await fetch(`${base}/download`, { headers: { 'x-test-user': staff } });
      assert.equal(denied.status, 404); assert.equal(denied.headers.get('cache-control'), 'no-store');
      const download = await fetch(`${base}/download`, { headers: { 'x-test-user': owner } });
      assert.equal(download.status, 200); assert.equal(download.headers.get('content-type'), 'text/csv; charset=utf-8');
      assert.match(await download.text(), /outcome_snapshot/);
    });

    await t.test('a worker with an older claim cannot publish after a newer lease takes over', async () => {
      const journalId = randomUUID(); await addJournal(journalId, 'stale lease');
      const staleJob = await service.request(owner, `${suffix}-stale-lease-key`, { kind: 'personal_raw' }); exportIds.push(staleJob.id);
      let changed = false;
      const fencedPool = { ...pool, connect: async () => {
        const client = await pool.connect();
        return { query: async (sql, values) => {
          const result = await client.query(sql, values);
          if (!changed && sql.includes('FROM journal_entry')) {
            changed = true;
            await pool.query('UPDATE export_job SET attempts=attempts+1,claimed_at=now() WHERE id=$1', [staleJob.id]);
          }
          return result;
        }, release: () => client.release() };
      } };
      let writes = 0;
      await processExportJob(fencedPool, { put: async () => { writes++; return `${staleJob.id}-a1.csv`; }, delete: async () => {} }, { jobId: staleJob.id });
      assert.equal(changed, true); assert.equal(writes, 0);
      const row = await pool.query('SELECT status,object_key,attempts FROM export_job WHERE id=$1', [staleJob.id]);
      assert.equal(row.rows[0].status, 'running'); assert.equal(row.rows[0].object_key, null); assert.equal(Number(row.rows[0].attempts), 2);
    });

    await t.test('downgrade hides analytical download and expiry purge deletes the object', async () => {
      await pool.query('UPDATE subscription_entitlement SET valid_until=now() WHERE id=$1', [entitlementId]);
      const analytics = await pool.query("SELECT id FROM export_job WHERE owner_user_id=$1 AND kind='journal_analytics' ORDER BY created_at DESC LIMIT 1", [owner]);
      if (analytics.rows[0]) await assert.rejects(service.download(owner, analytics.rows[0].id), error => error instanceof CommandError && error.status === 403);
      await pool.query('UPDATE export_job SET expires_at=now()-interval \'1 second\' WHERE id=$1', [raw.id]);
      await assert.rejects(service.download(owner, raw.id), error => error instanceof CommandError && error.status === 404);
      const failing = await purgeExpiredExports(pool, { delete: async () => { throw new Error('storage failure'); } });
      assert.equal(failing, 0);
      const retained = await pool.query('SELECT status,object_key FROM export_job WHERE id=$1', [raw.id]); assert.equal(retained.rows[0].status, 'succeeded'); assert.equal(retained.rows[0].object_key, objectKey);
      assert.equal(await purgeExpiredExports(pool, storage), 1);
      await assert.rejects(storage.read(objectKey));
      assert.equal((await pool.query('SELECT status,object_key FROM export_job WHERE id=$1', [raw.id])).rows[0].status, 'expired');
    });
  } finally {
    if (app) await app.close().catch(() => {});
    try { await cleanupP08Fixtures(pool,[owner,staff],[instrumentId]); } finally { await pool.end(); await rm(storageRoot, { recursive: true, force: true }); }
  }
});
