import assert from 'node:assert/strict';
import test from 'node:test';
import { projectPublicationRenderCandidate, validatePublicationRenderCandidate } from '../src/lib/publication-render-candidate.ts';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const asOf = '2026-10-20T15:00:00.000Z';
const base = () => ({
  jobId: id(1), publicationId: id(2), publicationVersionId: id(3), kind: 'trade', title: 'Frozen candidate', thesis: 'A published explanation.', plan: null,
  chartState: {
    schemaVersion: 1, instrumentId: id(4), metadataVersion: 1, interval: '1d', timezone: 'UTC', session: 'regular', adjustment: 'unadjusted',
    viewport: { from: '2026-10-19T00:00:00.000Z', to: asOf }, indicators: [],
    provenance: { provider: 'Approved feed', asOf, delaySeconds: 900, demo: false }, drawings: [],
  },
  series: {
    instrumentId: id(4), asset: 'stock', symbol: 'XYZ', venue: 'XNYS', currency: 'USD', metadataVersion: 1,
    session: 'regular', adjustment: 'unadjusted', tickSize: '0.01', provider: 'Approved feed', providerReference: 'bars:v1',
    delaySeconds: 900, demo: false, asOf,
    capabilities: { displayPublic: true, displayMember: true, retainBars: true, retainSnapshot: true, newPublishing: true },
  },
  bars: [{ time: asOf, open: '10', high: '12', low: '9', close: '11', volume: '100' }],
  attachments: [{ id: id(5), processedKey: `${id(5)}/processed.webp`, checksum: 'a'.repeat(64), width: 512, height: 512, mime: 'image/webp' }],
  disclosures: { evidence: 'member_reported', providerVerified: false, demo: false, delaySeconds: 900, asOf },
});

test('accepts frozen candidates after schema, capability, source, and processed attachment validation', () => {
  assert.equal(validatePublicationRenderCandidate(base()), true);
});

test('rejects unauthorized capabilities, mismatched source metadata, and arbitrary upload fields', () => {
  const noSnapshot = base();
  noSnapshot.series.capabilities.retainSnapshot = false;
  assert.equal(validatePublicationRenderCandidate(noSnapshot), false);
  const sourceMismatch = base();
  sourceMismatch.series.provider = 'Different feed';
  assert.equal(validatePublicationRenderCandidate(sourceMismatch), false);
  const upload = base();
  upload.clientImage = 'data:image/png;base64,arbitrary';
  assert.equal(validatePublicationRenderCandidate(upload), false);
});

test('rejects malformed bars and attachment storage paths instead of rendering untrusted bytes', () => {
  const badBars = base();
  badBars.bars[0].high = '8';
  assert.equal(validatePublicationRenderCandidate(badBars), false);
  const badAttachment = base();
  badAttachment.attachments[0].processedKey = 'https://example.test/image.webp';
  assert.equal(validatePublicationRenderCandidate(badAttachment), false);
});

test('browser projection allowlists frozen chart data and strips author, attachment, and internal API fields', () => {
  const candidate = base();
  candidate.series.ownerEmail = 'private@example.test';
  candidate.series.capabilities.internalNotes = 'private';
  candidate.bars[0].providerCredential = 'private';
  candidate.disclosures.correctionReason = 'private staff note';
  candidate.correctionRequestId = id(6);
  const projected = projectPublicationRenderCandidate(candidate);
  assert.equal(projected.thesis, '');
  assert.equal(projected.plan, null);
  assert.deepEqual(projected.attachments, []);
  assert.deepEqual(Object.keys(projected.series).sort(), [
    'adjustment', 'asset', 'asOf', 'capabilities', 'currency', 'delaySeconds', 'demo',
    'instrumentId', 'metadataVersion', 'provider', 'providerReference', 'session', 'symbol', 'tickSize', 'venue',
  ].sort());
  assert.deepEqual(Object.keys(projected.disclosures).sort(), ['asOf', 'demo', 'delaySeconds', 'evidence', 'providerVerified'].sort());
  assert.deepEqual(Object.keys(projected.bars[0]).sort(), ['close', 'high', 'low', 'open', 'time', 'volume'].sort());
  assert.equal(JSON.stringify(projected).includes('private'), false);
  assert.equal(JSON.stringify(projected).includes('correctionRequestId'), false);
});

test('event-only correction metadata is validated for internal use and excluded from the renderer payload', () => {
  const candidate = base();
  candidate.publishMode = 'correction';
  candidate.eventOnlyCorrection = true;
  candidate.previousVersionId = id(6);
  candidate.sourceVersionId = id(6);
  candidate.correctionRequestId = id(7);
  assert.equal(validatePublicationRenderCandidate(candidate), true);
  const projected = projectPublicationRenderCandidate(candidate);
  assert.equal('eventOnlyCorrection' in projected, false);
  assert.equal('correctionRequestId' in projected, false);
  const invalid = { ...candidate, eventOnlyCorrection: 'yes' };
  assert.equal(validatePublicationRenderCandidate(invalid), false);
});
