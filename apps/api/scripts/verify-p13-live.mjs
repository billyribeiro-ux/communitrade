import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import Ajv from '../../../packages/contracts/node_modules/ajv/dist/2020.js';
import addFormats from '../../../packages/contracts/node_modules/ajv-formats/dist/index.js';
import { readFile } from 'node:fs/promises';
import { AuthService, authConfigFromEnv } from '../dist/auth/service.js';
import { FilesystemExportStorage } from '@trading/media';
import { cleanupP08Fixtures } from './p08-fixture-cleanup.mjs';

if (process.env.RELEASE_MODE !== 'local' || process.env.NODE_ENV === 'production') throw new Error('P13 acceptance requires local release mode.');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8, connectionTimeoutMillis: 5000 });
const auth = new AuthService(pool, authConfigFromEnv());
const exportStorage = new FilesystemExportStorage(process.env.LOCAL_OBJECTS_PATH ?? '/var/lib/options-trade-ideas/objects');
const users = [], mailpitIds = new Set(), archiveJobs = new Set();
const sentinel = `P13_PRIVATE_${randomUUID().replaceAll('-', '')}`;
// The driver runs inside Linux's API container. Each run uses a real, distinct
// loopback source for public intake; shared proxy limits are never reset or
// bypassed with forwarded headers. Other API/SSR journeys use the web proxy.
const intakeOctets=randomBytes(3);
const intakeAddress=`127.${intakeOctets[0]||1}.${intakeOctets[1]}.${intakeOctets[2]||1}`;
function intake(headers,body){return new Promise((resolve,reject)=>{
  const req=httpRequest('http://127.0.0.1:3001/api/v1/support',{method:'POST',headers:Object.fromEntries(headers),localAddress:intakeAddress},res=>{
    const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);
    res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
  });
  req.setTimeout(45000,()=>req.destroy(new Error('Local contact acceptance timed out.')));req.on('error',reject);req.end(body);
});}
let stage = 'setup', deletionFixture = null;
const spec = JSON.parse(await readFile(new URL('../../../contracts/openapi.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true }); addFormats(ajv); ajv.addSchema({ $id: 'https://p13.invalid/contracts', components: spec.components });
const validators = new Map();
function schema(name, value) {
  if (!validators.has(name)) {
    const definition = structuredClone(spec.components.schemas[name]);
    function rewrite(node) { if (!node || typeof node !== 'object') return; if (node.$ref?.startsWith('#/')) node.$ref = `https://p13.invalid/contracts${node.$ref}`; for (const child of Object.values(node)) rewrite(child); }
    rewrite(definition); validators.set(name, ajv.compile(definition));
  }
  if(!validators.get(name)(value))console.error(`CONTRACT ${name}: ${(validators.get(name).errors??[]).map(error=>`${error.instancePath}:${error.keyword}`).slice(0,8).join(', ')}`);
  assert.ok(validators.get(name)(value), `${name} response violated the OpenAPI contract; private values omitted.`);
}
const key = () => randomUUID();
const writes = (actor, idem = key()) => ({ Origin: auth.config.appOrigin, 'X-CSRF-Token': actor.csrfToken, 'Idempotency-Key': idem });
const safePath = path => path.split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id');
async function request(path, actor, init = {}, expected = 200) {
  const headers = new Headers(init.headers);
  if (actor) headers.set('Cookie', `${auth.config.cookieName}=${actor.token}`);
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = path==='/api/v1/support'&&init.method==='POST'
    ?await intake(headers,init.body)
    :await fetch(`http://web:3000${path}`, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(45000) });
  const text = await response.text(); let data = null;
  try { if (text && response.headers.get('content-type')?.includes('json')) data = JSON.parse(text); } catch { /* Diagnostics intentionally exclude bodies. */ }
  if (response.status !== expected) {
    const code = /^[A-Z0-9_]{1,80}$/.test(data?.code ?? '') ? data.code : 'UNKNOWN';
    console.error(`HTTP ${init.method ?? 'GET'} ${safePath(path)} ${response.status} ${code}; expected ${expected}.`);
  }
  assert.equal(response.status, expected, `${stage}: HTTP status mismatch at ${safePath(path)}.`);
  return { response, text, data };
}
async function json(path, actor, init = {}, expected = 200) { return (await request(path, actor, init, expected)).data; }
async function persona(label, emailSuffix = '') {
  const subject = `p13-live-${randomUUID()}`, email = `${subject}${emailSuffix}@example.invalid`;
  const identity = { issuer: auth.config.issuer, subject, email, emailVerified: true, sid: subject, assurance: '1', authTime: Math.floor(Date.now() / 1000) };
  const session = await auth.createSession(identity, undefined, false);
  const id = (await pool.query('SELECT id FROM user_account WHERE oidc_issuer=$1 AND oidc_subject=$2', [auth.config.issuer, subject])).rows[0].id;
  users.push(id); await pool.query('UPDATE user_account SET synthetic=true WHERE id=$1', [id]);
  const onboarded = await json('/api/v1/me/onboarding', session, { method: 'POST', headers: writes(session), body: JSON.stringify({ handle: `p13_${randomUUID().replaceAll('-', '').slice(0, 16)}`, displayName: `P13 ${label}`, experience: 'experienced', interests: ['stock', 'option', 'future'], timezone: 'America/New_York', termsVersion: auth.config.termsVersion, adultUSDeclaration: true }) }, 201);
  const account = (await pool.query('SELECT id,oidc_issuer,oidc_subject,email,email_verified,status,onboarding_version,declaration_version,policy_version,synthetic FROM user_account WHERE id=$1', [id])).rows[0];
  return { ...session, id, subject, email, identity, handle: onboarded.profile?.handle ?? onboarded.handle, originalAccount: account };
}
async function staffSession(actor, role) {
  await pool.query(`INSERT INTO role_grant(id,user_id,role,grantor_user_id,reason,granted_at) VALUES($1,$2,$3,$4,$5,now())`, [key(), actor.id, role, actor.id, 'Synthetic P13 local acceptance role']);
  const identity = { ...actor.identity, assurance: auth.config.mfaAssurance, authTime: Math.floor(Date.now() / 1000) };
  Object.assign(actor, await auth.createSession(identity, undefined, true));
  actor.identity = identity;
}
async function waitFor(read, description, attempts = 180, intervalMs = 500) {
  for (let i = 0; i < attempts; i++) { const value = await read().catch(() => null); if (value) return value; await delay(intervalMs); }
  throw new Error(`${description} did not complete.`);
}
async function adminAction(staff, path, body, expected = 201) {
  const result = await json(path, staff, { method: 'POST', headers: writes(staff), body: JSON.stringify(body) }, expected);
  if (expected === 201) schema('AuditEvent', result);
  return result;
}
async function captureFixtureMailpitIds() {
  const base = (process.env.MAILPIT_URL ?? 'http://mailpit:8025').replace(/\/$/, '');
  for (const actor of actors) {
    const email = actor.email;
    if (!email) continue;
    try {
      const response = await fetch(`${base}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}&limit=100`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) continue;
      const data = await response.json();
      for (const message of data.messages ?? []) {
        const recipients = (message.To ?? []).map(to => String(to.Address ?? '').toLowerCase());
        if (recipients.includes(email.toLowerCase()) && (message.ID ?? message.id)) mailpitIds.add(message.ID ?? message.id);
      }
    } catch { /* Mailpit can be absent in an API-only local stack. */ }
  }
}
const actors = [];

try {
  stage = 'synthetic personas and role grants';
  const owner = await persona('owner'), author = await persona('target-author'), admin = await persona('administrator'), secondAdmin = await persona('second-administrator'), moderator = await persona('moderator');
  actors.push(owner, author, admin, secondAdmin, moderator);
  await staffSession(admin, 'admin'); await staffSession(secondAdmin, 'admin'); await staffSession(moderator, 'moderator');

  stage = 'owner-only journal and report boundary';
  const journal = await json('/api/v1/journal', owner, { method: 'POST', headers: writes(owner), body: JSON.stringify({ title: 'P13 private journal fixture', notes: sentinel, thesis: 'Synthetic local-only idea.', tags: ['p13'], review: '' }) }, 201);
  assert.ok(journal.id);
  for (const actor of [author, admin, secondAdmin, moderator]) await request(`/api/v1/journal/${journal.id}`, actor, {}, 404);
  await request(`/api/v1/journal/${journal.id}`, null, {}, 401);
  const ownerHtml = await request(`/app/journal/${journal.id}`, owner);
  assert.match(ownerHtml.response.headers.get('cache-control') ?? '', /no-store/i); assert.match(ownerHtml.text, /noindex/i); assert.ok(ownerHtml.text.includes(sentinel)); assert.ok(!ownerHtml.text.includes(owner.token));
  const deniedHtml = await request(`/app/journal/${journal.id}`, author, {}, 404); assert.ok(!deniedHtml.text.includes(sentinel));
  await request(`/api/v1/admin/users?limit=20`, moderator, {}, 403);

  stage = 'report assignment, moderator scope, hide and sanitized owner notice';
  const reportBody = { resourceType: 'profile', resourceId: author.id, reason: 'other', detail: sentinel }, reportKey = key();
  await request('/api/v1/reports', owner, { method: 'POST', headers: { Origin: auth.config.appOrigin, 'Idempotency-Key': key() }, body: JSON.stringify(reportBody) }, 403);
  const report = await json('/api/v1/reports', owner, { method: 'POST', headers: writes(owner, reportKey), body: JSON.stringify(reportBody) }, 201);
  assert.ok(report.id);
  const duplicateReport = await json('/api/v1/reports', owner, { method: 'POST', headers: writes(owner, reportKey), body: JSON.stringify(reportBody) }, 201);
  assert.equal(duplicateReport.id, report.id);
  const ownReports = await json('/api/v1/reports?limit=20', owner); schema('ReportPage', ownReports);
  const ownCase = await json(`/api/v1/reports/${report.id}`, owner); schema('Report', ownCase); assert.equal(ownCase.detail, sentinel);
  const ownReportPage = await request(`/app/reports/${report.id}`, owner); assert.match(ownReportPage.text, /noindex/i); assert.ok(ownReportPage.text.includes(sentinel)); assert.ok(!ownReportPage.text.includes(owner.token));
  await request(`/api/v1/reports/${report.id}`, author, {}, 404);
  await request(`/api/v1/reports/${report.id}`, admin, {}, 404);
  const noAssignment = await json('/api/v1/admin/reports?limit=50', moderator); schema('ReportPage', noAssignment); assert.ok(!noAssignment.items.some(item => item.id === report.id));
  await adminAction(admin, `/api/v1/admin/reports/${report.id}/actions`, { action: 'assign', reason: 'Assign synthetic moderation fixture to moderator.', reviewerUserId: author.id }, 403);
  await adminAction(admin, `/api/v1/admin/reports/${report.id}/actions`, { action: 'assign', reason: 'Assign synthetic moderation fixture to moderator.', reviewerUserId: moderator.id });
  const assigned = await json('/api/v1/admin/reports?limit=50', moderator); schema('ReportPage', assigned); assert.ok(assigned.items.some(item => item.id === report.id));
  await request(`/api/v1/admin/reports/${report.id}`, moderator);
  await adminAction(moderator, `/api/v1/admin/reports/${report.id}/actions`, { action: 'hide', reason: 'Synthetic local moderation hide for appeal flow.' });
  const notice = await json(`/api/v1/reports/${report.id}`, author); schema('Report', notice); assert.equal(notice.caseKind, 'moderation_notice'); assert.equal(notice.viewerCanAppeal, true); assert.equal(notice.detail, ''); assert.ok(!JSON.stringify(notice).includes(sentinel)); assert.ok(!Object.hasOwn(notice, 'reporterUserId'));
  const noticePage = await request(`/app/reports/${report.id}`, author); assert.match(noticePage.text, /noindex/i); assert.ok(!noticePage.text.includes(sentinel)); assert.ok(!noticePage.text.includes(owner.email));
  await request(`/api/v1/reports/${report.id}`, secondAdmin, {}, 404);
  const appealed = await json(`/api/v1/reports/${report.id}/appeals`, author, { method: 'POST', headers: writes(author), body: JSON.stringify({ reason: 'Additional synthetic context for an independent review.' }) }, 201);
  assert.ok(appealed.id);
  const appeals = await json('/api/v1/admin/appeals?limit=50', secondAdmin); schema('ReportPage', appeals);
  const appealId = appeals.items.flatMap(item => item.appeals ?? []).find(item => item.id === appealed.id)?.id; assert.equal(appealId, appealed.id);
  await adminAction(secondAdmin, `/api/v1/admin/appeals/${appealId}/actions`, { action: 'assign', reason: 'Independent appeal review assignment.' });
  await adminAction(secondAdmin, `/api/v1/admin/appeals/${appealId}/actions`, { action: 'resolve', reason: 'Synthetic independent appeal overturn.', outcome: 'overturn' });
  assert.equal((await pool.query('SELECT moderation_hidden_at FROM profile WHERE user_id=$1', [author.id])).rows[0].moderation_hidden_at, null);
  const restoredNotice = await json(`/api/v1/reports/${report.id}`, author); assert.equal(restoredNotice.viewerCanAppeal, false);
  const staffDetail = await json(`/api/v1/admin/reports/${report.id}`, admin); schema('Report', staffDetail); assert.equal(staffDetail.detail, sentinel);
  const audit = await json('/api/v1/admin/audit?limit=50&q=appeal', secondAdmin); schema('AuditEventPage', audit); assert.ok(audit.items.some(item => item.action === 'appeal_resolve'));
  const modAudit = await json(`/api/v1/admin/audit?limit=50&q=${encodeURIComponent(report.id)}`, moderator); schema('AuditEventPage', modAudit);
  const csv = await request(`/api/v1/admin/audit/export?limit=5000&q=${encodeURIComponent(report.id)}`, admin);
  assert.match(csv.response.headers.get('content-type') ?? '', /text\/csv/i); assert.match(csv.response.headers.get('content-disposition') ?? '', /audit-events\.csv/i); assert.ok(csv.text.includes(report.id)); assert.ok(!csv.text.includes(sentinel));
  const staffUsers = await json(`/api/v1/admin/users?limit=20&q=${encodeURIComponent(moderator.email)}`, admin); schema('AdminUserPage', staffUsers); assert.ok(staffUsers.items.some(item => item.user.id === moderator.id && item.roles.includes('moderator')));

  stage = 'public contact, exact owner claim, replies and no general support access';
  const supportConfig = await json('/api/v1/support/configuration', null); schema('SupportConfiguration', supportConfig); assert.equal(typeof supportConfig.monitored, 'boolean');
  const contactBody = { email: owner.email, category: 'account', subject: 'P13 private ticket fixture', message: `Private support message ${sentinel}`, consent: true };
  await request('/api/v1/support', owner, { method: 'POST', headers: { Origin: auth.config.appOrigin, 'Idempotency-Key': key() }, body: JSON.stringify(contactBody) }, 403);
  const receipt = await json('/api/v1/support', null, { method: 'POST', headers: { Origin: auth.config.appOrigin, 'Idempotency-Key': key() }, body: JSON.stringify(contactBody) }, 201);
  schema('SupportTicket', receipt); assert.ok(receipt.reference); assert.ok(!Object.hasOwn(receipt, 'requesterUserId'));
  await request(`/api/v1/support/${receipt.id}`, null, {}, 401);
  await request(`/api/v1/support/${receipt.id}`, author, {}, 404);
  const claim = await json(`/api/v1/support/${receipt.id}/claim`, owner, { method: 'POST', headers: writes(owner), body: '{}' }, 201); schema('SupportTicket', claim); assert.equal(claim.requesterUserId, owner.id);
  const ticket = await json(`/api/v1/support/${receipt.id}`, owner); schema('SupportTicket', ticket);
  await request(`/api/v1/support/${receipt.id}`, author, {}, 404);
  const myTickets = await json('/api/v1/support?limit=20', owner); schema('SupportTicketPage', myTickets); assert.ok(myTickets.items.some(item => item.id === receipt.id));
  const supportBody = `Owner follow-up ${sentinel}`;
  await json(`/api/v1/support/${receipt.id}/messages`, owner, { method: 'POST', headers: writes(owner), body: JSON.stringify({ body: supportBody }) }, 201);
  const supportBefore = await json(`/api/v1/support/${receipt.id}`, owner); schema('SupportTicket', supportBefore); assert.ok(JSON.stringify(supportBefore).includes(supportBody));
  const ticketPage = await request(`/support/requests/${receipt.id}`, owner); assert.match(ticketPage.text, /noindex/i); assert.ok(ticketPage.text.includes(supportBody)); assert.ok(!ticketPage.text.includes(owner.token));
  const otherTicketPage = await request(`/support/requests/${receipt.id}`, author, {}, 404); assert.ok(!otherTicketPage.text.includes(sentinel));
  await request('/api/v1/admin/support?limit=20', moderator, {}, 403);
  const adminTickets = await json('/api/v1/admin/support?limit=50&status=open', admin); schema('SupportTicketPage', adminTickets); assert.ok(adminTickets.items.some(item => item.id === receipt.id));
  await json(`/api/v1/admin/support/${receipt.id}/actions`, admin, { method: 'POST', headers: writes(admin), body: JSON.stringify({ action: 'assign', reason: 'Assign synthetic support ticket.' }) }, 201);
  await json(`/api/v1/support/${receipt.id}/messages`, admin, { method: 'POST', headers: writes(admin), body: JSON.stringify({ body: 'Administrator reply through the verified private ticket.' }) }, 201);
  const staffReplyAudit = await json(`/api/v1/admin/audit?limit=50&q=${encodeURIComponent(receipt.id)}`, admin); assert.ok(staffReplyAudit.items.some(item => item.action === 'support_reply'));
  await request(`/api/v1/journal/${journal.id}`, admin, {}, 404);
  await request(`/api/v1/admin/support/access/${key()}/resource`, admin, {}, 404);

  stage = 'owner-requested resource scope, named admin, reason audit and grant expiry';
  await request(`/api/v1/support/${receipt.id}/access-requests`, owner, { method: 'POST', headers: { Origin: auth.config.appOrigin, 'Idempotency-Key': key() }, body: JSON.stringify({ resourceType: 'journal', resourceId: journal.id, purpose: 'Missing CSRF must be rejected.' }) }, 403);
  const accessRequest = await json(`/api/v1/support/${receipt.id}/access-requests`, owner, { method: 'POST', headers: writes(owner), body: JSON.stringify({ resourceType: 'journal', resourceId: journal.id, purpose: 'Help troubleshoot the owner reported journal display issue.' }) }, 201);
  schema('SupportTicket', accessRequest); const grant = accessRequest.accessRequests.find(item => item.status === 'requested'); assert.ok(grant?.id);
  await request(`/api/v1/admin/support/${receipt.id}/access-actions`, moderator, { method: 'POST', headers: writes(moderator), body: JSON.stringify({ accessRequestId: grant.id, action: 'approve', reason: 'Attempt approval without admin MFA.', minutes: 20 }) }, 403);
  const granted = await json(`/api/v1/admin/support/${receipt.id}/access-actions`, admin, { method: 'POST', headers: writes(admin), body: JSON.stringify({ accessRequestId: grant.id, action: 'approve', reason: 'Owner requested narrowly scoped troubleshooting access.', minutes: 60 }) }, 201);
  schema('SupportTicket', granted); const approved = granted.accessRequests.find(item => item.id === grant.id); assert.equal(approved.staffUserId, admin.id); assert.ok(Date.parse(approved.expiresAt) - Date.now() <= 60 * 60_000);
  const resource = await json(`/api/v1/admin/support/access/${grant.id}/resource`, admin); schema('SupportResource', resource); assert.equal(resource.resourceId, journal.id); assert.equal(resource.resourceType, 'journal'); assert.ok(JSON.stringify(resource.data).includes(sentinel));
  await request(`/api/v1/admin/support/access/${grant.id}/resource`, secondAdmin, {}, 404);
  await pool.query("UPDATE support_access_grant SET approved_at=now()-interval '61 minutes',expires_at=now()-interval '1 minute' WHERE id=$1", [grant.id]);
  await request(`/api/v1/admin/support/access/${grant.id}/resource`, admin, {}, 404);
  const freshAccess=await json(`/api/v1/support/${receipt.id}/access-requests`,owner,{method:'POST',headers:writes(owner),body:JSON.stringify({resourceType:'journal',resourceId:journal.id,purpose:'Exercise owner revocation before the approved expiry.'})},201);const revokeGrant=freshAccess.accessRequests.find(item=>item.status==='requested');assert.ok(revokeGrant);
  await json(`/api/v1/admin/support/${receipt.id}/access-actions`,admin,{method:'POST',headers:writes(admin),body:JSON.stringify({accessRequestId:revokeGrant.id,action:'approve',reason:'Owner requested a revocable support scope.',minutes:30})},201);
  await request(`/api/v1/support/${receipt.id}/access-revocations`,author,{method:'POST',headers:writes(author),body:JSON.stringify({accessRequestId:revokeGrant.id})},404);
  const revoked=await json(`/api/v1/support/${receipt.id}/access-revocations`,owner,{method:'POST',headers:writes(owner),body:JSON.stringify({accessRequestId:revokeGrant.id})},201);assert.equal(revoked.accessRequests.find(item=>item.id===revokeGrant.id)?.status,'revoked');await request(`/api/v1/admin/support/access/${revokeGrant.id}/resource`,admin,{},404);
  const scopeAudit = await json(`/api/v1/admin/audit?limit=50&q=${encodeURIComponent(receipt.id)}`, admin); assert.ok(scopeAudit.items.some(item => item.action === 'support_resource_read'));
  await adminAction(admin, `/api/v1/admin/users/${moderator.id}/actions`, { action: 'revoke_sessions', reason: 'Synthetic moderator access test completed.' });
  await request('/api/v1/admin/reports?limit=20', moderator, {}, 401);

  await waitFor(async()=>{const delivery=await pool.query("SELECT status FROM side_effect_delivery WHERE channel='support_email' AND payload->>'ticketId'=$1",[receipt.id]);return delivery.rows[0]?.status==='succeeded';},'Generic support receipt SMTP delivery',120,500);
  const deliveredMail=await fetch(`http://mailpit:8025/api/v1/search?query=${encodeURIComponent(`to:${owner.email}`)}&limit=100`);assert.ok(deliveredMail.ok);const receiptMail=(await deliveredMail.json()).messages??[];assert.ok(receiptMail.some(message=>(message.To??[]).some(to=>to.Address===owner.email)&&String(message.Subject??'').includes(receipt.reference)));
  stage = 'owner personal archive worker and private download';
  const exportJob = await json('/api/v1/exports', owner, { method: 'POST', headers: writes(owner), body: JSON.stringify({ kind: 'personal_archive' }) }, 202);
  schema('ExportJob', exportJob); archiveJobs.add(exportJob.id);
  await request(`/api/v1/exports/${exportJob.id}`, author, {}, 404); await request(`/api/v1/exports/${exportJob.id}/download`, admin, {}, 404);
  const readyArchive = await waitFor(async () => { const job = await json(`/api/v1/exports/${exportJob.id}`, owner); schema('ExportJob', job); return job.status === 'succeeded' ? job : job.status === 'failed' ? (() => { throw new Error('Personal archive worker failed.'); })() : null; }, 'Personal archive worker', 180, 500);
  assert.ok(readyArchive.expiresAt && Date.parse(readyArchive.expiresAt) - Date.now() <= 24 * 60 * 60_000);
  const archiveDownload = await request(`/api/v1/exports/${exportJob.id}/download`, owner); assert.match(archiveDownload.response.headers.get('content-type') ?? '', /application\/json/i); assert.match(archiveDownload.response.headers.get('cache-control') ?? '', /no-store/i);
  const archive = JSON.parse(archiveDownload.text); assert.equal(archive.accountId, owner.id); assert.ok(JSON.stringify(archive.sections.journal).includes(sentinel)); assert.ok(!JSON.stringify(archive).includes(owner.token));
  const publicSearch = await json(`/api/v1/publications?q=${encodeURIComponent(sentinel)}`, null); assert.equal(publicSearch.items.length, 0);

  stage = 'deletion recent verification, hold/release, worker erasure and suppression';
  await pool.query("UPDATE app_session SET issued_at=now()-interval '6 minutes' WHERE token_hash IS NOT NULL AND user_id=$1 AND revoked_at IS NULL", [owner.id]);
  await request('/api/v1/privacy/deletion', owner, { method: 'POST', headers: writes(owner), body: JSON.stringify({ confirm: 'DELETE_MY_ACCOUNT', reason: 'Synthetic P13 deletion fixture.' }) }, 403);
  assert.equal((await request('/api/v1/privacy/deletion', owner, { method: 'POST', headers: writes(owner), body: JSON.stringify({ confirm: 'DELETE_MY_ACCOUNT', reason: 'Synthetic P13 deletion fixture.' }) }, 403)).data?.code, 'RECENT_VERIFICATION_REQUIRED');
  Object.assign(owner, await auth.createSession({ ...owner.identity, assurance: auth.config.mfaAssurance, authTime: Math.floor(Date.now() / 1000) }, undefined, true));
  const deletion = await json('/api/v1/privacy/deletion', owner, { method: 'POST', headers: writes(owner), body: JSON.stringify({ confirm: 'DELETE_MY_ACCOUNT', reason: 'Synthetic P13 deletion fixture.' }) }, 202);
  schema('PrivacyRequest', deletion); deletionFixture = { id: deletion.id, ownerId: owner.id, original: owner.originalAccount, issuer: owner.identity.issuer, subject: owner.identity.subject, email: owner.email };
  const ownerPrivacy = await json('/api/v1/privacy/requests', owner); schema('PrivacyRequestPage', ownerPrivacy); assert.ok(ownerPrivacy.items.some(item => item.id === deletion.id));
  const adminPrivacy = await json('/api/v1/admin/privacy/requests?status=requested', admin); schema('AdminPrivacyRequestPage', adminPrivacy); assert.ok(adminPrivacy.items.some(item => item.id === deletion.id && item.ownerUserId === owner.id));
  const holdUntil = new Date(Date.now() + 30 * 86400_000).toISOString();
  const held = await json(`/api/v1/admin/privacy/requests/${deletion.id}/actions`, admin, { method: 'POST', headers: writes(admin), body: JSON.stringify({ action: 'hold', reason: 'Synthetic acceptance hold for review.', holdUntil }) }, 201); schema('PrivacyRequest', held); assert.equal(held.status, 'held');
  const heldList = await json('/api/v1/admin/privacy/requests?status=held', admin); assert.ok(heldList.items.some(item => item.id === deletion.id && item.hold?.reason === 'Synthetic acceptance hold for review.'));
  const released = await json(`/api/v1/admin/privacy/requests/${deletion.id}/actions`, admin, { method: 'POST', headers: writes(admin), body: JSON.stringify({ action: 'release_hold', reason: 'Synthetic hold review completed.' }) }, 201); assert.equal(released.status, 'queued');
  await json(`/api/v1/admin/privacy/requests/${deletion.id}/actions`, admin, { method: 'POST', headers: writes(admin), body: JSON.stringify({ action: 'process', reason: 'Synthetic acceptance requested erasure.' }) }, 201);
  const complete = await waitFor(async () => { const row = await pool.query('SELECT status,stage,completed_at FROM privacy_request WHERE id=$1 AND owner_user_id=$2', [deletion.id, owner.id]); return row.rows[0]?.status === 'completed' ? row.rows[0] : null; }, 'Privacy deletion worker', 240, 500);
  assert.equal(complete.stage, 'complete');
  const deleted = await pool.query('SELECT status,email,oidc_issuer,oidc_subject FROM user_account WHERE id=$1', [owner.id]); assert.equal(deleted.rows[0].status, 'deleted'); assert.equal(deleted.rows[0].email, null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM journal_entry WHERE owner_user_id=$1', [owner.id])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM support_ticket WHERE requester_user_id=$1', [owner.id])).rows[0].n, 0);
  await assert.rejects(() => auth.createSession({ issuer: deletionFixture.issuer, subject: deletionFixture.subject, email: deletionFixture.email, emailVerified: true, sid: `p13-suppression-${key()}`, assurance: '1', authTime: Math.floor(Date.now() / 1000) }, undefined, false), error => error?.code === 'ACCOUNT_DELETED');
  const restored=await pool.query("UPDATE user_account SET oidc_issuer=$2,oidc_subject=$3,email=$4,email_verified=true,status='active' WHERE id=$1 AND synthetic=true AND status='deleted' RETURNING id",[owner.id,deletionFixture.issuer,deletionFixture.subject,deletionFixture.email]);assert.equal(restored.rowCount,1);
  const tokenHash=createHash('sha256').update(owner.token).digest('hex');assert.equal((await pool.query("UPDATE app_session SET revoked_at=NULL,issued_at=now(),last_seen_at=now(),expires_at=now()+interval '1 hour' WHERE user_id=$1 AND token_hash=$2 RETURNING id",[owner.id,tokenHash])).rowCount,1);
  const restoredSession=await request('/api/v1/me',owner,{},403);assert.equal(restoredSession.data?.code,'ACCOUNT_DELETED');assert.ok((await pool.query('SELECT revoked_at FROM app_session WHERE user_id=$1 AND token_hash=$2',[owner.id,tokenHash])).rows[0].revoked_at);
  console.log('PASS P13 report/appeal separation, private support access/owner revocation, real receipt SMTP, personal archive, deletion erasure and new/restored-session suppression.');
} catch (error) {
  const line = error?.stack?.match(/verify-p13-live\.mjs:(\d+)/)?.[1];
  console.error(`FAIL P13 ${stage}: ${error?.name ?? 'Error'}${line ? ` at driver line ${line}` : ''}; credentials and private payloads omitted.`);
  process.exitCode = 1;
} finally {
  try {
    await captureFixtureMailpitIds();
    const stored = users.length ? await pool.query('SELECT object_key FROM export_job WHERE owner_user_id=ANY($1::uuid[]) AND object_key IS NOT NULL', [users]) : { rows: [] };
    for (const row of stored.rows) await exportStorage.delete(row.object_key);
    if (deletionFixture) {
      const original=deletionFixture.original;assert.ok(original.synthetic&&original.oidc_subject.startsWith('p13-live-')&&original.email.endsWith('@example.invalid'));
      await pool.query(`UPDATE user_account SET oidc_issuer=$2,oidc_subject=$3,email=$4,email_verified=$5,status=$6,onboarding_version=$7,declaration_version=$8,policy_version=$9,synthetic=true WHERE id=$1`, [deletionFixture.ownerId, deletionFixture.original.oidc_issuer, deletionFixture.original.oidc_subject, deletionFixture.original.email, deletionFixture.original.email_verified, deletionFixture.original.status, deletionFixture.original.onboarding_version, deletionFixture.original.declaration_version, deletionFixture.original.policy_version]);
    }
    if (mailpitIds.size) {
      const base = (process.env.MAILPIT_URL ?? 'http://mailpit:8025').replace(/\/$/, '');
      const response = await fetch(`${base}/api/v1/messages`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ IDs: [...mailpitIds] }), signal: AbortSignal.timeout(10000) });
      assert.ok(response.ok, 'Exact-recipient Mailpit fixture cleanup failed.');
    }
    await cleanupP08Fixtures(pool, users);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_account WHERE id=ANY($1::uuid[])', [users])).rows[0].n, 0);
    for (const id of archiveJobs) await assert.equal((await pool.query('SELECT 1 FROM export_job WHERE id=$1', [id])).rowCount, 0);
    console.log('PASS generated P13 identities, support/privacy rows, export objects and exact-recipient Mailpit messages cleaned.');
  } catch {
    console.error('FAIL strict P13 fixture cleanup; generated identifiers and private payloads omitted.'); process.exitCode = 1;
  }
  await pool.end();
}
