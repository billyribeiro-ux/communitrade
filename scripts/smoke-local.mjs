import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseEnv } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env.local');
const startedAt = new Date().toISOString();
const results = [];

async function check(name, run) {
  try {
    await run();
    results.push({ name, ok: true });
  } catch {
    results.push({ name, ok: false });
  }
}

async function getResponse(url) {
  return fetch(url, { signal: AbortSignal.timeout(5_000), cache: 'no-store' });
}

async function readJson(url, expectedStatus = 200) {
  const response = await getResponse(url);
  if (response.status !== expectedStatus) throw new Error('unexpected response status');
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) throw new Error('expected JSON');
  return response.json();
}

function isWebHealth(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && value.status === 'ok';
}

function isApiHealth(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 2
    && value.status === 'ok'
    && typeof value.version === 'string'
    && value.version.length > 0
    && value.version.length <= 100;
}

async function checkApiHealth(name, url) {
  await check(name, async () => {
    if (!isApiHealth(await readJson(url))) throw new Error('unexpected health response schema');
  });
}

function localPort(env, key, fallback) {
  const value = env[key] ?? String(fallback);
  if (!/^\d{1,5}$/.test(value)) throw new Error('invalid local port');
  const port = Number(value);
  if (port < 1 || port > 65535) throw new Error('invalid local port');
  return port;
}

function runPsql() {
  const sql = `SELECT EXISTS (
    SELECT 1 FROM foundation_probe
    WHERE id = 'worker-heartbeat'
      AND created_at > :'smoke_started_at'::timestamptz
  );`;
  return spawnSync('docker', [
    'compose', '--env-file', '.env.local', 'exec', '-T', 'postgres',
    'sh', '-c',
    'psql -U "$APP_DB_USER" -d "$APP_DB_NAME" --no-psqlrc --tuples-only --no-align --set=smoke_started_at="$1"',
    'smoke-local', startedAt,
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    input: sql,
  });
}

async function checkWorkerHeartbeat() {
  await check('worker heartbeat', async () => {
    const deadline = Date.now() + 75_000;
    while (Date.now() < deadline) {
      const result = runPsql();
      if (result.status === 0 && result.stdout.trim() === 't') return;
      await sleep(1_000);
    }
    throw new Error('worker heartbeat not observed');
  });
}

try {
  const env = { ...parseEnv(await readFile(envPath, 'utf8')), ...process.env };
  const webPort = localPort(env, 'WEB_PORT', 3000);
  const apiPort = localPort(env, 'API_PORT', 3001);
  const keycloakPort = localPort(env, 'KEYCLOAK_PORT', 8080);
  const mailpitPort = localPort(env, 'MAILPIT_UI_PORT', 8025);

  await check('web', async () => {
    const response = await getResponse(`http://127.0.0.1:${webPort}/`);
    if (response.status !== 200) throw new Error('unexpected web status');
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('text/html')) throw new Error('expected HTML');
  });

  await check('web health', async () => {
    const response = await readJson(`http://127.0.0.1:${webPort}/health`);
    if (!isWebHealth(response)) throw new Error('unexpected web health response schema');
  });

  for (const pathName of ['live', 'ready']) {
    await checkApiHealth(
      `web proxy health ${pathName}`,
      `http://127.0.0.1:${webPort}/api/v1/health/${pathName}`,
    );
    await checkApiHealth(
      `direct API health ${pathName}`,
      `http://127.0.0.1:${apiPort}/api/v1/health/${pathName}`,
    );
  }

  await check('Keycloak discovery', async () => {
    const metadata = await readJson(
      `http://127.0.0.1:${keycloakPort}/realms/master/.well-known/openid-configuration`,
    );
    if (metadata.issuer !== `http://auth.localhost:${keycloakPort}/realms/master`
      || typeof metadata.authorization_endpoint !== 'string'
      || typeof metadata.jwks_uri !== 'string') {
      throw new Error('unexpected OIDC discovery response');
    }
  });

  await check('Mailpit API', async () => {
    const messages = await readJson(`http://127.0.0.1:${mailpitPort}/api/v1/messages`);
    if (messages === null || typeof messages !== 'object' || Array.isArray(messages)) {
      throw new Error('unexpected Mailpit response');
    }
  });

  await checkWorkerHeartbeat();
} catch {
  results.push({ name: 'local configuration', ok: false });
}

for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}`);
}

if (results.some((result) => !result.ok)) process.exitCode = 1;
