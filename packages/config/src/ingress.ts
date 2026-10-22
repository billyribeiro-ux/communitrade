import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type IngressPrincipal = 'web' | 'service';

export interface IngressSignatureInput {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  principal: IngressPrincipal;
  body?: Uint8Array | undefined;
  clientIp?: string;
}

/** Hashes exact transport bytes so JSON, forms, uploads and webhook-like payloads stay byte-bound. */
export function ingressBodyDigest(body?: Uint8Array): string {
  return createHash('sha256').update(body ?? new Uint8Array()).digest('hex');
}

/** Stable canonical input shared by the web proxy and API verifier. */
export function ingressSigningValue(input: IngressSignatureInput): string {
  return JSON.stringify([
    'trusted-ingress:v1', input.method.toUpperCase(), input.path,
    input.timestamp, input.nonce, input.principal, ingressBodyDigest(input.body), input.clientIp ?? '',
  ]);
}

export function signIngress(secret: string, input: IngressSignatureInput): string {
  return createHmac('sha256', secret).update(ingressSigningValue(input)).digest('base64url');
}

export function verifyIngressSignature(secret: string, input: IngressSignatureInput, signature: string): boolean {
  if (secret.length < 32 || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  const expected = Buffer.from(signIngress(secret, input));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
