import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import Ajv from '../../../packages/contracts/node_modules/ajv/dist/2020.js';
import addFormats from '../../../packages/contracts/node_modules/ajv-formats/dist/index.js';
import {readFile} from 'node:fs/promises';
import {AuthService,authConfigFromEnv} from '../dist/auth/service.js';
import {createDatabase} from '../dist/database.js';
import {createBillingProvider,createBillingProviderConfig} from '../dist/billing/provider-config.js';
import {cleanupP08Fixtures} from './p08-fixture-cleanup.mjs';

if(process.env.RELEASE_MODE!=='local'||process.env.NODE_ENV==='production'||(process.env.BILLING_PROVIDER??'fake')!=='fake')throw new Error('P12 acceptance requires local synthetic billing.');
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:6}),database=createDatabase(process.env.DATABASE_URL);
const auth=new AuthService(pool,authConfigFromEnv()),config=createBillingProviderConfig(process.env),provider=await createBillingProvider(process.env,database);
const users=[],mailIds=new Set(),sentinel=`P12_PRIVATE_${randomUUID().replaceAll('-','')}`;
let stage='setup';
const spec=JSON.parse(await readFile(new URL('../../../contracts/openapi.json',import.meta.url),'utf8'));
const ajv=new Ajv({strict:false,allErrors:true});addFormats(ajv);ajv.addSchema({$id:'https://p12.invalid/contracts',components:spec.components});
const validators=new Map();
function schema(name,value){if(!validators.has(name)){const definition=structuredClone(spec.components.schemas[name]);function rewrite(v){if(!v||typeof v!=='object')return;if(v.$ref?.startsWith('#/'))v.$ref=`https://p12.invalid/contracts${v.$ref}`;for(const child of Object.values(v))rewrite(child);}rewrite(definition);validators.set(name,ajv.compile(definition));}assert.ok(validators.get(name)(value),`${name} response violated contract; private values omitted`);}
const command=()=>randomUUID();
const writes=(actor,key=command())=>({Origin:auth.config.appOrigin,'X-CSRF-Token':actor.csrfToken,'Idempotency-Key':key});
async function request(path,actor,init={},expected=200){const headers=new Headers(init.headers);if(actor)headers.set('Cookie',`${auth.config.cookieName}=${actor.token}`);if(init.body!==undefined&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');const response=await fetch(`http://web:3000${path}`,{...init,headers,redirect:'manual',signal:AbortSignal.timeout(45000)}),text=await response.text();let data=null;try{if(text&&response.headers.get('content-type')?.includes('json'))data=JSON.parse(text);}catch{}if(response.status!==expected){const code=/^[A-Z0-9_]{1,80}$/.test(data?.code??'')?data.code:'UNKNOWN';console.error(`HTTP ${init.method??'GET'} ${path.split('?')[0].replace(/\/[A-Za-z0-9_-]{25,}/g,'/:id')} billing acceptance: ${response.status} ${code}; expected ${expected}`);}assert.equal(response.status,expected,`${stage}: HTTP status mismatch`);return {response,text,data};}
async function json(path,actor,init={},expected=200){return (await request(path,actor,init,expected)).data;}
async function summary(actor){const result=await request('/api/v1/billing/subscription',actor);assert.match(result.response.headers.get('cache-control'),/no-store/);schema('BillingSummary',result.data);return result.data;}
async function persona(label){const subject=`p12-live-${randomUUID()}`,email=`${subject}@example.invalid`,session=await auth.createSession({issuer:auth.config.issuer,subject,email,emailVerified:true,sid:subject,assurance:'1',authTime:Math.floor(Date.now()/1000)},undefined,false);const id=(await pool.query('SELECT id FROM user_account WHERE oidc_issuer=$1 AND oidc_subject=$2',[auth.config.issuer,subject])).rows[0].id;users.push(id);await pool.query('UPDATE user_account SET synthetic=true WHERE id=$1',[id]);await request('/api/v1/me/onboarding',session,{method:'POST',headers:writes(session),body:JSON.stringify({handle:`p12_${randomUUID().replaceAll('-','').slice(0,16)}`,displayName:`P12 ${label}`,experience:'experienced',interests:['stock','option','future'],timezone:'America/New_York',termsVersion:auth.config.termsVersion,adultUSDeclaration:true})},201);return {...session,id,subject,email};}
async function checkout(actor,interval='monthly',key=command(),expected=201){return json('/api/v1/billing/checkout',actor,{method:'POST',headers:writes(actor,key),body:JSON.stringify({plan:'pro',interval,termsVersion:auth.config.termsVersion})},expected);}
async function inspect(actor,url){const parsed=new URL(url);assert.equal(parsed.origin,config.appOrigin);const id=parsed.searchParams.get('session');assert.ok(id);const result=await json(`/api/v1/billing/demo/${encodeURIComponent(id)}`,actor);schema('DemoBillingSession',result);return result;}
async function demo(actor,id,action,key=command(),expected=201){const result=await json(`/api/v1/billing/demo/${encodeURIComponent(id)}/actions`,actor,{method:'POST',headers:writes(actor,key),body:JSON.stringify({action})},expected);if(expected===201)schema('Redirect',result);return result;}
async function scenario(actor,name){const event=await provider.applyScenario({userId:actor.id,scenario:name});const delivery=await provider.getEventDelivery({eventId:event.eventId});await request('/api/v1/webhooks/stripe',null,{method:'POST',headers:{'Stripe-Signature':delivery.signature},body:Buffer.from(delivery.rawBody)},204);return delivery;}
function sign(payload){const raw=Buffer.from(JSON.stringify(payload,null,2)),seconds=Math.floor(Date.now()/1000),signature=createHmac('sha256',config.fakeWebhookSecret).update(`${seconds}.`).update(raw).digest('hex');return {raw,signature:`t=${seconds},v1=${signature}`};}
async function adminAction(staff,id,body,key=command(),expected=201){const result=await json(`/api/v1/admin/billing/${id}/actions`,staff,{method:'POST',headers:writes(staff,key),body:JSON.stringify(body)},expected);if(expected===201)schema('AuditEvent',result);return result;}
async function captureAndRemoveMail(){for(const id of users){const email=(await pool.query('SELECT email FROM user_account WHERE id=$1',[id])).rows[0]?.email;if(!email)continue;const response=await fetch(`http://mailpit:8025/api/v1/search?query=${encodeURIComponent(`to:${email}`)}&limit=100`);if(!response.ok)continue;for(const message of (await response.json()).messages??[]){if((message.To??[]).some(to=>String(to.Address??'').toLowerCase()===email.toLowerCase()))mailIds.add(message.ID);}}if(mailIds.size){const response=await fetch('http://mailpit:8025/api/v1/messages',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({IDs:[...mailIds]})});assert.ok(response.ok);}}
try{
 const owner=await persona('monthly'),annual=await persona('annual'),other=await persona('other'),staff=await persona('support');
 await pool.query("INSERT INTO role_grant(id,user_id,role,grantor_user_id,reason,granted_at) VALUES($1,$2,'admin',$2,'Synthetic P12 support acceptance',now())",[command(),staff.id]);
 const staleStaff={...staff,...await auth.createSession({issuer:auth.config.issuer,subject:staff.subject,email:staff.email,emailVerified:true,sid:staff.subject,assurance:'1',authTime:Math.floor(Date.now()/1000)},undefined,false)};Object.assign(staff,await auth.createSession({issuer:auth.config.issuer,subject:staff.subject,email:staff.email,emailVerified:true,sid:staff.subject,assurance:auth.config.mfaAssurance,authTime:Math.floor(Date.now()/1000)},undefined,true));
 stage='Free and interrupted checkout';schema('Plans',await json('/api/v1/plans',null));assert.equal((await summary(owner)).plan,'free');await request('/api/v1/billing/subscription',null,{},401);
 const journal=await json('/api/v1/journal',owner,{method:'POST',headers:writes(owner),body:JSON.stringify({title:'Private P12 journal',notes:sentinel,tags:[]})},201);
 const firstList=await json('/api/v1/watchlists',owner,{method:'POST',headers:writes(owner),body:JSON.stringify({name:'First private list'})},201);
 assert.ok(firstList.id);
 await request('/api/v1/watchlists',owner,{method:'POST',headers:writes(owner),body:JSON.stringify({name:'Beyond Free'})},403);
 await request('/api/v1/billing/checkout',owner,{method:'POST',headers:{Origin:auth.config.appOrigin,'Idempotency-Key':command()},body:JSON.stringify({plan:'pro',interval:'monthly',termsVersion:auth.config.termsVersion})},403);
 const checkoutKey=command(),created=await checkout(owner,'monthly',checkoutKey);schema('Redirect',created);const session=await inspect(owner,created.url);assert.equal(session.kind,'checkout');assert.equal(session.amountMinor,2900);assert.equal((await summary(owner)).resumeCheckoutUrl,created.url);
 await request(`/api/v1/billing/demo/${session.id}`,other,{},404);await demo(other,session.id,'complete',command(),404);
 assert.equal((await checkout(owner,'monthly',checkoutKey)).url,created.url);
 await request('/subscribe/return?paid=true&status=success',owner);assert.equal((await summary(owner)).plan,'free');
 await demo(owner,session.id,'cancel_checkout');assert.equal((await summary(owner)).plan,'free');
 console.log('PASS Free quota, CSRF, owner-only synthetic checkout, interrupted/canceled return and no redirect-based entitlement.');
 stage='monthly and annual completion';
 await json('/api/v1/me/preferences',owner,{method:'PATCH',headers:writes(owner),body:JSON.stringify({analyticsConsent:true})});
 const monthly=await inspect(owner,(await checkout(owner)).url);await demo(owner,monthly.id,'complete');let current=await summary(owner);assert.equal(current.plan,'pro');assert.equal(current.interval,'monthly');assert.equal(current.demo,true);assert.equal(current.mode,'test');assert.equal(current.resumeCheckoutUrl,null);assert.ok(current.invoices.some(i=>i.amountMinor===2900));
 await checkout(owner,'annual',command(),409);
 const year=await inspect(annual,(await checkout(annual,'annual')).url);assert.equal(year.amountMinor,29000);await demo(annual,year.id,'complete');assert.equal((await summary(annual)).interval,'annual');
 const secondList=await json('/api/v1/watchlists',owner,{method:'POST',headers:writes(owner),body:JSON.stringify({name:'Second private list'})},201);
 await json('/api/v1/me/saved-searches',owner,{method:'POST',headers:writes(owner),body:JSON.stringify({name:'Private P12 search',filters:{asset:'option',q:'earnings'}})},201);
 const actualUsage=await summary(owner);assert.equal(actualUsage.usage.find(u=>u.key==='watchlists').used,2);assert.equal(actualUsage.usage.find(u=>u.key==='saved_searches').used,1);
 console.log('PASS monthly/annual provider confirmation, real Pro allowances, invoices, saved searches and duplicate-subscription prevention.');
 stage='verified webhooks and replay';
 const savedEvent=(await database.fakeBillingEvent.findFirst({where:{customerId:(await database.fakeBillingCustomer.findFirst({where:{userId:owner.id}})).customerId},orderBy:{createdAt:'desc'}}));assert.ok(savedEvent);const original=await provider.getEventDelivery({eventId:savedEvent.eventId});
 await request('/api/v1/webhooks/stripe',null,{method:'POST',headers:{'Stripe-Signature':original.signature},body:Buffer.from(original.rawBody)},204);assert.equal((await pool.query('SELECT count(*)::int n FROM billing_event WHERE event_id=$1',[savedEvent.eventId])).rows[0].n,1);
 await request('/api/v1/webhooks/stripe',null,{method:'POST',headers:{'Stripe-Signature':original.signature},body:Buffer.from(original.rawBody).toString()+' '},400);
 for(const mutate of [event=>{event.livemode=true;},event=>{event.account='other-account';}]){const payload=JSON.parse(Buffer.from(original.rawBody).toString());payload.id=`evt_fake_${command().replaceAll('-','')}`;mutate(payload);const forged=sign(payload);await request('/api/v1/webhooks/stripe',null,{method:'POST',headers:{'Stripe-Signature':forged.signature},body:forged.raw},400);}
 assert.equal((await summary(owner)).plan,'pro');
 console.log('PASS raw signed webhook, replay dedupe, byte tampering and cross-account/mode denial.');
 stage='admin support and separate refund/cancel';
 await request('/api/v1/admin/billing',other,{},403);await request('/api/v1/admin/billing',staleStaff,{},403);
 const admin=await json('/api/v1/admin/billing?limit=50',staff);schema('AdminSubscriptionPage',admin);assert.ok(!JSON.stringify(admin).includes(sentinel));const own=admin.items.find(i=>i.user.id===owner.id),another=admin.items.find(i=>i.user.id===annual.id);assert.ok(own&&another);
 await adminAction(staff,own.id,{action:'refund',reason:'Synthetic cross-owner denial',paymentId:another.payments[0].paymentId},command(),422);
 const refundKey=command(),refundBody={action:'refund',reason:'Synthetic partial refund acceptance',paymentId:own.payments[0].paymentId,amount:'1.00'};const receipt=await adminAction(staff,own.id,refundBody,refundKey);assert.equal((await adminAction(staff,own.id,refundBody,refundKey)).id,receipt.id);
 await adminAction(staff,own.id,{...refundBody,amount:'2.00'},refundKey,409);current=await summary(owner);assert.equal(current.plan,'pro');assert.equal(current.cancelAtPeriodEnd,false);
 await adminAction(staff,own.id,{action:'cancel',reason:'Synthetic explicit cancellation'});current=await summary(owner);assert.equal(current.plan,'pro');assert.equal(current.cancelAtPeriodEnd,true);
 const portal=await json('/api/v1/billing/portal',owner,{method:'POST',headers:writes(owner)},201);schema('Redirect',portal);const portalSession=await inspect(owner,portal.url);assert.equal(portalSession.kind,'portal');await demo(owner,portalSession.id,'resume');assert.equal((await summary(owner)).cancelAtPeriodEnd,false);
 console.log('PASS recent-MFA admin isolation, payment ownership, idempotent audited refund, explicit paid-through cancel and owner portal resume.');
 stage='renewal and dispute reconciliation';const priorPaidThrough=(await summary(owner)).paidThrough;await scenario(owner,'renew');assert.ok(Date.parse((await summary(owner)).paidThrough)>Date.parse(priorPaidThrough));await scenario(owner,'dispute');assert.equal((await pool.query("SELECT count(*)::int n FROM billing_dispute WHERE user_id=$1 AND status='needs_response'",[owner.id])).rows[0].n,1);await scenario(owner,'resolve_dispute');assert.equal((await pool.query("SELECT count(*)::int n FROM billing_dispute WHERE user_id=$1 AND status='won'",[owner.id])).rows[0].n,1);
 console.log('PASS renewed paid-through access and current dispute/resolution evidence.');
 stage='grace, unpaid, out-of-order and preservation';
 await scenario(owner,'payment_failed');current=await summary(owner);assert.equal(current.status,'past_due');assert.equal(current.plan,'pro');const grace=current.graceUntil;assert.ok(grace);
 await scenario(owner,'payment_failed');assert.equal((await summary(owner)).graceUntil,grace);
 await scenario(owner,'unpaid');assert.equal((await summary(owner)).plan,'free');
 // Redelivery of old active evidence must fetch current provider truth rather than restore Pro.
 const stalePayload=JSON.parse(Buffer.from(original.rawBody).toString());stalePayload.id=`evt_fake_${command().replaceAll('-','')}`;const staleEvidence=sign(stalePayload);await request('/api/v1/webhooks/stripe',null,{method:'POST',headers:{'Stripe-Signature':staleEvidence.signature},body:staleEvidence.raw},204);assert.equal((await summary(owner)).plan,'free');
 assert.equal((await json(`/api/v1/journal/${journal.id}`,owner)).notes,sentinel);assert.equal((await json('/api/v1/watchlists',owner)).items.length,2);await request('/api/v1/watchlists',owner,{method:'POST',headers:writes(owner),body:JSON.stringify({name:'Denied after downgrade'})},403);await request('/api/v1/me/saved-searches',owner,{method:'POST',headers:writes(owner),body:JSON.stringify({name:'Denied after downgrade',filters:{asset:'stock'}})},403);
 for(const actor of [other,staff]){await request(`/api/v1/journal/${journal.id}`,actor,{},404);await request(`/api/v1/watchlists/${secondList.id}`,actor,{},404);}
 assert.equal((await json('/api/v1/me',owner)).entitlement.plan,'free');const measured=(await pool.query("SELECT event_name,properties FROM product_event WHERE owner_user_id=$1 AND event_name IN ('conversion','churn')",[owner.id])).rows;assert.ok(measured.some(e=>e.event_name==='conversion'));assert.ok(measured.some(e=>e.event_name==='churn'));assert.ok(!JSON.stringify(measured).includes(sentinel));
 await pool.query("UPDATE subscription_entitlement SET plan='pro',valid_until=now()+interval '1 day',provider_account='unrelated-test-account' WHERE user_id=$1",[owner.id]);
 assert.equal((await summary(owner)).plan,'free');assert.equal((await json('/api/v1/me',owner)).entitlement.plan,'free');await request('/api/v1/journal-analytics?tag=review',owner,{},403);await request('/api/v1/exports',owner,{method:'POST',headers:writes(owner),body:JSON.stringify({kind:'journal_analytics'})},403);
 await pool.query("UPDATE subscription_entitlement SET plan='free',valid_until=NULL,provider_account=$2,provider_mode=$3 WHERE user_id=$1",[owner.id,`${provider.provider}:${config.providerAccountId}`,config.mode]);
 console.log('PASS fixed failure grace, unpaid downgrade, stale-event safety, record preservation and actual API quota/private boundaries.');
 for(const path of ['/app/billing','/subscribe/return','/admin/billing']){const actor=path.startsWith('/admin')?staff:owner;const html=(await request(path,actor)).text;stage=`SSR ${path} robots`;assert.match(html,/noindex/);stage=`SSR ${path} private content`;assert.ok(!html.includes(sentinel));stage=`SSR ${path} session secrecy`;assert.ok(!html.includes(actor.token));}stage='SSR public search isolation';assert.equal((await json('/api/v1/publications?q='+sentinel,null)).items.length,0);
 console.log('PASS authenticated billing SSR/noindex and public/private content isolation.');
 // Let transactional notification fanout finish before exact-recipient cleanup.
 await delay(2500);
}catch(error){const line=error?.stack?.match(/verify-p12-live\.mjs:(\d+)/)?.[1];console.error(`FAIL P12 ${stage}: ${error?.name??'Error'}${line?` at driver line ${line}`:''}; credentials and private payloads omitted.`);process.exitCode=1;}
finally{try{await captureAndRemoveMail();await cleanupP08Fixtures(pool,users);assert.equal((await pool.query('SELECT count(*)::int n FROM user_account WHERE id=ANY($1::uuid[])',[users])).rows[0].n,0);console.log('PASS generated P12 billing/identity fixtures and exact-recipient Mailpit cleanup.');}catch{console.error('FAIL scoped P12 fixture cleanup.');process.exitCode=1;}await database.$disconnect();await pool.end();}
