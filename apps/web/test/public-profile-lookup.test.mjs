import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProfileLookupFailure } from '../src/lib/public-profile-lookup.ts';

test('public profiles redirect only a valid API canonical-handle location',()=>{
  assert.deepEqual(classifyProfileLookupFailure(308,'/api/v1/users/canonical_handle','old_handle'),{kind:'canonical',handle:'canonical_handle'});
  for(const location of [null,'https://evil.invalid/api/v1/users/other','//evil.invalid/api/v1/users/other','/users/other','/api/v1/users/a%2fb','/api/v1/users/other?next=//evil.invalid','/api/v1/users/old_handle']){
    assert.deepEqual(classifyProfileLookupFailure(308,location,'old_handle'),{kind:'unavailable'},`reject unsafe/noncanonical Location: ${location}`);
  }
});

test('unknown profiles remain not found while API failures render as unavailable',()=>{
  assert.deepEqual(classifyProfileLookupFailure(404,null,'missing_handle'),{kind:'not-found'});
  assert.deepEqual(classifyProfileLookupFailure(503,null,'known_handle'),{kind:'unavailable'});
  assert.deepEqual(classifyProfileLookupFailure(undefined,null,'known_handle'),{kind:'unavailable'});
});
