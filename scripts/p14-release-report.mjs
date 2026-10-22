import {readFile,access} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const record=JSON.parse(await readFile(resolve(root,'docs/implementation/p14-release-status.json'),'utf8'));
if(record.schemaVersion!==1||record.gates.length!==12||new Set(record.gates.map(g=>g.id)).size!==12)throw new Error('Invalid release gate register.');
const blockers=[];
for(let i=0;i<12;i++){
  const gate=record.gates[i];if(gate.id!==`G${String(i+1).padStart(2,'0')}`||!gate.owner||!gate.reason)throw new Error('Release gate metadata incomplete.');
  if(gate.status!=='passed'){blockers.push(gate.id);continue;}
  if(!gate.reviewer||!gate.reviewedAt||!Number.isFinite(Date.parse(gate.reviewedAt))||!Array.isArray(gate.evidence)||gate.evidence.length===0)throw new Error('Passing gate lacks review evidence.');
  if(gate.expiresAt&&Date.parse(gate.expiresAt)<=Date.now()){blockers.push(gate.id);continue;}
  for(const artifact of gate.evidence){const path=resolve(root,artifact);if(relative(root,path).startsWith('..'))throw new Error('Gate artifact must be in the reviewed repository.');await access(path);}
}
const decision=blockers.length?'NO_GO':'REVIEW_REQUIRED';
// This reports recorded evidence. It never grants deployment/launch authorization.
console.log(JSON.stringify({decision,reviewDate:record.reviewDate,openGates:blockers,deploys:false,charges:false,note:'Artifact presence and configured flags do not establish commercial or legal approval.'},null,2));
if(process.argv.includes('--require-ready')&&blockers.length)process.exitCode=1;
