import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  calculatePosition, decimal, entryEligibility, formatDecimal, formatRatio,
  stateAtTime, transitionPosition,
  type CalculationResult, type PositionEvent as DomainEvent, type PositionState, type TradePlan,
} from '@trading/domain';
import { CommandError } from '../http/problem.js';
import { executeIdempotentCommand, type Json, type Transaction } from '../persistence/transactions.js';

type EventDetails = { resolution?: string; netResult?: string; borrowCosts?: string | null; exclusions?: string[]; retrospective?: boolean };
type EventRow = { id: string; type: string; claimed_at: Date; received_at: Date; quantity: number | null; price: string | null; costs: string | null; reason: string | null; supersedes_id: string | null; details: EventDetails };
type PositionRow = { id: string; owner_user_id: string; owner_status:string|null; public_publication_id: string | null; private_journal_entry_id: string | null; state: PositionState; plan: TradePlan; api_plan: unknown|null; instrument_id: string; metadata_version_id: string; remaining_quantity: number; initial_risk: string | null; calculation_version: string; revision: number; risk_source_version_id:string|null; published_at: Date | null; created_at:Date; current_version_id?: string|null; visibility: string | null; author_profile_hidden_at?: Date|null; deleted_at?: Date | null };
type OutcomeSnapshotRow={publication_version_id:string|null;source_event_cutoff:Date;net:string|null;r_multiple:string|null;cost_coverage:string;eligibility:string;exclusions:string[]};
type EventInput = { type: string; claimedAt: string; quantity?: number; price?: string; costs?: string | null; reason?: string; resolution?: string; netResult?: string; borrowCosts?: string | null };
type EventProjection = EventRow & { retrospective: boolean };
export type PublicPositionReadGuard = (publicationId:string,versionId:string,queryable:Transaction)=>Promise<void>;

const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const decimalPattern = /^-?[0-9]{1,18}(?:\.[0-9]{1,10})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxRevision = 2_147_483_646;
export function meanExactRatios(results:CalculationResult[]):string|null {
  const gcd=(left:bigint,right:bigint)=>{let a=left<0n?-left:left,b=right<0n?-right:right;while(b!==0n){const next=a%b;a=b;b=next;}return a||1n;};
  let numerator=0n,denominator=1n,count=0;
  for(const result of results){
    if(!result.rRatio)continue;
    const n=BigInt(result.rRatio.numerator),d=BigInt(result.rRatio.denominator);
    if(d<=0n)continue;
    const common=gcd(denominator,d);
    numerator=numerator*(d/common)+n*(denominator/common);
    denominator=denominator*(d/common);
    const reduce=gcd(numerator,denominator);
    numerator/=reduce;denominator/=reduce;count++;
  }
  return count?formatRatio(numerator,denominator*BigInt(count)):null;
}

function cursorTimestamp(value:Date|string):string {
  if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value))return value;
  return iso(value).replace(/\.(\d{3})Z$/,'.$1000Z');
}
function decodeCursor(value: unknown,positionId:string): { receivedAt: string; id: string } | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 500) throw new CommandError(400, 'INVALID_CURSOR');
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { v?: number; receivedAt?: string; id?: string; positionId?:string };
    if (decoded.v !== 1 || decoded.positionId!==positionId || typeof decoded.receivedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(decoded.receivedAt) || !Number.isFinite(Date.parse(decoded.receivedAt)) || !decoded.id || !UUID.test(decoded.id)) throw new Error();
    return { receivedAt: decoded.receivedAt, id: decoded.id };
  } catch { throw new CommandError(400, 'INVALID_CURSOR'); }
}

function cursorFor(row: EventRow,positionId:string) { return Buffer.from(JSON.stringify({ v: 1, receivedAt: cursorTimestamp(row.received_at), id: row.id,positionId })).toString('base64url'); }
function positiveRevision(revision: number) {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision >= maxRevision) throw new CommandError(409, 'REVISION_EXHAUSTED');
  return revision + 1;
}
function eventInputJson(event: EventInput): Json { return JSON.parse(JSON.stringify(event)) as Json; }

function eventDomain(row: EventRow): DomainEvent {
  return {
    type: row.type as DomainEvent['type'], claimedAt: iso(row.claimed_at), receivedAt: iso(row.received_at),
    ...(row.quantity === null ? {} : { quantity: row.quantity }), ...(row.price === null ? {} : { price: row.price }),
    ...(row.costs === null ? { costs: null } : { costs: { amount: row.costs } }), ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.details.resolution ? { resolution: row.details.resolution as DomainEvent['resolution'] } : {}),
    ...(row.details.netResult === undefined ? {} : { netResult: row.details.netResult }),
    ...(row.details.borrowCosts === undefined ? {} : { borrowCosts: row.details.borrowCosts }),
  } as DomainEvent;
}

function serializeEvent(row: EventProjection) {
  return {
    id: row.id, type: row.type, claimedAt: iso(row.claimed_at), receivedAt: iso(row.received_at),
    ...(row.quantity === null ? {} : { quantity: Number(row.quantity) }), ...(row.price === null ? {} : { price: row.price }),
    ...(row.costs === null ? { costs: null } : { costs: row.costs }), ...(row.reason === null ? {} : { reason: row.reason }),
    retrospective: row.retrospective, supersedesId: row.supersedes_id,
    ...(row.details.resolution ? { resolution: row.details.resolution } : {}),
    ...(row.details.netResult ? { netResult: row.details.netResult } : {}),
    ...(row.details.borrowCosts !== undefined ? { borrowCosts: row.details.borrowCosts } : {}),
  };
}

function isRetrospectiveEntry(position:PositionRow,event:EventRow):boolean {
  if(event.type!=='entry')return false;
  const origin=position.published_at??position.created_at;
  const eligibility=entryEligibility(iso(origin),iso(event.claimed_at),iso(event.received_at),position.plan.entryFrom??'',position.plan.entryUntil??'');
  return !eligibility.eligible;
}

async function loadPosition(tx: Transaction, id: string, ownerId?: string, lock = false) {
  if (!UUID.test(id)) throw new CommandError(400, 'INVALID_ID');
  const result = await tx.query<PositionRow>(`SELECT p.*,COALESCE(pv.terms->'plan',p.plan->'privateApiPlan') AS api_plan,pub.visibility,pub.published_at,pub.current_version_id,author.status AS owner_status,author_profile.moderation_hidden_at AS author_profile_hidden_at
    FROM position p LEFT JOIN publication pub ON pub.id=p.public_publication_id AND pub.author_user_id=p.owner_user_id
    LEFT JOIN user_account author ON author.id=p.owner_user_id
    LEFT JOIN profile author_profile ON author_profile.user_id=p.owner_user_id
    LEFT JOIN publication_version pv ON pv.id=p.risk_source_version_id AND pv.publication_id=p.public_publication_id
    LEFT JOIN journal_entry j ON j.id=p.private_journal_entry_id
    WHERE p.id=$1 AND ((p.public_publication_id IS NOT NULL AND pub.visibility='public' AND pub.published_at IS NOT NULL AND author.status='active' AND author_profile.moderation_hidden_at IS NULL)
      OR (p.owner_user_id=$2 AND (p.public_publication_id IS NOT NULL OR (j.owner_user_id=$2 AND j.deleted_at IS NULL))))${lock ? ' FOR UPDATE OF p' : ''}`,
  [id, ownerId ?? null]);
  // A row without a visible public publication is only returned to its owner.
  const row = result.rows[0];
  if (!row || (row.visibility !== 'public' && row.owner_user_id !== ownerId)) throw new CommandError(404, 'POSITION_NOT_FOUND');
  return row;
}

async function loadEvents(tx: Transaction, positionId: string, lock = false): Promise<EventRow[]> {
  const result = await tx.query<EventRow>(`SELECT id,type,claimed_at,received_at,quantity,price::text,costs::text,reason,supersedes_id,details
    FROM position_event WHERE position_id=$1 ORDER BY received_at ASC,id ASC${lock ? ' FOR UPDATE' : ''}`, [positionId]);
  return result.rows;
}

async function loadEventPage(tx:Transaction,positionId:string,after:{receivedAt:string;id:string}|undefined,limit:number):Promise<EventRow[]> {
  const result=await tx.query<EventRow>(`SELECT id,type,claimed_at,received_at,quantity,price::text,costs::text,reason,supersedes_id,details
    FROM position_event WHERE position_id=$1
      AND ($2::timestamptz IS NULL OR received_at>$2::timestamptz OR (received_at=$2::timestamptz AND id>$3::uuid))
    ORDER BY received_at ASC,id ASC LIMIT $4`,[positionId,after?.receivedAt??null,after?.id??null,limit]);
  return result.rows;
}

function activeEvents(events: EventRow[]) {
  const superseded = new Set(events.map(event => event.supersedes_id).filter((id): id is string => Boolean(id)));
  return events.filter(event => !superseded.has(event.id));
}

function computeOutcome(position: PositionRow, allEvents: EventRow[]) {
  const events = activeEvents(allEvents);
  const entry = events.find(event => event.type === 'entry');
  const exits = events.filter(event => event.type === 'partial_exit' || event.type === 'final_exit');
  const resolution = events.find(event => event.type === 'resolution' && event.details.netResult !== undefined);
  const plan = position.plan;
  const reasons: string[] = [];
  let eligibility: 'eligible' | 'retrospective' | 'excluded' = 'excluded';
  if (entry) {
    const origin=position.published_at??position.created_at;
    const eligibilityResult = entryEligibility(iso(origin), iso(entry.claimed_at), iso(entry.received_at), plan.entryFrom ?? '', plan.entryUntil ?? '');
    eligibility = eligibilityResult.eligible ? 'eligible' : 'retrospective';
    reasons.push(...eligibilityResult.reasons);
    if(!position.public_publication_id)reasons.push('private_position');
  } else if (!position.public_publication_id) reasons.push('private_position');
  else if (!entry) reasons.push('entry_not_reported');

  let calculation: CalculationResult;
  try {
    const entryCosts = entry && entry.costs !== null ? { amount: entry.costs } : null;
    const borrow = entry?.details.borrowCosts;
    calculation = calculatePosition({
      plan, entryCosts,
      ...(entry?.price === null || entry?.price === undefined ? {} : { actualEntryPrice: entry.price }),
      ...(borrow === undefined ? {} : { borrowCosts: borrow === null ? null : { amount: borrow } }),
      exits: exits.map(event => ({ quantity: Number(event.quantity), price: event.price!, costs: event.costs === null ? null : { amount: event.costs } })),
      ...(position.initial_risk ? { frozenInitialRisk: { amount: position.initial_risk, calculationVersion: '1', metadataVersion: plan.instrument?.metadataVersion ?? 1, entryTermsVersion: plan.termsVersion ?? 1 } } : {}),
    });
  } catch {
    throw new CommandError(503, 'POSITION_CALCULATION_UNAVAILABLE');
  }
  // An open or unresolved position with no reported exit has no realized cash
  // result yet; the calculator's zero is a mathematical empty sum, not a fill.
  let net = exits.length === 0 ? null : calculation.netRealized;
  let costCoverage: 'complete' | 'incomplete' = calculation.costComplete ? 'complete' : 'incomplete';
  if (resolution) {
    const resolvedAmount = resolution.details.netResult!;
    // A standalone resolution is already a net amount for every remaining
    // unit. Prior exits can be combined only when their own costs are complete.
    net = calculation.netRealized === null
      ? (exits.length === 0 ? formatDecimal(decimal(resolvedAmount)) : null)
      : formatDecimal(decimal(calculation.netRealized) + decimal(resolvedAmount));
    // `netResult` is the member-reported net result for remaining units including
    // their attributable costs; it is added once and never fee-subtracted again.
    // resolution.netResult already includes attributable costs for the remaining
    // units, so it is never fee-subtracted again. Earlier fill costs still need
    // complete coverage before a combined closed result can be eligible.
    if (!calculation.costComplete) costCoverage = 'incomplete';
  }
  const rRatio = net !== null && costCoverage === 'complete' && calculation.initialRisk !== null && decimal(calculation.initialRisk) > 0n
    ? { numerator: decimal(net).toString(), denominator: decimal(calculation.initialRisk).toString() }
    : null;
  const rMultiple = rRatio ? formatRatio(BigInt(rRatio.numerator), BigInt(rRatio.denominator)) : null;
  return { calculation, eligibility, exclusions: reasons, netRealized: net, costCoverage, rRatio, rMultiple };
}

export function projectPosition(row: PositionRow, events: EventRow[], snapshot:OutcomeSnapshotRow|null=null) {
  if(!row.api_plan||typeof row.api_plan!=='object'||Array.isArray(row.api_plan)) throw new CommandError(503,'POSITION_PLAN_UNAVAILABLE','The position’s frozen published plan is unavailable.');
  const outcome = computeOutcome(row, events);
  const currentState = stateAtTime(row.plan, row.state, new Date().toISOString());
  const eventPage=events.slice(0,100);
  return {
    id: row.id, visibility: row.public_publication_id ? 'public' : 'private',
    publicationId: row.public_publication_id, journalEntryId: row.private_journal_entry_id,
    state: currentState, plan: row.api_plan, events: eventPage.map(event=>serializeEvent({...event,retrospective:isRetrospectiveEntry(row,event)})), eventsNextCursor: events.length>eventPage.length&&eventPage.length?cursorFor(eventPage.at(-1)!,row.id):null,
    calculationVersion: Number(row.calculation_version), revision: Number(row.revision),
    remainingQuantity: Number(row.remaining_quantity),
    initialRisk: row.initial_risk,
    riskSourceVersionId:row.risk_source_version_id,
    outcome: {
      netRealized: outcome.netRealized,
      rMultiple: outcome.rMultiple,
      costCoverage: outcome.costCoverage,
      eligibility: outcome.eligibility,
      exclusions: outcome.exclusions,
      borrowCostCoverage: outcome.calculation.borrowCostCoverage,
      publicationVersionId:snapshot?.publication_version_id??row.risk_source_version_id??null,
      sourceEventCutoff:iso(snapshot?.source_event_cutoff??row.published_at??row.created_at),
    },
  };
}

export class PositionService {
  constructor(private readonly pool: Pool,private readonly assertPublicRead?:PublicPositionReadGuard) {}

  async get(id: string, ownerUserId?: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const row = await loadPosition(client, id, ownerUserId);
      if(row.visibility==='public'&&row.public_publication_id&&!(row.owner_user_id===ownerUserId&&row.author_profile_hidden_at!==null)){
        if(!row.current_version_id)throw new CommandError(404,'POSITION_NOT_FOUND');
        await this.assertPublicRead?.(row.public_publication_id,row.current_version_id,client);
      }
      const events = await loadEvents(client, row.id);
      const snapshot=await client.query<OutcomeSnapshotRow>(`SELECT publication_version_id,source_event_cutoff,net::text,r_multiple::text,cost_coverage,eligibility,exclusions
        FROM outcome_snapshot WHERE position_id=$1 ORDER BY source_event_cutoff DESC,created_at DESC LIMIT 1`,[row.id]);
      const projection=projectPosition(row, events, snapshot.rows[0]??null);
      await client.query('COMMIT');
      return projection;
    } catch(error) { await client.query('ROLLBACK').catch(()=>undefined); throw error;
    } finally { client.release(); }
  }

  async listEvents(id: string, ownerUserId: string | undefined, cursor: unknown, limit: unknown) {
    const take = limit === undefined ? 20 : Number(limit);
    if (!Number.isInteger(take) || take < 1 || take > 50) throw new CommandError(400, 'INVALID_LIMIT');
    if(!UUID.test(id))throw new CommandError(400,'INVALID_ID');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const position = await loadPosition(client, id, ownerUserId);
      if(position.visibility==='public'&&position.public_publication_id&&!(position.owner_user_id===ownerUserId&&position.author_profile_hidden_at!==null)){
        if(!position.current_version_id)throw new CommandError(404,'POSITION_NOT_FOUND');
        await this.assertPublicRead?.(position.public_publication_id,position.current_version_id,client);
      }
      const after = decodeCursor(cursor,position.id);
      const page = await loadEventPage(client,position.id,after,take+1);
      const hasMore = page.length > take;
      if (hasMore) page.pop();
      const response={ items: page.map(event => serializeEvent({ ...event, retrospective: isRetrospectiveEntry(position,event) })), nextCursor: hasMore && page.length ? cursorFor(page.at(-1)!,position.id) : null };
      await client.query('COMMIT');
      return response;
    } catch(error) { await client.query('ROLLBACK').catch(()=>undefined); throw error;
    } finally { client.release(); }
  }

  async append(ownerUserId: string, id: string, expectedRevision: number, idempotencyKey: string, input: EventInput) {
    if (!UUID.test(id)) throw new CommandError(400, 'INVALID_ID');
    const result = await executeIdempotentCommand(this.pool, {
      actorUserId: ownerUserId, operation: `position-event:${id}`, idempotencyKey, input: eventInputJson(input),
    }, async tx => {
      await tx.query(`SELECT pub.id FROM publication pub JOIN position p ON p.public_publication_id=pub.id
        WHERE p.id=$1 FOR SHARE OF pub`,[id]);
      const position = await loadPosition(tx, id, ownerUserId, true);
      if (position.owner_user_id !== ownerUserId) throw new CommandError(404, 'POSITION_NOT_FOUND');
      if (Number(position.revision) !== expectedRevision) throw new CommandError(409, 'STALE_POSITION', 'Position changed. Reload before reporting another event.');
      const rows = await loadEvents(tx, id, true);
      const active = activeEvents(rows);
      const nowResult = await tx.query<{ now: Date }>('SELECT CURRENT_TIMESTAMP AS now');
      const now = nowResult.rows[0];
      if (!now) throw new CommandError(503, 'DATABASE_CLOCK_UNAVAILABLE');
      const receivedAt = iso(now.now);
      const state = stateAtTime(position.plan, position.state, receivedAt);
      const details: EventDetails = {
        ...(input.resolution ? { resolution: input.resolution } : {}),
        ...(input.netResult === undefined ? {} : { netResult: input.netResult }),
        ...(input.borrowCosts === undefined ? {} : { borrowCosts: input.borrowCosts }),
      };
      const event = {
        type: input.type, claimedAt: input.claimedAt, receivedAt,
        ...(input.quantity === undefined ? {} : { quantity: input.quantity }), ...(input.price === undefined ? {} : { price: input.price }),
        ...(input.costs === undefined ? {} : { costs: input.costs === null ? null : { amount: input.costs } }),
        ...(input.reason === undefined ? {} : { reason: input.reason }), ...(input.resolution === undefined ? {} : { resolution: input.resolution }),
        ...(input.netResult === undefined ? {} : { netResult: input.netResult }),
        ...(input.borrowCosts === undefined ? {} : { borrowCosts: input.borrowCosts }),
      } as DomainEvent;
      let nextState: PositionState;
      let remainingQuantity = Number(position.remaining_quantity);
      let entryRetrospective = false;
      const previous = active.map(eventDomain);
      const transition = transitionPosition({ state, plan: position.plan, events: previous, ...(position.published_at ? {publicationAt:position.published_at.toISOString()} : {}), now: receivedAt }, event);
      if (transition.validation.length) throw new CommandError(422, 'INVALID_POSITION_EVENT', 'The reported event does not match this position state.', transition.validation.map(issue => ({ path: 'event', message: issue.message })));
      nextState = transition.state;
      remainingQuantity = transition.remainingQuantity;
      if (input.type === 'entry') {
        const eligibility = entryEligibility(iso(position.published_at??position.created_at), input.claimedAt, receivedAt, position.plan.entryFrom ?? '', position.plan.entryUntil ?? '');
        if (eligibility.reasons.includes('invalid_timestamp') || eligibility.reasons.includes('received_before_claimed_time')) throw new CommandError(422, 'INVALID_ENTRY_CHRONOLOGY');
        entryRetrospective = !eligibility.eligible;
        details.retrospective = entryRetrospective;
        details.exclusions = eligibility.reasons;
      }
      if (input.type === 'resolution' && !decimalPattern.test(input.netResult ?? '')) throw new CommandError(422, 'RESOLUTION_NET_RESULT_REQUIRED', 'Enter the net result for the remaining units, including their attributable costs.');
      if (input.borrowCosts !== undefined && (position.plan.asset !== 'stock' || position.plan.strategy !== 'short' || input.type !== 'entry')) throw new CommandError(422, 'BORROW_COSTS_UNSUPPORTED');
      if (input.borrowCosts !== undefined && input.borrowCosts !== null && (!decimalPattern.test(input.borrowCosts) || decimal(input.borrowCosts) < 0n)) throw new CommandError(422, 'INVALID_BORROW_COSTS');
      if (['cancel','never_entered'].includes(input.type)) remainingQuantity = 0;
      if (input.type === 'review' && state === 'unresolved' && active.some(row => row.type === 'resolution')) remainingQuantity = 0;
      const eventId = randomUUID();
      await tx.query(`INSERT INTO position_event(id,position_id,type,claimed_at,received_at,quantity,price,costs,reason,details)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, [
        eventId,id,input.type,input.claimedAt,receivedAt,input.quantity ?? null,input.price ?? null,input.costs ?? null,input.reason?.trim() ?? null,JSON.stringify(details),
      ]);
      const revision = positiveRevision(Number(position.revision));
      await tx.query(`UPDATE position SET state=$3,remaining_quantity=$4,revision=$5,updated_at=$6 WHERE id=$1 AND revision=$2`, [id,position.revision,nextState,remainingQuantity,revision,receivedAt]);
      const newEvent: EventRow = { id:eventId,type:input.type,claimed_at:new Date(input.claimedAt),received_at:new Date(receivedAt),quantity:input.quantity ?? null,price:input.price ?? null,costs:input.costs ?? null,reason:input.reason?.trim() ?? null,supersedes_id:null,details };
      const allEvents = [...rows,newEvent];
      const updated: PositionRow = { ...position, state:nextState,remaining_quantity:remainingQuantity,revision,updated_at:new Date(receivedAt) } as PositionRow;
      const outcome = computeOutcome(updated,allEvents);
      await tx.query(`INSERT INTO outcome_snapshot(id,position_id,source_event_cutoff,calculation_version,eligibility,exclusions,net,r_multiple,cost_coverage,publication_version_id,created_at)
        VALUES($1,$2,$3,'1',$4,$5::jsonb,$6,$7,$8,$9,$3)`, [
        randomUUID(),id,receivedAt,outcome.eligibility,JSON.stringify(outcome.exclusions),outcome.netRealized,outcome.rMultiple,outcome.costCoverage,position.current_version_id??null,
      ]);
      const response = { id:eventId,positionId:id,receivedAt,claimedAt:input.claimedAt,state:nextState,retrospective:entryRetrospective,calculationVersion:1 };
      return { status:201,body:response as unknown as Json,resourceId:id };
    });
    return result.body as unknown as { id:string; positionId:string; receivedAt:string; claimedAt:string; state:string; retrospective:boolean; calculationVersion:number };
  }

  async correctPrivateEvent(ownerUserId:string,positionId:string,expectedRevision:number,sourceEventId:string,idempotencyKey:string,input:EventInput) {
    if(!UUID.test(positionId)||!UUID.test(sourceEventId))throw new CommandError(400,'INVALID_ID');
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw new CommandError(400,'INVALID_REVISION');
    const result=await executeIdempotentCommand(this.pool,{actorUserId:ownerUserId,operation:`position-private-correction:${positionId}`,idempotencyKey,
      input:JSON.parse(JSON.stringify({expectedRevision,sourceEventId,event:input})) as Json},async tx=>{
      const position=await loadPosition(tx,positionId,ownerUserId,true);
      if(position.public_publication_id!==null||position.private_journal_entry_id===null)throw new CommandError(404,'POSITION_NOT_FOUND');
      if(Number(position.revision)!==expectedRevision)throw new CommandError(409,'STALE_POSITION','Position changed. Reload before correcting an event.');
      const receipt=await this.applyCorrectedEvent(tx,positionId,sourceEventId,input,undefined,ownerUserId);
      const eligibility=input.type==='entry'?entryEligibility(iso(position.created_at),input.claimedAt,receipt.receivedAt,position.plan.entryFrom??'',position.plan.entryUntil??''):null;
      const body={id:receipt.id,positionId:receipt.positionId,receivedAt:receipt.receivedAt,claimedAt:input.claimedAt,state:receipt.state,
        retrospective:eligibility?!eligibility.eligible:false,calculationVersion:1};
      return {status:201,body:body as unknown as Json,resourceId:positionId};
    });
    return result.body as unknown as {id:string;positionId:string;receivedAt:string;claimedAt:string;state:string;retrospective:boolean;calculationVersion:number};
  }

  /** Apply a reviewed event correction within the correction-review transaction. */
  async applyCorrectedEvent(client:Transaction,positionId:string,sourceEventId:string,input:EventInput,publicationVersionId?:string,privateOwnerUserId?:string) {
    if(!UUID.test(positionId)||!UUID.test(sourceEventId)) throw new CommandError(400,'INVALID_ID');
    const position=await loadPosition(client,positionId,privateOwnerUserId,true);
    if(privateOwnerUserId ? position.public_publication_id!==null||position.private_journal_entry_id===null : !position.public_publication_id) throw new CommandError(404,'POSITION_NOT_FOUND');
    if(['entry','partial_exit','final_exit'].includes(input.type)&&input.costs===undefined)throw new CommandError(422,'FILL_COSTS_REQUIRED','Supply fill costs or explicitly mark them unknown.');
    if(input.borrowCosts!==undefined&&(position.plan.asset!=='stock'||position.plan.strategy!=='short'||input.type!=='entry'))throw new CommandError(422,'BORROW_COSTS_UNSUPPORTED');
    if(input.borrowCosts!==undefined&&input.borrowCosts!==null&&(!decimalPattern.test(input.borrowCosts)||decimal(input.borrowCosts)<0n))throw new CommandError(422,'INVALID_BORROW_COSTS');
    const rows=await loadEvents(client,positionId,true);
    const source=rows.find(row=>row.id===sourceEventId);
    if(!source||!activeEvents(rows).some(row=>row.id===sourceEventId)) throw new CommandError(409,'CORRECTION_SOURCE_UNAVAILABLE','The source event is already superseded or unavailable.');
    const receivedResult=await client.query<{now:Date}>('SELECT CURRENT_TIMESTAMP AS now');
    const now=receivedResult.rows[0];
    if(!now)throw new CommandError(503,'DATABASE_CLOCK_UNAVAILABLE');
    const receivedAt=iso(now.now);
    const details:EventDetails={
      ...(input.resolution?{resolution:input.resolution}:{}),
      ...(input.netResult===undefined?{}:{netResult:input.netResult}),
      ...(input.borrowCosts===undefined?{}:{borrowCosts:input.borrowCosts}),
    };
    const replacement:EventRow={id:randomUUID(),type:input.type,claimed_at:new Date(input.claimedAt),received_at:new Date(receivedAt),quantity:input.quantity??null,price:input.price??null,costs:input.costs??null,reason:input.reason?.trim()??null,supersedes_id:sourceEventId,details};
    const replay=[...activeEvents(rows).filter(row=>row.id!==sourceEventId),replacement].sort((a,b)=>a.claimed_at.getTime()-b.claimed_at.getTime()||a.received_at.getTime()-b.received_at.getTime()||a.id.localeCompare(b.id));
    let state:PositionState='pending';let remaining=Number(position.plan.quantity);const domainEvents:DomainEvent[]=[];
    for(const row of replay){
      const event=eventDomain(row);
      const transition=transitionPosition({state,plan:position.plan,events:domainEvents,...(position.published_at?{publicationAt:position.published_at.toISOString()}:{}),now:receivedAt},event);
      if(transition.validation.length) throw new CommandError(422,'INVALID_CORRECTED_EVENT','The proposed event does not produce a valid lifecycle.',transition.validation.map(issue=>({path:'replacementEvent',message:issue.message})));
      state=transition.state;remaining=transition.remainingQuantity;domainEvents.push(event);
      if(row.type==='review'&&state==='closed') remaining=0;
      if(state==='canceled'||state==='never_entered') remaining=0;
    }
    if(input.type==='resolution'&&!decimalPattern.test(input.netResult??'')) throw new CommandError(422,'RESOLUTION_NET_RESULT_REQUIRED');
    await client.query(`INSERT INTO position_event(id,position_id,type,claimed_at,received_at,quantity,price,costs,reason,supersedes_id,details)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,[replacement.id,positionId,input.type,input.claimedAt,receivedAt,input.quantity??null,input.price??null,input.costs??null,input.reason?.trim()??null,sourceEventId,JSON.stringify(details)]);
    const revision=positiveRevision(Number(position.revision));
    await client.query('UPDATE position SET state=$2,remaining_quantity=$3,revision=$4,updated_at=$5 WHERE id=$1',[positionId,state,remaining,revision,receivedAt]);
    const outcome=computeOutcome({...position,state,remaining_quantity:remaining,revision} as PositionRow,[...rows,replacement]);
    await client.query(`INSERT INTO outcome_snapshot(id,position_id,source_event_cutoff,calculation_version,eligibility,exclusions,net,r_multiple,cost_coverage,publication_version_id,created_at)
      VALUES($1,$2,$3,'1',$4,$5::jsonb,$6,$7,$8,$9,$3)`,[randomUUID(),positionId,receivedAt,outcome.eligibility,JSON.stringify(outcome.exclusions),outcome.netRealized,outcome.rMultiple,outcome.costCoverage,publicationVersionId??position.current_version_id??null]);
    return {id:replacement.id,positionId,state,revision,receivedAt};
  }
}

export interface PerformanceQuery { asset?: string; strategy?: string }
export class PerformanceService {
  constructor(private readonly pool: Pool,private readonly assertPublicRead?:PublicPositionReadGuard) {}

  async get(handle: string, filters: PerformanceQuery = {}) {
    if (!/^[a-z0-9_]{3,30}$/.test(handle)) throw new CommandError(400, 'INVALID_HANDLE');
    const profile = await this.pool.query<{ user_id:string }>(`SELECT p.user_id FROM profile p JOIN user_account u ON u.id=p.user_id
      WHERE p.normalized_handle=$1 AND u.status='active' AND p.moderation_hidden_at IS NULL`,[handle.toLowerCase()]);
    if (!profile.rows[0]) throw new CommandError(404, 'PROFILE_NOT_FOUND');
    return this.getForUser(profile.rows[0].user_id, filters);
  }

  async getForUser(userId:string, filters: PerformanceQuery = {}) {
    const result = await this.pool.query(`WITH latest AS (
      SELECT DISTINCT ON (o.position_id) o.position_id,o.net::text,o.r_multiple::text,o.cost_coverage,o.eligibility,o.exclusions
      FROM outcome_snapshot o ORDER BY o.position_id,o.source_event_cutoff DESC,o.created_at DESC
    ) SELECT p.state,p.plan,p.initial_risk::text,p.public_publication_id,p.remaining_quantity,p.created_at,pub.current_version_id,
        pub.published_at,COALESCE(latest.net::text,'0') AS net,latest.r_multiple::text,latest.cost_coverage,latest.eligibility,latest.exclusions
      FROM position p JOIN publication pub ON pub.id=p.public_publication_id AND pub.author_user_id=p.owner_user_id JOIN user_account author ON author.id=p.owner_user_id AND author.status='active' JOIN profile author_profile ON author_profile.user_id=p.owner_user_id AND author_profile.moderation_hidden_at IS NULL LEFT JOIN latest ON latest.position_id=p.id
      WHERE p.owner_user_id=$1 AND pub.visibility='public' AND pub.published_at IS NOT NULL
      ORDER BY p.created_at DESC`,[userId]);
    const readableRows=await Promise.all(result.rows.map(async row=>{
      if(!this.assertPublicRead)return row;
      if(!row.public_publication_id||!row.current_version_id)return null;
      try{await this.assertPublicRead(row.public_publication_id,row.current_version_id,this.pool);return row;}
      catch(error){if(error instanceof CommandError&&error.status===404)return null;throw error;}
    }));
    const records = readableRows.flatMap(row => {
      if(!row)return [];
      const plan = row.plan as TradePlan;
      if (filters.asset && plan.asset !== filters.asset || filters.strategy && plan.strategy !== filters.strategy) return [];
      const state=stateAtTime(plan,row.state as PositionState,new Date().toISOString());
      let net: string | null = row.eligibility ? row.net : null;
      if (row.cost_coverage !== 'complete') net = null;
      const result: CalculationResult = {
        grossRealized:'0',knownCosts:'0',netRealized:net,initialRisk:row.initial_risk,rMultiple:row.r_multiple,
      rRatio:net !== null && row.initial_risk && row.cost_coverage==='complete' ? {numerator:decimal(net).toString(),denominator:decimal(row.initial_risk).toString()} : null,
        maxLoss:null,maxProfit:null,maxProfitKind:null,remainingQuantity:0,costComplete:row.cost_coverage==='complete',borrowCostCoverage:null,
        calculationVersion:'1',metadataVersion:plan.instrument?.metadataVersion ?? null,entryTermsVersion:1,
        frozenRiskSourceVersion:null,frozenRiskMetadataVersion:null,frozenRiskEntryTermsVersion:null,
      };
      return [{ result, eligible:row.eligibility==='eligible', state, asset:plan.asset, strategy:plan.strategy, eligibility:row.eligibility as string|null }];
    });
    const closed=records.filter(x=>x.state==='closed'&&x.eligible);
    const complete=closed.filter(x=>x.result.costComplete&&x.result.netRealized!==null);
    const values=complete.map(x=>decimal(x.result.netRealized!));
    const wins=values.filter(value=>value>0n),losses=values.filter(value=>value<0n),breakevens=values.filter(value=>value===0n);
    const total=values.reduce((sum,value)=>sum+value,0n);
    const average=(list:bigint[])=>list.length?formatDecimal(list.reduce((sum,value)=>sum+value,0n)/BigInt(list.length)):null;
    const meanR=meanExactRatios(complete.map(item=>item.result));
    const excluded={
      retrospective:records.filter(x=>x.eligibility==='retrospective').length,
      unresolved:records.filter(x=>x.state==='unresolved').length,
      open:records.filter(x=>x.state==='entered'||x.state==='partially_closed').length,
      canceled:records.filter(x=>x.state==='canceled').length,
      never_entered:records.filter(x=>x.state==='never_entered').length,
      pending:records.filter(x=>x.state==='pending').length,
    };
    return {
      closedCount:closed.length,wins:wins.length,losses:losses.length,breakevens:breakevens.length,
      unresolved:records.filter(x=>x.state==='unresolved').length,
      retrospective:excluded.retrospective,
      incompleteCosts:closed.length-complete.length,
      winRate:wins.length+losses.length ? Number((wins.length/(wins.length+losses.length)).toFixed(4)) : null,
      reportedRealizedPnl:formatDecimal(total),
      meanR,
      evidence:'member_reported',
      completeCostClosedCount:complete.length,
      incompleteCostClosedCount:closed.length-complete.length,
      excluded,
      averageWin:average(wins),averageLoss:average(losses),worstLoss:losses.length?formatDecimal(losses.reduce((a,b)=>a<b?a:b)):null,
    };
  }
}
