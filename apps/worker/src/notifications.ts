import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export interface NotificationJob { outboxEventId:string }
type Row=Record<string,any>;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_TYPES=new Set(['notification.followed_publication','notification.comment_activity','notification.bookmark_material_update','notification.transactional']);
const CATEGORIES=new Set(['reply','mention','followed_publication','bookmark_update','moderation','account','billing','security']);
const RETRY_LIMIT=5;
export type NotificationSourceAuthorizer=(publicationId:string)=>Promise<{available:boolean;title?:string;url?:string}>;
const safeJson=(value:unknown):Row=>value&&typeof value==='object'&&!Array.isArray(value)?value as Row:{};
const genericText=(category:string)=>({reply:'There is new reply activity on an idea.',mention:'Someone mentioned you in a discussion.',followed_publication:'An author you follow published a new idea.',bookmark_update:'A bookmarked idea has an important update.',moderation:'There is an update about a community decision.',account:'There is an update about your account.',billing:'There is an update about your subscription.',security:'There is a security update for your account.'} as Record<string,string>)[category]??'There is new activity for your account.';
const canNotify=async(client:Pick<PoolClient,'query'>,ownerId:string,category:string)=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`notification-owner:${ownerId}`]);
  const pref=await client.query('SELECT settings FROM preference WHERE user_id=$1',[ownerId]);
  const settings=safeJson(pref.rows[0]?.settings);
  const setting={followed_publication:'publicationNotices',reply:'replyNotices',mention:'mentionNotices',bookmark_update:'bookmarkNotices',moderation:'moderationNotices'}[category];
  if(setting&&settings[setting]===false)return false;
  return true;
};

/** A source can be linked only while it remains public and its frozen chart data rights remain active. */
async function publicSource(client:Pick<PoolClient,'query'>,publicationId:string,authorizeSource?:NotificationSourceAuthorizer):Promise<{authorId:string;versionId:string;url?:string}|null>{
  if(!UUID.test(publicationId))return null;
  if(!authorizeSource&&(process.env.NODE_ENV==='production'||['production','public'].includes((process.env.RELEASE_MODE??'').toLowerCase())))return null;
  const authorized=authorizeSource?await authorizeSource(publicationId):null;
  if(authorized&&!authorized.available)return null;
  const result=await client.query(`SELECT p.id,p.author_user_id,p.current_version_id,v.terms,v.disclosures,c.state
    FROM publication p JOIN user_account u ON u.id=p.author_user_id AND u.status='active'
    JOIN publication_version v ON v.id=p.current_version_id AND v.publication_id=p.id
    LEFT JOIN chart_state c ON c.publication_version_id=v.id
    WHERE p.id=$1 AND p.visibility='public' AND p.published_at IS NOT NULL`,[publicationId]);
  const row=result.rows[0];if(!row||(!authorized&&!row.state))return null;
  const terms=safeJson(row.terms),plan=safeJson(terms.plan),chart=safeJson(row.state),disclosures=safeJson(row.disclosures);
  const instruments=[{id:chart.instrumentId,version:Number(chart.metadataVersion)},...(Array.isArray(plan.legs)?plan.legs.map((leg:Row)=>({id:leg.instrumentId,version:null as number|null})):[])];
  const refs=Array.isArray(disclosures.referenceVersions)?disclosures.referenceVersions as Row[]:[];
  // The internal source authorizer is the API's exact current publication and
  // provider-rights check. Keep the database rights fallback for local tests.
  for(const item of (authorized?[]:instruments)){
    if(typeof item.id!=='string'||!UUID.test(item.id))return null;
    const reference=refs.find((entry:Row)=>entry.instrumentId===item.id);
    const version=item.version??Number(reference?.metadataVersion);
    if(!Number.isInteger(version))return null;
    const rights=await client.query(`SELECT
        bool_or(d.purpose='display' AND d.flags->>'displayPublic'='true') AS display_ok,
        bool_or(d.purpose='snapshot' AND d.flags->>'retainSnapshot'='true') AS snapshot_ok
      FROM provider_instrument_mapping m JOIN data_capability d ON d.supplier=m.supplier AND d.dataset=m.dataset AND d.audience='public'
        AND d.effective_at<=now() AND (d.revoked_at IS NULL OR d.revoked_at>now())
      WHERE m.instrument_id=$1 AND m.metadata_version=$2 AND m.revoked_at IS NULL AND m.effective_at<=now()`,[item.id,version]);
    if(rights.rows[0]?.display_ok!==true||rights.rows[0]?.snapshot_ok!==true)return null;
  }
  return {authorId:String(row.author_user_id),versionId:String(row.current_version_id),...(authorized?.url?{url:authorized.url}:{})};
}

async function insertNotice(client:Pick<PoolClient,'query'>,ownerId:string,category:string,sourceId:string|null,url:string,key:string,text:string,email?:Row){
  if(!UUID.test(ownerId)||!CATEGORIES.has(category)||key.length>200)throw new Error('INVALID_NOTIFICATION_RECIPIENT');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`notification-owner:${ownerId}`]);
  const internalUrl=sourceId&&UUID.test(sourceId)&&new RegExp(`^/ideas/${sourceId}(?:/[a-z0-9-]+)?$`).test(url)?url:url.startsWith('/app/')||url==='/app'?url:'/app/notifications';
  const id=randomUUID();
  await client.query(`INSERT INTO notification(id,owner_user_id,category,aggregation_key,internal_url,text,source_id,event_count,last_activity_at,read_at,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,1,now(),NULL,now())
    ON CONFLICT(owner_user_id,aggregation_key) DO UPDATE SET event_count=notification.event_count+1,last_activity_at=now(),read_at=NULL,
      internal_url=EXCLUDED.internal_url,text=EXCLUDED.text,source_id=EXCLUDED.source_id`,[id,ownerId,category,key,internalUrl,text.slice(0,500),sourceId]);
  if(email&&['billing','account','security'].includes(category)){
    const envelope={version:1,template:'notification',recipientUserId:ownerId,category,subject:String(email.subject??'Account notice').slice(0,160),title:String(email.title??genericText(category)).slice(0,120),body:String(email.body??genericText(category)).slice(0,500),internalUrl};
    await client.query(`INSERT INTO side_effect_delivery(id,channel,business_delivery_key,attempts,provider_reference,result,created_at,status,payload,max_attempts,next_attempt_at,owner_user_id,category,updated_at)
      VALUES($1,'email',$2,0,NULL,NULL,now(),'pending',$3::jsonb,5,now(),$4,$5,now()) ON CONFLICT(channel,business_delivery_key) DO NOTHING`,
      [randomUUID(),`notification:${category}:${key}`,JSON.stringify(envelope),ownerId,category]);
  }
}
function fanoutJobId(id:string,attempt:number){
 if(attempt===0)return id;
 const bytes=createHash('sha256').update(`notification-fanout:v1:${id}:${attempt}`).digest().subarray(0,16);
 bytes[6]=(bytes[6]!&0x0f)|0x50;bytes[8]=(bytes[8]!&0x3f)|0x80;
 const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
const aggregation=(category:string,sourceId:string,actorId:string,date:Date)=>`${category}:${sourceId}:${actorId}:${date.toISOString().slice(0,10)}`;

async function fanoutFollowed(client:Pick<PoolClient,'query'>,payload:Row,authorizeSource?:NotificationSourceAuthorizer){
  const publicationId=String(payload.publicationId??''),authorId=String(payload.authorUserId??'');
  const source=await publicSource(client,publicationId,authorizeSource);if(!source||source.authorId!==authorId)return;
  const recipients=await client.query(`SELECT f.follower_user_id AS user_id FROM follow f
    JOIN user_account u ON u.id=f.follower_user_id AND u.status='active' AND u.email_verified=true
    WHERE f.target_user_id=$1 AND f.follower_user_id<>$1
      AND NOT EXISTS(SELECT 1 FROM mute m WHERE m.user_id=f.follower_user_id AND m.author_id=$1)
      AND COALESCE((SELECT p.settings->>'publicationNotices' FROM preference p WHERE p.user_id=f.follower_user_id),'true')<>'false'`,[authorId]);
  for(const recipient of recipients.rows){const userId=String(recipient.user_id);if(!await canNotify(client,userId,'followed_publication'))continue;
    await insertNotice(client,userId,'followed_publication',publicationId,source.url??`/ideas/${publicationId}`,`followed_publication:${publicationId}`,genericText('followed_publication'));}
}

async function fanoutComment(client:Pick<PoolClient,'query'>,payload:Row,authorizeSource?:NotificationSourceAuthorizer){
  const commentId=String(payload.commentId??''),publicationId=String(payload.publicationId??''),authorId=String(payload.authorUserId??'');
  const source=await publicSource(client,publicationId,authorizeSource);if(!source)return;
  const comment=await client.query(`SELECT c.reply_to_id,c.created_at,p.author_user_id FROM comment c JOIN publication p ON p.id=c.publication_id
    WHERE c.id=$1 AND c.publication_id=$2 AND c.author_user_id=$3 AND c.deleted_at IS NULL AND c.hidden_at IS NULL`,[commentId,publicationId,authorId]);
  if(!comment.rows[0])return;
  const recipients=new Map<string,'reply'|'mention'>();
  if(String(comment.rows[0].author_user_id)!==authorId)recipients.set(String(comment.rows[0].author_user_id),'reply');
  if(comment.rows[0].reply_to_id){
    const reply=await client.query(`SELECT author_user_id FROM comment WHERE id=$1 AND publication_id=$2 AND deleted_at IS NULL AND hidden_at IS NULL`,[comment.rows[0].reply_to_id,publicationId]);
    const userId=String(reply.rows[0]?.author_user_id??'');if(userId&&userId!==authorId)recipients.set(userId,'reply');
  }
  const mentions=await client.query('SELECT mentioned_user_id FROM comment_mention WHERE comment_id=$1 AND mentioned_user_id<>$2',[commentId,authorId]);
  for(const mention of mentions.rows){const userId=String(mention.mentioned_user_id);if(!recipients.has(userId))recipients.set(userId,'mention');}
  for(const [userId,category] of recipients){
    const active=await client.query("SELECT 1 FROM user_account WHERE id=$1 AND status='active' AND email_verified=true",[userId]);if(!active.rowCount)continue;
    const muted=await client.query('SELECT 1 FROM mute WHERE user_id=$1 AND author_id=$2',[userId,authorId]);if(muted.rowCount)continue;
    if(!await canNotify(client,userId,category))continue;
    const day=comment.rows[0].created_at instanceof Date?comment.rows[0].created_at:new Date(comment.rows[0].created_at);
    await insertNotice(client,userId,category,publicationId,source.url??`/ideas/${publicationId}`,aggregation(category,publicationId,authorId,day),genericText(category));
  }
}

async function fanoutBookmarkUpdate(client:Pick<PoolClient,'query'>,payload:Row,authorizeSource?:NotificationSourceAuthorizer){
  const publicationId=String(payload.publicationId??''),authorId=String(payload.authorUserId??'');
  const source=await publicSource(client,publicationId,authorizeSource);if(!source||source.authorId!==authorId)return;
  const versionId=String(payload.versionId??'');if(source.versionId!==versionId)return;
  const rows=await client.query(`SELECT b.user_id FROM bookmark b JOIN user_account u ON u.id=b.user_id AND u.status='active' AND u.email_verified=true
    WHERE b.publication_id=$1 AND b.user_id<>$2 AND COALESCE((SELECT p.settings->>'bookmarkNotices' FROM preference p WHERE p.user_id=b.user_id),'true')<>'false'
    AND NOT EXISTS(SELECT 1 FROM mute m WHERE m.user_id=b.user_id AND m.author_id=$2)`,[publicationId,authorId]);
  for(const row of rows.rows){const userId=String(row.user_id);if(!await canNotify(client,userId,'bookmark_update'))continue;
    await insertNotice(client,userId,'bookmark_update',publicationId,source.url??`/ideas/${publicationId}`,`bookmark_update:${publicationId}:${versionId}`,genericText('bookmark_update'));}
}

async function fanoutTransactional(client:Pick<PoolClient,'query'>,eventId:string,payload:Row,authorizeSource?:NotificationSourceAuthorizer){
  const recipient=String(payload.recipientUserId??''),category=String(payload.category??'');
  if(!UUID.test(recipient)||!['moderation','account','billing','security'].includes(category)||typeof payload.text!=='string')return;
  const account=await client.query("SELECT 1 FROM user_account WHERE id=$1 AND status='active' AND email_verified=true",[recipient]);if(!account.rowCount)return;
  let sourceId=typeof payload.sourceId==='string'&&UUID.test(payload.sourceId)?payload.sourceId:null;
  let url=typeof payload.internalUrl==='string'?payload.internalUrl:'/app/settings';
  if(sourceId){const source=await publicSource(client,sourceId,authorizeSource);if(!source){sourceId=null;url='/app/notifications';}else if(source.url)url=source.url;}
  // Each committed outbox event is a distinct transactional notice. Never key
  // all future security/account notices for one recipient to the recipient ID.
  const id=String(payload.notificationId??eventId);
  await insertNotice(client,recipient,category,sourceId,url,`transactional:${category}:${id}`,payload.text,safeJson(payload.email));
}

async function processEvent(client:Pick<PoolClient,'query'>,event:Row,authorizeSource?:NotificationSourceAuthorizer){
  const type=String(event.event_type),payload=safeJson(event.payload);
  if(type==='notification.followed_publication')await fanoutFollowed(client,payload,authorizeSource);
  else if(type==='notification.comment_activity')await fanoutComment(client,payload,authorizeSource);
  else if(type==='notification.bookmark_material_update')await fanoutBookmarkUpdate(client,payload,authorizeSource);
  else if(type==='notification.transactional')await fanoutTransactional(client,String(event.id),payload,authorizeSource);
  else throw new Error('UNSUPPORTED_NOTIFICATION_EVENT');
}

export async function processNotificationJob(pool:Pool,payload:NotificationJob,retryCount=0,retryLimit=5,_now=new Date(),authorizeSource?:NotificationSourceAuthorizer):Promise<void>{
  if(!payload||typeof payload!=='object'||Object.keys(payload).length!==1||!UUID.test(String(payload.outboxEventId)))throw new Error('INVALID_NOTIFICATION_JOB');
  const client=await pool.connect();let inTransaction=false;
  try{
    await client.query('BEGIN');inTransaction=true;
    const result=await client.query('SELECT id,event_type,aggregate_type,aggregate_id,revision,payload,status,attempts,created_at FROM outbox_event WHERE id=$1 FOR UPDATE',[payload.outboxEventId]);
    const event=result.rows[0];if(!event||event.status==='delivered'||event.status==='failed'){await client.query('COMMIT');inTransaction=false;return;}
    if(Number(event.attempts)>=RETRY_LIMIT||new Date(event.created_at).getTime()<=Date.now()-24*60*60_000){await client.query("UPDATE outbox_event SET status='failed',attempts=LEAST(5,attempts+1) WHERE id=$1",[payload.outboxEventId]);await client.query('COMMIT');inTransaction=false;return;}
    if(!EVENT_TYPES.has(String(event.event_type))){await client.query("UPDATE outbox_event SET status='failed',attempts=LEAST(5,attempts+1) WHERE id=$1",[payload.outboxEventId]);await client.query('COMMIT');inTransaction=false;return;}
    await processEvent(client,event,authorizeSource);
    await client.query("UPDATE outbox_event SET status='delivered',delivered_at=now(),attempts=attempts+1 WHERE id=$1",[payload.outboxEventId]);
    await client.query('COMMIT');inTransaction=false;
  }catch(error){
    if(inTransaction)await client.query('ROLLBACK').catch(()=>undefined);
    const attempt=Math.max(retryCount+1,1),exhausted=attempt>=Math.min(retryLimit,RETRY_LIMIT);
    await pool.query(`UPDATE outbox_event SET attempts=LEAST(5,attempts+1),status=CASE WHEN attempts+1 >= $2 THEN 'failed' ELSE 'queued' END,
      available_at=CASE WHEN attempts+1 >= $2 THEN available_at ELSE now()+make_interval(secs=>LEAST(300,5*(2^LEAST(attempts,6))::int)) END WHERE id=$1 AND status IN ('pending','queued')`,[payload.outboxEventId,Math.min(retryLimit,RETRY_LIMIT)]).catch(()=>undefined);
    if(!exhausted)throw error;
  }finally{if(inTransaction)await client.query('ROLLBACK').catch(()=>undefined);client.release();}
}

/** Enqueue first, acknowledge second; stable job IDs make crash replay idempotent. */
export async function dispatchNotificationOutbox(pool:Pool,send:(queue:string,data:NotificationJob,options?:Record<string,unknown>)=>Promise<unknown>):Promise<number>{
  const client=await pool.connect();let transaction=false,queued=0;
  try{
    await client.query('BEGIN');transaction=true;
    await client.query("UPDATE outbox_event SET status='failed',attempts=attempts+1 WHERE event_type=ANY($1::text[]) AND status IN ('pending','queued') AND created_at<=now()-interval '24 hours'",[[...EVENT_TYPES]]);
    const events=await client.query(`SELECT id,attempts FROM outbox_event WHERE event_type=ANY($1::text[]) AND status IN ('pending','queued') AND attempts<5 AND created_at>now()-interval '24 hours' AND available_at<=now()
      ORDER BY created_at,id LIMIT 25 FOR UPDATE SKIP LOCKED`,[[...EVENT_TYPES]]);
    for(const event of events.rows){
      try{
        await send('notification.fanout',{outboxEventId:String(event.id)},{id:fanoutJobId(String(event.id),Number(event.attempts)),retryLimit:5,retryDelay:5,retryBackoff:true,expireInSeconds:86400});
      }catch{
        await client.query(`UPDATE outbox_event SET attempts=attempts+1,status=CASE WHEN attempts+1>=5 THEN 'failed' ELSE 'pending' END,
          available_at=CASE WHEN attempts+1>=5 THEN available_at ELSE now()+make_interval(secs=>LEAST(300,5*(2^LEAST(attempts,6))::int)) END WHERE id=$1`,[event.id]);
        continue;
      }
      // Persist only after enqueue. A failed DB acknowledgment rolls back and reuses the same attempt identity.
      await client.query("UPDATE outbox_event SET status='queued',delivered_at=NULL,available_at=now()+interval '2 minutes' WHERE id=$1 AND status IN ('pending','queued')",[event.id]);queued++;
    }
    await client.query('COMMIT');transaction=false;return queued;
  }catch(error){if(transaction)await client.query('ROLLBACK').catch(()=>undefined);throw error;}
  finally{if(transaction)await client.query('ROLLBACK').catch(()=>undefined);client.release();}
}
