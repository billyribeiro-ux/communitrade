import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { chmod, link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import sharp, { type Metadata, type OutputInfo } from 'sharp';
export { createAttributedShareImage, type ShareImageAttribution } from './share-image.js';
export { createObjectStores, R2ExportStorage, R2Storage, type ObjectStoreEnvironment, type R2StorageConfig, type R2Transport } from './r2-storage.js';

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
const KEY = /^[0-9a-f-]{36}\/(?:quarantine|processed)\.(?:bin|webp)$/i;
const EXPORT_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-a[1-9][0-9]*\.(?:csv|json)$/i;

export interface StoragePort {
  putQuarantined(id: string, bytes: Uint8Array): Promise<string>;
  readQuarantined(id: string): Promise<Buffer>;
  putProcessed(id: string, bytes: Uint8Array): Promise<string>;
  /** Creates a processed object once and refuses to replace existing content. */
  putImmutableProcessed(id: string, bytes: Uint8Array): Promise<string>;
  readAuthorized(key: string, access: MediaAccess): Promise<Buffer>;
  deleteObject(key: string): Promise<void>;
}
export interface MediaAccess {
  actorUserId: string;
  ownerUserId: string;
  purpose: string;
  status: string;
  attachedPublicAvatar: boolean;
  attachedPublicPublication?: boolean;
}

/** Local private object storage for generated personal CSV exports. Keys are never URLs. */
export class FilesystemExportStorage {
  private readonly root: string;
  constructor(root: string) {
    if (!path.isAbsolute(root)) throw new Error('Export root must be absolute');
    this.root = path.join(root, 'exports');
  }
  async initialize(): Promise<void> { await mkdir(this.root, { recursive: true, mode: 0o700 }); await chmod(this.root, 0o700); }
  async put(id: string, bytes: Uint8Array, attempt = 1, format: 'csv' | 'json' = 'csv'): Promise<string> {
    const key = this.key(id, attempt, format); if (bytes.byteLength < 1) throw new Error('Export object cannot be empty');
    await this.initialize(); const target = path.join(this.root, key); const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await link(temp, target); await unlink(temp); return key;
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const existing = await readFile(target).catch(() => null);
        if (existing && existing.equals(Buffer.from(bytes))) return key;
      }
      throw error;
    }
  }
  async read(key: string): Promise<Buffer> { await this.initialize(); return readFile(path.join(this.root, this.validateKey(key))); }
  async delete(key: string): Promise<void> { await unlink(path.join(this.root, this.validateKey(key))).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
  private key(id: string, attempt: number, format: 'csv' | 'json'): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Invalid export identity');
    return this.validateKey(`${id}-a${attempt}.${format}`);
  }
  private validateKey(key: string): string { if (!EXPORT_KEY.test(key)) throw new Error('Invalid export key'); return key; }
}

/** Private filesystem implementation; keys are generated internally and never URLs. */
export class FilesystemStorage implements StoragePort {
  private readonly quarantine: string;
  private readonly processed: string;
  constructor(root: string) {
    if (!path.isAbsolute(root)) throw new Error('Media root must be absolute');
    this.quarantine = path.join(root, 'quarantine');
    this.processed = path.join(root, 'processed');
  }
  async initialize(): Promise<void> {
    await mkdir(this.quarantine, { recursive: true, mode: 0o700 });
    await mkdir(this.processed, { recursive: true, mode: 0o700 });
    await chmod(this.quarantine, 0o700);
    await chmod(this.processed, 0o700);
  }
  async putQuarantined(id: string, bytes: Uint8Array): Promise<string> {
    const key = `${id}/quarantine.bin`;
    await this.write(this.quarantine, key, bytes);
    return key;
  }
  async readQuarantined(id: string): Promise<Buffer> { return this.read(this.quarantine, `${id}/quarantine.bin`); }
  async putProcessed(id: string, bytes: Uint8Array): Promise<string> {
    const key = `${id}/processed.webp`;
    await this.write(this.processed, key, bytes);
    return key;
  }
  async putImmutableProcessed(id: string, bytes: Uint8Array): Promise<string> {
    const key = `${id}/processed.webp`;
    if (!KEY.test(key) || bytes.byteLength < 1) throw new Error('Invalid immutable media object');
    await this.initialize();
    const target = path.join(this.processed, key);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(target), 0o700);
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await link(temp, target);
      await unlink(temp);
      return key;
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }
  async readAuthorized(key: string, access: MediaAccess): Promise<Buffer> {
    if (access.status !== 'ready' || !key.endsWith('/processed.webp')) throw new Error('Media is unavailable');
    const allowed = access.actorUserId === access.ownerUserId || (access.purpose === 'avatar' && access.attachedPublicAvatar)
      || ((access.purpose === 'publication_attachment' || access.purpose === 'chart_snapshot') && access.attachedPublicPublication === true);
    if (!allowed) throw new Error('Media is unavailable');
    return this.read(this.processed, key);
  }
  async deleteObject(key: string): Promise<void> {
    if (!KEY.test(key)) throw new Error('Invalid media key');
    const root = key.includes('/quarantine.') ? this.quarantine : this.processed;
    await unlink(path.join(root, key)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
  private async write(root: string, key: string, bytes: Uint8Array): Promise<void> {
    if (!KEY.test(key)) throw new Error('Invalid media key');
    await this.initialize();
    const target = path.join(root, key);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(target), 0o700);
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }
  private async read(root: string, key: string): Promise<Buffer> {
    if (!KEY.test(key)) throw new Error('Invalid media key');
    return readFile(path.join(root, key));
  }
}

export interface ProcessedImage { bytes: Buffer; width: number; height: number; checksum: string }
export async function processAvatar(bytes: Buffer, declaredMime: string): Promise<ProcessedImage> {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_UPLOAD_BYTES) throw new Error('INVALID_SIZE');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(declaredMime)) throw new Error('INVALID_MIME');
  const image = sharp(bytes, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS, animated: false });
  let metadata: Metadata;
  try { metadata = await image.metadata(); } catch { throw new Error('INVALID_IMAGE'); }
  const actualMime = metadata.format === 'jpeg' ? 'image/jpeg' : metadata.format === 'png' ? 'image/png' : metadata.format === 'webp' ? 'image/webp' : '';
  if (actualMime !== declaredMime || !metadata.width || !metadata.height || (metadata.pages ?? 1) > 1 || metadata.width > 10000 || metadata.height > 10000 || metadata.width * metadata.height > MAX_IMAGE_PIXELS) throw new Error('INVALID_IMAGE');
  let output: {data:Buffer;info:OutputInfo};
  try { output = await image.rotate().resize({ width: 512, height: 512, fit: 'cover', position: 'centre', withoutEnlargement: true }).webp({ quality: 84, effort: 4 }).toBuffer({ resolveWithObject: true }); } catch { throw new Error('INVALID_IMAGE'); }
  const { data, info } = output;
  return { bytes: data, width: info.width, height: info.height, checksum: createHash('sha256').update(data).digest('hex') };
}
