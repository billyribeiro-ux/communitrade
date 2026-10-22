import {createHmac} from 'node:crypto';
export interface PublicSourceAuthorization{available:boolean;title?:string;url?:string}
/** Service credential is purpose-bound, ID-bound and short-lived. Never use cookies or log it. */
export function createSourceAuthorizer(apiOrigin:string,secret:string,transport:typeof fetch=fetch){
 const base=new URL(apiOrigin);if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.pathname!=='/'||base.search||base.hash||secret.length<32)throw new Error('SOURCE_AUTH_CONFIGURATION_INVALID');
 if(process.env.NODE_ENV==='production'&&base.protocol!=='https:')throw new Error('SOURCE_AUTH_HTTPS_REQUIRED');
 return async(publicationId:string):Promise<PublicSourceAuthorization>=>{
  if(!/^[0-9a-f-]{36}$/i.test(publicationId))throw new Error('INVALID_SOURCE_ID');const seconds=Math.floor(Date.now()/1000),signature=createHmac('sha256',secret).update(`notification-source:v1:${publicationId}:${seconds}`).digest('base64url');
  for(let attempt=0;attempt<2;attempt++)try{
   const response=await transport(new URL('/api/v1/internal/notifications/source',base),{method:'POST',redirect:'error',credentials:'omit',signal:AbortSignal.timeout(5000),headers:{'Content-Type':'application/json','X-Notification-Authorization':`${seconds}.${signature}`},body:JSON.stringify({publicationId})});
   if(!response.ok)throw new Error('SOURCE_AUTH_UNAVAILABLE');const value=await response.json() as PublicSourceAuthorization;
   if(typeof value.available!=='boolean'||value.available&&(typeof value.title!=='string'||typeof value.url!=='string'||!/^\/ideas\/[0-9a-f-]{36}\/[a-z0-9-]+$/.test(value.url)))throw new Error('SOURCE_AUTH_INVALID');return value;
  }catch{if(attempt===1)throw new Error('SOURCE_AUTH_UNAVAILABLE');}
  throw new Error('SOURCE_AUTH_UNAVAILABLE');
 };
}
