/**
 * Completeness gate for a future human editorial queue. This deliberately has
 * no author performance, win-rate, subscription, or payment inputs: it cannot
 * rank a publication or select it for promotion.
 */
export interface EditorialEligibilityInput {
  kind: 'trade' | 'education';
  title: string | null | undefined;
  thesis: string | null | undefined;
  plan: unknown;
  chart: unknown;
  disclosures: unknown;
  positionState?: string | null;
  hasEntry?: boolean;
  hasFollowUp?: boolean;
  costCoverage?: 'complete' | 'incomplete' | null;
}

export interface EditorialEligibility {
  eligible: boolean;
  reasons: string[];
}

const nonEmptyObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;

/** Evaluate completeness and follow-up only; never use outcomes or performance. */
export function evaluateEditorialEligibility(input: EditorialEligibilityInput): EditorialEligibility {
  const reasons: string[] = [];
  if (!input.title?.trim()) reasons.push('Add a title.');
  if (!input.thesis?.trim()) reasons.push('Add a thesis.');
  if (!nonEmptyObject(input.chart)) reasons.push('Include a saved chart.');
  if (!nonEmptyObject(input.disclosures)) reasons.push('Complete the required disclosures.');

  if (input.kind === 'trade') {
    if (!nonEmptyObject(input.plan)) reasons.push('Complete the trade plan.');
    if (!input.hasEntry) reasons.push('Report an entry or mark the idea never entered.');
    if (!input.hasFollowUp) reasons.push('Add a final exit or reviewed resolution.');
    if (input.positionState !== 'closed' && input.positionState !== 'never_entered') reasons.push('Close or review the position.');
    if (input.positionState === 'closed' && input.costCoverage !== 'complete') reasons.push('Complete reported cost coverage.');
  }

  return { eligible: reasons.length === 0, reasons: reasons.slice(0, 20) };
}
