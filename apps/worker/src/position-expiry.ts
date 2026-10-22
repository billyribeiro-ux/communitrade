import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export interface ExpireOpenPositionsOptions { limit: number }

function withExpiryExclusion(value: unknown): string[] {
  const items = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  return [...new Set([...items, 'expired_unresolved'])];
}

/**
 * Expiration is recorded as unresolved when settlement/assignment evidence is absent.
 * This transition never invents a fill, price, cost, or outcome.
 */
export async function expireOpenPositions(pool: Pool, { limit }: ExpireOpenPositionsOptions): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Expiry sweep limit must be between 1 and 100');
  const client = await pool.connect();
  let transaction = false;
  try {
    await client.query('BEGIN'); transaction = true;
    const selected = await client.query(`SELECT p.id,p.plan,p.remaining_quantity,p.revision,p.public_publication_id,
        pub.current_version_id AS publication_version_id,
        (p.plan->>'expiration')::timestamptz AS expiration,
        (SELECT o.eligibility FROM outcome_snapshot o WHERE o.position_id=p.id ORDER BY o.source_event_cutoff DESC,o.created_at DESC LIMIT 1) AS eligibility,
        (SELECT o.exclusions FROM outcome_snapshot o WHERE o.position_id=p.id ORDER BY o.source_event_cutoff DESC,o.created_at DESC LIMIT 1) AS exclusions
      FROM position p LEFT JOIN publication pub ON pub.id=p.public_publication_id
      WHERE p.state IN ('entered','partially_closed')
        AND p.revision<2147483647
        AND NULLIF(p.plan->>'expiration','') IS NOT NULL
        AND (p.plan->>'expiration')::timestamptz<=CURRENT_TIMESTAMP
      ORDER BY (p.plan->>'expiration')::timestamptz,p.id
      LIMIT $1 FOR UPDATE OF p SKIP LOCKED`, [limit]);
    if (!selected.rows.length) { await client.query('COMMIT'); transaction = false; return 0; }
    const clock = await client.query<{ now: Date }>('SELECT CURRENT_TIMESTAMP AS now');
    const receivedAt = clock.rows[0]?.now ?? new Date();
    for (const position of selected.rows) {
      const expiration = new Date(position.expiration).toISOString();
      const detail = { system: 'claim_window_expired', exclusions: ['expired_unresolved'] };
      await client.query(`INSERT INTO position_event(id,position_id,type,claimed_at,received_at,quantity,price,costs,reason,details)
        VALUES($1,$2,'exception',$3,$4,NULL,NULL,NULL,$5,$6::jsonb)`, [
        randomUUID(), position.id, expiration, receivedAt.toISOString(),
        'Contract expiry passed; settlement or assignment evidence is required.', JSON.stringify(detail),
      ]);
      await client.query(`UPDATE position SET state='unresolved',revision=revision+1,updated_at=$2
        WHERE id=$1 AND state IN ('entered','partially_closed')`, [position.id, receivedAt.toISOString()]);
      await client.query(`INSERT INTO outcome_snapshot(id,position_id,source_event_cutoff,calculation_version,eligibility,exclusions,net,r_multiple,cost_coverage,publication_version_id,created_at)
        VALUES($1,$2,$3,'1',$4,$5::jsonb,NULL,NULL,'incomplete',$6,$3)`, [
        randomUUID(), position.id, receivedAt.toISOString(),
        ['eligible', 'retrospective'].includes(String(position.eligibility)) ? position.eligibility : 'excluded',
        JSON.stringify(withExpiryExclusion(position.exclusions)),
        position.publication_version_id ?? null,
      ]);
    }
    await client.query('COMMIT'); transaction = false;
    return selected.rows.length;
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
