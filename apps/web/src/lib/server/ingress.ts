import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { signIngress, type IngressPrincipal } from '@trading/config/ingress';

const HEADER_PREFIX = 'x-trusted-ingress-';

export function providerClientIp(headers: Headers, mode: string | undefined, production: boolean, vercel: string | undefined = process.env.VERCEL): string | undefined {
  if (!production) return undefined;
  if (mode !== 'vercel' || vercel !== '1') throw new Error('Production web ingress requires the Vercel platform runtime.');
  // Vercel documents these as provider supplied and overwritten at the edge. Never
  // consume a generic X-Forwarded-For value supplied by the browser.
  const ip = headers.get('x-vercel-forwarded-for');
  if (!ip || ip.includes(',') || isIP(ip.trim()) === 0) throw new Error('Trusted Vercel client address is unavailable.');
  return ip.trim();
}

export function trustedIngressHeaders(input: {
  secret: string;
  method: string;
  path: string;
  principal: IngressPrincipal;
  clientIp?: string;
  body?: Uint8Array | undefined;
  now?: number;
  nonce?: string;
}): Headers {
  if (input.secret.length < 32) throw new Error('TRUSTED_INGRESS_SECRET must contain at least 32 characters.');
  const timestamp = String(Math.floor((input.now ?? Date.now()) / 1000));
  const nonce = input.nonce ?? randomUUID().replaceAll('-', '');
  const signature = signIngress(input.secret, {
    method: input.method,
    path: input.path,
    timestamp,
    nonce,
    principal: input.principal,
    body: input.body,
    ...(input.clientIp === undefined ? {} : { clientIp: input.clientIp }),
  });
  const result = new Headers();
  result.set(`${HEADER_PREFIX}timestamp`, timestamp);
  result.set(`${HEADER_PREFIX}nonce`, nonce);
  result.set(`${HEADER_PREFIX}signature`, signature);
  result.set(`${HEADER_PREFIX}principal`, input.principal);
  if (input.clientIp !== undefined) result.set(`${HEADER_PREFIX}client-ip`, input.clientIp);
  return result;
}

/** Server component/API helper for trusted internal calls; service identity is distinct from web ingress. */
export function trustedServiceIngressHeaders(method: string, path: string, body?: Uint8Array, secret = process.env.TRUSTED_INGRESS_SECRET ?? ''): Headers {
  return trustedIngressHeaders({ secret, method, path, principal: 'service', body });
}
