import {recordActivation,recordProductEvent} from '../measurement/events.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { calculatePosition, decimal, formatDecimal, formatRatio, stateAtTime, type TradePlan } from '@trading/domain';
import type { components } from '@trading/contracts';
import { CommandError } from '../http/problem.js';
import { consumeQuota, executeIdempotentCommand, requireUuid, withActorTransaction, type CommandTransaction, type Json, type Transaction } from '../persistence/transactions.js';
import { hydrateTradePlan, type ReferenceInstrument } from '../domain/reference-plan.js';
import { effectivePlan, serializeUser } from '../workspace/entitlements.js';

type JournalWrite = components['schemas']['JournalWrite'];
type JournalRow = {
  id:string;revision:number;publication_id:string|null;title:string;thesis:string;notes:string|null;tags:string[];review:unknown;
  position_id:string|null;updated_at:Date;terms:Record<string,unknown>|null;published_thesis:string|null;position_state:string|null;
  plan:unknown|null;current_version_id:string|null;
};
type JournalFilters = { cursor?:unknown;limit?:unknown;q?:unknown;tag?:unknown;asset?:unknown;from?:unknown;to?:unknown;strategy?:unknown };
type AnalyticsFilters = { from?:unknown;to?:unknown;strategy?:unknown;tag?:unknown;asset?:unknown };
export type JournalPublicReadGuard=(publicationId:string,versionId:string,queryable:Transaction)=>Promise<void>;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REVISION=2_147_483_646;
const iso=(value:Date|string)=>value instanceof Date?value.toISOString():new Date(value).toISOString();
const record=(value:unknown):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};
const clean=(value:unknown,max:number)=>typeof value==='string'?value.trim().slice(0,max):'';

function validateWrite(input:JournalWrite,allowEmptyTitle=false) {
  const title=clean(input.title,120), thesis=clean(input.thesis,10000), notes=clean(input.notes,10000);
  if(title.length<1&&!allowEmptyTitle)throw new CommandError(422,'JOURNAL_TITLE_REQUIRED');
  if(typeof input.notes!=='string'||input.notes.length>10000)throw new CommandError(422,'INVALID_JOURNAL_NOTES');
  if(input.thesis!==undefined&&typeof input.thesis!=='string')throw new CommandError(422,'INVALID_JOURNAL_THESIS');
  const tags=Array.isArray(input.tags)?input.tags.map(value=>clean(value,40)).filter(Boolean):[];
  if(tags.length>20||new Set(tags.map(tag=>tag.toLocaleLowerCase())).size!==tags.length)throw new CommandError(422,'INVALID_JOURNAL_TAGS');
  const review=input.review===undefined?'':clean(input.review,10000);
  if(input.review!==undefined&&typeof input.review!=='string')throw new CommandError(422,'INVALID_JOURNAL_REVIEW');
  return {title,thesis,notes,tags,review,publicationId:input.publicationId??null,apiPlan:input.plan??null};
}

function cursorTimestamp(value:unknown):string {
  if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value))return value;
  return iso(value as Date|string).replace(/\.(\d{3})Z$/,'.$1000Z');
}
function filterBinding(ownerId:string,filters:unknown) {
  return createHash('sha256').update(JSON.stringify([ownerId,filters])).digest('hex');
}
function decodeCursor(value:unknown,ownerId:string,binding:string):{updatedAt:string;id:string}|undefined {
  if(value===undefined||value==='')return undefined;
  if(typeof value!=='string'||value.length>500)throw new CommandError(400,'INVALID_CURSOR');
  try {
    const item=JSON.parse(Buffer.from(value,'base64url').toString('utf8')) as {v?:number;updatedAt?:string;id?:string;ownerId?:string;binding?:string};
    if(item.v!==1||item.ownerId!==ownerId||item.binding!==binding||!item.updatedAt||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(item.updatedAt)||!Number.isFinite(Date.parse(item.updatedAt))||!item.id||!UUID.test(item.id))throw new Error();
    return {updatedAt:item.updatedAt,id:item.id};
  }catch{throw new CommandError(400,'INVALID_CURSOR');}
}
function cursor(row:JournalRow,ownerId:string,binding:string){return Buffer.from(JSON.stringify({v:1,updatedAt:cursorTimestamp((row as JournalRow&{cursor_updated_at?:string}).cursor_updated_at??row.updated_at),id:row.id,ownerId,binding})).toString('base64url');}
function project(row:JournalRow) {
  const terms=record(row.terms);
  const linked=Boolean(row.publication_id);
  return {
    id:row.id,revision:Number(row.revision),publicationId:row.publication_id,
    title:linked?(row.terms?String(terms.title??''):''):row.title,
    notes:row.notes??'',tags:row.tags??[],review:typeof row.review==='string'?row.review:'',
    positionId:row.position_id,updatedAt:iso(row.updated_at),
    thesis:linked?(row.terms?(row.published_thesis??''):''):row.thesis,
    plan:linked?(row.terms?(terms.plan??null):null):row.plan,
  };
}
function inputJson(input:JournalWrite):Json{return JSON.parse(JSON.stringify(input)) as Json;}

async function filterLinkedRights(row:JournalRow,tx:Transaction,guard?:JournalPublicReadGuard,strict=false) {
  if(!row.publication_id||!row.terms||!row.current_version_id||!guard)return row;
  try { await guard(row.publication_id,row.current_version_id,tx); }
  catch(error){
    if(error instanceof CommandError&&error.status===404){
      if(strict)throw new CommandError(404,'PUBLICATION_NOT_FOUND');
      return {...row,terms:null,published_thesis:null};
    }
    throw error;
  }
  return row;
}

async function loadJournal(tx:Transaction,ownerId:string,id:string,lock=false,guard?:JournalPublicReadGuard):Promise<JournalRow> {
  requireUuid(id);
  const result=await tx.query<JournalRow>(`SELECT j.id,j.revision,j.publication_id,j.title,j.thesis,j.notes,j.tags,j.review,j.position_id,j.updated_at,
      CASE WHEN p.visibility='public' AND p.published_at IS NOT NULL AND author.status='active' THEN v.terms ELSE NULL END AS terms,
      CASE WHEN p.visibility='public' AND p.published_at IS NOT NULL AND author.status='active' THEN v.thesis ELSE NULL END AS published_thesis,
      pos.state AS position_state,
      CASE WHEN j.publication_id IS NULL THEN pos.plan->'privateApiPlan' ELSE NULL END AS plan,p.current_version_id
    FROM journal_entry j
    LEFT JOIN publication p ON p.id=j.publication_id
    LEFT JOIN user_account author ON author.id=p.author_user_id
    LEFT JOIN publication_version v ON v.id=p.current_version_id
    LEFT JOIN position pos ON pos.id=j.position_id AND pos.owner_user_id=j.owner_user_id
    WHERE j.id=$1 AND j.owner_user_id=$2 AND j.deleted_at IS NULL${lock?' FOR UPDATE OF j':''}`,[id,ownerId]);
  if(!result.rows[0])throw new CommandError(404,'JOURNAL_ENTRY_NOT_FOUND');
  return filterLinkedRights(result.rows[0],tx,guard);
}

async function loadReferences(tx:Transaction,ids:string[]):Promise<Map<string,ReferenceInstrument>> {
  if(!ids.length)return new Map();
  if(ids.some(id=>!UUID.test(id))||new Set(ids).size!==ids.length)throw new CommandError(422,'INVALID_INSTRUMENT_REFERENCE');
  const result=await tx.query(`SELECT i.id,i.asset,i.vendor_id,i.currency,i.enabled,i.underlying_id,m.id AS metadata_id,m.version,m.multiplier::text,m.tick_size::text,
      m.expiry,m.strike::text,m.option_type,m.root,m.contract_month,m.contract_year,m.adjusted
    FROM instrument i JOIN instrument_metadata_version m ON m.instrument_id=i.id AND m.version=(SELECT MAX(mx.version) FROM instrument_metadata_version mx WHERE mx.instrument_id=i.id)
    WHERE i.id=ANY($1::uuid[]) FOR SHARE OF i,m`,[ids]);
  const refs=new Map<string,ReferenceInstrument>();
  for(const row of result.rows){
    refs.set(row.id,{id:row.id,asset:row.asset,symbol:row.vendor_id,currency:row.currency,enabled:Boolean(row.enabled),underlyingId:row.underlying_id,
      metadata:{id:row.metadata_id,version:Number(row.version),multiplier:String(row.multiplier),tickSize:String(row.tick_size),...(row.expiry?{expiry:iso(row.expiry)}:{}),...(row.strike?{strike:String(row.strike)}:{}),...(row.option_type?{optionType:row.option_type}:{}),...(row.root?{root:row.root}:{}),...(row.contract_month?{contractMonth:Number(row.contract_month)}:{}),...(row.contract_year?{contractYear:Number(row.contract_year)}:{}),adjusted:Boolean(row.adjusted)}});
  }
  if(refs.size!==ids.length)throw new CommandError(422,'INVALID_INSTRUMENT_REFERENCE');
  return refs;
}

async function createPrivatePosition(tx:CommandTransaction,ownerId:string,journalId:string,apiPlan:components['schemas']['TradePlan']) {
  const ids=[apiPlan.instrumentId,...apiPlan.legs.map(leg=>leg.instrumentId)];
  const refs=await loadReferences(tx,ids);
  const hydrated=hydrateTradePlan(apiPlan,refs,new Date().toISOString());
  let initialRisk:string;
  try {
    const calculation=calculatePosition({plan:hydrated.plan,entryCosts:null,exits:[]});
    if(!calculation.initialRisk||decimal(calculation.initialRisk)<=0n)throw new Error();
    initialRisk=calculation.initialRisk;
  }catch{throw new CommandError(422,'INITIAL_RISK_UNAVAILABLE');}
  const primary=refs.get(apiPlan.instrumentId)!;
  const primaryVersion=hydrated.referenceVersions[0]!;
  const id=randomUUID();
  await tx.query(`INSERT INTO position(id,owner_user_id,public_publication_id,private_journal_entry_id,state,plan,instrument_id,metadata_version_id,remaining_quantity,initial_risk,calculation_version,revision,risk_source_version_id,created_at,updated_at)
    VALUES($1,$2,NULL,$3,'pending',$4::jsonb,$5,$6,$7,$8,'1',1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,[
    id,ownerId,journalId,JSON.stringify({...hydrated.plan,privateApiPlan:apiPlan}),primary.id,primaryVersion.metadataVersionId,hydrated.plan.quantity,initialRisk]);
  for(const [index,reference] of hydrated.referenceVersions.slice(1).entries()){
    const leg=hydrated.plan.legs?.[index];
    if(!leg)throw new CommandError(422,'INVALID_OPTION_CONTRACT');
    await tx.query('INSERT INTO position_leg(id,position_id,instrument_id,metadata_version_id,side,quantity) VALUES($1,$2,$3,$4,$5,$6)',[
      randomUUID(),id,reference.instrumentId,reference.metadataVersionId,leg.side,leg.quantity]);
  }
  await tx.query('UPDATE journal_entry SET position_id=$2,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND owner_user_id=$3',[journalId,id,ownerId]);
  return {id,plan:hydrated.plan as TradePlan};
}

async function createLinkedPositionCopy(tx:CommandTransaction,ownerId:string,journalId:string,source:Record<string,any>) {
  if(!source.domain_plan||!source.initial_risk||!source.instrument_id||!source.metadata_version_id)throw new CommandError(409,'LINKED_POSITION_UNAVAILABLE');
  const apiPlan=record(source.api_plan);
  if(!apiPlan.instrumentId||!Array.isArray(apiPlan.legs))throw new CommandError(409,'LINKED_POSITION_UNAVAILABLE');
  const id=randomUUID(),domainPlan=record(source.domain_plan);
  await tx.query(`INSERT INTO position(id,owner_user_id,public_publication_id,private_journal_entry_id,state,plan,instrument_id,metadata_version_id,remaining_quantity,initial_risk,calculation_version,revision,risk_source_version_id,created_at,updated_at)
    VALUES($1,$2,NULL,$3,'pending',$4::jsonb,$5,$6,$7,$8,'1',1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,[
    id,ownerId,journalId,JSON.stringify({...domainPlan,privateApiPlan:apiPlan}),source.instrument_id,source.metadata_version_id,Number(domainPlan.quantity),source.initial_risk]);
  const legs=await tx.query('SELECT instrument_id,metadata_version_id,side,quantity FROM position_leg WHERE position_id=$1 ORDER BY id',[source.position_id]);
  for(const leg of legs.rows)await tx.query('INSERT INTO position_leg(id,position_id,instrument_id,metadata_version_id,side,quantity) VALUES($1,$2,$3,$4,$5,$6)',[
    randomUUID(),id,leg.instrument_id,leg.metadata_version_id,leg.side,leg.quantity]);
  await tx.query('UPDATE journal_entry SET position_id=$2,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND owner_user_id=$3',[journalId,id,ownerId]);
  return id;
}

export class JournalService {
  constructor(private readonly pool:Pool,private readonly assertPublicRead?:JournalPublicReadGuard) {}

  async create(ownerId:string,idempotencyKey:string,input:JournalWrite) {
    const values=validateWrite(input);
    if(values.publicationId&&values.apiPlan)throw new CommandError(422,'LINKED_PUBLICATION_READ_ONLY');
    const result=await executeIdempotentCommand(this.pool,{actorUserId:ownerId,operation:'journal-entry:create',idempotencyKey,input:inputJson(input)},async tx=>{
      await serializeUser(tx,ownerId);
      const entitlements=await effectivePlan(tx,ownerId);
      await consumeQuota(tx,'journal_monthly',entitlements.journalMonthly);
      const journalId=randomUUID();
      let publicationId:string|null=null,positionId:string|null=null,title=values.title,thesis=values.thesis;
      let linkedPosition:Record<string,any>|null=null;
      if(values.publicationId){
        requireUuid(values.publicationId);
        const linked=await tx.query(`SELECT p.id,p.author_user_id,p.current_version_id,v.terms,v.thesis,v.disclosures,pos.id AS position_id,pos.plan AS domain_plan,
            pos.initial_risk::text,pos.instrument_id,pos.metadata_version_id
          FROM publication p JOIN publication_version v ON v.id=p.current_version_id
          LEFT JOIN position pos ON pos.public_publication_id=p.id AND pos.owner_user_id=p.author_user_id
          JOIN user_account author ON author.id=p.author_user_id AND author.status='active'
          WHERE p.id=$1 AND p.visibility='public' AND p.published_at IS NOT NULL FOR SHARE OF p,v`,[values.publicationId]);
        const row=linked.rows[0];
        if(!row)throw new CommandError(404,'PUBLICATION_NOT_FOUND');
        await this.assertPublicRead?.(values.publicationId,row.current_version_id,tx);
        publicationId=values.publicationId;positionId=row.author_user_id===ownerId?(row.position_id??null):null;
        const terms=record(row.terms);title=String(terms.title??title);thesis=String(row.thesis??thesis);
        if(row.position_id&&row.author_user_id!==ownerId)linkedPosition={...row,api_plan:terms.plan};
      }
      await tx.query(`INSERT INTO journal_entry(id,owner_user_id,publication_id,position_id,title,thesis,notes,tags,review,revision,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,[
        journalId,ownerId,publicationId,positionId,publicationId?'':title,publicationId?'':thesis,values.notes,values.tags,JSON.stringify(values.review)]);
      if(linkedPosition)positionId=await createLinkedPositionCopy(tx,ownerId,journalId,linkedPosition);
      if(!publicationId&&values.apiPlan){
        const position=await createPrivatePosition(tx,ownerId,journalId,values.apiPlan as components['schemas']['TradePlan']);
        positionId=position.id;
      }
      const saved=await loadJournal(tx,ownerId,journalId,false,this.assertPublicRead);
      const body=project(saved);
      await recordActivation(tx,ownerId,'journal');
      return {status:201,body:body as unknown as Json,resourceId:journalId};
    });
    return result.body as unknown as ReturnType<typeof project>;
  }

  async list(ownerId:string,filters:JournalFilters={}) {
    const take=filters.limit===undefined?20:Number(filters.limit);
    if(!Number.isInteger(take)||take<1||take>50)throw new CommandError(400,'INVALID_LIMIT');
    const q=typeof filters.q==='string'?filters.q.trim().slice(0,200):'';
    const tag=typeof filters.tag==='string'?filters.tag.trim().slice(0,40):'';
    const asset=typeof filters.asset==='string'?filters.asset:'';
    if(asset&&!['stock','option','future'].includes(asset))throw new CommandError(400,'INVALID_ASSET');
    const advanced=[filters.from,filters.to,filters.strategy].some(value=>value!==undefined&&value!=='');
    const entitlements=await effectivePlan({query:(sql,values)=>this.pool.query(sql,values)},ownerId);
    if(advanced&&entitlements.plan!=='pro')throw new CommandError(403,'PRO_ENTITLEMENT_REQUIRED','Period and strategy filters require Pro.');
    const from=filters.from===undefined?null:String(filters.from),to=filters.to===undefined?null:String(filters.to);
    for(const value of [from,to])if(value!==null&&(!Number.isFinite(Date.parse(value))||!value.endsWith('Z')))throw new CommandError(400,'INVALID_PERIOD');
    if(from&&to&&Date.parse(from)>Date.parse(to))throw new CommandError(400,'INVALID_PERIOD');
    const strategy=typeof filters.strategy==='string'?filters.strategy:'';
    const binding=filterBinding(ownerId,{q,tag,asset,from,to,strategy});
    const after=decodeCursor(filters.cursor,ownerId,binding);
    const client=await this.pool.connect();
    try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result=await client.query<JournalRow>(`SELECT j.id,j.revision,j.publication_id,j.title,j.thesis,j.notes,j.tags,j.review,j.position_id,j.updated_at,
        CASE WHEN p.visibility='public' AND p.published_at IS NOT NULL AND author.status='active' THEN v.terms ELSE NULL END AS terms,
        CASE WHEN p.visibility='public' AND p.published_at IS NOT NULL AND author.status='active' THEN v.thesis ELSE NULL END AS published_thesis,
        pos.state AS position_state,CASE WHEN j.publication_id IS NULL THEN pos.plan->'privateApiPlan' ELSE NULL END AS plan,p.current_version_id,
        to_char(j.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_updated_at
      FROM journal_entry j LEFT JOIN publication p ON p.id=j.publication_id LEFT JOIN user_account author ON author.id=p.author_user_id
      LEFT JOIN publication_version v ON v.id=p.current_version_id LEFT JOIN position pos ON pos.id=j.position_id AND pos.owner_user_id=j.owner_user_id
      WHERE j.owner_user_id=$1 AND j.deleted_at IS NULL
        AND ($2='' OR j.title ILIKE '%'||$2||'%' OR j.thesis ILIKE '%'||$2||'%' OR COALESCE(j.notes,'') ILIKE '%'||$2||'%')
        AND ($3='' OR $3=ANY(j.tags))
        AND ($4='' OR (CASE WHEN j.publication_id IS NULL THEN pos.plan->>'asset' ELSE v.terms->'plan'->>'asset' END)=$4)
        AND ($5::timestamptz IS NULL OR j.created_at >= $5::timestamptz)
        AND ($6::timestamptz IS NULL OR j.created_at < $6::timestamptz)
        AND ($7='' OR (CASE WHEN j.publication_id IS NULL THEN pos.plan->>'strategy' ELSE v.terms->'plan'->>'strategy' END)=$7)
        AND ($8::timestamptz IS NULL OR j.updated_at<$8::timestamptz OR (j.updated_at=$8::timestamptz AND j.id<$9::uuid))
      ORDER BY j.updated_at DESC,j.id DESC LIMIT $10`,[ownerId,q,tag,asset,from,to,strategy,after?.updatedAt??null,after?.id??null,take+1]);
    const hasMore=result.rows.length>take,rows=result.rows.slice(0,take);
    const authorized=[] as JournalRow[];
    for(const row of rows)authorized.push(await filterLinkedRights(row,client,this.assertPublicRead));
    await client.query('COMMIT');
    return {items:authorized.map(project),nextCursor:hasMore&&authorized.length?cursor(authorized.at(-1)!,ownerId,binding):null};
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
  }

  async get(ownerId:string,id:string) {
    const result=await this.pool.connect();
    try {
      await result.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const row=await loadJournal(result,ownerId,id,false,this.assertPublicRead);
      await result.query('COMMIT');
      return project(row);
    }catch(error){await result.query('ROLLBACK').catch(()=>undefined);throw error;}finally{result.release();}
  }

  async privatePositionId(ownerId:string,id:string) {
    requireUuid(id);
    const result=await this.pool.query<{position_id:string}>(`SELECT p.id AS position_id FROM journal_entry j JOIN position p
      ON p.id=j.position_id AND p.private_journal_entry_id=j.id AND p.public_publication_id IS NULL
      WHERE j.id=$1 AND j.owner_user_id=$2 AND j.deleted_at IS NULL`,[id,ownerId]);
    if(!result.rows[0])throw new CommandError(404,'JOURNAL_ENTRY_NOT_FOUND');
    return result.rows[0].position_id;
  }

  async update(ownerId:string,id:string,revision:number,input:JournalWrite) {
    return this.mutateOwned(ownerId,id,revision,async(tx,row)=>{
      const values=validateWrite(input,row.publication_id!==null);
      if(row.publication_id&&(input.publicationId!==undefined&&input.publicationId!==row.publication_id||input.plan!==undefined))throw new CommandError(422,'LINKED_PUBLICATION_READ_ONLY');
      const current=project(row);
      if(row.publication_id&&row.terms&&(values.title!==current.title||values.thesis!==current.thesis))throw new CommandError(422,'LINKED_PUBLICATION_READ_ONLY');
      if(!row.publication_id&&input.publicationId!==undefined&&input.publicationId!==null)throw new CommandError(422,'JOURNAL_LINK_IMMUTABLE');
      if(row.position_id&&input.plan!==undefined)throw new CommandError(422,'POSITION_PLAN_IMMUTABLE');
      const next=revision+1;
      await tx.query(`UPDATE journal_entry SET title=$3,thesis=$4,notes=$5,tags=$6,review=$7::jsonb,revision=$8,updated_at=CURRENT_TIMESTAMP
        WHERE id=$1 AND owner_user_id=$2 AND revision=$9`,[id,ownerId,row.publication_id?'':values.title,row.publication_id?'':values.thesis,values.notes,values.tags,JSON.stringify(values.review),next,revision]);
      if(values.review.trim()&&values.review!==row.review)await recordProductEvent(tx,ownerId,'review',`${id}:${next}`,{surface:'journal'});
      if(!row.publication_id&&!row.position_id&&values.apiPlan)await createPrivatePosition(tx,ownerId,id,values.apiPlan as components['schemas']['TradePlan']);
      const saved=await loadJournal(tx,ownerId,id,false,this.assertPublicRead);
      return project(saved);
    });
  }

  async delete(ownerId:string,id:string,revision:number) {
    return this.mutateOwned(ownerId,id,revision,async(tx)=>{
      await tx.query(`UPDATE journal_entry SET deleted_at=CURRENT_TIMESTAMP,title='',thesis='',notes=NULL,review=NULL,tags=ARRAY[]::text[],revision=revision+1,updated_at=CURRENT_TIMESTAMP
        WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL`,[id,ownerId]);
      return null;
    });
  }

  private async mutateOwned<T>(ownerId:string,id:string,revision:number,work:(tx:CommandTransaction,row:JournalRow)=>Promise<T>) {
    if(!Number.isSafeInteger(revision)||revision<1||revision>=MAX_REVISION)throw new CommandError(400,'INVALID_REVISION');
    return withActorTransaction(this.pool,ownerId,async tx=>{
      const row=await loadJournal(tx,ownerId,id,true,this.assertPublicRead);
      if(Number(row.revision)!==revision)throw new CommandError(409,'STALE_REVISION','Reload the current journal entry before saving.');
      return work(tx,row);
    });
  }

  async analytics(ownerId:string,filters:AnalyticsFilters={}) {
    const advanced=[filters.from,filters.to,filters.strategy,filters.tag,filters.asset].some(value=>value!==undefined&&value!=='');
    const entitlements=await effectivePlan({query:(sql,values)=>this.pool.query(sql,values)},ownerId);
    if(advanced&&entitlements.plan!=='pro')throw new CommandError(403,'PRO_ENTITLEMENT_REQUIRED','Filtered journal analytics require Pro.');
    const from=filters.from===undefined?null:String(filters.from),to=filters.to===undefined?null:String(filters.to);
    for(const value of [from,to])if(value!==null&&(!Number.isFinite(Date.parse(value))||!value.endsWith('Z')))throw new CommandError(400,'INVALID_PERIOD');
    if(from&&to&&Date.parse(from)>Date.parse(to))throw new CommandError(400,'INVALID_PERIOD');
    const tag=typeof filters.tag==='string'?filters.tag:'';
    const asset=typeof filters.asset==='string'?filters.asset:'';
    const strategy=typeof filters.strategy==='string'?filters.strategy:'';
    const rows=await this.pool.query(`WITH owned AS (
        SELECT j.id AS journal_id,j.tags,j.review,j.created_at AS journal_created,p.id AS position_id,p.state,p.plan,p.initial_risk::text,
          p.public_publication_id,p.created_at,pub.published_at,
          latest.net::text,latest.r_multiple::text,latest.cost_coverage,latest.eligibility,latest.exclusions
        FROM journal_entry j LEFT JOIN position p ON p.id=j.position_id AND p.owner_user_id=j.owner_user_id
        LEFT JOIN publication pub ON pub.id=p.public_publication_id AND pub.author_user_id=p.owner_user_id
        LEFT JOIN LATERAL (SELECT o.net,o.r_multiple,o.cost_coverage,o.eligibility,o.exclusions FROM outcome_snapshot o WHERE o.position_id=p.id
          ORDER BY o.source_event_cutoff DESC,o.created_at DESC LIMIT 1) latest ON true
        WHERE j.owner_user_id=$1 AND j.deleted_at IS NULL
          AND ($2::timestamptz IS NULL OR j.created_at >= $2::timestamptz) AND ($3::timestamptz IS NULL OR j.created_at < $3::timestamptz)
          AND ($4='' OR $4=ANY(j.tags))
      ) SELECT * FROM owned WHERE ($5='' OR plan->>'asset'=$5) AND ($6='' OR plan->>'strategy'=$6)`,[ownerId,from,to,tag,asset,strategy]);
    let totalEntries=rows.rows.length,openPositions=0,closedPositions=0,reviewEligible=0,reviewCompleted=0;
    let wins=0,losses=0,breakevens=0,incompleteCosts=0,eligibleOutcomes=0,rDenominator=0,total=0n,rNumerator=0n,rDen=1n;
    const excluded:Record<string,number>={retrospective:0,unresolved:0,open:0,canceled:0,never_entered:0,pending:0,educational:0,ineligible:0};
    const gcd=(a:bigint,b:bigint)=>{let x=a<0n?-a:a,y=b<0n?-b:b;while(y){const t=x%y;x=y;y=t;}return x||1n;};
    const asOf=new Date().toISOString();
    for(const row of rows.rows){
      if(row.position_id)row.state=stateAtTime(row.plan,row.state,asOf);
      if(row.position_id&&['entered','partially_closed'].includes(row.state))openPositions++;
      if(row.position_id&&row.state==='closed')closedPositions++;
      if(row.position_id&&['closed','unresolved'].includes(row.state)){reviewEligible++;if(typeof row.review==='string'&&row.review.trim())reviewCompleted++;}
      if(!row.position_id){excluded.educational=(excluded.educational??0)+1;continue;}
      if(row.state==='unresolved'){excluded.unresolved=(excluded.unresolved??0)+1;continue;}
      if(row.state==='entered'||row.state==='partially_closed'){excluded.open=(excluded.open??0)+1;continue;}
      if(row.state==='pending'){excluded.pending=(excluded.pending??0)+1;continue;}
      if(row.state==='canceled'){excluded.canceled=(excluded.canceled??0)+1;continue;}
      if(row.state==='never_entered'){excluded.never_entered=(excluded.never_entered??0)+1;continue;}
      if(row.eligibility==='retrospective'){excluded.retrospective=(excluded.retrospective??0)+1;continue;}
      if(row.eligibility!=='eligible'){excluded.ineligible=(excluded.ineligible??0)+1;continue;}
      if(row.cost_coverage!=='complete'||row.net===null){incompleteCosts++;continue;}
      const amount=decimal(row.net);eligibleOutcomes++;total+=amount;
      if(amount>0n)wins++;else if(amount<0n)losses++;else breakevens++;
      if(row.r_multiple!==null&&row.initial_risk&&decimal(row.initial_risk)>0n){
        // Snapshots store display-rounded R. Use exact net/risk values before
        // final presentation so the mean never averages rounded multiples.
        const numerator=decimal(row.net),denominator=decimal(row.initial_risk),common=gcd(rDen,denominator);
        rNumerator=rNumerator*(denominator/common)+numerator*(rDen/common);rDen*=denominator/common;
        const reduce=gcd(rNumerator,rDen);rNumerator/=reduce;rDen/=reduce;rDenominator++;
      }
    }
    const pro=entitlements.plan==='pro';
    return {
      plan:entitlements.plan,totalEntries,openPositions,closedPositions,
      reviewCompletionRate:pro?(reviewEligible?`${formatRatio(BigInt(reviewCompleted),BigInt(reviewEligible))}`:null):null,
      reviewCompleted,reviewEligible,
      outcomeDistribution:pro?{wins,losses,breakevens,incompleteCosts}:null,
      meanR:pro&&rDenominator?formatRatio(rNumerator,rDen*BigInt(rDenominator)):null,
      reportedRealizedPnl:pro&&eligibleOutcomes?formatDecimal(total):null,
      eligibleOutcomes,rDenominator,excluded,
    };
  }
}
