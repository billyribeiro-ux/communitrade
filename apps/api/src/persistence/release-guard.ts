import type { Database } from '../database.js';

export async function assertNoProductionFixtures(database: Database,
  env: Readonly<Record<string, string | undefined>>) {
  const production = env.NODE_ENV === 'production' || ['production','public'].includes((env.RELEASE_MODE ?? '').toLowerCase());
  if (!production) return;
  const found = await database.$queryRaw<Array<{ synthetic: boolean }>>`SELECT
    EXISTS(SELECT 1 FROM user_account WHERE synthetic)
    OR EXISTS(SELECT 1 FROM instrument WHERE vendor ILIKE '%synthetic%' OR vendor ILIKE '%fixture%')
    OR EXISTS(SELECT 1 FROM data_capability WHERE supplier ILIKE '%synthetic%' OR agreement_id ILIKE '%fixture%') AS synthetic`;
  if (found[0]?.synthetic !== false) throw new Error('Production cannot start with synthetic fixture records.');
  if ((env.MARKET_DATA_PROVIDER ?? '').toLowerCase() !== 'databento') throw new Error('Production requires an approved non-fixture market data provider.');
  if (!env.DATABENTO_API_KEY || !env.DATABENTO_APPROVED_CAPABILITIES || !env.DATABENTO_CALENDAR_CONFIG || !env.DATABENTO_DELAY_SECONDS) throw new Error('Production requires configured provider credentials, database catalog mappings, a calendar, delay, and explicit data-use approvals.');
}
