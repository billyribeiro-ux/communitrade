import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

// Proves the production app-role bootstrap against a fresh local database.
// Every created cluster role and database has a random prefix; no app or
// identity database, role, schema, or volume is modified.
const token = randomBytes(8).toString('hex');
const prefix = `p14proof_${token}`;
const database = `${prefix}_db`;
const roles = {
  bootstrap: `${prefix}_bootstrap`,
  migrator: `${prefix}_migrator`,
  api: `${prefix}_api`,
  worker: `${prefix}_worker`,
};
const allRoles = Object.values(roles);
let createdRoles = false;
let createdDatabase = false;

function psql(databaseName, sql, variables = {}) {
  const args = [
    'compose', '--env-file', '.env.local', 'exec', '-T', 'postgres',
    'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', databaseName,
  ];
  for (const [key, value] of Object.entries(variables)) args.push('-v', `${key}=${value}`);
  const result = spawnSync('docker', args, { input: sql, encoding: 'utf8', timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) {
    // Keep database output (which may include SQL) out of reports and logs.
    throw new Error(`PostgreSQL role proof step failed (${databaseName}, exit ${result.status ?? 'signal'}).`);
  }
  return result.stdout.trim();
}

function assertValue(actual, expected, description) {
  if (actual.trim() !== expected) throw new Error(`Role proof failed: ${description}.`);
}

function substituteRoleNames(sql) {
  for (const [fixedName, generatedName] of Object.entries({
    trading_bootstrap: roles.bootstrap,
    trading_migrator: roles.migrator,
    trading_api: roles.api,
    trading_worker: roles.worker,
  })) {
    sql = sql.replaceAll(new RegExp(`\\b${fixedName}\\b`, 'g'), generatedName);
  }
  // The local proof creates NOLOGIN roles without passwords; test with SET
  // ROLE as superuser rather than authenticating as any temporary principal.
  return sql
    .replace(/^\s*\\prompt\b.*\n/gm, '')
    .replace(/^\s*\\password\b.*\n/gm, '')
    .replace(/^CREATE ROLE .*;\s*$/gm, '');
}

try {
  const collisions = psql('postgres', `SELECT count(*) FROM pg_roles WHERE rolname LIKE '${prefix}_%';`);
  assertValue(collisions, '0', 'generated role prefix was already present');

  psql('postgres', `
    CREATE ROLE ${roles.bootstrap} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
    CREATE ROLE ${roles.migrator} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
    CREATE ROLE ${roles.api} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
    CREATE ROLE ${roles.worker} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  `);
  createdRoles = true;
  psql('postgres', `CREATE DATABASE ${database} OWNER ${roles.bootstrap};`);
  createdDatabase = true;

  // Prepare current objects as the future migrator so the SQL's existing
  // table/sequence grants are exercised in addition to default privileges.
  psql(database, `
    GRANT USAGE, CREATE ON SCHEMA public TO ${roles.migrator};
    SET ROLE ${roles.migrator};
    CREATE TABLE public.p14_proof_existing_table (id integer PRIMARY KEY);
    CREATE SEQUENCE public.p14_proof_existing_sequence;
    RESET ROLE;
  `);

  const bootstrap = substituteRoleNames(await readFile('infra/production/bootstrap-app-roles.sql', 'utf8'));
  psql(database, bootstrap, { app_database: database });

  psql(database, `
    SET ROLE ${roles.migrator};
    CREATE TABLE public.p14_proof_future_table (id integer PRIMARY KEY);
    CREATE SEQUENCE public.p14_proof_future_sequence;
    RESET ROLE;
  `);

  const grants = psql(database, `
    SELECT
      (SELECT bool_and(has_table_privilege(r, t, p))
        FROM unnest(ARRAY['${roles.api}','${roles.worker}']) AS r
        CROSS JOIN unnest(ARRAY['public.p14_proof_existing_table','public.p14_proof_future_table']) AS t
        CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p)
      AND (SELECT bool_and(has_sequence_privilege(r, s, p))
        FROM unnest(ARRAY['${roles.api}','${roles.worker}']) AS r
        CROSS JOIN unnest(ARRAY['public.p14_proof_existing_sequence','public.p14_proof_future_sequence']) AS s
        CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) AS p);
  `);
  assertValue(grants, 't', 'API and worker current/default DML and sequence privileges');

  const roleFlags = psql(database, `
    SELECT bool_and(NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND NOT r.rolcanlogin)
    FROM pg_roles r WHERE r.rolname IN ('${roles.migrator}','${roles.api}','${roles.worker}');
  `);
  assertValue(roleFlags, 't', 'temporary migration and runtime roles are non-login and non-admin');

  const pgbossOwner = psql(database, `
    SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='pgboss';
  `);
  assertValue(pgbossOwner, roles.worker, 'worker is the owner of the pgboss schema');
  const workerCanCreatePgboss = psql(database, `SELECT has_schema_privilege('${roles.worker}', 'pgboss', 'CREATE');`);
  assertValue(workerCanCreatePgboss, 't', 'worker can create only within its queue schema');

  psql(database, `BEGIN; SET ROLE ${roles.migrator}; CREATE TABLE public.p14_proof_migrator_ddl (id integer); ROLLBACK;`);
  for (const role of [roles.api, roles.worker]) {
    for (const [operation, sql] of [
      ['public schema CREATE', `SET ROLE ${role}; CREATE TABLE public.p14_proof_denied (id integer);`],
      ['public table DROP', `SET ROLE ${role}; DROP TABLE public.p14_proof_existing_table;`],
      ['public table TRUNCATE', `SET ROLE ${role}; TRUNCATE TABLE public.p14_proof_existing_table;`],
    ]) {
      const result = spawnSync('docker', [
        'compose', '--env-file', '.env.local', 'exec', '-T', 'postgres',
        'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database,
      ], { input: sql, encoding: 'utf8', timeout: 30_000, maxBuffer: 512 * 1024 });
      if (result.status === 0) throw new Error(`Role proof failed: ${role} unexpectedly has ${operation}.`);
      if (!/permission denied|must be owner/i.test(result.stderr ?? '')) {
        throw new Error(`Role proof could not verify ${role} is denied ${operation}.`);
      }
    }
  }

  const apiPgboss = psql(database, `SELECT has_schema_privilege('${roles.api}', 'pgboss', 'USAGE,CREATE');`);
  assertValue(apiPgboss, 'f', 'API has no pg-boss schema access');
  console.log('PASS isolated P14 app-role proof: current/default grants, migrator DDL, runtime CREATE/DROP/TRUNCATE denials, and worker-only pgboss ownership.');
} finally {
  if (createdDatabase) psql('postgres', `DROP DATABASE ${database} WITH (FORCE);`);
  if (createdRoles) psql('postgres', `DROP ROLE ${allRoles.join(', ')};`);
}
