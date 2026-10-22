import{readFile,writeFile,mkdir}from'node:fs/promises';import{parseEnv}from'node:util';import{randomBytes}from'node:crypto';
const env={...parseEnv(await readFile('.env.local','utf8')),...process.env};
if(env.RELEASE_MODE!=='local'||env.NODE_ENV==='production')throw new Error('Synthetic identity fixtures require local mode.');
await mkdir('.local',{recursive:true,mode:0o700});
let personas;try{personas=JSON.parse(await readFile('.local/identity-personas.json','utf8'));}catch{personas={synthetic:true,users:{}};}
function base32(bytes){let bits=0,value=0,result='';for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5){result+='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(value>>>(bits-5))&31];bits-=5;}}if(bits)result+='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(value<<(5-bits))&31];return result;}
for(const name of ['owner_a','owner_b','moderator','admin','unverified'])if(!personas.users[name])personas.users[name]={username:`p04_${name}`,email:`p04-${name.replaceAll('_','-')}@example.test`,password:`Aa1!${randomBytes(30).toString('base64url')}`,...(name==='admin'?{otpSecret:base32(randomBytes(20))}:{})};
// Fixture credentials are generated at setup and remain ignored/mode 0600.
await writeFile('.local/identity-personas.json',JSON.stringify(personas,null,2)+'\n',{mode:0o600});
const origin=`http://127.0.0.1:${env.KEYCLOAK_PORT??8080}`;const realm='options-trade-ideas';
const login=await fetch(`${origin}/realms/master/protocol/openid-connect/token`,{method:'POST',body:new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:env.KEYCLOAK_ADMIN,password:env.KEYCLOAK_ADMIN_PASSWORD}),signal:AbortSignal.timeout(5000)});
if(!login.ok)throw new Error('Identity fixture administrator authentication failed.');const token=(await login.json()).access_token;
async function admin(path,method='GET',body){const r=await fetch(`${origin}/admin/realms/${realm}${path}`,{method,headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error(`Identity fixture operation failed (${r.status}).`);return r.status===204||r.headers.get('content-length')==='0'?null:r.headers.get('content-type')?.includes('json')?r.json():null;}
const otpCredential=person=>({type:'otp',userLabel:'Synthetic acceptance TOTP',secretData:JSON.stringify({value:person.otpSecret}),credentialData:JSON.stringify({subType:'totp',digits:6,counter:0,period:30,algorithm:'HmacSHA1',secretEncoding:'BASE32'})});
for(const[name,person]of Object.entries(personas.users)){
 person.username=person.email;
 const existing=await admin(`/users?username=${encodeURIComponent(person.username)}&exact=true`);
 if(existing.length){if(existing[0].attributes?.['tc.synthetic']?.[0]!=='true')throw new Error('Refusing to modify a non-fixture provider user.');person.providerId=existing[0].id;if(name==='admin'){const credentials=await admin(`/users/${person.providerId}/credentials`);if(!credentials.some(item=>item.type==='otp'&&JSON.parse(item.credentialData??'{}').secretEncoding==='BASE32')){await admin(`/users/${person.providerId}/logout`,'POST');for(const credential of credentials.filter(item=>item.type==='otp'))await admin(`/users/${person.providerId}/credentials/${encodeURIComponent(credential.id)}`,'DELETE');await admin(`/users/${person.providerId}`,'PUT',{credentials:[otpCredential(person)]});const repaired=await admin(`/users/${person.providerId}/credentials`);if(!repaired.some(item=>item.type==='otp'&&JSON.parse(item.credentialData??'{}').secretEncoding==='BASE32'))throw new Error('Synthetic administrator TOTP repair could not be verified.');}}continue;}
 const credentials=[{type:'password',value:person.password,temporary:false}];
 if(name==='admin')credentials.push(otpCredential(person));
 await admin('/users','POST',{username:person.username,email:person.email,emailVerified:name!=='unverified',enabled:true,firstName:'Synthetic',lastName:name.replaceAll('_',' '),attributes:{'tc.synthetic':['true']},requiredActions:[],credentials});
 const created=await admin(`/users?username=${encodeURIComponent(person.username)}&exact=true`);person.providerId=created[0].id;
}
await writeFile('.local/identity-personas.json',JSON.stringify(personas,null,2)+'\n',{mode:0o600});
console.log('PASS five local synthetic identity personas provisioned idempotently. Credentials remain in ignored .local/identity-personas.json (0600).');
