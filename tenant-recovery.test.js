'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canonicalHash } = require('./database/transactional-repository');
const { createPortableBackup } = require('./database/portable-backup');
const { parseArgs, execute, prepareTenantRestore } = require('./database/tenant-recovery');

const companyId = '11111111-1111-4111-8111-111111111111';
const objectId = (bucket, objectKey) => `${bucket}/${objectKey}`;
const missing = objectKey => new Error(`Supabase request failed (404): Object not found: ${objectKey}`);
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
      return response(bytes, objectKey.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
    },
    upload: async (bucket, objectKey, bytes, _contentType, upsert) => {
      calls.upload += 1;
      const key = objectId(bucket, objectKey);
      if (objects.has(key) && !upsert) throw new Error('Supabase request failed (409): object already exists');
      objects.set(key, Buffer.from(bytes));
      return { bucket, objectKey };
    },
    remove: async (bucket, objectKey) => {
      calls.remove += 1;
      objects.delete(objectId(bucket, objectKey));
      return true;
    }
  };
}

function memoryRepository(snapshot, revision = 9) {
  let state = snapshot ? { snapshot: structuredClone(snapshot), revision, contentHash: canonicalHash(snapshot) } : null;
  let saveCalls = 0;
  return {
    get saveCalls() { return saveCalls; },
    load: async id => {
      assert.equal(id, companyId);
      return state ? structuredClone(state) : null;
    },
    save: async (next, { expectedRevision }) => {
      saveCalls += 1;
      const actual = state?.revision || 0;
      assert.equal(expectedRevision, actual);
      state = { snapshot: structuredClone(next), revision: actual + 1, contentHash: canonicalHash(next) };
      return structuredClone(state);
    }
  };
}

function restoreArgs(backup, preRestoreOutput, expectedManifestSha256, expectedRevision = 9) {
  return { command: 'restore', companyId, backup, preRestoreOutput, output: '', apply: true, expectedRevision, expectedManifestSha256 };
}

assert.deepEqual(
  parseArgs(['restore-preview', '--company-id', companyId, '--backup', 'D:\\backups\\one', '--expected-manifest-sha256', 'a'.repeat(64)]),
  { command: 'restore-preview', companyId, output: '', backup: 'D:\\backups\\one', preRestoreOutput: '', apply: false, expectedRevision: null, expectedManifestSha256: 'a'.repeat(64) }
);
assert.throws(() => parseArgs(['restore-preview', '--company-id', companyId, '--backup', 'x']), /expected-manifest-sha256/);
assert.throws(() => parseArgs(['restore', '--company-id', companyId, '--backup', 'x', '--expected-manifest-sha256', 'a'.repeat(64)]), /without --apply/);
assert.throws(() => parseArgs(['restore', '--company-id', companyId, '--backup', 'x', '--expected-manifest-sha256', 'a'.repeat(64), '--apply', '--expected-revision', '2', '--pre-restore-output', 'y']), /confirm-company-id/);
assert.throws(() => parseArgs(['verify', '--company-id', 'legacy-name', '--backup', 'x']), /database UUID/);

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-tenant-recovery-'));
  try {
    const photo = `project-photos/${companyId}/photo.jpg`;
    const estimate = `estimate-documents/${companyId}/estimate.pdf`;
    const proposal = `estimate-documents/${companyId}/proposal.pdf`;
    const targetPhoto = Buffer.from('known-good-photo');
    const targetEstimate = Buffer.from('known-good-estimate');
    const targetProposal = Buffer.from('known-good-proposal');
    const target = {
      company: { id: companyId, name: 'Recovery Builders', pendingCheckout: { id: 'old-checkout' } },
      users: [{ id: 1, passwordHash: 'keep-password', resetTokenHash: 'reset', setupHash: 'setup', emailVerificationTokenHash: 'verify' }],
      sessions: [{ id: 'old-session', tokenHash: 'session' }],
      projects: [{ id: 5, name: 'Project', estimateProposals: [{ id: 7, sourceFile: { storageBucket: 'estimate-documents', storageKey: `${companyId}/proposal.pdf` } }] }],
      photos: [{ id: 1, project: 0, storageBucket: 'project-photos', storageKey: `${companyId}/photo.jpg` }],
      estimateImports: [{ id: 2, projectId: 5, storageBucket: 'estimate-documents', storageKey: `${companyId}/estimate.pdf` }],
      subcontractorLinks: [{ id: 3, status: 'Active', tokenHash: 'guest' }],
      changes: [{ id: 4, customerTokenHash: 'customer-link', customerLinkExpiresAt: '2030-01-01T00:00:00.000Z' }]
    };
    const sourceBytes = new Map([
      [photo, targetPhoto], [estimate, targetEstimate], [proposal, targetProposal]
    ]);
    const source = await createPortableBackup({
      snapshot: target,
      destination: path.join(root, 'source'),
      now: new Date('2026-10-20T12:00:00.000Z'),
      authority: { mode: 'transactional-primary', repositoryRevision: 4, contentHash: canonicalHash(target) },
      download: async (bucket, objectKey) => response(sourceBytes.get(objectId(bucket, objectKey)), objectKey.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg')
    });
    const nonAuthoritative = await createPortableBackup({
      snapshot: target,
      destination: path.join(root, 'non-authoritative'),
      now: new Date('2026-10-20T12:00:00.000Z'),
      download: async (bucket, objectKey) => response(sourceBytes.get(objectId(bucket, objectKey)), objectKey.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg')
    });
    await assert.rejects(
      () => execute({ command: 'restore-preview', companyId, backup: nonAuthoritative.directory, output: '', preRestoreOutput: '', apply: false, expectedRevision: null, expectedManifestSha256: nonAuthoritative.manifestSha256 }),
      /not an authoritative transactional-primary export/
    );

    const previewCalls = { repo: 0, download: 0, upload: 0, remove: 0 };
    const preview = await execute({ command: 'restore-preview', companyId, backup: source.directory, output: '', preRestoreOutput: '', apply: false, expectedRevision: null, expectedManifestSha256: source.manifestSha256 }, {
      repo: { load: async () => { previewCalls.repo += 1; } },
      download: async () => { previewCalls.download += 1; },
      upload: async () => { previewCalls.upload += 1; },
      remove: async () => { previewCalls.remove += 1; }
    });
    assert.equal(preview.writesPerformed, false);
    assert.equal(preview.complete, true);
    assert.deepEqual(previewCalls, { repo: 0, download: 0, upload: 0, remove: 0 });
    await assert.rejects(
      () => execute({ command: 'restore-preview', companyId, backup: source.directory, output: '', preRestoreOutput: '', apply: false, expectedRevision: null, expectedManifestSha256: 'b'.repeat(64) }),
      /independently recorded SHA-256/
    );
    await assert.rejects(
      () => execute({ ...preview, command: 'verify', companyId: '22222222-2222-4222-8222-222222222222', backup: source.directory }),
      /company does not match/
    );

    const current = {
      company: { id: companyId, name: 'Current Builders' },
      users: [], sessions: [], projects: [], reports: [],
      photos: [{ id: 1, project: 0, storageBucket: 'project-photos', storageKey: `${companyId}/photo.jpg` }]
    };
    const oldPhoto = Buffer.from('current-photo');
    const storage = memoryStorage({ [photo]: oldPhoto });
    const repo = memoryRepository(current);
    const restored = await execute(restoreArgs(source.directory, path.join(root, 'rollback'), source.manifestSha256), {
      repo, download: storage.download, upload: storage.upload, remove: storage.remove,
      now: new Date('2026-10-20T12:30:00.000Z')
    });
    assert.equal(restored.revision, 10);
    assert.deepEqual(restored.storage, { total: 3, created: 2, overwritten: 1, unchanged: 0, verified: 3 });
    assert.deepEqual(storage.objects.get(photo), targetPhoto);
    assert.deepEqual(storage.objects.get(estimate), targetEstimate);
    assert.deepEqual(storage.objects.get(proposal), targetProposal);
    assert.ok(fs.existsSync(restored.evidenceFile));
    const restoredState = await repo.load(companyId);
    assert.equal(restoredState.snapshot.users[0].passwordHash, 'keep-password');
    assert.equal(restoredState.snapshot.users[0].resetTokenHash, undefined);
    assert.equal(restoredState.snapshot.sessions.length, 0);
    assert.equal(restoredState.snapshot.subcontractorLinks[0].status, 'Revoked');
    assert.equal(restoredState.snapshot.subcontractorLinks[0].tokenHash, undefined);
    assert.equal(restoredState.snapshot.changes[0].customerTokenHash, undefined);
    assert.equal(restoredState.snapshot.company.pendingCheckout, undefined);

    const replay = await execute(restoreArgs(source.directory, path.join(root, 'replay-rollback'), source.manifestSha256, 10), {
      repo, download: storage.download, upload: storage.upload, remove: storage.remove,
      now: new Date('2026-10-20T12:40:00.000Z')
    });
    assert.equal(replay.alreadyRestored, true);
    assert.equal(replay.revision, 10);
    assert.equal(repo.saveCalls, 1, 'rehearsing the same verified restore is idempotent');
    assert.equal(replay.storage.unchanged, 3);

    const failingStorage = memoryStorage({ [photo]: oldPhoto });
    const failingRepo = memoryRepository(current);
    failingRepo.save = async () => { throw new Error('PDL_REVISION_CONFLICT'); };
    await assert.rejects(
      () => execute(restoreArgs(source.directory, path.join(root, 'failed-rollback'), source.manifestSha256), {
        repo: failingRepo,
        download: failingStorage.download,
        upload: failingStorage.upload,
        remove: failingStorage.remove,
        now: new Date('2026-10-20T12:50:00.000Z')
      }),
      /PDL_REVISION_CONFLICT/
    );
    assert.deepEqual(failingStorage.objects.get(photo), oldPhoto, 'failed CAS restores overwritten bytes');
    assert.equal(failingStorage.objects.has(estimate), false, 'failed CAS removes newly created estimate');
    assert.equal(failingStorage.objects.has(proposal), false, 'failed CAS removes newly created proposal');

    const tampered = path.join(root, 'tampered');
    fs.cpSync(source.directory, tampered, { recursive: true });
    fs.writeFileSync(path.join(tampered, source.manifest.objects[0].filename), 'tampered');
    const untouched = memoryStorage();
    await assert.rejects(
      () => execute({ command: 'restore-preview', companyId, backup: tampered, output: '', preRestoreOutput: '', apply: false, expectedRevision: null, expectedManifestSha256: source.manifestSha256 }, {
        download: untouched.download, upload: untouched.upload, remove: untouched.remove
      }),
      /(byte count|SHA-256)/i
    );
    assert.deepEqual(untouched.calls, { download: 0, upload: 0, remove: 0 });

    const deterministic = prepareTenantRestore(target, '2026-10-20T12:00:00.000Z');
    assert.equal(canonicalHash(deterministic), canonicalHash(prepareTenantRestore(target, '2026-10-20T12:00:00.000Z')));
    console.log('Tenant recovery passed: no-write preview, tenant/authority checks, private object restore, CAS rollback, secure credential revocation, idempotent replay, and tamper refusal.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
