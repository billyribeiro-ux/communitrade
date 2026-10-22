import { spawn } from 'node:child_process';

const child = spawn('docker', ['compose', '--env-file', '.env.local', 'exec', '-T', 'api', 'node', 'apps/api/scripts/verify-p08-live.mjs'], { stdio: 'inherit' });
child.once('error', () => { console.error('Could not launch local P08 live acceptance.'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
