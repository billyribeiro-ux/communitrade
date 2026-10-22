import type { Pool } from 'pg';
type Grant = {
  asset?: string;
  dataset: string;
  audience: string;
  purpose: string;
  flags: Record<string, boolean>;
};
const permitted = (rows: Grant[], audience: string, purpose: string, flag: string) => rows.some(row => row.audience === audience && row.purpose === purpose && row.flags?.[flag] === true);

/** Verifies the independent market, publication, and calendar rights required for a public release. */
export async function assertProductionDataReady(pool: Pick<Pool, 'query'>, configured: boolean): Promise<void> {
  if (!configured) throw new Error('Production provider credentials, datasets, schemas, and explicit catalog mappings are not fully configured.');
  const grants = (await pool.query(`SELECT i.asset,p.dataset,c.audience,c.purpose,c.flags
    FROM provider_instrument_mapping p JOIN instrument i ON i.id=p.instrument_id
    JOIN data_capability c ON c.supplier=p.supplier AND c.dataset=p.dataset
    WHERE p.supplier='databento' AND p.effective_at<=now() AND (p.revoked_at IS NULL OR p.revoked_at>now())
      AND p.metadata_version=(SELECT MAX(m.version) FROM instrument_metadata_version m WHERE m.instrument_id=p.instrument_id)
      AND c.agreement_id !~* '(synthetic|placeholder|fixture|test)' AND c.effective_at<=now() AND (c.revoked_at IS NULL OR c.revoked_at>now())`)).rows as Grant[];
  const scopeByAsset = new Map<string, Grant[]>(),
    datasetsByAsset = new Map<string, Set<string>>();
  for (const row of grants) {
    const scopes = scopeByAsset.get(row.asset!) ?? [];
    scopes.push(row);
    scopeByAsset.set(row.asset!, scopes);
    const sets = datasetsByAsset.get(row.asset!) ?? new Set<string>();
    sets.add(row.dataset);
    datasetsByAsset.set(row.asset!, sets);
  }
  for (const asset of ['stock', 'option', 'future']) {
    const datasets = datasetsByAsset.get(asset);
    if (!datasets?.size) throw new Error(`Production has no active provider catalog mappings for ${asset}.`);
    for (const dataset of datasets) {
      const rows = grants.filter(row => row.asset === asset && row.dataset === dataset);
      for (const audience of ['public', 'member']) {
        if (!permitted(rows, audience, 'display', audience === 'public' ? 'displayPublic' : 'displayMember')) throw new Error(`Production ${asset} catalog display rights are incomplete for ${audience}.`);
        if (!permitted(rows, audience, 'snapshot', 'retainSnapshot') || !permitted(rows, audience, 'publishing', 'newPublishing')) throw new Error(`Production ${asset} publication/snapshot rights are incomplete for ${audience}.`);
        if (asset !== 'option' && !permitted(rows, audience, 'chart', 'retainBars')) throw new Error(`Production ${asset} historical-bar rights are incomplete for ${audience}.`);
      }
    }
  }
  const calendar = (await pool.query(`SELECT c.audience,c.purpose,c.flags FROM data_capability c
    WHERE c.supplier='databento' AND c.dataset='calendar' AND c.agreement_id !~* '(synthetic|placeholder|fixture|test)'
      AND c.effective_at<=now() AND (c.revoked_at IS NULL OR c.revoked_at>now())`)).rows as Grant[];
  for (const audience of ['public', 'member']) if (!permitted(calendar, audience, 'display', audience === 'public' ? 'displayPublic' : 'displayMember')) throw new Error(`Production calendar display rights are incomplete for ${audience}.`);
}
