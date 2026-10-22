import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export function createDatabase(databaseUrl: string) {
  return new PrismaClient({ adapter: new PrismaPg({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 1500,
    query_timeout: 1500,
    max: 5,
  }) });
}

export type Database = ReturnType<typeof createDatabase>;
