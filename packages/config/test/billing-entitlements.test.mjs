import test from 'node:test';
import assert from 'node:assert/strict';
import { billingEntitlementScope, billingEntitlementPredicate } from '../dist/index.js';

test('legacy synthetic entitlements are restricted to the original local fake scope', () => {
  assert.deepEqual(billingEntitlementScope({}), ['fake:local-fake-account', 'test', true]);
  assert.deepEqual(billingEntitlementScope({BILLING_PROVIDER:'stripe',BILLING_PROVIDER_ACCOUNT_ID:'acct_test',BILLING_MODE:'test'}), ['stripe:acct_test','test',false]);
  assert.equal(billingEntitlementScope({BILLING_PROVIDER_ACCOUNT_ID:'other-fake-account'})[2], false);
  assert.deepEqual(billingEntitlementScope({BILLING_PROVIDER:'STRIPE',BILLING_MODE:'TEST',BILLING_PROVIDER_ACCOUNT_ID:' acct_test '}), ['stripe:acct_test','test',false]);
  assert.deepEqual(billingEntitlementScope({NODE_ENV:'production'}), ['__unconfigured__','__unconfigured__',false]);
  assert.deepEqual(billingEntitlementScope({RELEASE_MODE:'public',BILLING_PROVIDER:'stripe',BILLING_PROVIDER_ACCOUNT_ID:'acct_live',BILLING_MODE:'test'}), ['__unconfigured__','__unconfigured__',false]);
  assert.deepEqual(billingEntitlementScope({NODE_ENV:'production',BILLING_PROVIDER:'stripe',BILLING_PROVIDER_ACCOUNT_ID:'acct_live',BILLING_MODE:'live'}), ['stripe:acct_live','live',false]);
});

test('scope SQL bounds trusted Pro access and accepts only static identifiers', () => {
  const sql = billingEntitlementPredicate('ent', 4);
  assert.match(sql, /ent\.provider_account=\$4/);
  assert.match(sql, /ent\.provider_mode=\$5/);
  assert.match(sql, /ent\.valid_until IS NOT NULL/);
  assert.match(sql, /\$6::boolean/);
  assert.throws(() => billingEntitlementPredicate('x; DROP TABLE user_account'));
  assert.throws(() => billingEntitlementPredicate('', 0));
});
