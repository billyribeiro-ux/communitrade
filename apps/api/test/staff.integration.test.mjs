import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { StaffService } from '../dist/staff/service.js';
import { CommunityService } from '../dist/community/service.js';
import { ProfileService } from '../dist/profiles/service.js';
import { PublicationService } from '../dist/publications/service.js';
import { cleanupP08Fixtures } from '../scripts/p08-fixture-cleanup.mjs';

const databaseUrl=process.env.TEST_DATABASE_URL;
test('P13 PostgreSQL moderation, independent appeal, user controls, editorial actions and audit scope',{skip:databaseUrl?false:'Requires TEST_DATABASE_URL for PostgreSQL staff acceptance.'},async()=>{
 const pool=new pg.Pool({connectionString:databaseUrl,max:8,connectionTimeoutMillis:3000,query_timeout:15000});pool.on('error',()=>{});
 const ids=Array.from({length:5},()=>randomUUID()),[reporter,author,admin,moderator,appealReviewer]=ids;
 const suffix=randomUUID().replaceAll('-','').slice(0,12),issuer=`https://p12.core.${suffix}.invalid`,publicationId=randomUUID(),versionId=randomUUID(),reportId=randomUUID();
 let sessionId;
 try{
  for(const id of ids){const index=ids.indexOf(id);await pool.query(`INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,onboarding_version,created_at,updated_at)
    VALUES($1,$2,$4,$3,true,'active','p13-integration',now(),now())`,[id,issuer,`${id}@example.invalid`,id]);
    const handle=`p13_${suffix}_${index}`;await pool.query('INSERT INTO profile(user_id,handle,normalized_handle,display_name,revision,created_at,updated_at) VALUES($1,$2,$2,$3,1,now(),now())',[id,handle,`P13 ${handle}`]);}
  await pool.query("INSERT INTO role_grant(id,user_id,role,grantor_user_id,reason,granted_at) VALUES($1,$2,'admin',$2,'P13 fixture',now())",[randomUUID(),admin]);
  await pool.query("INSERT INTO role_grant(id,user_id,role,grantor_user_id,reason,granted_at) VALUES($1,$2,'moderator',$3,'P13 fixture',now()),($4,$5,'moderator',$3,'P13 fixture',now())",[randomUUID(),moderator,admin,randomUUID(),appealReviewer]);
  await pool.query("INSERT INTO publication(id,author_user_id,kind,visibility,published_at,created_at) VALUES($1,$2,'education','public',now(),now())",[publicationId,author]);
  await pool.query("INSERT INTO publication_version(id,publication_id,sequence,terms,thesis,chart,disclosures,created_at) VALUES($1,$2,1,'{\"title\":\"P13 synthetic report target\"}','Fixture content','{}','{}',now())",[versionId,publicationId]);
  await pool.query('UPDATE publication SET original_version_id=$2,current_version_id=$2 WHERE id=$1',[publicationId,versionId]);
  await pool.query("INSERT INTO report(id,reporter_user_id,resource_type,resource_id,reason,detail,status,created_at) VALUES($1,$2,'publication',$3,'spam','P13 fixture report','open',now())",[reportId,reporter,publicationId]);
  const staff=new StaffService(pool),community=new CommunityService(pool,{});
  assert.equal((await staff.reports(moderator,['member','moderator'],undefined,20)).items.length,0,'moderators only see assigned reports');
  const moderatorOverview=await staff.overview(moderator,['member','moderator']);assert.equal(moderatorOverview.pendingCorrections,0);assert.equal(moderatorOverview.failedJobs,0);assert.equal(moderatorOverview.openSupport,0,'moderator overview does not reveal unrelated operational queues');
  await staff.actReport(admin,['member','admin'],reportId,randomUUID(),{action:'assign',reason:'Assign to first reviewer',reviewerUserId:moderator});
  assert.equal((await staff.reports(moderator,['member','moderator'],undefined,20)).items[0].id,reportId);
  await assert.rejects(staff.actReport(appealReviewer,['member','moderator'],reportId,randomUUID(),{action:'hide',reason:'Unassigned reviewer'}),{code:'REPORT_NOT_ASSIGNED'});
  await assert.rejects(staff.actReport(author,['member'],reportId,randomUUID(),{action:'hide',reason:'Author cannot review'}),{code:'STAFF_REQUIRED'});
  await staff.actReport(moderator,['member','moderator'],reportId,randomUUID(),{action:'hide',reason:'Hide confirmed public abuse'});
  assert.equal((await pool.query('SELECT visibility FROM publication WHERE id=$1',[publicationId])).rows[0].visibility,'moderation_hidden');
  const ownerNotice=await community.getOwnReport(author,reportId);assert.equal(ownerNotice.caseKind,'moderation_notice');assert.equal(ownerNotice.reason,'moderation_decision');assert.equal(ownerNotice.viewerCanAppeal,true);
  assert.equal((await community.getOwnReport(reporter,reportId)).caseKind,'report');
  const ownPage=await community.listOwnReports(reporter,undefined,20);assert.equal(ownPage.items[0].id,reportId);assert.equal(ownPage.items[0].viewerCanAppeal,false);
  const appeal=await community.appealReport(author,reportId,randomUUID(),'The content is educational context.');assert.equal(appeal.status,'open');
  assert.equal((await community.getOwnReport(reporter,reportId)).appeals[0].reason,undefined,'reporter sees appeal status without the affected author’s private argument');
  assert.equal((await community.getOwnReport(author,reportId)).appeals[0].reason,'The content is educational context.');
  assert.equal((await community.getOwnReport(author,reportId)).viewerCanAppeal,false);
  await staff.actAppeal(admin,['member','admin'],appeal.id,randomUUID(),{action:'assign',reason:'Assign independent reviewer',reviewerUserId:appealReviewer});
  await assert.rejects(staff.actAppeal(moderator,['member','moderator'],appeal.id,randomUUID(),{action:'resolve',reason:'Same reviewer',outcome:'uphold'}),{code:'APPEAL_NOT_ASSIGNED'});
  await staff.actAppeal(appealReviewer,['member','moderator'],appeal.id,randomUUID(),{action:'resolve',reason:'Independent evidence review',outcome:'overturn'});
  assert.equal((await pool.query('SELECT visibility FROM publication WHERE id=$1',[publicationId])).rows[0].visibility,'public');
  const restoredNotice=await community.getOwnReport(author,reportId);assert.equal(restoredNotice.decision,'The item was restored after independent appeal review.');assert.equal(restoredNotice.viewerCanAppeal,false);
  await staff.actEditorial(admin,['member','admin'],publicationId,randomUUID(),{action:'select',reason:'=not a formula'});
  assert.equal((await staff.editorial(['admin'],undefined,20,'P13 synthetic')).items[0].active,true);
  await staff.actEditorial(admin,['member','admin'],publicationId,randomUUID(),{action:'deselect',reason:'No longer current'});
  assert.equal((await staff.editorial(['admin'],undefined,20,'P13 synthetic')).items[0].active,false);
  const profileReportId=randomUUID();await pool.query("INSERT INTO report(id,reporter_user_id,resource_type,resource_id,reason,detail,status,created_at) VALUES($1,$2,'profile',$3,'harassment','P13 profile report','open',now())",[profileReportId,reporter,author]);
  await staff.actReport(admin,['member','admin'],profileReportId,randomUUID(),{action:'assign',reason:'Assign profile review',reviewerUserId:moderator});
  await staff.actReport(moderator,['member','moderator'],profileReportId,randomUUID(),{action:'hide',reason:'Hide profile after review'});
  const handle=`p13_${suffix}_1`;assert.equal((await pool.query('SELECT moderation_hidden_at FROM profile WHERE user_id=$1',[author])).rows[0].moderation_hidden_at!==null,true);
  await assert.rejects(new ProfileService(pool).getPublic(handle),{code:'PROFILE_NOT_FOUND'});
  await assert.rejects(new PublicationService(pool,{}).getPublication(publicationId),{code:'PUBLICATION_NOT_FOUND'});
  await assert.rejects(community.getRelationship(undefined,handle),{code:'PROFILE_NOT_FOUND'});
  await pool.query('UPDATE report SET reporter_user_id=NULL WHERE id=$1',[profileReportId]);
  await staff.actReport(moderator,['member','moderator'],profileReportId,randomUUID(),{action:'restore',reason:'Restore profile after follow-up review'});
  assert.equal((await new ProfileService(pool).getPublic(handle)).profile.user.id,author);
  const activeAdmins=Number((await pool.query("SELECT count(*)::int n FROM role_grant r JOIN user_account u ON u.id=r.user_id WHERE r.role='admin' AND u.status='active'")).rows[0].n);
  if(activeAdmins===1){
   await assert.rejects(staff.actUser(admin,['member','admin'],admin,randomUUID(),{action:'suspend',reason:'Last admin guard'}),{code:'LAST_ADMIN_PROTECTED'});
   await assert.rejects(staff.actUser(admin,['member','admin'],admin,randomUUID(),{action:'change_role',role:'moderator',reason:'Last admin role guard'}),{code:'LAST_ADMIN_PROTECTED'});
  }
  sessionId=randomUUID();await pool.query(`INSERT INTO app_session(id,token_hash,user_id,issued_at,last_seen_at,expires_at)
    VALUES($1,$3,$2,now(),now(),now()+interval '1 hour')`,[sessionId,reporter,`${sessionId}-token`]);
  await staff.actUser(admin,['member','admin'],reporter,randomUUID(),{action:'suspend',reason:'Repeat abusive submissions'});
  assert.ok((await pool.query('SELECT revoked_at FROM app_session WHERE id=$1',[sessionId])).rows[0].revoked_at,'suspend revokes sessions atomically');
  const secondSession=randomUUID();await pool.query(`INSERT INTO app_session(id,token_hash,user_id,issued_at,last_seen_at,expires_at) VALUES($1,$3,$2,now(),now(),now()+interval '1 hour')`,[secondSession,author,`${secondSession}-token`]);
  await staff.actUser(admin,['member','admin'],author,randomUUID(),{action:'revoke_sessions',reason:'Member requested session termination'});
  assert.ok((await pool.query('SELECT revoked_at FROM app_session WHERE id=$1',[secondSession])).rows[0].revoked_at,'explicit revocation ends sessions without changing account status');
  const modAudit=await staff.audit(moderator,['member','moderator'],undefined,50);assert.ok(modAudit.items.length>=2);assert.ok(modAudit.items.every(x=>['report','appeal','publication','comment','repost','profile'].includes(x.resourceType)));
  const csv=await staff.exportAudit(['member','admin'],5000);assert.match(csv,/"'=not a formula"/);
 }finally{
  await cleanupP08Fixtures(pool,ids);
  await pool.end();
 }
});
