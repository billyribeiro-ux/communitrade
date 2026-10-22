import { createHash, randomBytes, randomUUID } from 'node:crypto';

const decode = (value) => value.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
export const providerAttributes = (tag) => Object.fromEntries([...tag.matchAll(/([\w:.-]+)\s*=\s*["']([^"']*)["']/g)].map((match) => [match[1], decode(match[2])]));

export function parseProviderForm(html) {
  const match = html.match(/<form\b([^>]*)>([\s\S]*?)<\/form>/i);
  if (!match) throw new Error('Provider login form was not available.');
  const fields = {};
  for (const input of match[2].matchAll(/<input\b[^>]*>/gi)) {
    const item = providerAttributes(input[0]);
    if (item.name && !['checkbox', 'submit', 'button'].includes(item.type)) fields[item.name] = item.value ?? '';
  }
  return { action: providerAttributes(match[1]).action, fields, html: match[2] };
}

// One loop owns every redirect, including the final callback. Following redirects
// inside form submission would consume the evidence of a completed action.
export async function driveKeycloakCredentialDeletion(jar, credentialId, { issuer, person, totp, maxSteps = 12 }) {
  const provider = new URL(issuer).origin;
  const verifier = randomBytes(32).toString('base64url');
  const authorization = new URL(`${issuer}/protocol/openid-connect/auth`);
  authorization.search = new URLSearchParams({
    client_id: 'account-console', redirect_uri: `${issuer}/account/`,
    response_type: 'code', response_mode: 'query', scope: 'openid',
    state: randomUUID(), nonce: randomUUID(),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', kc_action: `delete_credential:${credentialId}`,
  }).toString();
  let page = await jar.request(authorization.href);
  let confirmationSubmitted = false;
  let submittedOtpTimeStep = null;
  const trace = [];
  const result = (completed = false) => ({ ...page, completed, confirmationSubmitted });
  for (let attempt = 0; attempt < maxSteps; attempt++) {
    const path = new URL(page.url).pathname;
    const stage = path.endsWith('/login-actions/required-action') ? 'required-action'
      : path.endsWith('/login-actions/authenticate') ? 'authenticate' : 'provider';
    const names = [...page.text.matchAll(/<(?:input|button)\b[^>]*name=["']([^"']+)["']/gi)]
      .map((match) => match[1]).filter((name) => /^[a-zA-Z0-9_.-]{1,40}$/.test(name));
    trace.push(`${page.response.status} ${stage} [${[...new Set(names)].slice(0, 8).join(',') || 'no-fields'}]`);
    const location = [302, 303, 307, 308].includes(page.response.status) ? page.response.headers.get('location') : null;
    if (location) {
      const next = new URL(location, page.url);
      if (next.origin !== provider) throw new Error('Credential action redirect left the configured provider.');
      if (next.pathname === `${new URL(issuer).pathname}/account/` && next.searchParams.has('code')) {
        const rawStatus = next.searchParams.get('kc_action_status');
        const rawError = next.searchParams.get('error');
        const actionStatus = ['success', 'error', 'cancelled'].includes(rawStatus) ? rawStatus : undefined;
        const oidcError = ['access_denied', 'login_required', 'interaction_required', 'invalid_request', 'server_error', 'temporarily_unavailable', 'consent_required', 'account_selection_required'].includes(rawError) ? rawError : undefined;
        return { ...result(true), actionStatus, oidcError };
      }
      page = await jar.request(next.href);
      continue;
    }
    if (page.response.status >= 400) return result();
    let parsed;
    try { parsed = parseProviderForm(page.text); } catch { return result(); }
    let values;
    if ('username' in parsed.fields || 'email' in parsed.fields) {
      values = { username: person.username, email: person.email, password: person.password };
    } else if ('otp' in parsed.fields) {
      const otpTimeStep = Math.floor(Date.now() / 30_000);
      if (otpTimeStep === submittedOtpTimeStep) return result();
      submittedOtpTimeStep = otpTimeStep;
      values = { otp: totp(person.otpSecret) };
    } else if ('password' in parsed.fields) {
      values = { password: person.password };
    } else {
      const accept = [...parsed.html.matchAll(/<(?:button|input)\b[^>]*>/gi)]
        .map((match) => providerAttributes(match[0]))
        .find((item) => item.type === 'submit' && item.name === 'accept');
      if (!accept) return result();
      values = { accept: accept.value ?? '' };
    }
    const action = new URL(parsed.action, page.url);
    if (action.origin !== provider) throw new Error('Credential action form left the configured provider.');
    if ('accept' in values) confirmationSubmitted = true;
    page = await jar.request(action.href, {
      method: 'POST', headers: { origin: provider, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...parsed.fields, ...values }),
    });
  }
  throw new Error(`Credential deletion action did not finish within the redirect bound (confirmed=${confirmationSubmitted}; ${trace.join(' -> ')}).`);
}
