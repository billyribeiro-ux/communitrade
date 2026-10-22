/** The same account/mode boundary protects every API and worker entitlement read. */
export function billingEntitlementScope(env: Readonly<Record<string, string | undefined>>) {
  const production = env.NODE_ENV === 'production' || ['production', 'public'].includes((env.RELEASE_MODE ?? '').toLowerCase());
  const provider = (env.BILLING_PROVIDER ?? 'fake').trim().toLowerCase();
  const account = (env.BILLING_PROVIDER_ACCOUNT_ID ?? (production ? '__unconfigured__' : 'local-fake-account')).trim();
  const mode = (env.BILLING_MODE ?? (production ? 'live' : 'test')).trim().toLowerCase();
  const configured = ['fake', 'stripe'].includes(provider) && ['test', 'live'].includes(mode)
    && account !== 'default' && (!production || (provider === 'stripe' && mode === 'live' && account !== '__unconfigured__'));
  // Historical deterministic acceptance personas are usable only in the original local fake scope.
  const allowLegacy = !production && provider === 'fake' && mode === 'test' && account === 'local-fake-account';
  return [configured ? `${provider}:${account}` : '__unconfigured__', configured ? mode : '__unconfigured__', allowLegacy] as const;
}

/** Identifiers and parameter positions are engineering constants, never request input. */
export function billingEntitlementPredicate(alias = '', startAt = 1): string {
  if (alias && !/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error('INVALID_ENTITLEMENT_ALIAS');
  if (!Number.isInteger(startAt) || startAt < 1 || startAt > 100) throw new Error('INVALID_ENTITLEMENT_PARAMETER');
  const prefix = alias ? `${alias}.` : '';
  return `((${prefix}provider_account=$${startAt} AND ${prefix}provider_mode=$${startAt + 1}
    AND (${prefix}plan<>'pro' OR ${prefix}valid_until IS NOT NULL))
    OR ($${startAt + 2}::boolean AND ${prefix}provider_account='default' AND ${prefix}provider_mode='test'))`;
}
