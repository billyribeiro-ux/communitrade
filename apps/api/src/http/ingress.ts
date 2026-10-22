import { verifyIngressSignature, type IngressPrincipal, type IngressSignatureInput } from '@trading/config/ingress';
import {isIP} from 'node:net';

const MAX_CLOCK_SKEW_SECONDS = 60;
const NONCE_TTL_MS = 120_000;
const MAX_NONCES = 20_000;

export interface IngressRequest {
  method: string;
  originalUrl?: string;
  url?: string;
  path?: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Uint8Array;
  body?: unknown;
  ip?: string;
  socket?: { remoteAddress?: string };
  trustedIngress?: { principal: IngressPrincipal; clientIp?: string };
}

interface IngressResponse {
  status(code: number): IngressResponse;
  json(body: unknown): void;
}

export type IngressNext = () => void;
export type IngressNonceConsumer = (nonce: string, expiresAt: Date) => Promise<boolean>;

function oneHeader(req: IngressRequest, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function bypassPath(method: string, path: string): boolean {
  const verb = method.toUpperCase();
  if ((path === '/api/v1/health/live' || path === '/api/v1/health/ready') && ['GET', 'HEAD'].includes(verb)) return true;
  if ((path === '/api/v1/webhooks/stripe' || path === '/api/v1/webhooks/resend' || path === '/api/v1/webhooks/oidc/logout' ||
      path === '/api/v1/internal/notifications/source' || path === '/api/v1/internal/billing/reconcile') && verb === 'POST') return true;
  return verb === 'POST' && /^\/api\/v1\/internal\/publication-snapshot-jobs\/[0-9a-f-]{36}\/(?:claim|complete|fail)$/.test(path);
}

/** Test/development fallback only. Production must use a shared PostgreSQL nonce consumer. */
export class IngressReplayGuard {
  private readonly seen = new Map<string, number>();

  accept(nonce: string, nowMs: number): boolean {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt > nowMs) continue;
      this.seen.delete(key);
    }
    if (this.seen.has(nonce) || this.seen.size >= MAX_NONCES) return false;
    this.seen.set(nonce, nowMs + NONCE_TTL_MS);
    return true;
  }
}

export function createIngressGuard(options: {
  secret: string;
  production: boolean;
  now?: () => number;
  replayGuard?: IngressReplayGuard;
  consumeNonce?: IngressNonceConsumer;
}) {
  if (options.production && !options.consumeNonce) {
    throw new Error('Production trusted ingress requires shared PostgreSQL nonce storage.');
  }
  const now = options.now ?? Date.now;
  const replayGuard = options.replayGuard ?? new IngressReplayGuard();
  return async (req: IngressRequest, res: IngressResponse, next: IngressNext): Promise<void> => {
    // Express/Nest captures original parser bytes. A raw Buffer body is used for the
    // explicitly configured image parser; never serialize a parsed object to sign it.
    const body = req.rawBody ?? (req.body instanceof Uint8Array ? req.body : new Uint8Array());
    const rawPath = req.originalUrl ?? req.url ?? req.path ?? '/';
    const pathname = rawPath.split('?')[0] ?? rawPath;
    if (options.production && bypassPath(req.method, pathname)) {
      next();
      return;
    }

    const timestamp = oneHeader(req, 'x-trusted-ingress-timestamp');
    const nonce = oneHeader(req, 'x-trusted-ingress-nonce');
    const signature = oneHeader(req, 'x-trusted-ingress-signature');
    const principal = oneHeader(req, 'x-trusted-ingress-principal');
    const clientIp = oneHeader(req, 'x-trusted-ingress-client-ip');
    let valid = false;

    if (timestamp && nonce && signature && (principal === 'web' || principal === 'service') &&
        (principal==='service'?clientIp===undefined:typeof clientIp==='string'&&isIP(clientIp)!==0) &&
        /^\d{10}$/.test(timestamp) && /^[A-Za-z0-9_-]{16,128}$/.test(nonce) &&
        (clientIp === undefined || clientIp.length <= 64) &&
        Math.abs(Math.floor(now() / 1000) - Number(timestamp)) <= MAX_CLOCK_SKEW_SECONDS) {
      const input: IngressSignatureInput = {
        method: req.method,
        path: rawPath,
        timestamp,
        nonce,
        principal,
        body,
        ...(clientIp === undefined ? {} : { clientIp }),
      };
      valid = verifyIngressSignature(options.secret, input, signature);
      if (valid) {
        try {
          valid = options.consumeNonce
            ? await options.consumeNonce(nonce, new Date(now() + NONCE_TTL_MS))
            : replayGuard.accept(nonce, now());
        } catch {
          // A database failure fails closed. The caller does not learn storage details.
          res.status(503).json({ statusCode: 503, code: 'TRUSTED_INGRESS_UNAVAILABLE' });
          return;
        }
      }
      if (valid) {
        req.trustedIngress = { principal, ...(clientIp === undefined ? {} : { clientIp }) };
        if (principal === 'web' && clientIp) {
          // Express uses the socket peer by default. Replace req.ip only after the
          // complete method, target, body and provider-derived address are authenticated.
          Object.defineProperty(req, 'ip', { configurable: true, enumerable: true, value: clientIp });
        }
      }
    }

    if (valid || (!options.production && options.secret.length < 32) || (!options.production && !timestamp)) {
      next();
      return;
    }
    if (!options.production) {
      // Local development keeps Express's socket-derived req.ip and ignores bad signatures.
      next();
      return;
    }
    res.status(403).json({ statusCode: 403, code: 'TRUSTED_INGRESS_REQUIRED' });
  };
}

export function isProductionIngressMode(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.NODE_ENV === 'production' || ['production', 'public'].includes((env.RELEASE_MODE ?? '').toLowerCase());
}
