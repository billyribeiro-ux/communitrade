import pg from 'pg';
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:3000,query_timeout:5000});
pool.on('error',()=>{});
try{
  const result=await pool.query(`SELECT
    COALESCE((SELECT extract(epoch FROM now()-created_at)::int FROM foundation_probe WHERE id='worker-heartbeat'),2147483647) AS heartbeat_age_seconds,
    (SELECT count(*)::int FROM publication_job WHERE status IN ('pending','running') AND created_at<now()-interval '5 minutes') AS aged_snapshots,
    (SELECT count(*)::int FROM side_effect_delivery WHERE status='uncertain') AS uncertain_deliveries,
    (SELECT count(*)::int FROM billing_operation WHERE status='uncertain') AS uncertain_billing,
    (SELECT count(*)::int FROM privacy_request WHERE status='failed') AS failed_privacy`);
  const metrics=result.rows[0],attention=metrics.heartbeat_age_seconds>60||Object.entries(metrics).some(([k,v])=>k!=='heartbeat_age_seconds'&&Number(v)>0);
  console.log(JSON.stringify({status:attention?'attention_required':'ok',metrics,containsPrivatePayloads:false}));if(attention)process.exitCode=1;
}catch{console.error('Operational check unavailable; details withheld.');process.exitCode=1;}finally{await pool.end();}
