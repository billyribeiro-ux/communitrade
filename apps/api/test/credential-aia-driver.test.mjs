import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveKeycloakCredentialDeletion } from '../../../scripts/lib/drive-keycloak-aia.mjs';

const issuer = 'https://identity.example.test/realms/synthetic';
const action = `${issuer}/login-actions/required-action?session_code=hidden-action-value`;
const confirmation = `<form action="${action.replaceAll('&', '&amp;')}" method="POST">
  <button name="accept" id="kc-accept" type="submit">Confirm deletion</button>
  <button name="cancel-aia" id="kc-decline" type="submit">Cancel</button>
</form>`;
const context = { issuer, person: { username: 'synthetic', email: 'synthetic@example.test', password: 'hidden-password', otpSecret: 'hidden-secret' }, totp: () => 'hidden-otp' };
const page = (status, text = '', location, url = action) => ({ response: { status, headers: new Headers(location ? { location } : {}) }, text, url });

function script(pages) {
  const requests = [];
  return {
    requests,
    async request(url, options) {
      requests.push({ url, options });
      assert.ok(pages.length, 'driver must not follow the account callback');
      return pages.shift();
    },
    follow() { assert.fail('AIA driver must handle its own redirects'); },
  };
}

test('credential confirmation callback is recognized before following its authorization code', async () => {
  const jar = script([page(200, confirmation), page(302, '', `${issuer}/account/?code=hidden-code&state=hidden-state`)]);
  const result = await driveKeycloakCredentialDeletion(jar, 'synthetic-credential', context);
  assert.equal(result.completed, true);
  assert.equal(result.confirmationSubmitted, true);
  assert.equal(jar.requests.length, 2);
  assert.equal(jar.requests[1].options.method, 'POST');
  assert.equal(jar.requests[1].options.body.get('accept'), '');
  assert.equal(jar.requests[1].options.body.has('cancel-aia'), false);
  const authorization = new URL(jar.requests[0].url);
  assert.equal(authorization.searchParams.get('kc_action'), 'delete_credential:synthetic-credential');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
});

test('a confirmed provider 500 explicitly reports rejection and preserves confirmation evidence', async () => {
  const jar = script([page(200, confirmation), page(500)]);
  const result = await driveKeycloakCredentialDeletion(jar, 'synthetic-credential', context);
  assert.equal(result.completed, false);
  assert.equal(result.confirmationSubmitted, true);
  assert.equal(result.response.status, 500);
});

test('an authentication error cannot count as a confirmed rollback attempt', async () => {
  const jar = script([page(403)]);
  const result = await driveKeycloakCredentialDeletion(jar, 'synthetic-credential', context);
  assert.equal(result.completed, false);
  assert.equal(result.confirmationSubmitted, false);
  assert.equal(jar.requests.length, 1);
});

test('an unrelated error form is not submitted or reported as a confirmed deletion', async () => {
  const jar = script([page(200, `<form action="${action}"><button name="retry" type="submit">Retry</button></form>`)]);
  const result = await driveKeycloakCredentialDeletion(jar, 'synthetic-credential', context);
  assert.equal(result.completed, false);
  assert.equal(result.confirmationSubmitted, false);
  assert.equal(jar.requests.length, 1);
});

test('reauthentication and OTP submissions retain outer-loop callback detection', async () => {
  const jar = script([
    page(200, `<form action="${action}"><input name="password" type="password"></form>`),
    page(302, '', `${issuer}/login-actions/authenticate?hidden=redirect-value`),
    page(200, `<form action="${action}"><input name="otp"></form>`),
    page(200, confirmation), page(303, '', `${issuer}/account/?code=hidden-code`),
  ]);
  const result = await driveKeycloakCredentialDeletion(jar, 'synthetic-credential', context);
  assert.equal(result.completed, true);
  assert.equal(result.confirmationSubmitted, true);
  assert.equal(jar.requests.length, 5);
  assert.equal(jar.requests[1].options.body.get('password'), context.person.password);
  assert.equal(jar.requests[3].options.body.get('otp'), 'hidden-otp');
});

test('redirect-bound diagnostics expose stages and field names without form, URL, or credential values', async () => {
  const jar = script([page(200, confirmation), page(302, '', `${issuer}/account/?code=hidden-code`)]);
  await assert.rejects(driveKeycloakCredentialDeletion(jar, 'synthetic-credential', { ...context, maxSteps: 1 }), (error) => {
    assert.match(error.message, /confirmed=true; 200 required-action \[accept,cancel-aia\]/);
    assert.doesNotMatch(error.message, /hidden-|synthetic-credential|https?:/);
    return true;
  });
});
