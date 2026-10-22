export type AdminSecurity = { mfaVerified: boolean; mfaRecent: boolean };
export type AdminIdentity = { roles: string[]; security?: AdminSecurity };
export type AdminAccess = 'not-staff' | 'mfa-required' | 'step-up-needed' | 'ready';

/** Moderators enter the role-scoped staff workspace; recent MFA gates sensitive actions. */
export function adminAccess(identity: AdminIdentity): AdminAccess {
  if (!identity.roles.some(role => role === 'admin' || role === 'moderator')) return 'not-staff';
  if (identity.security?.mfaVerified !== true) return 'mfa-required';
  return identity.security.mfaRecent === true ? 'ready' : 'step-up-needed';
}
