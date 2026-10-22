import {readFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';

const env={...parseEnv(await readFile('.env.local','utf8')),...process.env};
if(env.RELEASE_MODE!=='local'||env.NODE_ENV==='production')throw new Error('Local identity configuration is prohibited outside explicit local mode.');
const port=Number(env.KEYCLOAK_PORT??8080),webPort=Number(env.WEB_PORT??3000);
if(!Number.isInteger(port)||!Number.isInteger(webPort))throw new Error('Invalid local identity ports.');
const origin=`http://localhost:${webPort}`;const issuer=`http://auth.localhost:${port}/realms/options-trade-ideas`;
const adminOrigin=`http://127.0.0.1:${port}`;
const tokenResponse=await fetch(`${adminOrigin}/realms/master/protocol/openid-connect/token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:env.KEYCLOAK_ADMIN,password:env.KEYCLOAK_ADMIN_PASSWORD}),signal:AbortSignal.timeout(5000)});
if(!tokenResponse.ok)throw new Error('Local identity administrator authentication failed.');
const token=(await tokenResponse.json()).access_token;
async function admin(path,method='GET',body){
 const response=await fetch(`${adminOrigin}/admin${path}`,{method,headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw new Error(`Local identity configuration failed (${method} ${path}, status ${response.status}).`);
 return response.status===204||response.headers.get('content-length')==='0'?null:response.headers.get('content-type')?.includes('json')?response.json():null;
}
const alias='options-trade-ideas';
const revocationListener='trading-community-credential-revocation';
const base={realm:alias,displayName:'Trading Community · Local identity',enabled:true,sslRequired:'none',registrationAllowed:true,registrationEmailAsUsername:true,loginWithEmailAllowed:true,duplicateEmailsAllowed:false,verifyEmail:true,resetPasswordAllowed:true,rememberMe:false,passwordPolicy:'length(12) and upperCase(1) and lowerCase(1) and digits(1)',bruteForceProtected:true,failureFactor:5,maxFailureWaitSeconds:900,ssoSessionIdleTimeout:1800,ssoSessionMaxLifespan:43200,accessTokenLifespan:300,actionTokenGeneratedByUserLifespan:600,loginTheme:'trading-community',eventsEnabled:true,eventsExpiration:86400,eventsListeners:['jboss-logging',revocationListener],adminEventsEnabled:true,adminEventsDetailsEnabled:false,smtpServer:{host:'mailpit',port:'1025',from:'identity@example.test',fromDisplayName:'Trading Community local identity',ssl:'false',starttls:'false',auth:'false'},attributes:{'acr.loa.map':JSON.stringify({'1':1,'2':2})}};
const rootExecution=(authenticator,requirement,priority,authenticatorFlow=false)=>({authenticator,requirement,priority,authenticatorFlow,userSetupAllowed:false});
const flows=[
 {alias:'tc-browser',providerId:'basic-flow',topLevel:true,builtIn:false,authenticationExecutions:[rootExecution('auth-cookie','ALTERNATIVE',10),{flowAlias:'tc-auth',requirement:'ALTERNATIVE',priority:20,authenticatorFlow:true,userSetupAllowed:false}]},
 {alias:'tc-auth',providerId:'basic-flow',topLevel:false,builtIn:false,authenticationExecutions:[{flowAlias:'tc-password-loa',requirement:'CONDITIONAL',priority:10,authenticatorFlow:true,userSetupAllowed:false},{flowAlias:'tc-mfa-loa',requirement:'CONDITIONAL',priority:20,authenticatorFlow:true,userSetupAllowed:false}]},
 {alias:'tc-password-loa',providerId:'basic-flow',topLevel:false,builtIn:false,authenticationExecutions:[{...rootExecution('conditional-level-of-authentication','REQUIRED',10),authenticatorConfig:'tc-loa-1'},rootExecution('auth-username-password-form','REQUIRED',20)]},
 {alias:'tc-mfa-loa',providerId:'basic-flow',topLevel:false,builtIn:false,authenticationExecutions:[{...rootExecution('conditional-level-of-authentication','REQUIRED',10),authenticatorConfig:'tc-loa-2'},rootExecution('auth-otp-form','REQUIRED',20)]},
];
const realmResponse=await fetch(`${adminOrigin}/admin/realms/${alias}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000)});
if(realmResponse.status===404){
 await admin('/realms','POST',{...base,authenticationFlows:flows,authenticatorConfig:[{alias:'tc-loa-1',config:{'loa-condition-level':'1','loa-max-age':'43200'}},{alias:'tc-loa-2',config:{'loa-condition-level':'2','loa-max-age':'0'}}],browserFlow:'tc-browser'});
}else if(realmResponse.ok){
 const configured=await admin(`/realms/${alias}/authentication/flows`);
 if(!configured.some(flow=>flow.alias==='tc-browser'))throw new Error('Existing realm lacks the expected P04 flow; preserve it and repair configuration explicitly.');
 await admin(`/realms/${alias}`,'PUT',{...base,browserFlow:'tc-browser'});
}else throw new Error('Cannot inspect local identity realm.');
const configuredRealm=await admin(`/realms/${alias}`);
if(!configuredRealm.eventsListeners?.includes(revocationListener))throw new Error('Credential-change revocation listener is missing; fail closed before using local identity. Rebuild Keycloak and rerun local identity configuration.');
const clients=await admin(`/realms/${alias}/clients?clientId=${encodeURIComponent(env.OIDC_CLIENT_ID)}`);
const logoutUrl='http://api:3001/api/v1/webhooks/oidc/logout';
const client={clientId:env.OIDC_CLIENT_ID,name:'Trading Community',enabled:true,protocol:'openid-connect',publicClient:false,secret:env.OIDC_CLIENT_SECRET,standardFlowEnabled:true,implicitFlowEnabled:false,directAccessGrantsEnabled:false,serviceAccountsEnabled:false,rootUrl:origin,baseUrl:origin,redirectUris:[`${origin}/api/v1/auth/callback`],webOrigins:[origin],attributes:{'pkce.code.challenge.method':'S256','backchannel.logout.url':logoutUrl,'backchannel.logout.session.required':'false','backchannel.logout.revoke.offline.tokens':'true','trading-community.credential-revocation':'true','post.logout.redirect.uris':`${origin}/*`,'acr.loa.map':JSON.stringify({'1':1,'2':2})}};
if(clients.length)await admin(`/realms/${alias}/clients/${clients[0].id}`,'PUT',client);else await admin(`/realms/${alias}/clients`,'POST',client);
const configuredClient=await admin(`/realms/${alias}/clients?clientId=${encodeURIComponent(env.OIDC_CLIENT_ID)}`);
const logoutAttributes=configuredClient[0]?.attributes??{};
if(logoutAttributes['backchannel.logout.url']!==logoutUrl||logoutAttributes['backchannel.logout.session.required']!=='false'||logoutAttributes['trading-community.credential-revocation']!=='true')throw new Error('The application client does not advertise its signed subject-wide logout endpoint; refusing local identity setup.');
const profileConfig=await admin(`/realms/${alias}/users/profile`);
await admin(`/realms/${alias}/users/profile`,'PUT',{...profileConfig,unmanagedAttributePolicy:'ADMIN_EDIT'});
const discovery=await fetch(`${adminOrigin}/realms/${alias}/.well-known/openid-configuration`,{signal:AbortSignal.timeout(5000)}).then(response=>response.json());
if(discovery.issuer!==issuer)throw new Error('Configured discovery issuer does not match browser/container authority.');
console.log('PASS local realm/client: registration, verified email, recovery, PKCE, conditional MFA, Mailpit and backchannel logout configured. Existing users preserved.');
