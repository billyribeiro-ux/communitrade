type Environment=Readonly<Record<string,string|undefined>>;
export function isProductionRuntime(env:Environment):boolean{return env.NODE_ENV==='production'||['production','public'].includes((env.RELEASE_MODE??'').toLowerCase());}
export function assertProductionRuntime(env:Environment,role:'api'|'worker'):void{
  if(!isProductionRuntime(env))return;
  const fail=(key:string)=>{throw new Error(`Production configuration rejected: ${key}.`);};
  for(const name of ['SESSION_SECRET','DATA_ENCRYPTION_KEY','PRIVACY_SUPPRESSION_KEY','TRUSTED_INGRESS_SECRET']){
    const value=env[name]??'';
    if(value.length<32||/^(?:dev|test|change|replace|example|local|generate|placeholder)[-_ ]/i.test(value)||new Set(value).size<12)fail(name);
  }
  if(new Set(['SESSION_SECRET','DATA_ENCRYPTION_KEY','PRIVACY_SUPPRESSION_KEY','TRUSTED_INGRESS_SECRET'].map(key=>env[key])).size!==4)fail('independent secret keys');
  const https=(key:string)=>{try{const value=new URL(env[key]??'');if(value.protocol!=='https:'||value.username||value.password||value.hash||/(?:^|\.)(?:localhost|invalid|test)$/.test(value.hostname))fail(key);}catch{fail(key);}};
  https('APP_ORIGIN');
  let database:URL;try{database=new URL(env.DATABASE_URL??'');}catch{fail('DATABASE_URL');return;}
  if(!['postgresql:','postgres:'].includes(database.protocol)||database.searchParams.get('sslmode')!=='verify-full')fail('verified database TLS');
  if(env.STORAGE_DRIVER!=='r2')fail('private durable R2 storage');
  if(env.MARKET_DATA_PROVIDER!=='databento')fail('licensed market data');
  if(env.BILLING_PROVIDER!=='stripe'||env.BILLING_MODE!=='live')fail('live processor scope');
  if(env.SMTP_TLS!=='true'||!env.SMTP_USER||!env.SMTP_PASSWORD||env.SMTP_HOST!=='smtp.resend.com'||env.EMAIL_FROM_VERIFIED!=='true')fail('authenticated production SMTP');
  if(env.BACKUP_POLICY_REVIEWED!=='true'||!env.DEPLOYMENT_REVISION||!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(env.DEPLOYMENT_REVISION))fail('reviewed backup policy and deployment revision');
  if(role==='api'){
    https('OIDC_ISSUER');https('OIDC_REDIRECT_URI');https('OIDC_ACCOUNT_URL');
    if(!env.OIDC_CLIENT_SECRET||(env.OIDC_CLIENT_SECRET.length<32))fail('OIDC_CLIENT_SECRET');
    if(!/^whsec_[A-Za-z0-9+/]{22,}={0,2}$/.test(env.RESEND_WEBHOOK_SECRET??''))fail('signed sender webhook');
    if(env.SUPPORT_CONTACT_MONITORED!=='true'||!env.SUPPORT_CONTACT_EMAIL||/\.(?:invalid|test)$/.test(env.SUPPORT_CONTACT_EMAIL))fail('monitored support');
  }
}
