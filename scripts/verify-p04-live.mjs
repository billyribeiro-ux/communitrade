import{readFile}from'node:fs/promises';import{parseEnv}from'node:util';import{spawn}from'node:child_process';
const env={...parseEnv(await readFile('.env.local','utf8')),...process.env};if(env.RELEASE_MODE!=='local')throw new Error('Live identity acceptance requires local mode.');
const personas=JSON.parse(await readFile('.local/identity-personas.json','utf8'));
const child=spawn('docker',['compose','--env-file','.env.local','exec','-T',...(process.env.P04_IDENTITY_ONLY?['-e','P04_IDENTITY_ONLY=1']:[]),...(process.env.P04_EMAIL_ONLY?['-e','P04_EMAIL_ONLY=1']:[]),'api','node','apps/api/scripts/verify-p04-live.mjs'],{stdio:['pipe','inherit','inherit']});
child.stdin.end(JSON.stringify({personas,adminUsername:env.KEYCLOAK_ADMIN,adminPassword:env.KEYCLOAK_ADMIN_PASSWORD}));
child.once('error',()=>{console.error('Could not launch local P04 verification.');process.exitCode=1;});
child.once('exit',code=>{process.exitCode=code??1;});
