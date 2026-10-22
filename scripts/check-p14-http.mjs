import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
const server=spawn('pnpm',['--filter','@trading/web','exec','next','start','--hostname','127.0.0.1','--port',String(port)],{
  cwd:new URL('..',import.meta.url),env:{...process.env,NODE_ENV:'production',RELEASE_MODE:'local'},stdio:'ignore',detached:true});
const origin=`http://127.0.0.1:${port}`;
try{
  let ready=false;for(let i=0;i<100;i++){
    if(server.exitCode!==null)throw new Error('Optimized web server exited before readiness.');
    try{const response=await fetch(`${origin}/health`,{signal:AbortSignal.timeout(1000)});if(response.ok){ready=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  assert.ok(ready);
  const nonces=[];
  for(let i=0;i<2;i++){
    const response=await fetch(origin,{headers:{'x-nonce':'untrusted-browser-value','Content-Security-Policy':"script-src 'unsafe-inline'"},signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,200);const policy=response.headers.get('content-security-policy')??'',html=await response.text();
    const nonce=policy.match(/'nonce-([^']+)'/)?.[1];assert.ok(nonce);nonces.push(nonce);
    assert.ok(!policy.includes('unsafe-eval'));assert.ok(!policy.includes('untrusted-browser-value'));
    assert.match(policy,/frame-ancestors 'none'/);assert.match(policy,/object-src 'none'/);
    assert.equal(response.headers.get('x-frame-options'),'DENY');
    const executable=[...html.matchAll(/<script\b([^>]*)>/g)].filter(([,attrs])=>!attrs.includes('application/ld+json'));
    assert.ok(executable.length>0);for(const [,attrs]of executable)assert.ok(attrs.includes(`nonce="${nonce}"`),'served framework scripts receive the document CSP nonce');
  }
  assert.notEqual(nonces[0],nonces[1]);
  const proxy=await fetch(`${origin}/api/v1/health/live`,{signal:AbortSignal.timeout(15000)});assert.equal(proxy.status,200);assert.match(proxy.headers.get('cache-control')??'',/no-store/);
  const privatePage=await fetch(`${origin}/app`,{redirect:'manual',signal:AbortSignal.timeout(15000)});assert.ok([307,308].includes(privatePage.status));assert.match(privatePage.headers.get('location')??'',/^\/login/);
  console.log('PASS optimized HTTP nonce uniqueness/injection, restrictive production script policy, no-store proxy and private redirects. This is not rendered browser acceptance.');
}finally{
  try{process.kill(-server.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH'){console.error('Could not stop optimized HTTP check server.');process.exitCode=1;}}
  await new Promise(resolve=>{if(server.exitCode!==null)return resolve();const timer=setTimeout(resolve,3000);server.once('exit',()=>{clearTimeout(timer);resolve();});});
}
