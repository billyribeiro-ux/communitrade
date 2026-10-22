import test from 'node:test';
import assert from 'node:assert/strict';
import {preflight,requiredSettings} from '../preflight.mjs';

test('preflight reports names without reflecting secret or malformed URL values',()=>{
  const sentinel='DO_NOT_LEAK_PRIVATE_SECRET_1234567890';
  const result=preflight('api',{SESSION_SECRET:sentinel,DATABASE_URL:sentinel,APP_ORIGIN:sentinel});
  assert.equal(result.status,'incomplete');assert.ok(result.missing.includes('R2_SECRET_ACCESS_KEY'));
  assert.ok(!JSON.stringify(result).includes(sentinel));assert.equal(result.providerConformance,false);assert.equal(result.releaseApproval,false);
});
test('frontend/worker configuration never requires API-only supplier or processor secrets',()=>{
  for(const role of ['web','worker'])for(const key of ['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','DATABENTO_API_KEY','OIDC_CLIENT_SECRET'])assert.ok(!requiredSettings[role].includes(key));
  assert.ok(requiredSettings.api.includes('RESEND_WEBHOOK_SECRET'));
  assert.throws(()=>preflight('unexpected',{}));
});
test('web preflight rejects local mode and insecure origins and cannot grant release approval',()=>{
  const env={APP_ORIGIN:'https://app.example.com',PUBLIC_SITE_URL:'https://app.example.com',API_INTERNAL_URL:'https://api.example.com',RELEASE_MODE:'production',WEB_INGRESS_MODE:'vercel',TRUSTED_INGRESS_SECRET:'synthetic-key-for-preflight-only-1234',PUBLICATION_RENDER_HMAC_SECRET:'synthetic-other-key-for-preflight-2345'};
  assert.equal(preflight('web',env).status,'configuration_present');
  assert.equal(preflight('web',{...env,RELEASE_MODE:'local'}).status,'incomplete');
  assert.equal(preflight('web',{...env,API_INTERNAL_URL:'http://localhost:3001'}).status,'incomplete');
  assert.equal(preflight('web',env).releaseApproval,false);
});
