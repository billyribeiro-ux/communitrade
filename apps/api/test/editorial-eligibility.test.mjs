import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateEditorialEligibility } from '../dist/positions/editorial-eligibility.js';

test('editorial eligibility depends on completeness and follow-up, never performance', () => {
  const complete = {
    kind: 'trade', title: 'Plan', thesis: 'Setup', plan: { entryPrice: '10' }, chart: { revision: 1 },
    disclosures: { evidence: 'member_reported' }, positionState: 'closed', hasEntry: true, hasFollowUp: true,
    costCoverage: 'complete',
  };
  assert.deepEqual(evaluateEditorialEligibility(complete), { eligible: true, reasons: [] });
  const incomplete = evaluateEditorialEligibility({ ...complete, hasFollowUp: false, costCoverage: 'incomplete' });
  assert.equal(incomplete.eligible, false);
  assert.match(incomplete.reasons.join(' '), /final exit|reviewed resolution/i);
  assert.match(incomplete.reasons.join(' '), /cost coverage/i);
  // Extra unrecognized performance-like data cannot affect the projection.
  assert.deepEqual(evaluateEditorialEligibility({ ...complete, winRate: 1, subscriptionTier: 'pro' }), { eligible: true, reasons: [] });
});

test('education eligibility requires publication completeness but no position follow-up', () => {
  const result = evaluateEditorialEligibility({
    kind: 'education', title: 'Guide', thesis: 'Context', plan: null, chart: { revision: 1 },
    disclosures: { evidence: 'member_reported' },
  });
  assert.deepEqual(result, { eligible: true, reasons: [] });
});
