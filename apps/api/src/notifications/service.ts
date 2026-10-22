import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { CommandError } from '../http/problem.js';
import { executeIdempotentCommand, parseIfMatch, requireUuid, withActorTransaction, type Json, type Transaction } from '../persistence/transactions.js';
import { effectivePlan, serializeUser } from '../workspace/entitlements.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATEGORY = new Set(['reply','mention','followed_publication','bookmark_update','moderation','account','billing','security']);
const ASSETS = new Set(['stock','option','future']);
const STRATEGIES = new Set(['long','short','long_call','long_put','bull_call_debit','bear_put_debit','bull_put_credit','bear_call_credit']);
const STATES = new Set(['pending','entered','partially_closed','closed','unresolved','canceled','never_entered']);
const iso = (value: Date | string) => new Date(value).toISOString();
const uuid = (value: string) => { if (!UUID.test(value)) throw new CommandError(400,'INVALID_ID'); return value; };
const limitOf = (value: unknown) => { const limit = value === undefined ? 20 : Number(value); if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new CommandError(400,'INVALID_LIMIT'); return limit; };

type Cursor = { v: 1; owner: string; unreadOnly: boolean; createdAt: string; id: string };
function cursorFor(row: Record<string, any>, owner: string, unreadOnly: boolean) {
  return Buffer.from(JSON.stringify({ v:1, owner, unreadOnly, createdAt:String(row.cursor_created_at), id:String(row.id) })).toString('base64url');
}
function decodeCursor(input: unknown, owner: string, unreadOnly: boolean): Cursor | null {
  if (input === undefined || input === null || input === '') return null;
  if (typeof input !== 'string' || input.length > 500 || !/^[A-Za-z0-9_-]+$/.test(input)) throw new CommandError(400,'INVALID_CURSOR');
  try {
    const value = JSON.parse(Buffer.from(input,'base64url').toString('utf8')) as Cursor;
    if (value.v !== 1 || value.owner !== owner || value.unreadOnly !== unreadOnly
      || typeof value.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.createdAt)
      || !Number.isFinite(Date.parse(value.createdAt)) || !UUID.test(value.id)) throw new Error();
    return value;
  } catch { throw new CommandError(400,'INVALID_CURSOR'); }
}
function safeUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 500 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/app/notifications';
  if (/^\/ideas\/[0-9a-f-]{36}(?:\/[a-z0-9-]{1,140})?$/.test(value) || /^\/app(?:\/[a-z0-9/_-]*)?$/.test(value)) return value;
  return '/app/notifications';
}
function projectNotification(row: Record<string, any>) {
  const kind = CATEGORY.has(String(row.category)) ? String(row.category) : 'security';
  return { id:String(row.id), kind, text:String(row.text ?? ''), url:safeUrl(row.internal_url), createdAt:iso(row.created_at),
    readAt:row.read_at ? iso(row.read_at) : null, eventCount:Number(row.event_count ?? 1), sourceId:row.source_id ? String(row.source_id) : null };
}
function normalizedFilters(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CommandError(422,'INVALID_SAVED_SEARCH');
  const raw = input as Record<string, unknown>;
  const allowed = new Set(['q','asset','strategy','status','author','instrumentId']);
  if (Object.keys(raw).some(key => !allowed.has(key))) throw new CommandError(422,'INVALID_SAVED_SEARCH');
  const filters: Record<string,string> = {};
  if (raw.q !== undefined) { if (typeof raw.q !== 'string' || raw.q.trim().length > 200) throw new CommandError(422,'INVALID_SAVED_SEARCH'); if (raw.q.trim()) filters.q = raw.q.trim().replace(/\s+/g,' '); }
  if (raw.asset !== undefined) { if (typeof raw.asset !== 'string' || !ASSETS.has(raw.asset)) throw new CommandError(422,'INVALID_SAVED_SEARCH'); filters.asset = raw.asset; }
  if (raw.strategy !== undefined) { if (typeof raw.strategy !== 'string' || !STRATEGIES.has(raw.strategy)) throw new CommandError(422,'INVALID_SAVED_SEARCH'); filters.strategy = raw.strategy; }
  if (raw.status !== undefined) { if (typeof raw.status !== 'string' || !STATES.has(raw.status)) throw new CommandError(422,'INVALID_SAVED_SEARCH'); filters.status = raw.status; }
  if (raw.author !== undefined) { if (typeof raw.author !== 'string' || !/^[a-z0-9_]{3,30}$/i.test(raw.author.trim())) throw new CommandError(422,'INVALID_SAVED_SEARCH'); filters.author = raw.author.trim().toLowerCase(); }
  if (raw.instrumentId !== undefined) { if (typeof raw.instrumentId !== 'string' || !UUID.test(raw.instrumentId)) throw new CommandError(422,'INVALID_SAVED_SEARCH'); filters.instrumentId = raw.instrumentId; }
  return filters;
}
function nameOf(value: unknown) { if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new CommandError(422,'INVALID_SAVED_SEARCH'); return value.trim(); }
function projectSearch(row: Record<string, any>) { return { id:String(row.id), name:String(row.name), filters:row.filters, revision:Number(row.revision), createdAt:iso(row.created_at), updatedAt:iso(row.updated_at) }; }
function searchCursor(row: Record<string, any>, owner: string) { return Buffer.from(JSON.stringify({v:1,owner,createdAt:String(row.cursor_created_at),id:String(row.id)})).toString('base64url'); }
function decodeSearchCursor(input: unknown, owner: string) {
  if (input === undefined || input === null || input === '') return null;
  try {
    if (typeof input !== 'string' || input.length > 500 || !/^[A-Za-z0-9_-]+$/.test(input)) throw new Error();
    const value = JSON.parse(Buffer.from(input,'base64url').toString('utf8'));
    if (value.v !== 1 || value.owner !== owner || typeof value.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.createdAt) || !UUID.test(value.id)) throw new Error();
    return value as {createdAt:string;id:string};
  } catch { throw new CommandError(400,'INVALID_CURSOR'); }
}

export interface NotificationWrite {
  ownerUserId: string; category: string; aggregationKey: string; internalUrl: string; text: string;
  sourceId?: string | null; email?: { subject: string; title: string; body: string };
}

export async function enqueueNotificationEvent(tx: Pick<Transaction,'query'>, eventType:string, aggregateType:string, aggregateId:string, revision:number, payload:Record<string,unknown>) {
  if(!/^notification\.[a-z_]{1,60}$/.test(eventType)||!/^\w{1,60}$/.test(aggregateType)||!UUID.test(aggregateId)||!Number.isSafeInteger(revision)||revision<1)throw new Error('INVALID_NOTIFICATION_OUTBOX_EVENT');
  await tx.query(`INSERT INTO outbox_event(id,event_type,aggregate_type,aggregate_id,revision,payload,status,available_at,attempts,created_at)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,'pending',now(),0,now()) ON CONFLICT(event_type,aggregate_type,aggregate_id,revision) DO NOTHING`,
    [randomUUID(),eventType,aggregateType,aggregateId,revision,JSON.stringify(payload)]);
}

export async function enqueueTransactionalNotification(tx:Pick<Transaction,'query'>, input:{recipientUserId:string;category:'moderation'|'account'|'billing'|'security';sourceId?:string|null;internalUrl?:string;text:string;email?:{subject:string;title:string;body:string}}) {
  uuid(input.recipientUserId);
  if(!['moderation','account','billing','security'].includes(input.category)||typeof input.text!=='string'||!input.text.trim()||input.text.length>500)throw new Error('INVALID_TRANSACTIONAL_NOTIFICATION');
  const internalUrl=safeUrl(input.internalUrl??'/app/settings');
  const aggregateId=randomUUID();
  await enqueueNotificationEvent(tx,'notification.transactional','transactional_notification',aggregateId,1,{recipientUserId:input.recipientUserId,category:input.category,sourceId:input.sourceId??null,internalUrl,text:input.text,...(input.email?{email:input.email}:{})});
}

/** Shared insertion path for fanout and transactional producers. */
export async function lockNotificationOwner(tx: Pick<Transaction,'query'>, ownerUserId: string) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`notification-owner:${ownerUserId}`]);
}

export async function saveNotification(tx: Pick<Transaction,'query'>, input: NotificationWrite) {
  uuid(input.ownerUserId);
  if (!CATEGORY.has(input.category) || !input.aggregationKey || input.aggregationKey.length > 200 || input.text.length > 500) throw new Error('INVALID_NOTIFICATION_EVENT');
  const url = safeUrl(input.internalUrl);
  await lockNotificationOwner(tx, input.ownerUserId);
  const id = randomUUID();
  const saved = await tx.query(`INSERT INTO notification(id,owner_user_id,category,aggregation_key,internal_url,text,source_id,event_count,last_activity_at,read_at,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,1,now(),NULL,now())
    ON CONFLICT(owner_user_id,aggregation_key) DO UPDATE SET event_count=notification.event_count+1,last_activity_at=now(),read_at=NULL,
      internal_url=EXCLUDED.internal_url,text=EXCLUDED.text,source_id=EXCLUDED.source_id
    RETURNING id`,[id,input.ownerUserId,input.category,input.aggregationKey,url,input.text,input.sourceId ?? null]);
  if (input.email && ['billing','account','security'].includes(input.category)) {
    const key = `notification:${input.category}:${input.aggregationKey}`;
    const delivery = { version:1, template:'notification', recipientUserId:input.ownerUserId, category:input.category,
      subject:input.email.subject, title:input.email.title, body:input.email.body, internalUrl:url };
    await tx.query(`INSERT INTO side_effect_delivery(id,channel,business_delivery_key,attempts,provider_reference,result,created_at,status,payload,max_attempts,next_attempt_at,owner_user_id,category,updated_at)
      VALUES($1,'email',$2,0,NULL,NULL,now(),'pending',$3::jsonb,5,now(),$4,$5,now()) ON CONFLICT(channel,business_delivery_key) DO NOTHING`,
      [randomUUID(),key,JSON.stringify(delivery),input.ownerUserId,input.category]);
  }
  return String(saved.rows[0]?.id ?? id);
}

export class NotificationService {
  constructor(private readonly pool: Pool, private readonly unsubscribeSecret = process.env.SESSION_SECRET ?? '',
    private readonly sourceVisible?: (publicationId:string,versionId:string)=>Promise<boolean>) {}

  private async sourceAuthorized(tx:Pick<Transaction,'query'>,publicationId:string,versionId:string) {
    if(this.sourceVisible)return this.sourceVisible(publicationId,versionId);
    if(process.env.NODE_ENV==='production'||['production','public'].includes((process.env.RELEASE_MODE??'').toLowerCase()))return false;
    const source=await tx.query(`SELECT 1 FROM publication p JOIN user_account u ON u.id=p.author_user_id AND u.status='active'
      WHERE p.id=$1 AND p.visibility='public' AND p.published_at IS NOT NULL AND p.current_version_id=$2`,[publicationId,versionId]);
    return Boolean(source.rowCount);
  }

  async listNotifications(ownerUserId: string, rawCursor?: unknown, rawLimit?: unknown, unreadOnlyInput?: unknown) {
    requireUuid(ownerUserId);
    const unreadOnly = unreadOnlyInput === true || unreadOnlyInput === 'true';
    if (unreadOnlyInput !== undefined && unreadOnlyInput !== true && unreadOnlyInput !== false && unreadOnlyInput !== 'true' && unreadOnlyInput !== 'false') throw new CommandError(400,'INVALID_FILTER');
    const limit = limitOf(rawLimit), cursor = decodeCursor(rawCursor,ownerUserId,unreadOnly);
    return withActorTransaction(this.pool,ownerUserId,async tx=>{
      const rows = await tx.query(`SELECT id,category,internal_url,text,source_id,event_count,created_at,read_at,
        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
        FROM notification WHERE owner_user_id=$1 AND ($2::boolean=false OR read_at IS NULL)
        AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid)) ORDER BY created_at DESC,id DESC LIMIT $5`,
      [ownerUserId,unreadOnly,cursor?.createdAt ?? null,cursor?.id ?? null,limit+1]);
      const selected=rows.rows.slice(0,limit);
      const items=[];
      for(const row of selected){
        if(row.source_id){
          const source=await tx.query('SELECT current_version_id FROM publication WHERE id=$1',[row.source_id]);
          const versionId=String(source.rows[0]?.current_version_id??'');
          if(!versionId||!await this.sourceAuthorized(tx,String(row.source_id),versionId)){row.internal_url='/app/notifications';row.source_id=null;}
        }
        items.push(projectNotification(row));
      }
      const last=selected.at(-1);
      const count = await tx.query<{count:number}>('SELECT count(*)::int AS count FROM notification WHERE owner_user_id=$1 AND read_at IS NULL',[ownerUserId]);
      return {items,nextCursor:rows.rows.length>limit&&last?cursorFor(last,ownerUserId,unreadOnly):null,unreadCount:Number(count.rows[0]?.count ?? 0)};
    });
  }

  async markRead(ownerUserId: string, id: string) {
    uuid(id);
    return withActorTransaction(this.pool,ownerUserId,async tx=>{
      const source=await tx.query(`SELECT n.source_id,p.current_version_id FROM notification n LEFT JOIN publication p ON p.id=n.source_id WHERE n.id=$1 AND n.owner_user_id=$2`,[id,ownerUserId]);
      if(source.rows[0]?.source_id){const versionId=String(source.rows[0].current_version_id??'');if(!versionId||!await this.sourceAuthorized(tx,String(source.rows[0].source_id),versionId))await tx.query("UPDATE notification SET source_id=NULL,internal_url='/app/notifications' WHERE id=$1 AND owner_user_id=$2",[id,ownerUserId]);}
      const row=await tx.query('UPDATE notification SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND owner_user_id=$2 RETURNING id',[id,ownerUserId]);
      if(!row.rowCount)throw new CommandError(404,'NOTIFICATION_NOT_FOUND');
    });
  }

  async readAll(ownerUserId: string) {
    return withActorTransaction(this.pool,ownerUserId,async tx=>{
      await lockNotificationOwner(tx,ownerUserId);
      // Keep PostgreSQL microseconds inside SQL; a JS Date cutoff can miss same-millisecond notices.
      await tx.query(`WITH boundary AS MATERIALIZED (SELECT clock_timestamp() AS cutoff)
        UPDATE notification n SET read_at=b.cutoff FROM boundary b WHERE n.owner_user_id=$1 AND n.read_at IS NULL AND n.created_at<=b.cutoff`,[ownerUserId]);
    });
  }

  async listSavedSearches(ownerUserId: string, rawCursor?: unknown, rawLimit?: unknown) {
    requireUuid(ownerUserId);const limit=limitOf(rawLimit),after=decodeSearchCursor(rawCursor,ownerUserId);
    return withActorTransaction(this.pool,ownerUserId,async tx=>{
      const rows=await tx.query(`SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at FROM saved_search
        WHERE owner_user_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4`,[ownerUserId,after?.createdAt??null,after?.id??null,limit+1]);
      const selected=rows.rows.slice(0,limit),last=selected.at(-1);
      return {items:selected.map(projectSearch),nextCursor:rows.rows.length>limit&&last?searchCursor(last,ownerUserId):null};
    });
  }

  async createSavedSearch(ownerUserId: string, idempotencyKey: string, input: {name:unknown;filters:unknown}) {
    const name=nameOf(input.name),filters=normalizedFilters(input.filters);
    const result=await executeIdempotentCommand(this.pool,{actorUserId:ownerUserId,operation:'saved-search.create',idempotencyKey,input:{name,filters} as Json},async tx=>{
      await serializeUser(tx,ownerUserId);
      const entitlement=await effectivePlan(tx,ownerUserId);if(entitlement.plan!=='pro')throw new CommandError(403,'PRO_REQUIRED','Saved public searches are available on Pro.');
      const count=await tx.query<{count:number}>('SELECT count(*)::int AS count FROM saved_search WHERE owner_user_id=$1',[ownerUserId]);
      if(Number(count.rows[0]?.count ?? 0)>=5)throw new CommandError(403,'SAVED_SEARCH_LIMIT','Pro members can save up to five public searches.');
      if((await tx.query('SELECT 1 FROM saved_search WHERE owner_user_id=$1 AND lower(name)=lower($2)',[ownerUserId,name])).rowCount)throw new CommandError(409,'SAVED_SEARCH_NAME_EXISTS');
      const id=randomUUID();
      const row=await tx.query('INSERT INTO saved_search(id,owner_user_id,name,filters,revision,created_at,updated_at) VALUES($1,$2,$3,$4::jsonb,1,now(),now()) RETURNING *',[id,ownerUserId,name,JSON.stringify(filters)]);
      return {status:201,body:projectSearch(row.rows[0]!) as unknown as Json,resourceId:id};
    });return result.body;
  }

  async updateSavedSearch(ownerUserId:string,id:string,ifMatch:unknown,input:{name?:unknown;filters?:unknown}) {
    uuid(id);const revision=parseIfMatch(ifMatch);
    if(!input||typeof input!=='object'||(!Object.hasOwn(input,'name')&&!Object.hasOwn(input,'filters'))||Object.keys(input).some(key=>key!=='name'&&key!=='filters'))throw new CommandError(422,'INVALID_SAVED_SEARCH');
    const name=input.name===undefined?undefined:nameOf(input.name),filters=input.filters===undefined?undefined:normalizedFilters(input.filters);
    return withActorTransaction(this.pool,ownerUserId,async tx=>{
      await serializeUser(tx,ownerUserId);
      const current=await tx.query('SELECT * FROM saved_search WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',[id,ownerUserId]);
      if(!current.rows[0])throw new CommandError(404,'SAVED_SEARCH_NOT_FOUND');
      if((await effectivePlan(tx,ownerUserId)).plan!=='pro')throw new CommandError(403,'PRO_REQUIRED');
      if(name!==undefined&&(await tx.query('SELECT 1 FROM saved_search WHERE owner_user_id=$1 AND id<>$2 AND lower(name)=lower($3)',[ownerUserId,id,name])).rowCount)throw new CommandError(409,'SAVED_SEARCH_NAME_EXISTS');
      if(Number(current.rows[0].revision)!==revision)throw new CommandError(409,'STALE_REVISION');
      const row=await tx.query(`UPDATE saved_search SET name=$3,filters=$4::jsonb,revision=revision+1,updated_at=now() WHERE id=$1 AND owner_user_id=$2 AND revision=$5 RETURNING *`,
        [id,ownerUserId,name??current.rows[0].name,JSON.stringify(filters??current.rows[0].filters),revision]);
      if(!row.rows[0])throw new CommandError(409,'STALE_REVISION');return projectSearch(row.rows[0]);
    });
  }

  async deleteSavedSearch(ownerUserId:string,id:string,ifMatch:unknown) {
    uuid(id);const revision=parseIfMatch(ifMatch);
    return withActorTransaction(this.pool,ownerUserId,async tx=>{
      const result=await tx.query('DELETE FROM saved_search WHERE id=$1 AND owner_user_id=$2 AND revision=$3 RETURNING id',[id,ownerUserId,revision]);
      if(!result.rowCount){const exists=await tx.query('SELECT id FROM saved_search WHERE id=$1 AND owner_user_id=$2',[id,ownerUserId]);if(!exists.rowCount)throw new CommandError(404,'SAVED_SEARCH_NOT_FOUND');throw new CommandError(409,'STALE_REVISION');}
    });
  }

  makeUnsubscribeToken(ownerUserId:string, expiresAtSeconds:number) {
    uuid(ownerUserId);if(this.unsubscribeSecret.length<32||!Number.isSafeInteger(expiresAtSeconds))throw new Error('DIGEST_UNSUBSCRIBE_CONFIGURATION_INVALID');
    const expires=String(expiresAtSeconds),signature=createHmac('sha256',this.unsubscribeSecret).update(`digest-unsubscribe:v1:${ownerUserId}:${expires}`).digest('base64url');
    return `${ownerUserId}.${expires}.${signature}`;
  }

  async unsubscribeDigest(token:unknown) {
    if(typeof token!=='string'||token.length>300)throw new CommandError(400,'INVALID_UNSUBSCRIBE_TOKEN');
    const match=/^([0-9a-f-]{36})\.(\d{10})\.([A-Za-z0-9_-]{43})$/i.exec(token);
    if(!match||this.unsubscribeSecret.length<32)throw new CommandError(400,'INVALID_UNSUBSCRIBE_TOKEN');
    const [,owner,expiry,provided]=match;const expires=Number(expiry);
    if(!UUID.test(owner!)||expires<Date.now()/1000||expires>Date.now()/1000+366*24*60*60)throw new CommandError(400,'INVALID_UNSUBSCRIBE_TOKEN');
    const expected=createHmac('sha256',this.unsubscribeSecret).update(`digest-unsubscribe:v1:${owner}:${expiry}`).digest();
    let actual:Buffer;try{actual=Buffer.from(provided!,'base64url');}catch{throw new CommandError(400,'INVALID_UNSUBSCRIBE_TOKEN');}
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new CommandError(400,'INVALID_UNSUBSCRIBE_TOKEN');
    await this.pool.query(`INSERT INTO digest_suppression(owner_user_id,suppressed_at,updated_at) VALUES($1,now(),now())
      ON CONFLICT(owner_user_id) DO UPDATE SET suppressed_at=now(),updated_at=now()`,[owner]);
  }

  async digestSuppressed(ownerUserId:string) {
    const result=await this.pool.query('SELECT suppressed_at FROM digest_suppression WHERE owner_user_id=$1',[ownerUserId]);
    return Boolean(result.rows[0]?.suppressed_at);
  }
}
