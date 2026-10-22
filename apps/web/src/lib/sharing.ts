/** Only canonical public resources may enter external share destinations. */
export function publicShareUrl(raw: string, resource: { publicationId: string } | { handle: string }): string {
  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('The public share link is unavailable.');
  const valid = 'publicationId' in resource
    ? url.pathname.startsWith(`/ideas/${resource.publicationId}/`) && /^\/ideas\/[0-9a-f-]{36}\/[a-z0-9-]+\/?$/i.test(url.pathname)
    : url.pathname === `/u/${resource.handle}` && /^[a-z0-9_]{3,30}$/.test(resource.handle);
  if (!valid) throw new Error('The public share link does not match this resource.');
  return url.href;
}

export function socialShareLinks(canonicalUrl: string, title = '') {
  const x = new URL('https://twitter.com/intent/tweet'); x.searchParams.set('url', canonicalUrl); x.searchParams.set('text', title);
  const linkedIn = new URL('https://www.linkedin.com/sharing/share-offsite/'); linkedIn.searchParams.set('url', canonicalUrl);
  const reddit = new URL('https://www.reddit.com/submit'); reddit.searchParams.set('url', canonicalUrl); reddit.searchParams.set('title', title);
  return { x: x.href, linkedIn: linkedIn.href, reddit: reddit.href };
}

/** A server-selected share image still travels through the same-origin authorization proxy. */
export function shareImagePath(raw: string, publicationId: string, versionId: string): string {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== `/api/v1/publications/${publicationId}/share/image`
      || url.searchParams.get('versionId') !== versionId || url.hash
      || [...url.searchParams.keys()].some(key => !['versionId', 'download'].includes(key)))
    throw new Error('The licensed share image is unavailable.');
  return url.pathname + url.search;
}
