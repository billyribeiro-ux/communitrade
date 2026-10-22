import type { Pool } from 'pg';
import { type StoragePort, processAvatar } from '@trading/media';

export interface MediaJob { mediaId:string }
export async function processMediaJob(pool:Pool,storage:StoragePort,payload:MediaJob,retryCount=0,retryLimit=5):Promise<void>{
  if(!payload||typeof payload.mediaId!=='string'||!/^[0-9a-f-]{36}$/i.test(payload.mediaId))throw new Error('Invalid media job payload');
  const client=await pool.connect();let inTransaction=false;
  try{
    await client.query('BEGIN');inTransaction=true;
    // Keep this row lock while reading/re-encoding/writing. Purging and any
    // duplicate delivery must wait or skip it so an expired upload cannot be
    // rejected and deleted while a worker is publishing its processed object.
    const result=await client.query('SELECT id,status,purpose,declared_mime,byte_size,quarantine_key,expires_at FROM media WHERE id=$1 FOR UPDATE',[payload.mediaId]);
    if(!result.rowCount){await client.query('COMMIT');inTransaction=false;return;}
    const media=result.rows[0];
    if(media.status==='ready'||media.status==='rejected'||media.status!=='processing'){await client.query('COMMIT');inTransaction=false;return;}
    if(media.expires_at&&new Date(media.expires_at).getTime()<=Date.now()){
      await client.query("UPDATE media SET status='rejected',failure_code='UPLOAD_EXPIRED',processed_key=NULL,updated_at=now() WHERE id=$1 AND status='processing'",[media.id]);
      await client.query('COMMIT');inTransaction=false;
      await storage.deleteObject(String(media.quarantine_key||`${media.id}/quarantine.bin`)).catch(()=>undefined);await storage.deleteObject(`${media.id}/processed.webp`).catch(()=>undefined);return;
    }
    try{
      const raw=await storage.readQuarantined(media.id);
      if(raw.byteLength!==Number(media.byte_size)||raw.byteLength>2*1024*1024)throw new Error('INVALID_SIZE');
      const image=await processAvatar(raw,String(media.declared_mime));
      const processedKey=await storage.putProcessed(media.id,image.bytes);
      const saved=await client.query(`UPDATE media SET status='ready',processed_key=$2,dimensions=$3::jsonb,checksum=$4,failure_code=NULL,expires_at=NULL,updated_at=now() WHERE id=$1 AND status='processing'`,[media.id,processedKey,JSON.stringify({width:image.width,height:image.height}),image.checksum]);
      await client.query('COMMIT');inTransaction=false;
      if(saved.rowCount)await storage.deleteObject(String(media.quarantine_key||`${media.id}/quarantine.bin`)).catch(()=>undefined);
      else await storage.deleteObject(processedKey).catch(()=>undefined);
    }catch(error){
      const code=error instanceof Error&&['INVALID_SIZE','INVALID_MIME','INVALID_IMAGE'].includes(error.message)?error.message:'MEDIA_PROCESSING_FAILED';
      if(code==='MEDIA_PROCESSING_FAILED'&&retryCount<retryLimit){
        await client.query("UPDATE media SET failure_code='MEDIA_PROCESSING_RETRY',updated_at=now() WHERE id=$1 AND status='processing'",[media.id]);
        await client.query('COMMIT');inTransaction=false;throw error;
      }
      if(code==='MEDIA_PROCESSING_FAILED')await client.query("UPDATE media SET status='rejected',failure_code='MEDIA_PROCESSING_FAILED',processed_key=NULL,updated_at=now() WHERE id=$1 AND status='processing'",[media.id]);
      else await client.query(`UPDATE media SET status='rejected',failure_code=$2,processed_key=NULL,updated_at=now() WHERE id=$1 AND status='processing'`,[media.id,code]);
      await client.query('COMMIT');inTransaction=false;
      await storage.deleteObject(String(media.quarantine_key||`${media.id}/quarantine.bin`)).catch(()=>undefined);await storage.deleteObject(`${media.id}/processed.webp`).catch(()=>undefined);
    }
  }finally{if(inTransaction)await client.query('ROLLBACK').catch(()=>undefined);client.release();}
}

/** Enqueue outbox rows before marking delivered. A crash between these steps can safely resend. */
export async function dispatchMediaOutbox(pool:Pool,storage:StoragePort,send:(queue:string,data:MediaJob,options?:Record<string,unknown>)=>Promise<unknown>):Promise<number>{
  const client=await pool.connect();let delivered=0;
  try{await client.query('BEGIN');const events=await client.query(`SELECT e.id,e.aggregate_id,m.quarantine_key FROM outbox_event e JOIN media m ON m.id=e.aggregate_id WHERE e.event_type='media.process' AND e.aggregate_type='media' AND e.status='pending' AND e.available_at<=now() ORDER BY e.created_at LIMIT 25 FOR UPDATE OF e SKIP LOCKED`);
    for(const event of events.rows){try{await send('media.process',{mediaId:event.aggregate_id},{id:String(event.id),retryLimit:5,retryDelay:5,retryBackoff:true,expireInSeconds:86400});await client.query("UPDATE outbox_event SET status='delivered',delivered_at=now(),attempts=attempts+1 WHERE id=$1",[event.id]);delivered++;}
      catch{const failed=await client.query("UPDATE outbox_event SET attempts=attempts+1,status=CASE WHEN attempts+1>=8 THEN 'failed' ELSE status END,available_at=CASE WHEN attempts+1>=8 THEN available_at ELSE now()+make_interval(secs=>LEAST(300,5*(2^LEAST(attempts,6))::int)) END WHERE id=$1 RETURNING status",[event.id]);if(failed.rows[0]?.status==='failed'){const rejected=await client.query("UPDATE media SET status='rejected',failure_code='QUEUE_DISPATCH_FAILED',processed_key=NULL,updated_at=now() WHERE id=$1 AND status='processing' RETURNING id",[event.aggregate_id]);if(rejected.rowCount){if(typeof event.quarantine_key==='string'&&event.quarantine_key)await storage.deleteObject(event.quarantine_key);await storage.deleteObject(`${event.aggregate_id}/processed.webp`);}}}
    }
    await client.query('COMMIT');return delivered;
  }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
}

/** Expired, unattached upload quarantine and rejected records are purged on the worker. */
export async function purgeExpiredUploads(pool:Pool,storage:StoragePort):Promise<number>{
  const client=await pool.connect();let purged=0;
  try{await client.query('BEGIN');const rows=await client.query(`SELECT m.id,m.status,m.purpose,m.quarantine_key,m.processed_key FROM media m WHERE ((m.expires_at<=now() AND m.status IN ('quarantined','processing')) OR (m.status='rejected' AND m.updated_at<=now()-interval '24 hours') OR (m.status='ready' AND m.purpose='avatar' AND m.updated_at<=now()-interval '24 hours' AND NOT EXISTS(SELECT 1 FROM profile p WHERE p.avatar_media_id=m.id))) ORDER BY m.updated_at LIMIT 50 FOR UPDATE OF m SKIP LOCKED`);
    for(const row of rows.rows){
      if(row.status==='processing'){for(const key of [row.quarantine_key,`${row.id}/processed.webp`])if(typeof key==='string'&&key)await storage.deleteObject(key);await client.query("UPDATE media SET status='rejected',failure_code='UPLOAD_EXPIRED',processed_key=NULL,updated_at=now() WHERE id=$1 AND status='processing'",[row.id]);continue;}
      await client.query("UPDATE outbox_event SET status='failed',attempts=attempts+1 WHERE aggregate_type='media' AND aggregate_id=$1 AND status='pending'",[row.id]);
      for(const key of [row.quarantine_key,row.processed_key])if(typeof key==='string'&&key)await storage.deleteObject(key);await client.query('DELETE FROM media WHERE id=$1',[row.id]);purged++;
    }
    await client.query('COMMIT');return purged;
  }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
}
