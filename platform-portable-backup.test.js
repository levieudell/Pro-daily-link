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
  readVerifiedPlatformObjects,
  validatePlatformSnapshot,
  validatePlatformRestoreSnapshot,
  SNAPSHOT_SCHEMA,
  isMissingStorageObjectError,
  digest
} = require('./database/platform-portable-backup');

const snapshot = {
  users: [{ id: 'owner-1', name: 'Platform Owner', email: 'owner@prodailylink.com', role: 'platform_owner', status: 'Active' }],
  blogPosts: [{
    id: 'post-1',
    title: 'Daily reports without the paperwork chase',
    hero: { storageBucket: 'platform-assets', storageKey: `platform/blog/post-1.jpg` }
  }],
  settings: { supportEmail: 'support@prodailylink.com' }
};

assert.throws(() => validatePlatformSnapshot({}), /at least one user/);
assert.throws(() => validatePlatformSnapshot({ users: [snapshot.users[0], { ...snapshot.users[0] }] }), /duplicate id/);
assert.throws(() => validatePlatformSnapshot({ users: [snapshot.users[0], { ...snapshot.users[0], id: 'owner-2' }] }), /duplicate user email/);
const legacyPlatformUsers = [
  snapshot.users[0],
  { id: 'legacy-root', name: 'Legacy Root', email: 'legacy-root@example.test', role: 'root', status: 'Active' },
  { id: 'legacy-import', name: 'Legacy Import', email: 'legacy-import@example.test', role: 'unknown', status: 'Quarantined' }
];
assert.doesNotThrow(() => validatePlatformSnapshot({ users: legacyPlatformUsers }), 'platform evidence preserves bounded historical identities');
assert.throws(() => validatePlatformRestoreSnapshot({ users: legacyPlatformUsers }), /unsupported role/);
assert.throws(() => validatePlatformRestoreSnapshot({ users: [snapshot.users[0], { ...legacyPlatformUsers[2], role: 'support' }] }), /unsupported status/);
assert.doesNotThrow(() => validatePlatformRestoreSnapshot({ users: [snapshot.users[0], { ...legacyPlatformUsers[1], status: 'Inactive' }] }));
assert.throws(() => validatePlatformSnapshot({ users: [snapshot.users[0], { ...legacyPlatformUsers[1], role: 'x'.repeat(81) }] }), /role is invalid/);
assert.throws(() => validatePlatformSnapshot({ users: [snapshot.users[0], { ...legacyPlatformUsers[1], status: 'Bad\nStatus' }] }), /status is invalid/);
assert.throws(() => validatePlatformSnapshot({ users: [{ ...snapshot.users[0], status: 'Inactive' }] }), /active platform_owner/);
assert.throws(() => validatePlatformSnapshot({ users: [snapshot.users[0]], blogPosts: {} }), /collection blogPosts must be an array/);
assert.throws(() => validatePlatformSnapshot({ users: [snapshot.users[0]], surpriseRows: [] }), /unsupported collection/);

assert.equal(collectPlatformStorageReferences(snapshot).length, 1);
assert.throws(() => collectPlatformStorageReferences({ image: { bucket: 'private', objectKey: 'another-tenant/file.png' } }), /Cross-namespace/);
assert.deepEqual(collectPlatformStorageReferences({ analytics: { bucket: 'qualified', count: 4 } }), []);
assert.throws(() => collectPlatformStorageReferences({ image: { storageBucket: 'private' } }), /Incomplete platform storage reference/);
assert.throws(() => collectPlatformStorageReferences({ image: { objectKey: 'platform/image.png' } }), /Incomplete platform storage reference/);
assert.throws(() => collectPlatformStorageReferences({ image: { bucket: '../private', objectKey: 'platform/image.png' } }), /bucket is invalid/);
assert.throws(() => collectPlatformStorageReferences({ image: { url: '/uploads/platform/image.png' } }), /Non-portable local platform storage reference/);
assert.throws(() => collectPlatformStorageReferences({ image: { url: '/api/files/platform-assets/platform/image.png' } }), /Non-portable local platform storage reference/);
assert.throws(() => collectPlatformStorageReferences({ image: { downloadUrl: 'C:\\private\\platform-image.png' } }), /Non-portable local platform storage reference/);
assert.throws(() => collectPlatformStorageReferences({ image: { downloadUrl: '\\\\fileserver\\private\\platform-image.png' } }), /Non-portable local platform storage reference/);
assert.throws(() => collectPlatformStorageReferences({ image: { downloadUrl: '\\\\?\\C:\\private\\platform-image.png' } }), /Non-portable local platform storage reference/);
assert.throws(() => collectPlatformStorageReferences({ image: { dataUrl: '//fileserver/private/platform-image.png' } }), /Non-portable local platform storage reference/);
assert.throws(() => collectPlatformStorageReferences({ image: { bucket: 'private', objectKey: 'platform/image.png\nsecret' } }), /object key is invalid/);
assert.equal(isMissingStorageObjectError(Object.assign(new Error('Object not found'), { statusCode: 403 })), false);
assert.equal(isMissingStorageObjectError(Object.assign(new Error('Provider hid the response'), { statusCode: 404 })), true);

function rewriteManifest(directory, mutate) {
  const manifestFile = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  mutate(manifest);
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
  fs.writeFileSync(manifestFile, bytes);
  fs.writeFileSync(path.join(directory, 'manifest.sha256'), `${digest(bytes)}  manifest.json\n`);
}

function rewriteSnapshotAndManifest(directory, replacement) {
  const snapshotFile = path.join(directory, 'platform.json');
  const snapshotBytes = Buffer.from(JSON.stringify(replacement, null, 2));
  fs.writeFileSync(snapshotFile, snapshotBytes);
  rewriteManifest(directory, manifest => {
    manifest.platform.bytes = snapshotBytes.length;
    manifest.platform.sha256 = digest(snapshotBytes);
    manifest.platform.canonicalSha256 = canonicalHash(replacement);
  });
}

(async () => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-platform-backup-test-'));
  try {
    const imageBytes = Buffer.from('private-blog-image');
    await assert.rejects(
      () => createPlatformPortableBackup({ snapshot: {}, revision: 12, destination }),
      /at least one user/
    );
    assert.deepEqual(fs.readdirSync(destination), [], 'an unsafe snapshot must fail before export filesystem I/O');
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
    assert.equal(backup.manifest.platform.schema, SNAPSHOT_SCHEMA);
    assert.equal(backup.manifest.sourceRevision, 12);
    assert.equal(backup.manifest.objects.length, 1);
    assert.equal(backup.manifest.objects[0].sha256, digest(imageBytes));
    assert.match(backup.manifest.objects[0].sourceRef, /^[a-f0-9]{24}$/);
    assert.equal('source' in backup.manifest.objects[0], false, 'manifest metadata must not repeat a potentially user-defined property path');
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

    const marker = path.join(destination, 'operator-note.txt');
    fs.writeFileSync(marker, 'keep me');
    await createPlatformPortableBackup({
      snapshot: { users: [snapshot.users[0]], settings: { support: true } },
      revision: 13,
      destination,
      now: new Date('2026-10-20T12:00:31.000Z')
    });
    assert.equal(fs.readFileSync(marker, 'utf8'), 'keep me', 'export must never replace unrelated destination contents');

    const missingBackup = await createPlatformPortableBackup({
      snapshot,
      revision: 14,
      destination,
      allowMissingObjects: true,
      now: new Date('2026-10-20T12:00:32.000Z'),
      download: async () => { throw new Error('404 Object not found'); }
    });
    const missingVerified = verifyPlatformPortableBackup(missingBackup.directory);
    assert.equal(missingVerified.missingObjects, 1);
    assert.throws(() => readVerifiedPlatformObjects(missingBackup.directory, missingVerified), /backup is incomplete/);
    assert.equal(readVerifiedPlatformObjects(missingBackup.directory, missingVerified, { allowMissing: true })[0].data, null);

    const legacyBackup = await createPlatformPortableBackup({
      snapshot: { ...snapshot, users: legacyPlatformUsers },
      revision: 16,
      destination,
      now: new Date('2026-10-20T12:00:31.000Z'),
      download: async () => ({ arrayBuffer: async () => imageBytes, headers: { get: () => 'image/png' } })
    });
    const legacyVerified = verifyPlatformPortableBackup(legacyBackup.directory);
    assert.deepEqual(legacyVerified.snapshot.users, legacyPlatformUsers, 'platform verification preserves legacy/quarantined identities exactly');

    const privateSource = {
      users: [snapshot.users[0]],
      assets: {
        'private.person@example.test': {
          storageBucket: 'platform-assets',
          storageKey: 'platform/no-pii-in-manifest.png'
        }
      }
    };
    const privateSourceBackup = await createPlatformPortableBackup({
      snapshot: privateSource,
      revision: 15,
      destination,
      now: new Date('2026-10-20T12:00:33.000Z'),
      download: async () => ({ arrayBuffer: async () => imageBytes, headers: { get: () => 'image/png' } })
    });
    assert.doesNotMatch(fs.readFileSync(path.join(privateSourceBackup.directory, 'manifest.json'), 'utf8'), /private\.person@example\.test/);

    const missingSchema = path.join(destination, 'missing-platform-schema-copy');
    fs.cpSync(backup.directory, missingSchema, { recursive: true });
    rewriteManifest(missingSchema, manifest => { delete manifest.platform.schema; });
    assert.throws(() => verifyPlatformPortableBackup(missingSchema), /Unsupported platform snapshot schema/);

    for (const [name, unsafe, message] of [
      ['empty', {}, /at least one user/],
      ['duplicate', { users: [snapshot.users[0], { ...snapshot.users[0] }] }, /duplicate id/],
      ['oversized-role', { users: [snapshot.users[0], { ...legacyPlatformUsers[1], role: 'x'.repeat(81) }] }, /role is invalid/],
      ['control-status', { users: [snapshot.users[0], { ...legacyPlatformUsers[1], status: 'Bad\nStatus' }] }, /status is invalid/]
    ]) {
      const copy = path.join(destination, `resigned-unsafe-platform-${name}`);
      fs.cpSync(backup.directory, copy, { recursive: true });
      rewriteSnapshotAndManifest(copy, unsafe);
      assert.throws(() => verifyPlatformPortableBackup(copy), message, `re-signed ${name} platform snapshot must fail domain validation`);
    }

    const extraPayload = path.join(destination, 'extra-payload-copy');
    fs.cpSync(backup.directory, extraPayload, { recursive: true });
    fs.writeFileSync(path.join(extraPayload, 'objects', '99999-deadbeefdeadbeef.bin'), 'not in manifest');
    assert.throws(() => verifyPlatformPortableBackup(extraPayload), /does not exactly match its manifest/);

    const nonExactSidecar = path.join(destination, 'non-exact-sidecar-copy');
    fs.cpSync(backup.directory, nonExactSidecar, { recursive: true });
    fs.appendFileSync(path.join(nonExactSidecar, 'manifest.sha256'), '\n');
    assert.throws(() => verifyPlatformPortableBackup(nonExactSidecar), /manifest SHA-256 verification failed/);

    const invalidTime = path.join(destination, 'invalid-time-copy');
    fs.cpSync(backup.directory, invalidTime, { recursive: true });
    rewriteManifest(invalidTime, manifest => { manifest.createdAt = 'not-a-time'; });
    assert.throws(() => verifyPlatformPortableBackup(invalidTime), /creation time/);

    const invalidFilename = path.join(destination, 'invalid-filename-copy');
    fs.cpSync(backup.directory, invalidFilename, { recursive: true });
    rewriteManifest(invalidFilename, manifest => { manifest.objects[0].filename = 'objects/not-exact.bin'; });
    assert.throws(() => verifyPlatformPortableBackup(invalidFilename), /Invalid or duplicate platform backup filename/);

    const invalidContentType = path.join(destination, 'invalid-content-type-copy');
    fs.cpSync(backup.directory, invalidContentType, { recursive: true });
    rewriteManifest(invalidContentType, manifest => { manifest.objects[0].contentType = 'image/jpeg\nX-Injected: yes'; });
    assert.throws(() => verifyPlatformPortableBackup(invalidContentType), /Invalid platform object content type/);

    // Linux CI must preserve the no-symlink recovery boundary. Windows often
    // requires a separate privilege to create symlinks, so it is covered by
    // the same implementation checks but not created in this local test run.
    if (process.platform !== 'win32') {
      const rootLink = path.join(destination, 'backup-root-link');
      fs.symlinkSync(backup.directory, rootLink, 'dir');
      assert.throws(() => verifyPlatformPortableBackup(rootLink), /root must be a regular directory/);

      const linkedPayload = path.join(destination, 'linked-payload-copy');
      fs.cpSync(backup.directory, linkedPayload, { recursive: true });
      const externalPlatform = path.join(destination, 'external-platform.json');
      fs.copyFileSync(path.join(linkedPayload, 'platform.json'), externalPlatform);
      fs.unlinkSync(path.join(linkedPayload, 'platform.json'));
      fs.symlinkSync(externalPlatform, path.join(linkedPayload, 'platform.json'));
      assert.throws(() => verifyPlatformPortableBackup(linkedPayload), /not a regular file/);

      const linkedObject = path.join(destination, 'linked-object-copy');
      fs.cpSync(backup.directory, linkedObject, { recursive: true });
      const linkedManifest = JSON.parse(fs.readFileSync(path.join(linkedObject, 'manifest.json'), 'utf8'));
      const objectPath = path.join(linkedObject, linkedManifest.objects[0].filename);
      const externalObject = path.join(destination, 'external-object.bin');
      fs.copyFileSync(objectPath, externalObject);
      fs.unlinkSync(objectPath);
      fs.symlinkSync(externalObject, objectPath);
      assert.throws(() => verifyPlatformPortableBackup(linkedObject), /not a regular file/);
    }

    const platformFile = path.join(backup.directory, 'platform.json');
    const original = fs.readFileSync(platformFile);
    fs.writeFileSync(platformFile, Buffer.from(original.toString('utf8').replace('owner-1', 'tampered')));
    assert.throws(() => verifyPlatformPortableBackup(backup.directory), /(byte count|SHA-256) does not match/);
    assert.throws(() => readVerifiedPlatformObjects(backup.directory, verified), /(byte count|SHA-256) does not match/);
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
