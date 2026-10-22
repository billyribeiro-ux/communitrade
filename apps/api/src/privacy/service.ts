import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { CommandError } from '../http/problem.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOLD_MAX_MS = 365 * 24 * 60 * 60_000;

export interface PrivacyRequestDto {
  id: string; type: 'deletion' | 'export'; status: string; requestedAt: string;
  dueAt: string | null; hold: { reason: string; until: string | null } | null; completedAt: string | null;
}

type Row = { id: string; type: string; status: string; requested_at: Date | string; due_at: Date | string | null;
  hold_reason: string | null; hold_until: Date | string | null; completed_at: Date | string | null };
const iso = (v: Date | string | null): string | null => v == null ? null : new Date(v).toISOString();
const dto = (r: Row): PrivacyRequestDto => ({ id:r.id, type:r.type as PrivacyRequestDto['type'], status:r.status,
  requestedAt:iso(r.requested_at)!, dueAt:iso(r.due_at), hold:r.hold_reason ? {reason:r.hold_reason,until:iso(r.hold_until)} : null, completedAt:iso(r.completed_at) });

/** Stable account suppression digest. Keep the same secret/key version available to auth and restore drills. */
export function deletionSubjectDigest(secret: string, issuer: string, subject: string): string {
  if (secret.length < 32 || !issuer || !subject) throw new Error('PRIVACY_SUPPRESSION_KEY_REQUIRED');
  return createHmac('sha256', secret).update(`p13-subject-v1\0${issuer}\0${subject}`).digest('hex');
}

export async function isDeletionSuppressed(pool:Pick<Pool,'query'>,secret:string,issuer:string,subject:string):Promise<boolean>{
  const digest=deletionSubjectDigest(secret,issuer,subject);
  const result=await pool.query(`SELECT 1 FROM privacy_deletion_suppression WHERE subject_hmac=$1 LIMIT 1`,[digest]);
  return Boolean(result.rowCount);
}

export class PrivacyService {
  constructor(private readonly pool: Pool) {}

  async requestDeletion(ownerId: string, verifiedAt: Date | string, idempotencyKey:string, confirm:string, requestReason?:string): Promise<PrivacyRequestDto> {
    if (!UUID.test(ownerId)) throw new CommandError(400,'INVALID_ID','Account ID is invalid.');
    if(confirm!=='DELETE_MY_ACCOUNT')throw new CommandError(422,'PRIVACY_CONFIRMATION_REQUIRED','Type DELETE_MY_ACCOUNT to confirm deletion.');
    const note=requestReason?.trim();if(note!==undefined&&note.length>500)throw new CommandError(422,'PRIVACY_REASON_INVALID','Request reason is limited to 500 characters.');
    const verifiedAtMs=new Date(verifiedAt).getTime();
    if(!Number.isFinite(verifiedAtMs)||Date.now()-verifiedAtMs>5*60_000||verifiedAtMs>Date.now()+30_000)throw new CommandError(403,'RECENT_VERIFICATION_REQUIRED','Verify your identity again before requesting account deletion.');
    if(!/^[\x21-\x7e]{16,200}$/.test(idempotencyKey))throw new CommandError(400,'IDEMPOTENCY_KEY_REQUIRED','A valid idempotency key is required.');
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`privacy-deletion:${ownerId}:${idempotencyKey}`]);
      const requestHash=createHash('sha256').update(JSON.stringify({type:'deletion',reason:note??null})).digest('hex');
      const idemRow=await client.query<{request_hash:string;resource_id:string|null}>(`SELECT request_hash,resource_id FROM idempotency_record WHERE actor_key=$1 AND route='/privacy/deletion' AND key=$2 AND expires_at>now()`,[ownerId,idempotencyKey]);
      if(idemRow.rowCount){const p=idemRow.rows[0];if(p?.request_hash!==requestHash)throw new CommandError(409,'IDEMPOTENCY_CONFLICT','This retry key belongs to a different privacy request.');const previous=p.resource_id?await client.query<Row>(`SELECT id,type,status,requested_at,due_at,hold_reason,hold_until,completed_at FROM privacy_request WHERE id=$1 AND owner_user_id=$2`,[p.resource_id,ownerId]):{rows:[]};if(previous.rows[0]){await client.query('COMMIT');return dto(previous.rows[0]);}}
      await client.query(`DELETE FROM idempotency_record WHERE actor_key=$1 AND route='/privacy/deletion' AND key=$2 AND expires_at<=now()`,[ownerId,idempotencyKey]);
      const account=await client.query(`SELECT status,email_verified FROM user_account WHERE id=$1 FOR UPDATE`,[ownerId]);
      if(!account.rowCount || account.rows[0]?.status!=='active' || account.rows[0]?.email_verified!==true) throw new CommandError(403,'ACCOUNT_UNAVAILABLE','A verified active account is required.');
      const prior=await client.query<Row>(`SELECT id,type,status,requested_at,due_at,hold_reason,hold_until,completed_at FROM privacy_request
        WHERE owner_user_id=$1 AND type='deletion' AND status NOT IN ('completed','cancelled') ORDER BY requested_at DESC LIMIT 1`,[ownerId]);
      if(prior.rows[0]) {const existing=prior.rows[0];await client.query(`INSERT INTO idempotency_record(id,actor_key,route,key,request_hash,response_status,response_body,resource_id,expires_at) VALUES($1,$2,'/privacy/deletion',$3,$4,202,$5::jsonb,$6,now()+interval '24 hours') ON CONFLICT(actor_key,route,key) DO NOTHING`,[randomUUID(),ownerId,idempotencyKey,requestHash,JSON.stringify(dto(existing)),existing.id]);await client.query('COMMIT'); return dto(existing); }
      const inserted=await client.query<Row>(`INSERT INTO privacy_request(id,owner_user_id,type,status,request_reason,requested_at,due_at,stage,progress,created_at,updated_at)
        VALUES($1,$2,'deletion','requested',$3,now(),now()+interval '30 days','queued','{}'::jsonb,now(),now())
        RETURNING id,type,status,requested_at,due_at,hold_reason,hold_until,completed_at`,[randomUUID(),ownerId,note??null]);
      const result=inserted.rows[0]; if(!result) throw new Error('privacy request missing');
      await client.query(`INSERT INTO idempotency_record(id,actor_key,route,key,request_hash,response_status,response_body,resource_id,expires_at)
        VALUES($1,$2,'/privacy/deletion',$3,$4,202,$5::jsonb,$6,now()+interval '24 hours')`,[randomUUID(),ownerId,idempotencyKey,requestHash,JSON.stringify(dto(result)),result.id]);
      await client.query(`INSERT INTO outbox_event(id,event_type,aggregate_type,aggregate_id,revision,payload,status,available_at,attempts,created_at)
        VALUES($1,'privacy.deletion','privacy_request',$2,1,$3::jsonb,'pending',now(),0,now()) ON CONFLICT(event_type,aggregate_type,aggregate_id,revision) DO NOTHING`,[randomUUID(),result.id,JSON.stringify({requestId:result.id})]);
      await client.query('COMMIT'); return dto(result);
    } catch(e) { await client.query('ROLLBACK').catch(()=>undefined); if(e instanceof CommandError) throw e; throw new CommandError(503,'PRIVACY_REQUEST_UNAVAILABLE','Deletion could not be queued. Retry shortly.'); }
    finally { client.release(); }
  }

  async listOwn(ownerId: string): Promise<{items:PrivacyRequestDto[]}> {
    if (!UUID.test(ownerId)) throw new CommandError(400,'INVALID_ID','Account ID is invalid.');
    const result=await this.pool.query<Row>(`SELECT id,type,status,requested_at,due_at,hold_reason,hold_until,completed_at FROM privacy_request WHERE owner_user_id=$1 ORDER BY requested_at DESC LIMIT 50`,[ownerId]);
    return {items:result.rows.map(dto)};
  }

  async adminList(status?: string): Promise<{items: Array<PrivacyRequestDto & {ownerUserId:string; stage:string; failedStage:string|null}>}> {
    if(status!==undefined && !['requested','queued','processing','held','failed','completed'].includes(status)) throw new CommandError(400,'INVALID_PRIVACY_STATUS','Status filter is invalid.');
    const result=await this.pool.query<Row & {owner_user_id:string;stage:string;failed_stage:string|null}>(`SELECT id,owner_user_id,type,status,requested_at,due_at,hold_reason,hold_until,completed_at,stage,failed_stage FROM privacy_request WHERE type='deletion' AND ($1::text IS NULL OR status=$1) ORDER BY requested_at LIMIT 100`,[status??null]);
    return {items:result.rows.map(r=>({...dto(r),ownerUserId:r.owner_user_id,stage:r.stage,failedStage:r.failed_stage}))};
  }

  /** Caller must enforce admin role, MFA <= 5 minutes, and insert its own exact-action audit record. */
  async adminAction(input:{actorUserId:string;sessionId:string;requestId:string;requestTraceId:string;idempotencyKey:string;action:'hold'|'release_hold'|'process';reason:string;holdUntil?:string}):Promise<PrivacyRequestDto>{
    const {requestId,action}=input; const reason=typeof input.reason==='string'?input.reason.trim():'';
    if(!UUID.test(requestId)||!UUID.test(input.actorUserId)||!UUID.test(input.sessionId)) throw new CommandError(400,'INVALID_ID','Privacy request ID is invalid.');
    if(!['hold','release_hold','process'].includes(action)) throw new CommandError(422,'PRIVACY_ACTION_INVALID','Action is invalid.');
    if(reason.length<8||reason.length>500) throw new CommandError(422,'PRIVACY_REASON_REQUIRED','Provide a reason between 8 and 500 characters.');
    let holdUntil:Date|null=null;
    if(!/^[\x21-\x7e]{16,200}$/.test(input.idempotencyKey))throw new CommandError(400,'IDEMPOTENCY_KEY_REQUIRED','A valid idempotency key is required.');
    if(action==='hold'){if(input.holdUntil===undefined)throw new CommandError(422,'PRIVACY_HOLD_INVALID','A legal or operational hold must have a review expiry.');const ms=Date.parse(input.holdUntil);if(!Number.isFinite(ms)||ms<=Date.now()||ms>Date.now()+HOLD_MAX_MS)throw new CommandError(422,'PRIVACY_HOLD_INVALID','Hold expiry must be within the next year.');holdUntil=new Date(ms);}else if(input.holdUntil!==undefined)throw new CommandError(422,'PRIVACY_HOLD_INVALID','holdUntil is only valid for hold actions.');
    const client=await this.pool.connect();
    try{
      await client.query('BEGIN');
      const admin=await client.query(`SELECT 1 FROM role_grant g JOIN user_account u ON u.id=g.user_id JOIN app_session s ON s.user_id=u.id WHERE g.user_id=$1 AND g.role='admin' AND u.status='active' AND s.id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND s.mfa_at>=now()-interval '5 minutes'`,[input.actorUserId,input.sessionId]);
      if(!admin.rowCount)throw new CommandError(403,'ADMIN_STEP_UP_REQUIRED','An active administrator session with recent MFA is required.');
      const route=`/admin/privacy/requests/${requestId}/actions`,requestHash=createHash('sha256').update(JSON.stringify({action,reason,holdUntil:holdUntil?.toISOString()??null})).digest('hex');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`privacy-admin:${input.actorUserId}:${route}:${input.idempotencyKey}`]);
      const idem=await client.query<{request_hash:string;response_body:PrivacyRequestDto|null}>(`SELECT request_hash,response_body FROM idempotency_record WHERE actor_key=$1 AND route=$2 AND key=$3 AND expires_at>now()`,[input.actorUserId,route,input.idempotencyKey]);
      if(idem.rowCount){const prior=idem.rows[0];if(prior?.request_hash!==requestHash)throw new CommandError(409,'IDEMPOTENCY_CONFLICT','This retry key belongs to a different privacy action.');if(prior.response_body){await client.query('COMMIT');return prior.response_body;}}
      await client.query(`DELETE FROM idempotency_record WHERE actor_key=$1 AND route=$2 AND key=$3 AND expires_at<=now()`,[input.actorUserId,route,input.idempotencyKey]);
      const found=await client.query<Row>(`SELECT id,type,status,requested_at,due_at,hold_reason,hold_until,completed_at FROM privacy_request WHERE id=$1 AND type='deletion' FOR UPDATE`,[requestId]);
      const row=found.rows[0];if(!row)throw new CommandError(404,'PRIVACY_REQUEST_NOT_FOUND','Privacy request is unavailable.');
      let updated;
      if(action==='hold'){
        if(['completed','cancelled'].includes(row.status))throw new CommandError(409,'PRIVACY_REQUEST_FINAL','Completed request cannot be held.');
        if(row.status==='processing')throw new CommandError(409,'PRIVACY_REQUEST_PROCESSING','A running erasure stage cannot be paused.');
        updated=await client.query<Row>(`UPDATE privacy_request SET status='held',hold_reason=$2,hold_until=$3,updated_at=now(),admin_reason=$2 WHERE id=$1 RETURNING id,type,status,requested_at,due_at,hold_reason,hold_until,completed_at`,[requestId,reason,holdUntil]);
      }else if(action==='release_hold'){
        if(row.status!=='held')throw new CommandError(409,'PRIVACY_REQUEST_NOT_HELD','Only a held request can be released.');
        updated=await client.query<Row>(`UPDATE privacy_request SET status='queued',hold_reason=NULL,hold_until=NULL,updated_at=now(),stage='queued',admin_reason=$2 WHERE id=$1 RETURNING id,type,status,requested_at,due_at,hold_reason,hold_until,completed_at`,[requestId,reason]);
      }else{
        if(row.status==='held')throw new CommandError(409,'PRIVACY_REQUEST_HELD','Release its hold before processing.');
        if(['completed','cancelled'].includes(row.status))throw new CommandError(409,'PRIVACY_REQUEST_FINAL','Completed request cannot be processed.');
        updated=await client.query<Row>(`UPDATE privacy_request SET status='queued',stage=CASE WHEN stage='queued' THEN 'queued' ELSE stage END,admin_reason=$2,updated_at=now() WHERE id=$1 RETURNING id,type,status,requested_at,due_at,hold_reason,hold_until,completed_at`,[requestId,reason]);
      }
      const result=updated.rows[0];if(!result)throw new Error('privacy action missing');
      await client.query(`INSERT INTO audit_event(id,actor,resource_type,resource_id,action,reason,request_id,metadata,created_at) VALUES($1,$2,'privacy_request',$3,$4,$5,$6,$7::jsonb,now())`,[randomUUID(),`user:${input.actorUserId}`,requestId,`privacy.${action}`,reason,input.requestTraceId,JSON.stringify({action,holdUntil:holdUntil?.toISOString()??null})]);
      await client.query(`DELETE FROM idempotency_record WHERE actor_key=$1 AND route=$2 AND key=$3 AND expires_at<=now()`,[input.actorUserId,route,input.idempotencyKey]);
      await client.query(`INSERT INTO idempotency_record(id,actor_key,route,key,request_hash,response_status,response_body,resource_id,expires_at) VALUES($1,$2,$3,$4,$5,200,$6::jsonb,$7,now()+interval '24 hours')`,[randomUUID(),input.actorUserId,route,input.idempotencyKey,requestHash,JSON.stringify(dto(result)),requestId]);
      await client.query(`INSERT INTO outbox_event(id,event_type,aggregate_type,aggregate_id,revision,payload,status,available_at,attempts,created_at)
        VALUES($1,'privacy.deletion','privacy_request',$2,(SELECT coalesce(max(revision),0)+1 FROM outbox_event WHERE event_type='privacy.deletion' AND aggregate_type='privacy_request' AND aggregate_id=$2),$3::jsonb,'pending',now(),0,now()) ON CONFLICT(event_type,aggregate_type,aggregate_id,revision) DO NOTHING`,[randomUUID(),requestId,JSON.stringify({requestId})]);
      await client.query('COMMIT');return dto(result);
    }catch(e){await client.query('ROLLBACK').catch(()=>undefined);if(e instanceof CommandError)throw e;throw new CommandError(503,'PRIVACY_ACTION_UNAVAILABLE','Privacy action could not be saved.');}finally{client.release();}
  }
}
