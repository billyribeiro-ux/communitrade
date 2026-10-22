import {test} from 'node:test';
import assert from 'node:assert/strict';
import {safeReturnPath,parsePlanIntent,readPlanIntent,intentQuery,postOnboardingPath} from '../src/lib/navigation.ts';
import {assertReleaseReady,policies} from '../src/lib/policies.ts';
test('plan preferences survive serialization while unsafe redirects and arbitrary entitlements are rejected',()=>{
  const intent=parsePlanIntent({plan:'pro',interval:'year',returnTo:'/app/journal?tag=review'});
  assert.deepEqual(readPlanIntent(JSON.stringify(intent)),intent);
  assert.equal(new URLSearchParams(intentQuery(intent)).get('interval'),'year');
  for(const value of ['https://evil.test','//evil.test','/\\evil.test','/login','/api/v1/secret','javascript:alert(1)','/app\nLocation: evil','/%2f%2fevil']) assert.equal(safeReturnPath(value),'/app');
  assert.equal(readPlanIntent('null'),null);
  assert.equal(readPlanIntent('{'),null);
  assert.deepEqual(parsePlanIntent({plan:'admin',interval:'forever',returnTo:'/app'}),{plan:'free',interval:'month',returnTo:'/app'});
});
test('onboarding preserves monthly or annual plan intent without accepting a hostile return path',()=>{
  const annual=parsePlanIntent({plan:'pro',interval:'year',returnTo:'/app/journal?tag=review'});
  const annualNext=new URL(postOnboardingPath(annual),'https://local.test');
  assert.equal(annualNext.pathname,'/subscribe');
  assert.equal(annualNext.searchParams.get('plan'),'pro');
  assert.equal(annualNext.searchParams.get('interval'),'year');
  assert.equal(annualNext.searchParams.get('returnTo'),'/app/journal?tag=review');
  const monthly=parsePlanIntent({plan:'pro',interval:'month',returnTo:'//evil.invalid'});
  const monthlyNext=new URL(postOnboardingPath(monthly),'https://local.test');
  assert.equal(monthlyNext.searchParams.get('interval'),'month');
  assert.equal(monthlyNext.searchParams.get('returnTo'),'/app');
  assert.equal(postOnboardingPath(parsePlanIntent({plan:'free',returnTo:'/ideas'})),'/ideas');
});
test('production release is closed while versioned legal approval records are drafts',()=>{
  assert.ok(policies.every(x=>x.status==='draft'&&!x.approverReference&&!x.effectiveDate));
  assert.doesNotThrow(()=>assertReleaseReady({RELEASE_MODE:'local'}));
  assert.throws(()=>assertReleaseReady({RELEASE_MODE:'production',PUBLIC_SITE_URL:'https://example.test'}),/approval evidence/);
});
