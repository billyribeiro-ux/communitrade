import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import test from 'node:test';
import { FilesystemStorage, processAvatar } from '../dist/index.js';

test('image processor verifies declared type and re-encodes metadata-free bounded output', async () => {
  const input = await sharp({ create: { width: 700, height: 300, channels: 3, background: '#123456' } }).png().withMetadata({ exif: { IFD0: { Artist: 'private' } } }).toBuffer();
  const result = await processAvatar(input, 'image/png');
  const metadata = await sharp(result.bytes).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 512);
  assert.equal(metadata.height, 300);
  assert.equal(metadata.exif, undefined);
  await assert.rejects(processAvatar(input, 'image/jpeg'), /INVALID_IMAGE/);
});

test('filesystem storage only serves authorized processed keys and rejects quarantine access', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'media-test-'));
  try {
    const storage = new FilesystemStorage(root);
    await storage.initialize();
    const id = '00000000-0000-4000-8000-000000000001';
    const key = await storage.putProcessed(id, Buffer.from('processed'));
    await assert.rejects(storage.readAuthorized(key, { actorUserId: 'owner-b', ownerUserId: 'owner-a', purpose: 'avatar', status: 'ready', attachedPublicAvatar: false }));
    assert.equal((await storage.readAuthorized(key, { actorUserId: 'owner-b', ownerUserId: 'owner-a', purpose: 'avatar', status: 'ready', attachedPublicAvatar: true })).toString(), 'processed');
    await assert.rejects(storage.readAuthorized(`${id}/quarantine.bin`, { actorUserId: 'owner-a', ownerUserId: 'owner-a', purpose: 'avatar', status: 'ready', attachedPublicAvatar: false }));
    await assert.rejects(storage.readAuthorized('../quarantine.bin', { actorUserId: 'owner-a', ownerUserId: 'owner-a', purpose: 'avatar', status: 'ready', attachedPublicAvatar: false }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('immutable processed objects use exclusive creation and refuse replacement', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'media-immutable-'));
  try {
    const storage = new FilesystemStorage(root);
    const id = '00000000-0000-4000-8000-000000000010';
    const key = await storage.putImmutableProcessed(id, Buffer.from('frozen snapshot bytes'));
    assert.equal(key, `${id}/processed.webp`);
    await assert.rejects(storage.putImmutableProcessed(id, Buffer.from('different snapshot bytes')), (error) => error.code === 'EEXIST');
    assert.deepEqual(await readdir(path.join(root, 'processed', id)), ['processed.webp']);
    const access = { actorUserId: 'owner', ownerUserId: 'owner', purpose: 'chart_snapshot', status: 'ready', attachedPublicAvatar: false };
    assert.equal((await storage.readAuthorized(key, access)).toString(), 'frozen snapshot bytes');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('public chart snapshots require a ready publication binding and cannot be read from arbitrary storage keys', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'media-snapshot-access-'));
  try {
    const storage = new FilesystemStorage(root);
    const id = '00000000-0000-4000-8000-000000000011';
    const key = await storage.putImmutableProcessed(id, Buffer.from('frozen chart'));
    const publicAccess = { actorUserId: 'reader', ownerUserId: 'creator', purpose: 'chart_snapshot', status: 'ready', attachedPublicAvatar: false, attachedPublicPublication: true };
    assert.equal((await storage.readAuthorized(key, publicAccess)).toString(), 'frozen chart');
    await assert.rejects(storage.readAuthorized(key, { ...publicAccess, attachedPublicPublication: false }));
    await assert.rejects(storage.readAuthorized(`${id}/quarantine.bin`, publicAccess));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('failed atomic media writes remove their temporary file', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'media-temp-cleanup-'));
  try{
    const storage=new FilesystemStorage(root);await storage.initialize();
    const id='00000000-0000-4000-8000-000000000009';
    const targetDirectory=path.join(root,'quarantine',id,'quarantine.bin');
    await mkdir(targetDirectory,{recursive:true});
    await assert.rejects(storage.putQuarantined(id,Buffer.from('image bytes')));
    assert.deepEqual(await readdir(path.dirname(targetDirectory)),['quarantine.bin']);
  }finally{await rm(root,{recursive:true,force:true});}
});
