import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Creates and removes only its own isolated acceptance database. Existing app,
// Keycloak databases and Docker volumes are never reset.
const databaseName = `p02_acceptance_${randomUUID().replaceAll('-', '')}`;
function compose(args, input) {
  const result = spawnSync('docker', ['compose', '--env-file', '.env.local', ...args], {
    input, encoding: 'utf8', timeout: 240_000, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error('Isolated database acceptance failed.');
}
function adminSql(sql) {
  compose(['exec', '-T', 'postgres', 'sh', '-c', 'psql -X -q -v ON_ERROR_STOP=1 -v app_role="$APP_DB_USER" -U postgres -d postgres'], sql);
}
let created = false;
try {
  adminSql(`CREATE DATABASE "${databaseName}" OWNER :"app_role";`);
  created = true;
  const verify = `
    const {spawnSync}=await import('node:child_process');
    const url=new URL(process.env.DATABASE_URL);url.pathname='/'+process.argv[1];
    const env={...process.env,DATABASE_URL:url.href,TEST_DATABASE_URL:url.href};
    for(const script of ['db:generate','db:migrate','test:p13:last-admin','db:seed','db:seed','test','check:migrations']){
      const result=spawnSync('pnpm',[script],{env,stdio:'inherit'});
      if(result.status!==0) process.exit(result.status??1);
    }
  `;
  compose(['exec', '-T', 'api', 'node', '--input-type=module', '-e', verify, databaseName]);
  console.log('PASS migration from empty, repeat seed and full suite against isolated PostgreSQL database.');
} finally {
  if (created) {
    adminSql(`DROP DATABASE "${databaseName}" WITH (FORCE);`);
    console.log('Isolated acceptance database removed; application/identity databases and volumes preserved.');
  }
}
