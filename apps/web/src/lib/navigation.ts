export type PlanIntent = { plan: 'free' | 'pro'; interval: 'month' | 'year'; returnTo: string };
export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 500 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || [...value].some(character => character.charCodeAt(0) <= 32)) return '/app';
  try {
    const parsed = new URL(value, 'https://return.invalid');
    if (parsed.origin !== 'https://return.invalid' || !/^\/(app(?:\/|$)|ideas(?:\/|$)|u\/|instruments\/|subscribe$)/.test(parsed.pathname)) return '/app';
    return parsed.pathname + parsed.search + parsed.hash;
  } catch { return '/app'; }
}
export function parsePlanIntent(values: Record<string, unknown>): PlanIntent {
  return { plan: values.plan === 'pro' ? 'pro' : 'free', interval: values.interval === 'year' ? 'year' : 'month', returnTo: safeReturnPath(values.returnTo) };
}
export function readPlanIntent(value: string | undefined): PlanIntent | null {
  if (!value || value.length > 1000) return null;
  try { return parsePlanIntent(JSON.parse(value) as Record<string, unknown>); } catch { return null; }
}
export function intentQuery(intent: PlanIntent): string {
  return new URLSearchParams(intent).toString();
}

/** Resolve the next local destination after identity setup has succeeded.
 * The provider intent is navigation state only; it can never grant billing access.
 */
export function postOnboardingPath(intent: PlanIntent): string {
  const returnTo = safeReturnPath(intent.returnTo);
  if (intent.plan !== 'pro') return returnTo;
  return `/subscribe?plan=pro&interval=${intent.interval}&returnTo=${encodeURIComponent(returnTo)}`;
}
