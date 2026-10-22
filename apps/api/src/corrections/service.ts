import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { TradePlan } from '@trading/domain';
import { CommandError } from '../http/problem.js';
import { hydrateTradePlan, type ReferenceInstrument } from '../domain/reference-plan.js';
import { executeIdempotentCommand, type CommandTransaction, type Json } from '../persistence/transactions.js';
import { enqueueNotificationEvent, enqueueTransactionalNotification } from '../notifications/service.js';
import type { PositionService } from '../positions/service.js';

type JsonObject=Record<string,any>;
type CorrectionInput={reason:string;replacementTitle?:string;replacementThesis?:string;replacementPlan?:any;replacementChart?:any;replacementEvent?:{sourceEventId:string;event:any}};
type RequestRow={id:string;author_user_id:string;publication_id:string;source_version_id:string;reason:string;proposal:CorrectionInput;status:string;created_at:Date;reviewer_user_id:string|null;review_reason:string|null;publication_job_id:string|null};
type VersionRow={id:string;sequence:number;terms:JsonObject;thesis:string|null;chart:JsonObject|null;disclosures:JsonObject|null};
const obj=(value:unknown):JsonObject=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as JsonObject:{};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CorrectionSnapshotPatch { title?: string; thesis?: string; plan?: JsonObject; chart?: JsonObject }
export interface CorrectionSnapshotQueueInput {
  publicationId:string; ownerUserId:string; sourceVersionId:string; correctionRequestId:string; reason:string;
  patch:CorrectionSnapshotPatch; replacementEvent?:CorrectionInput['replacementEvent'];
}
export type QueueCorrectionSnapshot = (tx:Pick<CommandTransaction,'query'>,input:CorrectionSnapshotQueueInput)=>Promise<{jobId:string;publicationVersionId:string}>;

function projectRequest(row:RequestRow){return {id:row.id,publicationId:row.publication_id,sourceVersionId:row.source_version_id,status:row.status,createdAt:new Date(row.created_at).toISOString(),reason:row.reason,proposal:row.proposal,...(row.publication_job_id?{publicationJobId:row.publication_job_id}:{})};}
function cursorFor(row:RequestRow){return Buffer.from(JSON.stringify({v:1,createdAt:row.created_at.toISOString(),id:row.id})).toString('base64url');}
function decodeCursor(value:unknown){if(value===undefined||value==='')return undefined;if(typeof value!=='string'||value.length>500)throw new CommandError(400,'INVALID_CURSOR');try{const c=JSON.parse(Buffer.from(value,'base64url').toString('utf8')) as {v:number;createdAt:string;id:string};if(c.v!==1||!Number.isFinite(Date.parse(c.createdAt))||new Date(c.createdAt).toISOString()!==c.createdAt||!UUID.test(c.id))throw new Error();return c;}catch{throw new CommandError(400,'INVALID_CURSOR');}}

async function appendVersion(tx:CommandTransaction,publicationId:string,current:VersionRow,patch:{title?:string;thesis?:string;plan?:JsonObject;chart?:JsonObject},reason:string){
  const terms={...current.terms,...(patch.title===undefined?{}:{title:patch.title}),...(patch.plan===undefined?{}:{plan:patch.plan})};
  const disclosures={...obj(current.disclosures),correctionReason:reason};
  // Immutable failed candidates can leave sequence gaps above the visible pointer.
  // Allocate after every previously reserved version while the publication is locked.
  const next=await tx.query<{sequence:number}>('SELECT COALESCE(MAX(sequence),0)::int+1 AS sequence FROM publication_version WHERE publication_id=$1',[publicationId]);
  const versionId=randomUUID();const sequence=Number(next.rows[0]?.sequence??Number(current.sequence)+1);
  await tx.query(`INSERT INTO publication_version(id,publication_id,sequence,previous_version_id,terms,thesis,chart,disclosures,created_at)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8::jsonb,CURRENT_TIMESTAMP)`,[
    versionId,publicationId,sequence,current.id,JSON.stringify(terms),patch.thesis===undefined?current.thesis:patch.thesis,
    patch.chart===undefined?current.chart:JSON.stringify(patch.chart),JSON.stringify(disclosures),
  ]);
  await tx.query('UPDATE publication SET current_version_id=$2 WHERE id=$1',[publicationId,versionId]);
  const chart=await tx.query<{schema_version:number;state:JsonObject;provenance:JsonObject;revision:number}>(`SELECT schema_version,state,provenance,revision FROM chart_state WHERE publication_version_id=$1`,[current.id]);
  if(!chart.rows[0])throw new CommandError(409,'CORRECTION_CHART_UNAVAILABLE','The original frozen chart is unavailable; the correction was not published.');
  await tx.query(`INSERT INTO chart_state(id,owner_user_id,draft_id,publication_version_id,schema_version,state,provenance,revision,created_at)
    VALUES($1,NULL,NULL,$2,$3,$4::jsonb,$5::jsonb,$6,CURRENT_TIMESTAMP)`,[randomUUID(),versionId,chart.rows[0].schema_version,JSON.stringify(chart.rows[0].state),JSON.stringify(chart.rows[0].provenance),chart.rows[0].revision]);
  const snapshot=await tx.query<{owner_user_id:string;resource_id:string;processed_key:string;dimensions:JsonObject;checksum:string;declared_mime:string}>(`SELECT owner_user_id,resource_id,processed_key,dimensions,checksum,declared_mime FROM media
    WHERE id=$1 AND purpose='chart_snapshot' AND resource_type='publication' AND resource_id=$2 AND status='ready' AND processed_key IS NOT NULL FOR SHARE`,[current.id,publicationId]);
  if(!snapshot.rows[0])throw new CommandError(409,'CORRECTION_SNAPSHOT_UNAVAILABLE','The original chart image is unavailable; the correction was not published.');
  const frozen=snapshot.rows[0];
  await tx.query(`INSERT INTO media(id,owner_user_id,purpose,resource_id,resource_type,version,quarantine_key,processed_key,dimensions,checksum,status,declared_mime,byte_size,expires_at,failure_code,created_at,updated_at)
    VALUES($1,$2,'chart_snapshot',$3,'publication',1,'',$4,$5::jsonb,$6,'ready',$7,NULL,NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,[versionId,frozen.owner_user_id,publicationId,frozen.processed_key,JSON.stringify(frozen.dimensions),frozen.checksum,frozen.declared_mime]);
  return {versionId,sequence};
}

async function referenceMap(tx:CommandTransaction,input:JsonObject,asOf:string):Promise<{plan:TradePlan;refs:Map<string,ReferenceInstrument>}>{
  const ids=[String(input.instrumentId??''),...(Array.isArray(input.legs)?input.legs.map((leg:JsonObject)=>String(leg.instrumentId??'')):[])];
  if(ids.some(id=>!UUID.test(id)))throw new CommandError(422,'INVALID_CORRECTION_PLAN');
  const result=await tx.query(`SELECT i.id,i.asset,i.vendor,i.vendor_id,i.underlying_id,i.venue,i.currency,i.enabled,
      m.id AS metadata_id,m.version,m.multiplier::text,m.tick_size::text,m.expiry,m.strike::text,m.option_type,m.root,m.contract_month,m.contract_year,m.adjusted
    FROM instrument i JOIN instrument_metadata_version m ON m.instrument_id=i.id
      AND m.version=(SELECT MAX(mx.version) FROM instrument_metadata_version mx WHERE mx.instrument_id=i.id)
    WHERE i.id=ANY($1::uuid[])`,[ids]);
  const refs=new Map<string,ReferenceInstrument>();
  for(const row of result.rows){refs.set(row.id as string,{id:row.id as string,asset:row.asset as ReferenceInstrument['asset'],symbol:row.vendor_id as string,currency:row.currency as string,enabled:Boolean(row.enabled),underlyingId:row.underlying_id as string|null,metadata:{id:row.metadata_id as string,version:Number(row.version),multiplier:String(row.multiplier),tickSize:String(row.tick_size),expiry:row.expiry?new Date(row.expiry as Date).toISOString():null,strike:row.strike===null?null:String(row.strike),optionType:row.option_type as 'call'|'put'|null,...(row.root===null||row.root===undefined?{}:{root:row.root as NonNullable<ReferenceInstrument['metadata']['root']>}),contractMonth:row.contract_month as number|null,contractYear:row.contract_year as number|null,adjusted:Boolean(row.adjusted)}});}
  const hydrated=hydrateTradePlan(input as any,refs,asOf);
  return {plan:hydrated.plan,refs};
}

export class CorrectionService {
  constructor(private readonly pool:Pool,private readonly positions:PositionService,private readonly queueCorrectionSnapshot?:QueueCorrectionSnapshot){}

  async request(authorUserId:string,publicationId:string,key:string,input:CorrectionInput){
    if(!UUID.test(publicationId))throw new CommandError(400,'INVALID_ID');
    if(typeof input.reason!=='string'||!input.reason.trim()||input.reason.trim().length>1000)throw new CommandError(422,'INVALID_CORRECTION_REASON');
    const title=input.replacementTitle;
    const thesis=input.replacementThesis;
    const structured=Boolean(input.replacementPlan||input.replacementChart||input.replacementEvent);
    if(title===undefined&&thesis===undefined&&!structured)throw new CommandError(422,'EMPTY_CORRECTION','Provide display text or a structured correction.');
    const result=await executeIdempotentCommand(this.pool,{actorUserId:authorUserId,operation:`publication-correction:${publicationId}`,idempotencyKey:key,input:JSON.parse(JSON.stringify(input)) as Json},async tx=>{
      const found=await tx.query<VersionRow&{author_user_id:string;current_version_id:string|null;locked_current_version_id:string;visibility:string;published_at:Date|null;kind:string}>(`SELECT v.*,p.author_user_id,p.current_version_id,p.current_version_id AS locked_current_version_id,p.visibility,p.published_at,p.kind
        FROM publication p JOIN publication_version v ON v.id=p.current_version_id WHERE p.id=$1 FOR UPDATE OF p`,[publicationId]);
      const publication=found.rows[0];
      if(!publication||publication.author_user_id!==authorUserId||publication.visibility!=='public'||!publication.published_at)throw new CommandError(404,'PUBLICATION_NOT_FOUND');
      const inFlight=await tx.query('SELECT id FROM correction_request WHERE publication_id=$1 AND status=$2 LIMIT 1',[publicationId,'processing']);
      if(inFlight.rowCount)throw new CommandError(409,'CORRECTION_PROCESSING','A structured correction is still being prepared for this publication.');
      if(publication.kind==='education'&&(input.replacementPlan||input.replacementEvent))throw new CommandError(422,'EDUCATION_HAS_NO_POSITION');
      if(input.replacementTitle!==undefined&&(typeof title!=='string'||title.trim().length<1||title.length>120))throw new CommandError(422,'INVALID_CORRECTION_TITLE');
      if(input.replacementThesis!==undefined&&(typeof thesis!=='string'||thesis.length>10000))throw new CommandError(422,'INVALID_CORRECTION_THESIS');
      const id=randomUUID();const status=structured?'requested':'approved';const sourceVersionId=publication.locked_current_version_id;
      const proposal={...input,reason:input.reason.trim()};
      await tx.query(`INSERT INTO correction_request(id,author_user_id,publication_id,source_version_id,reason,proposal,status,created_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,CURRENT_TIMESTAMP)`,[id,authorUserId,publicationId,sourceVersionId,input.reason.trim(),JSON.stringify(proposal),status]);
      if(!structured){
        const appended=await appendVersion(tx,publicationId,publication,{...(title===undefined?{}:{title:title.trim()}),...(thesis===undefined?{}:{thesis})},input.reason.trim());
        await enqueueNotificationEvent(tx,'notification.bookmark_material_update','publication',publicationId,appended.sequence,{publicationId,authorUserId,versionId:appended.versionId});
      }
      const row=await tx.query<RequestRow>('SELECT id,author_user_id,publication_id,source_version_id,reason,proposal,status,created_at,reviewer_user_id,review_reason,publication_job_id FROM correction_request WHERE id=$1',[id]);
      const created=row.rows[0];
      if(!created)throw new CommandError(503,'CORRECTION_REQUEST_UNAVAILABLE');
      return {status:201,body:projectRequest(created) as unknown as Json,resourceId:id};
    });
    return result.body;
  }

  async listOwn(authorUserId:string,publicationId:string,cursor:unknown,limit:unknown){
    const take=limit===undefined?20:Number(limit);if(!Number.isInteger(take)||take<1||take>50)throw new CommandError(400,'INVALID_LIMIT');
    const after=decodeCursor(cursor);
    const publication=await this.pool.query('SELECT id FROM publication WHERE id=$1 AND author_user_id=$2',[publicationId,authorUserId]);
    if(!publication.rowCount)throw new CommandError(404,'PUBLICATION_NOT_FOUND');
    const result=await this.pool.query<RequestRow>(`SELECT id,author_user_id,publication_id,source_version_id,reason,proposal,status,created_at,reviewer_user_id,review_reason,publication_job_id
      FROM correction_request WHERE publication_id=$1 AND author_user_id=$2
      AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::uuid))
      ORDER BY created_at DESC,id DESC LIMIT $5`,[publicationId,authorUserId,after?.createdAt??null,after?.id??null,take+1]);
    const more=result.rows.length>take;const rows=result.rows.slice(0,take);
    return {items:rows.map(projectRequest),nextCursor:more&&rows.length?cursorFor(rows.at(-1)!):null};
  }

  async listQueue(cursor:unknown,limit:unknown){
    const take=limit===undefined?20:Number(limit);if(!Number.isInteger(take)||take<1||take>50)throw new CommandError(400,'INVALID_LIMIT');
    const after=decodeCursor(cursor);
    const result=await this.pool.query<RequestRow>(`SELECT id,author_user_id,publication_id,source_version_id,reason,proposal,status,created_at,reviewer_user_id,review_reason,publication_job_id
      FROM correction_request WHERE status='requested'
      AND ($1::timestamptz IS NULL OR (created_at,id)<($1::timestamptz,$2::uuid)) ORDER BY created_at DESC,id DESC LIMIT $3`,[after?.createdAt??null,after?.id??null,take+1]);
    const more=result.rows.length>take;const rows=result.rows.slice(0,take);
    return {items:rows.map(projectRequest),nextCursor:more&&rows.length?cursorFor(rows.at(-1)!):null};
  }

  async review(reviewerUserId:string,id:string,key:string,action:'approve'|'reject',reason:string){
    if(!UUID.test(id))throw new CommandError(400,'INVALID_ID');
    const result=await executeIdempotentCommand(this.pool,{actorUserId:reviewerUserId,operation:`correction-review:${id}`,idempotencyKey:key,input:{action,reason} as Json},async tx=>{
      const found=await tx.query<RequestRow&{current_version_id:string|null;kind:string}>(`SELECT c.*,p.current_version_id,p.kind FROM correction_request c
        JOIN publication p ON p.id=c.publication_id WHERE c.id=$1 FOR UPDATE OF c,p`,[id]);
      const correction=found.rows[0];if(!correction)throw new CommandError(404,'CORRECTION_NOT_FOUND');
      if(correction.author_user_id===reviewerUserId)throw new CommandError(403,'SELF_REVIEW_FORBIDDEN','You cannot review your own correction.');
      if(correction.status!=='requested')throw new CommandError(409,'CORRECTION_ALREADY_REVIEWED');
      const competing=await tx.query('SELECT id FROM correction_request WHERE publication_id=$1 AND status=$2 AND id<>$3 LIMIT 1',[correction.publication_id,'processing',id]);
      if(competing.rowCount)throw new CommandError(409,'CORRECTION_PROCESSING','Another structured correction is already being prepared for this publication.');
      if(!reason.trim()||reason.length>2000)throw new CommandError(422,'REVIEW_REASON_REQUIRED');
      const current=await tx.query<VersionRow>('SELECT id,sequence,terms,thesis,chart,disclosures FROM publication_version WHERE id=$1 FOR SHARE',[correction.current_version_id]);
      const version=current.rows[0];if(!version||version.id!==correction.source_version_id)throw new CommandError(409,'CORRECTION_SOURCE_STALE','The publication has a newer version. Review its current correction request.');
      let publicationJobId:string|null=null;
      if(action==='approve'){
        const patch:{title?:string;thesis?:string;plan?:JsonObject;chart?:JsonObject}={};
        if(correction.proposal.replacementTitle!==undefined)patch.title=correction.proposal.replacementTitle.trim();
        if(correction.proposal.replacementThesis!==undefined)patch.thesis=correction.proposal.replacementThesis;
        if(correction.proposal.replacementPlan){
          if(correction.kind==='education')throw new CommandError(422,'EDUCATION_HAS_NO_POSITION');
          await referenceMap(tx,correction.proposal.replacementPlan as JsonObject,new Date().toISOString());
          patch.plan=correction.proposal.replacementPlan as JsonObject;
        }
        if(correction.proposal.replacementChart){
          const chart=correction.proposal.replacementChart as JsonObject;
          const plan=patch.plan??version.terms.plan;
          const frozenChart=obj(version.chart);
          const referenceInstrumentId=typeof plan?.instrumentId==='string'?plan.instrumentId:frozenChart.instrumentId;
          if(typeof referenceInstrumentId!=='string'||chart.instrumentId!==referenceInstrumentId)throw new CommandError(422,'CORRECTION_CHART_REFERENCE_MISMATCH');
          patch.chart=chart;
        }
        if(!this.queueCorrectionSnapshot)throw new CommandError(503,'CORRECTION_SNAPSHOT_UNAVAILABLE','Trusted chart capture is unavailable; retry this review later.');
        const queued=await this.queueCorrectionSnapshot(tx,{publicationId:correction.publication_id,ownerUserId:correction.author_user_id,sourceVersionId:version.id,correctionRequestId:id,reason:correction.reason,patch,...(correction.proposal.replacementEvent?{replacementEvent:correction.proposal.replacementEvent}:{})});
        publicationJobId=queued.jobId;
      }
      const status=action==='approve'?'processing':'rejected';
      await tx.query('UPDATE correction_request SET status=$2,reviewer_user_id=$3,review_reason=$4,publication_job_id=$5 WHERE id=$1',[id,status,reviewerUserId,reason.trim(),publicationJobId]);
      if(action==='reject')await enqueueTransactionalNotification(tx,{recipientUserId:correction.author_user_id,category:'moderation',sourceId:correction.publication_id,internalUrl:`/ideas/${correction.publication_id}`,text:'Your requested publication correction was declined.'});
      const auditId=randomUUID();const audit={id:auditId,actor:reviewerUserId,resourceType:'correction_request',resourceId:id,action:action==='approve'?'correction_processing':'correction_rejected',reason:reason.trim(),requestId:null,metadata:{publicationId:correction.publication_id,...(publicationJobId?{publicationJobId}: {})},createdAt:new Date().toISOString()};
      await tx.query(`INSERT INTO audit_event(id,actor,resource_type,resource_id,action,reason,request_id,metadata,created_at)
        VALUES($1,$2,'correction_request',$3,$4,$5,NULL,$6::jsonb,CURRENT_TIMESTAMP)`,[auditId,reviewerUserId, id,`correction_${status}`,reason.trim(),JSON.stringify(audit.metadata)]);
      return {status:201,body:audit as unknown as Json,resourceId:id};
    });
    return result.body;
  }

  /** Called by successful trusted publication capture inside that job's transaction. */
  async finalizeCorrection(tx:Pick<CommandTransaction,'query'>,correctionRequestId:string,jobId:string,publicationVersionId:string){
    if(!UUID.test(correctionRequestId)||!UUID.test(jobId)||!UUID.test(publicationVersionId))throw new CommandError(400,'INVALID_ID');
    const found=await tx.query<RequestRow&{current_version_id:string|null}>(`SELECT c.*,p.current_version_id FROM correction_request c
      JOIN publication p ON p.id=c.publication_id WHERE c.id=$1 FOR UPDATE OF c,p`,[correctionRequestId]);
    const correction=found.rows[0];
    if(!correction)throw new CommandError(404,'CORRECTION_NOT_FOUND');
    if(correction.status==='approved'&&correction.publication_job_id===jobId)return {status:'approved',positionEvent:null};
    if(correction.status!=='processing'||correction.publication_job_id!==jobId)throw new CommandError(409,'CORRECTION_JOB_MISMATCH');
    if(correction.current_version_id!==correction.source_version_id)throw new CommandError(409,'CORRECTION_SOURCE_STALE');
    const candidate=await tx.query('SELECT id FROM publication_version WHERE id=$1 AND publication_id=$2 AND previous_version_id=$3 FOR SHARE',[publicationVersionId,correction.publication_id,correction.source_version_id]);
    if(!candidate.rowCount)throw new CommandError(409,'CORRECTION_CANDIDATE_MISMATCH');
    let positionEvent:unknown=null;
    if(correction.proposal.replacementEvent){
      const position=await tx.query<{id:string}>('SELECT id FROM position WHERE public_publication_id=$1 FOR UPDATE',[correction.publication_id]);
      if(!position.rows[0])throw new CommandError(404,'POSITION_NOT_FOUND');
      const replacement=correction.proposal.replacementEvent;
      positionEvent=await this.positions.applyCorrectedEvent(tx as any,position.rows[0].id,replacement.sourceEventId,replacement.event,publicationVersionId);
    }
    await tx.query("UPDATE correction_request SET status='approved' WHERE id=$1 AND status='processing' AND publication_job_id=$2",[correctionRequestId,jobId]);
    await enqueueTransactionalNotification(tx,{recipientUserId:correction.author_user_id,category:'moderation',sourceId:correction.publication_id,internalUrl:`/ideas/${correction.publication_id}`,text:'Your requested publication correction was approved.'});
    return {status:'approved',positionEvent};
  }
}
