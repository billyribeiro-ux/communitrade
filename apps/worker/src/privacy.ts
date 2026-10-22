import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ARCHIVE_BYTES=50*1024*1024;
const MAX_ARCHIVE_ROWS=10_000;
const STALE_CLAIM_MS=5*60_000;
export interface PrivacyObjectStorage { deleteExport(key:string):Promise<void>; deleteMedia(key:string):Promise<void> }
export interface PrivacyWorkResult { processed:number; failed:number; objectsDeleted:number }
type JsonQuery={query(sql:string,values?:unknown[]):Promise<{rows:Array<Record<string,unknown>>}>};
type PrivacyJob={id:string;owner_user_id:string;status:string;stage:string;attempts:number;claim_token:string|null;claimed_at:Date|string|null};
type ObjectRow={request_id:string;object_kind:string;object_key:string;attempts:number};
function hmac(secret:string,issuer:string,subject:string):string{
  if(secret.length<32)throw new Error('PRIVACY_SUPPRESSION_KEY_REQUIRED');
  return createHmac('sha256',secret).update(`p13-subject-v1\0${issuer}\0${subject}`).digest('hex');
}
function safeError(e:unknown):string{return e instanceof Error&&/^[A-Z0-9_]{1,80}$/.test(e.message)?e.message:'PRIVACY_STAGE_FAILED';}

/** Builds a complete, owner-scoped JSON archive. Authentication secrets and raw object-store keys are excluded. */
export async function buildPersonalArchive(db:JsonQuery,ownerId:string,exportedAt=new Date()):Promise<Buffer>{
  if(!UUID.test(ownerId))throw new Error('INVALID_OWNER_ID');
  const sections:Record<string,Array<Record<string,unknown>>|Record<string,unknown>|null>={};
  let sectionBytes=0;
  const one=async(key:string,sql:string,params:unknown[]=[ownerId])=>{const r=await db.query(sql,params);sections[key]=r.rows[0]??null;};
  const many=async(key:string,sql:string,params:unknown[]=[ownerId])=>{const r=await db.query(`${sql} LIMIT ${MAX_ARCHIVE_ROWS+1}`,params);if(r.rows.length>MAX_ARCHIVE_ROWS)throw new Error('EXPORT_TOO_MANY_ROWS');sectionBytes+=Buffer.byteLength(JSON.stringify(r.rows));if(sectionBytes>MAX_ARCHIVE_BYTES)throw new Error('EXPORT_TOO_LARGE');sections[key]=r.rows;};
  await one('account',`SELECT id,email,email_verified,status,onboarding_version,declaration_version,policy_version,created_at,updated_at FROM user_account WHERE id=$1`);
  await many('profile',`SELECT handle,display_name,bio,interests,links,revision,created_at,updated_at FROM profile WHERE user_id=$1`);
  await many('policy_acceptances',`SELECT policy_slug,version,accepted_at FROM policy_acceptance WHERE user_id=$1`);
  await many('handle_history',`SELECT old_handle,changed_at,redirect_expires_at FROM handle_history WHERE user_id=$1`);
  await many('sessions',`SELECT issued_at,last_seen_at,expires_at,revoked_at,mfa_at,assurance FROM app_session WHERE user_id=$1`);
  await many('roles',`SELECT role,grantor_user_id,reason,granted_at FROM role_grant WHERE user_id=$1`);
  await many('drafts',`SELECT id,kind,title,thesis,plan,attachment_ids,revision,chart_revision,deleted_at,created_at,updated_at FROM draft WHERE owner_user_id=$1`);
  await many('private_charts',`SELECT id,draft_id,schema_version,state,provenance,revision,created_at FROM chart_state WHERE owner_user_id=$1 AND publication_version_id IS NULL`);
  await many('publications',`SELECT id,kind,original_version_id,current_version_id,visibility,published_at,created_at FROM publication WHERE author_user_id=$1`);
  await many('publication_versions',`SELECT v.* FROM publication_version v JOIN publication p ON p.id=v.publication_id WHERE p.author_user_id=$1 ORDER BY p.id,v.sequence`);
  await many('positions',`SELECT * FROM position WHERE owner_user_id=$1`);
  await many('position_legs',`SELECT l.* FROM position_leg l JOIN position p ON p.id=l.position_id WHERE p.owner_user_id=$1`);
  await many('position_events',`SELECT e.* FROM position_event e JOIN position p ON p.id=e.position_id WHERE p.owner_user_id=$1 ORDER BY e.received_at,e.id`);
  await many('outcome_snapshots',`SELECT s.* FROM outcome_snapshot s JOIN position p ON p.id=s.position_id WHERE p.owner_user_id=$1 ORDER BY s.created_at,s.id`);
  await many('journal',`SELECT * FROM journal_entry WHERE owner_user_id=$1`);
  await many('watchlists',`SELECT * FROM watchlist WHERE owner_user_id=$1`);
  await many('watchlist_items',`SELECT i.* FROM watchlist_item i JOIN watchlist w ON w.id=i.list_id WHERE w.owner_user_id=$1`);
  await many('saved_layouts',`SELECT * FROM saved_layout WHERE owner_user_id=$1`);
  await many('saved_searches',`SELECT * FROM saved_search WHERE owner_user_id=$1`);
  await many('preferences',`SELECT * FROM preference WHERE user_id=$1`);
  await many('notifications',`SELECT id,category,aggregation_key,internal_url,text,read_at,created_at FROM notification WHERE owner_user_id=$1`);
  await many('product_events',`SELECT event_name,source_key,properties,consent_version,created_at FROM product_event WHERE owner_user_id=$1`);
  await many('reactions',`SELECT * FROM reaction WHERE user_id=$1`);
  await many('follows',`SELECT * FROM follow WHERE follower_user_id=$1`);
  await many('bookmarks',`SELECT * FROM bookmark WHERE user_id=$1`);
  await many('mutes',`SELECT * FROM mute WHERE user_id=$1`);
  await many('reposts',`SELECT * FROM repost WHERE user_id=$1`);
  await many('comments',`SELECT * FROM comment WHERE author_user_id=$1 ORDER BY created_at,id`);
  await many('comment_edits',`SELECT h.* FROM comment_edit_history h JOIN comment c ON c.id=h.comment_id WHERE c.author_user_id=$1 ORDER BY h.changed_at,h.id`);
  await many('comment_mentions',`SELECT m.* FROM comment_mention m JOIN comment c ON c.id=m.comment_id WHERE c.author_user_id=$1`);
  await many('correction_requests',`SELECT * FROM correction_request WHERE author_user_id=$1`);
  await many('reports',`SELECT * FROM report WHERE reporter_user_id=$1`);
  await many('appeals',`SELECT * FROM appeal WHERE appellant_user_id=$1`);
  await many('media_metadata',`SELECT id,purpose,resource_id,version,dimensions,checksum,status,created_at FROM media WHERE owner_user_id=$1`);
  await many('exports',`SELECT id,kind,filters,status,expires_at,byte_size,created_at,updated_at,failure_code FROM export_job WHERE owner_user_id=$1`);
  await many('support_tickets',`SELECT * FROM support_ticket WHERE requester_user_id=$1`);
  await many('support_messages',`SELECT m.* FROM support_message m JOIN support_ticket t ON t.id=m.ticket_id WHERE t.requester_user_id=$1 ORDER BY m.created_at,m.id`);
  await many('privacy_requests',`SELECT id,type,status,hold_reason,hold_until,requested_at,due_at,completed_at,stage,created_at,updated_at FROM privacy_request WHERE owner_user_id=$1`);
  await many('billing_subscription',`SELECT id,provider_customer_id,provider_subscription_id,mode,provider_status,provider_version,paid_through,grace_until,plan,interval,current_period_start,current_period_end,cancel_at_period_end,canceled_at,provider_account,last_reconciled_at,reason FROM subscription WHERE user_id=$1`);
  await many('billing_entitlement',`SELECT plan,limits,valid_from,valid_until,provider_account,provider_mode FROM subscription_entitlement WHERE user_id=$1`);
  await many('billing_customer',`SELECT provider_account,mode,provider_customer_id,created_at,last_reconciled_at FROM billing_customer WHERE user_id=$1`);
  await many('billing_invoices',`SELECT id,provider_account,mode,provider_invoice_id,provider_subscription_id,status,amount_due,amount_paid,currency,created_at,period_start,period_end,payment_id FROM billing_invoice WHERE user_id=$1`);
  await many('billing_refunds',`SELECT id,provider_account,mode,provider_subscription_id,payment_id,provider_refund_id,amount,status,reason,created_at FROM billing_refund WHERE user_id=$1`);
  await many('billing_disputes',`SELECT id,provider_account,mode,provider_dispute_id,provider_subscription_id,payment_id,amount_minor,status,reason,created_at,resolved_at FROM billing_dispute WHERE user_id=$1`);
  await many('billing_operations',`SELECT id,kind,idempotency_key,request_hash,provider_account,mode,status,provider_ref,reason,attempts,created_at,updated_at FROM billing_operation WHERE user_id=$1`);
  await many('quota_usage',`SELECT metric,month_start,count,reserved_count,created_at,updated_at FROM quota_bucket WHERE user_id=$1`);
  await many('audit_activity',`SELECT resource_type,resource_id,action,reason,request_id,metadata,created_at FROM audit_event WHERE actor=$1`,[ownerId]);
  const archive={schemaVersion:1,exportedAt:exportedAt.toISOString(),accountId:ownerId,sections};
  const bytes=Buffer.from(JSON.stringify(archive,null,2));if(bytes.byteLength>MAX_ARCHIVE_BYTES)throw new Error('EXPORT_TOO_LARGE');return bytes;
}

export async function processPersonalArchive(pool:Pool,storage:{put(id:string,bytes:Uint8Array,attempt?:number,format?:'csv'|'json'):Promise<string>;delete(key:string):Promise<void>},payload:{jobId:string},retryCount=0,retryLimit=5,now=new Date()):Promise<void>{
  if(!payload||!UUID.test(String(payload.jobId))||Object.keys(payload).some(k=>k!=='jobId'))throw new Error('INVALID_PRIVACY_EXPORT_JOB');
  const c=await pool.connect();let job:{id:string;owner_user_id:string;status:string;attempts:number;claimed_at:Date|string|null}|undefined;let token=0;let claimed='';
  try{await c.query('BEGIN');const q=await c.query<PrivacyJob>(`SELECT id,owner_user_id,status,attempts,claimed_at FROM export_job WHERE id=$1 AND kind='personal_archive' FOR UPDATE`,[payload.jobId]);job=q.rows[0];if(!job||['succeeded','failed','expired'].includes(job.status)){await c.query('COMMIT');return;}if(job.status==='running'&&job.claimed_at&&new Date(job.claimed_at).getTime()>now.getTime()-STALE_CLAIM_MS){await c.query('COMMIT');return;}
    if(Number(job.attempts)>=retryLimit){await c.query(`UPDATE export_job SET status='failed',failure_code='EXPORT_ATTEMPTS_EXHAUSTED',claimed_at=NULL,updated_at=now() WHERE id=$1`,[job.id]);await c.query('COMMIT');return;}
    const active=await c.query(`SELECT 1 FROM user_account u WHERE u.id=$1 AND u.status='active' AND u.email_verified=true AND NOT EXISTS(SELECT 1 FROM privacy_request p WHERE p.owner_user_id=u.id AND p.type='deletion' AND p.status NOT IN ('completed','cancelled'))`,[job.owner_user_id]);if(!active.rowCount){await c.query(`UPDATE export_job SET status='failed',failure_code='ACCOUNT_UNAVAILABLE',claimed_at=NULL,updated_at=now() WHERE id=$1`,[job.id]);await c.query('COMMIT');return;}
    token=Number(job.attempts)+1;claimed=now.toISOString();await c.query(`UPDATE export_job SET status='running',attempts=$2,claimed_at=$3,failure_code=NULL,updated_at=now() WHERE id=$1`,[job.id,token,claimed]);await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}finally{c.release();}
  if(!job||!token)return;
  let bytes:Buffer;const snapshot=await pool.connect();try{await snapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');bytes=await buildPersonalArchive(snapshot,String(job.owner_user_id),now);await snapshot.query('COMMIT');}catch(e){await snapshot.query('ROLLBACK').catch(()=>undefined);await pool.query(`UPDATE export_job SET status=$4,claimed_at=NULL,failure_code=$5,updated_at=now() WHERE id=$1 AND status='running' AND attempts=$2 AND claimed_at=$3`,[job.id,token,claimed,retryCount<retryLimit?'pending':'failed',retryCount<retryLimit?null:safeError(e)]).catch(()=>undefined);if(retryCount<retryLimit)throw e;return;}finally{snapshot.release();}
  const f=await pool.connect();let tx=false;let key:string|undefined;
  try{await f.query('BEGIN');tx=true;const lock=await f.query(`SELECT status,owner_user_id,attempts,claimed_at FROM export_job WHERE id=$1 FOR UPDATE`,[job.id]);const current=lock.rows[0];if(!current||current.status!=='running'||Number(current.attempts)!==token||new Date(current.claimed_at).toISOString()!==claimed){await f.query('ROLLBACK');tx=false;return;}
    const active=await f.query(`SELECT 1 FROM user_account u WHERE u.id=$1 AND u.status='active' AND u.email_verified=true AND NOT EXISTS(SELECT 1 FROM privacy_request p WHERE p.owner_user_id=u.id AND p.type='deletion' AND p.status NOT IN ('completed','cancelled'))`,[job.owner_user_id]);if(!active.rowCount){await f.query(`UPDATE export_job SET status='failed',failure_code='ACCOUNT_UNAVAILABLE',claimed_at=NULL,updated_at=now() WHERE id=$1`,[job.id]);await f.query('COMMIT');tx=false;return;}
    key=await storage.put(String(job.id),bytes,token,'json');const expiry=new Date(now.getTime()+24*60*60_000).toISOString();const saved=await f.query(`UPDATE export_job SET status='succeeded',object_key=$4,expires_at=$5,byte_size=$6,checksum=$7,claimed_at=NULL,failure_code=NULL,updated_at=now() WHERE id=$1 AND status='running' AND attempts=$2 AND claimed_at=$3`,[job.id,token,claimed,key,expiry,bytes.byteLength,createHash('sha256').update(bytes).digest('hex')]);
    if(!saved.rowCount){await storage.delete(key).catch(()=>undefined);key=undefined;}await f.query('COMMIT');tx=false;
  }catch(e){if(tx)await f.query('ROLLBACK').catch(()=>undefined);if(key)await storage.delete(key).catch(()=>undefined);await pool.query(`UPDATE export_job SET status=$4,claimed_at=NULL,failure_code=$5,updated_at=now() WHERE id=$1 AND status='running' AND attempts=$2 AND claimed_at=$3`,[job.id,token,claimed,retryCount<retryLimit?'pending':'failed',retryCount<retryLimit?null:'EXPORT_PROCESSING_FAILED']).catch(()=>undefined);if(retryCount<retryLimit)throw e;}finally{if(tx)await f.query('ROLLBACK').catch(()=>undefined);f.release();}
}

/** One checkpoint per committed stage; storage deletes are idempotent and are checkpointed after acknowledgement. */
export async function runPrivacySweep(pool:Pool,storage:PrivacyObjectStorage,options:{suppressionKey:string;keyVersion?:string;limit?:number;now?:Date}):Promise<PrivacyWorkResult>{
  const {suppressionKey}=options;const keyVersion=options.keyVersion??'v1';const limit=Math.max(1,Math.min(50,options.limit??10));const now=options.now??new Date();if(suppressionKey.length<32)throw new Error('PRIVACY_SUPPRESSION_KEY_REQUIRED');
  await pool.query(`UPDATE privacy_request SET status='queued',hold_reason=NULL,hold_until=NULL,updated_at=$1 WHERE type='deletion' AND status='held' AND hold_until<=$1`,[now]);
  let processed=0,failed=0,objectsDeleted=0;
  for(let n=0;n<limit;n++){
    const c=await pool.connect();let r:PrivacyJob|undefined;const claim=randomUUID();
    try{await c.query('BEGIN');const q=await c.query<PrivacyJob>(`SELECT id,owner_user_id,status,stage,attempts,claim_token,claimed_at FROM privacy_request WHERE type='deletion' AND (status IN ('queued','processing','failed') OR (status='requested' AND due_at<=$1)) AND (claimed_at IS NULL OR claimed_at<$1-interval '5 minutes') ORDER BY due_at NULLS FIRST,requested_at FOR UPDATE SKIP LOCKED LIMIT 1`,[now]);r=q.rows[0];if(!r){await c.query('COMMIT');break;}await c.query(`UPDATE privacy_request SET status='processing',claimed_at=$2,claim_token=$3,attempts=attempts+1,updated_at=now() WHERE id=$1`,[r.id,now,claim]);await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}finally{c.release();}
    if(!r)break;
    try{
      let stage=r.stage;
      if(stage==='queued'||stage==='revoke'){
        const x=await pool.connect();try{await x.query('BEGIN');const lease=await x.query(`SELECT 1 FROM privacy_request WHERE id=$1 AND status='processing' AND claim_token=$2 FOR UPDATE`,[r.id,claim]);if(!lease.rowCount)throw new Error('PRIVACY_CLAIM_LOST');const u=await x.query(`SELECT oidc_issuer,oidc_subject FROM user_account WHERE id=$1 FOR UPDATE`,[r.owner_user_id]);if(u.rows[0]){const digest=hmac(suppressionKey,String(u.rows[0].oidc_issuer),String(u.rows[0].oidc_subject));await x.query(`INSERT INTO privacy_deletion_suppression(subject_hmac,key_version,request_id) VALUES($1,$2,$3) ON CONFLICT(subject_hmac) DO NOTHING`,[digest,keyVersion,r.id]);await x.query(`UPDATE user_account SET status='deleting',updated_at=now() WHERE id=$1`,[r.owner_user_id]);await x.query(`UPDATE app_session SET revoked_at=coalesce(revoked_at,now()) WHERE user_id=$1`,[r.owner_user_id]);}await x.query(`UPDATE privacy_request SET stage='inventory',progress=jsonb_set(progress,'{revoked}','true'::jsonb,true),failed_stage=NULL WHERE id=$1 AND claim_token=$2`,[r.id,claim]);await x.query('COMMIT');}catch(e){await x.query('ROLLBACK').catch(()=>undefined);throw e;}finally{x.release();}stage='inventory';
      }
      if(stage==='inventory'){
        await pool.query(`INSERT INTO privacy_deletion_object(request_id,object_kind,object_key) SELECT $1,'export',object_key FROM export_job WHERE owner_user_id=$2 AND object_key IS NOT NULL ON CONFLICT DO NOTHING`,[r.id,r.owner_user_id]);
        await pool.query(`INSERT INTO privacy_deletion_object(request_id,object_kind,object_key) SELECT $1,'quarantine',quarantine_key FROM media WHERE owner_user_id=$2 AND quarantine_key IS NOT NULL ON CONFLICT DO NOTHING`,[r.id,r.owner_user_id]);
        await pool.query(`INSERT INTO privacy_deletion_object(request_id,object_kind,object_key) SELECT $1,'processed_media',processed_key FROM media WHERE owner_user_id=$2 AND processed_key IS NOT NULL ON CONFLICT DO NOTHING`,[r.id,r.owner_user_id]);
        await pool.query(`INSERT INTO privacy_deletion_object(request_id,object_kind,object_key) SELECT $1,'publication_snapshot',snapshot_object_key FROM publication_job pj WHERE pj.owner_user_id=$2 AND snapshot_object_key IS NOT NULL ON CONFLICT DO NOTHING`,[r.id,r.owner_user_id]);
        await pool.query(`UPDATE privacy_request SET stage='objects',progress=jsonb_set(progress,'{objectsInventoried}','true'::jsonb,true) WHERE id=$1 AND status='processing' AND claim_token=$2`,[r.id,claim]);stage='objects';
      }
      if(stage==='objects'){
        const rows=await pool.query<ObjectRow>(`SELECT request_id,object_kind,object_key,attempts FROM privacy_deletion_object WHERE request_id=$1 AND status IN ('pending','failed') ORDER BY created_at LIMIT 100`,[r.id]);
        for(const o of rows.rows){try{const lease=await pool.query(`SELECT 1 FROM privacy_request WHERE id=$1 AND status='processing' AND claim_token=$2`,[r.id,claim]);if(!lease.rowCount)throw new Error('PRIVACY_CLAIM_LOST');if(o.object_kind==='export')await storage.deleteExport(o.object_key);else await storage.deleteMedia(o.object_key);await pool.query(`UPDATE privacy_deletion_object SET status='deleted',deleted_at=now(),last_error_code=NULL,attempts=attempts+1,updated_at=now() WHERE request_id=$1 AND object_kind=$2 AND object_key=$3 AND EXISTS(SELECT 1 FROM privacy_request WHERE id=$1 AND status='processing' AND claim_token=$4)`,[r.id,o.object_kind,o.object_key,claim]);objectsDeleted++;}catch(e){await pool.query(`UPDATE privacy_deletion_object SET status='failed',attempts=attempts+1,last_error_code=$4,updated_at=now() WHERE request_id=$1 AND object_kind=$2 AND object_key=$3 AND EXISTS(SELECT 1 FROM privacy_request WHERE id=$1 AND status='processing' AND claim_token=$5)`,[r.id,o.object_kind,o.object_key,safeError(e),claim]);throw e;}}
        const remaining=await pool.query(`SELECT 1 FROM privacy_deletion_object WHERE request_id=$1 AND status<>'deleted' LIMIT 1`,[r.id]);if(remaining.rowCount)throw new Error('PRIVACY_OBJECTS_REMAIN');
        await pool.query(`UPDATE privacy_request SET stage='private_data',progress=jsonb_set(progress,'{objectsErased}','true'::jsonb,true) WHERE id=$1 AND status='processing' AND claim_token=$2`,[r.id,claim]);stage='private_data';
      }
      if(stage==='private_data'){
        const c=await pool.connect();try{await c.query('BEGIN');const lease=await c.query(`SELECT 1 FROM privacy_request WHERE id=$1 AND status='processing' AND claim_token=$2 AND stage='private_data' FOR UPDATE`,[r.id,claim]);if(!lease.rowCount)throw new Error('PRIVACY_CLAIM_LOST');await c.query(`WITH owned(id) AS (SELECT id FROM draft WHERE owner_user_id=$1 UNION SELECT id FROM publication WHERE author_user_id=$1 UNION SELECT id FROM position WHERE owner_user_id=$1 UNION SELECT id FROM journal_entry WHERE owner_user_id=$1 UNION SELECT id FROM comment WHERE author_user_id=$1 UNION SELECT id FROM watchlist WHERE owner_user_id=$1 UNION SELECT id FROM saved_layout WHERE owner_user_id=$1 UNION SELECT id FROM media WHERE owner_user_id=$1 UNION SELECT id FROM export_job WHERE owner_user_id=$1 UNION SELECT id FROM support_ticket WHERE requester_user_id=$1 UNION SELECT id FROM publication_job WHERE owner_user_id=$1) DELETE FROM outbox_event e WHERE e.aggregate_id IN (SELECT id FROM owned) OR (e.aggregate_type IN ('user_account','profile') AND e.aggregate_id=$1) OR (e.aggregate_type='privacy_request' AND e.aggregate_id=$2)`,[r.owner_user_id,r.id]);await c.query(`DELETE FROM idempotency_record WHERE actor_key=$1`,[r.owner_user_id]);await c.query(`DELETE FROM notification WHERE owner_user_id=$1`,[r.owner_user_id]);await c.query(`DELETE FROM saved_search WHERE owner_user_id=$1`,[r.owner_user_id]);await c.query(`DELETE FROM product_event WHERE owner_user_id=$1`,[r.owner_user_id]);await c.query(`DELETE FROM preference WHERE user_id=$1`,[r.owner_user_id]);await c.query(`DELETE FROM saved_layout WHERE owner_user_id=$1`,[r.owner_user_id]);await c.query(`DELETE FROM watchlist_item WHERE list_id IN(SELECT id FROM watchlist WHERE owner_user_id=$1)`,[r.owner_user_id]);await c.query(`DELETE FROM watchlist WHERE owner_user_id=$1`,[r.owner_user_id]);await c.query(`DELETE FROM support_access_grant WHERE owner_user_id=$1 OR ticket_id IN(SELECT id FROM support_ticket WHERE requester_user_id=$1 OR (requester_user_id IS NULL AND requester_email=(SELECT email FROM user_account WHERE id=$1 AND email_verified=true)))`,[r.owner_user_id]);await c.query(`DELETE FROM idempotency_record WHERE route='/support' AND resource_id IN(SELECT id FROM support_ticket WHERE requester_user_id=$1 OR (requester_user_id IS NULL AND requester_email=(SELECT email FROM user_account WHERE id=$1 AND email_verified=true)))`,[r.owner_user_id]);await c.query(`DELETE FROM side_effect_delivery WHERE owner_user_id=$1 OR payload->>'ticketId' IN(SELECT id::text FROM support_ticket WHERE requester_user_id=$1 OR (requester_user_id IS NULL AND requester_email=(SELECT email FROM user_account WHERE id=$1 AND email_verified=true)))`,[r.owner_user_id]);await c.query(`DELETE FROM support_message WHERE ticket_id IN(SELECT id FROM support_ticket WHERE requester_user_id=$1 OR (requester_user_id IS NULL AND requester_email=(SELECT email FROM user_account WHERE id=$1 AND email_verified=true)))`,[r.owner_user_id]);await c.query(`DELETE FROM support_ticket WHERE requester_user_id=$1 OR (requester_user_id IS NULL AND requester_email=(SELECT email FROM user_account WHERE id=$1 AND email_verified=true))`,[r.owner_user_id]);await c.query(`DELETE FROM export_job WHERE owner_user_id=$1`,[r.owner_user_id]);await c.query(`DELETE FROM media WHERE owner_user_id=$1`,[r.owner_user_id]);await c.query(`DELETE FROM profile WHERE user_id=$1`,[r.owner_user_id]);await c.query(`DELETE FROM handle_history WHERE user_id=$1`,[r.owner_user_id]);await c.query(`DELETE FROM reaction WHERE user_id=$1`,[r.owner_user_id]);await c.query(`DELETE FROM follow WHERE follower_user_id=$1`,[r.owner_user_id]);await c.query(`DELETE FROM bookmark WHERE user_id=$1`,[r.owner_user_id]);await c.query(`DELETE FROM mute WHERE user_id=$1 OR author_id=$1`,[r.owner_user_id]);await c.query(`DELETE FROM repost WHERE user_id=$1`,[r.owner_user_id]);await c.query(`DELETE FROM comment_mention WHERE comment_id IN(SELECT id FROM comment WHERE author_user_id=$1)`,[r.owner_user_id]);await c.query(`DELETE FROM comment_edit_history WHERE comment_id IN(SELECT id FROM comment WHERE author_user_id=$1)`,[r.owner_user_id]);await c.query(`UPDATE comment SET body='',tag=NULL,deleted_at=coalesce(deleted_at,now()),edited_at=now() WHERE author_user_id=$1`,[r.owner_user_id]);await c.query(`UPDATE correction_request SET reason='[redacted]',proposal='{}'::jsonb,review_reason=NULL WHERE author_user_id=$1`,[r.owner_user_id]);await c.query(`UPDATE report SET reporter_user_id=NULL WHERE reporter_user_id=$1`,[r.owner_user_id]);await c.query(`UPDATE appeal SET appellant_user_id=NULL WHERE appellant_user_id=$1`,[r.owner_user_id]);await c.query(`DELETE FROM chart_state WHERE owner_user_id=$1 AND publication_version_id IS NULL`,[r.owner_user_id]);
          // Published version history and audit/billing records are retained under their documented purposes. Hide their public derivative and remove private trading trees.
          await c.query(`DELETE FROM outcome_snapshot WHERE position_id IN(SELECT id FROM position WHERE owner_user_id=$1)`,[r.owner_user_id]);await c.query(`DELETE FROM position_leg WHERE position_id IN(SELECT id FROM position WHERE owner_user_id=$1)`,[r.owner_user_id]);await c.query(`SELECT set_config('app.privacy_erasure_request',$1,true)`,[r.id]);await c.query(`DELETE FROM position_event WHERE position_id IN(SELECT id FROM position WHERE owner_user_id=$1)`,[r.owner_user_id]);await c.query(`DELETE FROM position WHERE owner_user_id=$1`,[r.owner_user_id]);await c.query(`DELETE FROM journal_entry WHERE owner_user_id=$1`,[r.owner_user_id]);await c.query(`DELETE FROM draft WHERE owner_user_id=$1`,[r.owner_user_id]);await c.query(`DELETE FROM publication_job WHERE owner_user_id=$1`,[r.owner_user_id]);await c.query(`UPDATE privacy_request SET stage='public_derivatives',progress=jsonb_set(progress,'{privateDataErased}','true'::jsonb,true) WHERE id=$1 AND status='processing' AND claim_token=$2`,[r.id,claim]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}finally{c.release();}stage='public_derivatives';
      }
      if(stage==='public_derivatives'){
        const c=await pool.connect();try{await c.query('BEGIN');const lease=await c.query(`SELECT 1 FROM privacy_request WHERE id=$1 AND status='processing' AND claim_token=$2 AND stage='public_derivatives' FOR UPDATE`,[r.id,claim]);if(!lease.rowCount)throw new Error('PRIVACY_CLAIM_LOST');await c.query(`SELECT set_config('app.privacy_erasure_request',$1,true)`,[r.id]);await c.query(`UPDATE publication_version v SET terms=privacy_redacted_publication_terms(v.terms),thesis=NULL,chart=NULL,disclosures='{}'::jsonb FROM publication p WHERE p.id=v.publication_id AND p.author_user_id=$1`,[r.owner_user_id]);await c.query(`UPDATE chart_state cs SET state='{"redacted":"privacy_erasure"}'::jsonb,provenance='{"redacted":"privacy_erasure"}'::jsonb WHERE cs.publication_version_id IN(SELECT v.id FROM publication_version v JOIN publication p ON p.id=v.publication_id WHERE p.author_user_id=$1)`,[r.owner_user_id]);await c.query(`UPDATE publication SET visibility='removed' WHERE author_user_id=$1`,[r.owner_user_id]);await c.query(`UPDATE privacy_request SET stage='identity',progress=jsonb_set(jsonb_set(progress,'{publicDerivativesHidden}','true'::jsonb,true),'{publicationPersonalTextRedacted}','true'::jsonb,true) WHERE id=$1 AND status='processing' AND claim_token=$2`,[r.id,claim]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}finally{c.release();}stage='identity';
      }
      if(stage==='identity'){
        const c=await pool.connect();try{await c.query('BEGIN');const lease=await c.query(`SELECT 1 FROM privacy_request WHERE id=$1 AND status='processing' AND claim_token=$2 AND stage='identity' FOR UPDATE`,[r.id,claim]);if(!lease.rowCount)throw new Error('PRIVACY_CLAIM_LOST');await c.query(`UPDATE app_session SET revoked_at=coalesce(revoked_at,now()) WHERE user_id=$1`,[r.owner_user_id]);await c.query(`UPDATE user_account SET oidc_issuer='deleted.invalid',oidc_subject=$2,email=NULL,email_verified=false,status='deleted',onboarding_version=NULL,declaration_version=NULL,policy_version=NULL,updated_at=now() WHERE id=$1`,[r.owner_user_id,`deleted-${r.id}`]);await c.query(`UPDATE privacy_request SET status='completed',stage='complete',request_reason=NULL,hold_reason=NULL,admin_reason=NULL,completed_at=now(),claimed_at=NULL,claim_token=NULL,failed_stage=NULL,progress=jsonb_build_object('completed',true,'identityErased',true),updated_at=now() WHERE id=$1 AND status='processing' AND claim_token=$2`,[r.id,claim]);await c.query(`INSERT INTO audit_event(id,actor,resource_type,resource_id,action,reason,metadata,created_at) VALUES($1,'system:privacy-worker','privacy_request',$2,'privacy.deletion.completed','P13 staged personal-data deletion',jsonb_build_object('requestId',$3::text),now())`,[randomUUID(),r.id,r.id]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK').catch(()=>undefined);throw e;}finally{c.release();}
      }
      processed++;
    }catch(e){failed++;await pool.query(`UPDATE privacy_request SET status='failed',failed_stage=stage,claimed_at=NULL,claim_token=NULL,progress=jsonb_set(progress,'{lastFailureCode}',to_jsonb($2::text),true),updated_at=now() WHERE id=$1 AND status='processing' AND claim_token=$3`,[r.id,safeError(e),claim]).catch(()=>undefined);}
  }
  return {processed,failed,objectsDeleted};
}

/** Restore drill input is an exported suppression ledger; exact HMAC matches are queued for normal erasure. */
export async function applyRestoreSuppression(pool:Pool,entries:Array<{subjectHmac:string;keyVersion:string;requestId:string}>,options:{key:string;limit?:number}):Promise<{matched:number;queued:number}>{
  const limit=options.limit??100;if(options.key.length<32||!Array.isArray(entries)||entries.length>100_000||!Number.isInteger(limit)||limit<1||limit>10_000)throw new Error('INVALID_SUPPRESSION_LEDGER');
  const clean=entries.filter(x=>/^[0-9a-f]{64}$/.test(x.subjectHmac)&&/^v[0-9]+$/.test(x.keyVersion)&&UUID.test(x.requestId));if(clean.length!==entries.length)throw new Error('INVALID_SUPPRESSION_LEDGER');
  const client=await pool.connect();let matched=0,queued=0;
  try{
    await client.query('BEGIN');
    for(const entry of clean)await client.query(`INSERT INTO privacy_deletion_suppression(subject_hmac,key_version,request_id) VALUES($1,$2,$3) ON CONFLICT(subject_hmac) DO NOTHING`,[entry.subjectHmac,entry.keyVersion,entry.requestId]);
    const candidates=await client.query<{id:string;oidc_issuer:string;oidc_subject:string}>(`SELECT id,oidc_issuer,oidc_subject FROM user_account WHERE status IN ('active','suspended') ORDER BY id LIMIT 100001 FOR UPDATE`);
    if(candidates.rows.length>100000)throw new Error('RESTORE_POPULATION_REQUIRES_PAGINATED_DRILL');
    const digests=new Map(clean.map(entry=>[entry.subjectHmac,entry]));
    for(const candidate of candidates.rows){
      if(matched>=limit)break;
      const entry=digests.get(hmac(options.key,candidate.oidc_issuer,candidate.oidc_subject));if(!entry)continue;
      matched++;const id=candidate.id;
      const existing=await client.query<{id:string}>(`SELECT id FROM privacy_request WHERE owner_user_id=$1 AND type='deletion' AND status NOT IN ('completed','cancelled') ORDER BY requested_at DESC LIMIT 1 FOR UPDATE`,[id]);
      let requestId=existing.rows[0]?.id;
      if(requestId){
        await client.query(`UPDATE privacy_request SET status='queued',due_at=now(),hold_reason=NULL,hold_until=NULL,updated_at=now() WHERE id=$1`,[requestId]);
      }else{
        requestId=randomUUID();
        await client.query(`INSERT INTO privacy_request(id,owner_user_id,type,status,requested_at,due_at,stage,progress,created_at,updated_at) VALUES($1,$2,'deletion','queued',now(),now(),'revoke',jsonb_build_object('restoreSuppression',true),now(),now())`,[requestId,id]);
      }
      await client.query(`UPDATE user_account SET status='deleting',updated_at=now() WHERE id=$1`,[id]);
      await client.query(`UPDATE app_session SET revoked_at=coalesce(revoked_at,now()) WHERE user_id=$1`,[id]);
      await client.query(`UPDATE privacy_deletion_suppression SET request_id=$3 WHERE subject_hmac=$1 AND request_id=$2`,[entry.subjectHmac,entry.requestId,requestId]);
      await client.query(`INSERT INTO outbox_event(id,event_type,aggregate_type,aggregate_id,revision,payload,status,available_at,attempts,created_at) VALUES($1,'privacy.deletion','privacy_request',$2,1,$3::jsonb,'pending',now(),0,now()) ON CONFLICT(event_type,aggregate_type,aggregate_id,revision) DO NOTHING`,[randomUUID(),requestId,JSON.stringify({requestId})]);
      queued++;
    }
    await client.query('COMMIT');return {matched,queued};
  }catch(e){await client.query('ROLLBACK').catch(()=>undefined);throw e;}finally{client.release();}
}

export async function readSuppressionLedger(pool:Pool):Promise<Array<{subjectHmac:string;keyVersion:string;requestId:string}>>{
  const result=await pool.query<{subject_hmac:string;key_version:string;request_id:string}>(`SELECT subject_hmac,key_version,request_id FROM privacy_deletion_suppression ORDER BY created_at,subject_hmac`);
  return result.rows.map(r=>({subjectHmac:r.subject_hmac,keyVersion:r.key_version,requestId:r.request_id}));
}
