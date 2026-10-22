import { NextRequest } from 'next/server';
import { providerClientIp, trustedIngressHeaders } from '@/lib/server/ingress';
import { apiProxyTarget } from '@/lib/server/api-target';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const API_ORIGIN = process.env.API_INTERNAL_URL ?? 'http://localhost:3001';
const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

async function readLimitedBody(request: Request): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new RangeError('REQUEST_BODY_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function forward(request: NextRequest): Promise<Response> {
  let target: URL;
  try {
    target = apiProxyTarget(API_ORIGIN, request.nextUrl.pathname, request.nextUrl.search);
  } catch (error) {
    const invalidPath = error instanceof Error && error.message === 'INVALID_API_PATH';
    const status = invalidPath ? 400 : 503;
    return Response.json({ statusCode: status, code: invalidPath ? 'INVALID_API_PATH' : 'API_UNAVAILABLE' }, { status, headers: { 'Cache-Control': 'no-store' } });
  }
  const production = ['production', 'public'].includes((process.env.RELEASE_MODE ?? '').toLowerCase()) || process.env.NODE_ENV==='production'&&process.env.RELEASE_MODE!=='local';
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  let body: Uint8Array | undefined;
  if (hasBody) {
    const declaredLength = Number(request.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
      return Response.json({ statusCode: 413, code: 'REQUEST_TOO_LARGE' }, { status: 413, headers: { 'Cache-Control': 'no-store' } });
    }
    try {
      body = await readLimitedBody(request);
    } catch {
      return Response.json({ statusCode: 413, code: 'REQUEST_TOO_LARGE' }, { status: 413, headers: { 'Cache-Control': 'no-store' } });
    }
  }

  let ingress: Headers | undefined;
  if (production) {
    try {
      const clientIp = providerClientIp(request.headers, process.env.WEB_INGRESS_MODE, production, process.env.VERCEL);
      ingress = trustedIngressHeaders({
        secret: process.env.TRUSTED_INGRESS_SECRET ?? '',
        method: request.method,
        path: `${target.pathname}${target.search}`,
        principal: 'web',
        body,
        ...(clientIp === undefined ? {} : { clientIp }),
      });
    } catch {
      return Response.json({ statusCode: 503, code: 'TRUSTED_INGRESS_UNAVAILABLE' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  }

  const headers = new Headers(request.headers);
  for (const key of Array.from(headers.keys())) if (HOP_BY_HOP.has(key.toLowerCase())) headers.delete(key);
  for(const key of ['forwarded','x-forwarded-for','x-real-ip','x-vercel-forwarded-for'])headers.delete(key);
  for (const key of Array.from(headers.keys())) if (key.toLowerCase().startsWith('x-trusted-ingress-')) headers.delete(key);
  ingress?.forEach((value, key) => headers.set(key, value));
  if (body?.byteLength) headers.set('content-length', String(body.byteLength));
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody&&body ? Uint8Array.from(body) : null,
      cache: 'no-store',
      redirect: 'manual',
      signal:AbortSignal.any([request.signal,AbortSignal.timeout(30000)]),
    });
    const responseHeaders = new Headers();
    upstream.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key.toLowerCase()) && key.toLowerCase() !== 'content-encoding' && key.toLowerCase() !== 'set-cookie') responseHeaders.set(key, value);
    });
    for (const cookie of upstream.headers.getSetCookie()) responseHeaders.append('set-cookie', cookie);
    responseHeaders.set('Cache-Control', 'no-store');
    return new Response(request.method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    return Response.json({ statusCode: 502, code: 'API_UNAVAILABLE' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}

export const GET = forward;
export const HEAD = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
export const OPTIONS = forward;
