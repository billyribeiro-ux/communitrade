import { billingEntitlementScope, billingEntitlementPredicate } from '@trading/config';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { CommandError } from '../http/problem.js';
import type { PerformanceService } from '../positions/service.js';

const RESERVED = new Set(['about','account','accessibility','admin','administrator','api','auth','billing','blog','callback','comments','contact','design_preview','email','export','faq','features','feed','following','followers','help','home','ideas','journal','login','logout','media','me','moderator','notifications','oauth','official','onboarding','password','plans','policy','privacy','pricing','profile','register','reset','root','search','security','settings','signup','staff','status','subscribe','support','terms','uploads','users','verify','www']);
export function validateHandle(handle:string):string {
  const normalized=handle.trim().toLowerCase();
  if(!/^[a-z0-9_]{3,30}$/.test(normalized))throw new CommandError(422,'INVALID_HANDLE','Use 3–30 lowercase letters, numbers, or underscores.');
  if(RESERVED.has(normalized)||normalized.startsWith('api_')||normalized.endsWith('_official'))throw new CommandError(422,'HANDLE_RESERVED','That handle is reserved.');
  return normalized;
}
export interface ProfileWrite { handle?: string; displayName?: string; bio?: string; links?: string[]; interests?: string[]; avatarMediaId?: string | null }
export interface PublicProfile {
  user: { id: string; handle: string; displayName: string; avatarUrl: string | null; pro: boolean };
  bio: string; links: string[]; interests: string[]; joinedAt: string; followers: number; following: number;
  statistics: { closedCount:number; wins:number; losses:number; breakevens:number; unresolved:number; retrospective:number; incompleteCosts:number; winRate:number|null; reportedRealizedPnl:string; meanR:string|null; evidence:'member_reported' };
  revision: number;
}
export class ProfileService {
  constructor(private readonly pool: Pool, private readonly performance?: Pick<PerformanceService, 'getForUser'>) {}
  async getPublic(handle: string): Promise<{profile:PublicProfile;redirect?:string}> {
    const normalized = handle.toLowerCase();
    const result = await this.pool.query(`SELECT p.*,u.created_at FROM profile p JOIN user_account u ON u.id=p.user_id WHERE p.normalized_handle=$1 AND u.status='active' AND p.moderation_hidden_at IS NULL`,[normalized]);
    if (result.rowCount) return { profile: await this.project(result.rows[0]) };
    const history = await this.pool.query('SELECT p.handle,h.redirect_expires_at FROM handle_history h JOIN profile p ON p.user_id=h.user_id JOIN user_account u ON u.id=p.user_id WHERE h.old_handle=$1 AND u.status=$2 AND p.moderation_hidden_at IS NULL',[normalized,'active']);
    if (history.rowCount && history.rows[0].redirect_expires_at && new Date(history.rows[0].redirect_expires_at as Date).getTime() > Date.now()) return { profile: await this.getProfileByHandle(history.rows[0].handle as string), redirect: history.rows[0].handle as string };
    throw new CommandError(404,'PROFILE_NOT_FOUND','Profile is unavailable.');
  }
  async update(userId: string, expectedRevision: number, input: ProfileWrite): Promise<PublicProfile> {
    const next: ProfileWrite = { ...input };
    if (next.handle !== undefined) next.handle = validateHandle(next.handle);
    if (next.displayName !== undefined) {
      next.displayName = next.displayName.trim();
      if(next.displayName.length<2||next.displayName.length>60)throw new CommandError(422,'INVALID_DISPLAY_NAME','Display name must contain 2–60 characters.');
    }
    if (next.bio !== undefined) next.bio = next.bio.trim();
    if (next.links !== undefined) {
      if (next.links.some(link => { try { const url = new URL(link); return url.protocol !== 'https:' || !url.hostname || url.username !== '' || url.password !== ''; } catch { return true; } })) throw new CommandError(422,'INVALID_PROFILE_LINK','Profile links must be valid HTTPS URLs.');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT * FROM profile WHERE user_id=$1 FOR UPDATE',[userId]);
      if (!current.rowCount) throw new CommandError(404,'PROFILE_NOT_FOUND','Profile is unavailable.');
      const row = current.rows[0];
      if (row.revision !== expectedRevision) throw new CommandError(409,'STALE_PROFILE','Profile changed. Reload before saving.');
      if (next.avatarMediaId !== undefined && next.avatarMediaId !== null) {
        const media = await client.query(`SELECT id FROM media WHERE id=$1 AND owner_user_id=$2 AND purpose='avatar' AND status='ready' FOR UPDATE`,[next.avatarMediaId,userId]);
        if (!media.rowCount) throw new CommandError(404,'MEDIA_NOT_FOUND','Avatar is unavailable.');
      }
      const handle = next.handle ?? row.handle as string;
      if (handle !== row.handle) {
        const lastChange = await client.query(`SELECT changed_at,changed_at+interval '30 days' AS next_allowed_at FROM handle_history WHERE user_id=$1 ORDER BY changed_at DESC LIMIT 1`,[userId]);
        if(lastChange.rowCount){
          const { next_allowed_at: nextAllowedAt } = lastChange.rows[0];
          if(new Date(nextAllowedAt as Date).getTime()>Date.now()) throw new CommandError(409,'HANDLE_CHANGE_COOLDOWN',`Handle changes are limited to once every 30 days. You can change it again after ${new Date(nextAllowedAt as Date).toISOString()}.`);
        }
        // Redirects expire after one year, but previously used handles remain
        // reserved forever so an old identity cannot be claimed by another user.
        const exists = await client.query(`SELECT 1 FROM profile WHERE normalized_handle=$1 UNION ALL SELECT 1 FROM handle_history WHERE old_handle=$1 LIMIT 1`,[handle]);
        if (exists.rowCount) throw new CommandError(409,'HANDLE_TAKEN','That handle is unavailable.');
        await client.query(`INSERT INTO handle_history(id,old_handle,user_id,changed_at,redirect_expires_at) VALUES($1,$2,$3,now(),now()+interval '1 year') ON CONFLICT(old_handle) DO UPDATE SET user_id=EXCLUDED.user_id, changed_at=now(), redirect_expires_at=EXCLUDED.redirect_expires_at`,[randomUUID(),row.handle,userId]);
      }
      const saved = await client.query(`UPDATE profile SET handle=$2,normalized_handle=$3,display_name=$4,bio=$5,links=$6::jsonb,interests=$7::jsonb,avatar_media_id=$8,revision=revision+1,updated_at=now()
        WHERE user_id=$1 AND revision=$9 RETURNING *`,[userId,handle,handle,next.displayName ?? row.display_name,next.bio ?? row.bio,JSON.stringify(next.links ?? row.links ?? []),JSON.stringify(next.interests ?? row.interests ?? []),next.avatarMediaId === undefined ? row.avatar_media_id : next.avatarMediaId,expectedRevision]);
      if (!saved.rowCount) throw new CommandError(409,'STALE_PROFILE','Profile changed. Reload before saving.');
      await client.query('COMMIT');
      const user = await this.pool.query('SELECT created_at FROM user_account WHERE id=$1',[userId]);
      return this.project({ ...saved.rows[0], created_at: user.rows[0].created_at });
    } catch (error) { await client.query('ROLLBACK').catch(()=>undefined); if (error instanceof CommandError) throw error; if ((error as {code?:string}).code==='23505') throw new CommandError(409,'HANDLE_TAKEN','That handle is unavailable.'); throw new CommandError(503,'PROFILE_UNAVAILABLE','Profile could not be saved. Retry.'); }
    finally { client.release(); }
  }
  private async getProfileByHandle(handle:string):Promise<PublicProfile> { const r=await this.pool.query("SELECT p.*,u.created_at FROM profile p JOIN user_account u ON u.id=p.user_id WHERE p.normalized_handle=$1 AND u.status='active' AND p.moderation_hidden_at IS NULL",[handle.toLowerCase()]); if(!r.rowCount) throw new CommandError(404,'PROFILE_NOT_FOUND','Profile is unavailable.'); return this.project(r.rows[0]); }
  private async project(row: Record<string,unknown>): Promise<PublicProfile> {
    const userId = row.user_id as string;
    const [counts, positions, entitlement] = await Promise.all([
      this.pool.query(`SELECT count(*) FILTER(WHERE target_user_id=$1)::int AS followers,count(*) FILTER(WHERE follower_user_id=$1)::int AS following FROM follow WHERE target_user_id=$1 OR follower_user_id=$1`,[userId]),
      this.performance ? this.performance.getForUser(userId) : this.pool.query(`WITH latest AS (
        SELECT DISTINCT ON (o.position_id) o.position_id,o.net,o.r_multiple,o.cost_coverage,o.eligibility
        FROM outcome_snapshot o JOIN position p ON p.id=o.position_id
        JOIN publication pub ON pub.id=p.public_publication_id AND pub.author_user_id=p.owner_user_id
        WHERE p.owner_user_id=$1 AND pub.visibility='public' AND pub.published_at IS NOT NULL
        ORDER BY o.position_id,o.source_event_cutoff DESC,o.created_at DESC
      ), public_positions AS (
        SELECT p.id,p.state,l.net,l.r_multiple,l.cost_coverage,l.eligibility
        FROM position p
        JOIN publication pub ON pub.id=p.public_publication_id AND pub.author_user_id=p.owner_user_id
        LEFT JOIN latest l ON l.position_id=p.id
        WHERE p.owner_user_id=$1 AND pub.visibility='public' AND pub.published_at IS NOT NULL
      )
      SELECT count(*) FILTER(WHERE state IN ('closed','resolved'))::int AS closed,
        count(*) FILTER(WHERE state IN ('closed','resolved') AND eligibility='eligible' AND cost_coverage='complete' AND net>0)::int AS wins,
        count(*) FILTER(WHERE state IN ('closed','resolved') AND eligibility='eligible' AND cost_coverage='complete' AND net<0)::int AS losses,
        count(*) FILTER(WHERE state IN ('closed','resolved') AND eligibility='eligible' AND cost_coverage='complete' AND net=0)::int AS breakevens,
        count(*) FILTER(WHERE state IN ('entered','partially_closed','unresolved'))::int AS unresolved,
        count(*) FILTER(WHERE state IN ('closed','resolved') AND eligibility='retrospective')::int AS retrospective,
        count(*) FILTER(WHERE state IN ('closed','resolved') AND eligibility='eligible' AND cost_coverage IS DISTINCT FROM 'complete')::int AS incomplete_costs,
        COALESCE(sum(net) FILTER(WHERE state IN ('closed','resolved') AND eligibility='eligible' AND cost_coverage='complete'),0)::text AS realized,
        avg(r_multiple) FILTER(WHERE state IN ('closed','resolved') AND eligibility='eligible' AND cost_coverage='complete')::text AS mean_r
      FROM public_positions`,[userId]),
      this.pool.query(`SELECT EXISTS(SELECT 1 FROM subscription_entitlement WHERE user_id=$1 AND plan='pro' AND valid_from<=now() AND (valid_until IS NULL OR valid_until>now()) AND ${billingEntitlementPredicate('',2)}) AS pro`,[userId,...billingEntitlementScope(process.env)]),
    ]);
    const stats='rows' in positions
      ? (()=>{const p=positions.rows[0] as Record<string,number|string|null>|undefined;if(!p)throw new CommandError(503,'PROFILE_STATISTICS_UNAVAILABLE');const closed=Number(p.closed||0),wins=Number(p.wins||0),losses=Number(p.losses||0);return {closedCount:closed,wins,losses,breakevens:Number(p.breakevens||0),unresolved:Number(p.unresolved||0),retrospective:Number(p.retrospective||0),incompleteCosts:Number(p.incomplete_costs||0),winRate:wins+losses?wins/(wins+losses):null,reportedRealizedPnl:String(p.realized??'0'),meanR:p.mean_r===null?null:String(p.mean_r),evidence:'member_reported'};})()
      : positions;
    return { user:{id:userId,handle:row.handle as string,displayName:row.display_name as string,avatarUrl:row.avatar_media_id?`/api/v1/media/${row.avatar_media_id}/content`:null,pro:Boolean(entitlement.rows[0].pro)}, bio:(row.bio as string|null)??'',links:(row.links as string[]|null)??[],interests:(row.interests as string[]|null)??[],joinedAt:new Date(row.created_at as Date).toISOString(),followers:Number(counts.rows[0].followers||0),following:Number(counts.rows[0].following||0),statistics:stats as any,revision:Number(row.revision)};
  }
}
