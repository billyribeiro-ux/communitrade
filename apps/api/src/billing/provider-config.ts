import { createHmac } from 'node:crypto';
import type { Database } from '../database.js';
import type { BillingMode, BillingRuntime } from './provider.js';

type Env = Readonly<Record<string, string | undefined>>;

export interface BillingProviderConfig {
  provider: 'fake' | 'stripe';
  providerAccountId: string;
  mode: BillingMode;
  appOrigin: string;
  apiBaseUrl: string;
  apiVersion: string;
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  stripePriceProMonth?: string;
  stripePriceProYear?: string;
  stripePortalConfigurationId?: string;
  fakeWebhookSecret?: string;
  timeoutMs: number;
  webhookToleranceSeconds: number;
  allowScenarioControls: boolean;
  liveApproved: boolean;
  taxConfigured: boolean;
}

function checkedOrigin(value: string, name: string, production: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid absolute URL.`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`${name} must be an origin without credentials, path, query, or fragment.`);
  }
  if (production && url.protocol !== 'https:') throw new Error(`${name} must use HTTPS in production.`);
  return url.origin;
}

export function safeBillingUrl(input: string, appOrigin: string): string {
  let value: URL;
  try {
    value = new URL(input, appOrigin);
  } catch {
    throw new Error('Billing return URL must be an absolute or app-relative URL.');
  }
  if (value.origin !== appOrigin || !['http:', 'https:'].includes(value.protocol) || value.username || value.password) {
    throw new Error('Billing return URL must use the configured application origin.');
  }
  return value.toString();
}

export function createBillingProviderConfig(env: Env): BillingProviderConfig {
  const production = env.NODE_ENV === 'production' || ['production', 'public'].includes((env.RELEASE_MODE ?? '').toLowerCase());
  const providerValue = (env.BILLING_PROVIDER ?? (production ? '' : 'fake')).toLowerCase();
  if (providerValue !== 'fake' && providerValue !== 'stripe') throw new Error('BILLING_PROVIDER must be fake or stripe.');
  const provider = providerValue;
  if (production && provider !== 'stripe') throw new Error('Synthetic billing is disabled in public and production releases.');

  const appOrigin = checkedOrigin(env.APP_ORIGIN ?? '', 'APP_ORIGIN', production);
  const accountId = (env.BILLING_PROVIDER_ACCOUNT_ID ?? (provider === 'fake' && !production ? 'local-fake-account' : '')).trim();
  if (!accountId || accountId.length > 128 || [...accountId].some(character => /\s/.test(character) || character.charCodeAt(0) < 32)) throw new Error('BILLING_PROVIDER_ACCOUNT_ID must be a nonempty bounded identifier.');

  const secret = env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim();
  const inferredMode: BillingMode | undefined = secret?.startsWith('sk_test_') ? 'test' : secret?.startsWith('sk_live_') ? 'live' : undefined;
  const configuredMode = (env.BILLING_MODE ?? inferredMode ?? (production ? 'live' : 'test')).toLowerCase();
  if (configuredMode !== 'test' && configuredMode !== 'live') throw new Error('BILLING_MODE must be test or live.');
  const mode = configuredMode;
  if (provider === 'stripe') {
    if (!secret || !webhookSecret) throw new Error('STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are required for Stripe billing.');
    if (!inferredMode) throw new Error('STRIPE_SECRET_KEY must be a Stripe test or live secret key.');
    if (mode !== inferredMode) throw new Error('BILLING_MODE must match the Stripe secret key mode.');
    if (production && mode !== 'live') throw new Error('Production Stripe billing requires a live key and BILLING_MODE=live.');
    if (env.STRIPE_TAX_CONFIGURED !== 'true') throw new Error('Stripe billing requires STRIPE_TAX_CONFIGURED=true after automatic tax is configured and tested.');
    if (mode === 'live' && env.BILLING_LIVE_APPROVED !== 'true') throw new Error('Live Stripe billing requires BILLING_LIVE_APPROVED=true after live billing release review.');
  }
  if (provider === 'fake' && mode !== 'test') throw new Error('Fake billing only supports test mode.');

  const timeoutMs = Number(env.BILLING_PROVIDER_TIMEOUT_MS ?? '5000');
  const webhookToleranceSeconds = Number(env.BILLING_WEBHOOK_TOLERANCE_SECONDS ?? '300');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 15000) throw new Error('BILLING_PROVIDER_TIMEOUT_MS must be an integer from 1000 through 15000.');
  if (!Number.isInteger(webhookToleranceSeconds) || webhookToleranceSeconds < 30 || webhookToleranceSeconds > 900) throw new Error('BILLING_WEBHOOK_TOLERANCE_SECONDS must be an integer from 30 through 900.');

  const stripePriceProMonth = env.STRIPE_PRICE_PRO_MONTH?.trim();
  const stripePriceProYear = env.STRIPE_PRICE_PRO_YEAR?.trim();
  if (provider === 'stripe' && (!stripePriceProMonth || !stripePriceProYear || stripePriceProMonth === stripePriceProYear)) {
    throw new Error('Stripe requires distinct STRIPE_PRICE_PRO_MONTH and STRIPE_PRICE_PRO_YEAR price IDs.');
  }
  const stripePortalConfigurationId = env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID?.trim();
  if (stripePortalConfigurationId && !/^bpc_[A-Za-z0-9]+$/.test(stripePortalConfigurationId)) throw new Error('STRIPE_BILLING_PORTAL_CONFIGURATION_ID must be a Stripe billing portal configuration ID.');
  if (production && provider === 'stripe' && !stripePortalConfigurationId) throw new Error('Production Stripe billing requires an approved STRIPE_BILLING_PORTAL_CONFIGURATION_ID.');
  const sessionSecret = env.SESSION_SECRET?.trim();
  const fakeWebhookSecret = env.FAKE_BILLING_WEBHOOK_SECRET?.trim() ?? (sessionSecret ? createHmac('sha256', sessionSecret).update('local-only-fake-billing-webhook-v1').digest('hex') : '');
  if (provider === 'fake' && fakeWebhookSecret.length < 32) throw new Error('FAKE_BILLING_WEBHOOK_SECRET must contain at least 32 characters.');

  return {
    provider,
    providerAccountId: accountId,
    mode,
    appOrigin,
    apiBaseUrl: 'https://api.stripe.com/v1',
    apiVersion: '2025-06-30.basil',
    ...(secret ? { stripeSecretKey: secret } : {}),
    ...(webhookSecret ? { stripeWebhookSecret: webhookSecret } : {}),
    ...(stripePriceProMonth ? { stripePriceProMonth } : {}),
    ...(stripePriceProYear ? { stripePriceProYear } : {}),
    ...(stripePortalConfigurationId ? { stripePortalConfigurationId } : {}),
    ...(provider === 'fake' ? { fakeWebhookSecret } : {}),
    timeoutMs,
    webhookToleranceSeconds,
    allowScenarioControls: !production && provider === 'fake' && mode === 'test',
    liveApproved: env.BILLING_LIVE_APPROVED === 'true',
    taxConfigured: env.STRIPE_TAX_CONFIGURED === 'true'
  };
}

export async function createBillingProvider(env: Env, database: Database): Promise<BillingRuntime> {
  const config = createBillingProviderConfig(env);
  if (config.provider === 'fake') {
    const { FakeBillingProvider } = await import('./fake-provider.js');
    return new FakeBillingProvider(config, database);
  }
  const { StripeBillingProvider } = await import('./stripe-provider.js');
  return new StripeBillingProvider(config);
}
