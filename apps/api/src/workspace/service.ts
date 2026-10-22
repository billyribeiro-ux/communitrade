import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { validateChartState, type components } from '@trading/contracts';
import { CommandError } from '../http/problem.js';
import { canonicalJson, executeIdempotentCommand, parseIfMatch, requireUuid, withActorTransaction, type Transaction } from '../persistence/transactions.js';
import { effectivePlan, serializeUser } from './entitlements.js';
import { validateChartSemantics } from '../drafts/service.js';

type Watchlist = components['schemas']['Watchlist'];
type Layout = components['schemas']['Layout'];
type LayoutWrite = components['schemas']['LayoutWrite'];
type Kind = 'watchlist'|'layout';
const iso = (v: Date | string) => new Date(v).toISOString();
const nameOf = (value: string) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new CommandError(422,'INVALID_NAME');
  return value.trim();
};
function cursor(input: unknown, owner: string, kind: Kind): { at: string; id: string } | null {
  if (input === undefined || input === '') return null;
  try {
    if (typeof input !== 'string' || input.length > 500) throw new Error();
    const v = JSON.parse(Buffer.from(input,'base64url').toString());
    if (v.v !== 1 || v.owner !== owner || v.kind !== kind || typeof v.at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(v.at) || !Number.isFinite(Date.parse(v.at))) throw new Error();
    requireUuid(v.id); return { at:v.at,id:v.id };
  } catch { throw new CommandError(400,'INVALID_CURSOR'); }
}
const tables = { watchlist:'watchlist', layout:'saved_layout' } as const;
export class WorkspaceService {
  constructor(private readonly pool: Pool,private readonly resolveInstruments?: (ids:string[],tx:Transaction)=>Promise<components['schemas']['Instrument'][]>) {}
  async usage(userId: string) {
    return withActorTransaction(this.pool,userId,async tx => {
      const limits = await effectivePlan(tx,userId);
      const result=await tx.query(`SELECT date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS month_start,
        (date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC' AS next_month,
        COALESCE((SELECT count+reserved_count FROM quota_bucket WHERE user_id=$1 AND metric='journal_monthly' AND month_start=date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0)::int AS used,
        (SELECT count(*)::int FROM watchlist WHERE owner_user_id=$1) AS watchlists,
        (SELECT count(*)::int FROM saved_layout WHERE owner_user_id=$1) AS layouts`,[userId]);
      const row=result.rows[0]!;
      return {...limits,monthStart:iso(row.month_start),nextMonthStart:iso(row.next_month),journalEntriesThisMonth:row.used,watchlistCount:row.watchlists,layoutCount:row.layouts};
    });
  }
  private async project(tx: Transaction, kind: Kind, row: any): Promise<Watchlist|Layout> {
    const common={id:row.id,name:row.name,revision:row.revision,updatedAt:iso(row.updated_at)};
    if(kind==='layout') return {...common,state:row.template};
    const items=await tx.query<{instrument_id:string}>('SELECT instrument_id FROM watchlist_item WHERE list_id=$1 ORDER BY created_at,id',[row.id]);
    const instrumentIds=items.rows.map(item=>item.instrument_id);
    return {...common,instrumentIds,...(this.resolveInstruments?{instruments:await this.resolveInstruments(instrumentIds,tx)}:{})};
  }
  async list(userId: string, kind: Kind, rawCursor?: unknown, rawLimit?: unknown): Promise<{items:(Watchlist|Layout)[];nextCursor:string|null}> {
    const after=cursor(rawCursor,userId,kind),limit=rawLimit===undefined?20:Number(rawLimit);
    if(!Number.isInteger(limit)||limit<1||limit>50)throw new CommandError(400,'INVALID_PAGE_LIMIT');
    return withActorTransaction(this.pool,userId,async tx=>{
      const result=await tx.query(`SELECT *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at FROM ${tables[kind]}
        WHERE owner_user_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4`,[userId,after?.at??null,after?.id??null,limit+1]);
      const rows=result.rows.slice(0,limit),items=[];
      for(const row of rows)items.push(await this.project(tx,kind,row));
      const last=rows.at(-1);
      return {items,nextCursor:result.rows.length>limit&&last?Buffer.from(JSON.stringify({v:1,owner:userId,kind,at:last.cursor_at,id:last.id})).toString('base64url'):null};
    });
  }
  private async owned(tx: Transaction,userId:string,kind:Kind,id:string,lock=false) {
    requireUuid(id);
    const result=await tx.query(`SELECT * FROM ${tables[kind]} WHERE id=$1 AND owner_user_id=$2${lock?' FOR UPDATE':''}`,[id,userId]);
    if(!result.rows[0])throw new CommandError(404,'NOT_FOUND');return result.rows[0];
  }
  async get(userId:string,kind:Kind,id:string): Promise<Watchlist|Layout> {
    return withActorTransaction(this.pool,userId,async tx=>this.project(tx,kind,await this.owned(tx,userId,kind,id)));
  }
  private async layout(tx:Transaction,input:LayoutWrite) {
    if(!validateChartState(input.state))throw new CommandError(422,'INVALID_CHART_STATE');
    validateChartSemantics(input.state as any);
    // Templates contain member-owned geometry/settings; never modify frozen evidence.
    const ref=await tx.query('SELECT id FROM instrument_metadata_version WHERE instrument_id=$1 AND version=$2',[input.state.instrumentId,input.state.metadataVersion]);
    if(!ref.rows[0])throw new CommandError(422,'INVALID_INSTRUMENT_REFERENCE');
    return canonicalJson(input.state);
  }
  async create(userId:string,kind:Kind,key:string,input:{name:string}|LayoutWrite): Promise<Watchlist|Layout> {
    const name=nameOf(input.name);
    const result=await executeIdempotentCommand(this.pool,{actorUserId:userId,operation:`workspace.${kind}.create`,idempotencyKey:key,input:input as any},async tx=>{
      await serializeUser(tx,userId);const limits=await effectivePlan(tx,userId);
      const count=await tx.query(`SELECT count(*)::int AS count FROM ${tables[kind]} WHERE owner_user_id=$1`,[userId]);
      if(count.rows[0]!.count >= (kind==='watchlist'?limits.watchlists:limits.layouts))throw new CommandError(403,'QUOTA_EXCEEDED','Existing records remain accessible. Remove a record or upgrade before adding another.');
      const id=randomUUID();
      const result=kind==='watchlist'?await tx.query('INSERT INTO watchlist(id,owner_user_id,name,revision,created_at,updated_at) VALUES($1,$2,$3,1,now(),now()) RETURNING *',[id,userId,name]):
        await tx.query('INSERT INTO saved_layout(id,owner_user_id,name,version,template,revision,created_at,updated_at) VALUES($1,$2,$3,1,$4::jsonb,1,now(),now()) RETURNING *',[id,userId,name,await this.layout(tx,input as LayoutWrite)]);
      return {status:201,body:await this.project(tx,kind,result.rows[0]) as any,resourceId:id};
    });return result.body as unknown as Watchlist|Layout;
  }
  async update(userId:string,kind:Kind,id:string,ifMatch:unknown,input:{name:string}|LayoutWrite): Promise<Watchlist|Layout> {
    const revision=parseIfMatch(ifMatch),name=nameOf(input.name);
    return withActorTransaction(this.pool,userId,async tx=>{
      const row=await this.owned(tx,userId,kind,id,true);
      if(row.revision!==revision)throw new CommandError(409,'STALE_REVISION');
      const template=kind==='layout'?await this.layout(tx,input as LayoutWrite):null;
      const result=await tx.query(`UPDATE ${tables[kind]} SET name=$3,revision=revision+1,updated_at=now()${kind==='layout'?',template=$4::jsonb':''} WHERE id=$1 AND owner_user_id=$2 RETURNING *`,kind==='layout'?[id,userId,name,template]:[id,userId,name]);
      return this.project(tx,kind,result.rows[0]);
    });
  }
  async remove(userId:string,kind:Kind,id:string,ifMatch:unknown) {
    const revision=parseIfMatch(ifMatch);
    return withActorTransaction(this.pool,userId,async tx=>{
      await serializeUser(tx,userId);const row=await this.owned(tx,userId,kind,id,true);
      if(row.revision!==revision)throw new CommandError(409,'STALE_REVISION');
      if(kind==='watchlist')await tx.query('DELETE FROM watchlist_item WHERE list_id=$1',[id]);
      await tx.query(`DELETE FROM ${tables[kind]} WHERE id=$1 AND owner_user_id=$2`,[id,userId]);
    });
  }
  async instrument(userId:string,id:string,instrumentId:string,add:boolean) {
    requireUuid(instrumentId);
    return withActorTransaction(this.pool,userId,async tx=>{
      await serializeUser(tx,userId);await this.owned(tx,userId,'watchlist',id,true);
      const existing=await tx.query('SELECT id FROM watchlist_item WHERE list_id=$1 AND instrument_id=$2',[id,instrumentId]);
      if(add&&existing.rows.length||!add&&!existing.rows.length)return;
      if(add){
        const limits=await effectivePlan(tx,userId),count=await tx.query('SELECT count(*)::int AS count FROM watchlist_item WHERE list_id=$1',[id]);
        if(count.rows[0]!.count>=limits.watchlistItems)throw new CommandError(403,'QUOTA_EXCEEDED');
        const instrument=await tx.query('SELECT id FROM instrument WHERE id=$1 AND enabled=true',[instrumentId]);
        if(!instrument.rows[0])throw new CommandError(422,'INSTRUMENT_UNAVAILABLE');
        await tx.query('INSERT INTO watchlist_item(id,list_id,instrument_id,created_at) VALUES($1,$2,$3,now())',[randomUUID(),id,instrumentId]);
      }else await tx.query('DELETE FROM watchlist_item WHERE list_id=$1 AND instrument_id=$2',[id,instrumentId]);
      await tx.query('UPDATE watchlist SET revision=revision+1,updated_at=now() WHERE id=$1 AND owner_user_id=$2',[id,userId]);
    });
  }
}
