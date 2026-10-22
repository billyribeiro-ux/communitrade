export const HEARTBEAT_ID = "worker-heartbeat";

export interface Queryable {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

export async function writeHeartbeat(db: Queryable, now = new Date()): Promise<void> {
  await db.query(
    `INSERT INTO foundation_probe (id, label, created_at)
     VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, created_at = now()`,
    [HEARTBEAT_ID, now.toISOString()]
  );
}
