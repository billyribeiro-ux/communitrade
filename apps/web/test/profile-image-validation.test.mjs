import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AVATAR_MAX_BYTES, AVATAR_MAX_DIMENSION, AVATAR_MAX_PIXELS, avatarDimensionsSupported, validateAvatarFile } from '../src/lib/profile-image-validation.ts';

test('avatar selection matches the server image caps before upload',()=>{
  assert.equal(AVATAR_MAX_DIMENSION,10_000);
  assert.equal(AVATAR_MAX_PIXELS,40_000_000);
  assert.equal(AVATAR_MAX_BYTES,2*1024*1024);
  assert.equal(validateAvatarFile('image/jpeg',AVATAR_MAX_BYTES),null);
  assert.equal(validateAvatarFile('image/png',1024),null);
  assert.equal(validateAvatarFile('image/webp',1024),null);
  assert.equal(validateAvatarFile('image/svg+xml',1024),'type');
  assert.equal(validateAvatarFile('image/jpeg',AVATAR_MAX_BYTES+1),'size');
  assert.equal(avatarDimensionsSupported(10000,4000),true);
  assert.equal(avatarDimensionsSupported(8000,5000),true);
  assert.equal(avatarDimensionsSupported(8001,5000),false);
  assert.equal(avatarDimensionsSupported(10001,32),false);
  assert.equal(avatarDimensionsSupported(31,100),false);
});
