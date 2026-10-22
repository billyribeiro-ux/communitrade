export const policySlugs = ['terms', 'privacy', 'risk-disclosure', 'community-guidelines', 'accessibility'] as const;
const titles = { terms: 'Terms of use', privacy: 'Privacy', 'risk-disclosure': 'Risk disclosure', 'community-guidelines': 'Community guidelines', accessibility: 'Accessibility' };
export type PolicySlug = typeof policySlugs[number];
export interface PolicyRecord {
  slug: PolicySlug; title: string; status: 'draft' | 'reviewed' | 'approved'; version: string;
  effectiveDate: string | null; approverReference: string | null; publishedAt: string | null; draft: boolean;
}
/** Approval evidence is deliberately absent. Shipping requires replacing this record with reviewed evidence. */
export const policies: readonly PolicyRecord[] = policySlugs.map(slug => ({
  slug, title: titles[slug], status: 'draft', version: '2026-10-19.draft-1',
  effectiveDate: null, approverReference: null, publishedAt: null, draft: true,
}));
export function getPolicy(slug: string): PolicyRecord {
  const policy = policies.find(item => item.slug === slug);
  if (!policy) throw new Error('Unknown policy');
  return policy;
}
export function assertReleaseReady(env: Readonly<Record<string, string | undefined>> = process.env): void {
  if (!['production','public'].includes(env.RELEASE_MODE??'')) return;
  let origin: URL;
  try { origin = new URL(env.PUBLIC_SITE_URL ?? ''); } catch { throw new Error('Release blocked: approved HTTPS site origin is required.'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.origin !== env.PUBLIC_SITE_URL) throw new Error('Release blocked: approved HTTPS site origin is required.');
  if (policies.some(item => item.status !== 'approved' || !item.effectiveDate || !item.approverReference || !item.publishedAt)) {
    throw new Error('Release blocked: versioned policy approval evidence is incomplete.');
  }
}
