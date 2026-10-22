import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createDatabase } from '../dist/database.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('PostgreSQL integration: migrated health probe and idempotent upsert', {
  skip: databaseUrl ? false : 'Set TEST_DATABASE_URL to run the PostgreSQL integration test.',
}, async () => {
  const database = createDatabase(databaseUrl);
  const probeId = `ci-${randomUUID()}`;

  try {
    const firstSeed = await database.foundationProbe.upsert({
      where: { id: 'seed' },
      create: { id: 'seed', label: 'P01 local seed' },
      update: {},
    });
    const repeatedSeed = await database.foundationProbe.upsert({
      where: { id: 'seed' },
      create: { id: 'seed', label: 'P01 local seed' },
      update: {},
    });
    assert.equal(repeatedSeed.id, firstSeed.id);
    assert.equal(repeatedSeed.label, firstSeed.label);

    const probe = await database.foundationProbe.create({
      data: { id: probeId, label: 'CI PostgreSQL integration' },
    });
    assert.equal(probe.id, probeId);

    const rows = await database.$queryRaw`SELECT id FROM foundation_probe WHERE id = ${probeId}`;
    assert.deepEqual(rows, [{ id: probeId }]);
  } finally {
    try {
      await database.foundationProbe.deleteMany({ where: { id: probeId } });
    } finally {
      await database.$disconnect();
    }
  }
});
