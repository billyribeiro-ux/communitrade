import { billingEntitlementScope, billingEntitlementPredicate } from '@trading/config';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {components} from '@trading/contracts';
import {CommandError} from '../http/problem.js';
import {appendOutbox,executeIdempotentCommand,requireUuid,withActorTransaction,type Transaction,type Json} from '../persistence/transactions.js';
type Kind='email'|'notification'|'media'|'publication'|'export'|'outbox';
const kinds:Kind[]=['email','notification','media','publication','export','outbox'];
const iso=(v:Date|string)=>new Date(v).toISOString();
async function admin(tx:Transaction,user:string){const role=await tx.query("SELECT id FROM role_grant WHERE user_id=$1 AND role='admin' FOR SHARE",[user]);if(!role.rowCount)throw new CommandError(403,'ADMIN_REQUIRED');}
const jobsSql=`WITH jobs AS (
 SELECT id,CASE WHEN channel IN ('email','digest_email','support_email') THEN 'email' ELSE 'notification' END AS kind,status,attempts,max_attempts,
 next_attempt_at,last_error_code,created_at,updated_at,
 (status='failed' AND attempts<max_attempts AND (first_attempt_at IS NULL OR first_attempt_at>now()-interval '24 hours')
 AND COALESCE(last_error_code,'') NOT IN ('ACCOUNT_UNAVAILABLE','PRO_REQUIRED','INVALID_PAYLOAD','INVALID_DELIVERY_PAYLOAD','INVALID_RECIPIENT_ADDRESS','DELIVERY_CHANNEL_TEMPLATE_MISMATCH','SMTP_PERMANENT_FAILURE','SMTP_RECIPIENT_REJECTED','SMTP_AUTH_FAILED','SMTP_REJECTED')) AS can_retry
 FROM side_effect_delivery
 UNION ALL SELECT id,'export',status,attempts,5,NULL::timestamptz,failure_code,created_at,updated_at,
 (status='failed' AND attempts<5 AND created_at>now()-interval '24 hours' AND kind IN ('personal_raw','journal_analytics')
 AND failure_code NOT IN ('EXPORT_TOO_LARGE','EXPORT_KIND_UNAVAILABLE','PRO_REQUIRED','ACCOUNT_UNAVAILABLE')) FROM export_job
 UNION ALL SELECT id,'publication',status,attempts,3,NULL::timestamptz,failure_code,created_at,updated_at,false FROM publication_job
 UNION ALL SELECT id,'media',status,0,5,NULL::timestamptz,failure_code,created_at,updated_at,false FROM media
 UNION ALL SELECT id,'outbox',status,attempts,5,available_at,CASE WHEN status='failed' THEN 'OUTBOX_DISPATCH_FAILED' ELSE NULL END,created_at,COALESCE(delivered_at,created_at),
 (status='failed' AND attempts<5 AND created_at>now()-interval '24 hours' AND event_type IN ('notification.followed_publication','notification.comment_activity','notification.bookmark_material_update','notification.transactional')) FROM outbox_event
)`;
export class JobService{
 constructor(private readonly pool:Pool){}
 async list(user:string,query:{cursor?:unknown;limit?:unknown;kind?:unknown;status?:unknown}={}):Promise<components['schemas']['OperationalJobPage']>{
  const limit=query.limit===undefined?20:Number(query.limit);if(!Number.isInteger(limit)||limit<1||limit>50)throw new CommandError(400,'INVALID_PAGE_LIMIT');
  const kind=query.kind===undefined?null:String(query.kind),status=query.status===undefined?null:String(query.status);
  if(kind&&!kinds.includes(kind as Kind))throw new CommandError(400,'INVALID_JOB_KIND');
  const binding=createHash('sha256').update(JSON.stringify([user,kind,status])).digest('hex').slice(0,24);let after:{at:string;id:string;kind:string}|null=null;
  if(query.cursor!==undefined)try{const v=JSON.parse(Buffer.from(String(query.cursor),'base64url').toString());if(v.v!==1||v.binding!==binding||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(v.at)||!Number.isFinite(Date.parse(v.at))||!kinds.includes(v.kind))throw new Error();requireUuid(v.id);after=v;}catch{throw new CommandError(400,'INVALID_CURSOR');}
  return withActorTransaction(this.pool,user,async tx=>{
   await admin(tx,user);
   const result=await tx.query(`${jobsSql} SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM jobs
    WHERE ($1::text IS NULL OR kind=$1) AND ($2::text IS NULL OR status=$2)
    AND ($3::timestamptz IS NULL OR (created_at,id,kind)<($3::timestamptz,$4::uuid,$5::text)) ORDER BY created_at DESC,id DESC,kind DESC LIMIT $6`,[kind,status,after?.at??null,after?.id??null,after?.kind??null,limit+1]);
   const stats=await tx.query(`${jobsSql} SELECT count(*) FILTER(WHERE status='pending')::int AS pending,count(*) FILTER(WHERE status='queued')::int AS queued,
    count(*) FILTER(WHERE status IN ('processing','running'))::int AS processing,count(*) FILTER(WHERE status IN ('failed','rejected'))::int AS failed,
    count(*) FILTER(WHERE status='uncertain')::int AS uncertain,
    COALESCE(GREATEST(0,EXTRACT(EPOCH FROM now()-MIN(created_at) FILTER(WHERE status IN ('pending','queued','processing','running'))))::int,0) AS oldest,
    (SELECT count(*)::int FROM product_event WHERE created_at>now()-interval '30 days') AS product_events FROM jobs`);
   const rows=result.rows.slice(0,limit),last=rows.at(-1),count=stats.rows[0]!;
   return {items:rows.map(row=>({id:row.id,kind:row.kind,status:row.status,attempts:row.attempts,maxAttempts:row.max_attempts,nextAttemptAt:row.next_attempt_at?iso(row.next_attempt_at):null,lastErrorCode:typeof row.last_error_code==='string'?(/^[A-Z0-9_]{1,100}$/.test(row.last_error_code)?row.last_error_code:'JOB_FAILED'):null,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),canRetry:row.can_retry===true})),nextCursor:result.rows.length>limit&&last?Buffer.from(JSON.stringify({v:1,binding,at:last.cursor_at,id:last.id,kind:last.kind})).toString('base64url'):null,telemetry:{pending:count.pending,queued:count.queued,processing:count.processing,failed:count.failed,uncertain:count.uncertain,oldestPendingSeconds:count.oldest,productEventsLast30Days:count.product_events}};
  });
 }
 async retry(user:string,id:string,key:string,input:{action:string;kind:Kind;reason:string}):Promise<components['schemas']['AuditEvent']>{
  requireUuid(id);if(input.action!=='retry'||!kinds.includes(input.kind)||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>2000)throw new CommandError(422,'INVALID_JOB_ACTION');
  const result=await executeIdempotentCommand(this.pool,{actorUserId:user,operation:`job-retry:${input.kind}:${id}`,idempotencyKey:key,input:input as unknown as Json},async tx=>{
   await admin(tx,user);const kind=input.kind;
   if(kind==='media'||kind==='publication')throw new CommandError(409,'JOB_RETRY_UNSAFE','This job requires its member recovery workflow; its original evidence cannot be reset here.');
   if(kind==='email'||kind==='notification'){
    const row=(await tx.query('SELECT * FROM side_effect_delivery WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row||(kind==='email')!==['email','digest_email','support_email'].includes(String(row.channel)))throw new CommandError(404,'JOB_NOT_FOUND');
    if(row.status!=='failed'||row.attempts>=row.max_attempts||(row.first_attempt_at&&new Date(row.first_attempt_at).getTime()<=Date.now()-86400000)||['ACCOUNT_UNAVAILABLE','PRO_REQUIRED','INVALID_PAYLOAD','INVALID_DELIVERY_PAYLOAD','INVALID_RECIPIENT_ADDRESS','DELIVERY_CHANNEL_TEMPLATE_MISMATCH','SMTP_PERMANENT_FAILURE','SMTP_RECIPIENT_REJECTED','SMTP_AUTH_FAILED','SMTP_REJECTED'].includes(row.last_error_code))throw new CommandError(409,'JOB_RETRY_BUDGET_EXHAUSTED','Only a known failed, retryable delivery within its original budget can be retried. Uncertain SMTP delivery requires reconciliation.');
    await tx.query("UPDATE side_effect_delivery SET status='pending',next_attempt_at=now(),last_error_code=NULL,queue_job_id=NULL,updated_at=now() WHERE id=$1",[id]);
   }else if(kind==='export'){
    const row=(await tx.query(`SELECT e.*,u.status AS owner_status,u.email_verified FROM export_job e JOIN user_account u ON u.id=e.owner_user_id WHERE e.id=$1 FOR UPDATE OF e`,[id])).rows[0];if(!row)throw new CommandError(404,'JOB_NOT_FOUND');
    if(row.status!=='failed'||row.attempts>=5||new Date(row.created_at).getTime()<=Date.now()-86400000||row.owner_status!=='active'||!row.email_verified||row.object_key||!['personal_raw','journal_analytics'].includes(row.kind)||['EXPORT_TOO_LARGE','EXPORT_KIND_UNAVAILABLE','PRO_REQUIRED','ACCOUNT_UNAVAILABLE'].includes(row.failure_code))throw new CommandError(409,'JOB_RETRY_UNSAFE');
    if(row.kind==='journal_analytics'&&!(await tx.query(`SELECT 1 FROM subscription_entitlement WHERE user_id=$1 AND plan='pro' AND valid_from<=now() AND (valid_until IS NULL OR valid_until>now()) AND ${billingEntitlementPredicate('',2)}`,[row.owner_user_id,...billingEntitlementScope(process.env)])).rowCount)throw new CommandError(409,'JOB_RETRY_UNSAFE');
    const revision=(await tx.query("SELECT COALESCE(MAX(revision),0)::int+1 AS next FROM outbox_event WHERE aggregate_type='export_job' AND aggregate_id=$1 AND event_type='export.generate'",[id])).rows[0]!.next;
    await tx.query("UPDATE export_job SET status='pending',failure_code=NULL,claimed_at=NULL,updated_at=now() WHERE id=$1",[id]);
    await appendOutbox(tx,{eventType:'export.generate',aggregateType:'export_job',aggregateId:id,revision,payload:{jobId:id}});
   }else{
    const row=(await tx.query('SELECT * FROM outbox_event WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!row)throw new CommandError(404,'JOB_NOT_FOUND');
    // Notification fanout is safe to replay through its per-recipient delivery ledger.
    if(row.status!=='failed'||row.attempts>=5||new Date(row.created_at).getTime()<=Date.now()-86400000||!['notification.followed_publication','notification.comment_activity','notification.bookmark_material_update','notification.transactional'].includes(row.event_type))throw new CommandError(409,'JOB_RETRY_UNSAFE');
    await tx.query("UPDATE outbox_event SET status='pending',available_at=now() WHERE id=$1",[id]);
   }
   const auditId=randomUUID();const now=(await tx.query(`INSERT INTO audit_event(id,actor,action,resource_type,resource_id,reason,metadata,created_at) VALUES($1,$2,'job.retry','background_job',$3,$4,$5::jsonb,now()) RETURNING created_at`,[auditId,user,id,input.reason.trim(),JSON.stringify({kind})])).rows[0]!.created_at;
   return {status:201,body:{id:auditId,actorId:user,action:'job.retry',resourceType:'background_job',resourceId:id,reason:input.reason.trim(),createdAt:iso(now)},resourceId:id};
  });return result.body as components['schemas']['AuditEvent'];
 }
}
