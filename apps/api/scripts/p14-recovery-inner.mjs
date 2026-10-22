import pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, rm, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const { Pool } = pg;
const base = new URL(process.env.DATABASE_URL);
const phase = process.env.P14_PHASE;
const sourceDb = process.env.P14_SOURCE_DB;
const restoreDb = process.env.P14_RESTORE_DB;
const runId = process.env.P14_RUN_ID ?? '';
if (!/^[a-f0-9]{20}$/.test(runId) || sourceDb !== `p14_source_${runId}` || restoreDb !== `p14_restore_${runId}`) throw new Error('GENERATED_RECOVERY_DATABASE_GUARD_FAILED');
const objectRoot = resolve('/tmp', 'p14-recovery-' + process.env.P14_RUN_ID);
const sourceObjects = resolve(objectRoot, 'source');
const checkpointObjects = resolve(objectRoot, 'checkpoint');
const restoredObjects = resolve(objectRoot, 'restored');
const dbUrl = name => { const u = new URL(base); u.pathname = '/' + name; return u.href; };
const poolFor = name => new Pool({ connectionString: dbUrl(name), max: 4, connectionTimeoutMillis: 5000, query_timeout: 30000 });
const apiCwd = '/workspace';
if (phase === 'migrate-seed') {
  for (const command of ['db:migrate','db:seed']) {
    const result = spawnSync('pnpm', [command], { cwd: apiCwd, env: { ...process.env, DATABASE_URL: dbUrl(sourceDb) }, stdio: 'inherit' });
    if (result.status !== 0) throw new Error('ISOLATED_MIGRATION_OR_SEED_FAILED');
  }
  process.exit(0);
}
const { runPrivacySweep, readSuppressionLedger, applyRestoreSuppression } = await import('/workspace/apps/worker/dist/privacy.js');
const source = poolFor(sourceDb);
const restored = poolFor(restoreDb);
const objectStorage = root => ({
  deleteExport: async key => rm(resolve(root, 'exports', key), { force: true }),
  deleteMedia: async key => rm(resolve(root, 'media', key), { force: true }),
});
const sourceStorage = objectStorage(sourceObjects);
const restoredStorage = objectStorage(restoredObjects);
const output = {};
try {
 if (phase === 'prepare') {
   const {AuthService,authConfigFromEnv}=await import('/workspace/apps/api/dist/auth/service.js');
   const auth=new AuthService(source,authConfigFromEnv(process.env));
   await mkdir(resolve(sourceObjects, 'media'), { recursive: true });
   await mkdir(resolve(checkpointObjects, 'media'), { recursive: true });
   const a = randomUUID(), b = randomUUID(), issuer = 'https://p14.' + process.env.P14_RUN_ID + '.invalid';
   const inst = await source.query("SELECT i.id,i.vendor_id,i.asset,m.version FROM instrument i JOIN instrument_metadata_version m ON m.instrument_id=i.id AND m.version=(SELECT max(x.version) FROM instrument_metadata_version x WHERE x.instrument_id=i.id) WHERE i.vendor='synthetic-fixture' AND i.asset='stock' ORDER BY i.id LIMIT 1");
   if (!inst.rowCount) throw new Error('SYNTHETIC_STOCK_FIXTURE_MISSING');
   const instrument = inst.rows[0];
   for (const [id, n] of [[a,1],[b,2]]) {
     await source.query(`INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,onboarding_version,created_at,updated_at) VALUES($1,$2,$3,$4,true,'active','p14-recovery',now(),now())`,[id,issuer,id,`${id}@example.invalid`]);
     await source.query(`INSERT INTO profile(user_id,handle,normalized_handle,display_name,bio,created_at,updated_at) VALUES($1,$2,$2,$3,$4,now(),now())`,[id,`p14${process.env.P14_RUN_ID.slice(0,8)}${n}`,`Synthetic P14 ${n}`,'Synthetic recovery fixture']);
     const sessionToken=createHash('sha256').update(`p14-session:${runId}:${id}`).digest('base64url');
     const tokenHash=createHash('sha256').update(sessionToken).digest('hex');
     await source.query(`INSERT INTO app_session(id,token_hash,user_id,issued_at,last_seen_at,expires_at) VALUES($1,$2,$3,now(),now(),now()+interval '1 day')`,[randomUUID(),tokenHash,id]);
   }
   const pub=randomUUID(), ver=randomUUID(), chartState=randomUUID(), journal=randomUUID(), mediaId=randomUUID();
   const chart={instrumentId:instrument.id,metadataVersion:Number(instrument.version),interval:'1d',session:'regular',adjustment:'unadjusted',viewport:{from:'2026-10-01T00:00:00.000Z',to:'2026-10-20T00:00:00.000Z'},provenance:{provider:'synthetic-fixture',asOf:'2026-10-20T00:00:00.000Z',delaySeconds:900,demo:true},drawings:[]};
   const terms={title:'P14 frozen synthetic publication',slug:'p14-frozen-synthetic-publication',plan:{asset:'stock',strategy:'long',instrumentId:instrument.id,quantity:'1',entryPrice:'100.00',initialStopPrice:'95.00'}};
   await source.query(`INSERT INTO publication(id,author_user_id,kind,original_version_id,current_version_id,visibility,published_at,created_at) VALUES($1,$2,'education',NULL,NULL,'private',NULL,now())`,[pub,a]);
   await source.query(`INSERT INTO publication_version(id,publication_id,sequence,previous_version_id,terms,thesis,chart,disclosures,created_at) VALUES($1,$2,1,NULL,$3::jsonb,$4,$5::jsonb,'{}'::jsonb,now())`,[ver,pub,JSON.stringify(terms),'Synthetic frozen thesis',JSON.stringify(chart)]);
   await source.query(`UPDATE publication SET original_version_id=$2,current_version_id=$2,visibility='public',published_at=now() WHERE id=$1`,[pub,ver]);
   await source.query(`INSERT INTO chart_state(id,owner_user_id,draft_id,publication_version_id,schema_version,state,provenance,created_at) VALUES($1,NULL,NULL,$2,1,$3::jsonb,$4::jsonb,now())`,[chartState,ver,JSON.stringify(chart),JSON.stringify(chart.provenance)]);
   await source.query(`INSERT INTO journal_entry(id,owner_user_id,title,thesis,notes,tags,revision,created_at,updated_at) VALUES($1,$2,'Private P14 journal','Private thesis','PRIVATE_SENTINEL_P14',ARRAY['synthetic'],1,now(),now())`,[journal,a]);
   const objectKey=`${mediaId}/processed.webp`;
   const bytes=Buffer.from('P14 synthetic object bytes');
   const objectHash=createHash('sha256').update(bytes).digest('hex');
   await mkdir(dirname(resolve(sourceObjects,'media',objectKey)),{recursive:true});
   await mkdir(dirname(resolve(checkpointObjects,'media',objectKey)),{recursive:true});
   await writeFile(resolve(sourceObjects,'media',objectKey),bytes);
   await writeFile(resolve(checkpointObjects,'media',objectKey),bytes);
   await source.query(`INSERT INTO media(id,owner_user_id,purpose,version,quarantine_key,status,processed_key,checksum,created_at,updated_at) VALUES($1,$2,'avatar',1,$3,'ready',$4,$5,now(),now())`,[mediaId,a,`${mediaId}/quarantine.bin`,objectKey,objectHash]);
   await source.query(`INSERT INTO privacy_request(id,owner_user_id,type,status,requested_at,due_at,stage,progress,request_reason,created_at,updated_at) VALUES($1,$2,'deletion','queued',now(),now(),'queued','{}'::jsonb,'P14 local recovery rehearsal',now(),now())`,[randomUUID(),a]);
   const sessionToken=createHash('sha256').update(`p14-session:${runId}:${a}`).digest('base64url');
   await auth.authenticate({headers:{cookie:`tc_session_dev=${sessionToken}`}});
   await source.query(`CREATE TABLE p14_recovery_watermark(id text PRIMARY KEY,committed_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
   const mark=await source.query(`INSERT INTO p14_recovery_watermark(id) VALUES('checkpoint') RETURNING committed_at`);
   output.ownerA=a; output.ownerB=b; output.publicationId=pub; output.versionId=ver; output.journalId=journal; output.objectKey=objectKey; output.objectHash=objectHash;
   output.checkpointCommittedAt=new Date(mark.rows[0].committed_at).toISOString();
   output.baselineCounts=(await source.query(`SELECT (SELECT count(*) FROM publication_version WHERE publication_id=$1)::int AS versions,(SELECT count(*) FROM journal_entry WHERE id=$2)::int AS private_rows`,[pub,journal])).rows[0];
 }
 if (phase === 'post-checkpoint') {
   const mark=await source.query(`INSERT INTO p14_recovery_watermark(id) VALUES('post-checkpoint') RETURNING committed_at`);
   output.postCheckpointCommittedAt=new Date(mark.rows[0].committed_at).toISOString();
 }
 if (phase === 'erase-and-export') {
   for(let i=0;i<30;i++){const r=await runPrivacySweep(source,sourceStorage,{suppressionKey:process.env.PRIVACY_SUPPRESSION_KEY||process.env.SESSION_SECRET,limit:20});if(r.failed)throw new Error('SOURCE_ERASURE_FAILED');const s=await source.query("SELECT status FROM privacy_request WHERE owner_user_id=$1 AND type='deletion' ORDER BY requested_at DESC LIMIT 1",[process.env.P14_OWNER_A]);if(s.rows[0]?.status==='completed')break;if(i===29)throw new Error('SOURCE_ERASURE_DID_NOT_COMPLETE');}
   output.ledger=await readSuppressionLedger(source);
   if(!output.ledger.length)throw new Error('SUPPRESSION_LEDGER_EMPTY');
 }
 if (phase === 'restore-and-verify') {
   const {AuthService,authConfigFromEnv}=await import('/workspace/apps/api/dist/auth/service.js');
   const auth=new AuthService(restored,authConfigFromEnv(process.env));
   const entries=JSON.parse(Buffer.from(process.env.P14_LEDGER_B64,'base64').toString('utf8'));
   const savedObject=await import('node:fs/promises').then(fs=>fs.readFile(resolve(checkpointObjects,'media',process.env.P14_OBJECT_KEY)));
   const savedHash=createHash('sha256').update(savedObject).digest('hex');
   if(savedHash!==process.env.P14_OBJECT_HASH)throw new Error('CHECKPOINT_OBJECT_HASH_MISMATCH');
   await mkdir(dirname(resolve(restoredObjects,'media',process.env.P14_OBJECT_KEY)),{recursive:true});
   await writeFile(resolve(restoredObjects,'media',process.env.P14_OBJECT_KEY),savedObject);
   const applied=await applyRestoreSuppression(restored,entries,{key:process.env.PRIVACY_SUPPRESSION_KEY||process.env.SESSION_SECRET,limit:10000});
   if(applied.matched!==1||applied.queued!==1)throw new Error('RESTORED_SUPPRESSION_MATCH_COUNT');
   for(let i=0;i<30;i++){const r=await runPrivacySweep(restored,restoredStorage,{suppressionKey:process.env.PRIVACY_SUPPRESSION_KEY||process.env.SESSION_SECRET,limit:20});if(r.failed)throw new Error('RESTORED_ERASURE_FAILED');const s=await restored.query("SELECT status FROM privacy_request WHERE owner_user_id=$1 AND type='deletion' ORDER BY requested_at DESC LIMIT 1",[process.env.P14_OWNER_A]);if(s.rows[0]?.status==='completed')break;if(i===29)throw new Error('RESTORED_ERASURE_DID_NOT_COMPLETE');}
   const a=await restored.query(`SELECT u.status,u.email,(SELECT count(*) FROM app_session s WHERE s.user_id=u.id AND s.revoked_at IS NULL)::int AS live_sessions,(SELECT count(*) FROM journal_entry j WHERE j.owner_user_id=u.id)::int AS private_rows FROM user_account u WHERE u.id=$1`,[process.env.P14_OWNER_A]);
   const sessionToken=createHash('sha256').update(`p14-session:${runId}:${process.env.P14_OWNER_A}`).digest('base64url');
   let authRejected=false;
   try { await auth.authenticate({headers:{cookie:`tc_session_dev=${sessionToken}`}}); } catch(error) { authRejected=error?.status===401&&error?.code==='SESSION_EXPIRED'; }
   if(!authRejected)throw new Error('RESTORED_AUTHENTICATION_WAS_NOT_REJECTED');
   const b=await restored.query(`SELECT u.status,(SELECT count(*) FROM profile p WHERE p.user_id=u.id)::int AS profiles FROM user_account u WHERE u.id=$1`,[process.env.P14_OWNER_B]);
   const p=await restored.query(`SELECT p.visibility,v.sequence,v.terms->'plan'->>'quantity' AS quantity,v.thesis,v.chart FROM publication p JOIN publication_version v ON v.id=p.current_version_id WHERE p.id=$1`,[process.env.P14_PUBLICATION]);
   const o=await access(resolve(restoredObjects,'media',process.env.P14_OBJECT_KEY)).then(()=>true,()=>false);
   const watermark=await restored.query(`SELECT id,committed_at FROM p14_recovery_watermark ORDER BY id`);
   if(watermark.rowCount!==1||watermark.rows[0].id!=='checkpoint'||new Date(watermark.rows[0].committed_at).toISOString()!==process.env.P14_CHECKPOINT_WATERMARK)throw new Error('RESTORED_COMMITTED_DATA_WATERMARK_MISMATCH');
   if(a.rows[0]?.status!=='deleted'||a.rows[0]?.email!==null||a.rows[0]?.live_sessions!==0||a.rows[0]?.private_rows!==0)throw new Error('RESTORED_OWNER_ACCESS_OR_PRIVATE_DATA_REMAINS');
   if(b.rows[0]?.status!=='active'||b.rows[0]?.profiles!==1)throw new Error('UNRELATED_OWNER_NOT_PRESERVED');
   if(p.rows[0]?.visibility!=='removed'||Number(p.rows[0]?.sequence)!==1||p.rows[0]?.quantity!=='1'||p.rows[0]?.thesis!==null||p.rows[0]?.chart!==null)throw new Error('FROZEN_HISTORY_OR_PUBLIC_DERIVATIVE_CHECK_FAILED');
   if(o)throw new Error('ERASED_OBJECT_REMAINS');
   output.snapshotObjectSha256=savedHash;
   output.checks={restoredAuthServiceRejectedSession:authRejected,restoredSessionRevoked:a.rows[0].live_sessions===0,privateJournalRemoved:a.rows[0].private_rows===0,publicDerivativeRemoved:p.rows[0].visibility==='removed',personalTextRedacted:p.rows[0].thesis===null,immutableFinancialTermsPreserved:p.rows[0].quantity==='1',otherOwnerPreserved:b.rows[0].status==='active',checkpointObjectHashVerified:savedHash===process.env.P14_OBJECT_HASH,objectRemoved:!o,postCheckpointWatermarkAbsent:true};
 }
 if (phase === 'cleanup-objects') await rm(objectRoot,{recursive:true,force:true});
 process.stdout.write(JSON.stringify(output));
} finally { await source.end(); await restored.end(); }
