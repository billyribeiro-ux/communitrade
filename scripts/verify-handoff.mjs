import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const exists = p => fs.existsSync(path.join(root, p));
const ignored = new Set(['.git', 'node_modules', '.next', 'dist', 'coverage', '.local', 'data', 'backups']);
function walk(dir = '') {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
    if (ignored.has(entry.name) || entry.name === '.DS_Store') return [];
    const rel = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(rel) : [rel];
  });
}
const all = walk();
const markdown = all.filter(p => p.endsWith('.md'));
for (const required of ['README.md','AGENTS.md','LICENSE','CHANGELOG.md','CONTRIBUTING.md','SECURITY.md','CODE_OF_CONDUCT.md','SUPPORT.md','THIRD_PARTY_NOTICES.md','docs/README.md','docs/mvp-specification.md','.github/pull_request_template.md','.github/CODEOWNERS','.github/workflows/docs.yml','contracts/openapi.json','contracts/chart-state.schema.json']) {
  check(exists(required), 'Missing required file: ' + required);
}
for (const file of markdown) {
  const text = read(file);
  check(text.trim().length > 40, 'Empty/near-empty Markdown: ' + file);
  for (const match of text.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].split(/\s+"/)[0].replace(/^<|>$/g, '');
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
    const relative = decodeURIComponent(target.split('#')[0]);
    if (!relative) continue;
    const resolved = path.resolve(path.dirname(path.join(root, file)), relative);
    check(resolved === root || resolved.startsWith(root + path.sep), 'Link escapes repository: ' + file + ' -> ' + target);
    check(fs.existsSync(resolved), 'Broken local link: ' + file + ' -> ' + target);
  }
}
const manifest = JSON.parse(read('docs/implementation/requirements.json'));
const reqs = new Map(manifest.requirements.map(r => [r.id, r]));
const milestones = new Map(manifest.milestones.map(m => [m.id, m]));
check(reqs.size === 32 && manifest.requirements.length === 32, 'Requirement registry must contain 32 unique entries');
check(milestones.size === 14 && manifest.milestones.length === 14, 'Milestone registry must contain 14 unique entries');
const requirementText = read('docs/product/requirements.md');
const acceptanceText = read('docs/quality/acceptance.md');
for (const r of reqs.values()) {
  check(requirementText.includes(r.id), 'Requirement missing from product spec: ' + r.id);
  check(acceptanceText.includes(r.test), 'Missing acceptance case: ' + r.test);
  const m = milestones.get(r.milestone);
  check(Boolean(m), 'Unknown primary milestone for ' + r.id);
  if (m) check(m.requirements.includes(r.id), 'Primary milestone does not cover ' + r.id);
}
for (const m of milestones.values()) {
  check(exists(m.prompt), 'Missing prompt: ' + m.prompt);
  if (exists(m.prompt)) {
    const t = read(m.prompt);
    for (const heading of ['## Authority and prerequisites','## Work','## Acceptance and evidence','## Completion']) check(t.includes(heading), m.id + ' missing ' + heading);
    for (const req of m.requirements) check(t.includes(req), m.id + ' prompt omits ' + req);
  }
  for (const dep of m.depends) {
    check(milestones.has(dep), m.id + ' unknown prerequisite ' + dep);
    check(Number(dep.slice(1)) < Number(m.id.slice(1)), m.id + ' prerequisite order invalid');
  }
}
for (const file of markdown) {
  for (const id of new Set(read(file).match(/REQ-[0-9]{3}/g) || [])) check(reqs.has(id), file + ' references unknown ' + id);
  for (const id of new Set(read(file).match(/AC-[0-9]{3}/g) || [])) check(manifest.requirements.some(r => r.test === id), file + ' references unknown ' + id);
}
const documents = new Map();
function loadJson(file) {
  const absolute = path.resolve(root, file);
  if (!documents.has(absolute)) documents.set(absolute, JSON.parse(fs.readFileSync(absolute, 'utf8')));
  return documents.get(absolute);
}
function resolvePointer(document, fragment, label) {
  let current = document;
  if (!fragment) return current;
  check(fragment.startsWith('/'), 'Unsupported JSON pointer in ' + label);
  for (const token of fragment.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!current || !Object.hasOwn(current, token)) { failures.push('Broken schema reference: ' + label); return undefined; }
    current = current[token];
  }
  return current;
}
function inspectReferences(node, file) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.$ref === 'string') {
    const [relative, fragment = ''] = node.$ref.split('#');
    if (!/^[a-z][a-z0-9+.-]*:/i.test(relative)) {
      const target = relative ? path.resolve(path.dirname(file), relative) : file;
      if (!fs.existsSync(target)) failures.push('Missing schema document: ' + node.$ref);
      else resolvePointer(loadJson(target), fragment, file + ' ' + node.$ref);
    }
  }
  if (node.type === 'object' && Array.isArray(node.required) && node.properties) for (const key of node.required) check(Object.hasOwn(node.properties,key), 'Required property has no schema: ' + file + ' ' + key);
  for (const value of Object.values(node)) inspectReferences(value, file);
}
const apiFile = path.join(root, 'contracts/openapi.json');
const chartFile = path.join(root, 'contracts/chart-state.schema.json');
const api = loadJson(apiFile);
const chart = loadJson(chartFile);
inspectReferences(api, apiFile);
inspectReferences(chart, chartFile);
check(api.openapi === '3.1.0', 'OpenAPI version differs');
check(chart.properties.drawings.maxItems === 50, 'Drawing bound differs from scope');
check(chart.$defs.Drawing.oneOf.length === 8, 'Missing drawing variant');
const operationIds = new Set();
let operationCount = 0;
for (const [route, item] of Object.entries(api.paths)) {
  check(route.startsWith('/'), 'API path must be relative absolute: ' + route);
  for (const [method, op] of Object.entries(item)) {
    if (!['get','post','put','patch','delete','head','options'].includes(method)) continue;
    operationCount++;
    check(!operationIds.has(op.operationId), 'Duplicate operation ID: ' + op.operationId);
    operationIds.add(op.operationId);
    check(reqs.has(op['x-requirement']), 'Unknown requirement on operation: ' + op.operationId);
    check(Boolean(op['x-access']), 'Missing access rule: ' + op.operationId);
    const vars = [...route.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
    for (const variable of vars) check(op.parameters.some(p => p.in === 'path' && p.name === variable && p.required), 'Missing required path variable: ' + op.operationId + ' ' + variable);
    for (const p of op.parameters.filter(p => p.in === 'path')) check(vars.includes(p.name), 'Extra path variable: ' + op.operationId + ' ' + p.name);
    check(Object.keys(op.responses).some(code => /^[23][0-9]{2}$/.test(code)), 'No success response: ' + op.operationId);
    for (const security of op.security ?? api.security) for (const name of Object.keys(security)) check(Boolean(api.components.securitySchemes[name]), 'Unknown security scheme: ' + name);
    check(read('docs/architecture/api-contract.md').includes('| ' + op.operationId + ' |'), 'Operation missing from Markdown inventory: ' + op.operationId);
  }
}
const adrFiles = all.filter(p => /^docs\/adr\/[0-9]{4}-.*\.md$/.test(p));
for (const requiredOperation of ['startLogin','completeLogin','getMe','updateProfile','saveDraftChart','publishDraft','getPublicationJob','getPublicationVersion','appendPositionEvent','listPositionEvents','createRepost','getShareImage','createCheckout','receiveStripeWebhook','oidcBackchannelLogout','startStepUp','adminReviewCorrection','getMediaContent','downloadExport']) check(operationIds.has(requiredOperation), 'Missing core workflow operation: ' + requiredOperation);
check(adrFiles.length === 25, 'Expected 25 substantive ADRs');
if (failures.length) {
  for (const failure of failures) process.stderr.write('FAIL ' + failure + '\n');
  process.exitCode = 1;
} else {
  assert.equal(reqs.size,32);
  process.stdout.write(JSON.stringify({status:'passed',files:all.length,markdownFiles:markdown.length,requirements:reqs.size,milestones:milestones.size,adrs:adrFiles.length,apiOperations:operationCount,apiSchemas:Object.keys(api.components.schemas).length,checks:['local links','required files','requirement/acceptance/prompt traceability','milestone dependencies','JSON parsing and references','API path parameters/access/security/success responses','endpoint inventory','drawing bounds']},null,2) + '\n');
}
