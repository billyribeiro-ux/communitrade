import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {AuthService,authConfigFromEnv} from '../dist/auth/service.js';
import {FilesystemStorage} from '@trading/media';
import {cleanupP09Fixtures} from './p09-fixture-cleanup.mjs';

if(process.env.RELEASE_MODE!=='local'||process.env.NODE_ENV==='production'||(process.env.MARKET_DATA_PROVIDER??'synthetic')!=='synthetic')throw new Error('P09 live acceptance requires local synthetic mode.');
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:5,connectionTimeoutMillis:5000});
const auth=new AuthService(pool,authConfigFromEnv()),storage=new FilesystemStorage(process.env.LOCAL_OBJECTS_PATH??'/var/lib/options-trade-ideas/objects');
const sharp=createRequire(new URL('../../../packages/media/package.json',import.meta.url))('sharp');
const users=[],keys=[],nonce=randomUUID().replaceAll('-',''),privateSentinel=`PRIVATE${nonce}`;
const stockId='00000000-0000-4000-8000-000000000201',optionId='00000000-0000-4000-8000-000000000221';
let publicationId,versionId,stage='setup';
const key=()=>{const value=randomUUID();keys.push(value);return value;};
const stamp=value=>new Date(value).toISOString();
function write(actor,extra={}){return {Origin:auth.config.appOrigin,'X-CSRF-Token':actor.csrfToken,...extra};}
async function request(path,actor,init={},expected=200){
 const headers=new Headers(init.headers);if(actor)headers.set('Cookie',`${auth.config.cookieName}=${actor.token}`);if(init.body!==undefined)headers.set('Content-Type','application/json');
 let response,text;
 for(let attempt=0;attempt<4;attempt++){
  response=await fetch(`http://web:3000${path}`,{...init,headers,redirect:'manual',signal:AbortSignal.timeout(30000)});text=await response.text();
  if(response.status!==429||(init.method??'GET')!=='GET'||attempt===3)break;
  console.log('WAIT normal public-read budget; respecting Retry-After.');await delay(Math.min(60,Math.max(1,Number(response.headers.get('retry-after'))||60))*1000+250);
 }
 if(response.status!==expected){let code='UNKNOWN';try{const parsed=JSON.parse(text);if(/^[A-Z_]{1,100}$/.test(parsed.code))code=parsed.code;}catch{}console.error(`HTTP ${init.method??'GET'} ${path.split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi,':id')} ${response.status} ${code}`);}
 assert.equal(response.status,expected,`P09 ${stage}: HTTP status mismatch`);return {response,text};
}
async function json(path,actor,init={},expected=200){const result=await request(path,actor,init,expected);return {...result,data:result.text?JSON.parse(result.text):null};}
async function persona(label){
 const suffix=randomUUID(),subject=`p09-live-${suffix}`,email=`p09-${suffix}@example.invalid`;
 const session=await auth.createSession({issuer:auth.config.issuer,subject,email,emailVerified:true,sid:subject,assurance:'1',authTime:Math.floor(Date.now()/1000)},undefined,false);
 const row=(await pool.query('SELECT id FROM user_account WHERE oidc_issuer=$1 AND oidc_subject=$2',[auth.config.issuer,subject])).rows[0];assert.ok(row?.id);users.push(row.id);
 await pool.query('UPDATE user_account SET synthetic=true WHERE id=$1',[row.id]);
 const handle=`p09_${suffix.replaceAll('-','').slice(0,16)}`;
 await json('/api/v1/me/onboarding',session,{method:'POST',headers:write(session),body:JSON.stringify({handle,displayName:`P09 synthetic ${label}`,experience:'experienced',interests:['option','stock','future'],timezone:'America/New_York',termsVersion:auth.config.termsVersion,adultUSDeclaration:true})},201);
 return {...session,id:row.id,email,handle};
}
async function publish(owner){
 const created=await json('/api/v1/drafts',owner,{method:'POST',headers:write(owner,{'Idempotency-Key':key()}),body:JSON.stringify({kind:'trade',asset:'option'})},201);
 const plan={asset:'option',strategy:'long_call',instrumentId:stockId,legs:[{instrumentId:optionId,side:'buy',quantity:1}],quantity:1,entryPrice:'2.50',priceKind:'option_premium',entryFrom:stamp(Date.now()-60000),entryUntil:stamp(Date.now()+3600000),entryCondition:'Synthetic reference confirmation.',timeframe:'swing',exitRules:'Report actual exits and costs.',conflicts:'Synthetic acceptance; no investment claim.'};
 await json(`/api/v1/drafts/${created.data.id}`,owner,{method:'PATCH',headers:write(owner,{'If-Match':`"${created.data.revision}"`}),body:JSON.stringify({title:`Constellation${nonce} option scenario`,thesis:'A synthetic option publication used to verify community distribution and source attribution.',plan})});
 const bars=await json(`/api/v1/instruments/${stockId}/bars?${new URLSearchParams({interval:'1d',from:stamp(Date.now()-60*86400000),to:stamp(Date.now()),session:'regular',limit:'10000'})}`,owner);
 const state={schemaVersion:1,instrumentId:stockId,metadataVersion:bars.data.meta.metadataVersion,interval:'1d',timezone:'America/New_York',session:'regular',adjustment:'unadjusted',viewport:{from:bars.data.bars[0].time,to:stamp(Date.parse(bars.data.bars.at(-1).time)+86400000)},indicators:[],provenance:{provider:bars.data.meta.provider,asOf:bars.data.meta.asOf,delaySeconds:bars.data.meta.delaySeconds,demo:bars.data.meta.demo},drawings:[{id:randomUUID(),type:'horizontal',anchors:[{time:bars.data.bars[0].time,price:'100.00'}],style:{color:'#4678d4',lineWidth:2,lineStyle:'solid',fillOpacity:0}}]};
 await json(`/api/v1/drafts/${created.data.id}/chart`,owner,{method:'PUT',headers:write(owner,{'If-Match':'"0"'}),body:JSON.stringify(state)});
 const current=await json(`/api/v1/drafts/${created.data.id}`,owner);
 const started=await json(`/api/v1/drafts/${created.data.id}/publish`,owner,{method:'POST',headers:write(owner,{'If-Match':`"${current.data.revision}"`,'Idempotency-Key':key()}),body:JSON.stringify({draftRevision:current.data.revision,chartRevision:1})},202);
 let terminal;for(let i=0;i<600;i++){terminal=(await json(`/api/v1/publication-jobs/${started.data.id}`,owner)).data;if(['succeeded','failed'].includes(terminal.status))break;await delay(500);}
 if(terminal?.status!=='succeeded'&&/^[A-Z0-9_]{1,80}$/.test(terminal?.failureCode??''))console.error(`Trusted capture failure: ${terminal.failureCode}`);
 assert.equal(terminal?.status,'succeeded','Trusted publication capture must complete.');
 const row=(await pool.query('SELECT publication_id,publication_version_id FROM publication_job WHERE id=$1',[started.data.id])).rows[0];publicationId=row.publication_id;versionId=row.publication_version_id;
 return (await json(`/api/v1/publications/${publicationId}`,null)).data;
}
try{
 const owner=await persona('author'),member=await persona('reader');
 stage='private source exclusion';
 const draft=await json('/api/v1/drafts',owner,{method:'POST',headers:write(owner,{'Idempotency-Key':key()}),body:JSON.stringify({kind:'education',asset:'stock'})},201);
 await json(`/api/v1/drafts/${draft.data.id}`,owner,{method:'PATCH',headers:write(owner,{'If-Match':`"${draft.data.revision}"`}),body:JSON.stringify({title:privateSentinel,thesis:privateSentinel})});
 stage='trusted option publication';const publication=await publish(owner),canonical=`/ideas/${publicationId}/${publication.slug}`;
 console.log('PASS real option publication finalized by trusted capture.');
 stage='feeds, search, follows and bookmarks';
 await request('/api/v1/publications',null,{headers:{Cookie:`${auth.config.cookieName}=invalid-session`}},401);
 assert.ok((await json(`/api/v1/publications?q=Constellation${nonce}`,null)).data.items.some(item=>item.id===publicationId));
 assert.equal((await json(`/api/v1/publications?q=${privateSentinel}`,null)).data.items.length,0);
 await request('/api/v1/publications?feed=following',null,{},401);
 await request(`/api/v1/users/${owner.handle}/follow`,member,{method:'PUT',headers:write(member)},204);
 await request(`/api/v1/instruments/${stockId}/follow`,member,{method:'PUT',headers:write(member)},204);
 assert.ok((await json('/api/v1/publications?feed=following&asset=option&strategy=long_call',member)).data.items.some(item=>item.id===publicationId));
 await request(`/api/v1/publications/${publicationId}/reaction`,owner,{method:'PUT',headers:write(owner)},422);
 await request(`/api/v1/publications/${publicationId}/reaction`,member,{method:'PUT',headers:{Origin:auth.config.appOrigin}},403);
 await request(`/api/v1/publications/${publicationId}/reaction`,member,{method:'PUT',headers:write(member)},204);
 await request(`/api/v1/publications/${publicationId}/reaction`,member,{method:'PUT',headers:write(member)},204);
 await request(`/api/v1/publications/${publicationId}/bookmark`,member,{method:'PUT',headers:write(member)},204);
 assert.equal((await json(`/api/v1/publications/${publicationId}/community`,member)).data.helpfulCount,1);
 assert.ok((await json('/api/v1/me/bookmarks',member)).data.items.some(item=>item.id===publicationId));
 stage='thread, deep reply, mention, edit and tombstone';
 const commentKey=key(),commentBody={body:`A plain-text risk concern for @${owner.handle}.`,tag:'risk'};
 const root=(await json(`/api/v1/publications/${publicationId}/comments`,member,{method:'POST',headers:write(member,{'Idempotency-Key':commentKey}),body:JSON.stringify(commentBody)},201)).data;
 assert.ok(root.id);assert.equal(root.mentions[0].handle,owner.handle);
 assert.equal((await json(`/api/v1/publications/${publicationId}/comments`,member,{method:'POST',headers:write(member,{'Idempotency-Key':commentKey}),body:JSON.stringify(commentBody)},201)).data.id,root.id);
 const reply=(await json(`/api/v1/publications/${publicationId}/comments`,owner,{method:'POST',headers:write(owner,{'Idempotency-Key':key()}),body:JSON.stringify({body:'Author responds without suppressing criticism.',replyToId:root.id})},201)).data;
 const deep=(await json(`/api/v1/publications/${publicationId}/comments`,member,{method:'POST',headers:write(member,{'Idempotency-Key':key()}),body:JSON.stringify({body:'A second-level reply keeps its direct target.',replyToId:reply.id})},201)).data;
 assert.equal(deep.rootId,root.id);assert.equal(deep.replyToId,reply.id);
 const edited=(await json(`/api/v1/comments/${root.id}`,member,{method:'PATCH',headers:write(member,{'If-Match':'"1"'}),body:JSON.stringify({body:'Edited risk concern, still plain text.',tag:'risk'})})).data;assert.equal(edited.revision,2);assert.ok(edited.editedAt);
 await request(`/api/v1/comments/${root.id}`,owner,{method:'PATCH',headers:write(owner,{'If-Match':'"2"'}),body:JSON.stringify({body:'Forbidden owner override.'})},404);
 const firstPage=(await json(`/api/v1/publications/${publicationId}/comments?limit=1`,member)).data;assert.equal(firstPage.items.length,1);assert.ok(firstPage.nextCursor);
 const secondPage=(await json(`/api/v1/publications/${publicationId}/comments?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,member)).data;assert.notEqual(secondPage.items[0].id,firstPage.items[0].id);
 await request(`/api/v1/users/${member.handle}/mute`,owner,{method:'PUT',headers:write(owner)},204);
 assert.ok((await json(`/api/v1/publications/${publicationId}/comments`,owner)).data.items.some(item=>item.id===root.id&&!item.deleted),'Author mute never suppresses criticism.');
 await request(`/api/v1/comments/${root.id}`,member,{method:'DELETE',headers:write(member,{'If-Match':'"2"'})},204);
 const thread=(await json(`/api/v1/publications/${publicationId}/comments`,null)).data;assert.equal(thread.items.find(item=>item.id===root.id).body,'');assert.equal(thread.items.find(item=>item.id===deep.id).replyToId,reply.id);
 console.log('PASS follow/filter/search, private exclusion, idempotent actions, deep replies, mentions, edits, paging and tombstones; mute preserves public criticism.');
 stage='attributed reposts and report receipt';
 await request(`/api/v1/publications/${publicationId}/reposts`,owner,{method:'POST',headers:write(owner,{'Idempotency-Key':key()}),body:JSON.stringify({})},422);
 const before=(await pool.query('SELECT (SELECT count(*) FROM position WHERE public_publication_id=$1)::int AS positions,(SELECT count(*) FROM publication WHERE id=$1)::int AS publications',[publicationId])).rows[0];
 const repost=(await json(`/api/v1/publications/${publicationId}/reposts`,member,{method:'POST',headers:write(member,{'Idempotency-Key':key()}),body:JSON.stringify({commentary:'Inspect the original terms and risk.'})},201)).data;assert.equal(repost.publicationId,publicationId);
 assert.ok((await json(`/api/v1/users/${member.handle}/reposts`,null)).data.items.some(item=>item.id===repost.id&&item.publication.id===publicationId));
 const report=(await json('/api/v1/reports',owner,{method:'POST',headers:write(owner,{'Idempotency-Key':key()}),body:JSON.stringify({resourceType:'repost',resourceId:repost.id,reason:'other',detail:'Synthetic report interface acceptance.'})},201)).data;
 assert.equal((await json(`/api/v1/reports/${report.id}`,owner)).data.id,report.id);await request(`/api/v1/reports/${report.id}`,member,{},404);
 assert.deepEqual((await pool.query('SELECT (SELECT count(*) FROM position WHERE public_publication_id=$1)::int AS positions,(SELECT count(*) FROM publication WHERE id=$1)::int AS publications',[publicationId])).rows[0],before);
 stage='licensed image attribution and anonymous/authenticated SSR';
 const share=(await json(`/api/v1/publications/${publicationId}/share`,null)).data;assert.equal(new URL(share.canonicalUrl).pathname,canonical);assert.equal(share.imageAllowed,true);
 const imageUrl=new URL(share.imageUrl),imageResponse=await fetch(`http://web:3000${imageUrl.pathname}${imageUrl.search}`);assert.equal(imageResponse.status,200);const exported=Buffer.from(await imageResponse.arrayBuffer());const meta=await sharp(exported).metadata();assert.equal(meta.width,1200);assert.equal(meta.height,872);
 const original=await fetch(`http://web:3000/api/v1/publications/${publicationId}/share/image?versionId=${versionId}`);assert.equal(original.status,200);const frozen=Buffer.from(await original.arrayBuffer());assert.equal((await sharp(frozen).metadata()).height,760);assert.notEqual(createHash('sha256').update(exported).digest('hex'),createHash('sha256').update(frozen).digest('hex'));
 const html=(await request(canonical,null)).text;for(const secret of [privateSentinel,owner.token,member.token,owner.email,member.email])assert.ok(!html.includes(secret));assert.match(html,/Discussion/);assert.match(html,/Share/);assert.match(html,/og:image/);assert.match(html,/Constellation/);
 assert.match((await request('/app/feed',member)).text,/Following/);assert.match((await request('/app/bookmarks',member)).text,/Constellation/);assert.match((await request(`/u/${member.handle}?tab=reposts`,null)).text,/Inspect the original terms/);
 assert.match((await request('/app/explore?feed=following&asset=option&strategy=long_call',member)).text,/Constellation/);
 console.log('PASS attribution-preserving repost/report flows, unchanged trade counts, separate licensed image export and public/member SSR.');
 stage='source hide purge across derivatives and discovery';
 const shard=parseInt(publicationId[0],16),discoveryBefore=await json(`/api/v1/discovery/sitemap?shard=${shard}`,null);assert.ok(discoveryBefore.data.items.some(item=>item.path===canonical));
 await pool.query("UPDATE publication SET visibility='hidden' WHERE id=$1 AND author_user_id=$2",[publicationId,owner.id]);
 for(const path of [`/api/v1/publications/${publicationId}`,`/api/v1/publications/${publicationId}/share`,`/api/v1/publications/${publicationId}/comments`,`/api/v1/publications/${publicationId}/community`])await request(path,null,{},404);
 assert.equal((await json(`/api/v1/publications?q=Constellation${nonce}`,null)).data.items.length,0);assert.equal((await json('/api/v1/me/bookmarks',member)).data.items.length,0);assert.equal((await json(`/api/v1/users/${member.handle}/reposts`,null)).data.items.length,0);
 assert.ok(!(await json(`/api/v1/discovery/sitemap?shard=${shard}`,null)).data.items.some(item=>item.path===canonical));
 const deniedImage=await fetch(`http://web:3000${imageUrl.pathname}${imageUrl.search}`);assert.equal(deniedImage.status,404);
 await request(canonical,null,{},404);
 await request(`/api/v1/publications/${publicationId}/reposts/mine`,member,{method:'DELETE',headers:write(member)},204);
 console.log('PASS hidden original purged from search, bookmarks, reposts, SSR metadata, discovery and image bytes; undo remains available.');
}catch(error){const line=error instanceof Error?error.stack?.match(/verify-p09-live\.mjs:(\d+)/)?.[1]:undefined;console.error(`FAIL P09 stage: ${stage}. ${error instanceof Error?error.name:'Unknown failure'}${line?` at driver line ${line}`:''}; private payloads omitted.`);process.exitCode=1;}
finally{
 try{
  const objects=users.length?(await pool.query('SELECT processed_key,quarantine_key FROM media WHERE owner_user_id=ANY($1::uuid[])',[users])).rows.flatMap(row=>[row.processed_key,row.quarantine_key]).filter(Boolean):[];
  await cleanupP09Fixtures(pool,users);
  for(const object of objects)await storage.deleteObject(object);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM user_account WHERE id=ANY($1::uuid[])',[users])).rows[0].count,0);
  console.log('PASS generated P09 identities, private/public history, social rows and image objects cleaned; normal rate limits preserved.');
 }catch{console.error('FAIL strict P09 fixture cleanup; inspect only generated local fixtures.');process.exitCode=1;}
 await pool.end();
}
