import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, requestHash, parseIfMatch } from '../dist/persistence/transactions.js';
import { CommandError, problemFromError } from '../dist/http/problem.js';

test('idempotency canonicalization preserves values and ignores object insertion order', () => {
  assert.equal(requestHash({ z: [1, '1'], a: { b: true, a: null } }), requestHash({ a: { a: null, b: true }, z: [1, '1'] }));
  assert.notEqual(requestHash({ value: '1.00' }), requestHash({ value: '1' }));
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), { x: undefined }]) assert.throws(() => canonicalJson(value));
  assert.throws(() => canonicalJson({ a: 1, [Symbol('hidden')]: 2 }));
  assert.throws(() => canonicalJson(Object.defineProperty({}, 'hidden', { value: 'x' })));
  assert.throws(() => canonicalJson(Object.defineProperty({}, 'accessor', { enumerable: true, get() { throw new Error('must not invoke'); } })));
  assert.throws(() => canonicalJson(Object.assign([1], { extra: true })));
  const sparse = [1, 2]; delete sparse[0];
  assert.throws(() => canonicalJson(sparse));
  let nested = {}; for (let i = 0; i < 40; i++) nested = { nested };
  assert.throws(() => canonicalJson(nested));
});
test('revision parsing rejects loose, wildcard, unsafe and unquoted If-Match values', () => {
  assert.equal(parseIfMatch('"3"'), 3);
  for (const value of ['3', '*', 'W/"3"', '"-1"', '"2.1"', '"2147483647"', undefined]) assert.throws(() => parseIfMatch(value));
});
test('problem mapping exposes trusted failures and redacts unknown database errors', () => {
  assert.equal(problemFromError(new CommandError(404, 'NOT_FOUND'), 'request-1').status, 404);
  const result = problemFromError(new Error('postgresql://private:secret@host/db'), 'request-1');
  assert.equal(result.status, 500);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(problemFromError({ status: 422, code: 'FAKE', safeDetail: 'secret' }, 'request-1').status, 500);
});
