import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { CommandError } from '../http/problem.js';
import { executeIdempotentCommand, type CommandTransaction, type Json } from '../persistence/transactions.js';
import { enqueueTransactionalNotification } from '../notifications/service.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Role='member'|'moderator'|'admin';
type StaffAction='assign'|'hide'|'restore'|'resolve'|'dismiss'|'suspend'|'unsuspend'|'change_role'|'revoke_sessions'|'select'|'deselect';
type Command={action:StaffAction;reason:string;reviewerUserId?:string;role?:Role;outcome?:'uphold'|'overturn'};
type PageCursor={v:1;createdAt:string;id:string;scope:string};
type Row=Record<string,any>;
function checkedReason(value:unknown){if(typeof value!=='string'||!value.trim()||value.trim().length>2000)throw new CommandError(422,'REASON_REQUIRED','Provide a reason between 1 and 2,000 characters.');return value.trim();}
function checkedId(value:string){if(!UUID.test(value))throw new CommandError(400,'INVALID_ID');return value;}
function checkedLimit(raw:unknown){const n=raw===undefined?20:Number(raw);if(!Number.isInteger(n)||n<1||n>50)throw new CommandError(400,'INVALID_LIMIT');return n;}
function decodeCursor(raw:unknown,scope:string):PageCursor|undefined {if(raw===undefined||raw==='')return undefined;if(typeof raw!=='string'||raw.length>500)throw new CommandError(400,'INVALID_CURSOR');try{const c=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));if(c.v!==1||typeof c.createdAt!=='string'||!Number.isFinite(Date.parse(c.createdAt))||!UUID.test(c.id)||c.scope!==scope)throw Error();return c;}catch{throw new CommandError(400,'INVALID_CURSOR');}}
function encodeCursor(row:Row,scope:string){const raw=row.cursor_created_at??row.created_at??row.createdAt;const createdAt=typeof raw==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(raw)?raw:new Date(raw).toISOString().replace(/\.(\d{3})Z$/,'$1000Z');return Buffer.from(JSON.stringify({v:1,createdAt,id:String(row.cursor_id??row.id),scope})).toString('base64url');}
function page(rows:Row[],limit:number,scope:string,sourceRows:Row[]=rows){const more=rows.length>limit;const items=rows.slice(0,limit);return {items,nextCursor:more&&items.length?encodeCursor(sourceRows.at(items.length-1)!,scope):null};}
function toAudit(row:Row){return {id:String(row.id),actorId:String(row.actor),action:String(row.action),resourceType:String(row.resource_type),resourceId:row.resource_id===null?'':String(row.resource_id),reason:row.reason??'',createdAt:new Date(row.created_at).toISOString()};}
function toReport(row:Row,actorId?:string){return {id:String(row.id),status:row.status,createdAt:new Date(row.created_at).toISOString(),reason:row.reason,decision:row.decision??null,resourceType:row.resource_type,resourceId:String(row.resource_id),detail:row.detail??'',appeals:row.appeals??[],assignedReviewerUserId:row.assigned_reviewer_user_id?String(row.assigned_reviewer_user_id):null,lastAction:row.last_action??null,viewerCanReview:Boolean(actorId&&row.assigned_reviewer_user_id===actorId&&row.reporter_user_id!==actorId&&row.target_author_id!==actorId),...(row.target?{target:row.target}:{})};}
function toUser(row:Row){return {user:{id:String(row.id),handle:row.handle??null,displayName:row.display_name??(row.status==='deleted'?'Deleted member':'Account not onboarded')},email:row.email??null,status:row.status,roles:row.roles??[],createdAt:new Date(row.created_at).toISOString()};}
function toEditorial(row:Row){return {id:String(row.id),publicationId:String(row.publication_id),reason:row.reason,active:row.active,createdAt:new Date(row.active_from).toISOString()};}
function requireAdmin(roles:string[]){if(!roles.includes('admin'))throw new CommandError(403,'ADMIN_REQUIRED','Administrator access is required.');}
function requireStaff(roles:string[]){if(!roles.includes('admin')&&!roles.includes('moderator'))throw new CommandError(403,'STAFF_REQUIRED','Staff access is required.');}

async function insertAudit(tx:CommandTransaction,actor:string,resourceType:string,resourceId:string|null,action:string,reason:string,metadata:Record<string,unknown>={}){
  const id=randomUUID();
  await tx.query(`INSERT INTO audit_event(id,actor,resource_type,resource_id,action,reason,request_id,metadata,created_at)
    VALUES($1,$2,$3,$4,$5,$6,NULL,$7::jsonb,CURRENT_TIMESTAMP)`,[id,actor,resourceType,resourceId,action,reason,JSON.stringify(metadata)]);
  return {id,actorId:actor,action,resourceType,resourceId,reason,createdAt:new Date().toISOString()};
}

/** P13 staff workflows. Authorization is rechecked against persisted grants inside each command transaction. */
export class StaffService {
  constructor(private readonly pool:Pool){}

  // The controller supplies the authenticated moderator ID for scope. Kept separate from request filters.
  async reports(actorId:string,roles:string[],cursorInput:unknown,limitInput:unknown){
    requireStaff(roles);const limit=checkedLimit(limitInput),scope=`reports:${actorId}:${roles.includes('admin')?'all':'assigned'}`,after=decodeCursor(cursorInput,scope);
    const rows=await this.pool.query<Row>(`SELECT r.*,r.decision,to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_created_at,COALESCE((SELECT json_agg(json_build_object('id',a.id,'reason',a.reason,'status',a.status,'assignedReviewerUserId',a.assigned_reviewer_user_id,'viewerCanReview',COALESCE(a.assigned_reviewer_user_id=$2,false),'createdAt',to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY a.created_at,a.id) FROM appeal a WHERE a.report_id=r.id),'[]'::json) AS appeals
      ,(SELECT action FROM moderation_action m WHERE m.report_id=r.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) last_action,
      ${targetOwnerSql()},${targetProjectionSql()}
      FROM report r WHERE ($1::boolean OR r.assigned_reviewer_user_id=$2)
      AND ($3::timestamptz IS NULL OR (r.created_at,r.id)<($3::timestamptz,$4::uuid))
      ORDER BY r.created_at DESC,r.id DESC LIMIT $5`,[roles.includes('admin'),actorId,after?.createdAt??null,after?.id??null,limit+1]);
    return page(rows.rows.map(row=>toReport(row,actorId)),limit,scope,rows.rows);
  }

  async report(actorId:string,roles:string[],id:string){
    checkedId(id);requireStaff(roles);
    const row=await this.pool.query<Row>(`SELECT r.*,r.decision,COALESCE((SELECT json_agg(json_build_object('id',a.id,'reason',a.reason,'status',a.status,'assignedReviewerUserId',a.assigned_reviewer_user_id,'viewerCanReview',COALESCE(a.assigned_reviewer_user_id=$3,false),'createdAt',to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY a.created_at,a.id) FROM appeal a WHERE a.report_id=r.id),'[]'::json) appeals,
      (SELECT action FROM moderation_action m WHERE m.report_id=r.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) last_action,${targetOwnerSql()},
      ${targetProjectionSql()}
      FROM report r WHERE r.id=$1 AND ($2::boolean OR r.assigned_reviewer_user_id=$3)`,[id,roles.includes('admin'),actorId]);
    if(!row.rows[0])throw new CommandError(404,'REPORT_NOT_FOUND');return toReport(row.rows[0],actorId);
  }

  async listAppeals(actorId:string,roles:string[],cursorInput:unknown,limitInput:unknown){
    requireStaff(roles);const limit=checkedLimit(limitInput),scope=`appeals:${actorId}:${roles.includes('admin')?'all':'assigned'}`,after=decodeCursor(cursorInput,scope);
    const rows=await this.pool.query<Row>(`SELECT r.*,r.decision,a.id cursor_id,to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_created_at,
      json_build_object('id',a.id,'reason',a.reason,'status',a.status,'assignedReviewerUserId',a.assigned_reviewer_user_id,'viewerCanReview',COALESCE(a.assigned_reviewer_user_id=$2,false),'createdAt',to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) appeal
      ,(SELECT action FROM moderation_action m WHERE m.report_id=r.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) last_action,${targetOwnerSql()},${targetProjectionSql()}
      FROM appeal a JOIN report r ON r.id=a.report_id
      WHERE ($1::boolean OR a.assigned_reviewer_user_id=$2)
      AND ($3::timestamptz IS NULL OR (a.created_at,a.id)<($3::timestamptz,$4::uuid))
      ORDER BY a.created_at DESC,a.id DESC LIMIT $5`,[roles.includes('admin'),actorId,after?.createdAt??null,after?.id??null,limit+1]);
    return page(rows.rows.map(row=>({...toReport(row,actorId),appeals:[row.appeal]})),limit,scope,rows.rows);
  }

  async actReport(actorId:string,roles:string[],id:string,key:string,command:Command){
    checkedId(id);requireStaff(roles);const reason=checkedReason(command.reason);
    if(!['assign','hide','restore','resolve','dismiss'].includes(command.action))throw new CommandError(422,'INVALID_REPORT_ACTION');
    const reviewerId=command.reviewerUserId??actorId;if(command.action==='assign')checkedId(reviewerId);
    const result=await executeIdempotentCommand(this.pool,{actorUserId:actorId,operation:`staff-report:${id}`,idempotencyKey:key,input:command as unknown as Json},async tx=>{
      await this.assertRole(tx,actorId,'staff');
      if(roles.includes('admin'))await this.assertRole(tx,actorId,'admin');
      const q=await tx.query<Row>('SELECT * FROM report WHERE id=$1 FOR UPDATE',[id]);const report=q.rows[0];if(!report)throw new CommandError(404,'REPORT_NOT_FOUND');
      if(report.assigned_reviewer_user_id!==actorId&&command.action!=='assign')throw new CommandError(403,'REPORT_NOT_ASSIGNED');
      const owner=await this.resourceOwner(tx,report.resource_type,report.resource_id);
      if(command.action==='assign'){
        if(!['open','reviewing'].includes(report.status))throw new CommandError(409,'REPORT_CLOSED');
        if(reviewerId!==actorId){await this.assertRole(tx,actorId,'admin');}
        if(reviewerId===report.reporter_user_id||reviewerId===owner)throw new CommandError(403,'SELF_REVIEW_FORBIDDEN');
        await this.assertRole(tx,reviewerId,'staff');
        await tx.query("UPDATE report SET assigned_reviewer_user_id=$2,status=CASE WHEN status='open' THEN 'reviewing' ELSE status END WHERE id=$1",[id,reviewerId]);
      } else {
        if(report.assigned_reviewer_user_id!==actorId)throw new CommandError(403,'REVIEWER_REQUIRED');
        if(actorId===report.reporter_user_id||actorId===owner)throw new CommandError(403,'SELF_REVIEW_FORBIDDEN');
        if(command.action==='hide'||command.action==='restore'){
          await this.setResourceVisibility(tx,report.resource_type,report.resource_id,command.action==='hide');
          await tx.query('INSERT INTO moderation_action(id,report_id,reviewer_user_id,action,reason,created_at) VALUES($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)',[randomUUID(),id,actorId,command.action,reason]);
          await tx.query("UPDATE report SET status='resolved',decision=$2 WHERE id=$1",[id,reason]);
          if(owner)await enqueueTransactionalNotification(tx,{recipientUserId:owner,category:'moderation',sourceId:id,internalUrl:'/app/reports',text:command.action==='hide'?'A reported item you authored was hidden after review. You may appeal this decision.':'A moderation decision affecting your item was restored.'});
          if(report.reporter_user_id)await enqueueTransactionalNotification(tx,{recipientUserId:report.reporter_user_id,category:'moderation',sourceId:id,internalUrl:'/app/reports',text:command.action==='hide'?'Your report was reviewed and action was taken.':'Your report was reviewed and the item was restored.'});
        } else {
          await tx.query("UPDATE report SET status=$3,decision=$2 WHERE id=$1",[id,reason,command.action==='dismiss'?'closed':'resolved']);
          await tx.query('INSERT INTO moderation_action(id,report_id,reviewer_user_id,action,reason,created_at) VALUES($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)',[randomUUID(),id,actorId,command.action,reason]);
          if(report.reporter_user_id)await enqueueTransactionalNotification(tx,{recipientUserId:report.reporter_user_id,category:'moderation',sourceId:id,internalUrl:'/app/reports',text:command.action==='dismiss'?'Your report was dismissed after review.':'Your report was resolved without a content visibility change.'});
        }
      }
      const audit=await insertAudit(tx,actorId,'report',id,`report_${command.action}`,reason,{resourceType:report.resource_type,resourceId:report.resource_id,...(command.action==='assign'?{reviewerUserId:reviewerId}:{})});
      return {status:201,body:audit as unknown as Json,resourceId:id};
    });return result.body;
  }

  async actAppeal(actorId:string,roles:string[],id:string,key:string,command:Command){
    checkedId(id);requireStaff(roles);const reason=checkedReason(command.reason);
    if(!['assign','resolve'].includes(command.action))throw new CommandError(422,'INVALID_APPEAL_ACTION');
    const reviewerId=command.reviewerUserId??actorId;if(command.action==='assign')checkedId(reviewerId);
    const result=await executeIdempotentCommand(this.pool,{actorUserId:actorId,operation:`staff-appeal:${id}`,idempotencyKey:key,input:command as unknown as Json},async tx=>{
      await this.assertRole(tx,actorId,'staff');
      if(roles.includes('admin'))await this.assertRole(tx,actorId,'admin');
      const found=await tx.query<Row>('SELECT a.*,r.reporter_user_id,r.resource_type,r.resource_id,r.assigned_reviewer_user_id report_reviewer FROM appeal a JOIN report r ON r.id=a.report_id WHERE a.id=$1 FOR UPDATE OF a,r',[id]);
      const appeal=found.rows[0];if(!appeal)throw new CommandError(404,'APPEAL_NOT_FOUND');
      const owner=await this.resourceOwner(tx,appeal.resource_type,appeal.resource_id);
      if(command.action==='assign'){
        if(appeal.status==='resolved')throw new CommandError(409,'APPEAL_ALREADY_RESOLVED');
        if(reviewerId!==actorId)await this.assertRole(tx,actorId,'admin');
        if(reviewerId===appeal.appellant_user_id||reviewerId===appeal.reporter_user_id||reviewerId===owner||reviewerId===appeal.report_reviewer)throw new CommandError(403,'INDEPENDENT_REVIEW_REQUIRED');
        await this.assertRole(tx,reviewerId,'staff');
        await tx.query("UPDATE appeal SET assigned_reviewer_user_id=$2,status='reviewing' WHERE id=$1 AND status<>'resolved'",[id,reviewerId]);
      }else{
        if(appeal.status==='resolved')throw new CommandError(409,'APPEAL_ALREADY_RESOLVED');
        if(appeal.assigned_reviewer_user_id!==actorId)throw new CommandError(403,'APPEAL_NOT_ASSIGNED');
        if(actorId===appeal.appellant_user_id||actorId===appeal.reporter_user_id||actorId===owner||actorId===appeal.report_reviewer)throw new CommandError(403,'INDEPENDENT_REVIEW_REQUIRED');
        if(command.outcome!=='uphold'&&command.outcome!=='overturn')throw new CommandError(422,'APPEAL_OUTCOME_REQUIRED');
        if(command.outcome==='overturn'){
          await this.setResourceVisibility(tx,appeal.resource_type,appeal.resource_id,false);
          await tx.query('INSERT INTO moderation_action(id,report_id,reviewer_user_id,action,reason,created_at) VALUES($1,$2,$3,\'appeal_restore\',$4,CURRENT_TIMESTAMP)',[randomUUID(),appeal.report_id,actorId,reason]);
        }
        await tx.query("UPDATE appeal SET status='resolved',review_reason=$2,reviewer_user_id=$3 WHERE id=$1",[id,reason,actorId]);
        await tx.query("UPDATE report SET status='resolved',decision=$2 WHERE id=$1",[appeal.report_id,command.outcome==='overturn'?reason:'The original moderation decision was upheld after independent review.']);
        if(appeal.appellant_user_id)await enqueueTransactionalNotification(tx,{recipientUserId:appeal.appellant_user_id,category:'moderation',sourceId:appeal.report_id,internalUrl:'/app/reports',text:'Your moderation appeal has been reviewed.'});
        if(owner&&owner!==appeal.appellant_user_id)await enqueueTransactionalNotification(tx,{recipientUserId:owner,category:'moderation',sourceId:appeal.report_id,internalUrl:'/app/reports',text:command.outcome==='overturn'?'Your appeal was accepted and the item was restored.':'Your appeal was reviewed and the moderation decision was upheld.'});
      }
      const audit=await insertAudit(tx,actorId,'appeal',id,`appeal_${command.action}`,reason,{reportId:appeal.report_id,...(command.action==='assign'?{reviewerUserId:reviewerId}:command.outcome?{outcome:command.outcome}:{})});
      return {status:201,body:audit as unknown as Json,resourceId:id};
    });return result.body;
  }

  async users(roles:string[],cursorInput:unknown,limitInput:unknown,qInput:unknown){
    requireAdmin(roles);const limit=checkedLimit(limitInput),q=qInput===undefined?'':String(qInput).trim();if(q.length>200)throw new CommandError(400,'INVALID_QUERY');const scope=`users:${q.toLowerCase()}`,after=decodeCursor(cursorInput,scope);
    const rows=await this.pool.query<Row>(`SELECT u.id,u.email,u.status,u.created_at,p.handle,p.display_name,to_char(u.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_created_at,
      COALESCE(array_agg(r.role) FILTER(WHERE r.role IS NOT NULL),'{}') roles
      FROM user_account u LEFT JOIN profile p ON p.user_id=u.id LEFT JOIN role_grant r ON r.user_id=u.id
      WHERE ($1='' OR u.email ILIKE '%'||$1||'%' OR p.handle ILIKE '%'||$1||'%' OR p.display_name ILIKE '%'||$1||'%')
      AND ($2::timestamptz IS NULL OR (u.created_at,u.id)<($2::timestamptz,$3::uuid))
      GROUP BY u.id,p.handle,p.display_name ORDER BY u.created_at DESC,u.id DESC LIMIT $4`,[q,after?.createdAt??null,after?.id??null,limit+1]);
    return page(rows.rows.map(toUser),limit,scope,rows.rows);
  }

  async actUser(actorId:string,roles:string[],id:string,key:string,command:Command){
    checkedId(id);requireAdmin(roles);const reason=checkedReason(command.reason);
    if(!['suspend','unsuspend','change_role','revoke_sessions'].includes(command.action))throw new CommandError(422,'INVALID_USER_ACTION');
    if(command.action==='change_role'&&!['member','moderator','admin'].includes(command.role??''))throw new CommandError(422,'INVALID_ROLE');
    const result=await executeIdempotentCommand(this.pool,{actorUserId:actorId,operation:`staff-user:${id}`,idempotencyKey:key,input:command as unknown as Json},async tx=>{
      await this.assertRole(tx,actorId,'admin');
      const target=await tx.query<Row>('SELECT id,status FROM user_account WHERE id=$1 FOR UPDATE',[id]);if(!target.rows[0])throw new CommandError(404,'USER_NOT_FOUND');
      if(command.action==='suspend'&&target.rows[0].status!=='suspended'){
        const role=await tx.query("SELECT 1 FROM role_grant WHERE user_id=$1 AND role='admin'",[id]);
        if(role.rowCount){await tx.query("SELECT id FROM user_account WHERE status='active' FOR UPDATE");const count=await tx.query("SELECT count(*)::int n FROM role_grant r JOIN user_account u ON u.id=r.user_id WHERE r.role='admin' AND u.status='active'");if(Number(count.rows[0]?.n)<=1)throw new CommandError(409,'LAST_ADMIN_PROTECTED');}
        await tx.query("UPDATE user_account SET status='suspended',updated_at=CURRENT_TIMESTAMP WHERE id=$1",[id]);
        await tx.query('UPDATE app_session SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND revoked_at IS NULL',[id]);
      } else if(command.action==='unsuspend'){
        if(target.rows[0].status!=='suspended')throw new CommandError(409,'USER_NOT_SUSPENDED');
        await tx.query("UPDATE user_account SET status='active',updated_at=CURRENT_TIMESTAMP WHERE id=$1",[id]);
      } else if(command.action==='change_role'){
        const role=command.role!;
        if(role!=='admin'){
          const current=await tx.query("SELECT 1 FROM role_grant WHERE user_id=$1 AND role='admin'",[id]);
          if(current.rowCount&&target.rows[0].status==='active'){await tx.query("SELECT id FROM user_account WHERE status='active' FOR UPDATE");const count=await tx.query("SELECT count(*)::int n FROM role_grant r JOIN user_account u ON u.id=r.user_id WHERE r.role='admin' AND u.status='active'");if(Number(count.rows[0]?.n)<=1)throw new CommandError(409,'LAST_ADMIN_PROTECTED');}
        }
        if(role==='member'){
          await tx.query("DELETE FROM role_grant WHERE user_id=$1 AND role IN ('admin','moderator')",[id]);
        }else{
          if(role==='moderator')await tx.query("DELETE FROM role_grant WHERE user_id=$1 AND role='admin'",[id]);
          if(role==='admin')await tx.query("DELETE FROM role_grant WHERE user_id=$1 AND role='moderator'",[id]);
          await tx.query(`INSERT INTO role_grant(id,user_id,role,grantor_user_id,reason,granted_at) VALUES($1,$2,$3,$4,$5,CURRENT_TIMESTAMP) ON CONFLICT(user_id,role) DO UPDATE SET grantor_user_id=EXCLUDED.grantor_user_id,reason=EXCLUDED.reason,granted_at=CURRENT_TIMESTAMP`,[randomUUID(),id,role,actorId,reason]);
        }
        await tx.query('UPDATE app_session SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND revoked_at IS NULL',[id]);
      } else if(command.action==='revoke_sessions'){
        await tx.query('UPDATE app_session SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND revoked_at IS NULL',[id]);
      } else throw new CommandError(422,'INVALID_USER_ACTION');
      const audit=await insertAudit(tx,actorId,'user',id,`user_${command.action}`,reason,command.role?{role:command.role}:{});
      return {status:201,body:audit as unknown as Json,resourceId:id};
    });return result.body;
  }

  async editorial(roles:string[],cursorInput:unknown,limitInput:unknown,qInput:unknown){
    requireAdmin(roles);const limit=checkedLimit(limitInput),q=qInput===undefined?'':String(qInput).trim();if(q.length>200)throw new CommandError(400,'INVALID_QUERY');const scope=`editorial:${q.toLowerCase()}`,after=decodeCursor(cursorInput,scope);
    const rows=await this.pool.query<Row>(`SELECT e.*,to_char(e.active_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_created_at,(e.active_until IS NULL OR e.active_until>CURRENT_TIMESTAMP) active FROM editorial_selection e
      JOIN publication p ON p.id=e.publication_id JOIN publication_version v ON v.id=p.current_version_id
      WHERE ($1='' OR p.id::text ILIKE '%'||$1||'%' OR v.terms->>'title' ILIKE '%'||$1||'%')
      AND ($2::timestamptz IS NULL OR (e.active_from,e.id)<($2::timestamptz,$3::uuid))
      ORDER BY e.active_from DESC,e.id DESC LIMIT $4`,[q,after?.createdAt??null,after?.id??null,limit+1]);return page(rows.rows.map(toEditorial),limit,scope,rows.rows);
  }

  async actEditorial(actorId:string,roles:string[],id:string,key:string,command:Command){
    checkedId(id);requireAdmin(roles);const reason=checkedReason(command.reason);if(!['select','deselect'].includes(command.action))throw new CommandError(422,'INVALID_EDITORIAL_ACTION');
    const result=await executeIdempotentCommand(this.pool,{actorUserId:actorId,operation:`staff-editorial:${id}`,idempotencyKey:key,input:command as unknown as Json},async tx=>{
      await this.assertRole(tx,actorId,'admin');
      if(command.action==='select'){
        const selection=await tx.query<Row>('SELECT * FROM editorial_selection WHERE publication_id=$1 ORDER BY active_from DESC LIMIT 1 FOR UPDATE',[id]);
        if(!selection.rows[0]){
          const publication=await tx.query("SELECT id FROM publication WHERE id=$1 AND visibility='public' AND published_at IS NOT NULL FOR SHARE",[id]);if(!publication.rowCount)throw new CommandError(404,'PUBLICATION_NOT_FOUND');
          await tx.query('INSERT INTO editorial_selection(id,publication_id,selector_user_id,reason,active_from,active_until) VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP,NULL)',[randomUUID(),id,actorId,reason]);
        }else if(selection.rows[0].active_until!==null)await tx.query('UPDATE editorial_selection SET selector_user_id=$2,reason=$3,active_from=CURRENT_TIMESTAMP,active_until=NULL WHERE id=$1',[selection.rows[0].id,actorId,reason]);
        else throw new CommandError(409,'ALREADY_SELECTED');
      }else{
        const selection=await tx.query<Row>('SELECT * FROM editorial_selection WHERE publication_id=$1 AND active_until IS NULL ORDER BY active_from DESC LIMIT 1 FOR UPDATE',[id]);
        if(!selection.rows[0])throw new CommandError(404,'EDITORIAL_SELECTION_NOT_FOUND');
        await tx.query('UPDATE editorial_selection SET active_until=CURRENT_TIMESTAMP WHERE id=$1',[selection.rows[0].id]);
      }
      const audit=await insertAudit(tx,actorId,'editorial_selection',id,`editorial_${command.action}`,reason,{publicationId:id});
      return {status:201,body:audit as unknown as Json,resourceId:id};
    });return result.body;
  }

  async audit(actorId:string,roles:string[],cursorInput:unknown,limitInput:unknown,qInput:unknown){
    requireStaff(roles);const limit=checkedLimit(limitInput),q=qInput===undefined?'':String(qInput).trim();if(q.length>200)throw new CommandError(400,'INVALID_QUERY');const scope=`audit:${actorId}:${roles.includes('admin')?'admin':'moderator'}:${q.toLowerCase()}`,after=decodeCursor(cursorInput,scope);
    const rows=await this.pool.query<Row>(`SELECT id,actor,resource_type,resource_id,action,reason,created_at,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_created_at FROM audit_event
      WHERE ($1::boolean OR ((resource_type='report' AND resource_id IN (SELECT id FROM report WHERE assigned_reviewer_user_id=$2)) OR (resource_type='appeal' AND resource_id IN (SELECT id FROM appeal WHERE assigned_reviewer_user_id=$2))))
      AND actor ~* '^[0-9a-f-]{36}$'
      AND ($3='' OR action ILIKE '%'||$3||'%' OR resource_type ILIKE '%'||$3||'%' OR actor ILIKE '%'||$3||'%' OR COALESCE(resource_id::text,'') ILIKE '%'||$3||'%' OR COALESCE(reason,'') ILIKE '%'||$3||'%')
      AND ($4::timestamptz IS NULL OR (created_at,id)<($4::timestamptz,$5::uuid)) ORDER BY created_at DESC,id DESC LIMIT $6`,[roles.includes('admin'),actorId,q,after?.createdAt??null,after?.id??null,limit+1]);return page(rows.rows.map(toAudit),limit,scope,rows.rows);
  }

  async exportAudit(roles:string[],limitInput:unknown=5000,qInput:unknown){
    requireAdmin(roles);const limit=Number(limitInput);if(!Number.isInteger(limit)||limit<1||limit>5000)throw new CommandError(400,'INVALID_LIMIT');
    const q=qInput===undefined?'':String(qInput).trim();if(q.length>200)throw new CommandError(400,'INVALID_QUERY');
    const rows=await this.pool.query<Row>(`SELECT id,actor,resource_type,resource_id,action,reason,created_at FROM audit_event
      WHERE actor ~* '^[0-9a-f-]{36}$' AND ($1='' OR action ILIKE '%'||$1||'%' OR resource_type ILIKE '%'||$1||'%' OR actor ILIKE '%'||$1||'%' OR COALESCE(resource_id::text,'') ILIKE '%'||$1||'%' OR COALESCE(reason,'') ILIKE '%'||$1||'%')
      ORDER BY created_at DESC,id DESC LIMIT $2`,[q,limit]);
    const quote=(v:unknown)=>{let value=String(v??'').replace(/[\r\n]+/g,' ');if(/^[=+\-@]/.test(value))value=`'${value}`;return `"${value.replaceAll('"','""')}"`;};
    return ['id,actorId,resourceType,resourceId,action,reason,createdAt',...rows.rows.map(row=>[row.id,row.actor,row.resource_type,row.resource_id,row.action,row.reason,new Date(row.created_at).toISOString()].map(quote).join(','))].join('\r\n');
  }

  async overview(actorId:string,roles:string[]){
    requireStaff(roles);const result=await this.pool.query<Row>(`SELECT
      (SELECT count(*)::int FROM report WHERE status IN ('open','reviewing') AND ($1::boolean OR assigned_reviewer_user_id=$2)) open_reports,
      (SELECT count(*)::int FROM appeal WHERE status IN ('open','reviewing') AND ($1::boolean OR assigned_reviewer_user_id=$2)) open_appeals,
      CASE WHEN $1::boolean THEN (SELECT count(*)::int FROM correction_request WHERE status='requested') ELSE 0 END pending_corrections,
      CASE WHEN $1::boolean THEN (SELECT count(*)::int FROM outbox_event WHERE status='failed') ELSE 0 END failed_jobs,
      CASE WHEN $1::boolean THEN (SELECT count(*)::int FROM support_ticket WHERE status IN ('open','in_progress')) ELSE 0 END open_support`,[roles.includes('admin'),actorId]);
    const row=result.rows[0]??{};return {openReports:Number(row.open_reports??0),openAppeals:Number(row.open_appeals??0),pendingCorrections:Number(row.pending_corrections??0),failedJobs:Number(row.failed_jobs??0),openSupport:Number(row.open_support??0)};
  }

  private async assertRole(tx:CommandTransaction,userId:string,role:'admin'|'staff'){
    const result=role==='admin'?await tx.query("SELECT 1 FROM role_grant r JOIN user_account u ON u.id=r.user_id AND u.status='active' WHERE r.user_id=$1 AND r.role='admin'",[userId]):await tx.query("SELECT 1 FROM role_grant r JOIN user_account u ON u.id=r.user_id AND u.status='active' WHERE r.user_id=$1 AND r.role IN ('admin','moderator')",[userId]);if(!result.rowCount)throw new CommandError(403,role==='admin'?'ADMIN_REQUIRED':'STAFF_REQUIRED');
  }
  private async resourceOwner(tx:CommandTransaction,type:string,id:string):Promise<string|null>{
    const sql=type==='publication'?'SELECT author_user_id id FROM publication WHERE id=$1':type==='comment'?'SELECT author_user_id id FROM comment WHERE id=$1':type==='repost'?'SELECT user_id id FROM repost WHERE id=$1':type==='profile'?'SELECT user_id id FROM profile WHERE user_id=$1':'SELECT id FROM user_account WHERE id=$1';
    const r=await tx.query<Row>(sql,[id]);return r.rows[0]?String(r.rows[0].id):null;
  }
  private async setResourceVisibility(tx:CommandTransaction,type:string,id:string,hidden:boolean){
    const sql=type==='publication'?(hidden?"UPDATE publication SET visibility='moderation_hidden' WHERE id=$1 AND visibility='public'":"UPDATE publication SET visibility='public' WHERE id=$1 AND visibility='moderation_hidden'"):
      type==='comment'?(hidden?'UPDATE comment SET hidden_at=CURRENT_TIMESTAMP WHERE id=$1 AND deleted_at IS NULL AND hidden_at IS NULL':'UPDATE comment SET hidden_at=NULL WHERE id=$1 AND deleted_at IS NULL AND hidden_at IS NOT NULL'):
      type==='repost'?(hidden?'UPDATE repost SET hidden_at=CURRENT_TIMESTAMP WHERE id=$1 AND active AND hidden_at IS NULL':'UPDATE repost SET hidden_at=NULL WHERE id=$1 AND active AND hidden_at IS NOT NULL'):
      (hidden?'UPDATE profile SET moderation_hidden_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND moderation_hidden_at IS NULL':'UPDATE profile SET moderation_hidden_at=NULL WHERE user_id=$1 AND moderation_hidden_at IS NOT NULL');
    if(!['publication','comment','repost','profile','user'].includes(type))throw new CommandError(422,'INVALID_REPORT_RESOURCE');
    const result=await tx.query(sql,[id]);if(!result.rowCount)throw new CommandError(409,hidden?'RESOURCE_NOT_PUBLIC':'RESOURCE_NOT_HIDDEN');
  }
}

function targetProjectionSql(){return `CASE r.resource_type
  WHEN 'publication' THEN (SELECT json_build_object('type','publication','id',r.resource_id,'text',left(COALESCE(v.terms->>'title','')||' '||COALESCE(v.thesis,''),2000),'authorUserId',p.author_user_id) FROM publication p JOIN publication_version v ON v.id=p.current_version_id WHERE p.id=r.resource_id)
  WHEN 'comment' THEN (SELECT json_build_object('type','comment','id',r.resource_id,'text',left(c.body,2000),'authorUserId',c.author_user_id) FROM comment c WHERE c.id=r.resource_id)
  WHEN 'repost' THEN (SELECT json_build_object('type','repost','id',r.resource_id,'text',left(COALESCE(x.commentary,''),2000),'authorUserId',x.user_id) FROM repost x WHERE x.id=r.resource_id)
  ELSE (SELECT json_build_object('type','profile','id',r.resource_id,'text',left(pr.display_name,2000),'authorUserId',pr.user_id) FROM profile pr WHERE pr.user_id=r.resource_id)
END AS target`;}

function targetOwnerSql(){return `CASE r.resource_type
  WHEN 'publication' THEN (SELECT author_user_id FROM publication WHERE id=r.resource_id)
  WHEN 'comment' THEN (SELECT author_user_id FROM comment WHERE id=r.resource_id)
  WHEN 'repost' THEN (SELECT user_id FROM repost WHERE id=r.resource_id)
  WHEN 'profile' THEN r.resource_id
  ELSE (SELECT id FROM user_account WHERE id=r.resource_id)
END AS target_author_id`;}
