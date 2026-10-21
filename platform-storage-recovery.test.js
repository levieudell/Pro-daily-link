'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PLATFORM_NAMESPACE_ID, canonicalHash } = require('./database/platform-repository');
const { createPlatformPortableBackup } = require('./database/platform-portable-backup');
const { execute } = require('./database/platform-recovery');

const missing = objectKey => new Error(`Supabase request failed (404): Object not found: ${objectKey}`);
const objectId = (bucket, objectKey) => `${bucket}/${objectKey}`;
const response = (bytes, contentType = 'application/octet-stream') => ({
  arrayBuffer: async () => Buffer.from(bytes),
  headers: { get: name => name.toLowerCase() === 'content-type' ? contentType : null }
});

function memoryStorage(initial = {}) {
  const objects = new Map(Object.entries(initial).map(([key, value]) => [key, Buffer.from(value)]));
  const calls = { download: 0, upload: 0, remove: 0 };
  return {
    objects,
    calls,
    download: async (bucket, objectKey) => {
      calls.download += 1;
      const bytes = objects.get(objectId(bucket, objectKey));
      if (!bytes) throw missing(objectKey);
      return response(bytes, objectKey.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream');
    },
    upload: async (bucket, objectKey, bytes, contentType, upsert) => {
      calls.upload += 1;
      const key = objectId(bucket, objectKey);
      if (objects.has(key) && !upsert) throw new Error('Supabase request failed (409): object already exists');
      objects.set(key, Buffer.from(bytes));
      return { bucket, objectKey, contentType };
    },
    remove: async (bucket, objectKey) => {
      calls.remove += 1;
      objects.delete(objectId(bucket, objectKey));
      return true;
    }
  };
}

function memoryRepository(snapshot, revision = 9) {
  let state = {
    snapshot: structuredClone(snapshot),
    revision,
    contentHash: canonicalHash(snapshot),
    namespaceId: PLATFORM_NAMESPACE_ID
  };
  let saveCalls = 0;
  return {
    get saveCalls() { return saveCalls; },
    load: async () => structuredClone(state),
    save: async (next, { expectedRevision }) => {
      saveCalls += 1;
      assert.equal(expectedRevision, state.revision);
      state = {
        snapshot: structuredClone(next),
        revision: state.revision + 1,
        contentHash: canonicalHash(next),
        namespaceId: PLATFORM_NAMESPACE_ID
      };
      return { ...structuredClone(state), records: 1 };
    }
  };
}

function restoreArgs(backup, preRestoreOutput, revision = 9) {
  const expectedManifestSha256 = fs.readFileSync(path.join(backup, 'manifest.sha256'), 'utf8').trim().split(/\s+/)[0];
  return {
    command: 'restore', output: '', backup, preRestoreOutput,
    apply: true, expectedManifestSha256, expectedRevision: revision
  };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-platform-storage-recovery-'));
  try {
    const bucket = 'platform-assets';
    const heroKey = 'platform/blog/hero.jpg';
    const guideKey = 'platform/guides/launch.pdf';
    const heroId = objectId(bucket, heroKey);
    const guideId = objectId(bucket, guideKey);
    const oldHero = Buffer.from('current-live-hero');
    const targetHero = Buffer.from('restored-hero');
    const targetGuide = Buffer.from('restored-guide');
    const targetSnapshot = {
      users: [{ id: 'owner-1', passwordHash: 'kept' }],
      sessions: [],
      supportGrants: [],
      blogPosts: [{
        id: 'post-1',
        hero: { storageBucket: bucket, storageKey: heroKey },
        guide: { storageBucket: bucket, storageKey: guideKey }
      }]
    };
    const currentSnapshot = {
      users: [{ id: 'owner-1', passwordHash: 'current' }],
      sessions: [],
      supportGrants: [],
      blogPosts: [{
        id: 'post-1',
        hero: { storageBucket: bucket, storageKey: heroKey },
        // This referenced live object is already missing. The rollback backup
        // records that fact without blocking recovery of the known-good copy.
        guide: { storageBucket: bucket, storageKey: guideKey }
      }]
    };
    const sourceBackup = await createPlatformPortableBackup({
      snapshot: targetSnapshot,
      revision: 4,
      destination: path.join(root, 'source'),
      now: new Date('2026-10-20T12:00:00.000Z'),
      download: async (sourceBucket, sourceKey) => {
        assert.equal(sourceBucket, bucket);
        if (sourceKey === heroKey) return response(targetHero, 'image/jpeg');
        if (sourceKey === guideKey) return response(targetGuide, 'application/pdf');
        throw missing(sourceKey);
      }
    });

    // Preview verifies the source set but performs no repository/provider I/O.
    const noWriteCalls = { repo: 0, download: 0, upload: 0, remove: 0 };
    const preview = await execute({
      command: 'restore-preview', output: '', backup: sourceBackup.directory,
      preRestoreOutput: '', apply: false, expectedManifestSha256: sourceBackup.manifestSha256, expectedRevision: null
    }, {
      repo: { load: async () => { noWriteCalls.repo += 1; throw new Error('preview touched repository'); } },
      download: async () => { noWriteCalls.download += 1; throw new Error('preview touched storage'); },
      upload: async () => { noWriteCalls.upload += 1; },
      remove: async () => { noWriteCalls.remove += 1; }
    });
    assert.equal(preview.writesPerformed, false);
    assert.deepEqual(noWriteCalls, { repo: 0, download: 0, upload: 0, remove: 0 });

    // A rollback-evidence set may accurately record live objects as missing,
    // but it cannot be used as a source restore set without those bytes.
    const incompleteBackup = await createPlatformPortableBackup({
      snapshot: targetSnapshot,
      revision: 5,
      destination: path.join(root, 'incomplete-source'),
      allowMissingObjects: true,
      now: new Date('2026-10-20T12:01:00.000Z'),
      download: async (sourceBucket, sourceKey) => {
        assert.equal(sourceBucket, bucket);
        throw missing(sourceKey);
      }
    });
    const incompleteVerification = await execute({
      command: 'verify', output: '', backup: incompleteBackup.directory,
      preRestoreOutput: '', apply: false, expectedRevision: null
    });
    assert.equal(incompleteVerification.verified, true, 'the missing-state evidence manifest is internally valid');
    assert.equal(incompleteVerification.complete, false);
    assert.equal(incompleteVerification.missingObjects, 2);
    await assert.rejects(
      () => execute({
        command: 'restore-preview', output: '', backup: incompleteBackup.directory,
        preRestoreOutput: '', apply: false, expectedManifestSha256: incompleteBackup.manifestSha256, expectedRevision: null
      }),
      /backup is incomplete/
    );

    // A real restore overwrites only an object preserved in the rollback set,
    // creates the missing object, verifies both, commits the database last,
    // and retains a dated evidence record.
    const successStorage = memoryStorage({ [heroId]: oldHero });
    const successRepo = memoryRepository(currentSnapshot);
    const success = await execute(
      restoreArgs(sourceBackup.directory, path.join(root, 'success-rollback')),
      {
        repo: successRepo,
        download: successStorage.download,
        upload: successStorage.upload,
        remove: successStorage.remove,
        now: new Date('2026-10-20T12:30:00.000Z')
      }
    );
    assert.deepEqual(success.storage, { total: 2, created: 1, overwritten: 1, unchanged: 0, verified: 2 });
    assert.deepEqual(successStorage.objects.get(heroId), targetHero);
    assert.deepEqual(successStorage.objects.get(guideId), targetGuide);
    assert.equal(successRepo.saveCalls, 1);
    assert.equal(success.preRestoreBackup.missingObjects, 1, 'rollback evidence records the already-missing live guide');
    assert.ok(fs.existsSync(success.evidenceFile));
    const successEvidence = JSON.parse(fs.readFileSync(success.evidenceFile, 'utf8'));
    assert.equal(successEvidence.status, 'verified');
    assert.equal(successEvidence.storage.verified, 2);

    // An ambiguous upload failure that lands bytes is detected and rolled back;
    // the database is never committed.
    const ambiguousStorage = memoryStorage();
    const normalUpload = ambiguousStorage.upload;
    ambiguousStorage.upload = async (...args) => {
      await normalUpload(...args);
      throw new Error('provider response lost after upload');
    };
    const ambiguousRepo = memoryRepository(currentSnapshot);
    const ambiguousRollbackRoot = path.join(root, 'ambiguous-rollback');
    await assert.rejects(
      () => execute(restoreArgs(sourceBackup.directory, ambiguousRollbackRoot), {
        repo: ambiguousRepo,
        download: ambiguousStorage.download,
        upload: ambiguousStorage.upload,
        remove: ambiguousStorage.remove,
        now: new Date('2026-10-20T12:31:00.000Z')
      }),
      /provider response lost/
    );
    assert.equal(ambiguousRepo.saveCalls, 0);
    assert.equal(ambiguousStorage.objects.size, 0, 'ambiguous destination write is removed during rollback');
    assert.equal(ambiguousStorage.calls.remove, 1);
    const ambiguousEvidenceDir = fs.readdirSync(ambiguousRollbackRoot).map(name => path.join(ambiguousRollbackRoot, name))[0];
    const ambiguousEvidence = JSON.parse(fs.readFileSync(path.join(ambiguousEvidenceDir, 'restore-evidence.json'), 'utf8'));
    assert.equal(ambiguousEvidence.status, 'failed-before-repository-commit');
    assert.equal(ambiguousEvidence.storageRollback.ok, true);

    // Destination verification failure rolls an overwritten object back to
    // the exact bytes captured by the pre-restore backup.
    const corruptStorage = memoryStorage({ [heroId]: oldHero });
    const ordinaryUpload = corruptStorage.upload;
    corruptStorage.upload = async (targetBucket, targetKey, bytes, contentType, upsert) => {
      if (targetKey === heroKey && Buffer.from(bytes).equals(targetHero)) {
        return ordinaryUpload(targetBucket, targetKey, Buffer.from('corrupt-after-upload'), contentType, upsert);
      }
      return ordinaryUpload(targetBucket, targetKey, bytes, contentType, upsert);
    };
    const corruptRepo = memoryRepository(currentSnapshot);
    await assert.rejects(
      () => execute(restoreArgs(sourceBackup.directory, path.join(root, 'corrupt-rollback')), {
        repo: corruptRepo,
        download: corruptStorage.download,
        upload: corruptStorage.upload,
        remove: corruptStorage.remove,
        now: new Date('2026-10-20T12:32:00.000Z')
      }),
      /verification failed/
    );
    assert.equal(corruptRepo.saveCalls, 0);
    assert.deepEqual(corruptStorage.objects.get(heroId), oldHero, 'failed overwrite restores prior verified bytes');
    assert.equal(corruptStorage.objects.has(guideId), false);

    // A repository CAS/write failure happens after storage verification, so
    // both the overwritten and newly created objects must still roll back.
    const rejectedStorage = memoryStorage({ [heroId]: oldHero });
    const rejectedBase = memoryRepository(currentSnapshot);
    const rejectedRepo = {
      get saveCalls() { return rejectedBase.saveCalls; },
      load: rejectedBase.load,
      save: async () => {
        // Count the attempted commit while keeping the original repository state.
        await rejectedBase.save(currentSnapshot, { expectedRevision: 9 });
        throw new Error('PDL_PLATFORM_REVISION_CONFLICT');
      }
    };
    await assert.rejects(
      () => execute(restoreArgs(sourceBackup.directory, path.join(root, 'rejected-rollback')), {
        repo: rejectedRepo,
        download: rejectedStorage.download,
        upload: rejectedStorage.upload,
        remove: rejectedStorage.remove,
        now: new Date('2026-10-20T12:33:00.000Z')
      }),
      /PDL_PLATFORM_REVISION_CONFLICT/
    );
    assert.equal(rejectedRepo.saveCalls, 1);
    assert.deepEqual(rejectedStorage.objects.get(heroId), oldHero, 'CAS failure restores overwritten bytes');
    assert.equal(rejectedStorage.objects.has(guideId), false, 'CAS failure removes newly created bytes');

    // If the provider loses both the save response and all reconciliation
    // reads, the command cannot know whether the CAS committed. It retains the
    // verified target objects, refuses to claim success, and records the state
    // for an operator instead of guessing which side to roll back.
    const unknownStorage = memoryStorage({ [heroId]: oldHero });
    let unknownLoads = 0;
    let unknownSaves = 0;
    const initialUnknownState = {
      snapshot: structuredClone(currentSnapshot), revision: 9,
      contentHash: canonicalHash(currentSnapshot), namespaceId: PLATFORM_NAMESPACE_ID
    };
    const unknownRepo = {
      load: async () => {
        unknownLoads += 1;
        if (unknownLoads === 1) return structuredClone(initialUnknownState);
        throw new Error('repository unavailable during reconciliation');
      },
      save: async () => {
        unknownSaves += 1;
        throw new Error('repository response lost');
      }
    };
    const unknownRollbackRoot = path.join(root, 'unknown-repository-rollback');
    await assert.rejects(
      () => execute(restoreArgs(sourceBackup.directory, unknownRollbackRoot), {
        repo: unknownRepo,
        download: unknownStorage.download,
        upload: unknownStorage.upload,
        remove: unknownStorage.remove,
        now: new Date('2026-10-20T12:33:30.000Z')
      }),
      /rollback was incomplete/
    );
    assert.equal(unknownSaves, 1);
    assert.deepEqual(unknownStorage.objects.get(heroId), targetHero, 'uncertain repository outcome retains verified target storage');
    assert.deepEqual(unknownStorage.objects.get(guideId), targetGuide);
    const unknownEvidenceDir = fs.readdirSync(unknownRollbackRoot).map(name => path.join(unknownRollbackRoot, name))[0];
    const unknownEvidence = JSON.parse(fs.readFileSync(path.join(unknownEvidenceDir, 'restore-evidence.json'), 'utf8'));
    assert.equal(unknownEvidence.status, 'repository-outcome-unknown');
    assert.equal(unknownEvidence.storageRollback.ok, false);

    // Never overwrite an existing destination object unless its exact prior
    // bytes were captured in the verified rollback set.
    const conflictStorage = memoryStorage({ [heroId]: Buffer.from('unreferenced-newer-object') });
    const conflictRepo = memoryRepository({ users: [], sessions: [], supportGrants: [] });
    await assert.rejects(
      () => execute(restoreArgs(sourceBackup.directory, path.join(root, 'conflict-rollback')), {
        repo: conflictRepo,
        download: conflictStorage.download,
        upload: conflictStorage.upload,
        remove: conflictStorage.remove,
        now: new Date('2026-10-20T12:34:00.000Z')
      }),
      /not preserved in the verified pre-restore backup/
    );
    assert.equal(conflictRepo.saveCalls, 0);
    assert.deepEqual(conflictStorage.objects.get(heroId), Buffer.from('unreferenced-newer-object'));
    assert.equal(conflictStorage.calls.upload, 0);

    // A missing or tampered source payload fails local verification before any
    // repository or destination operation can begin.
    for (const [name, mutate, pattern] of [
      ['missing-source', directory => fs.unlinkSync(path.join(directory, sourceBackup.manifest.objects[0].filename)), /ENOENT|no such file/i],
      ['tampered-source', directory => fs.writeFileSync(path.join(directory, sourceBackup.manifest.objects[0].filename), 'tampered'), /(byte count|SHA-256)/i]
    ]) {
      const directory = path.join(root, name);
      fs.cpSync(sourceBackup.directory, directory, { recursive: true });
      mutate(directory);
      const untouchedStorage = memoryStorage();
      const untouchedRepo = memoryRepository(currentSnapshot);
      await assert.rejects(
        () => execute(restoreArgs(directory, path.join(root, `${name}-rollback`)), {
          repo: untouchedRepo,
          download: untouchedStorage.download,
          upload: untouchedStorage.upload,
          remove: untouchedStorage.remove
        }),
        pattern
      );
      assert.equal(untouchedRepo.saveCalls, 0);
      assert.deepEqual(untouchedStorage.calls, { download: 0, upload: 0, remove: 0 });
    }

    console.log('Platform storage recovery passed: no-write preview, object restore, destination verification, rollback, evidence, and corrupt-source refusal.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
