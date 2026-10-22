import { createHmac, timingSafeEqual } from 'node:crypto';

export interface PublicationRenderClaims {
  readonly jobId: string;
  readonly publicationVersionId: string;
  readonly nonce: string;
  readonly expiresAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PUBLICATION_RENDER_MAX_TTL_MS = 120_000;

function assertClaims(value: PublicationRenderClaims, now: number): void {
  if (!value || !UUID.test(value.jobId) || !UUID.test(value.publicationVersionId) || !UUID.test(value.nonce)) {
    throw new Error('Invalid publication render token claims');
  }
  const expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== value.expiresAt || expiresAt <= now || expiresAt > now + PUBLICATION_RENDER_MAX_TTL_MS) {
    throw new Error('Publication render token expired or outside its allowed lifetime');
  }
}

function signature(secret: string, payload: string): string {
  if (Buffer.byteLength(secret, 'utf8') < 32) throw new Error('Publication render HMAC secret must be at least 32 bytes');
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/** Canonical wire token shared by the trusted worker, web renderer and API claim endpoint. */
export function signPublicationRenderToken(secret: string, claims: PublicationRenderClaims, now = Date.now()): string {
  assertClaims(claims, now);
  const canonical = JSON.stringify({
    jobId: claims.jobId,
    publicationVersionId: claims.publicationVersionId,
    nonce: claims.nonce,
    expiresAt: claims.expiresAt,
  });
  const encoded = Buffer.from(canonical, 'utf8').toString('base64url');
  return `${encoded}.${signature(secret, encoded)}`;
}

export function verifyPublicationRenderToken(secret: string, token: string, now = Date.now()): PublicationRenderClaims {
  if (typeof token !== 'string' || token.length > 2048) throw new Error('Invalid publication render token');
  const pieces = token.split('.');
  if (pieces.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(pieces[0]!) || !/^[0-9a-f]{64}$/.test(pieces[1]!)) {
    throw new Error('Invalid publication render token');
  }
  const expected = Buffer.from(signature(secret, pieces[0]!), 'hex');
  const supplied = Buffer.from(pieces[1]!, 'hex');
  if (expected.byteLength !== supplied.byteLength || !timingSafeEqual(expected, supplied)) throw new Error('Invalid publication render token signature');
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(pieces[0]!, 'base64url').toString('utf8')); }
  catch { throw new Error('Invalid publication render token payload'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid publication render token payload');
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).length !== 4 || Object.keys(value).some((key) => !['jobId', 'publicationVersionId', 'nonce', 'expiresAt'].includes(key))
      || typeof value.jobId !== 'string' || typeof value.publicationVersionId !== 'string'
      || typeof value.nonce !== 'string' || typeof value.expiresAt !== 'string') {
    throw new Error('Invalid publication render token claims');
  }
  const claims = { jobId: value.jobId, publicationVersionId: value.publicationVersionId, nonce: value.nonce, expiresAt: value.expiresAt };
  assertClaims(claims, now);
  return claims;
}
