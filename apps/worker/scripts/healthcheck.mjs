import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL,
  max: 1, connectionTimeoutMillis: 1500, query_timeout: 1500 });
pool.on('error', () => { process.exitCode = 1; });
try {
  const result = await pool.query(`SELECT EXISTS (
    SELECT 1 FROM foundation_probe WHERE id='worker-heartbeat'
    AND created_at > now() - interval '90 seconds'
  ) AS fresh`);
  if (result.rows[0]?.fresh !== true) process.exitCode = 1;
} catch { process.exitCode = 1; }
finally { await pool.end(); }
