import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Pool } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { AuthService, authConfigFromEnv } from '../dist/auth/service.js';
import { FilesystemStorage } from '@trading/media';
import { cleanupP08Fixtures } from './p08-fixture-cleanup.mjs';

const mediaRequire = createRequire(new URL('../../../packages/media/package.json', import.meta.url));
const sharp = mediaRequire('sharp');
const storage = new FilesystemStorage(process.env.LOCAL_OBJECTS_PATH ?? '/var/lib/options-trade-ideas/objects');

// Product-level P08 capture acceptance. Synthetic accounts are disposable, and
// all traffic still passes through AuthService, the public API, PgBoss, Chromium
// in the worker, immutable media storage, and the public read projections.
if (process.env.RELEASE_MODE !== 'local' || (process.env.MARKET_DATA_PROVIDER ?? 'synthetic') !== 'synthetic') {
  throw new Error('P08 live acceptance requires RELEASE_MODE=local and MARKET_DATA_PROVIDER=synthetic.');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 5_000 });
const auth = new AuthService(pool, authConfigFromEnv());
const appOrigin = process.env.APP_ORIGIN;
const testUsers = [];
const adminSessionTokenHashes = [];
const versionIds = [];
const generatedObjectKeys=new Set();
const idemKeys = [];
let stage = 'local synthetic gate';

const ids = {
  stock: '00000000-0000-4000-8000-000000000201',
  futures: {
    ES: '00000000-0000-4000-8000-000000000202',
    MES: '00000000-0000-4000-8000-000000000203',
    NQ: '00000000-0000-4000-8000-000000000204',
    MNQ: '00000000-0000-4000-8000-000000000205',
  },
  options: {
    C100: '00000000-0000-4000-8000-000000000221', C105: '00000000-0000-4000-8000-000000000222',
    P100: '00000000-0000-4000-8000-000000000223', P105: '00000000-0000-4000-8000-000000000224',
    C95: '00000000-0000-4000-8000-000000000225', C110: '00000000-0000-4000-8000-000000000226',
    P95: '00000000-0000-4000-8000-000000000227', P110: '00000000-0000-4000-8000-000000000228',
  },
};

function idem() { const key = randomUUID(); idemKeys.push(key); return key; }
function headers(actor, extra = {}) {
  return { Origin: appOrigin, 'X-CSRF-Token': actor.csrfToken, ...extra };
}
async function request(path, actor, init = {}, expected = 200) {
  const h = new Headers(init.headers);
  if (actor) h.set('Cookie', `${auth.config.cookieName}=${actor.token}`);
  if (init.body !== undefined && !(init.body instanceof Uint8Array)) h.set('Content-Type', 'application/json');
  let response,text;
  for(let attempt=0;attempt<3;attempt++){
    response=await fetch(`http://web:3000${path}`, { ...init, headers: h, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    text=await response.text();
    if(response.status!==429||(init.method??'GET')!=='GET'||attempt===2)break;
    let limited=false;try{limited=JSON.parse(text).code==='PUBLIC_READ_RATE_LIMIT';}catch{}
    if(!limited)break;
    console.log('WAIT existing public-read limit; retrying after the advertised interval.');
    await delay(Math.min(60,Math.max(1,Number(response.headers.get('retry-after'))||60))*1000+250);
  }
  if(response.status!==expected){let code="UNKNOWN";try{const body=JSON.parse(text);if(typeof body.code==="string"&&/^[A-Z_]{1,100}$/.test(body.code))code=body.code;}catch{}const route=path.split("?")[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi,":id");console.error(`HTTP failure: ${init.method??"GET"} ${route} ${response.status} ${code}`);}
  assert.equal(response.status, expected, `P08 ${stage}: received HTTP ${response.status}, expected ${expected}`);
  return { response, text };
}
async function json(path, actor, init, expected = 200) {
  const result = await request(path, actor, init, expected);
  return { ...result, data: result.text ? JSON.parse(result.text) : null };
}

async function createOwner(label) {
  const suffix = randomUUID();
  const email = `p08-${suffix}@example.invalid`;
  const subject = `p08-live-${suffix}`;
  const actor = await auth.createSession({ issuer: auth.config.issuer, subject, email, emailVerified: true, sid: `p08-${suffix}`, assurance: '1', authTime: Math.floor(Date.now() / 1000) }, undefined, false);
  const row = (await pool.query('SELECT id FROM user_account WHERE oidc_issuer=$1 AND oidc_subject=$2 AND email=$3 AND email_verified=true AND status=\'active\'', [auth.config.issuer, subject, email])).rows[0];
  assert.ok(row?.id, 'AuthService must create the disposable verified identity');
  const userId = row.id;
  testUsers.push(userId);
  await pool.query('UPDATE user_account SET synthetic=true WHERE id=$1 AND oidc_issuer=$2 AND oidc_subject=$3', [userId, auth.config.issuer, subject]);
  const onboarding = await json('/api/v1/me/onboarding', actor, {
    method: 'POST', headers: headers(actor), body: JSON.stringify({
      handle: `p08_${suffix.replaceAll('-', '').slice(0, 16)}`, displayName: `Synthetic P08 ${label}`,
      experience: 'experienced', interests: ['stock', 'option', 'future'], timezone: 'America/New_York',
      termsVersion: auth.config.termsVersion, adultUSDeclaration: true,
    }),
  }, 201);
  assert.equal(onboarding.data.onboarded, true, 'Disposable owner completes normal application onboarding');
  const privateSentinel=`P08_PRIVATE_${randomUUID()}`;
  const privateDraft=await json('/api/v1/drafts',actor,{method:'POST',headers:headers(actor,{'Idempotency-Key':idem()}),body:JSON.stringify({kind:'education',asset:'stock'})},201);
  await json(`/api/v1/drafts/${privateDraft.data.id}`,actor,{method:'PATCH',headers:headers(actor,{'If-Match':`"${privateDraft.data.revision}"`}),body:JSON.stringify({title:'Unpublished private draft',thesis:privateSentinel})});
  return { ...actor, userId,email,privateSentinel };
}

async function adminActor() {
  const id = '00000000-0000-4000-8000-000000000106';
  const row = (await pool.query('SELECT oidc_issuer,oidc_subject,email,email_verified,synthetic,status FROM user_account WHERE id=$1', [id])).rows[0];
  assert.ok(row?.synthetic && row.status === 'active' && row.email_verified);
  assert.equal((await pool.query("SELECT 1 FROM role_grant WHERE user_id=$1 AND role='admin'", [id])).rowCount, 1);
  const actor = await auth.createSession({ issuer: row.oidc_issuer, subject: row.oidc_subject, email: row.email, emailVerified: row.email_verified, sid: `p08-stepup-${randomUUID()}`, assurance: auth.config.mfaAssurance, authTime: Math.floor(Date.now() / 1000) }, undefined, true);
  adminSessionTokenHashes.push(createHash('sha256').update(actor.token).digest('hex'));
  return actor;
}

const stamp = (date) => new Date(date).toISOString();
const drawingTypes = ['horizontal', 'trendline', 'rectangle', 'arrow', 'text', 'entry', 'target', 'invalidation'];
function drawingsAt(from, to, center, linkPlan = true) {
  return Array.from({ length: 50 }, (_, index) => {
    const type = linkPlan && index < 8 ? drawingTypes[index] : drawingTypes[index % 5];
    const two = ['trendline', 'rectangle', 'arrow'].includes(type);
    const anchors = [{ time: from, price: String(center) }, ...(two ? [{ time: to, price: String(center + (index % 4) + 1) }] : [])];
    const drawing = {
      id: randomUUID(), type, anchors,
      style: { color: ['#16865d', '#4678d4', '#cf3c47', '#8AB4FF'][index % 4], lineWidth: index % 4 + 1, lineStyle: ['solid', 'dashed', 'dotted'][index % 3], fillOpacity: index % 2 ? 0.24 : 0 },
    };
    if (type === 'text') drawing.text = `Frozen note ${index + 1}`;
    // Keep linked fields unique, while still exercising all eight drawing families.
    if (linkPlan && type === 'entry' && index < 8) drawing.planField = 'entryUnderlying';
    if (linkPlan && type === 'target' && index < 8) drawing.planField = 'targetUnderlying1';
    if (linkPlan && type === 'invalidation' && index < 8) drawing.planField = 'invalidationUnderlying';
    return drawing;
  });
}

async function chartState(actor, instrumentId, asset, entry, include50, linkPlan = true) {
  const future = asset === 'future';
  const from = stamp(Date.now() - 75 * 86_400_000);
  const to = stamp(Date.now() + 86_400_000);
  const query = new URLSearchParams({ interval: '1d', from, to, session: future ? 'exchange' : 'regular', limit: '10000' });
  const bars = await json(`/api/v1/instruments/${instrumentId}/bars?${query}`, actor);
  assert.ok(bars.data.bars.length > 1, `${asset} source provides enough bars for a frozen viewport`);
  assert.equal(bars.data.meta.capabilities.retainBars, true);
  const first = bars.data.bars[0].time;
  const last = bars.data.bars.at(-1).time;
  const center = Number(entry);
  return {
    schemaVersion: 1, instrumentId, metadataVersion: bars.data.meta.metadataVersion,
    interval: '1d', timezone: future ? 'America/Chicago' : 'America/New_York', session: future ? 'exchange' : 'regular',
    adjustment: 'unadjusted', viewport: { from: first, to: stamp(Date.parse(last) + 86_400_000) },
    indicators: [{ kind: 'ema', period: 20, color: '#f5bd55' }, { kind: 'ema', period: 50, color: '#8ab4ff' }],
    provenance: { provider: bars.data.meta.provider, asOf: bars.data.meta.asOf, delaySeconds: bars.data.meta.delaySeconds, demo: bars.data.meta.demo },
    drawings: include50 ? drawingsAt(first, last, center, linkPlan) : drawingsAt(first, last, center, linkPlan).slice(0, 8),
  };
}

const optionCases = [
  ['long_call', [[ids.options.C100, 'buy']]], ['long_put', [[ids.options.P100, 'buy']]],
  ['bull_call_debit', [[ids.options.C100, 'buy'], [ids.options.C105, 'sell']]],
  ['bear_put_debit', [[ids.options.P105, 'buy'], [ids.options.P100, 'sell']]],
  ['bull_put_credit', [[ids.options.P105, 'sell'], [ids.options.P100, 'buy']]],
  ['bear_call_credit', [[ids.options.C100, 'sell'], [ids.options.C105, 'buy']]],
];

function tradePlan({ asset, strategy, instrumentId, legs = [], entryPrice, stop, entryFrom, entryUntil,quantity=1 }) {
  return {
    asset, strategy, instrumentId, legs: legs.map(([id, side]) => ({ instrumentId: id, side, quantity })), quantity,
    entryPrice, priceKind: asset === 'option' ? (strategy.endsWith('debit') ? 'spread_debit' : strategy.endsWith('credit') ? 'spread_credit' : 'option_premium') : asset === 'future' ? 'futures' : 'underlying',
    entryFrom, entryUntil, entryCondition: 'Enter after a confirmed synthetic reference-bar close.', timeframe: 'swing',
    ...(stop ? { initialStopPrice: stop } : {}), exitRules: 'Exit at the planned target or invalidation; report actual fills separately.', conflicts: 'No known conflicts reported.',
  };
}

async function publish(owner, { kind = 'trade', asset = 'stock', strategy = 'long', instrumentId = ids.stock, legs = [], label, include50 = false, lateWindow = false }) {
  const created = await json('/api/v1/drafts', owner, { method: 'POST', headers: headers(owner, { 'Idempotency-Key': idem() }), body: JSON.stringify({ kind, asset }) }, 201);
  const entryFrom = stamp(Date.now() + (lateWindow ? 30 : -1) * 60_000), entryUntil = stamp(Date.now() + 2 * 60 * 60_000);
  let plan = {};
  if (kind === 'trade') plan = tradePlan({ asset, strategy, instrumentId: asset === 'option' ? ids.stock : instrumentId, legs, entryPrice: asset === 'option' ? (strategy.endsWith('debit') || strategy.endsWith('credit') ? '1.50' : '2.50') : asset === 'future' ? '6000.00' : '100.00', stop: asset === 'future' ? (strategy === 'long' ? '5990.00' : '6010.00') : asset === 'stock' ? (strategy === 'long' ? '98.00' : '102.00') : undefined, entryFrom, entryUntil,quantity:asset==='stock'&&strategy==='long'?2:1 });
  await json(`/api/v1/drafts/${created.data.id}`, owner, { method: 'PATCH', headers: headers(owner, { 'If-Match': `"${created.data.revision}"` }), body: JSON.stringify({ title: label, thesis: `Synthetic acceptance thesis for ${label}; references are synthetic and do not represent verified fills or investment results.`, ...(kind === 'trade' ? { plan } : {}) }) });
  const chartInstrument = asset === 'option' || kind === 'education' ? ids.stock : instrumentId;
  const state = await chartState(owner, chartInstrument, asset === 'future' ? 'future' : 'stock', asset === 'future' ? '6000.00' : '100.00', include50, kind === 'trade');
  if (include50) assert.equal(state.drawings.length, 50);
  const saved = await json(`/api/v1/drafts/${created.data.id}/chart`, owner, { method: 'PUT', headers: headers(owner, { 'If-Match': '"0"' }), body: JSON.stringify(state) });
  assert.equal(saved.data.revision, 1);
  let attachmentId=null;
  if(include50){
    const image=await sharp({create:{width:80,height:60,channels:3,background:'#4678d4'}}).png().toBuffer();
    const upload=await json('/api/v1/uploads',owner,{method:'POST',headers:headers(owner,{'Idempotency-Key':idem()}),body:JSON.stringify({purpose:'publication_attachment',resourceType:'draft',resourceId:created.data.id,filename:'synthetic-evidence.png',mime:'image/png',sizeBytes:image.length})},201);
    attachmentId=upload.data.id;
    await request(`/api/v1/uploads/${attachmentId}/content`,owner,{method:'POST',headers:headers(owner,{'Content-Type':'image/png'}),body:image},204);
    await json(`/api/v1/uploads/${attachmentId}/complete`,owner,{method:'POST',headers:headers(owner,{'Idempotency-Key':idem()})},202);
    let ready=false;for(let i=0;i<60;i++){const media=await json(`/api/v1/media/${attachmentId}`,owner);if(media.data.status==='ready'){ready=true;break;}assert.notEqual(media.data.status,'rejected','Valid synthetic PNG must survive real worker processing');await delay(500);}
    assert.ok(ready,'Real attachment processing completed');
    await request(`/api/v1/media/${attachmentId}/content`,null,{},404);
    const before=await json(`/api/v1/drafts/${created.data.id}`,owner);
    await json(`/api/v1/drafts/${created.data.id}`,owner,{method:'PATCH',headers:headers(owner,{'If-Match':`"${before.data.revision}"`}),body:JSON.stringify({attachmentIds:[attachmentId]})});
  }
  const currentDraft = await json(`/api/v1/drafts/${created.data.id}`, owner);
  if(include50||kind==='education'||strategy==='long_call'||asset==='future'&&strategy==='long'&&instrumentId===ids.futures.ES){const composer=await request(`/app/drafts/${created.data.id}/compose`,owner);assert.match(composer.text,/Complete your idea/);assert.match(composer.text,/Review and publish/);assert.match(composer.text,/Processed attachments/);}

  assert.equal(currentDraft.data.chartRevision, 1);
  // A client-supplied image is an invalid command; only the worker snapshot is accepted.
  if (include50) {
    const forged = await request(`/api/v1/drafts/${created.data.id}/publish`, owner, { method: 'POST', headers: headers(owner, { 'If-Match': `"${currentDraft.data.revision}"`, 'Idempotency-Key': idem() }), body: JSON.stringify({ draftRevision: currentDraft.data.revision, chartRevision: 1, snapshot: 'data:image/png;base64,AAAA', imageUrl: 'https://example.invalid/image.png' }) }, 400);
    assert.match(forged.response.headers.get('cache-control') ?? '', /no-store/);
    assert.equal((await pool.query('SELECT id FROM publication WHERE author_user_id=$1 ORDER BY created_at DESC LIMIT 1', [owner.userId])).rowCount, 0, 'Client snapshot injection must not create a public publication');
  }
  const key = idem();
  const started = await json(`/api/v1/drafts/${created.data.id}/publish`, owner, { method: 'POST', headers: headers(owner, { 'If-Match': `"${currentDraft.data.revision}"`, 'Idempotency-Key': key }), body: JSON.stringify({ draftRevision: currentDraft.data.revision, chartRevision: 1 }) }, 202);
  const jobId = started.data.id;
  if (started.data.status === 'failed') assert.fail('Publication job must be accepted into snapshot processing.');
  let terminal;
  for (let i = 0; i < 600; i++) {
    const status = await json(`/api/v1/publication-jobs/${jobId}`, owner);
    if (status.data.status === 'succeeded' || status.data.status === 'failed') { terminal = status.data; break; }
    await delay(500);
  }
  assert.equal(terminal?.status, 'succeeded', `Worker snapshot must complete (${terminal?.failureCode ?? 'timeout'}).`);
  const job = (await pool.query('SELECT publication_id,publication_version_id,candidate,snapshot_checksum,snapshot_width,snapshot_height,snapshot_mime FROM publication_job WHERE id=$1', [jobId])).rows[0];
  assert.ok(job?.publication_id && job.publication_version_id);
  assert.equal(job.snapshot_width, 1200); assert.equal(job.snapshot_height, 760); assert.equal(job.snapshot_mime, 'image/webp');
  assert.match(job.snapshot_checksum, /^[a-f0-9]{64}$/);
  assert.equal(job.candidate.chartState.drawings.length, include50 ? 50 : 8, 'Frozen candidate preserves exact semantic drawing JSON');
  assert.equal(job.candidate.chartState.drawings[0].type, 'horizontal');
  assert.equal(job.candidate.chartState.drawings[3].type, 'arrow');
  assert.equal(job.candidate.chartState.drawings[4].type, 'text');
  const detail = await json(`/api/v1/publications/${job.publication_id}`, null);
  assert.equal(detail.data.versionId, job.publication_version_id);
  assert.equal(detail.data.chart.drawings.length, include50 ? 50 : 8);
  assert.equal(detail.data.evidence, 'member_reported');
  if(attachmentId){assert.deepEqual(detail.data.attachmentIds,[attachmentId]);const attached=await request(`/api/v1/media/${attachmentId}/content`,null);assert.match(attached.response.headers.get('content-type')??'',/^image\/webp/);}
  for(const secret of [owner.token,owner.csrfToken,owner.email,owner.privateSentinel])assert.ok(!JSON.stringify(detail.data).includes(secret),'Public publication JSON excludes private draft, identity and authentication values');
  assert.equal(job.candidate.disclosures.providerVerified, false);
  assert.equal(job.candidate.disclosures.evidence, 'member_reported');
  const imageResponse = await fetch(`http://web:3000/api/v1/publications/${job.publication_id}/share/image?versionId=${job.publication_version_id}`, { signal: AbortSignal.timeout(30_000) });
  assert.equal(imageResponse.status, 200);
  assert.match(imageResponse.headers.get('content-type') ?? '', /^image\/webp/);
  assert.match(imageResponse.headers.get('cache-control') ?? '', /no-store/);
  const data = Buffer.from(await imageResponse.arrayBuffer());
  assert.ok(data.length > 1000, 'Public readback is a stable non-empty image payload');
  const imageAgain = await fetch(`http://web:3000/api/v1/publications/${job.publication_id}/share/image?versionId=${job.publication_version_id}`, { signal: AbortSignal.timeout(30_000) });
  assert.equal(imageAgain.status, 200);
  assert.equal(createHash('sha256').update(Buffer.from(await imageAgain.arrayBuffer())).digest('hex'), job.snapshot_checksum, 'Public response bytes match the worker-persisted immutable checksum');
  const decoded = await sharp(data).metadata();
  assert.equal(decoded.format, 'webp'); assert.equal(decoded.width, 1200); assert.equal(decoded.height, 760);
  const stats = await sharp(data).stats();
  assert.ok(stats.channels.some(channel => channel.stdev > 0), 'Decoded snapshot contains rendered pixels');
  const slug = detail.data.slug;
  const page = await fetch(`http://web:3000/ideas/${job.publication_id}/${slug}`, { signal: AbortSignal.timeout(30_000) });
  assert.equal(page.status, 200, 'Public SSR page is available after immutable snapshot completion');
  const html = await page.text();
  for(const secret of [owner.token,owner.csrfToken,owner.email,owner.privateSentinel])assert.ok(!html.includes(secret),'Anonymous public SSR excludes private draft, identity and authentication values');
  assert.match(html, /MEMBER REPORTED/); assert.match(html, /not independently verified/); assert.match(html, /Frozen chart/);
  assert.ok(!html.includes(owner.token), 'Private auth token is absent from public SSR');
  return { publicationId: job.publication_id, versionId: job.publication_version_id, jobId, details: detail.data, owner, chart: state };
}

async function appendPositionEvent(actor, publicationId, event) {
  const publication = await json(`/api/v1/publications/${publicationId}`, actor);
  const positionId = publication.data.positionId;
  assert.ok(positionId, 'Trade publication initializes its position only after snapshot success');
  let position = await json(`/api/v1/positions/${positionId}`, actor);
  const result = await json(`/api/v1/positions/${positionId}/events`, actor, {
    method: 'POST', headers: headers(actor, { 'If-Match': `"${position.data.revision}"`, 'Idempotency-Key': idem() }), body: JSON.stringify(event),
  }, 201);
  return { positionId, result: result.data, position: (await json(`/api/v1/positions/${positionId}`, actor)).data };
}

try {
  stage = 'local web and API readiness';
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch('http://web:3000/api/v1/health/ready', { signal: AbortSignal.timeout(2000) })).ok) { ready = true; break; } } catch { /* local services can still be starting */ }
    await delay(500);
  }
  assert.ok(ready, 'Local API and web proxy must be ready before acceptance writes begin');

  stage = 'disposable verified synthetic owner setup';
  const owners = [await createOwner('A'), await createOwner('B')];
  const staff = await adminActor();
  const journeys = [];
  const cases = [
    { asset: 'stock', strategy: 'long', label: 'P08 stock long', instrumentId: ids.stock },
    { asset: 'stock', strategy: 'short', label: 'P08 stock short', instrumentId: ids.stock, lateWindow: true },
    ...optionCases.map(([strategy, legs]) => ({ asset: 'option', strategy, legs, label: `P08 option ${strategy}` })),
    ...Object.entries(ids.futures).flatMap(([root, instrumentId]) => [
      { asset: 'future', strategy: 'long', label: `P08 ${root} futures long`, instrumentId },
      { asset: 'future', strategy: 'short', label: `P08 ${root} futures short`, instrumentId },
    ]),
    { kind: 'education', asset: 'stock', strategy: 'long', label: 'P08 educational publication', instrumentId: ids.stock },
  ];
  assert.equal(cases.length, 17, 'Acceptance matrix contains every supported trade family plus education');
  for (let index = 0; index < cases.length; index++) {
    const owner = owners[index < 10 ? 0 : 1];
    stage = `worker-rendered ${cases[index].label}`;
    journeys.push(await publish(owner, { ...cases[index], include50: index === 0 }));
    console.log(`PASS trusted capture ${index+1}/17 · ${cases[index].label}`);
    // SSR also makes source/metadata/history reads. Stay below the shared public
    // ingress budget; never reset a bucket or spoof client forwarding headers.
    await delay(8000);
  }
  console.log('PASS 17 real snapshot jobs: stock long/short, six option strategies, four futures roots long/short, and education; all captured to public WebP.');

  stage = 'reported position lifecycle, duplicate event replay, and missing-cost eligibility';
  const lifecycle = journeys[0];
  const entryAt = stamp(Date.now());
  const entry = { type: 'entry', claimedAt: entryAt, quantity: 2, price: '100.00', costs: null };
  const createdEntry = await appendPositionEvent(lifecycle.owner, lifecycle.publicationId, entry);
  const positionId = createdEntry.positionId;
  const reporter=await request(`/app/positions/${positionId}`,lifecycle.owner);assert.match(reporter.text,/Report the trade lifecycle/);
  const replay = await json(`/api/v1/positions/${positionId}/events`, lifecycle.owner);
  assert.ok(replay.data.items.some(item => item.type === 'entry'));
  let current = (await json(`/api/v1/positions/${positionId}`, lifecycle.owner)).data;
  await json(`/api/v1/positions/${positionId}/events`, lifecycle.owner, { method: 'POST', headers: headers(lifecycle.owner, { 'If-Match': '"1"', 'Idempotency-Key': [...idemKeys].at(-1) }), body: JSON.stringify(entry) }, 201);
  await json(`/api/v1/positions/${positionId}/events`, lifecycle.owner, { method: 'POST', headers: headers(lifecycle.owner, { 'If-Match': `"${current.revision}"`, 'Idempotency-Key': idem() }), body: JSON.stringify({ type: 'partial_exit', claimedAt: stamp(Date.now() + 1000), quantity: 1, price: '101.00', costs: null }) }, 201);
  current = (await json(`/api/v1/positions/${positionId}`, lifecycle.owner)).data;
  assert.equal(current.state, 'partially_closed');
  await json(`/api/v1/positions/${positionId}/events`, lifecycle.owner, { method: 'POST', headers: headers(lifecycle.owner, { 'If-Match': `"${current.revision}"`, 'Idempotency-Key': idem() }), body: JSON.stringify({ type: 'final_exit', claimedAt: stamp(Date.now() + 2000), quantity: 1, price: '102.00', costs: null }) }, 201);
  current = (await json(`/api/v1/positions/${positionId}`, lifecycle.owner)).data;
  assert.equal(current.state, 'closed');
  assert.equal(current.outcome.costCoverage, 'incomplete');
  assert.equal(current.outcome.netRealized, null);
  console.log('PASS reported entry/final lifecycle preserves missing-cost exclusion and idempotent event replay.');

  stage = 'late-reported entry exclusion';
  const lateJourney = journeys[1];
  const latePublication = await json(`/api/v1/publications/${lateJourney.publicationId}`, lateJourney.owner);
  const latePositionId = latePublication.data.positionId;
  let late = await json(`/api/v1/positions/${latePositionId}`, lateJourney.owner);
  const lateTime = stamp(Date.now());
  await json(`/api/v1/positions/${latePositionId}/events`, lateJourney.owner, { method: 'POST', headers: headers(lateJourney.owner, { 'If-Match': `"${late.data.revision}"`, 'Idempotency-Key': idem() }), body: JSON.stringify({ type: 'entry', claimedAt: lateTime, quantity: 1, price: '100.00', costs: '0' }) }, 201);
  late = await json(`/api/v1/positions/${latePositionId}`, lateJourney.owner);
  assert.equal(late.data.outcome.eligibility, 'retrospective', 'Out-of-window entry remains reported but excluded from eligible headline counts');

  stage = 'visible text correction and staff reject/approve correction review';
  const correctable = journeys[2];
  const correctionText = await json(`/api/v1/publications/${correctable.publicationId}/corrections`, correctable.owner, { method: 'POST', headers: headers(correctable.owner, { 'Idempotency-Key': idem() }), body: JSON.stringify({ reason: 'Clarify the published thesis wording.', replacementThesis: 'A clearer synthetic thesis for this publication, retaining the original member-reported context and all historical evidence.' }) }, 201);
  const requested = await json(`/api/v1/publications/${correctable.publicationId}/correction-requests`, correctable.owner);
  assert.ok(requested.data.items.some(item => item.id === correctionText.data.id));
  assert.equal(requested.data.items.find(item => item.id === correctionText.data.id).status, 'approved', 'Text-only correction is immediately appended as a visible version.');
  // Text correction is immediately visible and retains the frozen chart snapshot.
  const visiblePage = await fetch(`http://web:3000/ideas/${correctable.publicationId}/${correctable.details.slug}`);
  assert.equal(visiblePage.status, 200);
  assert.match(await visiblePage.text(), /Clarify the published thesis wording/);

  // The first structured event correction is rejected; a second request is approved
  // and must pass through a new real worker capture before it becomes current.
  const lifecycleEvents = await json(`/api/v1/positions/${positionId}/events`, lifecycle.owner);
  const originalEntry = lifecycleEvents.data.items.find(item => item.type === 'entry');
  assert.ok(originalEntry?.id);
  const eventCorrection = { sourceEventId: originalEntry.id, event: { type: 'entry', claimedAt: entryAt, quantity: 2, price: '99.50', costs: null } };
  const rejectedRequest = await json(`/api/v1/publications/${lifecycle.publicationId}/corrections`, lifecycle.owner, { method: 'POST', headers: headers(lifecycle.owner, { 'Idempotency-Key': idem() }), body: JSON.stringify({ reason: 'A test request for the review rejection path.', replacementEvent: eventCorrection }) }, 201);
  const rejected = await json(`/api/v1/admin/corrections/${rejectedRequest.data.id}/actions`, staff, { method: 'POST', headers: headers(staff, { 'Idempotency-Key': idem() }), body: JSON.stringify({ action: 'reject', reason: 'Synthetic acceptance rejection path.' }) }, 201);
  assert.equal(rejected.data.action, 'correction_rejected');

  const approvedRequest = await json(`/api/v1/publications/${lifecycle.publicationId}/corrections`, lifecycle.owner, { method: 'POST', headers: headers(lifecycle.owner, { 'Idempotency-Key': idem() }), body: JSON.stringify({ reason: 'Correct a synthetic member-reported entry.', replacementEvent: eventCorrection }) }, 201);
  const staffPage=await request('/admin/corrections',staff);assert.match(staffPage.text,/correction/i);
  const approved = await json(`/api/v1/admin/corrections/${approvedRequest.data.id}/actions`, staff, { method: 'POST', headers: headers(staff, { 'Idempotency-Key': idem() }), body: JSON.stringify({ action: 'approve', reason: 'Synthetic acceptance approval path.' }) }, 201);
  assert.equal(approved.data.action, 'correction_processing');
  const correctionPage = await json(`/api/v1/publications/${lifecycle.publicationId}/correction-requests`, lifecycle.owner);
  const approvedRow = correctionPage.data.items.find(item => item.id === approvedRequest.data.id);
  assert.equal(approvedRow.status, 'processing');
  const correctionJobId = approvedRow.publicationJobId;
  assert.ok(correctionJobId);
  let correctionTerminal;
  for (let i = 0; i < 600; i++) {
    correctionTerminal = (await json(`/api/v1/publication-jobs/${correctionJobId}`, lifecycle.owner)).data;
    if (['succeeded', 'failed'].includes(correctionTerminal.status)) break;
    await delay(500);
  }
  assert.equal(correctionTerminal?.status, 'succeeded', 'Approved structured correction receives its own trusted capture');
  const corrected = await json(`/api/v1/publications/${lifecycle.publicationId}`, null);
  assert.notEqual(corrected.data.versionId, lifecycle.versionId);
  assert.equal(corrected.data.originalVersionId, lifecycle.versionId, 'Correction never replaces the original source version');
  assert.equal(corrected.data.correctionReason, 'Correct a synthetic member-reported entry.');
  const correctionJob = (await pool.query('SELECT publication_version_id,candidate,snapshot_checksum,snapshot_object_key FROM publication_job WHERE id=$1', [correctionJobId])).rows[0];
  assert.equal(correctionJob.candidate.eventOnlyCorrection, true);
  assert.deepEqual(correctionJob.candidate.chartState, lifecycle.chart, 'Event-only correction keeps the immutable source chart semantics');
  assert.equal(correctionJob.snapshot_object_key, `${correctionJob.publication_version_id}/processed.webp`, 'The corrected version receives its own newly rendered immutable image object');
  const correctionImageResponse = await fetch(`http://web:3000/api/v1/publications/${lifecycle.publicationId}/share/image?versionId=${correctionJob.publication_version_id}`, { signal: AbortSignal.timeout(30_000) });
  assert.equal(correctionImageResponse.status, 200);
  const correctionImage = Buffer.from(await correctionImageResponse.arrayBuffer());
  assert.equal(createHash('sha256').update(correctionImage).digest('hex'), correctionJob.snapshot_checksum);
  const correctionImageMetadata = await sharp(correctionImage).metadata();
  assert.equal(correctionImageMetadata.format, 'webp');
  assert.equal(correctionImageMetadata.width, 1200);
  assert.equal(correctionImageMetadata.height, 760);
  console.log('PASS visible text correction, staff rejection, and approved event correction with a second trusted capture; original version remains addressable.');

  stage = 'public historical snapshot and semantic JSON readback';
  for (const journey of journeys.slice(0, 3)) {
    const original = await json(`/api/v1/publications/${journey.publicationId}/versions/${journey.versionId}`, null);
    assert.equal(original.data.versionId, journey.versionId);
    assert.deepEqual(original.data.chart.drawings, journey.chart.drawings, 'Historical public version preserves original chart semantics');
  }
  console.log('PASS original publication versions retain frozen semantic drawings and image references.');
} catch (error) {
  if(error instanceof Error){const safeHttp=/^P08 [^\r\n]{1,200}: received HTTP [0-9]{3}, expected [0-9]{3}/.exec(error.message);if(safeHttp)console.error(safeHttp[0]);else if(/^Worker snapshot must complete \([A-Z_0-9]+|^Worker snapshot must complete \(timeout/.test(error.message))console.error(error.message.split("\n")[0]);else console.error(`Failure category: ${error.name} / ${"code" in error?String(error.code):"no code"}`);}
  console.error(`FAIL P08 live acceptance stage: ${stage}. Assertion/transport details and credentials omitted.`);
  process.exitCode = 1;
} finally {
  try {
    if (testUsers.length) {
      const generatedVersions = await pool.query('SELECT DISTINCT publication_version_id FROM publication_job WHERE owner_user_id=ANY($1::uuid[])', [testUsers]);
      for (const row of generatedVersions.rows) if (row.publication_version_id && !versionIds.includes(row.publication_version_id)) versionIds.push(row.publication_version_id);
    }
    if(testUsers.length){const media=await pool.query('SELECT quarantine_key,processed_key FROM media WHERE owner_user_id=ANY($1::uuid[])',[testUsers]);for(const item of media.rows)for(const key of [item.quarantine_key,item.processed_key])if(key)generatedObjectKeys.add(key);}
    await cleanupP08Fixtures(pool, testUsers);
    // Staff account is a seeded persona: delete only this run's opaque session-token hashes.
    if (adminSessionTokenHashes.length) await pool.query('DELETE FROM app_session WHERE token_hash=ANY($1::text[])', [adminSessionTokenHashes]);
    // Idempotency keys are fresh UUIDs generated by this run; leave rate-limit buckets untouched.
    if (idemKeys.length) await pool.query('DELETE FROM idempotency_record WHERE key=ANY($1::text[])', [idemKeys]);
    for (const versionId of versionIds) generatedObjectKeys.add(`${versionId}/processed.webp`);
    for(const key of generatedObjectKeys)await storage.deleteObject(key);
    assert.ok(testUsers.every(id => !id.startsWith('00000000-0000-4000-8000-000000000')), 'Only disposable generated owners entered cleanup');
    console.log('PASS disposable synthetic identities and generated records cleaned; only this run’s seeded admin session hashes removed; rate-limit buckets preserved.');
  } catch {
    console.error('FAIL P08 generated-record cleanup. Only locally generated acceptance rows may require inspection.');
    process.exitCode = 1;
    try {
      if (adminSessionTokenHashes.length) await pool.query('DELETE FROM app_session WHERE token_hash=ANY($1::text[])', [adminSessionTokenHashes]);
      if (idemKeys.length) await pool.query('DELETE FROM idempotency_record WHERE key=ANY($1::text[])', [idemKeys]);
    } catch {
      console.error('FAIL removal of this run’s seeded admin session hashes or UUID idempotency keys.');
      process.exitCode = 1;
    }
  } finally { await pool.end(); }
}
