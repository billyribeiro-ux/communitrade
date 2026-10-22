/** Copy only path/query into a configured server origin, never resolve a client URL. */
export function apiProxyTarget(apiOrigin: string, pathname: string, search: string): URL {
  const target = new URL(apiOrigin);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('INVALID_API_ORIGIN');
  if (!pathname.startsWith('/api/v1/') || pathname.includes('\\')) throw new Error('INVALID_API_PATH');
  target.pathname = pathname;
  target.search = search;
  target.hash = '';
  // URL setters normalize dot segments, including their percent-encoded forms.
  if (!target.pathname.startsWith('/api/v1/')) throw new Error('INVALID_API_PATH');
  return target;
}
