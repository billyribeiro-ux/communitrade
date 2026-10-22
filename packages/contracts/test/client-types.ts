import { createApiClient, type components } from '../dist/index.js';

const client = createApiClient();
const instrumentId = '00000000-0000-4000-8000-000000000000';

const instrument = client.request('getInstrument', { path: { id: instrumentId } });
instrument.then((result) => {
  const typed: components['schemas']['Instrument'] = result.data;
  void typed;
});

client.request('createDraft', {
  headers: { 'Idempotency-Key': '0123456789abcdef', 'X-CSRF-Token': 'csrf' },
  body: { kind: 'trade', asset: 'option' },
});

// @ts-expect-error required idempotency and CSRF headers are part of the operation type
client.request('createDraft', { body: { kind: 'trade' } });
// @ts-expect-error enum values are generated from the request schema
client.request('createDraft', { headers: { 'Idempotency-Key': '0123456789abcdef', 'X-CSRF-Token': 'csrf' }, body: { kind: 'other' } });
// @ts-expect-error operation identifiers are closed over the 122 generated routes
client.request('madeUpOperation', {});

client.request('uploadLocalBytes', {
  path: { id: instrumentId },
  headers: { 'X-CSRF-Token': 'csrf' },
  contentType: 'image/png',
  body: new Uint8Array([1, 2, 3]),
});

const meta: components['schemas']['DataMeta'] = {
  provider: 'fixture', providerReference: 'fixture:catalog', metadataVersion: 1, asOf: null, delaySeconds: 0, freshness: 'missing', demo: true,
  capabilities: { displayPublic: false, displayMember: true, retainBars: false, retainSnapshot: false, exportImage: false, exportPersonalRecord: true, newPublishing: false },
};
const event: components['schemas']['PositionEvent'] = { type: 'entry', claimedAt: '2026-01-01T00:00:00Z', quantity: 1, price: '1.2500000001', costs: null };
void [meta, event];
// @ts-expect-error price values remain decimal strings at the contract boundary
const invalidEvent: components['schemas']['PositionEvent'] = { type: 'entry', claimedAt: '2026-01-01T00:00:00Z', quantity: 1, price: 1.25, costs: null };
void invalidEvent;
