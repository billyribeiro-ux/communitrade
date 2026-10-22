import { chmod, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { applyRestoreSuppression, readSuppressionLedger } from './privacy.js';

const {Pool}=pg;
type Entry={subjectHmac:string;keyVersion:string;requestId:string};
function usage():never{throw new Error('Usage: privacy-restore-suppression export <ledger.json> | apply <ledger.json> --confirm RESTORE-SUPPRESSION');}
export async function runPrivacyRestoreSuppression(args=process.argv.slice(2),env=process.env):Promise<void>{
  const [mode,file,...rest]=args;if(!file||!['export','apply'].includes(mode??''))usage();
  const target=resolve(file);const connectionString=env.DATABASE_URL;if(!connectionString)throw new Error('DATABASE_URL_REQUIRED');
  const pool=new Pool({connectionString,max:1,connectionTimeoutMillis:3000,query_timeout:30000});
  try{
    if(mode==='export'){
      if(rest.length)usage();const entries=await readSuppressionLedger(pool);const bytes=JSON.stringify({format:'p13-suppression-ledger-v1',entries},null,2)+'\n';
      await writeFile(target,bytes,{encoding:'utf8',mode:0o600,flag:'wx'});await chmod(target,0o600);console.info(`Exported ${entries.length} suppression digests to a new private file.`);return;
    }
    if(rest.length!==2||rest[0]!=='--confirm'||rest[1]!=='RESTORE-SUPPRESSION'||env.PRIVACY_RESTORE_CONFIRM!=='YES-RESTORE-SUPPRESSION')usage();
    const raw=await readFile(target);if(raw.byteLength>20*1024*1024)throw new Error('SUPPRESSION_LEDGER_TOO_LARGE');
    const parsed=JSON.parse(raw.toString('utf8')) as {format?:string;entries?:Entry[]};if(parsed.format!=='p13-suppression-ledger-v1'||!Array.isArray(parsed.entries))throw new Error('INVALID_SUPPRESSION_LEDGER');
    const key=env.PRIVACY_SUPPRESSION_KEY??'';const result=await applyRestoreSuppression(pool,parsed.entries,{key,limit:10000});console.info(`Imported suppression ledger; matched ${result.matched} restored accounts and queued ${result.queued} erasure workflows.`);
  }finally{await pool.end();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  runPrivacyRestoreSuppression().catch(error=>{console.error(error instanceof Error?error.message:'Privacy restore suppression failed.');process.exitCode=1;});
}
