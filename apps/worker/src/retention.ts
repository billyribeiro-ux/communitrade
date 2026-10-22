import type { Pool } from 'pg';

/** Deletes only expired first-party product events; never reads or logs event properties. */
export async function purgeExpiredProductEvents(pool: Pool, now = new Date(), limit = 1000): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new RangeError('PRODUCT_EVENT_PURGE_LIMIT_INVALID');
  const result = await pool.query(`WITH expired AS (
      SELECT id FROM product_event WHERE created_at < $1::timestamptz - interval '90 days'
      ORDER BY created_at,id LIMIT $2
    ) DELETE FROM product_event e USING expired x WHERE e.id=x.id`, [now,limit]);
  return result.rowCount ?? 0;
}

/** Bounded operational replay retention; never removes address suppression. */
export async function purgeOperationalReplay(pool:Pool):Promise<void>{
  await pool.query(`DELETE FROM trusted_ingress_nonce WHERE nonce IN (SELECT nonce FROM trusted_ingress_nonce WHERE expires_at<now() LIMIT 10000)`);
  await pool.query(`DELETE FROM email_webhook_event WHERE (provider,event_id) IN (SELECT provider,event_id FROM email_webhook_event WHERE received_at<now()-interval '30 days' LIMIT 1000)`);
}
