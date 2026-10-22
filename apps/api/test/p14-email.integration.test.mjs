import assert from 'node:assert/strict';
import test from 'node:test';
import {createHmac,randomUUID} from 'node:crypto';
import pg from 'pg';
import {EmailWebhookService,verifyResendWebhook} from '../dist/email/webhook.js';
import {emailSuppressionDigest} from '@trading/config';
import {createApp} from '../dist/app.js';
const secret=`whsec_${Buffer.from('p14 synthetic signature secret only').toString('base64')}`;
const key='p14-stable-suppression-key-with-distinct-entropy';
function sign(body,id=`msg_${randomUUID()}`,timestamp=String(Math.floor(Date.now()/1000))){const raw=Buffer.from(typeof body==='string'?body:JSON.stringify(body));return {raw,headers:{'svix-id':id,'svix-timestamp':timestamp,'svix-signature':`v1,${createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(`${id}.${timestamp}.`).update(raw).digest('base64')}`}};}
test('Resend signatures bind exact raw bytes and reject stale/forged/malformed attempts',()=>{
  const event=sign({type:'email.bounced',data:{}});
  assert.equal(verifyResendWebhook(event.raw,event.headers,secret).id,event.headers['svix-id']);
  assert.throws(()=>verifyResendWebhook(Buffer.from(`${event.raw} `),event.headers,secret));
  assert.throws(()=>verifyResendWebhook(event.raw,{...event.headers,'svix-signature':'v1,notvalid'},secret));
  const stale=sign({},undefined,String(Math.floor(Date.now()/1000)-301));assert.throws(()=>verifyResendWebhook(stale.raw,stale.headers,secret));
  const future=sign({},undefined,String(Math.floor(Date.now()/1000)+301));assert.throws(()=>verifyResendWebhook(future.raw,future.headers,secret));
  const officialRaw=Buffer.from('{"event_type":"ping","data":{"success":true}}');
  assert.equal(verifyResendWebhook(officialRaw,{'svix-id':'msg_loFOjxBNrRLzqYUf','svix-timestamp':'1731705121','svix-signature':'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0='},'whsec_plJ3nmyCDGBKInavdOK15jsl',1731705121000).id,'msg_loFOjxBNrRLzqYUf');
});

test('PostgreSQL and real Nest raw transport: signed provider events dedupe and suppress only their exact recipient', {skip:process.env.TEST_DATABASE_URL?false:'Set TEST_DATABASE_URL'},async()=>{
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:4});pool.on('error',()=>{});
  const id=randomUUID(),other=randomUUID(),email=`p14-${id}@example.invalid`,second=`p14-${other}@example.invalid`,events=[];
  const service=new EmailWebhookService(pool,{secret,from:'sender@example.invalid',suppressionKey:key});let app;
  const body=(type,to=email)=>({type,created_at:new Date().toISOString(),data:{from:'Sender <sender@example.invalid>',to:[to],bounce:{type:'Permanent'},subject:'P14_PRIVATE_PROVIDER_BODY'}});
  try{
    for(const [owner,address]of[[id,email],[other,second]])await pool.query(`INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,created_at,updated_at) VALUES($1::uuid,'https://p14-email.invalid',$1::text,$2,true,'active',now(),now())`,[owner,address]);
    app=await createApp({$queryRaw:async()=>[]},null,{auth:{},emailWebhook:service});await app.listen(0,'127.0.0.1');const origin=await app.getUrl();
    const event=sign(body('email.bounced'));events.push(event.headers['svix-id']);
    const http=async e=>fetch(`${origin}/api/v1/webhooks/resend`,{method:'POST',headers:{...e.headers,'Content-Type':'application/json'},body:e.raw});
    assert.equal((await http(event)).status,204);assert.equal((await http(event)).status,204);
    assert.equal((await pool.query('SELECT reason FROM email_suppression WHERE owner_user_id=$1',[id])).rows[0].reason,'provider_hard_bounce');
    assert.equal((await pool.query('SELECT 1 FROM email_suppression WHERE owner_user_id=$1',[other])).rowCount,0);
    const ledger=await pool.query('SELECT * FROM email_webhook_event WHERE event_id=$1',[events[0]]);assert.equal(ledger.rowCount,1);assert.ok(!JSON.stringify(ledger.rows).includes('P14_PRIVATE_PROVIDER_BODY'));assert.ok(!JSON.stringify(ledger.rows).includes(email));
    const altered=sign(body('email.complained'),events[0]);assert.equal((await http(altered)).status,409);
    const spoofed={...event,raw:Buffer.from(JSON.stringify(body('email.complained',second)))};assert.equal((await http(spoofed)).status,400);
    const transient=body('email.bounced',second);transient.data.bounce.type='Transient';const transientEvent=sign(transient);events.push(transientEvent.headers['svix-id']);assert.equal((await http(transientEvent)).status,204);
    assert.equal((await pool.query('SELECT 1 FROM email_address_suppression WHERE email_hash=$1',[emailSuppressionDigest(second,key)])).rowCount,0);
    const complaint=sign(body('email.complained',second));events.push(complaint.headers['svix-id']);assert.equal((await http(complaint)).status,204);
    assert.equal((await pool.query('SELECT reason FROM email_address_suppression WHERE email_hash=$1',[emailSuppressionDigest(second,key)])).rows[0].reason,'provider_complaint');
    const foreign=body('email.complained');foreign.data.from='other@example.invalid';const wrongSender=sign(foreign);assert.equal((await http(wrongSender)).status,400);
  }finally{
    await app?.close();await pool.query('DELETE FROM email_webhook_event WHERE event_id=ANY($1::text[])',[events]);await pool.query('DELETE FROM email_address_suppression WHERE email_hash=ANY($1::text[])',[[emailSuppressionDigest(email,key),emailSuppressionDigest(second,key)]]);await pool.query('DELETE FROM email_suppression WHERE owner_user_id=ANY($1::uuid[])',[[id,other]]);await pool.query('DELETE FROM user_account WHERE id=ANY($1::uuid[])',[[id,other]]);await pool.end();
  }
});
