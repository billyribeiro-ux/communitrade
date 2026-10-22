export type ProfileLookupFailure = { kind: 'not-found' } | { kind: 'unavailable' } | { kind: 'canonical'; handle: string };

/** Resolve only the API's exact relative canonical-user route. */
export function classifyProfileLookupFailure(status: number | undefined, location: string | null, requestedHandle: string): ProfileLookupFailure {
  if (status === 404) return { kind: 'not-found' };
  if (status === 308) {
    const match = location?.match(/^\/api\/v1\/users\/([a-z0-9_]{3,30})$/);
    const handle = match?.[1];
    if (handle && handle !== requestedHandle) return { kind: 'canonical', handle };
  }
  return { kind: 'unavailable' };
}
