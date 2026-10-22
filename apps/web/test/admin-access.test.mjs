import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminAccess } from '../src/lib/admin-access.ts';

test('staff SSR scopes moderator access and requires verified MFA',()=>{
  assert.equal(adminAccess({roles:['member']}),'not-staff');
  assert.equal(adminAccess({roles:['member','moderator'],security:{mfaVerified:true,mfaRecent:true}}),'ready');
  assert.equal(adminAccess({roles:['member','moderator'],security:{mfaVerified:true,mfaRecent:false}}),'step-up-needed');
  assert.equal(adminAccess({roles:['member','admin']}),'mfa-required');
  assert.equal(adminAccess({roles:['member','admin'],security:{mfaVerified:false,mfaRecent:false}}),'mfa-required');
  assert.equal(adminAccess({roles:['member','admin'],security:{mfaVerified:true,mfaRecent:false}}),'step-up-needed');
  assert.equal(adminAccess({roles:['member','admin'],security:{mfaVerified:true,mfaRecent:true}}),'ready');
  assert.equal(adminAccess({roles:['member','admin'],security:{mfaVerified:false,mfaRecent:true}}),'mfa-required');
});
