import assert from 'node:assert/strict';
import test from 'node:test';
import { digestDueInstant, dispatchSideEffectDeliveries, processEmailDelivery, zonedLocalTimeToUtc } from '../dist/delivery.js';
import { classifySmtpFailure, createSmtpEmailPort, EmailDeliveryError, isValidSingleMailboxAddress, safeInternalUrl } from '../dist/email.js';

test('digest wall times convert through both New York DST transitions', () => {
  assert.equal(zonedLocalTimeToUtc('2026-03-08', 8, 0, 'America/New_York').toISOString(), '2026-03-08T12:00:00.000Z');
  assert.equal(zonedLocalTimeToUtc('2026-11-01', 8, 0, 'America/New_York').toISOString(), '2026-11-01T13:00:00.000Z');
});

test('quiet hours delay the digest to their local end, including a midnight crossing', () => {
  assert.equal(digestDueInstant({ digestHour:8, quietFrom:'22:00', quietUntil:'08:00' },'2026-10-20','America/New_York').toISOString(),'2026-10-20T12:00:00.000Z');
  assert.equal(digestDueInstant({ digestHour:8, quietFrom:'07:00', quietUntil:'09:00' },'2026-10-20','America/New_York').toISOString(),'2026-10-20T13:00:00.000Z');
  assert.equal(digestDueInstant({ digestHour:23, quietFrom:'22:00', quietUntil:'08:00' },'2026-10-20','America/New_York').toISOString(),'2026-10-20T12:00:00.000Z');
});

test('delivery dispatcher sends a stable ID and stores queue acknowledgment in the same transaction', async () => {
  const id = '00000000-0000-4000-8000-000000000011';
  const calls = [];
  const client = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.includes('SELECT id,channel,attempts FROM side_effect_delivery')) return { rows: [{ id, channel: 'email', attempts: 0 }] };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  let jobArgs;
  const sent = await dispatchSideEffectDeliveries({ connect: async () => client }, async (...args) => { jobArgs = args; return 'queue-job-1'; });
  assert.equal(sent, 1);
  assert.equal(jobArgs[0], 'email.deliver');
  assert.deepEqual(jobArgs[1], { deliveryId: id });
  assert.match(jobArgs[2].id, /^[0-9a-f-]{36}$/i);
  assert.ok(calls.some(call => call.sql.includes("status='queued'") && call.values[1] === jobArgs[2].id));
  assert.ok(calls.some(call => call.sql === 'COMMIT'));
});

test('safe email links stay on allowed internal routes', () => {
  assert.equal(safeInternalUrl('/ideas/public-id', 'https://ideas.invalid'), 'https://ideas.invalid/ideas/public-id');
  assert.equal(safeInternalUrl('/app/settings/notifications', 'https://ideas.invalid'), 'https://ideas.invalid/app/settings/notifications');
  assert.match(safeInternalUrl('/digest/unsubscribe?token=abc', 'https://ideas.invalid'), /^https:\/\/ideas\.invalid\/digest\/unsubscribe\?token=abc$/);
  assert.equal(safeInternalUrl('//evil.invalid/path', 'https://ideas.invalid'), null);
  assert.equal(safeInternalUrl('/api/v1/auth/callback', 'https://ideas.invalid'), null);
  assert.equal(safeInternalUrl('https://evil.invalid', 'https://ideas.invalid'), null);
});

test('local SMTP is restricted to the Mailpit host and production fails closed without verified TLS credentials', () => {
  assert.throws(() => createSmtpEmailPort({ RELEASE_MODE: 'local', SMTP_HOST: 'smtp.example.com', SMTP_PORT: '1025', EMAIL_FROM: 'ideas@example.invalid' }), /LOCAL_SMTP_MUST_USE_MAILPIT/);
  assert.throws(() => createSmtpEmailPort({ RELEASE_MODE: 'public', SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', EMAIL_FROM: 'ideas@example.com' }), /PRODUCTION_SMTP_CONFIGURATION_REQUIRED/);
  const port = createSmtpEmailPort({ RELEASE_MODE: 'local', SMTP_HOST: 'mailpit', SMTP_PORT: '1025', EMAIL_FROM: 'ideas@example.invalid' });
  port.close();
});

test('SMTP accepts exactly one mailbox recipient and rejects address lists before transport', async () => {
  for (const address of ['reader@example.invalid','reader+digest@example.invalid']) assert.equal(isValidSingleMailboxAddress(address),true);
  const addresses=['reader@example.invalid,other@example.invalid','reader@example.invalid;other@example.invalid','Reader <reader@example.invalid>','reader@example.invalid'+String.fromCharCode(13,10)+'Bcc:other@example.invalid','reader@@example.invalid','reader@example'];
  for (const address of addresses) assert.equal(isValidSingleMailboxAddress(address),false,address);
  const port=createSmtpEmailPort({RELEASE_MODE:'local',SMTP_HOST:'mailpit',SMTP_PORT:'1025',EMAIL_FROM:'ideas@example.invalid'});
  try {
    await assert.rejects(port.send({to:'reader@example.invalid,other@example.invalid',from:'ideas@example.invalid',subject:'test',text:'test',html:'test',messageId:'<test@local.invalid>'}),error=>error.code==='INVALID_RECIPIENT_ADDRESS');
  } finally { port.close(); }
});

test('SMTP recipient bounces, authentication failures, and uncertain DATA ACKs have distinct retry classifications', () => {
  const rejected = classifySmtpFailure({ command:'RCPT', responseCode:550 });
  assert.equal(rejected.code,'SMTP_RECIPIENT_REJECTED');
  assert.equal(rejected.uncertain,false);
  const auth = classifySmtpFailure({ command:'AUTH', responseCode:535 });
  assert.equal(auth.code,'SMTP_AUTH_FAILED');
  assert.equal(auth.uncertain,false);
  const data = classifySmtpFailure({ command:'DATA', code:'ETIMEDOUT' });
  assert.equal(data.code,'SMTP_ACK_UNCERTAIN');
  assert.equal(data.uncertain,true);
});

test('recipient RCPT rejection suppresses the owner and becomes terminal; SMTP auth failure does not suppress', async t => {
  const ownerId = '00000000-0000-4000-8000-000000000021';
  const deliveryId = '00000000-0000-4000-8000-000000000022';
  async function run(error, acceptedDbFailure = false) {
    const sideEffect = { id:deliveryId,channel:'email',business_delivery_key:'fixture',status:'pending',attempts:0,max_attempts:5,first_attempt_at:null,owner_user_id:ownerId,category:'security',claimed_at:new Date(),payload:{version:1,template:'transactional_security',recipientUserId:ownerId,category:'security',subject:'Notice',title:'Notice',body:'A generic account notice.',internalUrl:'/app/settings'} };
    const writes = [];
    const client = { query: async (sql,values) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return {rowCount:1,rows:[]};
      if (sql.includes('SELECT id,channel,business_delivery_key,status')) return {rowCount:1,rows:[sideEffect]};
      if (sql.includes("SET status='processing'")) return {rowCount:1,rows:[{id:deliveryId}]};
      writes.push({sql,values}); return {rowCount:1,rows:[]};
    }, release() {} };
    const pool = { connect:async()=>client, query:async(sql,values)=>{
      if (acceptedDbFailure && sql.includes("SET status='succeeded'")) throw new Error('database acknowledgment unavailable');
      writes.push({sql,values});
      if (sql.includes('SELECT u.email,u.status')) return {rowCount:1,rows:[{email:`${ownerId}@example.invalid`,status:'active',email_verified:true,settings:{}}]};
      if (sql.includes('SELECT 1 FROM email_suppression')) return {rowCount:0,rows:[]};
      return {rowCount:1,rows:[]};
    }};
    const email = { send:async()=>{if(error)throw error;return {messageId:'<accepted@local.invalid>',accepted:true};}, close(){} };
    await processEmailDelivery(pool,email,{deliveryId},{appOrigin:'http://localhost:3000',sessionSecret:'test-session-secret-that-is-long-enough-123',releaseMode:'local',emailFrom:'local@example.invalid',authorizeSource:async()=>({available:false})},new Date());
    return writes;
  }
  await t.test('550 recipient',async()=>{
    const writes=await run(new EmailDeliveryError('SMTP_RECIPIENT_REJECTED'));
    assert.ok(writes.some(write=>write.sql.includes('INSERT INTO email_suppression')&&write.values[0]===ownerId));
    assert.ok(writes.some(write=>write.sql.includes("SET status=$3")&&write.values[2]==='failed'));
  });
  await t.test('auth rejection',async()=>{
    const writes=await run(new EmailDeliveryError('SMTP_AUTH_FAILED'));
    assert.ok(!writes.some(write=>write.sql.includes('INSERT INTO email_suppression')));
    assert.ok(writes.some(write=>write.sql.includes("SET status=$3")&&write.values[2]==='failed'));
  });
  await t.test('accepted message with failed DB acknowledgment is quarantined',async()=>{
    const writes=await run(null,true);
    assert.ok(writes.some(write=>write.sql.includes("SET status='uncertain'")&&write.values[0]===deliveryId));
    assert.ok(!writes.some(write=>write.sql.includes("SET status=$3")&&write.values[2]==='pending'));
  });
});
