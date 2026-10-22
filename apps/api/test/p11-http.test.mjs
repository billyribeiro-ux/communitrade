import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {createApp} from '../dist/app.js';
test('P11 HTTP notification and saved-search routes validate real Express requests',async()=>{
 const owner=randomUUID(),id=randomUUID(),calls=[],actor={userId:owner},csrf='synthetic-token',auth={authenticate:async()=>actor,assertCsrf:async()=>{}},item={id,name:'Synthetic long calls',filters:{q:'P11',asset:'option',strategy:'long_call',author:'p11_synthetic'},revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
 const notifications={listNotifications:async(...args)=>{calls.push(['list',...args]);return{items:[],nextCursor:null,unreadCount:0};},markRead:async(...args)=>{calls.push(['read',...args]);},readAll:async()=>{},listSavedSearches:async()=>({items:[item],nextCursor:null}),createSavedSearch:async(...args)=>{calls.push(['create',...args]);return item;},updateSavedSearch:async()=>({...item,revision:2}),deleteSavedSearch:async()=>{},unsubscribeDigest:async()=>{}};
 const app=await createApp({$queryRaw:async()=>[]},null,{auth,notifications});
 try{
  await app.listen(0,'127.0.0.1');const origin=`http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`,headers={'Content-Type':'application/json','X-CSRF-Token':csrf,'Idempotency-Key':randomUUID()};
  const list=await fetch(`${origin}/notifications?unreadOnly=true&limit=5`);assert.equal(list.status,200);assert.equal(calls[0][4],'true');
  const created=await fetch(`${origin}/me/saved-searches`,{method:'POST',headers,body:JSON.stringify({name:item.name,filters:item.filters})});assert.equal(created.status,201,JSON.stringify(await created.clone().json()));assert.equal((await created.json()).id,id);assert.deepEqual(calls.find(call=>call[0]==='create').slice(1),[owner,headers['Idempotency-Key'],{name:item.name,filters:item.filters}]);
  const updated=await fetch(`${origin}/me/saved-searches/${id}`,{method:'PATCH',headers:{...headers,'If-Match':'"1"'},body:JSON.stringify({name:'Updated'})});assert.equal(updated.status,200);
  assert.equal((await fetch(`${origin}/me/saved-searches/${id}`,{method:'DELETE',headers:{...headers,'If-Match':'"2"'}})).status,204);
  const read=await fetch(`${origin}/notifications/${id}/read`,{method:'PUT',headers:{'X-CSRF-Token':csrf}});assert.equal(read.status,204,await read.text());
 }finally{await app.close();}
});
