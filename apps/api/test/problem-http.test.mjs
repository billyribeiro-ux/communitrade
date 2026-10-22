import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ProblemFilter } from '../dist/http/problem-filter.js';
import { CommandError } from '../dist/http/problem.js';
import { validateIncomingRequest } from '../dist/http/validate-request.js';
import { ContractValidationError } from '@trading/contracts';

test('real Nest error transport returns redacted problem JSON and request IDs', async () => {
  let error;
  class ErrorController { fail() { throw error; } }
  Controller('problem')(ErrorController);
  Get()(ErrorController.prototype, 'fail', Object.getOwnPropertyDescriptor(ErrorController.prototype, 'fail'));
  class TestModule {}
  Module({ controllers: [ErrorController] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  app.useGlobalFilters(new ProblemFilter());
  await app.listen(0, '127.0.0.1');
  try {
    const origin = await app.getUrl();
    for (const status of [400, 401, 403, 404, 409, 422, 429, 503]) {
      error = new CommandError(status, status === 404 ? 'NOT_FOUND' : 'TEST_KNOWN');
      const response = await fetch(`${origin}/problem`);
      assert.equal(response.status, status);
      assert.match(response.headers.get('content-type'), /application\/problem\+json/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json();
      assert.equal(body.requestId, response.headers.get('x-request-id'));
      assert.match(body.requestId, /^[a-f0-9-]{36}$/);
      if (status === 429) assert.equal(response.headers.get('retry-after'), '60');
    }
    error = new Error('password=private-secret SQL relation hidden_table');
    const unknown = await fetch(`${origin}/problem`);
    assert.equal(unknown.status, 500);
    assert.equal((await unknown.text()).includes('private-secret'), false);
    error = new ContractValidationError([{ field: 'body.title', message: 'is required' }]);
    const invalid = await fetch(`${origin}/problem`);
    assert.equal(invalid.status, 400);
    assert.deepEqual((await invalid.json()).errors, [{ path: 'body.title', message: 'is required' }]);
  } finally { await app.close(); }
});

test('server request adapter validates declared headers without rejecting browser transport headers', () => {
  const input = validateIncomingRequest('createDraft', {
    headers: { cookie: 'private-session', origin: 'http://localhost:3000', 'x-csrf-token': 'csrf', 'idempotency-key': '1234567890123456' },
    body: { kind: 'trade' },
  });
  assert.equal(JSON.stringify(input).includes('private-session'), false);
  assert.throws(() => validateIncomingRequest('createDraft', { headers: {}, body: { kind: 'trade', ownerUserId: 'attacker' } }), ContractValidationError);
  assert.doesNotThrow(() => validateIncomingRequest('oidcBackchannelLogout', {
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body: { logout_token: 'signed-provider-token' },
  }));
  assert.doesNotThrow(() => validateIncomingRequest('uploadLocalBytes', {
    params: { id: '00000000-0000-4000-8000-000000000001' },
    headers: { 'content-type': 'image/png', 'x-csrf-token': 'csrf' }, body: new Uint8Array([1, 2, 3]),
  }));
});
