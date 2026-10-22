import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv2020 from '../packages/contracts/node_modules/ajv/dist/2020.js';
import addFormats from '../packages/contracts/node_modules/ajv-formats/dist/index.js';
import { validateRequest, ContractValidationError } from '../packages/contracts/dist/runtime.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const openapi = JSON.parse(await readFile(path.join(root, 'contracts/openapi.json'), 'utf8'));
const chart = JSON.parse(await readFile(path.join(root, 'contracts/chart-state.schema.json'), 'utf8'));
if (openapi.openapi !== '3.1.0') throw new Error(`Expected OpenAPI 3.1.0, got ${openapi.openapi}`);
await SwaggerParser.validate(path.join(root, 'contracts/openapi.json'));

const ajv = new Ajv2020({ strict: false, allErrors: true, allowUnionTypes: true });
addFormats(ajv);
const rootSchema = { $id: 'https://options-trade-ideas.invalid/openapi.json', components: openapi.components };
ajv.addSchema(rootSchema);
ajv.addSchema({ ...chart, $id: 'https://options-trade-ideas.invalid/chart-state.schema.json' });
const validateSchema = (schema) => {
  const local = structuredClone(schema);
  const rewriteRefs = (value) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.$ref === 'string' && value.$ref.startsWith('#/')) value.$ref = `https://options-trade-ideas.invalid/openapi.json${value.$ref}`;
    else if (value.$ref === './chart-state.schema.json') value.$ref = 'https://options-trade-ideas.invalid/chart-state.schema.json';
    for (const child of Object.values(value)) rewriteRefs(child);
  };
  rewriteRefs(local);
  return ajv.compile(local);
};
const schemaValidators = Object.entries(openapi.components.schemas).map(([name, schema]) => [name, validateSchema(schema)]);
const validateChart = ajv.compile(chart);
const operationRecords = [];
for (const [route, item] of Object.entries(openapi.paths)) {
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const operation = item[method];
    if (!operation) continue;
    if (!operation.operationId) throw new Error(`Missing operationId for ${method.toUpperCase()} ${route}`);
    operationRecords.push(operation);
  }
}
if (operationRecords.length !== 158) throw new Error(`Expected 158 operations; found ${operationRecords.length}`);
if (schemaValidators.length !== 146) throw new Error(`Expected 146 component schemas; found ${schemaValidators.length}`);

const validCases = [
  ['getInstrument', { path: { id: '00000000-0000-4000-8000-000000000000' } }],
  ['getBars', { path: { id: '00000000-0000-4000-8000-000000000000' }, query: { interval: '1d', from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' } }],
  ['getPublicDiscovery', {query:{shard:'15',limit:'200'}}],
  ['deleteComment', {path:{id:'00000000-0000-4000-8000-000000000000'},headers:{'If-Match':'"2"','X-CSRF-Token':'csrf'}}],
];
for (const [id, request] of validCases) validateRequest(id, request);
const invalidCases = [
  ['getInstrument', { path: { id: 'bad', extra: 'x' } }],
  ['getBars', { path: { id: '00000000-0000-4000-8000-000000000000' }, query: { interval: '1d', from: 'x', to: 'x', arbitrary: 'x' } }],
  ['createDraft', { body: { unexpected: true } }],
  ['getPublicDiscovery', {query:{shard:'16'}}],
  ['listPublications', {query:{sort:'highest_win_rate'}}],
  ['deleteComment', {path:{id:'00000000-0000-4000-8000-000000000000'},headers:{'X-CSRF-Token':'csrf'}}],
];
for (const [id, request] of invalidCases) {
  try { validateRequest(id, request); throw new Error(`${id} unexpectedly accepted invalid request`); }
  catch (error) { if (!(error instanceof ContractValidationError)) throw error; }
}

const chartSample = { schemaVersion: 1, instrumentId: '00000000-0000-4000-8000-000000000000', metadataVersion: 1, interval: '1d', timezone: 'UTC', session: 'regular', adjustment: 'split-adjusted', viewport: { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' }, indicators: [], provenance: { provider: 'fixture', asOf: '2026-01-02T00:00:00Z', delaySeconds: 0, demo: true }, drawings: [] };
if (!validateChart(chartSample)) throw new Error(`Valid chart fixture rejected: ${JSON.stringify(validateChart.errors)}`);
if (validateChart({ ...chartSample, drawings: Array.from({ length: 501 }, () => ({})) })) throw new Error('Chart schema accepted too many drawings');

console.log(`OpenAPI 3.1 validated: ${operationRecords.length} operations, ${schemaValidators.length} schemas; chart schema and request validation checks passed.`);
