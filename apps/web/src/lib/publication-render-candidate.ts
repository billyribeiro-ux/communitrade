import { validateChartState, type components } from '@trading/contracts';

export type SnapshotChartState = components['schemas']['ChartState'];
export type SnapshotBar = { time: string; open: string; high: string; low: string; close: string; volume?: string };

export interface PublicationRenderCandidate {
  readonly jobId: string;
  readonly publicationId: string;
  readonly publicationVersionId: string;
  readonly kind: 'trade' | 'education';
  readonly title: string;
  readonly thesis: string;
  readonly plan: components['schemas']['TradePlan'] | null;
  readonly chartState: SnapshotChartState;
  readonly series: {
    readonly instrumentId: string;
    readonly asset: 'stock' | 'future';
    readonly symbol: string;
    readonly venue: string;
    readonly currency: string;
    readonly metadataVersion: number;
    readonly session: 'regular' | 'exchange';
    readonly adjustment: 'unadjusted';
    readonly tickSize: string;
    readonly contractMonth?: string;
    readonly root?: string;
    readonly provider: string;
    readonly providerReference: string;
    readonly delaySeconds: number;
    readonly demo: boolean;
    readonly asOf: string;
    readonly capabilities: {
      readonly displayPublic: boolean;
      readonly displayMember: boolean;
      readonly retainBars: boolean;
      readonly retainSnapshot: boolean;
      readonly newPublishing: boolean;
    };
  };
  readonly bars: readonly SnapshotBar[];
  readonly attachments: readonly { id: string; processedKey: string; checksum: string; width: number; height: number; mime: 'image/webp' }[];
  readonly disclosures: { evidence: 'member_reported'; providerVerified: false; demo: boolean; delaySeconds: number; asOf: string };
}

/** Explicit allowlist for the data serialized into the isolated browser page. */
export function projectPublicationRenderCandidate(candidate: PublicationRenderCandidate): PublicationRenderCandidate {
  return {
    jobId: candidate.jobId,
    publicationId: candidate.publicationId,
    publicationVersionId: candidate.publicationVersionId,
    kind: candidate.kind,
    title: candidate.title,
    thesis: '',
    plan: null,
    chartState: candidate.chartState,
    series: {
      instrumentId: candidate.series.instrumentId,
      asset: candidate.series.asset,
      symbol: candidate.series.symbol,
      venue: candidate.series.venue,
      currency: candidate.series.currency,
      metadataVersion: candidate.series.metadataVersion,
      session: candidate.series.session,
      adjustment: candidate.series.adjustment,
      tickSize: candidate.series.tickSize,
      ...(candidate.series.contractMonth === undefined ? {} : { contractMonth: candidate.series.contractMonth }),
      ...(candidate.series.root === undefined ? {} : { root: candidate.series.root }),
      provider: candidate.series.provider,
      providerReference: candidate.series.providerReference,
      delaySeconds: candidate.series.delaySeconds,
      demo: candidate.series.demo,
      asOf: candidate.series.asOf,
      capabilities: {
        displayPublic: candidate.series.capabilities.displayPublic,
        displayMember: candidate.series.capabilities.displayMember,
        retainBars: candidate.series.capabilities.retainBars,
        retainSnapshot: candidate.series.capabilities.retainSnapshot,
        newPublishing: candidate.series.capabilities.newPublishing,
      },
    },
    bars: candidate.bars.map((bar) => ({
      time: bar.time,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      ...(bar.volume === undefined ? {} : { volume: bar.volume }),
    })),
    attachments: [],
    disclosures: {
      evidence: 'member_reported',
      providerVerified: false,
      demo: candidate.disclosures.demo,
      delaySeconds: candidate.disclosures.delaySeconds,
      asOf: candidate.disclosures.asOf,
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL = /^-?[0-9]{1,18}(?:\.[0-9]{1,10})?$/;
// Reject control bytes so source metadata cannot place terminal controls in canvas labels.
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const CANDIDATE_KEYS = new Set(['jobId', 'publicationId', 'publicationVersionId', 'kind', 'title', 'thesis', 'plan', 'chartState', 'series', 'bars', 'attachments', 'disclosures', 'referenceVersions', 'domainPlan', 'publishMode', 'previousVersionId', 'sourceVersionId', 'correctionRequestId', 'replacementEvent', 'eventOnlyCorrection']);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeLabel(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !CONTROL.test(value);
}

function safeUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const canonical = new Date(timestamp).toISOString();
  return value === canonical || value === canonical.replace('.000Z', 'Z');
}

/** Runtime boundary for the frozen API candidate; the renderer never accepts browser-posted data. */
export function validatePublicationRenderCandidate(value: unknown): value is PublicationRenderCandidate {
  if (!record(value) || Object.keys(value).some((key) => !CANDIDATE_KEYS.has(key))
      || !UUID.test(String(value.jobId)) || !UUID.test(String(value.publicationId)) || !UUID.test(String(value.publicationVersionId))) return false;
  if (!['trade', 'education'].includes(String(value.kind)) || !safeLabel(value.title, 120) || !safeLabel(value.thesis, 10_000)) return false;
  if (value.publishMode !== undefined && !['initial', 'correction'].includes(String(value.publishMode))) return false;
  if (value.eventOnlyCorrection !== undefined && (typeof value.eventOnlyCorrection !== 'boolean' || value.publishMode !== 'correction')) return false;
  for (const key of ['previousVersionId', 'sourceVersionId', 'correctionRequestId']) {
    if (value[key] !== undefined && !UUID.test(String(value[key]))) return false;
  }
  if (!validateChartState(value.chartState) || !record(value.series) || !record(value.series.capabilities)) return false;
  const series = value.series;
  const caps = series.capabilities as Record<string, unknown>;
  const chartState = value.chartState as SnapshotChartState;
  if (!UUID.test(String(series.instrumentId)) || chartState.instrumentId !== series.instrumentId
      || chartState.metadataVersion !== series.metadataVersion || chartState.session !== series.session || chartState.adjustment !== series.adjustment
      || chartState.provenance.provider !== series.provider || chartState.provenance.demo !== series.demo
      || !['stock', 'future'].includes(String(series.asset))
      || !safeLabel(series.symbol, 40) || !safeLabel(series.venue, 40) || !safeLabel(series.currency, 8)
      || !Number.isSafeInteger(series.metadataVersion) || !['regular', 'exchange'].includes(String(series.session))
      || series.adjustment !== 'unadjusted' || typeof series.tickSize !== 'string' || !DECIMAL.test(series.tickSize)
      || (series.contractMonth !== undefined && !/^\d{4}-\d{2}$/.test(String(series.contractMonth)))
      || (series.root !== undefined && !safeLabel(series.root, 16))
      || !safeLabel(series.provider, 64) || !safeLabel(series.providerReference, 200)
      || !Number.isFinite(series.delaySeconds) || Number(series.delaySeconds) < 0
      || typeof series.demo !== 'boolean' || !safeUtc(series.asOf)) return false;
  if (caps.displayPublic !== true || caps.retainSnapshot !== true || typeof caps.displayMember !== 'boolean'
      || typeof caps.retainBars !== 'boolean' || typeof caps.newPublishing !== 'boolean') return false;
  if (!Array.isArray(value.bars) || value.bars.length < 1 || value.bars.length > 10_000) return false;
  let previous = -Infinity;
  for (const bar of value.bars) {
    if (!record(bar) || !safeUtc(bar.time)
        || !['open', 'high', 'low', 'close'].every((key) => typeof bar[key] === 'string' && DECIMAL.test(bar[key] as string))) return false;
    const time = Date.parse(bar.time);
    const open = Number(bar.open); const high = Number(bar.high); const low = Number(bar.low); const close = Number(bar.close);
    const volume = bar.volume === undefined ? 0 : Number(bar.volume);
    if (!Number.isFinite(time) || time <= previous || ![open, high, low, close, volume].every(Number.isFinite)
        || high < Math.max(open, close, low) || low > Math.min(open, close, high) || volume < 0
        || (bar.volume !== undefined && (typeof bar.volume !== 'string' || !DECIMAL.test(bar.volume)))) return false;
    previous = time;
  }
  if (!Array.isArray(value.attachments) || value.attachments.length > 3 || !value.attachments.every((attachment) => {
    if (!record(attachment) || Object.keys(attachment).some((key) => !['id', 'processedKey', 'checksum', 'width', 'height', 'mime'].includes(key))) return false;
    return UUID.test(String(attachment.id)) && attachment.processedKey === `${attachment.id}/processed.webp`
      && typeof attachment.checksum === 'string' && /^[0-9a-f]{64}$/.test(attachment.checksum)
      && Number.isSafeInteger(attachment.width) && Number(attachment.width) > 0 && Number(attachment.width) <= 10_000
      && Number.isSafeInteger(attachment.height) && Number(attachment.height) > 0 && Number(attachment.height) <= 10_000
      && attachment.mime === 'image/webp';
  })) return false;
  if (!record(value.disclosures) || value.disclosures.evidence !== 'member_reported' || value.disclosures.providerVerified !== false
      || value.disclosures.demo !== series.demo || value.disclosures.delaySeconds !== series.delaySeconds || value.disclosures.asOf !== series.asOf || !safeUtc(value.disclosures.asOf)) return false;
  return true;
}
