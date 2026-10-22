import { billingEntitlementScope, billingEntitlementPredicate } from '@trading/config';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { calculatePosition, type TradePlan } from '@trading/domain';
import type { components } from '@trading/contracts';
import { enqueueNotificationEvent } from '../notifications/service.js';
import { recordActivation, recordProductEvent } from '../measurement/events.js';
import { verifyPublicationRenderToken, type PublicationRenderClaims } from '@trading/media/snapshot-token';
import { CommandError } from '../http/problem.js';
import { executeIdempotentCommand, parseIfMatch, type CommandTransaction, type Transaction } from '../persistence/transactions.js';
import type { InstrumentService } from '../instruments/service.js';
import { hydrateTradePlan, type ReferenceInstrument } from '../domain/reference-plan.js';
import { initializePublishedPosition } from '../positions/persistence.js';
import { evaluateEditorialEligibility } from '../positions/editorial-eligibility.js';

type Obj = Record<string, any>;
type Queryable = Transaction;
type DraftRow = { id:string; owner_user_id:string; kind:string; title:string|null; thesis:string|null; plan:Obj; attachment_ids:string[]; revision:number; chart_revision:number; deleted_at:Date|null };
type SnapshotArtifact = { objectKey:string; checksum:string; width:number; height:number; mime:'image/webp' };
type PublishCommand = { draftRevision:number; chartRevision:number };
type SnapshotCandidate = {
  jobId:string; publicationId:string; publicationVersionId:string; publishMode?:'initial'|'correction'; sourceVersionId?:string|null; correctionRequestId?:string; replacementEvent?:{sourceEventId:string;event:Obj}; eventOnlyCorrection?:boolean; kind:'trade'|'education'; title:string; thesis:string;
  plan:components['schemas']['TradePlan']|null; chartState:components['schemas']['ChartState'];
  series:{instrumentId:string;asset:'stock'|'future';symbol:string;venue:string;currency:string;metadataVersion:number;tickSize:string;root?:string;contractMonth?:string;session:string;adjustment:'unadjusted';provider:string;providerReference:string;delaySeconds:number;demo:boolean;asOf:string;capabilities:Obj};
  bars:Obj[]; attachments:Array<{id:string;processedKey:string;checksum:string;width:number;height:number;mime:'image/webp'}>;
  disclosures:{evidence:'member_reported';providerVerified:false;demo:boolean;delaySeconds:number;asOf:string}; referenceVersions:Array<{instrumentId:string;metadataVersionId:string;metadataVersion:number}>; domainPlan?:TradePlan;
};

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const obj=(v:unknown):Obj=>v&&typeof v==='object'&&!Array.isArray(v)?v as Obj:{};
const iso=(v:Date|string)=>new Date(v).toISOString();
const slug=(value:string)=>value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,140)||'idea';
const makeError=(status:number,code:string,detail:string)=>new CommandError(status,code,detail);

function assertTitleAndThesis(title:unknown,thesis:unknown):asserts title is string {
  if(typeof title!=='string'||title.trim().length<3||title.trim().length>120)throw makeError(422,'PUBLICATION_TITLE_REQUIRED','Add a title between 3 and 120 characters.');
  if(typeof thesis!=='string'||thesis.trim().length<20||thesis.trim().length>10000)throw makeError(422,'PUBLICATION_THESIS_REQUIRED','Add an explanation between 20 and 10,000 characters.');
}
function assertPlanDetailFields(plan:Obj) {
  if(typeof plan.entryCondition!=='string'||!plan.entryCondition.trim()||plan.entryCondition.length>1000)throw makeError(422,'ENTRY_CONDITION_REQUIRED','Describe the entry condition.');
  if(!['intraday','swing','position'].includes(plan.timeframe))throw makeError(422,'TIMEFRAME_REQUIRED','Choose an intended timeframe.');
  if(typeof plan.exitRules!=='string'||!plan.exitRules.trim()||plan.exitRules.length>2000)throw makeError(422,'EXIT_RULES_REQUIRED','Describe the intended exit rules.');
  if(typeof plan.conflicts!=='string'||plan.conflicts.length>1000)throw makeError(422,'CONFLICTS_REQUIRED','State known conflicts or enter “none”.');
  if(typeof plan.entryUntil!=='string'||Date.parse(plan.entryUntil)<=Date.now())throw makeError(422,'ENTRY_WINDOW_EXPIRED','The entry window has expired. Update it before publishing.');
}
function maxDailyPosts(tx:CommandTransaction,ownerId:string) {
  const principal=createHash('sha256').update(ownerId).digest('hex');
  return tx.query(`INSERT INTO rate_limit_bucket(id,principal_hash,route,window_start,counter,expires_at)
    VALUES($1,$2,'/publications/daily',date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',1,date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'+interval '2 days')
    ON CONFLICT(principal_hash,route,window_start) DO UPDATE SET counter=rate_limit_bucket.counter+1
    WHERE rate_limit_bucket.counter<10 RETURNING counter`,[randomUUID(),principal]);
}
function quoteCandidate(row:Obj):ReferenceInstrument {
  const expiry=row.expiry?iso(row.expiry):undefined;
  return {id:row.id,asset:row.asset,symbol:row.vendor_id,currency:row.currency,enabled:Boolean(row.enabled),underlyingId:row.underlying_id,
    metadata:{id:row.metadata_id,version:Number(row.version),multiplier:String(row.multiplier),tickSize:String(row.tick_size),...(expiry?{expiry}:{}),...(row.strike!==null?{strike:String(row.strike)}:{}),...(row.option_type?{optionType:row.option_type}:{}),...(row.root?{root:row.root}:{}),...(row.contract_month?{contractMonth:Number(row.contract_month)}:{}),...(row.contract_year?{contractYear:Number(row.contract_year)}:{}),adjusted:Boolean(row.adjusted)}};
}

export class PublicationService {
  private correctionFinalizer?: (tx:Pick<CommandTransaction,'query'>,correctionRequestId:string,jobId:string,publicationVersionId:string)=>Promise<unknown>;
  constructor(private readonly pool:Pool, private readonly instruments:InstrumentService) {}
  setCorrectionFinalizer(finalizer:(tx:Pick<CommandTransaction,'query'>,correctionRequestId:string,jobId:string,publicationVersionId:string)=>Promise<unknown>) { this.correctionFinalizer=finalizer; }

  /** Freeze a reviewed correction as a new immutable version. The current pointer remains on
   * the source version until the trusted renderer completes and the completion transaction commits. */
  async queueCorrectionSnapshot(tx:Pick<CommandTransaction,'query'>,input:{publicationId:string;ownerUserId:string;sourceVersionId:string;correctionRequestId:string;reason:string;patch:{title?:string;thesis?:string;plan?:Obj;chart?:Obj};replacementEvent?:{sourceEventId:string;event:Obj}|undefined}):Promise<{jobId:string;publicationVersionId:string}> {
    const locked=await tx.query(`SELECT p.id,p.author_user_id,p.kind,p.current_version_id,p.visibility,p.published_at,v.id AS id,
        v.sequence,v.terms,v.thesis,v.chart,v.disclosures
      FROM publication p JOIN publication_version v ON v.id=p.current_version_id
      WHERE p.id=$1 FOR UPDATE OF p,v`,[input.publicationId]);
    const current=locked.rows[0];
    if(!current||current.author_user_id!==input.ownerUserId||current.current_version_id!==input.sourceVersionId||current.visibility!=='public'||!current.published_at)
      throw makeError(409,'CORRECTION_SOURCE_STALE','The publication changed before this correction could be captured.');
    const originalJob=await tx.query("SELECT draft_id FROM publication_job WHERE publication_id=$1 AND candidate->>'publishMode' IS DISTINCT FROM 'correction' ORDER BY created_at ASC LIMIT 1",[input.publicationId]);
    const draftId=originalJob.rows[0]?.draft_id as string|undefined;
    if(!draftId)throw makeError(409,'CORRECTION_DRAFT_UNAVAILABLE','The source publication draft is unavailable.');
    const replacementEvent=input.replacementEvent;
    if(replacementEvent&&Object.keys(input.patch).length===0)
      return this.queueEventOnlyCorrection(tx,{...input,replacementEvent},current,draftId);
    const terms=obj(current.terms);
    const title=input.patch.title??String(terms.title??'');
    const thesis=input.patch.thesis??String(current.thesis??'');
    assertTitleAndThesis(title,thesis);
    const chartState=(input.patch.chart??current.chart) as components['schemas']['ChartState'];
    if(!chartState||typeof chartState.instrumentId!=='string')throw makeError(422,'CHART_REQUIRED','A valid chart is required for the corrected version.');
    const apiPlan=(input.patch.plan??terms.plan??null) as components['schemas']['TradePlan']|null;
    const ids=[chartState.instrumentId,...(apiPlan?.legs??[]).map(leg=>leg.instrumentId)];
    const refs=await loadReferences(tx,ids);
    const primary=refs.get(chartState.instrumentId);
    if(!primary)throw makeError(422,'INVALID_INSTRUMENT_REFERENCE','The chart instrument is unavailable.');
    const primaryMeta=await this.instruments.get(primary.id,primary.metadata.version,'member',tx as any);
    requirePublishingCaps(primaryMeta.meta.capabilities,'chart');
    const publicPrimary=await this.instruments.get(primary.id,primary.metadata.version,'public',tx as any);
    requirePublicSnapshotCaps(publicPrimary.meta.capabilities);
    assertChartReference(chartState,primary,primaryMeta.meta.providerReference);
    let canonicalPlan:TradePlan|undefined;
    let referenceVersions=[{instrumentId:primary.id,metadataVersionId:primary.metadata.id,metadataVersion:primary.metadata.version}];
    if(current.kind==='trade') {
      if(!apiPlan||apiPlan.instrumentId!==chartState.instrumentId)throw makeError(422,'CHART_PLAN_INSTRUMENT_MISMATCH','The chart must use the trade plan underlying.');
      const normalized=hydrateTradePlan(apiPlan,refs,new Date().toISOString());
      canonicalPlan=normalized.plan;
      referenceVersions=normalized.referenceVersions;
      for(const reference of referenceVersions.slice(1)) {
        const metadata=await this.instruments.get(reference.instrumentId,reference.metadataVersion,'member',tx as any);
        requirePublishingCaps(metadata.meta.capabilities,'option contract');
        const publicMetadata=await this.instruments.get(reference.instrumentId,reference.metadataVersion,'public',tx as any);
        requirePublicDisplayCaps(publicMetadata.meta.capabilities,'option contract');
      }
      try { const risk=calculatePosition({plan:canonicalPlan,entryCosts:null,exits:[]}).initialRisk;if(!risk||Number(risk)<=0)throw new Error(); }
      catch { throw makeError(422,'TRADE_RISK_UNAVAILABLE','The corrected plan does not support a safe risk calculation.'); }
    } else if(apiPlan) throw makeError(422,'EDUCATION_HAS_NO_POSITION','Education publications cannot include a trade plan.');
    const barsResult=await this.instruments.bars(primary.id,{interval:chartState.interval,from:chartState.viewport.from,to:chartState.viewport.to,session:chartState.session,adjustment:'unadjusted',limit:10_000},'member',tx as any);
    if(!barsResult.bars.length||barsResult.nextCursor)throw makeError(422,'CHART_HISTORY_UNAVAILABLE','The chart history cannot be captured completely.');
    if(barsResult.meta.provider!==chartState.provenance.provider||barsResult.meta.demo!==chartState.provenance.demo)throw makeError(422,'CHART_PROVENANCE_MISMATCH','The current source does not match the chart provenance.');
    const originalAttachmentIds=Array.isArray(terms.attachmentIds)?terms.attachmentIds:[];
    const attachments=originalAttachmentIds.length?await tx.query(`SELECT id,processed_key,checksum,dimensions FROM media WHERE id=ANY($1::uuid[]) AND owner_user_id=$2 AND purpose='publication_attachment' AND resource_type='publication' AND resource_id=$3 AND status='ready' AND processed_key IS NOT NULL FOR SHARE`,[originalAttachmentIds,input.ownerUserId,input.publicationId]):{rows:[]};
    if(attachments.rows.length!==originalAttachmentIds.length)throw makeError(409,'ATTACHMENT_BINDING_CONFLICT','A frozen publication attachment is unavailable.');
    const nextSequence=await tx.query<{next_sequence:number}>("SELECT COALESCE(MAX(sequence),0)::int+1 AS next_sequence FROM publication_version WHERE publication_id=$1",[input.publicationId]);
    const publicationVersionId=randomUUID(),jobId=randomUUID(),nonce=randomUUID();
    const disclosures:SnapshotCandidate['disclosures'] & Obj={...obj(current.disclosures),evidence:'member_reported' as const,providerVerified:false as const,demo:barsResult.meta.demo,delaySeconds:barsResult.meta.delaySeconds,asOf:barsResult.meta.asOf??new Date().toISOString(),referenceVersions,correctionReason:input.reason};
    const nextTerms={...terms,title,plan:apiPlan,attachmentIds:originalAttachmentIds,disclosures:typeof apiPlan?.conflicts==='string'?apiPlan.conflicts:String(terms.disclosures??'')};
    const candidate:SnapshotCandidate={jobId,publicationId:input.publicationId,publicationVersionId,publishMode:'correction',sourceVersionId:current.id,correctionRequestId:input.correctionRequestId,...(input.replacementEvent?{replacementEvent:input.replacementEvent}:{}),kind:current.kind as 'trade'|'education',title,thesis,plan:apiPlan,chartState,
      series:{instrumentId:primary.id,asset:primary.asset as 'stock'|'future',symbol:primary.symbol,venue:String((primaryMeta as any).venue),currency:primary.currency,metadataVersion:primary.metadata.version,tickSize:primary.metadata.tickSize,...(primary.metadata.root?{root:primary.metadata.root}:{}),...(primary.metadata.contractMonth?{contractMonth:`${primary.metadata.contractYear}-${String(primary.metadata.contractMonth).padStart(2,'0')}`} :{}),session:chartState.session,adjustment:'unadjusted',provider:barsResult.meta.provider,providerReference:barsResult.meta.providerReference,delaySeconds:barsResult.meta.delaySeconds,demo:barsResult.meta.demo,asOf:barsResult.meta.asOf??disclosures.asOf,capabilities:combineCapabilities(primaryMeta.meta.capabilities,publicPrimary.meta.capabilities)},
      bars:barsResult.bars as unknown as Obj[],attachments:attachments.rows.map((a:any)=>({id:a.id,processedKey:a.processed_key,checksum:String(a.checksum),width:Number(obj(a.dimensions).width),height:Number(obj(a.dimensions).height),mime:'image/webp'})),disclosures,referenceVersions,...(canonicalPlan?{domainPlan:canonicalPlan}:{})};
    await tx.query('INSERT INTO publication_version(id,publication_id,sequence,previous_version_id,terms,thesis,chart,disclosures,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8::jsonb,now())',[publicationVersionId,input.publicationId,Number(nextSequence.rows[0]?.next_sequence??Number(current.sequence)+1),current.id,JSON.stringify(nextTerms),thesis,JSON.stringify(chartState),JSON.stringify(disclosures)]);
    await tx.query('INSERT INTO chart_state(id,owner_user_id,draft_id,publication_version_id,schema_version,state,provenance,revision,created_at) VALUES($1,NULL,NULL,$2,$3,$4::jsonb,$5::jsonb,1,now())',[randomUUID(),publicationVersionId,chartState.schemaVersion,JSON.stringify(chartState),JSON.stringify(chartState.provenance)]);
    await tx.query(`INSERT INTO publication_job(id,owner_user_id,draft_id,publication_id,publication_version_id,status,candidate,render_nonce,render_nonce_expires_at,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'pending',$6::jsonb,$7,$8,now(),now())`,[jobId,input.ownerUserId,draftId,input.publicationId,publicationVersionId,JSON.stringify(candidate),nonce,new Date(Date.now()+120_000).toISOString()]);
    await tx.query("INSERT INTO outbox_event(id,event_type,aggregate_type,aggregate_id,revision,payload,status,available_at,attempts,created_at) VALUES($1,'publication.snapshot','publication_job',$2,1,$3::jsonb,'pending',now(),0,now())",[randomUUID(),jobId,JSON.stringify({jobId})]);
    return {jobId,publicationVersionId};
  }

  /** Event-only history corrections reuse source-authorized frozen chart data. This lets
   * owners document an expired contract without treating it as a new publishing choice. */
  private async queueEventOnlyCorrection(tx:Pick<CommandTransaction,'query'>,input:{publicationId:string;ownerUserId:string;sourceVersionId:string;correctionRequestId:string;reason:string;replacementEvent:{sourceEventId:string;event:Obj}},current:Obj,draftId:string) {
    // Text-only revisions copy the frozen chart but do not create a render job.
    // Walk the committed visible lineage to find the nearest successful render.
    const source=await tx.query(`WITH RECURSIVE lineage AS (
        SELECT id,previous_version_id,0 AS depth FROM publication_version WHERE id=$2 AND publication_id=$1
        UNION ALL
        SELECT previous.id,previous.previous_version_id,lineage.depth+1
          FROM publication_version previous JOIN lineage ON previous.id=lineage.previous_version_id
         WHERE previous.publication_id=$1
      )
      SELECT job.candidate,lineage.id AS source_version_id FROM lineage
      JOIN publication_job job ON job.publication_version_id=lineage.id AND job.publication_id=$1 AND job.status='succeeded'
      ORDER BY lineage.depth ASC,job.created_at DESC LIMIT 1`,[input.publicationId,current.id]);
    const sourceCandidate=source.rows[0]?.candidate as SnapshotCandidate|undefined;
    if(!sourceCandidate)throw makeError(409,'CORRECTION_SOURCE_UNAVAILABLE','The committed chart source is unavailable for this correction.');
    const terms=obj(current.terms),chartState=sourceCandidate.chartState,plan=(terms.plan??null) as components['schemas']['TradePlan']|null;
    await this.assertPublicDataRights(chartState.instrumentId,chartState.metadataVersion,plan,sourceCandidate.disclosures,tx as any);
    const attachmentIds=Array.isArray(terms.attachmentIds)?terms.attachmentIds:[];
    const attachments=attachmentIds.length?await tx.query("SELECT id,processed_key,checksum,dimensions FROM media WHERE id=ANY($1::uuid[]) AND owner_user_id=$2 AND purpose='publication_attachment' AND resource_type='publication' AND resource_id=$3 AND status='ready' AND processed_key IS NOT NULL FOR SHARE",[attachmentIds,input.ownerUserId,input.publicationId]):{rows:[]};
    if(attachments.rows.length!==attachmentIds.length)throw makeError(409,'ATTACHMENT_BINDING_CONFLICT','A frozen publication attachment is unavailable.');
    const nextSequence=await tx.query<{next_sequence:number}>("SELECT COALESCE(MAX(sequence),0)::int+1 AS next_sequence FROM publication_version WHERE publication_id=$1",[input.publicationId]);
    const publicationVersionId=randomUUID(),jobId=randomUUID(),nonce=randomUUID();
    const currentDisclosures=obj(current.disclosures);
    const disclosures={...sourceCandidate.disclosures,...currentDisclosures,correctionReason:input.reason};
    const title=String(terms.title??sourceCandidate.title),thesis=String(current.thesis??sourceCandidate.thesis),
      nextTerms={...terms,title,plan,attachmentIds,disclosures:typeof plan?.conflicts==='string'?plan.conflicts:String(terms.disclosures??'')};
    const frozenAttachments=attachments.rows.map((row:any)=>{
      const dimensions=obj(row.dimensions);
      return {id:String(row.id),processedKey:String(row.processed_key),checksum:String(row.checksum),width:Number(dimensions.width),height:Number(dimensions.height),mime:'image/webp' as const};
    });
    const candidate:SnapshotCandidate={...sourceCandidate,jobId,publicationId:input.publicationId,publicationVersionId,publishMode:'correction',sourceVersionId:current.id,correctionRequestId:input.correctionRequestId,replacementEvent:input.replacementEvent,eventOnlyCorrection:true,title,thesis,plan,attachments:frozenAttachments,disclosures};
    await tx.query('INSERT INTO publication_version(id,publication_id,sequence,previous_version_id,terms,thesis,chart,disclosures,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8::jsonb,now())',[publicationVersionId,input.publicationId,Number(nextSequence.rows[0]?.next_sequence??Number(current.sequence)+1),current.id,JSON.stringify(nextTerms),thesis,JSON.stringify(chartState),JSON.stringify(disclosures)]);
    await tx.query('INSERT INTO chart_state(id,owner_user_id,draft_id,publication_version_id,schema_version,state,provenance,revision,created_at) VALUES($1,NULL,NULL,$2,$3,$4::jsonb,$5::jsonb,1,now())',[randomUUID(),publicationVersionId,chartState.schemaVersion,JSON.stringify(chartState),JSON.stringify(chartState.provenance)]);
    await tx.query("INSERT INTO publication_job(id,owner_user_id,draft_id,publication_id,publication_version_id,status,candidate,render_nonce,render_nonce_expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'pending',$6::jsonb,$7,$8,now(),now())",[jobId,input.ownerUserId,draftId,input.publicationId,publicationVersionId,JSON.stringify(candidate),nonce,new Date(Date.now()+120_000).toISOString()]);
    await tx.query("INSERT INTO outbox_event(id,event_type,aggregate_type,aggregate_id,revision,payload,status,available_at,attempts,created_at) VALUES($1,'publication.snapshot','publication_job',$2,1,$3::jsonb,'pending',now(),0,now())",[randomUUID(),jobId,JSON.stringify({jobId})]);
    return {jobId,publicationVersionId};
  }

  async publish(ownerId:string,draftId:string,ifMatch:unknown,key:string,input:PublishCommand) {
    if(!UUID.test(draftId))throw makeError(400,'INVALID_ID','Draft id is invalid.');
    const expected=parseIfMatch(ifMatch);
    if(input.draftRevision!==expected)throw makeError(409,'REVISION_CONFLICT','Draft revision does not match If-Match. Reload before publishing.');
    const idempotent=await executeIdempotentCommand(this.pool,{actorUserId:ownerId,operation:`draft-publish:${draftId}`,idempotencyKey:key,input:{draftId,draftRevision:input.draftRevision,chartRevision:input.chartRevision}},async tx=>{
      const result=await tx.query<DraftRow>('SELECT id,owner_user_id,kind,title,thesis,plan,attachment_ids,revision,chart_revision,deleted_at FROM draft WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL FOR UPDATE',[draftId,ownerId]);
      const draft=result.rows[0]; if(!draft)throw makeError(404,'DRAFT_NOT_FOUND','Draft is unavailable.');
      if(Number(draft.revision)!==expected)throw makeError(409,'REVISION_CONFLICT','Draft changed. Reload before publishing.');
      if(obj(draft.plan).published===true||obj(draft.plan).locked===true)throw makeError(409,'DRAFT_LOCKED','This draft is already locked.');
      if(!['trade','education'].includes(draft.kind))throw makeError(422,'INVALID_DRAFT_KIND','Choose a supported publication type.');
      assertTitleAndThesis(draft.title,draft.thesis);
      const chartResult=await tx.query<{id:string;revision:number;state:components['schemas']['ChartState']}>('SELECT id,revision,state FROM chart_state WHERE draft_id=$1 AND publication_version_id IS NULL FOR UPDATE',[draftId]);
      const chart=chartResult.rows[0]; if(!chart)throw makeError(422,'CHART_REQUIRED','Save a chart before publishing.');
      if(Number(draft.chart_revision)!==input.chartRevision||Number(chart.revision)!==input.chartRevision)throw makeError(409,'CHART_REVISION_CONFLICT','The saved chart changed. Reload before publishing.');
      const chartState=chart.state as any;
      const attachmentIds=Array.isArray(draft.attachment_ids)?draft.attachment_ids:[];
      if(attachmentIds.length>3||new Set(attachmentIds).size!==attachmentIds.length||attachmentIds.some(id=>typeof id!=='string'||!UUID.test(id)))throw makeError(422,'INVALID_DRAFT_ATTACHMENTS','Draft attachments are invalid. Remove them and try again.');
      const attachments=attachmentIds.length?await tx.query(`SELECT id,processed_key,checksum,dimensions,declared_mime,status FROM media WHERE id=ANY($1::uuid[]) AND owner_user_id=$2 AND purpose='publication_attachment' AND resource_type='draft' AND resource_id=$3 AND status='ready' AND processed_key IS NOT NULL FOR SHARE`,[attachmentIds,ownerId,draftId]):{rows:[]};
      if(attachments.rows.length!==attachmentIds.length)throw makeError(422,'DRAFT_ATTACHMENT_NOT_READY','Every attachment must be a completed, processed image assigned to this draft.');
      const ids=new Set<string>([chartState.instrumentId]);
      let apiPlan:components['schemas']['TradePlan']|null=null;
      let canonicalPlan:TradePlan|undefined;
      let referenceVersions:Array<{instrumentId:string;metadataVersionId:string;metadataVersion:number}> = [];
      if(draft.kind==='trade') {
        const plan=obj(draft.plan);
        assertPlanDetailFields(plan);
        if(!UUID.test(String(plan.instrumentId??''))||!Array.isArray(plan.legs))throw makeError(422,'INVALID_TRADE_PLAN','Complete the instrument and strategy fields before publishing.');
        if(plan.instrumentId!==chartState.instrumentId)throw makeError(422,'CHART_PLAN_INSTRUMENT_MISMATCH','The saved chart must use the plan underlying.');
        ids.add(plan.instrumentId); for(const leg of plan.legs) if(typeof leg?.instrumentId==='string')ids.add(leg.instrumentId);
        const refs=await loadReferences(tx,[...ids]);
        const primary=refs.get(plan.instrumentId);
        if(!primary)throw makeError(422,'INVALID_INSTRUMENT_REFERENCE','The selected instrument is unavailable.');
        const primaryMeta=await this.instruments.get(primary.id,primary.metadata.version,'member',tx as any);
        requirePublishingCaps(primaryMeta.meta.capabilities,'underlying');
        const publicPrimary=await this.instruments.get(primary.id,primary.metadata.version,'public',tx as any);
        requirePublicSnapshotCaps(publicPrimary.meta.capabilities);
        assertChartReference(chartState,primary,primaryMeta.meta.providerReference);
        const normalized=hydrateTradePlan(plan as components['schemas']['TradePlan'],refs,new Date().toISOString());
        canonicalPlan=normalized.plan;
        referenceVersions=normalized.referenceVersions;
        assertPlanDetailFields(plan);
        for(const legRef of referenceVersions.slice(1)) {
          const legMeta=await this.instruments.get(legRef.instrumentId,legRef.metadataVersion,'member',tx as any);
          requirePublishingCaps(legMeta.meta.capabilities,'option contract');
          const publicLeg=await this.instruments.get(legRef.instrumentId,legRef.metadataVersion,'public',tx as any);
          requirePublicDisplayCaps(publicLeg.meta.capabilities,'option contract');
        }
        apiPlan=plan as unknown as components['schemas']['TradePlan'];
      } else {
        const refs=await loadReferences(tx,[chartState.instrumentId]);
        const primary=refs.get(chartState.instrumentId); if(!primary)throw makeError(422,'INVALID_INSTRUMENT_REFERENCE','The chart instrument is unavailable.');
        const primaryMeta=await this.instruments.get(primary.id,chartState.metadataVersion,'member',tx as any);
        requirePublishingCaps(primaryMeta.meta.capabilities,'chart');
        const publicPrimary=await this.instruments.get(primary.id,chartState.metadataVersion,'public',tx as any);
        requirePublicSnapshotCaps(publicPrimary.meta.capabilities);
        assertChartReference(chartState,primary,primaryMeta.meta.providerReference);
        referenceVersions=[{instrumentId:primary.id,metadataVersionId:primary.metadata.id,metadataVersion:primary.metadata.version}];
      }
      const primaryId=draft.kind==='trade'?String((apiPlan as Obj).instrumentId):chartState.instrumentId;
      if(chartState.instrumentId!==primaryId)throw makeError(422,'CHART_PLAN_INSTRUMENT_MISMATCH','The saved chart must use the plan underlying.');
      const barsResult=await this.instruments.bars(primaryId,{interval:chartState.interval,from:chartState.viewport.from,to:chartState.viewport.to,session:chartState.session,adjustment:'unadjusted',limit:10_000},'member',tx as any);
      if(!barsResult.bars.length)throw makeError(422,'CHART_HISTORY_EMPTY','The chart has no source bars for the saved viewport.');
      if(barsResult.nextCursor)throw makeError(422,'CHART_HISTORY_TOO_LARGE','Narrow the saved chart range so the frozen snapshot includes the complete authorized history.');
      const primaryRef=await this.instruments.get(primaryId,chartState.metadataVersion,'member',tx as any);
      const publicPrimary=await this.instruments.get(primaryId,chartState.metadataVersion,'public',tx as any);
      requirePublicSnapshotCaps(publicPrimary.meta.capabilities);
      const metadataRows=await loadReferences(tx,[primaryId]); const frozenRef=metadataRows.get(primaryId)!;
      const demo=primaryRef.meta.demo===true;
      const disclosures={evidence:'member_reported' as const,providerVerified:false as const,demo,delaySeconds:barsResult.meta.delaySeconds,asOf:barsResult.meta.asOf??new Date().toISOString(),referenceVersions};
      const publicationId=randomUUID(),versionId=randomUUID(),jobId=randomUUID(),nonce=randomUUID();
      const title=draft.title.trim(),thesis=draft.thesis!.trim(),publishedSlug=slug(title);
      const publicTerms={kind:draft.kind,title,slug:publishedSlug,plan:apiPlan,attachmentIds,evidence:'member_reported',disclosures:typeof obj(draft.plan).conflicts==='string'?obj(draft.plan).conflicts:''};
      const candidate:SnapshotCandidate={
        jobId,publicationId,publicationVersionId:versionId,publishMode:'initial',kind:draft.kind as 'trade'|'education',title,thesis,plan:apiPlan,
        chartState,series:{instrumentId:primaryId,asset:frozenRef.asset as 'stock'|'future',symbol:frozenRef.symbol,venue:String((primaryRef as any).venue),currency:frozenRef.currency,metadataVersion:frozenRef.metadata.version,tickSize:frozenRef.metadata.tickSize,...(frozenRef.metadata.root?{root:frozenRef.metadata.root}:{}),...(frozenRef.metadata.contractMonth?{contractMonth:`${frozenRef.metadata.contractYear}-${String(frozenRef.metadata.contractMonth).padStart(2,'0')}`} :{}),session:chartState.session,adjustment:'unadjusted',provider:barsResult.meta.provider,providerReference:barsResult.meta.providerReference,delaySeconds:barsResult.meta.delaySeconds,demo:barsResult.meta.demo,asOf:barsResult.meta.asOf??disclosures.asOf,capabilities:combineCapabilities(primaryRef.meta.capabilities,publicPrimary.meta.capabilities)},
        bars:barsResult.bars as unknown as Obj[],attachments:attachments.rows.map((a:any)=>({id:a.id,processedKey:a.processed_key,checksum:String(a.checksum),width:Number(obj(a.dimensions).width),height:Number(obj(a.dimensions).height),mime:'image/webp'})),disclosures,referenceVersions,...(canonicalPlan?{domainPlan:canonicalPlan}:{}),
      };
      if(candidate.series.provider!==chartState.provenance.provider||candidate.series.demo!==chartState.provenance.demo)throw makeError(422,'CHART_PROVENANCE_MISMATCH','Saved chart source details do not match the authorized current source.');
      if(draft.kind==='trade')try { const risk=calculatePosition({plan:canonicalPlan!,entryCosts:null,exits:[]}).initialRisk;if(!risk||Number(risk)<=0)throw new Error(); } catch { throw makeError(422,'TRADE_RISK_UNAVAILABLE','The complete plan does not support a safe initial-risk calculation.'); }
      await this.assertCapabilitiesForPublication(tx,[...ids]);
      const quota=await maxDailyPosts(tx,ownerId); if(!quota.rowCount)throw makeError(429,'DAILY_PUBLICATION_LIMIT','You have reached the limit of 10 new publications today.');
      await tx.query("INSERT INTO publication(id,author_user_id,kind,original_version_id,current_version_id,visibility,published_at,created_at) VALUES($1,$2,$3,NULL,NULL,'private',NULL,now())",[publicationId,ownerId,draft.kind]);
      await tx.query('INSERT INTO publication_version(id,publication_id,sequence,previous_version_id,terms,thesis,chart,disclosures,created_at) VALUES($1,$2,1,NULL,$3::jsonb,$4,$5::jsonb,$6::jsonb,now())',[versionId,publicationId,JSON.stringify(publicTerms),thesis,JSON.stringify(chartState),JSON.stringify(disclosures)]);
      await tx.query('INSERT INTO chart_state(id,owner_user_id,draft_id,publication_version_id,schema_version,state,provenance,revision,created_at) VALUES($1,NULL,NULL,$2,$3,$4::jsonb,$5::jsonb,$6,now())',[randomUUID(),versionId,chartState.schemaVersion,JSON.stringify(chartState),JSON.stringify(chartState.provenance),input.chartRevision]);
      const nonceExpiresAt=new Date(Date.now()+120_000).toISOString();
      await tx.query(`INSERT INTO publication_job(id,owner_user_id,draft_id,publication_id,publication_version_id,status,candidate,render_nonce,render_nonce_expires_at,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,'pending',$6::jsonb,$7,$8,now(),now())`,[jobId,ownerId,draftId,publicationId,versionId,JSON.stringify(candidate),nonce,nonceExpiresAt]);
      await tx.query("INSERT INTO outbox_event(id,event_type,aggregate_type,aggregate_id,revision,payload,status,available_at,attempts,created_at) VALUES($1,'publication.snapshot','publication_job',$2,1,$3::jsonb,'pending',now(),0,now())",[randomUUID(),jobId,JSON.stringify({jobId})]);
      const lockPlan={...obj(draft.plan),locked:true};
      await tx.query('UPDATE draft SET plan=$2::jsonb,revision=revision+1,updated_at=now() WHERE id=$1',[draftId,JSON.stringify(lockPlan)]);
      return {status:202,body:{id:jobId,status:'pending',publicationId:null,failureCode:null,createdAt:new Date().toISOString()},resourceId:jobId};
    });
    return this.getPublicationJob(ownerId,idempotent.resourceId!);
  }

  async getPublicationJob(ownerId:string,id:string) {
    if(!UUID.test(id))throw makeError(400,'INVALID_ID','Job id is invalid.');
    const result=await this.pool.query('SELECT id,status,publication_id,failure_code,created_at FROM publication_job WHERE id=$1 AND owner_user_id=$2',[id,ownerId]);
    const row=result.rows[0]; if(!row)throw makeError(404,'PUBLICATION_JOB_NOT_FOUND','Publication job is unavailable.');
    return {id:row.id,status:row.status,publicationId:row.status==='succeeded'?row.publication_id:null,failureCode:row.failure_code??null,createdAt:iso(row.created_at)};
  }

  async loadPublicationRenderJob(id:string) {
    const r=await this.pool.query('SELECT id,publication_version_id,status,render_nonce,render_nonce_expires_at,candidate FROM publication_job WHERE id=$1',[id]);
    if(!r.rows[0])throw makeError(404,'PUBLICATION_JOB_NOT_FOUND','Publication job is unavailable.'); return r.rows[0];
  }

  async claimPublicationRender(id:string,claims:PublicationRenderClaims) {
    return withDbTx(this.pool,async tx=>{
      const r=await tx.query('UPDATE publication_job SET render_claimed_at=now(),updated_at=now() WHERE id=$1 AND publication_version_id=$2 AND render_nonce=$3 AND render_nonce_expires_at=$4 AND status=\'running\' AND render_claimed_at IS NULL AND render_nonce_expires_at>now() RETURNING candidate',[id,claims.publicationVersionId,claims.nonce,claims.expiresAt]);
      if(!r.rows[0])throw makeError(409,'SNAPSHOT_CLAIM_INVALID','This render token is expired, already used, or no longer valid.');
      return {candidate:r.rows[0].candidate};
    });
  }

  async completePublicationSnapshot(id:string,artifact:SnapshotArtifact,claims:PublicationRenderClaims) {
    if(!UUID.test(id)||!UUID.test(artifact.objectKey.split('/')[0]??'')||! /^[0-9a-f]{64}$/.test(artifact.checksum)||artifact.width!==1200||artifact.height!==760||artifact.mime!=='image/webp')throw makeError(422,'INVALID_SNAPSHOT_ARTIFACT','Snapshot artifact metadata is invalid.');
    return withDbTx(this.pool,async tx=>{
      const jobResult=await tx.query('SELECT * FROM publication_job WHERE id=$1 FOR UPDATE',[id]);const job=jobResult.rows[0];
      if(!job)throw makeError(404,'PUBLICATION_JOB_NOT_FOUND','Publication job is unavailable.');
      if(job.status==='succeeded') { if(job.snapshot_checksum===artifact.checksum&&job.snapshot_object_key===artifact.objectKey)return {completed:true}; throw makeError(409,'IMMUTABLE_SNAPSHOT','A different snapshot has already completed this publication.'); }
      if(job.status!=='running'||!job.render_claimed_at||job.publication_version_id!==claims.publicationVersionId||job.render_nonce!==claims.nonce||job.render_nonce_expires_at.toISOString()!==claims.expiresAt||artifact.objectKey!==`${job.publication_version_id}/processed.webp`)throw makeError(409,'SNAPSHOT_COMPLETION_INVALID','Snapshot completion does not match the claimed job.');
      const candidate=job.candidate as SnapshotCandidate;
      const author=await tx.query("SELECT status,email_verified,onboarding_version FROM user_account WHERE id=$1 FOR SHARE",[job.owner_user_id]);
      if(!author.rows[0]||author.rows[0].status!=='active'||author.rows[0].email_verified!==true||!author.rows[0].onboarding_version)throw makeError(403,'PUBLISHER_UNAVAILABLE','The author is no longer eligible to publish this candidate.');
      if(candidate.eventOnlyCorrection)await this.assertPublicDataRights(candidate.chartState.instrumentId,candidate.chartState.metadataVersion,candidate.plan,candidate.disclosures,tx as any);
      else await this.assertCapabilitiesForReferences(tx,candidate.referenceVersions);
      await tx.query(`INSERT INTO media(id,owner_user_id,purpose,resource_id,resource_type,version,quarantine_key,processed_key,dimensions,checksum,status,declared_mime,byte_size,expires_at,failure_code,created_at,updated_at)
        VALUES($1,$2,'chart_snapshot',$3,'publication',1,'',$4,$5::jsonb,$6,'ready','image/webp',NULL,NULL,NULL,now(),now()) ON CONFLICT(id) DO NOTHING`,[job.publication_version_id,job.owner_user_id,job.publication_id,artifact.objectKey,JSON.stringify({width:artifact.width,height:artifact.height}),artifact.checksum]);
      const checkMedia=await tx.query('SELECT checksum,processed_key,status FROM media WHERE id=$1 FOR UPDATE',[job.publication_version_id]);
      if(checkMedia.rows[0]?.checksum!==artifact.checksum||checkMedia.rows[0]?.processed_key!==artifact.objectKey||checkMedia.rows[0]?.status!=='ready')throw makeError(409,'IMMUTABLE_SNAPSHOT','Snapshot storage metadata differs from the frozen artifact.');
      if(candidate.publishMode==='correction') {
        if(!candidate.sourceVersionId||!candidate.correctionRequestId||!this.correctionFinalizer)throw makeError(503,'CORRECTION_FINALIZER_UNAVAILABLE','Correction finalization is unavailable.');
        await this.correctionFinalizer(tx as any,candidate.correctionRequestId,id,job.publication_version_id);
        const advanced=await tx.query("UPDATE publication SET current_version_id=$3 WHERE id=$1 AND author_user_id=$4 AND visibility='public' AND current_version_id=$2",[job.publication_id,candidate.sourceVersionId,job.publication_version_id,job.owner_user_id]);
        if(!advanced.rowCount)throw makeError(409,'CORRECTION_SOURCE_STALE','The publication changed before the corrected version could be committed.');
        const version=await tx.query('SELECT sequence FROM publication_version WHERE id=$1',[job.publication_version_id]);
        await enqueueNotificationEvent(tx,'notification.bookmark_material_update','publication',job.publication_id,Number(version.rows[0]?.sequence??1),{publicationId:job.publication_id,authorUserId:job.owner_user_id,versionId:job.publication_version_id});
      } else {
        const published=await tx.query("UPDATE publication SET visibility='public',published_at=COALESCE(published_at,now()),original_version_id=COALESCE(original_version_id,$2),current_version_id=COALESCE(current_version_id,$2) WHERE id=$1 AND author_user_id=$3 AND visibility='private' RETURNING id",[job.publication_id,job.publication_version_id,job.owner_user_id]);
        if(!published.rowCount)throw makeError(409,'PUBLICATION_FINALIZATION_CONFLICT','The private publication could not be finalized.');
        await enqueueNotificationEvent(tx,'notification.followed_publication','publication',job.publication_id,1,{publicationId:job.publication_id,authorUserId:job.owner_user_id,versionId:job.publication_version_id});
        await recordActivation(tx,job.owner_user_id,'publish');
        await recordProductEvent(tx,job.owner_user_id,'publication',job.publication_id,{...(candidate.plan?.asset?{asset:candidate.plan.asset}:{}),...(candidate.plan?.strategy?{strategy:candidate.plan.strategy}:{})});
        for(const attachment of candidate.attachments) {
          const bound=await tx.query("UPDATE media SET resource_id=$2,resource_type='publication',updated_at=now() WHERE id=$1 AND owner_user_id=$3 AND purpose='publication_attachment' AND resource_id=$4 AND resource_type='draft' AND status='ready' AND processed_key=$5 AND checksum=$6 RETURNING id,dimensions",[attachment.id,job.publication_id,job.owner_user_id,job.draft_id,attachment.processedKey,attachment.checksum]);
          const size=obj(bound.rows[0]?.dimensions);
          if(!bound.rowCount||Number(size.width)!==attachment.width||Number(size.height)!==attachment.height)throw makeError(409,'ATTACHMENT_BINDING_CONFLICT','A frozen publication attachment could not be bound.');
        }
      }
      const terms=await tx.query('SELECT terms FROM publication_version WHERE id=$1',[job.publication_version_id]);
      const termObj=obj(terms.rows[0]?.terms); const ids=Array.isArray(termObj.attachmentIds)?termObj.attachmentIds:[];
      const candidateIds=candidate.attachments.map(item=>item.id);
      if(ids.length!==candidateIds.length||ids.some((value:any)=>!candidateIds.includes(value)))throw makeError(409,'ATTACHMENT_BINDING_CONFLICT','Frozen attachments are no longer available.');
      if(candidate.publishMode==='correction'&&ids.length) {
        const available=await tx.query("SELECT id,processed_key,checksum,dimensions FROM media WHERE id=ANY($1::uuid[]) AND owner_user_id=$2 AND purpose='publication_attachment' AND resource_type='publication' AND resource_id=$3 AND status='ready' AND processed_key IS NOT NULL FOR SHARE",[ids,job.owner_user_id,job.publication_id]);
        if(available.rows.length!==ids.length||candidate.attachments.some(frozen=>{const found=available.rows.find((row:any)=>row.id===frozen.id);const size=obj(found?.dimensions);return !found||found.processed_key!==frozen.processedKey||found.checksum!==frozen.checksum||Number(size.width)!==frozen.width||Number(size.height)!==frozen.height;}))throw makeError(409,'ATTACHMENT_BINDING_CONFLICT','A frozen publication attachment is no longer available.');
      }
      let positionId:string|null=null;
      if(candidate.publishMode!=='correction') {
      const draft=await tx.query('SELECT plan,revision FROM draft WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',[job.draft_id,job.owner_user_id]);
      if(!draft.rows[0]||!obj(draft.rows[0].plan).locked)throw makeError(409,'DRAFT_LOCK_CONFLICT','Draft is no longer locked for this publication.');
      const publishedPlan={...obj(draft.rows[0].plan),published:true,locked:true};
      await tx.query('UPDATE draft SET plan=$2::jsonb,revision=revision+1,updated_at=now() WHERE id=$1',[job.draft_id,JSON.stringify(publishedPlan)]);
      if(candidate.kind==='trade'&&candidate.plan) {
        const plan=hydrateSnapshotPlan(candidate);
        const refs=candidate.referenceVersions;
        const publishedPlan=candidate.plan;
        const legs=plan.legs??[];
        const initialized=await initializePublishedPosition(tx as any,{ownerUserId:job.owner_user_id,publicationId:job.publication_id,sourceVersionId:job.publication_version_id,primaryInstrumentId:publishedPlan.instrumentId,primaryMetadataVersionId:refs[0]!.metadataVersionId,plan,legReferences:refs.slice(1).map((ref,index)=>({instrumentId:ref.instrumentId,metadataVersionId:ref.metadataVersionId,side:legs[index]?.side==='long'?'buy' as const:'sell' as const,quantity:legs[index]?.quantity??publishedPlan.quantity}))});
        positionId=initialized.positionId;
      }
      }
      await tx.query("UPDATE publication_job SET status='succeeded',failure_code=NULL,snapshot_object_key=$2,snapshot_checksum=$3,snapshot_width=$4,snapshot_height=$5,snapshot_mime=$6,updated_at=now() WHERE id=$1",[id,artifact.objectKey,artifact.checksum,artifact.width,artifact.height,artifact.mime]);
      return {completed:true,publicationId:job.publication_id,...(positionId?{positionId}:{})};
    });
  }

  async failPublicationSnapshot(id:string,code:string,retryable:boolean,claims:PublicationRenderClaims) {
    const safeCode=/^[A-Z][A-Z0-9_]{1,99}$/.test(code)?code:'SNAPSHOT_FAILED';
    return withDbTx(this.pool,async tx=>{
      const result=await tx.query('SELECT * FROM publication_job WHERE id=$1 FOR UPDATE',[id]);const job=result.rows[0]; if(!job)throw makeError(404,'PUBLICATION_JOB_NOT_FOUND','Publication job is unavailable.');
      if(job.status==='succeeded')return {status:'succeeded'};
      if(job.status!=='running'||job.publication_version_id!==claims.publicationVersionId||job.render_nonce!==claims.nonce||job.render_nonce_expires_at.toISOString()!==claims.expiresAt)throw makeError(409,'SNAPSHOT_COMPLETION_INVALID','Failure report does not match the active render job.');
      if(retryable&&Number(job.attempts)<3) {
        const retryRevision=Number(job.attempts)+1; const nextNonce=randomUUID();
        await tx.query("UPDATE publication_job SET status='pending',failure_code=NULL,render_nonce=$2,render_nonce_expires_at=now(),render_claimed_at=NULL,updated_at=now() WHERE id=$1",[id,nextNonce]);
        await tx.query("INSERT INTO outbox_event(id,event_type,aggregate_type,aggregate_id,revision,payload,status,available_at,attempts,created_at) VALUES($1,'publication.snapshot','publication_job',$2,$3,$4::jsonb,'pending',now()+interval '15 seconds',0,now()) ON CONFLICT(event_type,aggregate_type,aggregate_id,revision) DO NOTHING",[randomUUID(),id,retryRevision,JSON.stringify({jobId:id})]);
        return {status:'pending'};
      }
      await tx.query("UPDATE publication_job SET status='failed',failure_code=$2,updated_at=now() WHERE id=$1",[id,safeCode]);
      const candidate=job.candidate as SnapshotCandidate;
      if(candidate.publishMode==='correction'&&candidate.correctionRequestId) {
        await tx.query("UPDATE correction_request SET status='requested' WHERE id=$1 AND status='processing' AND publication_job_id=$2",[candidate.correctionRequestId,id]);
      } else {
        const draft=await tx.query('SELECT plan FROM draft WHERE id=$1 AND owner_user_id=$2 FOR UPDATE',[job.draft_id,job.owner_user_id]);
        if(draft.rows[0]) { const plan={...obj(draft.rows[0].plan)}; delete plan.locked; await tx.query('UPDATE draft SET plan=$2::jsonb,revision=revision+1,updated_at=now() WHERE id=$1',[job.draft_id,JSON.stringify(plan)]); }
      }
      return {status:'failed',failureCode:safeCode};
    });
  }

  async getPublication(id:string,versionId?:string):Promise<components['schemas']['Publication']> {
    return this.publicationDto(id,versionId);
  }
  /** Validate a public source inside the caller's write transaction before creating a derivative. */
  async assertPublicInteractionSource(id:string,tx:Pick<CommandTransaction,'query'>):Promise<{authorId:string;currentVersionId:string}> {
    const pub=await this.publicVisibility(id,tx);
    if(typeof pub.current_version_id!=='string')throw makeError(404,'PUBLICATION_NOT_FOUND','Publication is unavailable.');
    await this.assertPublicVersionDataRights(id,pub.current_version_id,tx);
    return {authorId:String(pub.author_user_id),currentVersionId:String(pub.current_version_id)};
  }
  async assertShareImageExport(id:string,versionId:string) {
    const publication=await this.getPublication(id,versionId);
    const reference=await this.instruments.get(publication.chart.instrumentId,publication.chart.metadataVersion,'public');
    if(!reference.meta.capabilities.exportImage)throw makeError(403,'DATA_EXPORT_NOT_LICENSED','The current data license does not permit exporting this chart image.');
  }
  async getShareMetadata(id:string,canonicalOrigin:string):Promise<components['schemas']['ShareMetadata']> {
    const publication=await this.getPublication(id);
    const origin=parseCanonicalOrigin(canonicalOrigin);
    const canonicalUrl=new URL(`/ideas/${encodeURIComponent(publication.id)}/${encodeURIComponent(publication.slug)}`,origin).toString();
    const reference=await this.instruments.get(publication.chart.instrumentId,publication.chart.metadataVersion,'public');
    const imageAllowed=reference.meta.capabilities.exportImage===true;
    return {canonicalUrl,imageUrl:imageAllowed?new URL(`/api/v1/publications/${publication.id}/share/image?versionId=${publication.versionId}&download=true`,origin).toString():null,imageAllowed,versionId:publication.versionId,title:publication.title,author:publication.author};
  }
  async listPublications(input:Record<string,unknown>,viewerUserId?:string):Promise<components['schemas']['PublicationPage']> {
    const limit=Number(input.limit??20);
    if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw makeError(400,'INVALID_LIMIT','Publication page size must be between 1 and 50.');
    const feed=input.feed===undefined?'discover':String(input.feed);
    if(!['discover','following','editorial'].includes(feed))throw makeError(400,'INVALID_FEED','Choose Discover, Following, or Editorial.');
    if(feed==='following'&&!viewerUserId)throw makeError(401,'AUTHENTICATION_REQUIRED','Sign in to read your Following feed.');
    const q=String(input.q??'').trim().replace(/\s+/g,' '); if(q.length>200)throw makeError(400,'INVALID_QUERY','Publication search is limited to 200 characters.');
    const asset=input.asset===undefined?null:String(input.asset),strategy=input.strategy===undefined?null:String(input.strategy);
    const instrumentId=input.instrumentId===undefined?null:String(input.instrumentId),status=input.status===undefined?null:String(input.status),author=input.author===undefined?null:String(input.author).trim().toLowerCase();
    if(input.sort!==undefined&&input.sort!=='newest')throw makeError(400,'INVALID_SORT','Only newest-first sorting is supported.');
    if(asset!==null&&!['stock','option','future'].includes(asset))throw makeError(400,'INVALID_ASSET','Asset filter is invalid.');
    if(strategy!==null&&!['long','short','long_call','long_put','bull_call_debit','bear_put_debit','bull_put_credit','bear_call_credit'].includes(strategy))throw makeError(400,'INVALID_STRATEGY','Strategy filter is invalid.');
    if(status!==null&&!['pending','entered','partially_closed','closed','unresolved','canceled','never_entered'].includes(status))throw makeError(400,'INVALID_STATUS','Publication status filter is invalid.');
    if(instrumentId!==null&&!UUID.test(instrumentId))throw makeError(400,'INVALID_ID','Instrument id is invalid.');
    if(author!==null&&!/^[a-z0-9_]{3,30}$/.test(author))throw makeError(400,'INVALID_HANDLE','Author handle is invalid.');
    const binding=publicationCursorBinding({feed,q,asset,strategy,instrumentId,status,author,viewerUserId:viewerUserId??null,sort:'newest'});
    let scan=input.cursor===undefined?null:decodePublicationCursor(input.cursor,binding);
    const items:components['schemas']['PublicationSummary'][]=[];
    // Reuse identical reference/rights reads only within this request. Every
    // item's current author/version/repost visibility is still rechecked below.
    const sourceReads=new Map<string,Promise<components['schemas']['Instrument']>>();
    const itemCursors:Array<{feedAt:string;id:string;repostId:string}>=[];
    let lastScanned:{feedAt:string;id:string;repostId:string}|null=null,hasMore=false,exhausted=false;
    // Continue through revoked/unlicensed rows without returning them or looping forever.
    for(let page=0;page<8&&items.length<=limit;page++) {
      const rows=await this.pool.query(`WITH base AS NOT MATERIALIZED (
        SELECT p.id,p.author_user_id,p.kind,p.published_at,v.id AS version_id,v.terms,v.terms->>'title' AS title,v.thesis,v.chart,v.disclosures,
          prof.handle,prof.display_name,prof.bio,prof.avatar_media_id,
          COALESCE(pos.state,'pending') AS state,COALESCE((v.terms->'plan'->>'instrumentId')::uuid,(v.chart->>'instrumentId')::uuid) AS source_instrument_id,
          COALESCE(v.terms->'plan'->>'asset',source_instrument.asset) AS source_asset
        FROM publication p JOIN publication_version v ON v.id=p.current_version_id
        JOIN profile prof ON prof.user_id=p.author_user_id AND prof.moderation_hidden_at IS NULL JOIN user_account u ON u.id=p.author_user_id AND u.status='active'
        JOIN instrument source_instrument ON source_instrument.id=COALESCE((v.terms->'plan'->>'instrumentId')::uuid,(v.chart->>'instrumentId')::uuid)
        LEFT JOIN position pos ON pos.public_publication_id=p.id AND pos.owner_user_id=p.author_user_id
        WHERE p.visibility='public' AND p.published_at IS NOT NULL
          AND ($1::text IS NULL OR (to_tsvector('simple',coalesce(v.terms->>'title','')||' '||coalesce(v.thesis,'')) @@ websearch_to_tsquery('simple',$1)
            OR to_tsvector('simple',coalesce(prof.display_name,'')||' '||coalesce(prof.handle,'')) @@ websearch_to_tsquery('simple',$1)))
          AND ($2::text IS NULL OR lower(prof.handle)=$2)
          AND ($3::text IS NULL OR COALESCE(v.terms->'plan'->>'asset',source_instrument.asset)=$3)
          AND ($4::text IS NULL OR v.terms->'plan'->>'strategy'=$4)
          AND ($5::uuid IS NULL OR COALESCE((v.terms->'plan'->>'instrumentId')::uuid,(v.chart->>'instrumentId')::uuid)=$5)
          AND ($6::text IS NULL OR COALESCE(pos.state,'pending')=$6)
      ), feed_items AS (
        (SELECT b.*,NULL::uuid AS repost_id,NULL::text AS repost_commentary,NULL::timestamptz AS repost_created_at,
          NULL::uuid AS reposter_user_id,NULL::text AS reposter_handle,NULL::text AS reposter_display_name,NULL::text AS reposter_bio,NULL::uuid AS reposter_avatar_media_id,b.published_at AS feed_at
        FROM base b WHERE NOT EXISTS(SELECT 1 FROM mute m WHERE m.user_id=$8::uuid AND m.author_id=b.author_user_id)
          AND ($7::text<>'following' OR EXISTS(SELECT 1 FROM follow f WHERE f.follower_user_id=$8::uuid AND (f.target_user_id=b.author_user_id OR f.instrument_id=b.source_instrument_id)))
          AND ($7::text<>'editorial' OR (EXISTS(SELECT 1 FROM editorial_selection es WHERE es.publication_id=b.id AND es.active_from<=now() AND (es.active_until IS NULL OR es.active_until>now()))
            AND b.title IS NOT NULL AND b.thesis IS NOT NULL AND b.chart IS NOT NULL AND b.chart<>'{}'::jsonb AND b.disclosures IS NOT NULL AND b.disclosures<>'{}'::jsonb
            AND (b.kind='education' OR (b.kind='trade' AND b.state IN ('closed','never_entered')
              AND b.terms->'plan' IS NOT NULL AND b.terms->'plan'<>'{}'::jsonb
              AND EXISTS(SELECT 1 FROM position_event pe JOIN position px ON px.id=pe.position_id WHERE px.public_publication_id=b.id AND pe.type IN ('entry','never_entered'))
              AND EXISTS(SELECT 1 FROM position_event pe JOIN position px ON px.id=pe.position_id WHERE px.public_publication_id=b.id AND pe.type IN ('final_exit','never_entered','resolution'))
              AND (b.state<>'closed' OR EXISTS(SELECT 1 FROM position px JOIN LATERAL (SELECT cost_coverage FROM outcome_snapshot os WHERE os.position_id=px.id ORDER BY os.source_event_cutoff DESC,os.created_at DESC LIMIT 1) latest ON true WHERE px.public_publication_id=b.id AND latest.cost_coverage='complete'))))))
          AND ($9::timestamptz IS NULL OR (b.published_at,b.id,'00000000-0000-0000-0000-000000000000'::uuid)<($9::timestamptz,$10::uuid,$11::uuid))
        ORDER BY b.published_at DESC,b.id DESC LIMIT $12)
        UNION ALL
        (SELECT b.*,rp.id,rp.commentary,rp.created_at,rp.user_id,reposter.handle,reposter.display_name,reposter.bio,reposter.avatar_media_id,
          rp.created_at
        FROM base b JOIN repost rp ON rp.publication_id=b.id AND rp.active AND rp.hidden_at IS NULL
        JOIN profile reposter ON reposter.user_id=rp.user_id AND reposter.moderation_hidden_at IS NULL JOIN user_account reposter_account ON reposter_account.id=rp.user_id AND reposter_account.status='active'
        WHERE ($7::text='discover' OR ($7::text='following' AND EXISTS(SELECT 1 FROM follow f WHERE f.follower_user_id=$8::uuid AND (f.target_user_id=rp.user_id OR f.target_user_id=b.author_user_id OR f.instrument_id=b.source_instrument_id))))
          AND NOT EXISTS(SELECT 1 FROM mute m WHERE m.user_id=$8::uuid AND m.author_id IN (b.author_user_id,rp.user_id))
          AND ($9::timestamptz IS NULL OR (rp.created_at,b.id,rp.id)<($9::timestamptz,$10::uuid,$11::uuid))
        ORDER BY rp.created_at DESC,b.id DESC,rp.id DESC LIMIT $12)
      )
      , page_items AS MATERIALIZED (
      SELECT feed_items.*,to_char(feed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS feed_at_cursor FROM feed_items
      WHERE ($9::timestamptz IS NULL OR (feed_at,id,COALESCE(repost_id,'00000000-0000-0000-0000-000000000000'::uuid))<($9::timestamptz,$10::uuid,$11::uuid))
      ORDER BY feed_at DESC,id DESC,COALESCE(repost_id,'00000000-0000-0000-0000-000000000000'::uuid) DESC LIMIT $12)
      SELECT page_items.*,
        EXISTS(SELECT 1 FROM subscription_entitlement e WHERE e.user_id=page_items.author_user_id AND e.plan='pro' AND e.valid_from<=now() AND (e.valid_until IS NULL OR e.valid_until>now()) AND ${billingEntitlementPredicate('e',13)}) AS pro,
        EXISTS(SELECT 1 FROM subscription_entitlement re WHERE re.user_id=page_items.reposter_user_id AND re.plan='pro' AND re.valid_from<=now() AND (re.valid_until IS NULL OR re.valid_until>now()) AND ${billingEntitlementPredicate('re',13)}) AS reposter_pro,
        (SELECT count(*)::int FROM comment c WHERE c.publication_id=page_items.id AND c.deleted_at IS NULL AND c.hidden_at IS NULL) AS comments,
        (SELECT count(*)::int FROM reaction r WHERE r.publication_id=page_items.id) AS reactions,
        (SELECT count(*)::int FROM repost rp JOIN user_account ru ON ru.id=rp.user_id AND ru.status='active' JOIN profile rprof ON rprof.user_id=rp.user_id AND rprof.moderation_hidden_at IS NULL WHERE rp.publication_id=page_items.id AND rp.active AND rp.hidden_at IS NULL) AS reposts,
        EXISTS(SELECT 1 FROM reaction vr WHERE vr.publication_id=page_items.id AND vr.user_id=$8::uuid AND vr.type='helpful') AS viewer_helpful,
        EXISTS(SELECT 1 FROM bookmark vb WHERE vb.publication_id=page_items.id AND vb.user_id=$8::uuid) AS viewer_bookmarked,
        (SELECT vrp.id FROM repost vrp WHERE vrp.publication_id=page_items.id AND vrp.user_id=$8::uuid AND vrp.active AND vrp.hidden_at IS NULL LIMIT 1) AS viewer_repost_id,
        (SELECT vrp.commentary FROM repost vrp WHERE vrp.publication_id=page_items.id AND vrp.user_id=$8::uuid AND vrp.active AND vrp.hidden_at IS NULL LIMIT 1) AS viewer_repost_commentary
      FROM page_items ORDER BY feed_at DESC,id DESC,COALESCE(repost_id,'00000000-0000-0000-0000-000000000000'::uuid) DESC`,[q||null,author,asset,strategy,instrumentId,status,feed,viewerUserId??null,scan?.feedAt??null,scan?.id??null,scan?.repostId??'00000000-0000-0000-0000-000000000000',limit+1,...billingEntitlementScope(process.env)]);
      if(rows.rows.length<limit+1)exhausted=true;
      const candidates:Array<{summary:components['schemas']['PublicationSummary'];tuple:{feedAt:string;id:string;repostId:string};versionId:string;repostId:string|null}>=[];
      for(const row of rows.rows) {
        const tuple={feedAt:String(row.feed_at_cursor),id:String(row.id),repostId:row.repost_id?String(row.repost_id):'00000000-0000-0000-0000-000000000000'};
        lastScanned=tuple;
        const terms=obj(row.terms),chart=obj(row.chart),plan=(terms.plan??null) as components['schemas']['TradePlan']|null;
        let instrument:components['schemas']['Instrument'];
        try {
          const sourceKey=JSON.stringify([chart.instrumentId,chart.metadataVersion,plan,obj(row.disclosures)]);
          let pending=sourceReads.get(sourceKey);
          if(!pending){pending=this.assertPublicDataRights(String(chart.instrumentId),Number(chart.metadataVersion),plan,obj(row.disclosures));sourceReads.set(sourceKey,pending);}
          instrument=await pending;
        }
        catch(error) { if(error instanceof CommandError&&error.status===404)continue; throw error; }
        const summary:components['schemas']['PublicationSummary']={id:row.id,versionId:row.version_id,slug:String(terms.slug??slug(String(terms.title??'idea'))),author:{id:row.author_user_id,handle:row.handle,displayName:row.display_name,bio:String(row.bio??'').slice(0,500),avatarUrl:row.avatar_media_id?`/api/v1/media/${row.avatar_media_id}/content`:null,pro:Boolean(row.pro)},title:String(terms.title??''),excerpt:String(row.thesis??'').slice(0,220),...(plan?.asset?{asset:plan.asset}:{}),...(plan?.strategy?{strategy:plan.strategy}:{}),instrument,state:row.state,thumbnailUrl:`/api/v1/media/${row.version_id}/content`,publishedAt:iso(row.published_at),evidence:'member_reported' as const,comments:Number(row.comments),reactions:Number(row.reactions),reposts:Number(row.reposts),kind:row.kind,
          ...(row.repost_id?{repost:{id:String(row.repost_id),author:{id:String(row.reposter_user_id),handle:String(row.reposter_handle),displayName:String(row.reposter_display_name),bio:String(row.reposter_bio??'').slice(0,500),avatarUrl:row.reposter_avatar_media_id?`/api/v1/media/${row.reposter_avatar_media_id}/content`:null,pro:Boolean(row.reposter_pro)},commentary:String(row.repost_commentary??''),createdAt:iso(row.repost_created_at)}}:{}),
          ...(viewerUserId?{viewer:{helpful:Boolean(row.viewer_helpful),bookmarked:Boolean(row.viewer_bookmarked),reposted:Boolean(row.viewer_repost_id),repostId:row.viewer_repost_id?String(row.viewer_repost_id):null,commentary:row.viewer_repost_commentary===null?null:String(row.viewer_repost_commentary)}}:{})};
        candidates.push({summary,tuple,versionId:String(row.version_id),repostId:row.repost_id?String(row.repost_id):null});
      }
      // Recheck all candidate sources together, after rights hydration and just
      // before returning the page. The query includes every prior per-item guard.
      if(candidates.length){
        const current=await this.pool.query(`WITH candidates AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS c(id uuid,version_id uuid,repost_id uuid)
        ) SELECT c.id,c.version_id,c.repost_id FROM candidates c JOIN publication p ON p.id=c.id
        JOIN user_account author ON author.id=p.author_user_id AND author.status='active'
        JOIN profile author_profile ON author_profile.user_id=p.author_user_id AND author_profile.moderation_hidden_at IS NULL
        WHERE p.visibility='public' AND p.published_at IS NOT NULL AND p.current_version_id=c.version_id
          AND (c.repost_id IS NULL OR EXISTS(SELECT 1 FROM repost rp JOIN user_account reposter ON reposter.id=rp.user_id AND reposter.status='active'
            JOIN profile reposter_profile ON reposter_profile.user_id=rp.user_id AND reposter_profile.moderation_hidden_at IS NULL
            WHERE rp.id=c.repost_id AND rp.publication_id=p.id AND rp.active AND rp.hidden_at IS NULL))
          AND NOT EXISTS(SELECT 1 FROM mute m WHERE m.user_id=$2::uuid AND m.author_id=p.author_user_id)
          AND (c.repost_id IS NULL OR NOT EXISTS(SELECT 1 FROM mute m JOIN repost rp ON rp.id=c.repost_id WHERE m.user_id=$2::uuid AND m.author_id=rp.user_id))`,
          [JSON.stringify(candidates.map(item=>({id:item.summary.id,version_id:item.versionId,repost_id:item.repostId}))),viewerUserId??null]);
        const visibleKeys=new Set(current.rows.map(row=>`${row.id}:${row.version_id}:${row.repost_id??''}`));
        for(const candidate of candidates){
          if(!visibleKeys.has(`${candidate.summary.id}:${candidate.versionId}:${candidate.repostId??''}`))continue;
          items.push(candidate.summary);itemCursors.push(candidate.tuple);
          if(items.length>limit){hasMore=true;break;}
        }
      }
      if(hasMore||exhausted||rows.rows.length===0)break;
      scan=lastScanned;
    }
    const visible=items.slice(0,limit);
    const nextTuple=items.length>limit?itemCursors[limit-1]:(exhausted?null:lastScanned);
    const nextCursor=nextTuple?encodePublicationCursor({...nextTuple,binding}):null;
    return {items:visible,nextCursor};
  }
  async getRevisions(id:string,cursorInput:unknown,limitInput:unknown):Promise<components['schemas']['RevisionPage']> {
    const limit=Number(limitInput??20); if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw makeError(400,'INVALID_LIMIT','Revision limit must be between 1 and 50.');
    const pub=await this.publicVisibility(id); const cursor=typeof cursorInput==='string'&&cursorInput?decodeRevisionCursor(cursorInput):null;
    const rows=await this.pool.query(`WITH RECURSIVE visible_versions AS (
        SELECT v.id,v.publication_id,v.sequence,v.previous_version_id,v.created_at,v.disclosures
        FROM publication p JOIN publication_version v ON v.id=p.current_version_id
        JOIN user_account u ON u.id=p.author_user_id AND u.status='active'
        WHERE p.id=$1 AND p.visibility='public' AND p.published_at IS NOT NULL
        UNION ALL
        SELECT previous.id,previous.publication_id,previous.sequence,previous.previous_version_id,previous.created_at,previous.disclosures
        FROM publication_version previous JOIN visible_versions child ON child.previous_version_id=previous.id
      )
      SELECT id,publication_id,sequence,previous_version_id,created_at,disclosures FROM visible_versions
      WHERE ($2::int IS NULL OR sequence<$2) ORDER BY sequence DESC LIMIT $3`,[pub.id,cursor?.sequence??null,limit+1]);
    const slice=rows.rows.slice(0,limit),hasMore=rows.rows.length>limit;
    return {items:slice.map((row:any)=>({id:row.id,publicationId:row.publication_id,createdAt:iso(row.created_at),reason:String(obj(row.disclosures).correctionReason??'Original publication'),previousVersionId:row.previous_version_id??null,versionId:row.id})),nextCursor:hasMore&&slice.length?Buffer.from(JSON.stringify({sequence:slice.at(-1)!.sequence})).toString('base64url'):null};
  }

  async loadCandidateByToken(token:string,secret:string,expectedJobId:string) {
    let claims:PublicationRenderClaims; try{claims=verifyPublicationRenderToken(secret,token);}catch{throw makeError(401,'INVALID_RENDER_TOKEN','Render authorization is invalid or expired.');}
    if(claims.jobId!==expectedJobId)throw makeError(401,'INVALID_RENDER_TOKEN','Render authorization is invalid or expired.');
    const result=await this.claimPublicationRender(claims.jobId,claims);
    return result;
  }
  async completeByToken(token:string,secret:string,expectedJobId:string,artifact:SnapshotArtifact) {
    let claims:PublicationRenderClaims; try{claims=verifyPublicationRenderToken(secret,token);}catch{throw makeError(401,'INVALID_RENDER_TOKEN','Render authorization is invalid or expired.');}
    if(claims.jobId!==expectedJobId)throw makeError(401,'INVALID_RENDER_TOKEN','Render authorization is invalid or expired.');
    return this.completePublicationSnapshot(claims.jobId,artifact,claims);
  }
  async failByToken(token:string,secret:string,expectedJobId:string,input:{failureCode:string;retryable:boolean}) {
    let claims:PublicationRenderClaims; try{claims=verifyPublicationRenderToken(secret,token);}catch{throw makeError(401,'INVALID_RENDER_TOKEN','Render authorization is invalid or expired.');}
    if(claims.jobId!==expectedJobId)throw makeError(401,'INVALID_RENDER_TOKEN','Render authorization is invalid or expired.');
    return this.failPublicationSnapshot(claims.jobId,input.failureCode,input.retryable,claims);
  }

  async canServeSnapshot(publicationId:string,versionId:string):Promise<boolean> {
    try {
      await this.assertPublicVersionDataRights(publicationId,versionId);
      return true;
    } catch { return false; }
  }

  /** Return the frozen chart instrument only after all public reference rights pass. */
  async getPublicSummaryInstrument(instrumentId:string,metadataVersion:number,plan:components['schemas']['TradePlan']|null,disclosures:Obj={}):Promise<components['schemas']['Instrument']> {
    return this.assertPublicDataRights(instrumentId,metadataVersion,plan,disclosures);
  }

  /** Guard shared by public position/performance projections and media reads. */
  async assertPublicVersionDataRights(publicationId:string,versionId:string,queryable:Queryable=this.pool):Promise<void> {
    const pub=await this.publicVisibility(publicationId,queryable);
    await this.assertCommittedVersion(pub,versionId,queryable);
    const version=await queryable.query('SELECT terms,disclosures FROM publication_version WHERE id=$1 AND publication_id=$2',[versionId,publicationId]);
    const chart=await queryable.query('SELECT state FROM chart_state WHERE publication_version_id=$1',[versionId]);
    if(!version.rows[0]||!chart.rows[0])throw makeError(404,'PUBLICATION_NOT_FOUND','Publication is unavailable.');
    const plan=(obj(version.rows[0].terms).plan??null) as components['schemas']['TradePlan']|null;
    await this.assertPublicDataRights((chart.rows[0].state as any).instrumentId,(chart.rows[0].state as any).metadataVersion,plan,obj(version.rows[0].disclosures),queryable);
  }

  private async publicVisibility(id:string,queryable:Queryable=this.pool) {
    if(!UUID.test(id))throw makeError(400,'INVALID_ID','Publication id is invalid.');
    const r=await queryable.query("SELECT p.id,p.author_user_id,p.kind,p.current_version_id,p.original_version_id,p.published_at,p.visibility FROM publication p JOIN user_account u ON u.id=p.author_user_id AND u.status='active' JOIN profile pr ON pr.user_id=p.author_user_id AND pr.moderation_hidden_at IS NULL WHERE p.id=$1 AND p.visibility='public' AND p.published_at IS NOT NULL",[id]);
    if(!r.rows[0])throw makeError(404,'PUBLICATION_NOT_FOUND','Publication is unavailable.');return r.rows[0];
  }
  private async assertCommittedVersion(pub:Obj,versionId:string,queryable:Queryable=this.pool) {
    const visible=await queryable.query(`WITH RECURSIVE version_chain AS (
        SELECT v.id,v.previous_version_id FROM publication p JOIN publication_version v ON v.id=p.current_version_id
        WHERE p.id=$1 AND p.visibility='public' AND p.published_at IS NOT NULL
        UNION ALL
        SELECT previous.id,previous.previous_version_id FROM publication_version previous
        JOIN version_chain child ON child.previous_version_id=previous.id
      ) SELECT 1 FROM version_chain WHERE id=$2`,[pub.id,versionId]);
    if(!visible.rowCount)throw makeError(404,'PUBLICATION_VERSION_NOT_FOUND','Publication version is unavailable.');
  }
  private async publicationDto(id:string,versionId?:string) {
    const pub=await this.publicVisibility(id);
    const idToRead=versionId??pub.current_version_id;
    if(typeof idToRead!=='string')throw makeError(404,'PUBLICATION_VERSION_NOT_FOUND','Publication version is unavailable.');
    await this.assertCommittedVersion(pub,idToRead);
    const v=await this.pool.query('SELECT id,publication_id,sequence,previous_version_id,terms,thesis,chart,disclosures,created_at FROM publication_version WHERE id=$1 AND publication_id=$2',[idToRead,pub.id]);
    if(!v.rows[0])throw makeError(404,'PUBLICATION_VERSION_NOT_FOUND','Publication version is unavailable.');
    const row=v.rows[0],terms=obj(row.terms),plan=(terms.plan??null) as components['schemas']['TradePlan']|null;
    const chart=await this.pool.query('SELECT state FROM chart_state WHERE publication_version_id=$1',[row.id]);if(!chart.rows[0])throw makeError(404,'PUBLICATION_NOT_FOUND','Publication is unavailable.');
    const state=chart.rows[0].state as any;
    await this.assertPublicDataRights(state.instrumentId,state.metadataVersion,plan,obj(row.disclosures));
    const profile=await this.pool.query(`SELECT p.handle,p.display_name,p.bio,p.avatar_media_id,EXISTS(SELECT 1 FROM subscription_entitlement e WHERE e.user_id=p.user_id AND e.plan='pro' AND e.valid_from<=now() AND (e.valid_until IS NULL OR e.valid_until>now()) AND ${billingEntitlementPredicate('e',2)}) AS pro FROM profile p JOIN user_account u ON u.id=p.user_id WHERE p.user_id=$1 AND u.status='active' AND p.moderation_hidden_at IS NULL`,[pub.author_user_id,...billingEntitlementScope(process.env)]);
    if(!profile.rows[0])throw makeError(404,'PUBLICATION_NOT_FOUND','Publication is unavailable.');
    const position=await this.pool.query(`SELECT p.id,p.state,o.cost_coverage FROM position p LEFT JOIN LATERAL (SELECT cost_coverage FROM outcome_snapshot WHERE position_id=p.id ORDER BY source_event_cutoff DESC,created_at DESC LIMIT 1) o ON true WHERE p.public_publication_id=$1 AND p.owner_user_id=$2`,[pub.id,pub.author_user_id]);
    const lifecycle=position.rows[0]?await this.pool.query("SELECT type FROM position_event WHERE position_id=$1 ORDER BY received_at,id",[position.rows[0].id]):{rows:[]};
    const attachmentIds=Array.isArray(terms.attachmentIds)?terms.attachmentIds:[];
    const referenceVersions=Array.isArray(obj(row.disclosures).referenceVersions)?obj(row.disclosures).referenceVersions.filter((item:unknown)=>{
      const reference=obj(item);return UUID.test(String(reference.instrumentId??''))&&Number.isSafeInteger(reference.metadataVersion)&&Number(reference.metadataVersion)>0;
    }).map((item:unknown)=>({instrumentId:String(obj(item).instrumentId),metadataVersion:Number(obj(item).metadataVersion)})):[];
    const eventTypes=new Set(lifecycle.rows.map((event:any)=>event.type));
    const editorialEligibility=evaluateEditorialEligibility({kind:pub.kind,title:terms.title,thesis:row.thesis,plan,chart:state,disclosures:row.disclosures,positionState:position.rows[0]?.state??null,hasEntry:eventTypes.has('entry'),hasFollowUp:eventTypes.has('final_exit')||eventTypes.has('never_entered')||eventTypes.has('resolution'),costCoverage:position.rows[0]?.cost_coverage??null});
    return {id:pub.id,versionId:row.id,slug:String(terms.slug??'idea'),kind:pub.kind,author:{id:pub.author_user_id,handle:profile.rows[0].handle,displayName:profile.rows[0].display_name,bio:String(profile.rows[0].bio??'').slice(0,500),avatarUrl:profile.rows[0].avatar_media_id?`/api/v1/media/${profile.rows[0].avatar_media_id}/content`:null,pro:Boolean(profile.rows[0].pro)},title:String(terms.title??''),thesis:String(row.thesis??''),plan,publishedAt:iso(pub.published_at),state:position.rows[0]?.state??'pending',evidence:'member_reported' as const,thumbnailUrl:`/api/v1/media/${row.id}/content`,chart:state,attachmentIds,positionId:position.rows[0]?.id??null,originalVersionId:pub.original_version_id,versionSequence:Number(row.sequence),versionCreatedAt:iso(row.created_at),correctionReason:obj(row.disclosures).correctionReason??null,disclosures:typeof terms.disclosures==='string'?terms.disclosures:typeof plan?.conflicts==='string'?plan.conflicts:'',editorialEligibility,...(referenceVersions.length?{referenceVersions}:{})};
  }
  private async assertPublicDataRights(instrumentId:string,metadataVersion:number,plan:components['schemas']['TradePlan']|null,disclosures:Obj={},queryable:Queryable=this.pool):Promise<components['schemas']['Instrument']> {
    const ids=[instrumentId,...(plan?.legs??[]).map(leg=>leg.instrumentId)];
    const versions=new Map<string,number>(); for(const item of disclosures.referenceVersions??[])if(item&&typeof item.instrumentId==='string'&&Number.isInteger(item.metadataVersion))versions.set(item.instrumentId,item.metadataVersion);
    let chartInstrument:components['schemas']['Instrument']|undefined;
    for(let i=0;i<ids.length;i++) {
      try { const id=ids[i]!;const result=await this.instruments.get(id,i===0?metadataVersion:(versions.get(id)??undefined),'public',queryable as any) as components['schemas']['Instrument']; if(i===0)chartInstrument=result; const caps=result.meta.capabilities;
        if(!caps.displayPublic||!caps.retainSnapshot)throw makeError(404,'PUBLICATION_NOT_FOUND','Publication is unavailable.');
      } catch(error) { if(error instanceof CommandError)throw makeError(404,'PUBLICATION_NOT_FOUND','Publication is unavailable.'); throw error; }
    }
    if(!chartInstrument)throw makeError(404,'PUBLICATION_NOT_FOUND','Publication is unavailable.');
    return chartInstrument;
  }
  private async assertCapabilitiesForPublication(tx:CommandTransaction,ids:string[]) {
    const unique=[...new Set(ids)]; for(const id of unique) {
      const row=await this.instruments.get(id,undefined,'member',tx as any);
      requirePublishingCaps(row.meta.capabilities,'instrument');
    }
  }
  private async assertCapabilitiesForReferences(tx:Queryable,references:SnapshotCandidate['referenceVersions']) {
    if(!references.length)throw makeError(422,'REFERENCE_VERSIONS_REQUIRED','Frozen instrument references are unavailable.');
    for(let index=0;index<references.length;index++) {
      const reference=references[index]!;
      const current=await this.instruments.get(reference.instrumentId,undefined,'member',tx as any);
      if(current.meta.metadataVersion!==reference.metadataVersion||!current.enabled)throw makeError(409,'REFERENCE_CHANGED_DURING_RENDER','Instrument metadata changed before the publication could be finalized.');
      requirePublishingCaps(current.meta.capabilities,index===0?'underlying':'option contract');
      const publicCurrent=await this.instruments.get(reference.instrumentId,reference.metadataVersion,'public',tx as any);
      if(index===0)requirePublicSnapshotCaps(publicCurrent.meta.capabilities);
      else requirePublicDisplayCaps(publicCurrent.meta.capabilities,'option contract');
    }
  }
}

function requirePublishingCaps(caps:Obj,what:string) {
  if(!caps.displayMember||!caps.retainSnapshot||!caps.newPublishing)throw makeError(403,'DATA_NOT_LICENSED_FOR_PUBLISHING',`Current data rights do not permit publishing this ${what}.`);
  if(what==='underlying'||what==='chart')if(!caps.retainBars)throw makeError(403,'DATA_NOT_LICENSED_FOR_PUBLISHING','Current data rights do not permit retaining chart history.');
}
function requirePublicDisplayCaps(caps:Obj,what:string) {
  if(!caps.displayPublic)throw makeError(403,'DATA_NOT_LICENSED_FOR_PUBLISHING',`Current data rights do not permit public display of this ${what}.`);
}
function requirePublicSnapshotCaps(caps:Obj) {
  requirePublicDisplayCaps(caps,'chart');
  if(!caps.retainBars||!caps.retainSnapshot)throw makeError(403,'DATA_NOT_LICENSED_FOR_PUBLISHING','Current data rights do not permit retaining the public chart and its history.');
}
function combineCapabilities(member:Obj,publicAudience:Obj):Obj {
  return {displayPublic:Boolean(publicAudience.displayPublic),displayMember:Boolean(member.displayMember),retainBars:Boolean(member.retainBars&&publicAudience.retainBars),retainSnapshot:Boolean(member.retainSnapshot&&publicAudience.retainSnapshot),exportImage:Boolean(publicAudience.exportImage),exportPersonalRecord:Boolean(member.exportPersonalRecord),newPublishing:Boolean(member.newPublishing)};
}
function assertChartReference(state:any,ref:ReferenceInstrument,providerReference:string) {
  if(state.instrumentId!==ref.id||state.metadataVersion!==ref.metadata.version||!ref.enabled||ref.asset==='option'||state.adjustment!=='unadjusted'||state.session!==(ref.asset==='future'?'exchange':'regular'))throw makeError(422,'CHART_REFERENCE_MISMATCH','The saved chart series is no longer a supported current instrument.');
  if(typeof state.provenance?.provider!=='string'||typeof state.provenance?.demo!=='boolean'||typeof providerReference!=='string'||providerReference.length<1)throw makeError(422,'CHART_PROVENANCE_MISMATCH','Saved chart provenance or current market source metadata is invalid.');
}
async function loadReferences(tx:Pick<CommandTransaction,'query'>,ids:string[]):Promise<Map<string,ReferenceInstrument>> {
  if(!ids.length)return new Map();
  const result=await tx.query(`SELECT i.id,i.asset,i.vendor_id,i.currency,i.enabled,i.underlying_id,m.id AS metadata_id,m.version,m.multiplier,m.tick_size,m.strike,m.expiry,m.root,m.contract_month,m.contract_year,m.option_type,m.adjusted
    FROM instrument i JOIN instrument_metadata_version m ON m.instrument_id=i.id AND m.version=(SELECT max(mx.version) FROM instrument_metadata_version mx WHERE mx.instrument_id=i.id)
    WHERE i.id=ANY($1::uuid[]) FOR SHARE OF i,m`,[ids]);
  return new Map(result.rows.map((row:any)=>[row.id,quoteCandidate(row)]));
}
async function withDbTx<T>(pool:Pool,work:(tx:any)=>Promise<T>):Promise<T> {
  const client=await pool.connect();try{await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='5s'");await client.query("SET LOCAL statement_timeout='10s'");const value=await work(client);await client.query('COMMIT');return value;}catch(error){await client.query('ROLLBACK').catch(()=>undefined);if(error instanceof CommandError)throw error;const code=(error as any)?.code;if(['23503','23514','22003'].includes(code))throw makeError(422,'INVALID_PUBLICATION','Publication data is invalid.');if(['40001','40P01','55P03'].includes(code))throw makeError(409,'REVISION_CONFLICT','Publication changed concurrently. Retry.');if(typeof code==='string'&&code.startsWith('08'))throw makeError(503,'PERSISTENCE_UNAVAILABLE','Publication storage is temporarily unavailable.');throw makeError(503,'PUBLICATION_UNAVAILABLE','Publication could not be saved. Retry.');}finally{client.release();}}
function decodeRevisionCursor(input:string) {try{const v=JSON.parse(Buffer.from(input,'base64url').toString());if(Number.isSafeInteger(v.sequence)&&v.sequence>0)return v;throw new Error();}catch{throw makeError(400,'INVALID_CURSOR','Revision cursor is invalid.');}}
type PublicationCursor={feedAt:string;id:string;repostId:string;binding:string};
function publicationCursorBinding(filters:Obj):string{return createHash('sha256').update(JSON.stringify(filters)).digest('hex');}
function encodePublicationCursor(value:PublicationCursor):string{return Buffer.from(JSON.stringify({t:value.feedAt,p:value.id,r:value.repostId,f:value.binding})).toString('base64url');}
function decodePublicationCursor(input:unknown,binding:string):Omit<PublicationCursor,'binding'> {
  try {
    if(typeof input!=='string'||input.length>500)throw new Error();
    const value=JSON.parse(Buffer.from(input,'base64url').toString()) as Obj;
    const timestamp=typeof value.t==='string'?/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3}|\d{6})Z$/.exec(value.t):null;
    if(!timestamp||!Number.isFinite(Date.parse(`${timestamp[1]}.${timestamp[2]!.slice(0,3)}Z`))||new Date(`${timestamp[1]}.${timestamp[2]!.slice(0,3)}Z`).toISOString()!==`${timestamp[1]}.${timestamp[2]!.slice(0,3)}Z`||!UUID.test(String(value.p))
      ||!/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(String(value.r))||value.f!==binding)throw new Error();
    return {feedAt:value.t,id:value.p,repostId:value.r};
  } catch { throw makeError(400,'INVALID_CURSOR','Publication cursor is invalid or belongs to different filters.'); }
}
function parseCanonicalOrigin(value:string):URL {
  try {
    const parsed=new URL(value);
    if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash)throw new Error();
    return parsed;
  } catch { throw makeError(503,'CANONICAL_ORIGIN_UNAVAILABLE','Public share links are temporarily unavailable.'); }
}
function hydrateSnapshotPlan(candidate:SnapshotCandidate):TradePlan {
  if(!candidate.domainPlan)throw makeError(422,'INVALID_FROZEN_PLAN','Frozen trade plan is unavailable.');
  return candidate.domainPlan;
}
