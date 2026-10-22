import {cleanupP08Fixtures} from './p08-fixture-cleanup.mjs';

/** P09 reuses the guarded, transactional local history cleanup. Identity and
 * synthetic instrument validation, exclusive locks, trigger restoration, and
 * rollback remain centralized; no production erasure path is introduced. */
export async function cleanupP09Fixtures(pool,userIds,instrumentIds=[]) {
  return cleanupP08Fixtures(pool,userIds,instrumentIds);
}
