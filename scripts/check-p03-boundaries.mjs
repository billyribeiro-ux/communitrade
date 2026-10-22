import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {createServer} from 'node:net';

const root=new URL('..',import.meta.url).pathname;
const markers=['SYNTHETIC','Illustrative','preview'];
const productionBuild=spawnSync('pnpm',['--filter','@trading/web','build'],{cwd:root,env:{...process.env,RELEASE_MODE:'production'},encoding:'utf8',timeout:120_000});
assert.notEqual(productionBuild.status,0,'production build stays closed until policy approval evidence exists');
assert.match(`${productionBuild.stdout??''}\n${productionBuild.stderr??''}`,/approval evidence|release blocked/i,'production build reports its incomplete approval gate');
async function withServer(_requestedPort,localPreview,run){
  // Fixed ports can reach an orphan from an earlier run instead of this build.
  const reservation=createServer();
  await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;
  await new Promise((resolve,reject)=>reservation.close(error=>error?reject(error):resolve()));
  const env={...process.env,RELEASE_MODE:'local',API_INTERNAL_URL:process.env.API_INTERNAL_URL??'http://127.0.0.1:3999'};
  if(localPreview)env.LOCAL_DESIGN_PREVIEW='1';else delete env.LOCAL_DESIGN_PREVIEW;
  const server=spawn('pnpm',['--filter','@trading/web','exec','next','start','--hostname','127.0.0.1','--port',String(port)],{cwd:root,env,stdio:'ignore',detached:true});
  const origin=`http://127.0.0.1:${port}`;
  let cleanupFailure;
  try{
    let ready=false;
    for(let attempt=0;attempt<100;attempt++){
      if(server.exitCode!==null)throw new Error(`Next server exited with ${server.exitCode}`);
      try{await fetch(origin,{signal:AbortSignal.timeout(500)});ready=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,250));}
    }
    assert.ok(ready,`Next server on ${port} became ready`);
    await run(origin);
  }finally{try{process.kill(-server.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')cleanupFailure=error;}await new Promise(resolve=>{if(server.exitCode!==null)return resolve();const timeout=setTimeout(resolve,2500);server.once('exit',()=>{clearTimeout(timeout);resolve();});});}
  if(cleanupFailure)throw cleanupFailure;
}
async function request(origin,path,headers={}){const response=await fetch(new URL(path,origin),{headers,redirect:'manual',signal:AbortSignal.timeout(15_000)});return{response,text:await response.text()};}
async function requireLogin(origin,path){const {response}=await request(origin,path);assert.ok([307,308].includes(response.status),`${path} remains session-gated`);assert.match(response.headers.get('location')??'',/^\/login\?returnTo=/,`${path} redirects to sign in`);}

// This server uses the optimized build but has no fixture flag: public demo records
// and controls must stay unavailable, while private routes redirect through identity.
await withServer(3103,false,async origin=>{
  for(const path of ['/ideas/idea-demo-01/spy-defined-risk-call-spread','/ideas/idea-demo-02/mes-levels-and-invalidation','/instruments/instrument-demo-spy','/design-preview','/support/requests/support-demo-01','/share/ideas/idea-demo-01/1.png']){
    const {response,text}=await request(origin,path);
    assert.equal(response.status,404,`${path} fixture endpoint unavailable without local preview`);
    assert.ok(!text.includes('Synthetic example chart')&&!text.includes('SYNTHETIC PREVIEW'),`${path} fixture details absent`);
  }
  for(const path of ['/app','/app/profile','/admin','/admin/users'])await requireLogin(origin,path);
  const {response:ideas,text:ideasHtml}=await request(origin,'/ideas');
  assert.equal(ideas.status,200,'real public ideas empty state renders');
  assert.match(ideasHtml,/Ideas could not be loaded|No public ideas are available yet/i,'connected publication feed reports a truthful empty or unavailable state');
  assert.ok(!ideasHtml.includes('idea-demo-01'),'default ideas page contains no P03 fixtures');
  assert.ok(!ideasHtml.includes('public publication feed is not connected'),'boundary test must use the current connected build, not an old shell artifact');
});

// Explicit preview mode enables only named synthetic public design examples. It does
// not alter authenticated app/admin boundaries, even on an optimized Next build.
await withServer(3104,true,async origin=>{
  for(const path of ['/design-preview','/ideas/idea-demo-01/spy-defined-risk-call-spread']){
    const {response,text}=await request(origin,path);
    assert.equal(response.status,200,`${path} is available in explicit local design preview`);
    assert.ok(markers.some(marker=>text.includes(marker)),`${path} labels its synthetic content`);
  }
  // P05 replaces the old instrument sketch with real UUID/catalog access. The
  // design-preview flag must not re-enable that obsolete fixture route.
  assert.equal((await request(origin,'/instruments/instrument-demo-spy')).response.status,404);
  const catalog=await request(origin,'/instruments');
  assert.equal(catalog.response.status,200);
  assert.match(catalog.text,/Catalog unavailable/i,'missing API produces an explicit failure state');
  assert.ok(!catalog.text.includes('SYN-XYZ'),'missing API never substitutes the local catalog');
  for(const path of ['/app','/app/profile','/admin','/admin/users'])await requireLogin(origin,path);
  const {text:privateMarketing}=await request(origin,'/');
  assert.doesNotMatch(privateMarketing,/PRIVATE_SENTINEL|CSRF_SENTINEL|private\.sentinel@example\.test/i,'marketing page exposes no account fixture data');
});
console.log('PASS production-build fixture and authentication boundary HTTP checks.');
