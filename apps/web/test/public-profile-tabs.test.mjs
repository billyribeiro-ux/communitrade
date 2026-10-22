import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileTabEmptyState, publicProfileTab, PUBLIC_PROFILE_TABS } from '../src/lib/public-profile-tabs.ts';

test('public profile tabs are allowlisted and each selects a real, honest feed state',()=>{
  assert.deepEqual(PUBLIC_PROFILE_TABS,['ideas','updates','reposts']);
  assert.equal(publicProfileTab(undefined),'ideas');
  assert.equal(publicProfileTab('updates'),'updates');
  assert.equal(publicProfileTab(['reposts','ideas']),'reposts');
  assert.equal(publicProfileTab('admin'),'ideas');
  assert.equal(publicProfileTab('//evil.invalid'),'ideas');
  for(const tab of PUBLIC_PROFILE_TABS){
    const empty=profileTabEmptyState(tab);
    assert.ok(empty.heading.length>0&&empty.message.length>0);
  }
  assert.match(profileTabEmptyState('ideas').message,/visible publications/i);
  assert.match(profileTabEmptyState('updates').message,/lifecycle changes.*original idea/i);
  assert.match(profileTabEmptyState('reposts').message,/currently visible.*publication/i);
});
