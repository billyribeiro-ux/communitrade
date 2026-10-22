import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// P14 local recovery rehearsal. It creates generated empty databases; the
// configured app DB and Docker volumes are never mutated.
const suffix = randomUUID().replaceAll('-', '').slice(0, 20);
const sourceDb = `p14_source_${suffix}`;
const restoreDb = `p14_restore_${suffix}`;
const scratch = await mkdtemp(join(tmpdir(), 'p14-recovery-'));
const dumpFile = join(scratch, 'checkpoint.dump');
const ledgerFile = join(scratch, 'newer-suppression-ledger.json');
let sourceCreated = false;
let restoreCreated = false;
let report;
let failure;

function compose(args, input) {
  const result = spawnSync('docker', ['compose', '--env-file', '.env.local', ...args], { input, encoding: input === undefined ? 'utf8' : null, timeout: 30 * 60_000, maxBuffer: 512 * 1024 * 1024 });
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr ?? '';
    const safeDiagnostic = stderr.slice(-1200).replace(/(postgres(?:ql)?:\/\/)[^\s]+/gi, '$1[redacted]');
    throw new Error(`docker compose ${args.slice(0, 7).join(' ')} failed (${result.status ?? result.signal ?? 'unknown'}).${safeDiagnostic ? ` ${safeDiagnostic}` : ''}`);
  }
  return result;
}
function composeBinary(args) {
  const result = spawnSync('docker', ['compose', '--env-file', '.env.local', ...args], { encoding: null, timeout: 30 * 60_000, maxBuffer: 512 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`docker compose ${args[0]} failed (${result.status ?? result.signal ?? 'unknown'}).`);
  return result;
}
function admin(sql) {
  compose(['exec', '-T', 'postgres', 'sh', '-c', 'psql -X -q -v ON_ERROR_STOP=1 -v app_role="$APP_DB_USER" -v app_db="$APP_DB_NAME" -U postgres -d postgres'], sql);
}
function inApi(extraEnv = {}) {
  return compose(['exec', '-T', ...Object.entries(extraEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]), 'api', 'node', innerScript]);
}

const innerScript = 'apps/api/scripts/p14-recovery-inner.mjs';

try {
  const config = Object.fromEntries((await readFile('.env.local', 'utf8')).split(/\r?\n/).filter(line => /^[A-Z0-9_]+=/.test(line)).map(line => { const i=line.indexOf('='); return [line.slice(0,i),line.slice(i+1).replace(/^['"]|['"]$/g,'')]; }));
  if (!config.DATABASE_URL || !config.APP_DB_NAME) throw new Error('LOCAL_ENV_MISSING_DATABASE_URL');
  if (new URL(config.DATABASE_URL).pathname !== `/${config.APP_DB_NAME}` || config.RELEASE_MODE !== 'local' || (config.MARKET_DATA_PROVIDER ?? 'synthetic') !== 'synthetic') throw new Error('LOCAL_ONLY_DATABASE_GUARD_FAILED');
  const variables = { P14_RUN_ID:suffix, P14_SOURCE_DB:sourceDb, P14_RESTORE_DB:restoreDb };
  admin(`CREATE DATABASE "${sourceDb}" OWNER :"app_role";\n`);
  sourceCreated = true;
  inApi({ ...variables, P14_PHASE:'migrate-seed' });
  const prepared = inApi({ ...variables, P14_PHASE:'prepare' });
  const prepare = JSON.parse(prepared.stdout.trim().split('\n').at(-1));
  const baseDump = composeBinary(['exec','-T','postgres','pg_dump','-U','postgres','-Fc','-d',sourceDb]);
  await writeFile(dumpFile, baseDump.stdout);
  const afterCheckpoint = inApi({ ...variables, P14_PHASE:'post-checkpoint' });
  const postCheckpoint = JSON.parse(afterCheckpoint.stdout.trim().split('\n').at(-1));
  admin(`CREATE DATABASE "${restoreDb}" OWNER :"app_role";\n`);
  restoreCreated = true;
  const recoveryStartedAt = new Date();
  const bytes = await readFile(dumpFile);
  compose(['exec','-T','postgres','pg_restore','-U','postgres','-d',restoreDb,'--no-owner','--role',config.APP_DB_USER], bytes);
  const erased = inApi({ ...variables, P14_PHASE:'erase-and-export', P14_OWNER_A:prepare.ownerA });
  const ledger = JSON.parse(erased.stdout.trim().split('\n').at(-1)).ledger;
  await writeFile(ledgerFile, JSON.stringify({ schemaVersion:1, entries:ledger }), { mode:0o600, flag:'wx' });
  const ledgerB64 = Buffer.from(JSON.stringify(ledger)).toString('base64');
  const verify = inApi({ ...variables, P14_PHASE:'restore-and-verify', P14_OWNER_A:prepare.ownerA, P14_OWNER_B:prepare.ownerB, P14_PUBLICATION:prepare.publicationId, P14_OBJECT_KEY:prepare.objectKey, P14_OBJECT_HASH:prepare.objectHash, P14_CHECKPOINT_WATERMARK:prepare.checkpointCommittedAt, P14_LEDGER_B64:ledgerB64 });
  const checks = JSON.parse(verify.stdout.trim().split('\n').at(-1));
  inApi({ ...variables, P14_PHASE:'cleanup-objects' });
  const lostWindowMs=Date.parse(postCheckpoint.postCheckpointCommittedAt)-Date.parse(prepare.checkpointCommittedAt);
  if(!Number.isFinite(lostWindowMs)||lostWindowMs<0)throw new Error('INVALID_SYNTHETIC_WATERMARK_INTERVAL');
  report={result:'PASS',scope:'local synthetic isolated database rehearsal',generatedDatabases:[sourceDb,restoreDb],checkpoint:'custom-format pg_dump of generated source DB',checkpointCommittedAt:prepare.checkpointCommittedAt,postCheckpointSyntheticCommitAt:postCheckpoint.postCheckpointCommittedAt,simulatedCommittedDataLossWindowMs:lostWindowMs,restoreElapsedMs:Date.now()-recoveryStartedAt.getTime(),suppressionEntries:ledger.length,snapshotObjectSha256:checks.snapshotObjectSha256,checks:checks.checks,rpoClaim:false,note:'The loss window is the measured interval between two synthetic watermark commits. Restore elapsed time is local only; neither value establishes production RPO/RTO.'};
} catch (error) {
  failure=error instanceof Error?error.message:'P14_RECOVERY_FAILED';
} finally {
  try { compose(['exec','-T','api','rm','-rf',`/tmp/p14-recovery-${suffix}`]); } catch { failure??='GENERATED_OBJECT_CLEANUP_FAILED'; }
  if (restoreCreated) { try { admin(`DROP DATABASE "${restoreDb}" WITH (FORCE);\n`); } catch { failure??='GENERATED_RESTORE_DATABASE_CLEANUP_FAILED'; } }
  if (sourceCreated) { try { admin(`DROP DATABASE "${sourceDb}" WITH (FORCE);\n`); } catch { failure??='GENERATED_SOURCE_DATABASE_CLEANUP_FAILED'; } }
  try { await rm(scratch,{recursive:true,force:true}); } catch { failure??='RECOVERY_SCRATCH_CLEANUP_FAILED'; }
}
if(failure){console.error(failure);process.exitCode=1;}else console.log(JSON.stringify(report,null,2));
