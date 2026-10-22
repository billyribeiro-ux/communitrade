import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { CommandError } from '../http/problem.js';

export interface ContactInput { email: string; category: string; subject: string; message: string; consent: boolean }
export interface ContactReceipt { id: string; reference: string; status: 'open'; category: string; subject: string; createdAt: string; messages: {body: string; createdAt: string; fromStaff: boolean}[] }
export const CONTACT_CONSENT_VERSION = '2026-10-19.draft-1';
export class SupportService {
  constructor(private readonly pool: Pool, private readonly secret: string, readonly allowedOrigin: string) {
    if (secret.length < 32) throw new Error('Contact intake requires a strong principal hashing key.');
    if (new URL(allowedOrigin).origin !== allowedOrigin) throw new Error('Contact origin must be exact.');
  }
  async create(input: ContactInput, key: string, address: string, ownerUserId?: string): Promise<ContactReceipt> {
    const body = { email: input.email.trim().toLowerCase(), category: input.category, subject: input.subject.trim(), message: input.message.trim(), consent: input.consent };
    if (!body.subject || !body.message || !body.consent) throw new CommandError(422, 'INVALID_CONTACT', 'Complete the message and consent notice.');
    const principal = createHmac('sha256', this.secret).update(address).digest('hex');
    const hash = createHash('sha256').update(JSON.stringify({...body,ownerUserId:ownerUserId??null})).digest('hex');
    const client = await this.pool.connect().catch(() => { throw new CommandError(503, 'CONTACT_UNAVAILABLE', 'Your request was not confirmed. Retry with the same form.'); });
    try {
      await client.query('BEGIN');
      if(ownerUserId){const owner=await client.query("SELECT 1 FROM user_account WHERE id=$1 AND status='active' AND email_verified=true AND lower(email)=$2 FOR SHARE",[ownerUserId,body.email]);if(!owner.rowCount)throw new CommandError(422,'CONTACT_EMAIL_MISMATCH','Use your verified account email for a signed-in request.');}
      // Serializes rate limits and duplicate keys across all processes for this principal.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`contact:${principal}`]);
      const previous = await client.query('SELECT request_hash,response_body FROM idempotency_record WHERE actor_key=$1 AND route=$2 AND key=$3 AND expires_at>now()', [principal, '/support', key]);
      if (previous.rowCount) {
        if (previous.rows[0].request_hash !== hash) throw new CommandError(409, 'IDEMPOTENCY_CONFLICT', 'This retry key belongs to a different message.');
        await client.query('COMMIT');
        return previous.rows[0].response_body as ContactReceipt;
      }
      await client.query('DELETE FROM idempotency_record WHERE actor_key=$1 AND route=$2 AND key=$3 AND expires_at<=now()', [principal, '/support', key]);
      const bucket = await client.query(`INSERT INTO rate_limit_bucket(id,principal_hash,route,window_start,counter,expires_at)
        VALUES ($1,$2,'/support',date_trunc('hour',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',1,now()+interval '2 hours')
        ON CONFLICT(principal_hash,route,window_start) DO UPDATE SET counter=rate_limit_bucket.counter+1 RETURNING counter`, [randomUUID(),principal]);
      if (bucket.rows[0].counter > 3) throw new CommandError(429, 'CONTACT_RATE_LIMIT', 'Too many requests. Try again after the current UTC hour.');
      const id = randomUUID();
      const result = await client.query(`INSERT INTO support_ticket(id,category,status,visibility,requester_email,subject,consent_version,consent_at)
        VALUES ($1,$2,'open','private',$3,$4,$5,now()) RETURNING created_at`, [id,body.category,body.email,body.subject,CONTACT_CONSENT_VERSION]);
      const createdAt = (result.rows[0].created_at as Date).toISOString();
      if(ownerUserId)await client.query('UPDATE support_ticket SET requester_user_id=$2 WHERE id=$1',[id,ownerUserId]);
      await client.query("INSERT INTO support_message(id,ticket_id,body,visibility) VALUES($1,$2,$3,'requester')", [randomUUID(),id,body.message]);
      await client.query(`INSERT INTO side_effect_delivery(id,channel,business_delivery_key,status,payload,next_attempt_at,category)
        VALUES($1,'support_email',$2,'pending',$3::jsonb,now(),'account')`,[randomUUID(),`support-receipt:${id}`,JSON.stringify({ticketId:id})]);
      const receipt: ContactReceipt = { id,reference:`TC-${id}`,status:'open',category:body.category,subject:body.subject,createdAt,messages:[{body:body.message,createdAt,fromStaff:false}] };
      await client.query(`INSERT INTO idempotency_record(id,actor_key,route,key,request_hash,response_status,response_body,resource_id,expires_at)
        VALUES($1,$2,'/support',$3,$4,201,$5,$6,now()+interval '24 hours')`, [randomUUID(),principal,key,hash,JSON.stringify(receipt),id]);
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof CommandError) throw error;
      throw new CommandError(503, 'CONTACT_UNAVAILABLE', 'Your request was not confirmed. Retry with the same form.');
    } finally { client.release(); }
  }
}
