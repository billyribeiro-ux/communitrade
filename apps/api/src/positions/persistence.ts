import { randomUUID } from 'node:crypto';
import { calculatePosition, decimal, type TradePlan } from '@trading/domain';
import type { PoolClient } from 'pg';
import { CommandError } from '../http/problem.js';

export interface PublishedPositionLegReference {
  instrumentId: string;
  metadataVersionId: string;
  side: 'buy' | 'sell';
  quantity: number;
}

export interface InitializePublishedPositionArgs {
  ownerUserId: string;
  publicationId: string;
  sourceVersionId: string;
  primaryInstrumentId: string;
  primaryMetadataVersionId: string;
  /** Plan values and metadata have already been loaded and validated by the publication command. */
  plan: TradePlan;
  legReferences: PublishedPositionLegReference[];
}

export interface InitializedPosition {
  positionId: string;
  initialRisk: string;
  calculationVersion: number;
}

/**
 * Adds the single public position to an already-open publication-finalization
 * transaction. It intentionally does not commit or create an entry event: a
 * published plan begins pending until its author reports an entry.
 */
export async function initializePublishedPosition(client: PoolClient, args: InitializePublishedPositionArgs): Promise<InitializedPosition> {
  const publication = await client.query<{id:string;current_version_id:string|null}>('SELECT id,current_version_id FROM publication WHERE id=$1 AND author_user_id=$2 FOR UPDATE',[args.publicationId,args.ownerUserId]);
  if (!publication.rows[0] || publication.rows[0].current_version_id !== args.sourceVersionId) throw new CommandError(409, 'POSITION_SOURCE_VERSION_MISMATCH');
  if (args.plan.asset !== 'stock' && args.plan.asset !== 'option' && args.plan.asset !== 'future') {
    throw new CommandError(422, 'INVALID_POSITION_PLAN', 'The published plan asset is unsupported.');
  }
  if (args.plan.asset === 'option' && args.legReferences.length !== (args.plan.legs?.length ?? 0)) {
    throw new CommandError(422, 'INVALID_POSITION_LEGS', 'Position contracts must match the published option legs.');
  }
  if (args.plan.asset !== 'option' && args.legReferences.length !== 0) {
    throw new CommandError(422, 'INVALID_POSITION_LEGS', 'Stock and futures positions use their selected instrument directly.');
  }

  // The publication transaction may be retried after a worker restart. Returning
  // its existing position makes initialization safe without a second event or leg.
  const existing = await client.query<{ id: string; owner_user_id: string; initial_risk: string | null }>(
    'SELECT id,owner_user_id,initial_risk::text FROM position WHERE public_publication_id=$1 FOR UPDATE',
    [args.publicationId],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].owner_user_id !== args.ownerUserId) throw new CommandError(409, 'POSITION_OWNER_MISMATCH');
    if (existing.rows[0].initial_risk === null) throw new CommandError(409, 'POSITION_RISK_MISSING');
    return { positionId: existing.rows[0].id, initialRisk: existing.rows[0].initial_risk, calculationVersion: 1 };
  }

  let initialRisk: string;
  try {
    const calculation = calculatePosition({ plan: args.plan, entryCosts: null, exits: [] });
    if (!calculation.initialRisk || decimal(calculation.initialRisk) <= 0n) throw new Error('risk unavailable');
    initialRisk = calculation.initialRisk;
  } catch {
    throw new CommandError(422, 'INITIAL_RISK_UNAVAILABLE', 'The published trade plan does not have a valid positive initial risk.');
  }

  const positionId = randomUUID();
  await client.query(`INSERT INTO position
    (id,owner_user_id,public_publication_id,state,plan,instrument_id,metadata_version_id,remaining_quantity,initial_risk,calculation_version,revision,risk_source_version_id,created_at,updated_at)
    VALUES($1,$2,$3,'pending',$4::jsonb,$5,$6,$7,$8,'1',1,$9,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`, [
    positionId,
    args.ownerUserId,
    args.publicationId,
    JSON.stringify(args.plan),
    args.primaryInstrumentId,
    args.primaryMetadataVersionId,
    args.plan.quantity,
    initialRisk,
    args.sourceVersionId,
  ]);

  for (const [index, reference] of args.legReferences.entries()) {
    const planned = args.plan.legs?.[index];
    if (!planned || reference.quantity !== planned.quantity
      || reference.side !== (planned.side === 'long' ? 'buy' : 'sell')) {
      throw new CommandError(422, 'INVALID_POSITION_LEGS', 'Position contracts must match the published option strategy.');
    }
    await client.query(`INSERT INTO position_leg(id,position_id,instrument_id,metadata_version_id,side,quantity)
      VALUES($1,$2,$3,$4,$5,$6)`, [randomUUID(), positionId, reference.instrumentId, reference.metadataVersionId, planned.side, reference.quantity]);
  }

  return { positionId, initialRisk, calculationVersion: 1 };
}
