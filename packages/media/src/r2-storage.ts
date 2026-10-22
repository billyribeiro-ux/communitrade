import { createHash, createHmac } from 'node:crypto';
import type { MediaAccess, StoragePort } from './index.js';

const MEDIA_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:quarantine\.bin|processed\.webp)$/i;
const EXPORT_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-a[1-9][0-9]*\.(?:csv|json)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MEDIA_BYTES = 4 * 1024 * 1024;
const MAX_EXPORT_BYTES = 50 * 1024 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export type R2Transport = (url: URL, init: RequestInit) => Promise<Response>;
export interface R2StorageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional transport seam for deterministic tests. Production defaults to global fetch. */
  fetch?: R2Transport;
  timeoutMs?: number;
}

/** Server-side environment keys for the private R2 provider. */
export interface ObjectStoreEnvironment {
  R2_ACCOUNT_ID?: string;
  R2_BUCKET?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_TIMEOUT_MS?: string;
}

type ObjectStoreConfig = R2StorageConfig & { maxObjectBytes: number };

function assertConfig(config: R2StorageConfig): URL {
  if (!config || typeof config !== 'object') throw new Error('R2 configuration is required');
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw new Error('R2 endpoint must be a plain HTTPS account endpoint');
  if (!/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/i.test(endpoint.hostname)) throw new Error('R2 endpoint host is invalid');
  if (!/^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])?$/.test(config.bucket) || config.bucket.length < 3 || config.bucket.includes('..') || config.bucket.includes('.-') || config.bucket.includes('-.') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(config.bucket)) throw new Error('R2 bucket name is invalid');
  if (typeof config.accessKeyId !== 'string' || !/^[A-Za-z0-9+=,.@_-]{1,128}$/.test(config.accessKeyId)
    || typeof config.secretAccessKey !== 'string' || config.secretAccessKey.length < 16 || config.secretAccessKey.length > 256) throw new Error('R2 credentials are invalid');
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120_000) throw new Error('R2 timeout is invalid');
  return endpoint;
}

function sha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function hmac(key: Buffer | string, value: string): Buffer { return createHmac('sha256', key).update(value).digest(); }
function hex(bytes: Buffer): string { return bytes.toString('hex'); }
function awsEncode(value: string): string { return encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`); }
function canonicalPath(bucket: string, key: string): string { return `/${awsEncode(bucket)}/${key.split('/').map(awsEncode).join('/')}`; }
function safeKey(key: string, expression: RegExp): string {
  if (!expression.test(key) || key.includes('..') || key.includes('\\')) throw new Error('Invalid object key');
  return key;
}
function dateParts(now: Date): { amz: string; day: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amz: iso, day: iso.slice(0, 8) };
}
function signingKey(secret: string, day: string): Buffer {
  const dateKey = hmac(`AWS4${secret}`, day);
  const regionKey = hmac(dateKey, 'auto');
  const serviceKey = hmac(regionKey, 's3');
  return hmac(serviceKey, 'aws4_request');
}
class R2Objects {
  private readonly endpoint: URL;
  private readonly request: R2Transport;
  private readonly timeoutMs: number;
  constructor(private readonly config: ObjectStoreConfig) {
    this.endpoint = assertConfig(config);
    this.request = config.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async put(key: string, bytes: Uint8Array, contentType: string, conditional = false): Promise<void> {
    if (bytes.byteLength < 1 || bytes.byteLength > this.config.maxObjectBytes) throw new Error('Object size is outside configured bounds');
    const payload = Buffer.from(bytes);
    const response = await this.send('PUT', key, payload, { 'content-type': contentType, ...(conditional ? { 'if-none-match': '*' } : {}) });
    await drainBounded(response, MAX_ERROR_BYTES);
  }
  async get(key: string): Promise<Buffer> {
    const response = await this.send('GET', key);
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > this.config.maxObjectBytes) { await reader.cancel(); throw new Error('Stored object exceeds configured bounds'); }
        chunks.push(Buffer.from(value));
      }
    } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
    return Buffer.concat(chunks, length);
  }
  async delete(key: string): Promise<void> {
    // DELETE is idempotent. Retry only transient outcomes with a small, fixed
    // budget; never retry writes whose acknowledgement may have been lost.
    const delays = [0, 100, 300];
    let lastError: unknown;
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      if (delays[attempt]) await new Promise(resolve => setTimeout(resolve, delays[attempt]));
      try {
        const response = await this.send('DELETE', key, undefined, {}, [404], true);
        await drainBounded(response, MAX_ERROR_BYTES);
        return;
      } catch (error) {
        lastError = error;
        const status = (error as { status?: number }).status;
        if (attempt === delays.length - 1 || (status !== undefined && ![429, 500, 502, 503, 504].includes(status))) throw error;
      }
    }
    throw lastError;
  }

  private async send(method: string, key: string, body?: Buffer, extraHeaders: Record<string, string> = {}, allowedStatus: number[] = [], retryTransport = false): Promise<Response> {
    const path = canonicalPath(this.config.bucket, key);
    const url = new URL(path, this.endpoint.origin);
    const { amz, day } = dateParts(new Date());
    const payloadHash = body ? sha256(body) : sha256(Buffer.alloc(0));
    const headers: Record<string, string> = {
      ...extraHeaders,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amz,
    };
    const canonicalHeaders = Object.entries({ host: url.host, ...headers })
      .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map(([name, value]) => `${name.toLowerCase()}:${value.trim().replace(/\s+/g, ' ')}\n`).join('');
    const signedHeaders = Object.keys({ host: url.host, ...headers }).map(name => name.toLowerCase()).sort().join(';');
    const canonicalRequest = `${method}\n${url.pathname}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const scope = `${day}/auto/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amz}\n${scope}\n${sha256(Buffer.from(canonicalRequest))}`;
    const signature = hex(hmac(signingKey(this.config.secretAccessKey, day), stringToSign));
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try { response = await this.request(url, { method, headers, body:body?Uint8Array.from(body):null, signal, redirect: 'error' }); }
    catch (error) { throw new Error('R2 request failed', { cause: error }); }
    if (response.ok || allowedStatus.includes(response.status)) return response;
    if (retryTransport && [429, 500, 502, 503, 504].includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      const error = new Error(`R2 request failed (${response.status})`);
      Object.assign(error, { status: response.status });
      throw error;
    }
    const detail = await errorDetail(response);
    if (response.status === 412 && extraHeaders['if-none-match'] === '*') {
      const error = new Error('Immutable object already exists');
      Object.assign(error, { code: 'EEXIST', status: 412 });
      throw error;
    }
    const error = new Error(`R2 request failed (${response.status}${detail ? `: ${detail}` : ''})`);
    Object.assign(error, { status: response.status });
    throw error;
  }
}

async function drainBounded(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength; if (length > maxBytes) { await reader.cancel(); throw new Error('R2 error response exceeded its size limit'); }
      chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  return Buffer.concat(chunks, length);
}
async function errorDetail(response: Response): Promise<string> {
  const body = await drainBounded(response, MAX_ERROR_BYTES).catch(() => Buffer.alloc(0));
  const code = /<Code>([A-Za-z0-9]+)<\/Code>/.exec(body.toString('utf8'))?.[1];
  return code ?? '';
}

/** Private R2 object adapter. It never creates or returns public or presigned URLs. */
export class R2Storage implements StoragePort {
  private readonly objects: R2Objects;
  constructor(config: R2StorageConfig) { this.objects = new R2Objects({ ...config, maxObjectBytes: MAX_MEDIA_BYTES }); }
  async putQuarantined(id: string, bytes: Uint8Array): Promise<string> {
    if(bytes.byteLength>2*1024*1024)throw new Error('R2 quarantine object exceeds upload limit');
    const key = this.mediaKey(id, 'quarantine.bin');
    await this.putIdempotent(key, bytes, 'application/octet-stream'); return key;
  }
  async readQuarantined(id: string): Promise<Buffer> { return this.objects.get(this.mediaKey(id, 'quarantine.bin')); }
  async putProcessed(id: string, bytes: Uint8Array): Promise<string> {
    return this.putImmutableProcessed(id, bytes);
  }
  async putImmutableProcessed(id: string, bytes: Uint8Array): Promise<string> {
    const key = this.mediaKey(id, 'processed.webp');
    try { await this.objects.put(key, bytes, 'image/webp', true); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.objects.get(key);
      if (!existing.equals(Buffer.from(bytes))) throw error;
    }
    return key;
  }
  async readAuthorized(key: string, access: MediaAccess): Promise<Buffer> {
    safeKey(key, MEDIA_KEY);
    if (access.status !== 'ready' || !key.endsWith('/processed.webp')) throw new Error('Media is unavailable');
    const allowed = access.actorUserId === access.ownerUserId || (access.purpose === 'avatar' && access.attachedPublicAvatar)
      || ((access.purpose === 'publication_attachment' || access.purpose === 'chart_snapshot') && access.attachedPublicPublication === true);
    if (!allowed) throw new Error('Media is unavailable');
    return this.objects.get(key);
  }
  async deleteObject(key: string): Promise<void> { await this.objects.delete(safeKey(key, MEDIA_KEY)); }
  private async putIdempotent(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    try { await this.objects.put(key, bytes, contentType, true); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.objects.get(key);
      if (!existing.equals(Buffer.from(bytes))) throw error;
    }
  }
  private mediaKey(id: string, leaf: string): string {
    if (!UUID.test(id)) throw new Error('Invalid media identity');
    return safeKey(`${id}/${leaf}`, MEDIA_KEY);
  }
}

/** Private R2 adapter for owner-authorized, expiring export jobs. */
export class R2ExportStorage {
  private readonly objects: R2Objects;
  constructor(config: R2StorageConfig) { this.objects = new R2Objects({ ...config, maxObjectBytes: MAX_EXPORT_BYTES }); }
  async put(id: string, bytes: Uint8Array, attempt = 1, format: 'csv' | 'json' = 'csv'): Promise<string> {
    if (!UUID.test(id) || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 1_000_000) throw new Error('Invalid export identity');
    const key = safeKey(`${id}-a${attempt}.${format}`, EXPORT_KEY);
    try { await this.objects.put(key, bytes, format === 'json' ? 'application/json' : 'text/csv; charset=utf-8', true); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.objects.get(key);
      if (!existing.equals(Buffer.from(bytes))) throw error;
    }
    return key;
  }
  async read(key: string): Promise<Buffer> { return this.objects.get(safeKey(key, EXPORT_KEY)); }
  async delete(key: string): Promise<void> { await this.objects.delete(safeKey(key, EXPORT_KEY)); }
}

/** Build the production object adapters from server-only environment values. */
export function createObjectStores(env: ObjectStoreEnvironment): { media: R2Storage; exportStorage: R2ExportStorage } {
  if (!env || typeof env !== 'object') throw new Error('R2 object storage environment is required');
  const accountId = env.R2_ACCOUNT_ID;
  if (typeof accountId !== 'string' || !/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('R2_ACCOUNT_ID is invalid');
  const timeoutText = env.R2_TIMEOUT_MS;
  const timeoutMs = timeoutText === undefined ? undefined : Number(timeoutText);
  if (timeoutText !== undefined && (!/^\d{1,6}$/.test(timeoutText) || !Number.isSafeInteger(timeoutMs)||Number(timeoutMs)<100||Number(timeoutMs)>120000)) throw new Error('R2_TIMEOUT_MS is invalid');
  const config: R2StorageConfig = {
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    bucket: env.R2_BUCKET ?? '',
    accessKeyId: env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? '',
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  return { media: new R2Storage(config), exportStorage: new R2ExportStorage(config) };
}
