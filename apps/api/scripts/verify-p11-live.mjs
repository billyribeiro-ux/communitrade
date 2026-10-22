import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {access} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {AuthService,authConfigFromEnv} from '../dist/auth/service.js';
import {FilesystemStorage} from '@trading/media';
import {cleanupP08Fixtures} from './p08-fixture-cleanup.mjs';

if(process.env.RELEASE_MODE!=='local'||process.env.NODE_ENV==='production'||(process.env.MARKET_DATA_PROVIDER??'synthetic')!=='synthetic')throw new Error('P11 live acceptance requires local synthetic mode.');
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:5,connectionTimeoutMillis:5000});
const auth=new AuthService(pool,authConfigFromEnv()),storage=new FilesystemStorage(process.env.LOCAL_OBJECTS_PATH??'/var/lib/options-trade-ideas/objects'),users=[],mailpitIds=new Set();
const stockId='00000000-0000-4000-8000-000000000201',optionId='00000000-0000-4000-8000-000000000221';
const nonce=randomUUID().replaceAll('-',''),privateSentinel=`P11PRIVATE${nonce}`;
let stage='setup';
const key=()=>randomUUID(),stamp=value=>new Date(value).toISOString();
function write(actor,extra={}){return {Origin:auth.config.appOrigin,'X-CSRF-Token':actor.csrfToken,...extra};}
async function request(path,actor,init={},expected=200){
 const headers=new Headers(init.headers);if(actor)headers.set('Cookie',`${auth.config.cookieName}=${actor.token}`);if(init.body!==undefined)headers.set('Content-Type','application/json');
 const response=await fetch(`http://web:3000${path}`,{...init,headers,redirect:'manual',signal:AbortSignal.timeout(30000)}),text=await response.text();
 if(response.status!==expected){let code='UNKNOWN',fields='';try{const parsed=JSON.parse(text);if(/^[A-Z_]{1,100}$/.test(parsed.code))code=parsed.code;const safe=(parsed.errors??[]).map(item=>`${String(item.path??'').replace(/[^A-Za-z0-9_.-]/g,'').slice(0,80)}:${String(item.message??'').replace(/[^A-Za-z ]/g,'').slice(0,80)}`).filter(Boolean).slice(0,5);if(safe.length)fields=` fields=${safe.join(',')}`;}catch{}console.error(`HTTP ${init.method??'GET'} ${path.split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi,':id')} ${response.status} ${code}${fields}`);}
 assert.equal(response.status,expected,`P11 ${stage}: HTTP status mismatch`);return {response,text,data:response.headers.get('content-type')?.includes('json')&&text?JSON.parse(text):null};
}
async function persona(label){
 const suffix=randomUUID(),subject=`p11-live-${suffix}`,email=`p11-${suffix}@example.invalid`;
 const session=await auth.createSession({issuer:auth.config.issuer,subject,email,emailVerified:true,sid:subject,assurance:'1',authTime:Math.floor(Date.now()/1000)},undefined,false);
 const row=(await pool.query('SELECT id FROM user_account WHERE oidc_issuer=$1 AND oidc_subject=$2',[auth.config.issuer,subject])).rows[0];assert.ok(row?.id);users.push(row.id);
 await pool.query('UPDATE user_account SET synthetic=true WHERE id=$1',[row.id]);
 await request('/api/v1/me/onboarding',session,{method:'POST',headers:write(session),body:JSON.stringify({handle:`p11_${suffix.replaceAll('-','').slice(0,16)}`,displayName:`P11 ${label}`,experience:'experienced',interests:['stock','option','future'],timezone:'America/New_York',termsVersion:auth.config.termsVersion,adultUSDeclaration:true})},201);
 return {...session,id:row.id,subject,email,handle:`p11_${suffix.replaceAll('-','').slice(0,16)}`};
}
async function json(path,actor,init={},expected=200){return (await request(path,actor,init,expected)).data;}
async function publish(owner){
 const created=await json('/api/v1/drafts',owner,{method:'POST',headers:write(owner,{'Idempotency-Key':key()}),body:JSON.stringify({kind:'trade',asset:'option'})},201);
 const plan={asset:'option',strategy:'long_call',instrumentId:stockId,legs:[{instrumentId:optionId,side:'buy',quantity:1}],quantity:1,entryPrice:'2.50',priceKind:'option_premium',entryFrom:stamp(Date.now()-60000),entryUntil:stamp(Date.now()+3600000),entryCondition:'Synthetic acceptance reference confirmation.',timeframe:'swing',exitRules:'Report actual exits and costs.',conflicts:'Synthetic local acceptance only.'};
 await json(`/api/v1/drafts/${created.id}`,owner,{method:'PATCH',headers:write(owner,{'If-Match':`"${created.revision}"`}),body:JSON.stringify({title:`P11 synthetic idea ${nonce}`,thesis:'A synthetic option scenario for local notification acceptance.',plan})});
 const bars=await json(`/api/v1/instruments/${stockId}/bars?${new URLSearchParams({interval:'1d',from:stamp(Date.now()-60*86400000),to:stamp(Date.now()),session:'regular',limit:'10000'})}`,owner);
 const state={schemaVersion:1,instrumentId:stockId,metadataVersion:bars.meta.metadataVersion,interval:'1d',timezone:'America/New_York',session:'regular',adjustment:'unadjusted',viewport:{from:bars.bars[0].time,to:stamp(Date.parse(bars.bars.at(-1).time)+86400000)},indicators:[],provenance:{provider:bars.meta.provider,asOf:bars.meta.asOf,delaySeconds:bars.meta.delaySeconds,demo:bars.meta.demo},drawings:[]};
 await json(`/api/v1/drafts/${created.id}/chart`,owner,{method:'PUT',headers:write(owner,{'If-Match':'"0"'}),body:JSON.stringify(state)});
 const current=await json(`/api/v1/drafts/${created.id}`,owner);
 const started=await json(`/api/v1/drafts/${created.id}/publish`,owner,{method:'POST',headers:write(owner,{'If-Match':`"${current.revision}"`,'Idempotency-Key':key()}),body:JSON.stringify({draftRevision:current.revision,chartRevision:1})},202);
 let terminal,reportedFailure=false;for(let i=0;i<600;i++){terminal=await json(`/api/v1/publication-jobs/${started.id}`,owner);if(!reportedFailure&&terminal.status==='pending'&&/^[A-Z0-9_]{1,80}$/.test(terminal.failureCode??'')){console.error(`Trusted capture retry diagnostic: ${terminal.failureCode}`);reportedFailure=true;}if(['succeeded','failed'].includes(terminal.status))break;await delay(500);}
 if(terminal?.status!=='succeeded'&&/^[A-Z0-9_]{1,80}$/.test(terminal?.failureCode??''))console.error(`Trusted capture failure: ${terminal.failureCode}`);
 assert.equal(terminal?.status,'succeeded','Trusted synthetic publication capture must complete.');
 return (await pool.query('SELECT publication_id FROM publication_job WHERE id=$1',[started.id])).rows[0].publication_id;
}
async function waitFor(predicate,message,attempts=60){for(let i=0;i<attempts;i++){const value=await predicate();if(value)return value;await delay(1000);}assert.fail(message);}
async function mailpitCleanup(){
 if(!mailpitIds.size)return;
 const base=(process.env.MAILPIT_URL??'http://mailpit:8025').replace(/\/$/,'');
 const response=await fetch(`${base}/api/v1/messages`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({IDs:[...mailpitIds]}),signal:AbortSignal.timeout(10000)});assert.ok(response.ok,'Scoped generated-message cleanup failed.');
}
async function captureFixtureMailpitIds(){
 if(!users.length)return;
 const base=(process.env.MAILPIT_URL??'http://mailpit:8025').replace(/\/$/,'');
 const fixtureEmails=(await pool.query('SELECT email FROM user_account WHERE id=ANY($1::uuid[])',[users])).rows.map(row=>String(row.email).toLowerCase());
 for(const email of fixtureEmails){try{const response=await fetch(`${base}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}&limit=100`,{signal:AbortSignal.timeout(5000)});if(!response.ok)continue;const data=await response.json();for(const message of data.messages??[]){const recipients=[...(message.To??[]),...(message.to??[])].map(value=>String(value.Address??value.address??value).toLowerCase());if(recipients.includes(email)){const id=message.ID??message.id;if(id)mailpitIds.add(id);}}}catch{}}
}
try{
 const owner=await persona('author'),member=await persona('reader'),other=await persona('other'),staff=await persona('staff');
 await pool.query("INSERT INTO role_grant(id,user_id,role,grantor_user_id,reason,granted_at) VALUES($1,$2,'admin',$2,'Synthetic P11 local acceptance',now())",[randomUUID(),staff.id]);
 Object.assign(staff,await auth.createSession({issuer:auth.config.issuer,subject:staff.subject,email:staff.email,emailVerified:true,sid:staff.subject,assurance:auth.config.mfaAssurance,authTime:Math.floor(Date.now()/1000)},undefined,true));

 stage='notifications, preference isolation and no-store';
 await request('/api/v1/notifications',null,{},401);
 const ownerNotices=await json('/api/v1/notifications?limit=50',owner);assert.ok(Array.isArray(ownerNotices.items));assert.equal(typeof ownerNotices.unreadCount,'number');
 assert.match((await request('/api/v1/notifications',owner)).response.headers.get('cache-control')??'',/no-store/);
 for(const actor of [member,other,staff]){assert.equal((await json('/api/v1/notifications?limit=50',actor)).items.some(item=>ownerNotices.items.some(owned=>owned.id===item.id)),false);}
 const prefBefore=await json('/api/v1/me/preferences',owner);assert.equal(prefBefore.digestEnabled,false);assert.equal(prefBefore.analyticsConsent,false);
 const prefUpdated=await json('/api/v1/me/preferences',owner,{method:'PATCH',headers:write(owner),body:JSON.stringify({theme:'dark',timezone:'America/New_York',digestEnabled:true,digestHour:8,quietFrom:'22:00',quietUntil:'08:00',publicationNotices:true,replyNotices:true,mentionNotices:true,bookmarkNotices:true,moderationNotices:true})});
 assert.equal(prefUpdated.digestEnabled,true);assert.equal(prefUpdated.digestHour,8);assert.equal(prefUpdated.digestSuppressed,false);
 const {NotificationService}=await import('../dist/notifications/service.js'),notifications=new NotificationService(pool,auth.config.sessionSecret),unsubscribeToken=notifications.makeUnsubscribeToken(owner.id,Math.floor(Date.now()/1000)+86400);
 const suppressionBefore=(await pool.query('SELECT suppressed_at FROM digest_suppression WHERE owner_user_id=$1',[owner.id])).rows[0]?.suppressed_at??null;
 const unsubscribePage=await request(`/digest/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`,null);assert.ok(unsubscribePage.text.includes('Unsubscribe from the daily digest'));assert.match(unsubscribePage.response.headers.get('cache-control')??'',/no-store/);assert.equal(unsubscribePage.response.headers.get('referrer-policy'),'no-referrer');assert.match(unsubscribePage.response.headers.get('x-robots-tag')??'',/noindex/i);assert.equal((await pool.query('SELECT suppressed_at FROM digest_suppression WHERE owner_user_id=$1',[owner.id])).rows[0]?.suppressed_at??null,suppressionBefore);
 await request('/api/v1/digest/unsubscribe',null,{method:'POST',body:JSON.stringify({token:unsubscribeToken})},204);assert.equal((await json('/api/v1/me/preferences',owner)).digestSuppressed,true);
 await request('/api/v1/digest/unsubscribe',null,{method:'POST',body:JSON.stringify({token:unsubscribeToken})},204);
 const signatureStart=unsubscribeToken.lastIndexOf('.')+1,forgedToken=`${unsubscribeToken.slice(0,signatureStart)}${unsubscribeToken[signatureStart]==='A'?'B':'A'}${unsubscribeToken.slice(signatureStart+1)}`;await request('/api/v1/digest/unsubscribe',null,{method:'POST',body:JSON.stringify({token:forgedToken})},400);
 const resubscribed=await json('/api/v1/me/preferences',owner,{method:'PATCH',headers:write(owner),body:JSON.stringify({digestEnabled:true})});assert.equal(resubscribed.digestSuppressed,false);
 await request('/api/v1/me/preferences',owner,{method:'PATCH',headers:write(owner),body:JSON.stringify({billingNotices:false})},422);
 await request('/api/v1/me/preferences',owner,{method:'PATCH',headers:{Origin:auth.config.appOrigin},body:JSON.stringify({digestEnabled:false})},403);
 const badPage=await request('/api/v1/notifications?cursor=invalid&limit=20',owner,{},400);assert.match(badPage.response.headers.get('cache-control')??'',/no-store/);
 const journalNow=Date.now(),journalPlan={asset:'option',strategy:'long_call',instrumentId:stockId,legs:[{instrumentId:optionId,side:'buy',quantity:1}],quantity:1,entryPrice:'2.50',priceKind:'option_premium',entryFrom:stamp(journalNow-60000),entryUntil:stamp(journalNow+3600000),entryCondition:'Synthetic private acceptance entry.',timeframe:'swing',exitRules:'Report actual fills.',conflicts:'Synthetic acceptance only.'};
 const journal=await json('/api/v1/journal',owner,{method:'POST',headers:write(owner,{'Idempotency-Key':key()}),body:JSON.stringify({title:'Private P11 acceptance journal',thesis:privateSentinel,notes:privateSentinel,tags:['acceptance'],review:'',plan:journalPlan})},201);
 for(const actor of [member,other,staff])await request(`/api/v1/journal/${journal.id}`,actor,{},404);

 stage='public social notification producers and source visibility';
 await request(`/api/v1/users/${owner.handle}/follow`,member,{method:'PUT',headers:write(member)},204);
 const publicationId=await publish(owner);
 await waitFor(async()=>Boolean((await pool.query("SELECT 1 FROM notification WHERE owner_user_id=$1 AND category='followed_publication' AND source_id=$2",[member.id,publicationId])).rowCount),'Followed publication notification was not delivered.');
 await request(`/api/v1/publications/${publicationId}/bookmark`,member,{method:'PUT',headers:write(member)},204);
 const comment=(await json(`/api/v1/publications/${publicationId}/comments`,member,{method:'POST',headers:write(member,{'Idempotency-Key':key()}),body:JSON.stringify({body:`Synthetic comment mentions @${other.handle}; ${privateSentinel}`})},201));
 assert.equal(comment.mentions?.[0]?.handle,other.handle);
 await waitFor(async()=>Boolean((await pool.query("SELECT 1 FROM notification WHERE owner_user_id=$1 AND category='reply' AND source_id=$2",[owner.id,publicationId])).rowCount&& (await pool.query("SELECT 1 FROM notification WHERE owner_user_id=$1 AND category='mention' AND source_id=$2",[other.id,publicationId])).rowCount),'Reply and mention notifications were not delivered.');
 await json(`/api/v1/publications/${publicationId}/corrections`,owner,{method:'POST',headers:write(owner,{'Idempotency-Key':key()}),body:JSON.stringify({reason:'Synthetic correction acceptance.',replacementThesis:'Updated synthetic option scenario for notification acceptance.'})},201);
 await waitFor(async()=>Boolean((await pool.query("SELECT 1 FROM notification WHERE owner_user_id=$1 AND category='bookmark_update' AND source_id=$2",[member.id,publicationId])).rowCount),'Bookmarked publication update notification was not delivered.');
 const beforeHide=(await json('/api/v1/notifications?limit=50',owner)).items;assert.ok(beforeHide.every(item=>!item.text.includes(privateSentinel)));
 const paged=(await json('/api/v1/notifications?limit=1',member));assert.ok(paged.nextCursor);await request(`/api/v1/notifications?cursor=${encodeURIComponent(paged.nextCursor)}&limit=1`,other,{},400);
 assert.ok(beforeHide.some(item=>item.kind==='reply'&&item.sourceId===publicationId));
 for(const id of [beforeHide.find(item=>item.kind==='reply')?.id,beforeHide.find(item=>item.kind==='followed_publication')?.id].filter(Boolean))await request(`/api/v1/notifications/${id}/read`,owner,{method:'PUT',headers:write(owner)},204);
 await request('/api/v1/notifications/read-all',owner,{method:'POST',headers:write(owner)},204);
 assert.equal((await json('/api/v1/notifications?unreadOnly=true&limit=50',owner)).items.length,0);
 const hidden=(await pool.query("UPDATE publication SET visibility='hidden' WHERE id=$1 RETURNING id",[publicationId])).rowCount;assert.equal(hidden,1);
 const afterHide=(await json('/api/v1/notifications?limit=50',member)).items;assert.ok(afterHide.every(item=>item.sourceId!==publicationId&&item.url!==`/ideas/${publicationId}`));
 for(const actor of [other,staff])await request(`/api/v1/publications/${publicationId}`,actor,{},404);
 console.log('PASS owner-scoped notices, digest unsubscribe confirmation/idempotence/resubscribe, preference validation, public-source hiding, read-all and unread filtering.');

 stage='Pro saved search lifecycle and authorization';
 await pool.query("INSERT INTO subscription_entitlement(id,user_id,plan,limits,valid_from,valid_until) VALUES($1,$2,'pro','{}',now()-interval '1 day',now()+interval '1 day')",[randomUUID(),owner.id]);
 const searchBody={name:'Synthetic long calls',filters:{q:'P11',asset:'option',strategy:'long_call',author:owner.handle}};
 const saved=await json('/api/v1/me/saved-searches',owner,{method:'POST',headers:write(owner,{'Idempotency-Key':key()}),body:JSON.stringify(searchBody)},201);assert.equal(saved.revision,1);
 assert.equal((await json('/api/v1/me/saved-searches',owner)).items[0].id,saved.id);
 for(const actor of [other,staff])await request(`/api/v1/me/saved-searches/${saved.id}`,actor,{method:'PATCH',headers:write(actor,{'If-Match':'"1"'}),body:JSON.stringify({name:'Unauthorized access'})},404);
 await request('/api/v1/me/saved-searches',owner,{method:'POST',headers:write(owner,{'Idempotency-Key':key()}),body:JSON.stringify({name:'Invalid private query',filters:{journalNotes:privateSentinel}})},400);
 const updatedSearch=await json(`/api/v1/me/saved-searches/${saved.id}`,owner,{method:'PATCH',headers:write(owner,{'If-Match':'"1"'}),body:JSON.stringify({name:'Updated synthetic search'})});assert.equal(updatedSearch.revision,2);
 await request(`/api/v1/me/saved-searches/${saved.id}`,owner,{method:'DELETE',headers:write(owner,{'If-Match':'"1"'})},409);
 await request(`/api/v1/me/saved-searches/${saved.id}`,owner,{method:'DELETE',headers:write(owner,{'If-Match':'"2"'})},204);
 assert.equal((await json('/api/v1/me/saved-searches',owner)).items.length,0);
 console.log('PASS Pro public-search persistence, revision checks, input allowlist and cross-owner/staff isolation.');

 stage='analytics consent gating and withdrawal';
 const sourceKey=key();await request('/api/v1/product-events',owner,{method:'POST',headers:write(owner),body:JSON.stringify({name:'return',sourceKey,properties:{surface:'dashboard'}})},204);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM product_event WHERE owner_user_id=$1',[owner.id])).rows[0].n,0);
 await request('/api/v1/product-events',owner,{method:'POST',headers:write(owner),body:JSON.stringify({name:'return',sourceKey:key(),properties:{surface:'dashboard',journalNotes:privateSentinel}})},400);
 await json('/api/v1/me/preferences',owner,{method:'PATCH',headers:write(owner),body:JSON.stringify({analyticsConsent:true})});
 await request('/api/v1/product-events',owner,{method:'POST',headers:write(owner),body:JSON.stringify({name:'return',sourceKey,properties:{surface:'settings'}})},204);
 const metric=(await pool.query('SELECT event_name,source_key,properties,consent_version FROM product_event WHERE owner_user_id=$1',[owner.id])).rows;assert.equal(metric.length,1);assert.equal(metric[0].event_name,'return');assert.deepEqual(metric[0].properties,{surface:'settings'});assert.match(metric[0].source_key,/^[0-9a-f]{64}$/);assert.equal(metric[0].consent_version,'2026-10-20.v1');
 await json('/api/v1/me/preferences',owner,{method:'PATCH',headers:write(owner),body:JSON.stringify({analyticsConsent:false})});assert.equal((await pool.query('SELECT count(*)::int AS n FROM product_event WHERE owner_user_id=$1',[owner.id])).rows[0].n,0);
 console.log('PASS no analytics collection before explicit consent, allowlisted event data and atomic withdrawal.');

 stage='administrative operations isolation and private-data boundaries';
 await request('/api/v1/admin/jobs',member,{},403);await request('/api/v1/admin/jobs',owner,{},403);
 const jobs=await json('/api/v1/admin/jobs?limit=25',staff);assert.ok(Array.isArray(jobs.items));assert.equal(typeof jobs.telemetry.pending,'number');
 const encoded=JSON.stringify(jobs);for(const secret of [owner.token,member.token,privateSentinel,owner.email,member.email])assert.ok(!encoded.includes(secret));
 for(const item of jobs.items){for(const key of ['id','kind','status','attempts','maxAttempts','createdAt','updatedAt','canRetry'])assert.ok(Object.hasOwn(item,key));assert.ok(!Object.hasOwn(item,'payload')&&!Object.hasOwn(item,'journalNotes'));}
 assert.match((await request('/app/notifications',owner)).response.headers.get('cache-control')??'',/no-store/);assert.match((await request('/app/settings',owner)).text,/noindex/);
 const journalHtml=await request(`/app/journal/${journal.id}`,owner);assert.match(journalHtml.response.headers.get('cache-control')??'',/no-store/);assert.ok(journalHtml.text.includes(privateSentinel));
 const deniedJournalHtml=await request(`/app/journal/${journal.id}`,member,{},404);assert.ok(!deniedJournalHtml.text.includes(privateSentinel));
 console.log('PASS recent-MFA admin job DTO, non-admin denial and private/payload-free staff telemetry.');

 stage='transactional security notice and actual local mail delivery';
 const {enqueueTransactionalNotification}=await import('../dist/notifications/service.js');
 const tx=await pool.connect();try{await tx.query('BEGIN');await enqueueTransactionalNotification(tx,{recipientUserId:owner.id,category:'security',internalUrl:'/app/settings',text:'A synthetic security notification was generated for local acceptance.',email:{subject:'Synthetic security notice',title:'Security update',body:'Review your local account settings for this synthetic security notice.'}});await tx.query('COMMIT');}catch(error){await tx.query('ROLLBACK').catch(()=>undefined);throw error;}finally{tx.release();}
 await waitFor(async()=>Boolean((await pool.query("SELECT 1 FROM notification WHERE owner_user_id=$1 AND category='security' LIMIT 1",[owner.id])).rowCount),'Transactional security notice was not delivered to the notification inbox.');
 const base=(process.env.MAILPIT_URL??'http://mailpit:8025').replace(/\/$/,'');
 const delivered=await waitFor(async()=>{try{const response=await fetch(`${base}/api/v1/search?query=${encodeURIComponent(`to:${owner.email}`)}&limit=20`,{signal:AbortSignal.timeout(5000)});if(!response.ok)return null;const data=await response.json();const matches=(data.messages??[]).filter(message=>message.To?.some(address=>address.Address===owner.email)||message.to?.some(address=>String(address).includes(owner.email)));for(const item of matches){const id=item.ID??item.id;if(id)mailpitIds.add(id);}return matches.some(message=>/synthetic security notice/i.test(message.Subject??message.subject??''))?matches[0]:null;}catch{return null;}},'The transactional security message did not reach local Mailpit.',90);
 assert.ok(delivered.ID??delivered.id);assert.ok(mailpitIds.size);console.log('PASS generated transactional security notice reached local Mailpit; cleanup is scoped to exact-recipient message IDs.');
}catch(error){const line=error instanceof Error?error.stack?.match(/verify-p11-live\.mjs:(\d+)/)?.[1]:undefined;console.error(`FAIL P11 ${stage}: ${error instanceof Error?error.name:'Unknown failure'}${line?` at driver line ${line}`:''}; private payloads omitted.`);process.exitCode=1;}
finally{
 try{const media=users.length?(await pool.query('SELECT processed_key,quarantine_key FROM media WHERE owner_user_id=ANY($1::uuid[])',[users])).rows.flatMap(row=>[row.processed_key,row.quarantine_key]).filter(Boolean):[];await captureFixtureMailpitIds();await mailpitCleanup();await cleanupP08Fixtures(pool,users);for(const object of media)await storage.deleteObject(object);const root=process.env.LOCAL_OBJECTS_PATH??'/var/lib/options-trade-ideas/objects';for(const object of media){const base=object.includes('/quarantine.')?'quarantine':'processed';await assert.rejects(access(join(root,base,object)));}assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_account WHERE id=ANY($1::uuid[])',[users])).rows[0].n,0);console.log('PASS generated P11 database/media fixtures and only their captured Mailpit messages cleaned; normal rate budgets preserved.');}
 catch{console.error('FAIL strict P11 fixture cleanup; generated identifiers and private payloads omitted.');process.exitCode=1;}
 await pool.end();
}
