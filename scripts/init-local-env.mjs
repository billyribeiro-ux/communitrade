import { randomBytes } from 'node:crypto';
import { open, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const examplePath = path.join(root, '.env.example');
const localPath = path.join(root, '.env.local');

try {
  await open(localPath, 'wx', 0o600).then(async (file) => {
    await file.close();
  });
} catch (error) {
  if (error.code === 'EEXIST') {
    console.error('.env.local already exists; leaving it untouched.');
    process.exitCode = 1;
  } else {
    throw error;
  }
}

if (process.exitCode !== 1) {
  const template = await readFile(examplePath, 'utf8');
  const secrets = {
    APP_DB_PASSWORD: randomBytes(24).toString('hex'),
    IDENTITY_DB_PASSWORD: randomBytes(24).toString('hex'),
    POSTGRES_BOOTSTRAP_PASSWORD: randomBytes(24).toString('hex'),
    KEYCLOAK_ADMIN_PASSWORD: randomBytes(24).toString('hex'),
    SESSION_SECRET: randomBytes(32).toString('hex'),
    DATA_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    PUBLICATION_RENDER_HMAC_SECRET: randomBytes(32).toString('hex'),
    OIDC_CLIENT_SECRET: randomBytes(32).toString('hex'),
  };
  let env = template;
  for (const [key, value] of Object.entries(secrets)) {
    env = env.replaceAll(`${key}=GENERATE_ME`, `${key}=${value}`);
  }
  env = env.replace('postgresql://options_app:GENERATE_ME@postgres:5432/options_app?schema=public',
    `postgresql://options_app:${secrets.APP_DB_PASSWORD}@postgres:5432/options_app?schema=public`);
  env = env.replaceAll('=GENERATE_ME', '=');
  env = env.replace(/KC_DB_PASSWORD=$/m, `KC_DB_PASSWORD=${secrets.IDENTITY_DB_PASSWORD}`);
  await writeFile(localPath, env, { mode: 0o600, flag: 'w' });
  console.log('Created ignored .env.local with fresh local-only credentials.');
}
