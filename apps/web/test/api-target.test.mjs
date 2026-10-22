import assert from 'node:assert/strict';
import test from 'node:test';
import { apiProxyTarget } from '../src/lib/server/api-target.ts';

test('API proxy preserves its configured origin while copying opaque path and query', () => {
  const target = apiProxyTarget('https://api.example.test', '/api/v1/instruments', '?q=https%3A%2F%2Fevil.invalid&next=//evil.invalid');
  assert.equal(target.origin, 'https://api.example.test');
  assert.equal(target.pathname, '/api/v1/instruments');
  assert.equal(target.searchParams.get('q'), 'https://evil.invalid');
  assert.equal(target.searchParams.get('next'), '//evil.invalid');
  assert.equal(target.hash, '');
});

test('API proxy rejects authority overrides and normalized escapes from the API namespace', () => {
  for (const pathname of ['//evil.invalid/api/v1/x', 'https://evil.invalid/api/v1/x', '/api/v1/../../admin', '/api/v1/%2e%2e/%2e%2e/admin', '/api/v1/\\evil.invalid', '/admin']) {
    assert.throws(() => apiProxyTarget('http://api:3001', pathname, ''), /INVALID_API_PATH/);
  }
  for (const origin of ['file:///private/file', 'https://user:password@api.example.test']) {
    assert.throws(() => apiProxyTarget(origin, '/api/v1/me', ''), /INVALID_API_ORIGIN/);
  }
});
