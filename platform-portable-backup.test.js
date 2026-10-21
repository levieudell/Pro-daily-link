'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PLATFORM_NAMESPACE_ID, canonicalHash } = require('./database/platform-repository');
const {
  collectPlatformStorageReferences,
  createPlatformPortableBackup,
  verifyPlatformPortableBackup,
  digest
} = require('./database/platform-portable-backup');

const snapshot = {
  users: [{ id: 'owner-1', email: 'owner@prodailylink.com' }],
  blogPosts: [{
    id: 'post-1',
    title: 'Daily reports without the paperwork chase',
    hero: { storageBucket: 'platform-assets', storageKey: `platform/blog/post-1.jpg` }
  }],
  settings: { supportEmail: 'support@prodailylink.com' }
};

assert.equal(collectPlatformStorageReferences(snapshot).length, 1);
assert.throws(() => collectPlatformStorageReferences({ image: { bucket: 'private', objectKey: 'another-tenant/file.png' } }), /Cross-namespace/);

(async () => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-platform-backup-test-'));
  try {
    const imageBytes = Buffer.from('private-blog-image');
    await assert.rejects(
      () => createPlatformPortableBackup({ snapshot, revision: 12, destination, now: new Date('2026-10-20T11:59:00.000Z') }),
      /no server-side downloader/
    );
    assert.deepEqual(fs.readdirSync(destination), [], 'a failed export must not leave a partial recovery set');
    await assert.rejects(
      () => createPlatformPortableBackup({
        snapshot,
        revision: 12,
        destination,
        now: new Date('2026-10-20T11:59:30.000Z'),
        download: async () => { throw new Error('storage unavailable'); }
      }),
      /storage unavailable/
    );
    assert.deepEqual(fs.readdirSync(destination), [], 'a failed object download must remove its incomplete recovery set');
    const backup = await createPlatformPortableBackup({
      snapshot,
      revision: 12,
      destination,
      now: new Date('2026-10-20T12:00:00.000Z'),
      download: async (bucket, objectKey) => {
        assert.equal(bucket, 'platform-assets');
        assert.equal(objectKey, 'platform/blog/post-1.jpg');
        return {
          arrayBuffer: async () => imageBytes,
          headers: { get: name => name === 'content-type' ? 'image/jpeg' : null }
        };
      }
    });
    assert.equal(backup.verification.ok, true);
    assert.equal(backup.manifest.namespaceId, PLATFORM_NAMESPACE_ID);
    assert.equal(backup.manifest.sourceRevision, 12);
    assert.equal(backup.manifest.objects.length, 1);
    assert.equal(backup.manifest.objects[0].sha256, digest(imageBytes));
    assert.match(fs.readFileSync(path.join(backup.directory, 'manifest.sha256'), 'utf8'), /^[a-f0-9]{64}  manifest\.json\n$/);

    const collisionTime = new Date('2026-10-20T12:00:30.000Z');
    const [parallelA, parallelB] = await Promise.all([1, 2].map(() => createPlatformPortableBackup({
      snapshot,
      revision: 12,
      destination,
      now: collisionTime,
      download: async () => ({ arrayBuffer: async () => imageBytes, headers: { get: () => 'image/jpeg' } })
    })));
    assert.notEqual(parallelA.directory, parallelB.directory, 'same-revision exports allocate independent directories');
    assert.equal(verifyPlatformPortableBackup(parallelA.directory).ok, true);
    assert.equal(verifyPlatformPortableBackup(parallelB.directory).ok, true);

    const verified = verifyPlatformPortableBackup(backup.directory);
    assert.deepEqual(verified.snapshot, snapshot);
    assert.equal(verified.contentHash, canonicalHash(snapshot));
    assert.equal(verified.objects, 1);

    const platformFile = path.join(backup.directory, 'platform.json');
    const original = fs.readFileSync(platformFile);
    fs.writeFileSync(platformFile, Buffer.from(original.toString('utf8').replace('owner-1', 'tampered')));
    assert.throws(() => verifyPlatformPortableBackup(backup.directory), /(byte count|SHA-256) does not match/);
    fs.writeFileSync(platformFile, original);
    assert.equal(verifyPlatformPortableBackup(backup.directory).ok, true);

    const manifestFile = path.join(backup.directory, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.namespaceId = '11111111-1111-4111-8111-111111111111';
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    assert.throws(() => verifyPlatformPortableBackup(backup.directory), /manifest SHA-256/);
  } finally {
    fs.rmSync(destination, { recursive: true, force: true });
  }
  console.log('Platform portable backup and tamper-detection tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
