import type { components } from '@trading/contracts';
import { validateTradePlan, type TradePlan, type AssetClass, type FuturesRoot } from '@trading/domain';
import { CommandError } from '../http/problem.js';

type ApiPlan = components['schemas']['TradePlan'];
export interface ReferenceInstrument {
  id: string;
  asset: AssetClass;
  symbol: string;
  currency: string;
  enabled: boolean;
  underlyingId?: string | null;
  metadata: {
    id: string;
    version: number;
    multiplier: string;
    tickSize: string;
    expiry?: string | null;
    strike?: string | null;
    optionType?: 'call' | 'put' | null;
    root?: FuturesRoot | null;
    contractMonth?: number | null;
    contractYear?: number | null;
    adjusted?: boolean;
  };
}

/** Hydrates the canonical API's contract IDs using trusted, immutable catalog
 * snapshots. Client supplied strikes, multipliers and expirations are never used. */
export function hydrateTradePlan(input: ApiPlan, references: ReadonlyMap<string, ReferenceInstrument>, asOf: string) {
  const get = (id: string) => {
    const value = references.get(id);
    if (!value || !value.enabled || value.currency !== 'USD' || !Number.isInteger(value.metadata.version) || value.metadata.version < 1) throw new CommandError(422, 'INVALID_INSTRUMENT_REFERENCE');
    return value;
  };
  const primary = get(input.instrumentId);
  const option = input.asset === 'option';
  if (primary.asset !== (option ? 'stock' : input.asset)) throw new CommandError(422, 'INSTRUMENT_ASSET_MISMATCH');
  const expectedPriceKind = input.asset === 'stock' ? 'underlying' : input.asset === 'future' ? 'futures'
    : input.strategy.endsWith('debit') ? 'spread_debit' : input.strategy.endsWith('credit') ? 'spread_credit' : 'option_premium';
  if (input.priceKind !== expectedPriceKind) throw new CommandError(422, 'PRICE_KIND_MISMATCH');
  if (!option && input.legs.length !== 0) throw new CommandError(422, 'UNEXPECTED_OPTION_LEGS');
  const resolved = input.legs.map(leg => ({ leg, contract: get(leg.instrumentId) }));
  if (new Set(resolved.map(item => item.contract.id)).size !== resolved.length) throw new CommandError(422, 'DUPLICATE_OPTION_CONTRACT');
  for (const { leg, contract } of resolved) {
    if (contract.asset !== 'option' || contract.underlyingId !== primary.id || leg.quantity !== input.quantity
      || !contract.metadata.expiry || !contract.metadata.strike || !contract.metadata.optionType) throw new CommandError(422, 'INVALID_OPTION_CONTRACT');
  }
  // The API does not impose leg order; normalize to the strategy's long/short pair.
  const firstSide = input.strategy.endsWith('credit') ? 'sell' : 'buy';
  resolved.sort((a, b) => Number(b.leg.side === firstSide) - Number(a.leg.side === firstSide));
  const expiration = option ? resolved[0]?.contract.metadata.expiry : primary.metadata.expiry;
  const plan: TradePlan = {
    asset: input.asset, strategy: input.strategy, quantity: input.quantity, entryPrice: input.entryPrice,
    entryFrom: input.entryFrom, entryUntil: input.entryUntil,
    ...(input.initialStopPrice === undefined ? {} : { initialStopPrice: input.initialStopPrice }),
    ...(expiration ? { expiration } : {}),
    instrument: {
      asset: input.asset, symbol: primary.symbol, currency: primary.currency,
      multiplier: option ? '100' : primary.metadata.multiplier,
      tickSize: primary.metadata.tickSize, metadataVersion: primary.metadata.version, enabled: primary.enabled,
      ...(primary.metadata.root ? { root: primary.metadata.root } : {}),
      adjusted: primary.metadata.adjusted ?? false,
    },
    legs: resolved.map(({ leg, contract }) => ({
      side: leg.side === 'buy' ? 'long' as const : 'short' as const,
      quantity: leg.quantity, strike: contract.metadata.strike!, optionType: contract.metadata.optionType!,
      expiration: contract.metadata.expiry!, underlyingId: primary.id,
      multiplier: contract.metadata.multiplier, adjusted: contract.metadata.adjusted ?? false,
    })),
  };
  const issues = validateTradePlan(plan, asOf);
  if (issues.length) throw new CommandError(422, 'INVALID_TRADE_PLAN', 'The selected contracts or plan do not meet the supported trade rules.', issues.map(issue => ({ path: 'plan', message: issue.message })));
  return {
    plan,
    referenceVersions: [primary, ...resolved.map(item => item.contract)].map(instrument => ({
      instrumentId: instrument.id, metadataVersionId: instrument.metadata.id, metadataVersion: instrument.metadata.version,
    })),
  };
}
