import assert from 'node:assert/strict';
import {randomUUID,createHmac,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {createRequire} from 'node:module';
const mediaRequire=createRequire(new URL('../../../packages/media/package.json',import.meta.url));
const sharp=mediaRequire('sharp');
const contractRequire=createRequire(new URL('../../../packages/contracts/package.json',import.meta.url));
const Ajv=contractRequire('ajv/dist/2020.js').default;const addFormats=contractRequire('ajv-formats').default;
const contract=JSON.parse(await readFile(new URL('../../../contracts/openapi.json',import.meta.url),'utf8'));
const ajv=new Ajv({strict:false,allErrors:true});addFormats(ajv);ajv.addSchema({...contract,$id:'contract'});
const validate=(name,value)=>{const check=ajv.compile({$ref:`contract#/components/schemas/${name}`});if(!check(value))throw new Error(`Response contract invalid: ${name}: ${check.errors?.map(x=>x.instancePath+' '+x.keyword).join(',')}`);};
const input=JSON.parse(await new Promise(resolve=>{let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>data+=part);process.stdin.on('end',()=>resolve(data));}));
if(process.env.RELEASE_MODE!=='local'||!input.personas.synthetic)throw new Error('Refusing nonlocal protocol test.');
const app=process.env.APP_ORIGIN;const issuer=process.env.OIDC_ISSUER;const provider=new URL(issuer).origin;
const pool=new Pool({connectionString:process.env.DATABASE_URL});let stage='initialization';let temporaryPerson;
const decode=value=>value.replaceAll('&amp;','&').replaceAll('&quot;','"').replaceAll('&#39;',"'");
class Jar{
 cookies=new Map();callback;
 async request(url,options={}){
  const logical=new URL(url,app);if(![app,provider,'http://mailpit:8025'].includes(logical.origin))throw new Error('Unexpected test destination');
  const transport=new URL(logical);if(logical.origin===app){transport.hostname='web';transport.port='3000';}
  const headers=new Headers(options.headers);const cookies=[...this.cookies.values()].filter(c=>c.host===logical.hostname&&logical.pathname.startsWith(c.path)).map(c=>`${c.name}=${c.value}`).join('; ');if(cookies)headers.set('cookie',cookies);
  if(logical.origin===app)headers.set('host',new URL(app).host);
  const response=await fetch(transport,{...options,headers,redirect:'manual',signal:AbortSignal.timeout(10000)});
  for(const raw of response.headers.getSetCookie()){
   const [pair,...attributes]=raw.split(';');const index=pair.indexOf('=');const name=pair.slice(0,index),value=pair.slice(index+1);const path=attributes.find(x=>x.trim().toLowerCase().startsWith('path='))?.trim().slice(5)??'/';const key=`${logical.hostname}|${path}|${name}`;
   if(attributes.some(x=>/^\s*max-age=0\s*$/i.test(x)))this.cookies.delete(key);else this.cookies.set(key,{host:logical.hostname,path,name,value});
  }
  if(logical.origin===app&&logical.pathname==='/api/v1/auth/callback')this.callback=logical.href;
  return{response,url:logical.href,text:await response.text()};
 }
 async follow(result){for(let i=0;i<12;i++){if(![302,303,307,308].includes(result.response.status))return result;const location=result.response.headers.get('location');if(!location)throw new Error('Missing redirect');result=await this.request(new URL(location,result.url).href);}throw new Error('Too many protocol redirects');}
 async api(path,{method='GET',body,csrf,key,match,raw,mime}={}){const headers={...(body?{'Content-Type':'application/json'}:{}),...(raw?{'Content-Type':mime}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(key?{'Idempotency-Key':key}:{}),...(match?{'If-Match':`"${match}"`}:{}),...(method!=='GET'?{Origin:app}:{})};return this.request(`${app}/api/v1${path}`,{method,headers,...(raw?{body:raw}:body?{body:JSON.stringify(body)}:{})});}
}
function data(result,status=200){if(result.response.status!==status)throw new Error(`HTTP status ${result.response.status}, expected ${status}: ${JSON.parse(result.text||'{}').code??'unknown'}`);return JSON.parse(result.text);}
function attrs(tag){return Object.fromEntries([...tag.matchAll(/([\w:.-]+)\s*=\s*["']([^"']*)["']/g)].map(x=>[x[1],decode(x[2])]));}
function form(html){const match=html.match(/<form\b([^>]*)>([\s\S]*?)<\/form>/i);if(!match)throw new Error('Expected provider form');const fields={};for(const input of match[2].matchAll(/<input\b[^>]*>/gi)){const a=attrs(input[0]);if(a.name&&!['checkbox','submit','button'].includes(a.type))fields[a.name]=a.value??'';}return{action:attrs(match[1]).action,fields};}
async function submit(jar,page,values){const f=form(page.text);const action=new URL(f.action,page.url);if(action.origin!==provider)throw new Error('Provider credential action left configured issuer origin');return jar.request(action.href,{method:'POST',headers:{Origin:provider,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...f.fields,...values})});}
function otp(secret){const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let value=0,bits=0;const bytes=[];for(const letter of secret){value=(value<<5)|alphabet.indexOf(letter);bits+=5;if(bits>=8){bytes.push((value>>>(bits-8))&255);bits-=8;}}const time=Buffer.alloc(8);time.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const hash=createHmac('sha1',Buffer.from(bytes)).update(time).digest();const offset=hash[19]&15;return String((hash.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');}
async function login(person,{intent='free',jar=new Jar(),stepUp=false}={}){
 let page=await jar.follow(await jar.request(`${app}/api/v1/auth/${stepUp?'step-up':`login?intent=${intent}&returnTo=%2Fapp`}`));
 let passwordSent=false,otpSent=false;
 for(let challenge=0;challenge<3&&new URL(page.url).origin===provider;challenge++){
  const fields=form(page.text).fields;
  if('password' in fields&&!passwordSent){passwordSent=true;page=await jar.follow(await submit(jar,page,{username:person.username,password:person.password}));}
  else if('otp' in fields&&!otpSent){otpSent=true;page=await jar.follow(await submit(jar,page,{otp:otp(person.otpSecret)}));}
  else break;
 }
 if(stepUp&&new URL(page.url).origin===provider)console.log('INFO step-up stopped on provider form:',Object.keys(form(page.text).fields).join(','));
 if(page.response.status===500){try{console.log('INFO redacted transport failure:',JSON.parse(page.text).code??'proxy');}catch{console.log('INFO redacted transport failure: proxy');}}
 if(page.response.status!==200)throw new Error(`Provider flow stopped with ${page.response.status} at ${new URL(page.url).pathname}`);
 if(new URL(page.url).origin!==app)throw new Error(`Provider flow stopped with ${page.response.status} at ${new URL(page.url).pathname}`);
 const meResult=await jar.api('/me');const me=data(meResult);validate('Me',me);return{jar,me,page};
}
async function onboard(user,handle){if(!user.me.onboarded){const result=await user.jar.api('/me/onboarding',{method:'POST',csrf:user.me.csrfToken,body:{handle,displayName:`Synthetic ${handle}`,experience:'experienced',interests:['option','stock','future'],timezone:'America/New_York',termsVersion:'2026-10-19.draft-1',adultUSDeclaration:true}});user.me=data(result,201);validate('Me',user.me);}return user;}
async function asAdmin(path,method='GET',body){const r=await fetch(`${provider}/realms/master/protocol/openid-connect/token`,{method:'POST',body:new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:input.adminUsername,password:input.adminPassword}),signal:AbortSignal.timeout(5000)});if(!r.ok)throw new Error('Fixture admin unavailable');const token=(await r.json()).access_token;const result=await fetch(`${provider}/admin/realms/options-trade-ideas${path}`,{method,headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});if(!result.ok)throw new Error(`Fixture admin operation failed ${result.status}`);return result.status===204?null:result.json();}
async function emailAction(email,subject){
 for(let attempt=0;attempt<100;attempt++){
  const messages=await fetch('http://mailpit:8025/api/v1/messages').then(r=>r.json());
  const found=messages.messages?.find(m=>m.To?.some(to=>to.Address===email)&&(!subject||m.Subject?.toLowerCase().includes(subject)));
  if(found){const message=await fetch(`http://mailpit:8025/api/v1/message/${found.ID}`).then(r=>r.json());const text=message.HTML||message.Text||'';const links=[...text.matchAll(/https?:[^\s<>"']+/g)].map(x=>decode(x[0]));const action=links.find(x=>x.startsWith(provider)&&x.includes('/login-actions/action-token'));if(action)return action;}
  await new Promise(r=>setTimeout(r,100));
 }
 throw new Error('Provider email action was not delivered');
}
try{
 if(!process.env.P04_IDENTITY_ONLY&&!process.env.P04_EMAIL_ONLY){
 stage='owner A code + PKCE + annual intent';const a=await onboard(await login(input.personas.users.owner_a,{intent:'pro_annual'}),'p04_owner_a');await pool.query('UPDATE user_account SET synthetic=true WHERE id=$1',[a.me.user.id]);
 assert.equal(a.me.email,input.personas.users.owner_a.email);assert.ok(a.me.emailVerified);assert.ok(a.jar.callback);assert.match(a.page.url,/intent=pro_annual|interval=year/);
 stage='owner B isolated account';const b=await onboard(await login(input.personas.users.owner_b),'p04_owner_b');await pool.query('UPDATE user_account SET synthetic=true WHERE id=$1',[b.me.user.id]);assert.notEqual(a.me.user.id,b.me.user.id);
 console.log('PASS real Keycloak discovery/code/PKCE callback, verified email and two onboarded owners.');
 stage='session cookie and replay';const cookie=[...a.jar.cookies.values()].find(x=>x.name==='tc_session_dev');assert.ok(cookie?.value);const stored=await pool.query('SELECT token_hash FROM app_session WHERE user_id=$1 ORDER BY issued_at DESC LIMIT 1',[a.me.user.id]);assert.notEqual(stored.rows[0].token_hash,cookie.value);const replay=await a.jar.request(a.jar.callback);assert.ok([400,401].includes(replay.response.status));
 stage='CSRF';const csrfDenied=await a.jar.api('/me/preferences',{method:'PATCH',body:{theme:'light'}});assert.equal(csrfDenied.response.status,403);const pref=data(await a.jar.api('/me/preferences',{method:'PATCH',csrf:a.me.csrfToken,body:{theme:'dark',digestEnabled:false}}));validate('Preference',pref);
 stage='profile public projection';const publicJar=new Jar();let profile=data(await publicJar.api(`/users/${a.me.user.handle}`));validate('Profile',profile);assert.ok(!JSON.stringify(profile).includes(a.me.email));
 const changed=data(await a.jar.api('/me/profile',{method:'PATCH',csrf:a.me.csrfToken,match:profile.revision,body:{bio:'Synthetic options research · no verified returns',links:['https://example.test/research']}}));validate('Profile',changed);assert.equal((await a.jar.api('/me/profile',{method:'PATCH',csrf:a.me.csrfToken,match:profile.revision,body:{bio:'stale'}})).response.status,409);
 assert.equal((await b.jar.api('/me/profile',{method:'PATCH',csrf:b.me.csrfToken,match:1,body:{handle:a.me.user.handle}})).response.status,409);
 console.log('PASS CSRF, revision conflicts, duplicate handles and email-free public profile projection.');
 stage='avatar raw transport';assert.equal((await a.jar.api(`/uploads/${randomUUID()}/content`,{method:'POST',csrf:a.me.csrfToken,raw:Buffer.alloc(2097153),mime:'image/png'})).response.status,400);const raw=await sharp({create:{width:640,height:480,channels:3,background:'#334155'}}).withExifMerge({IFD0:{Artist:'SYNTHETIC_PRIVATE_METADATA'}}).png().toBuffer();
 const target=data(await a.jar.api('/uploads',{method:'POST',csrf:a.me.csrfToken,key:randomUUID(),body:{purpose:'avatar',filename:'synthetic-avatar.png',mime:'image/png',sizeBytes:raw.length}}),201);
 assert.equal((await b.jar.api(`/uploads/${target.id}/content`,{method:'POST',csrf:b.me.csrfToken,raw,mime:'image/png'})).response.status,404);
 assert.equal((await a.jar.api(`/uploads/${target.id}/content`,{method:'POST',csrf:a.me.csrfToken,raw,mime:'image/png'})).response.status,204);
 data(await a.jar.api(`/uploads/${target.id}/complete`,{method:'POST',csrf:a.me.csrfToken,key:randomUUID()}),202);
 let ready;for(let i=0;i<150;i++){const status=data(await a.jar.api(`/media/${target.id}`));validate('Media',status);if(status.status==='ready'){ready=status;break;}if(status.status==='rejected')throw new Error('Synthetic valid image was rejected');await new Promise(r=>setTimeout(r,100));}assert.ok(ready,'worker processed image');
 assert.equal((await publicJar.api(`/media/${target.id}/content`)).response.status,404);assert.equal((await b.jar.api(`/media/${target.id}`)).response.status,404);
 profile=data(await a.jar.api('/me/profile',{method:'PATCH',csrf:a.me.csrfToken,match:changed.revision,body:{avatarMediaId:target.id}}));
 const publicImage=await publicJar.api(`/media/${target.id}/content`);assert.equal(publicImage.response.status,200);assert.match(publicImage.response.headers.get('cache-control'),/no-store/);
 const encoded=await fetch(`http://web:3000/api/v1/media/${target.id}/content`);const output=Buffer.from(await encoded.arrayBuffer());const metadata=await sharp(output).metadata();assert.equal(metadata.format,'webp');assert.equal(metadata.exif,undefined);assert.ok(metadata.width<=512&&metadata.height<=512);
 stage='private SSR';const dashboard=await a.jar.request(`${app}/app`);assert.equal(dashboard.response.status,200);const anonymous=await new Jar().request(`${app}/app`);assert.equal(anonymous.response.status,307);const publicProfilePage=await publicJar.request(`${app}/u/${a.me.user.handle}`);assert.equal(publicProfilePage.response.status,200);assert.ok(!publicProfilePage.text.includes(a.me.email));assert.ok(!publicProfilePage.text.includes(a.me.csrfToken));const marketing=await publicJar.request(app);assert.ok(!marketing.text.includes(a.me.email));assert.ok(!marketing.text.includes(a.me.csrfToken));
 console.log('PASS live upload → durable outbox → real Sharp worker → processed avatar; private bytes and metadata remain protected.');
 stage='avatar removal';profile=data(await a.jar.api('/me/profile',{method:'PATCH',csrf:a.me.csrfToken,match:profile.revision,body:{avatarMediaId:null}}));assert.equal((await publicJar.api(`/media/${target.id}/content`)).response.status,404);
 stage='worker malformed-image rejection and recovery';
 for(const invalid of [Buffer.from('synthetic-not-an-image'),await sharp({create:{width:10001,height:1,channels:3,background:'#334155'}}).png().toBuffer()]){
  const rejected=data(await a.jar.api('/uploads',{method:'POST',csrf:a.me.csrfToken,key:randomUUID(),body:{purpose:'avatar',filename:'synthetic-invalid.png',mime:'image/png',sizeBytes:invalid.length}}),201);
  assert.equal((await a.jar.api(`/uploads/${rejected.id}/content`,{method:'POST',csrf:a.me.csrfToken,raw:invalid,mime:'image/png'})).response.status,204);
  data(await a.jar.api(`/uploads/${rejected.id}/complete`,{method:'POST',csrf:a.me.csrfToken,key:randomUUID()}),202);
  let terminal;for(let i=0;i<150;i++){terminal=data(await a.jar.api(`/media/${rejected.id}`));if(terminal.status==='rejected')break;await new Promise(r=>setTimeout(r,100));}assert.equal(terminal.status,'rejected');assert.equal(terminal.reason,'INVALID_IMAGE');assert.equal((await publicJar.api(`/media/${rejected.id}/content`)).response.status,404);
 }
 console.log('PASS actual worker rejects malformed/oversized-dimension images without public bytes or blocking the account.');
 stage='session owner and logout';const sessions=data(await b.jar.api('/me/sessions'));validate('SessionPage',sessions);assert.equal((await a.jar.api(`/me/sessions/${sessions.items[0].id}`,{method:'DELETE',csrf:a.me.csrfToken})).response.status,404);
 const logout=await asAdmin(`/users/${input.personas.users.owner_b.providerId}/logout`,'POST');assert.equal(logout,null);assert.equal((await b.jar.api('/me')).response.status,401);
 assert.equal((await a.jar.api('/auth/logout-all',{method:'POST',csrf:a.me.csrfToken})).response.status,204);assert.equal((await a.jar.api('/me')).response.status,401);
 console.log('PASS private session ownership, immediate provider backchannel revocation, logout-all and avatar removal.');
 }
 if(!process.env.P04_EMAIL_ONLY){
 stage='administrator initial login';let admin=await onboard(await login(input.personas.users.admin),'p04_admin');await pool.query('UPDATE user_account SET synthetic=true WHERE id=$1',[admin.me.user.id]);const adminGrant=await pool.query("INSERT INTO role_grant(id,user_id,role,grantor_user_id,reason) VALUES($1,$2,'admin',$2,'Synthetic P04 acceptance') ON CONFLICT(user_id,role) DO NOTHING RETURNING id",[randomUUID(),admin.me.user.id]);stage='administrator role re-login';if(adminGrant.rowCount)admin=await login(input.personas.users.admin);stage='administrator step-up';admin=await login(input.personas.users.admin,{jar:admin.jar,stepUp:true});stage='administrator role projection';assert.ok(admin.me.roles.includes('admin'));const assurance=await pool.query('SELECT assurance,mfa_at FROM app_session WHERE user_id=$1 AND revoked_at IS NULL ORDER BY issued_at DESC LIMIT 1',[admin.me.user.id]);stage='administrator stored assurance';assert.equal(assurance.rows[0].assurance,'2');assert.ok(assurance.rows[0].mfa_at);console.log('PASS real provider password + TOTP step-up, opaque-session rotation and SQL admin role.');
 stage='moderator identity';let moderator=await onboard(await login(input.personas.users.moderator),'p04_moderator');await pool.query('UPDATE user_account SET synthetic=true WHERE id=$1',[moderator.me.user.id]);const modGrant=await pool.query("INSERT INTO role_grant(id,user_id,role,grantor_user_id,reason) VALUES($1,$2,'moderator',$3,'Synthetic P04 acceptance') ON CONFLICT(user_id,role) DO NOTHING RETURNING id",[randomUUID(),moderator.me.user.id,admin.me.user.id]);if(modGrant.rowCount)moderator=await login(input.personas.users.moderator);assert.ok(moderator.me.roles.includes('moderator'));assert.ok(!moderator.me.roles.includes('admin'));const moderatorStaff=await moderator.jar.request(`${app}/admin`);assert.equal(moderatorStaff.response.status,200);assert.doesNotMatch(moderatorStaff.text,/href="\/admin\/(?:users|billing|data|jobs|privacy|support)"/);assert.match(moderatorStaff.text,/Verify your staff session/);assert.equal((await moderator.jar.api('/admin/users')).response.status,403);console.log('PASS separate moderator role is server-derived with scoped staff overview and no administrator access.');
 }
 stage='registration and email verification';
 temporaryPerson={email:`p04-registration-${randomUUID()}@example.test`,password:`Aa1!${randomBytes(24).toString('base64url')}`};
 const registered=new Jar();let registration=await registered.follow(await registered.request(`${app}/api/v1/auth/login?screen=signup&intent=free&returnTo=%2Fapp`));
 if(registration.response.status!==200)throw new Error(`Provider flow stopped with ${registration.response.status} at ${new URL(registration.url).pathname}`);
 registration=await registered.follow(await submit(registered,registration,{email:temporaryPerson.email,username:temporaryPerson.email,firstName:'Synthetic',lastName:'Registration',password:temporaryPerson.password,'password-confirm':temporaryPerson.password}));
 assert.equal((await registered.api('/me')).response.status,401);
 registration=await registered.follow(await registered.request(await emailAction(temporaryPerson.email,'verify')));
 if(registration.text.includes('name="password-new"'))registration=await registered.follow(await submit(registered,registration,{'password-new':temporaryPerson.password,'password-confirm':temporaryPerson.password,'logout-sessions':'on'}));
 const registrationResult=await registered.api('/me');if(registrationResult.response.status!==200)console.log('INFO verified provider landing:',new URL(registration.url).pathname,'form:',registration.text.includes('<form')?Object.keys(form(registration.text).fields).join(','):'none','title:',registration.text.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1]?.trim().slice(0,80),'links:',[...registration.text.matchAll(/href=["']([^"']+)["']/g)].map(x=>{try{return new URL(decode(x[1]),registration.url).pathname;}catch{return 'invalid';}}).filter(x=>x.includes('login-actions')).join(','));const registrationMe=data(registrationResult);validate('Me',registrationMe);assert.equal(registrationMe.emailVerified,true);assert.equal(registrationMe.onboarded,false);
 const created=await asAdmin(`/users?email=${encodeURIComponent(temporaryPerson.email)}&exact=true`);temporaryPerson.providerId=created[0].id;temporaryPerson.appId=registrationMe.user.id;
 await pool.query('UPDATE user_account SET synthetic=true WHERE id=$1',[temporaryPerson.appId]);
 console.log('PASS real self-registration, Mailpit verification link and verified onboarding gate.');
 stage='password recovery and credential-change revocation';assert.equal((await registered.api('/me')).response.status,200);
 const recovery=new Jar();let recoverPage=await recovery.follow(await recovery.request(`${app}/api/v1/auth/login?screen=recover&returnTo=%2Fapp`));
 const resetLink=[...recoverPage.text.matchAll(/href=["']([^"']+)["']/g)].map(x=>decode(x[1])).find(x=>x.includes('/login-actions/reset-credentials'));
 assert.ok(resetLink);recoverPage=await recovery.follow(await recovery.request(new URL(resetLink,recoverPage.url).href));
 recoverPage=await recovery.follow(await submit(recovery,recoverPage,{username:temporaryPerson.email}));
 recoverPage=await recovery.follow(await recovery.request(await emailAction(temporaryPerson.email,'reset')));
 assert.ok(recoverPage.text.includes('password-new'));
 const newPassword=`Aa2!${randomBytes(24).toString('base64url')}`;
 recoverPage=await recovery.follow(await submit(recovery,recoverPage,{'password-new':newPassword,'password-confirm':newPassword,'logout-sessions':'on'}));
 assert.equal((await registered.api('/me')).response.status,401);
 const recovered=data(await recovery.api('/me'));validate('Me',recovered);assert.equal(recovered.email,temporaryPerson.email);assert.equal(recovered.emailVerified,true);
 console.log('PASS real recovery email/password form and other-session backchannel revocation.');
 console.log(`PASS P04 live ${process.env.P04_EMAIL_ONLY?'registration/recovery':process.env.P04_IDENTITY_ONLY?'staff identity and registration/recovery':'identity/profile/media'} stages. Browser visual/keyboard acceptance remains blocked.`);
}catch(error){console.error(`FAIL P04 live stage: ${stage}. ${error instanceof Error&&/^(Response contract invalid|HTTP status|Provider flow stopped|Fixture admin operation failed|Fixture admin unavailable)/.test(error.message)?error.message:`Assertion or protocol failure at ${error?.stack?.match(/verify-p04-live\.mjs:(\d+):\d+/)?.[1]??'unknown'}; secrets omitted.`}`);process.exitCode=1;}
finally{
 if(temporaryPerson){try{const people=await asAdmin(`/users?email=${encodeURIComponent(temporaryPerson.email)}&exact=true`);if(people[0])await asAdmin(`/users/${people[0].id}`,'DELETE');if(temporaryPerson.appId){await pool.query('DELETE FROM app_session WHERE user_id=$1',[temporaryPerson.appId]);await pool.query('DELETE FROM user_account WHERE id=$1 AND synthetic=true',[temporaryPerson.appId]);}}catch{console.error('Temporary synthetic registration cleanup needs a retry.');process.exitCode=1;}}
 await pool.end();
}
