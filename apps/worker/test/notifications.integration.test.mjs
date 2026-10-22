import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { processNotificationJob } from '../dist/notifications.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const integration = { skip: databaseUrl ? false : 'Set TEST_DATABASE_URL for PostgreSQL notification fanout acceptance.' };

test('real PostgreSQL fanout honors mute and deduplicates distinct transactional notices by outbox event', integration, async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 3000, query_timeout: 15000 });
  pool.on('error', () => {});
  const author = randomUUID(), recipient = randomUUID();
  const publicationId = randomUUID(), versionId = randomUUID();
  const notificationEventIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const issuer = `https://p11.fanout.${author}.invalid`;
  const insertUser = async (id, label) => pool.query(`INSERT INTO user_account(id,oidc_issuer,oidc_subject,email,email_verified,status,created_at,updated_at)
    VALUES($1::uuid,$2,$3,$4,true,'active',now(),now())`, [id, issuer, id, `${label}-${id}@example.invalid`]);
  const addEvent = async (id, type, aggregateType, aggregateId, revision, payload) => pool.query(`INSERT INTO outbox_event
    (id,event_type,aggregate_type,aggregate_id,revision,payload,status,available_at,attempts,created_at)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,'pending',now(),0,now())`, [id,type,aggregateType,aggregateId,revision,JSON.stringify(payload)]);
  const authorize = async id => ({ available: id === publicationId, url: `/ideas/${id}` });
  const sourceRow = { id:publicationId,author_user_id:author,current_version_id:versionId,terms:{},disclosures:{},state:{} };
  const fanoutPool = {
    query: pool.query.bind(pool),
    async connect() {
      const client = await pool.connect();
      return new Proxy(client, { get(target, property) {
        if (property === 'query') return (sql, values) => String(sql).includes('SELECT p.id,p.author_user_id,p.current_version_id,v.terms,v.disclosures,c.state')
          ? Promise.resolve({ rows:[sourceRow], rowCount:1 }) : target.query.call(target,sql,values);
        const value = Reflect.get(target,property,target);
        return typeof value === 'function' ? value.bind(target) : value;
      }});
    },
  };
  try {
    await insertUser(author, 'author');
    await insertUser(recipient, 'recipient');
    await pool.query('INSERT INTO follow(id,follower_user_id,target_user_id,created_at) VALUES($1,$2,$3,now())', [randomUUID(),recipient,author]);
    await pool.query('INSERT INTO mute(id,user_id,author_id,created_at) VALUES($1,$2,$3,now())', [randomUUID(),recipient,author]);

    const publicationPayload = { publicationId, authorUserId: author, versionId };
    await addEvent(notificationEventIds[0], 'notification.followed_publication','publication',publicationId,1,publicationPayload);
    await processNotificationJob(fanoutPool,{outboxEventId:notificationEventIds[0]},0,5,new Date(),authorize);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM notification WHERE owner_user_id=$1',[recipient])).rows[0].n,0,'muted author activity is suppressed');

    await pool.query('DELETE FROM mute WHERE user_id=$1 AND author_id=$2',[recipient,author]);
    await addEvent(notificationEventIds[1], 'notification.followed_publication','publication',publicationId,2,publicationPayload);
    await processNotificationJob(fanoutPool,{outboxEventId:notificationEventIds[1]},0,5,new Date(),authorize);
    await processNotificationJob(fanoutPool,{outboxEventId:notificationEventIds[1]},0,5,new Date(),authorize);
    assert.equal((await pool.query('SELECT event_count FROM notification WHERE owner_user_id=$1',[recipient])).rows[0].event_count,1,'replaying a committed fanout event is idempotent');

    for (const id of notificationEventIds.slice(2)) await addEvent(id,'notification.transactional','transactional_notification',id,1,
      { recipientUserId: recipient, category:'security', internalUrl:'/app/settings', text:'A synthetic security notice.' });
    for (const id of notificationEventIds.slice(2)) await processNotificationJob(fanoutPool,{outboxEventId:id});
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM notification WHERE owner_user_id=$1 AND category='security'",[recipient])).rows[0].n,2,'separate security outbox events remain separate notices');
  } finally {
    await pool.query('DELETE FROM notification WHERE owner_user_id=ANY($1::uuid[])', [[author,recipient]]);
    await pool.query('DELETE FROM outbox_event WHERE id=ANY($1::uuid[])', [notificationEventIds]);
    await pool.query('DELETE FROM mute WHERE user_id=$1 AND author_id=$2', [recipient,author]);
    await pool.query('DELETE FROM follow WHERE follower_user_id=$1 AND target_user_id=$2', [recipient,author]);
    await pool.query('DELETE FROM preference WHERE user_id=ANY($1::uuid[])', [[author,recipient]]);
    await pool.query('DELETE FROM user_account WHERE id=ANY($1::uuid[])', [[author,recipient]]);
    await pool.end();
  }
});

test('notification enqueue rollback preserves attempt identity and delivery budget',integration,async()=>{
 const {dispatchNotificationOutbox}=await import('../dist/notifications.js'),pool=new pg.Pool({connectionString:databaseUrl,max:3}),id=randomUUID(),seen=[];
 try{
  await pool.query("INSERT INTO outbox_event(id,event_type,aggregate_type,aggregate_id,revision,payload,status,available_at,attempts,created_at) VALUES($1,'notification.transactional','transactional_notification',$1,1,'{}','pending',now()-interval '1 minute',0,now())",[id]);
  let inject=true;
  const isolated={async connect(){const client=await pool.connect();return new Proxy(client,{get(target,key){if(key==='query')return(sql,values)=>{if(String(sql).startsWith('SELECT id,attempts FROM outbox_event'))return target.query.call(target,String(sql).replace('ORDER BY created_at,id LIMIT 25','AND id=$2 ORDER BY created_at,id LIMIT 25'),[...values,id]);if(String(sql).startsWith("UPDATE outbox_event SET status='queued'")&&inject){inject=false;throw new Error('injected acknowledgment loss');}return target.query.call(target,sql,values);};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});}};
  const send=async(_queue,_data,options)=>{seen.push(options.id);};
  await assert.rejects(dispatchNotificationOutbox(isolated,send),/injected acknowledgment loss/);
  assert.deepEqual((await pool.query('SELECT status,attempts FROM outbox_event WHERE id=$1',[id])).rows[0],{status:'pending',attempts:0});
  await dispatchNotificationOutbox(isolated,send);assert.equal(seen[0],seen[1]);assert.equal((await pool.query('SELECT attempts FROM outbox_event WHERE id=$1',[id])).rows[0].attempts,0,'Enqueue acknowledgments must not spend processing attempts');
  await pool.query("UPDATE outbox_event SET status='pending',attempts=1,available_at=now()-interval '1 minute' WHERE id=$1",[id]);await dispatchNotificationOutbox(isolated,send);assert.notEqual(seen[2],seen[1],'A persisted failed attempt can enqueue a fresh job while retaining the same business event');
 }finally{await pool.query('DELETE FROM outbox_event WHERE id=$1',[id]);await pool.end();}
});
