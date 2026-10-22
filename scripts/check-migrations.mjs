import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createDatabase } from '../apps/api/dist/database.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for migration verification.');
const db = createDatabase(process.env.DATABASE_URL);
try {
  const applied = await db.$queryRaw`SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations`;
  const folders = (await readdir('prisma/migrations', { withFileTypes: true })).filter(entry => entry.isDirectory());
  for (const folder of folders) {
    const digest = createHash('sha256').update(await readFile(`prisma/migrations/${folder.name}/migration.sql`)).digest('hex');
    const record = applied.find(row => row.migration_name === folder.name && row.finished_at && !row.rolled_back_at);
    if (!record || record.checksum !== digest) throw new Error(`Migration history mismatch: ${folder.name}`);
  }
  if (applied.some(row => !row.rolled_back_at && (!row.finished_at || !folders.some(folder => folder.name === row.migration_name)))) throw new Error('Database has an incomplete or unrecognized migration.');
  console.log(`PASS ${folders.length} applied migration checksums match source history.`);
} finally { await db.$disconnect(); }
