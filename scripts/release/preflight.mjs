import {readFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {resolve} from 'node:path';
import {assertProductionRuntime} from '../../packages/config/src/production.ts';

const common=['DATABASE_URL','APP_ORIGIN','SESSION_SECRET','DATA_ENCRYPTION_KEY','PRIVACY_SUPPRESSION_KEY','TRUSTED_INGRESS_SECRET','PUBLICATION_RENDER_HMAC_SECRET','STORAGE_DRIVER','R2_ACCOUNT_ID','R2_BUCKET','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','MARKET_DATA_PROVIDER','BILLING_PROVIDER','BILLING_MODE','BILLING_PROVIDER_ACCOUNT_ID','EMAIL_FROM','EMAIL_FROM_VERIFIED','SMTP_HOST','SMTP_PORT','SMTP_TLS','SMTP_USER','SMTP_PASSWORD','BACKUP_POLICY_REVIEWED','DEPLOYMENT_REVISION'];
export const requiredSettings=Object.freeze({
  api:[...common,'WEB_ORIGIN','OIDC_ISSUER','OIDC_CLIENT_ID','OIDC_CLIENT_SECRET','OIDC_REDIRECT_URI','OIDC_ACCOUNT_URL','TERMS_VERSION','SUPPORT_CONTACT_EMAIL','SUPPORT_CONTACT_MONITORED','RESEND_WEBHOOK_SECRET','DATABENTO_API_KEY','DATABENTO_STOCK_DATASET','DATABENTO_OPTION_DATASET','DATABENTO_FUTURE_DATASET','DATABENTO_SCHEMAS','DATABENTO_APPROVED_CAPABILITIES','DATABENTO_DELAY_SECONDS','DATABENTO_CALENDAR_CONFIG','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','STRIPE_PRICE_PRO_MONTH','STRIPE_PRICE_PRO_YEAR','STRIPE_BILLING_PORTAL_CONFIGURATION_ID','STRIPE_TAX_CONFIGURED','BILLING_LIVE_APPROVED'],
  worker:[...common,'PUBLICATION_API_BASE_URL','PUBLICATION_RENDER_BASE_URL'],
  web:['APP_ORIGIN','PUBLIC_SITE_URL','API_INTERNAL_URL','RELEASE_MODE','WEB_INGRESS_MODE','TRUSTED_INGRESS_SECRET','PUBLICATION_RENDER_HMAC_SECRET'],
  identity:['KC_DB','KC_DB_URL','KC_DB_USERNAME','KC_DB_PASSWORD','KC_HOSTNAME','KC_HOSTNAME_STRICT','KC_PROXY_HEADERS','KC_HTTP_ENABLED','KC_HEALTH_ENABLED','KC_METRICS_ENABLED'],
});

export function preflight(role,env){
  if(!Object.hasOwn(requiredSettings,role))throw new Error('Unknown production role.');
  const missing=requiredSettings[role].filter(key=>!env[key]?.trim());
  const invalid=[];
  const https=key=>{if(!env[key])return;try{const u=new URL(env[key]);if(u.protocol!=='https:'||u.username||u.password||u.hash||/(?:^|\.)(?:test|invalid|localhost)$/.test(u.hostname))invalid.push(key);}catch{invalid.push(key);}};
  let runtimeGuard='not_applicable';
  if(role==='api'||role==='worker'){
    try{assertProductionRuntime({...env,NODE_ENV:'production',RELEASE_MODE:'production'},role);runtimeGuard='passed';}
    catch(error){runtimeGuard=/^Production configuration rejected: [A-Za-z0-9 _.-]+\.$/.test(error.message)?error.message:'Production runtime guard rejected configuration.';}
    if((env.PUBLICATION_RENDER_HMAC_SECRET?.length??0)<32)invalid.push('PUBLICATION_RENDER_HMAC_SECRET');
  }
  if(role==='api'){
    if(env.BILLING_LIVE_APPROVED!=='true')invalid.push('BILLING_LIVE_APPROVED');
    if(env.STRIPE_TAX_CONFIGURED!=='true')invalid.push('STRIPE_TAX_CONFIGURED');
    if(env.TERMS_VERSION?.toLowerCase().includes('draft'))invalid.push('TERMS_VERSION');
  }
  if(role==='web'){
    for(const key of ['APP_ORIGIN','PUBLIC_SITE_URL','API_INTERNAL_URL'])https(key);
    if(env.RELEASE_MODE!=='production')invalid.push('RELEASE_MODE');
    if(env.WEB_INGRESS_MODE!=='vercel')invalid.push('WEB_INGRESS_MODE');
    for(const key of ['TRUSTED_INGRESS_SECRET','PUBLICATION_RENDER_HMAC_SECRET'])if((env[key]?.length??0)<32)invalid.push(key);
  }
  if(role==='identity'){
    https('KC_HOSTNAME');
    if(env.KC_DB!=='postgres')invalid.push('KC_DB');
    if(env.KC_HOSTNAME_STRICT!=='true')invalid.push('KC_HOSTNAME_STRICT');
    if(env.KC_PROXY_HEADERS!=='xforwarded')invalid.push('KC_PROXY_HEADERS');
    if(!env.KC_DB_URL?.startsWith('jdbc:postgresql://')||!/[?&]sslmode=verify-full(?:&|$)/.test(env.KC_DB_URL))invalid.push('KC_DB_URL');
  }
  return {role,status:missing.length||invalid.length||!['passed','not_applicable'].includes(runtimeGuard)?'incomplete':'configuration_present',missing,invalid:[...new Set(invalid)],runtimeGuard,secretValuesIncluded:false,providerConformance:false,releaseApproval:false,note:'Presence is not provider verification, legal approval, DNS/TLS, backups or deployment authorization.'};
}

async function main(){
  const args=process.argv.slice(2);let role,envFile,describe=false;
  for(let i=0;i<args.length;i++){
    if(args[i]==='--role')role=args[++i];else if(args[i]==='--env-file')envFile=args[++i];else if(args[i]==='--describe')describe=true;else throw new Error('Unknown preflight option.');
  }
  if(describe){console.log(JSON.stringify({requiredSettings,allSettingsServerOnly:true,secretValuesIncluded:false},null,2));return;}
  if(!role)throw new Error('Use --role api, worker, web or identity.');
  const env=envFile?parseEnv(await readFile(envFile,'utf8')):process.env;
  const result=preflight(role,env);console.log(JSON.stringify(result,null,2));if(result.status!=='configuration_present')process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===import.meta.filename)main().catch(()=>{console.error('Preflight unavailable; no environment values emitted. Check options and private file access.');process.exitCode=1;});
