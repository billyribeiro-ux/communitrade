import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

// Local synthetic service-load harness. Creates and drops one generated DB;
// never accepts a caller-supplied database name or changes Docker volumes.
const id = randomUUID().replaceAll('-', '').slice(0, 20);
const database = `p14_load_${id}`;
const poolMax = Number(process.env.P14_LOAD_POOL_MAX ?? 8);
if (![8, 20].includes(poolMax)) throw new Error('LOAD_POOL_MAX_MUST_BE_8_OR_20');

function compose(args, input) {
  const result = spawnSync('docker', ['compose', '--env-file', '.env.local', ...args], { input, encoding: 'utf8', timeout: 45 * 60_000, maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) {
    const safeDiagnostic = String(result.stderr ?? '').slice(-1200).replace(/(postgres(?:ql)?:\/\/)[^\s]+/gi, '$1[redacted]');
    throw new Error(`docker compose ${args.slice(0, 7).join(' ')} failed (${result.status ?? result.signal ?? 'unknown'}).${safeDiagnostic ? ` ${safeDiagnostic}` : ''}`);
  }
  return result;
}
function admin(sql) {
  compose(['exec','-T','postgres','sh','-c','psql -X -q -v ON_ERROR_STOP=1 -v app_role="$APP_DB_USER" -U postgres -d postgres'],sql);
}
function api(extra = {}) {
  return compose(['exec','-T',...Object.entries(extra).flatMap(([k,v])=>['-e',`${k}=${v}`]),'api','node',innerScript]);
}

const innerScript = 'apps/api/scripts/p14-load-inner.mjs';

let created = false;
let report;
let failure;
try {
  const env = Object.fromEntries((await readFile('.env.local','utf8')).split(/\r?\n/).filter(x=>/^[A-Z0-9_]+=/.test(x)).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1).replace(/^['"]|['"]$/g,'')];}));
  if (!env.DATABASE_URL || !env.APP_DB_NAME) throw new Error('LOCAL_ENV_MISSING_DATABASE_URL');
  if (new URL(env.DATABASE_URL).pathname !== `/${env.APP_DB_NAME}` || env.RELEASE_MODE !== 'local' || (env.MARKET_DATA_PROVIDER ?? 'synthetic') !== 'synthetic') throw new Error('LOCAL_ONLY_DATABASE_GUARD_FAILED');
  admin(`CREATE DATABASE "${database}" OWNER :"app_role";\n`);
  created = true;
  api({P14_LOAD_DB:database,P14_LOAD_RUN:id,P14_LOAD_POOL_MAX:String(poolMax),P14_LOAD_PHASE:'migrate-seed'});
  const result=api({P14_LOAD_DB:database,P14_LOAD_RUN:id,P14_LOAD_POOL_MAX:String(poolMax)});
  const measurements=JSON.parse(result.stdout.trim().split('\n').at(-1));
  const required={plainFeed:40,publicationSearch:20,chartHistory:20,authenticatedPrivateRead:10,authenticatedPrivateWrite:10,sessionAuthentication:100};
  const checks=Object.fromEntries(Object.entries(required).map(([name,minSamples])=>{
    const metric=measurements.measurements?.requestDurationMs?.[name];
    const maximumP95Ms=name==='publicationSearch'?1000:750;
    return [name,{maximumP95Ms,minimumSamples:minSamples,passed:Boolean(metric&&Number.isFinite(metric.p95)&&metric.p95>=0&&metric.p95<maximumP95Ms&&metric.samples>=minSamples)}];
  }));
  report={result:Object.values(checks).every(check=>check.passed)?'PASS':'FAIL',database,thresholdChecks:checks,report:measurements};
} catch(error) {
  failure=error instanceof Error?error.message:'P14_LOAD_FAILED';
} finally {
  if(created)try{admin(`DROP DATABASE "${database}" WITH (FORCE);\n`);}catch{failure??='GENERATED_LOAD_DATABASE_CLEANUP_FAILED';}
}
if(failure){console.error(failure);process.exitCode=1;}else{console.log(JSON.stringify(report,null,2));if(report.result!=='PASS')process.exitCode=1;}
