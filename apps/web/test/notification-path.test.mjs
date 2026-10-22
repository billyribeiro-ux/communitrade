import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeNotificationHref } from '../src/lib/notification-path.ts';

test('notification links are limited to safe same-origin member and public routes', () => {
  assert.equal(safeNotificationHref('/app/settings/preferences'), '/app/settings/preferences');
  assert.equal(safeNotificationHref('/ideas/abc?tab=updates'), '/ideas/abc?tab=updates');
  assert.equal(safeNotificationHref('https://attacker.example/path'), '/app');
  assert.equal(safeNotificationHref('//attacker.example/path'), '/app');
  assert.equal(safeNotificationHref('/support/secret'), '/app');
  assert.equal(safeNotificationHref('/\u005c\u005cattacker.example'), '/app');
});
