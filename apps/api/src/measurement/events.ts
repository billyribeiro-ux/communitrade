import {createHash,randomUUID} from 'node:crypto';
import type {Transaction} from '../persistence/transactions.js';
import {CommandError} from '../http/problem.js';
export const ANALYTICS_CONSENT_VERSION='2026-10-20.v1';
export const PRODUCT_EVENT_NAMES=['activation','return','publication','review','report','conversion','churn'] as const;
export type ProductEventName=typeof PRODUCT_EVENT_NAMES[number];
const values:Record<string,readonly string[]>={asset:['stock','option','future'],strategy:['long','short','long_call','long_put','bull_call_debit','bear_put_debit','bull_put_credit','bear_call_credit'],plan:['free','pro'],surface:['dashboard','feed','journal','publish','settings']};
export function productProperties(input:unknown):Record<string,string>{
 if(!input||typeof input!=='object'||Array.isArray(input))throw new CommandError(422,'INVALID_PRODUCT_PROPERTIES');
 const entries=Object.entries(input);if(entries.some(([key,value])=>typeof value!=='string'||!values[key]?.includes(value)))throw new CommandError(422,'INVALID_PRODUCT_PROPERTIES');
 return Object.fromEntries(entries) as Record<string,string>;
}
/** Domain transactions supply opaque business keys; never store private IDs or prose. */
export async function recordProductEvent(tx:Transaction,userId:string,name:ProductEventName,sourceKey:string,properties:Record<string,string>={}){
 if(!PRODUCT_EVENT_NAMES.includes(name)||typeof sourceKey!=='string'||sourceKey.length<1||sourceKey.length>200)throw new CommandError(422,'INVALID_PRODUCT_EVENT');
 await tx.query('SELECT id FROM preference WHERE user_id=$1 FOR SHARE',[userId]);
 const safe=productProperties(properties),key=createHash('sha256').update(JSON.stringify([userId,name,sourceKey])).digest('hex');
 const result=await tx.query(`INSERT INTO product_event(id,owner_user_id,event_name,source_key,properties,consent_version,created_at)
  SELECT $1,u.id,$3,$4,$5::jsonb,$6::varchar,CURRENT_TIMESTAMP FROM user_account u JOIN preference p ON p.user_id=u.id
  WHERE u.id=$2 AND u.status='active' AND u.email_verified=true AND p.settings->>'analyticsConsent'='true' AND p.settings->>'analyticsConsentVersion'=$6::text
  ON CONFLICT(owner_user_id,event_name,source_key) DO NOTHING RETURNING id`,[randomUUID(),userId,name,key,JSON.stringify(safe),ANALYTICS_CONSENT_VERSION]);
 return result.rowCount===1;
}

/** MVP activation: follow three authors/instruments, then contribute within seven days of joining. */
export async function recordActivation(tx:Transaction,userId:string,surface:'feed'|'journal'|'publish'){
 const eligible=await tx.query(`SELECT 1 FROM user_account u WHERE u.id=$1 AND u.created_at>=now()-interval '7 days'
   AND (SELECT count(*) FROM follow f WHERE f.follower_user_id=u.id)>=3`,[userId]);
 if(!eligible.rowCount)return false;
 return recordProductEvent(tx,userId,'activation','follow-three-then-contribute:v1',{surface});
}
