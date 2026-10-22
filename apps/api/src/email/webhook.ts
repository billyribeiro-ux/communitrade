import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import type {Pool} from 'pg';
import {emailSuppressionDigest} from '@trading/config';
import {CommandError} from '../http/problem.js';

type Headers=Record<string,string|string[]|undefined>;
const mailbox=/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,63}$/;
export function verifyResendWebhook(raw:Uint8Array,headers:Headers,secret:string,now=Date.now()):{id:string;body:Record<string,unknown>} {
  const id=headers['svix-id'],timestamp=headers['svix-timestamp'],signatures=headers['svix-signature'];
  if(!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)||raw.byteLength<1||raw.byteLength>262144
    ||typeof id!=='string'||!/^msg_[A-Za-z0-9_-]{1,190}$/.test(id)
    ||typeof timestamp!=='string'||!/^\d{10}$/.test(timestamp)||Math.abs(now/1000-Number(timestamp))>300
    ||typeof signatures!=='string'||signatures.length>2048)throw new CommandError(400,'INVALID_EMAIL_WEBHOOK');
  const key=Buffer.from(secret.slice(6),'base64');if(key.length<16)throw new CommandError(400,'INVALID_EMAIL_WEBHOOK');
  const expected=createHmac('sha256',key).update(`${id}.${timestamp}.`).update(raw).digest();
  let valid=false;
  for(const signature of signatures.split(' ')){
    if(!/^v1,[A-Za-z0-9+/]{43}=$/.test(signature))continue;
    const candidate=Buffer.from(signature.slice(3),'base64');
    valid=(candidate.length===expected.length&&timingSafeEqual(candidate,expected))||valid;
  }
  if(!valid)throw new CommandError(400,'INVALID_EMAIL_WEBHOOK');
  try {const body=JSON.parse(Buffer.from(raw).toString('utf8'));if(!body||typeof body!=='object'||Array.isArray(body))throw new Error();return {id,body};}
  catch{throw new CommandError(400,'INVALID_EMAIL_WEBHOOK');}
}

export class EmailWebhookService {
  constructor(private readonly pool:Pool,private readonly config:{secret:string;from:string;suppressionKey:string}){
    if(!mailbox.test(config.from)||config.suppressionKey.length<32||!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(config.secret))throw new Error('Email webhook configuration invalid.');
  }
  async receive(raw:Uint8Array,headers:Headers):Promise<void>{
    const {id,body}=verifyResendWebhook(raw,headers,this.config.secret);
    if(typeof body.type!=='string'||!/^email\.[a-z_]{1,60}$/.test(body.type))throw new CommandError(400,'INVALID_EMAIL_WEBHOOK');
    const data=body.data as Record<string,unknown>|undefined;
    const actionable=body.type==='email.complained'||body.type==='email.bounced';
    let recipient:string|undefined,reason:string|undefined;
    if(actionable){
      if(!data||typeof data!=='object'||Array.isArray(data)||!Array.isArray(data.to)||data.to.length!==1||typeof data.to[0]!=='string'||!mailbox.test(data.to[0])||data.to[0].length>254||typeof data.from!=='string')throw new CommandError(400,'INVALID_EMAIL_WEBHOOK');
      // Resend may return a display name. Accept only its one exact configured sender.
      const sender=data.from.match(/^(?:[^<>\r\n]{1,100} <)?([^<>\s]+@[^<>\s]+)>?$/)?.[1];
      if(sender?.toLowerCase()!==this.config.from.toLowerCase())throw new CommandError(400,'EMAIL_WEBHOOK_SENDER_MISMATCH');
      recipient=data.to[0].toLowerCase();
      const bounce=data.bounce as Record<string,unknown>|undefined;
      if(body.type==='email.complained')reason='provider_complaint';
      else if(bounce?.type==='Permanent')reason='provider_hard_bounce';
      // Transient/unknown bounce classes cannot permanently suppress a recipient.
    }
    const hash=createHash('sha256').update(raw).digest('hex'),client=await this.pool.connect();
    try{
      await client.query('BEGIN');
      const inserted=await client.query(`INSERT INTO email_webhook_event(provider,event_id,payload_hash,event_type) VALUES('resend',$1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id`,[id,hash,body.type]);
      if(!inserted.rowCount){const previous=await client.query("SELECT payload_hash FROM email_webhook_event WHERE provider='resend' AND event_id=$1",[id]);if(previous.rows[0]?.payload_hash!==hash)throw new CommandError(409,'EMAIL_WEBHOOK_REPLAY_CONFLICT');}
      else if(recipient&&reason){
        await client.query(`INSERT INTO email_address_suppression(email_hash,reason) VALUES($1,$2) ON CONFLICT(email_hash) DO UPDATE SET reason=EXCLUDED.reason`,[emailSuppressionDigest(recipient,this.config.suppressionKey),reason]);
        await client.query(`INSERT INTO email_suppression(owner_user_id,reason) SELECT id,$2 FROM user_account WHERE lower(email)=$1 AND status='active'
          ON CONFLICT(owner_user_id) DO UPDATE SET reason=EXCLUDED.reason,updated_at=now()`,[recipient,reason]);
      }
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
  }
}
