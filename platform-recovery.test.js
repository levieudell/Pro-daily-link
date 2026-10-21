'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PLATFORM_NAMESPACE_ID, canonicalHash } = require('./database/platform-repository');
const { createPlatformPortableBackup, validatePlatformRestoreSnapshot } = require('./database/platform-portable-backup');
const {
  parseArgs,
  execute,
  preparePlatformRestore,
  sanitizedCliResult,
  sanitizedCliFailure
} = require('./database/platform-recovery');

const verifiedFence = Object.freeze({
  active: true,
  enforced: true,
  environmentEnabled: true,
  verified: true,
  mode: 'read_only',
  source: 'environment_and_lock',
  digest: 'c'.repeat(64),
  openedAt: '2026-10-20T12:00:00.000Z',
  reason: null,
  identity: { provider: 'local', serviceId: null, instanceId: null, releaseSha: 'local' }
});
const stableFenceApi = { requireVerifiedFence: () => structuredClone(verifiedFence) };
const disposableProjectRef = 't'.repeat(20);
const protectedProductionProjectRef = 'q'.repeat(20);
const disposableEnv = Object.freeze({
  NODE_ENV: 'test',
  RENDER: 'false',
  PDL_SUPABASE_ENABLED: '1',
  SUPABASE_URL: `https://${disposableProjectRef}.supabase.co`,
  PDL_DISPOSABLE_SUPABASE_PROJECT_REF: disposableProjectRef,
  PDL_PRODUCTION_SUPABASE_PROJECT_REF: protectedProductionProjectRef
});
const productionProjectRef = 'p'.repeat(20);
const productionServiceId = `srv-${'a'.repeat(20)}`;
const productionInstanceId = 'instance-123';
const productionEnv = Object.freeze({
  NODE_ENV: 'production',
  RENDER: 'true',
  RENDER_SERVICE_TYPE: 'web',
  IS_PULL_REQUEST: 'false',
  RENDER_SERVICE_ID: productionServiceId,
  RENDER_INSTANCE_ID: productionInstanceId,
  RENDER_GIT_COMMIT: 'a'.repeat(40),
  PDL_SUPABASE_ENABLED: '1',
  SUPABASE_URL: `https://${productionProjectRef}.supabase.co`,
  PDL_PRODUCTION_SUPABASE_PROJECT_REF: productionProjectRef
});
const productionFence = Object.freeze({
  ...verifiedFence,
  digest: 'f'.repeat(64),
  identity: {
    provider: 'render',
    serviceId: productionServiceId,
    instanceId: productionInstanceId,
    releaseSha: productionEnv.RENDER_GIT_COMMIT
  }
});
const changedFence = Object.freeze({ ...verifiedFence, digest: 'd'.repeat(64), openedAt: '2026-10-20T12:01:00.000Z' });
function sequenceFenceApi(states) {
  let calls = 0;
  return { get calls() { return calls; }, requireVerifiedFence() { return structuredClone(states[Math.min(calls++, states.length - 1)]); } };
}
const objectId = (bucket, objectKey) => `${bucket}/${objectKey}`;
const storageResponse = (bytes, contentType = 'application/octet-stream') => ({ arrayBuffer: async () => Buffer.from(bytes), headers: { get: () => contentType } });
const storageMissing = objectKey => Object.assign(new Error(`Object not found: ${objectKey}`), { statusCode: 404 });
function memoryStorage(initial = {}) {
  const objects = new Map(Object.entries(initial).map(([key, value]) => [key, Buffer.from(value)]));
  const calls = { download: 0, upload: 0, remove: 0 };
  return {
    objects, calls,
    async download(bucket, objectKey) {
      calls.download += 1;
      const bytes = objects.get(objectId(bucket, objectKey));
      if (!bytes) throw storageMissing(objectKey);
      return storageResponse(bytes);
    },
    async upload(bucket, objectKey, bytes, _contentType, upsert) {
      calls.upload += 1;
      const key = objectId(bucket, objectKey);
      if (objects.has(key) && !upsert) throw Object.assign(new Error('object already exists'), { statusCode: 409 });
      objects.set(key, Buffer.from(bytes));
    },
    async remove(bucket, objectKey) {
      calls.remove += 1;
      objects.delete(objectId(bucket, objectKey));
    }
  };
}

assert.deepEqual(parseArgs(['export', '--output', 'D:\\backups', '--disposable-target', disposableProjectRef]), {
  command: 'export', output: 'D:\\backups', backup: '', preRestoreOutput: '', apply: false,
  expectedManifestSha256: '', expectedCurrentContentHash: '', expectedRevision: null, expectedServiceId: '', expectedInstanceId: '',
  productionTarget: '', disposableTarget: disposableProjectRef
});
assert.equal(parseArgs(['verify', '--backup', 'D:\\backup-1']).command, 'verify');
assert.equal(parseArgs(['restore-preview', '--backup', 'D:\\backup-1', '--expected-manifest-sha256', 'a'.repeat(64)]).command, 'restore-preview');
assert.deepEqual(parseArgs(['restore', '--backup', 'D:\\backup-1', '--expected-revision', '9', '--expected-manifest-sha256', 'a'.repeat(64), '--expected-current-content-hash', 'b'.repeat(64), '--pre-restore-output', 'D:\\rollback', '--apply', '--disposable-target', disposableProjectRef]), {
  command: 'restore', output: '', backup: 'D:\\backup-1', preRestoreOutput: 'D:\\rollback', apply: true,
  expectedManifestSha256: 'a'.repeat(64), expectedCurrentContentHash: 'b'.repeat(64), expectedRevision: 9, expectedServiceId: '', expectedInstanceId: '',
  productionTarget: '', disposableTarget: disposableProjectRef
});
assert.equal(parseArgs([
  'restore', '--backup', 'D:\\backup-1', '--expected-revision', '9',
  '--expected-manifest-sha256', 'a'.repeat(64), '--expected-current-content-hash', 'b'.repeat(64), '--pre-restore-output', 'D:\\rollback', '--apply',
  '--expected-service-id', `srv-${'a'.repeat(20)}`, '--expected-instance-id', 'instance-123',
  '--production-target', 'p'.repeat(20)
]).expectedInstanceId, 'instance-123');
assert.throws(() => parseArgs(['restore', '--backup', 'D:\\backup-1', '--expected-revision', '9']), /Refusing a restore/);
assert.throws(() => parseArgs(['restore', '--backup', 'D:\\backup-1', '--apply']), /expected-revision/);
assert.throws(() => parseArgs(['restore', '--backup', 'D:\\backup-1', '--expected-revision', '9', '--apply']), /pre-restore-output/);
assert.throws(() => parseArgs([
  'restore', '--backup', 'D:\\backup-1', '--expected-revision', '9',
  '--expected-manifest-sha256', 'a'.repeat(64), '--pre-restore-output', 'D:\\rollback', '--apply',
  '--disposable-target', disposableProjectRef
]), /expected-current-content-hash/);
assert.throws(() => parseArgs(['restore-preview', '--backup', 'D:\\backup-1']), /expected-manifest-sha256/);
assert.throws(() => parseArgs(['export']), /independent-directory/);
assert.throws(() => parseArgs(['verify', '--backup', 'D:\\backup-1', '--backup', 'D:\\backup-2']), /only be provided once/);
assert.throws(() => parseArgs(['verify', '--backup', 'D:\\backup-1', '--unsafe']), /Unsupported platform recovery argument/);
assert.throws(() => parseArgs([
  'restore', '--backup', 'D:\\backup-1', '--expected-revision', '9',
  '--expected-manifest-sha256', 'a'.repeat(64), '--expected-current-content-hash', 'b'.repeat(64), '--pre-restore-output', 'D:\\rollback', '--apply',
  '--production-target', 'p'.repeat(20), '--expected-service-id', `srv-${'a'.repeat(20)}`
]), /provided together/);
assert.throws(
  () => parseArgs(['export', '--output', 'D:\\backups']),
  /exactly one of --production-target.*--disposable-target/
);

const privatePath = 'C:\\Users\\private-person\\Backups\\platform-secret';
const safeFailure = sanitizedCliFailure(new Error(`provider rejected platform/private-person@example.test at ${privatePath}`));
assert.equal(safeFailure.ok, false);
assert.doesNotMatch(JSON.stringify(safeFailure), /private-person|example\.test|Backups/i);
assert.equal(sanitizedCliFailure(new Error('MAINTENANCE_FENCE_CHANGED')).code, 'PDL_PLATFORM_RECOVERY_FENCE');
assert.equal(
  sanitizedCliFailure(new Error('Platform restore failed and storage rollback was incomplete: rollback conflict')).code,
  'PDL_PLATFORM_RECOVERY_ROLLBACK_CONFLICT'
);
const platformPostCommitFailure = Object.assign(new Error('do not expose provider detail'), { code: 'PDL_PLATFORM_RECOVERY_POST_COMMIT_RECONCILIATION_REQUIRED' });
assert.deepEqual(sanitizedCliFailure(platformPostCommitFailure), {
  ok: false,
  code: 'PDL_PLATFORM_RECOVERY_POST_COMMIT_RECONCILIATION_REQUIRED',
  message: 'Platform recovery committed repository state, but final verification did not complete. Do not retry automatically; use the retained evidence for manual reconciliation.'
});
const safeExport = sanitizedCliResult({
  mode: 'export', directory: path.join(privatePath, 'platform-set-1'), revision: 4,
  contentHash: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), objects: 2, verified: true,
  namespaceId: PLATFORM_NAMESPACE_ID, snapshot: { passwordHash: 'never-print-this' }
});
assert.equal(safeExport.backupSet, 'platform-set-1');
assert.doesNotMatch(JSON.stringify(safeExport), /private-person|never-print-this|namespaceId/i);

const platformIdentityRestoreTime = '2026-10-20T12:29:00.000Z';
const platformIdentitySource = {
  users: [
    { id: 'owner-1', email: 'owner@example.test', role: 'platform_owner', status: 'Active', passwordHash: 'old-password', passwordSalt: 'old-salt', resetTokenHash: 'old-reset' },
    { id: 'former-owner', email: 'former@example.test', role: 'platform_owner', status: 'Active', passwordHash: 'former-password', setupHash: 'former-setup' },
    { id: 'old-sales-id', email: 'sales@example.test', role: 'platform_owner', status: 'Active', passwordHash: 'old-sales-password' }
  ],
  sessions: [{ userId: 'owner-1', tokenHash: 'old-session' }],
  supportGrants: [{ id: 'old-grant', status: 'Active', tokenHash: 'old-support-token' }]
};
const platformIdentityCurrent = {
  users: [
    { id: 'owner-1', email: 'owner@example.test', role: 'support', status: 'Inactive', passwordHash: 'rotated-password', passwordSalt: 'rotated-salt', resetTokenHash: 'current-reset' },
    { id: 'sales-new-id', email: 'SALES@example.test', role: 'sales', status: 'Active', passwordHash: 'current-sales-password', passwordSalt: 'current-sales-salt' },
    { id: 'current-owner', email: 'current@example.test', role: 'platform_owner', status: 'Active', passwordHash: 'current-owner-password', passwordSalt: 'current-owner-salt' }
  ],
  sessions: [{ userId: 'current-owner', tokenHash: 'current-session' }]
};
const platformIdentityRestored = preparePlatformRestore(platformIdentitySource, platformIdentityCurrent, platformIdentityRestoreTime);
assert.deepEqual(platformIdentityRestored.sessions, []);
assert.equal(platformIdentityRestored.users[0].passwordHash, 'rotated-password');
assert.equal(platformIdentityRestored.users[0].role, 'support');
assert.equal(platformIdentityRestored.users[0].status, 'Inactive');
assert.equal('resetTokenHash' in platformIdentityRestored.users[0], false);
assert.equal(platformIdentityRestored.users[1].status, 'Inactive', 'a former backup owner is restored without access');
assert.equal(platformIdentityRestored.users[1].recoveryAccessState, 'reenrollment-required');
assert.equal('passwordHash' in platformIdentityRestored.users[1], false);
assert.equal(platformIdentityRestored.users[2].id, 'sales-new-id');
assert.equal(platformIdentityRestored.users[2].role, 'sales');
assert.equal(platformIdentityRestored.users[3].id, 'current-owner', 'current-only platform owners remain available');
assert.equal(platformIdentityRestored.supportGrants[0].status, 'Revoked');
assert.equal('tokenHash' in platformIdentityRestored.supportGrants[0], false);
assert.throws(() => preparePlatformRestore(
  { users: [{ id: 'one', email: 'one@example.test' }] },
  { users: [{ id: 'one', email: 'first@example.test' }, { id: 'two', email: 'one@example.test' }] },
  platformIdentityRestoreTime
), /PLATFORM_RECOVERY_IDENTITY_AMBIGUOUS/);

const legacyPlatformSource = {
  users: [
    { id: 'backup-owner', email: 'backup-owner@example.test', role: 'platform_owner', status: 'Active', passwordHash: 'stale-owner' },
    { id: 'legacy-root', email: 'legacy-root@example.test', role: 'root', status: 'Active', passwordHash: 'stale-root', apiToken: 'stale-token' },
    { id: 'legacy-import', email: 'legacy-import@example.test', role: 'unknown', status: 'Quarantined', credentialBlob: 'stale-credential' }
  ],
  sessions: [{ userId: 'legacy-root', tokenHash: 'stale-session' }]
};
const legacyPlatformCurrent = {
  users: [{ id: 'current-owner', email: 'current-owner@example.test', role: 'platform_owner', status: 'Active', passwordHash: 'current-hash', passwordSalt: 'current-salt' }]
};
const safeLegacyPlatformRestore = preparePlatformRestore(legacyPlatformSource, legacyPlatformCurrent, platformIdentityRestoreTime);
for (const historicalId of ['backup-owner', 'legacy-root', 'legacy-import']) {
  const historical = safeLegacyPlatformRestore.users.find(user => user.id === historicalId);
  assert.equal(historical.status, 'Inactive', `${historicalId} backup-only platform identity stays historical`);
  assert.equal(historical.mustSetPassword, true);
  assert.equal(historical.recoveryAccessState, 'reenrollment-required');
  assert.equal(Object.keys(historical).filter(key => key !== 'mustSetPassword').some(key => /password|credential|token|session/i.test(key)), false, `${historicalId} has no usable credential`);
}
assert.doesNotThrow(() => validatePlatformRestoreSnapshot(safeLegacyPlatformRestore));
const matchedLegacyPlatformRestore = preparePlatformRestore(legacyPlatformSource, {
  users: [
    legacyPlatformCurrent.users[0],
    { id: 'legacy-root', email: 'legacy-root@example.test', role: 'sales', status: 'Active', passwordHash: 'rotated-current', passwordSalt: 'rotated-salt', resetTokenHash: 'one-time-reset', territory: 'West' }
  ]
}, platformIdentityRestoreTime);
const matchedLegacyPlatform = matchedLegacyPlatformRestore.users.find(user => user.id === 'legacy-root');
assert.equal(matchedLegacyPlatform.role, 'sales', 'a current supported platform role replaces a matching legacy role');
assert.equal(matchedLegacyPlatform.status, 'Active');
assert.equal(matchedLegacyPlatform.passwordHash, 'rotated-current');
assert.equal(matchedLegacyPlatform.territory, 'West');
assert.equal('resetTokenHash' in matchedLegacyPlatform, false);
assert.doesNotThrow(() => validatePlatformRestoreSnapshot(matchedLegacyPlatformRestore));
const unsafeActivePlatformRestore = preparePlatformRestore(legacyPlatformSource, {
  users: [
    legacyPlatformCurrent.users[0],
    { id: 'legacy-root', email: 'legacy-root@example.test', role: 'root', status: 'Active', passwordHash: 'current-root', passwordSalt: 'current-root-salt' }
  ]
}, platformIdentityRestoreTime);
assert.throws(
  () => validatePlatformRestoreSnapshot(unsafeActivePlatformRestore),
  /unsupported role/,
  'an unknown platform role cannot become active through identity merge'
);

(async () => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-platform-recovery-test-'));
  try {
    const restoredSnapshot = {
      users: [{ id: 'owner-1', email: 'recovery-owner@example.test', role: 'platform_owner', status: 'Active', passwordHash: 'hash', resetTokenHash: 'old-reset', setupHash: 'old-setup' }],
      sessions: [{ tokenHash: 'old-session' }],
      supportGrants: [{ id: 'grant-1', status: 'Active', tokenHash: 'old-grant' }],
      settings: { support: true }
    };
    const backup = await createPlatformPortableBackup({
      snapshot: restoredSnapshot,
      revision: 4,
      destination,
      now: new Date('2026-10-20T12:30:00.000Z')
    });
    const uninitializedOutput = path.join(destination, 'uninitialized-target');
    let uninitializedStorageIo = 0;
    await assert.rejects(() => execute({
      command: 'restore', output: '', backup: backup.directory, preRestoreOutput: uninitializedOutput,
      apply: true, expectedManifestSha256: backup.manifestSha256, expectedRevision: 0,
      disposableTarget: disposableProjectRef
    }, {
      repo: { load: async () => null },
      download: async () => { uninitializedStorageIo += 1; throw new Error('unexpected download'); },
      upload: async () => { uninitializedStorageIo += 1; },
      remove: async () => { uninitializedStorageIo += 1; },
      fenceApi: stableFenceApi,
      env: disposableEnv
    }), /PLATFORM_RECOVERY_TARGET_OWNER_REQUIRED/);
    assert.equal(fs.existsSync(uninitializedOutput), false, 'an unseeded platform target fails before creating rollback evidence');
    assert.equal(uninitializedStorageIo, 0, 'an unseeded platform target performs no Storage I/O');
    const unusableOwnerSnapshot = {
      users: [{ id: 'break-glass', email: 'break-glass@example.test', role: 'platform_owner', status: 'Active', mustSetPassword: true }]
    };
    const unusableOwnerState = {
      snapshot: unusableOwnerSnapshot, revision: 0, contentHash: canonicalHash(unusableOwnerSnapshot), namespaceId: PLATFORM_NAMESPACE_ID
    };
    const unusableOwnerOutput = path.join(destination, 'unusable-owner-target');
    await assert.rejects(() => execute({
      command: 'restore', output: '', backup: backup.directory, preRestoreOutput: unusableOwnerOutput,
      apply: true, expectedManifestSha256: backup.manifestSha256, expectedRevision: 0,
      disposableTarget: disposableProjectRef
    }, {
      repo: { load: async () => structuredClone(unusableOwnerState) },
      download: async () => { uninitializedStorageIo += 1; throw new Error('unexpected download'); },
      upload: async () => { uninitializedStorageIo += 1; }, remove: async () => { uninitializedStorageIo += 1; },
      fenceApi: stableFenceApi, env: disposableEnv
    }), /PLATFORM_RECOVERY_TARGET_OWNER_REQUIRED.*permanent credential/);
    assert.equal(fs.existsSync(unusableOwnerOutput), false, 'a pending-setup platform owner is not accepted as the break-glass identity');
    assert.equal(uninitializedStorageIo, 0);

    let overlappingPathIo = 0;
    const overlappingChild = path.join(backup.directory, 'must-not-be-created');
    await assert.rejects(
      () => execute({
        command: 'restore', output: '', backup: backup.directory,
        preRestoreOutput: overlappingChild, apply: true,
        expectedManifestSha256: backup.manifestSha256, expectedRevision: 0,
        disposableTarget: disposableProjectRef
      }, {
        repo: { load: async () => { overlappingPathIo += 1; return null; } },
        download: async () => { overlappingPathIo += 1; throw new Error('unexpected download'); },
        fenceApi: { requireVerifiedFence: () => { overlappingPathIo += 1; return verifiedFence; } },
        env: disposableEnv
      }),
      /separate, non-overlapping directories/
    );
    assert.equal(overlappingPathIo, 0, 'overlapping paths fail before fence, repository, or storage I/O');
    assert.equal(fs.existsSync(overlappingChild), false, 'overlap rejection does not create the evidence directory');
    await assert.rejects(
      () => execute({
        command: 'restore', output: '', backup: backup.directory,
        preRestoreOutput: backup.directory, apply: true,
        expectedManifestSha256: backup.manifestSha256, expectedRevision: 0,
        disposableTarget: disposableProjectRef
      }, { env: disposableEnv }),
      /separate, non-overlapping directories/
    );
    await assert.rejects(
      () => execute({
        command: 'restore', output: '', backup: backup.directory,
        preRestoreOutput: path.dirname(backup.directory), apply: true,
        expectedManifestSha256: backup.manifestSha256, expectedRevision: 0,
        disposableTarget: disposableProjectRef
      }, { env: disposableEnv }),
      /separate, non-overlapping directories/
    );

    const aliasedBackupRoot = path.join(destination, 'backup-root-alias');
    let aliasCreated = false;
    try {
      fs.symlinkSync(backup.directory, aliasedBackupRoot, process.platform === 'win32' ? 'junction' : 'dir');
      aliasCreated = true;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOSYS', 'UNKNOWN'].includes(error.code)) throw error;
    }
    if (aliasCreated) {
      let aliasedPathIo = 0;
      const aliasedChild = path.join(aliasedBackupRoot, 'must-not-be-created-through-alias');
      await assert.rejects(
        () => execute({
          command: 'restore', output: '', backup: backup.directory,
          preRestoreOutput: aliasedChild, apply: true,
          expectedManifestSha256: backup.manifestSha256, expectedRevision: 0,
          disposableTarget: disposableProjectRef
        }, {
          repo: { load: async () => { aliasedPathIo += 1; return null; } },
          download: async () => { aliasedPathIo += 1; throw new Error('unexpected download'); },
          fenceApi: { requireVerifiedFence: () => { aliasedPathIo += 1; return verifiedFence; } },
          env: disposableEnv
        }),
        /separate, non-overlapping directories/
      );
      assert.equal(aliasedPathIo, 0, 'aliased overlap fails before fence, repository, or storage I/O');
      assert.equal(fs.existsSync(aliasedChild), false, 'alias rejection does not create the evidence directory');
    }

    const preview = await execute({ command: 'restore-preview', output: '', backup: backup.directory, preRestoreOutput: '', apply: false, expectedManifestSha256: backup.manifestSha256, expectedRevision: null });
    assert.equal(preview.verified, true);
    assert.equal(preview.sourceRevision, 4);
    assert.equal(preview.createdAt, '2026-10-20T12:30:00.000Z');

    const healthyExportState = {
      snapshot: restoredSnapshot,
      revision: 4,
      contentHash: canonicalHash(restoredSnapshot),
      namespaceId: PLATFORM_NAMESPACE_ID
    };
    const exportRoot = path.join(destination, 'export-root');
    const exported = await execute({
      command: 'export', output: exportRoot, backup: '', preRestoreOutput: '', apply: false,
      expectedManifestSha256: '', expectedRevision: null, disposableTarget: disposableProjectRef
    }, {
      repo: { load: async () => structuredClone(healthyExportState) },
      env: disposableEnv,
      now: new Date('2026-10-20T12:30:30.000Z')
    });
    assert.equal(exported.verified, true);
    assert.equal(exported.contentHash, healthyExportState.contentHash);

    let productionFenceChecks = 0;
    const productionExportRoot = path.join(destination, 'production-export');
    const productionExport = await execute({
      command: 'export', output: productionExportRoot, backup: '',
      preRestoreOutput: '', apply: false, expectedManifestSha256: '', expectedRevision: null,
      productionTarget: productionProjectRef,
      expectedServiceId: productionServiceId,
      expectedInstanceId: productionInstanceId
    }, {
      repo: { load: async () => structuredClone(healthyExportState) },
      env: productionEnv,
      fenceApi: {
        requireVerifiedFence: () => {
          productionFenceChecks += 1;
          if (productionFenceChecks === 2) {
            const staged = fs.readdirSync(productionExportRoot);
            assert.equal(staged.length, 1);
            assert.equal(
              fs.existsSync(path.join(productionExportRoot, staged[0], 'manifest.sha256')),
              false,
              'the authoritative set is not marked complete before the final fence check'
            );
          }
          return structuredClone(productionFence);
        }
      },
      now: new Date('2026-10-20T12:30:31.000Z')
    });
    assert.equal(productionExport.verified, true);
    assert.equal(productionExport.targetMode, 'production');
    assert.equal(productionExport.maintenanceFenceDigest, productionFence.digest);
    assert.equal(productionFenceChecks, 3, 'production export is fenced before capture, before completion, and after the completion marker');
    assert.equal(fs.existsSync(path.join(productionExport.directory, 'manifest.sha256')), true);
    const productionCli = sanitizedCliResult(productionExport);
    assert.equal(productionCli.targetMode, 'production');
    assert.equal(productionCli.maintenanceFenceDigest, productionFence.digest);

    let unstableLoads = 0;
    await assert.rejects(
      () => execute({
        command: 'export', output: path.join(destination, 'unstable-production-export'), backup: '',
        preRestoreOutput: '', apply: false, expectedManifestSha256: '', expectedRevision: null,
        productionTarget: productionProjectRef,
        expectedServiceId: productionServiceId,
        expectedInstanceId: productionInstanceId
      }, {
        repo: {
          load: async () => {
            unstableLoads += 1;
            return unstableLoads === 1
              ? structuredClone(healthyExportState)
              : { ...structuredClone(healthyExportState), revision: 5 };
          }
        },
        env: productionEnv,
        fenceApi: { requireVerifiedFence: () => structuredClone(productionFence) },
        now: new Date('2026-10-20T12:30:32.000Z')
      }),
      /source changed during capture/
    );

    let changedFenceChecks = 0;
    const changedFenceOutput = path.join(destination, 'changed-fence-production-export');
    await assert.rejects(
      () => execute({
        command: 'export', output: changedFenceOutput, backup: '',
        preRestoreOutput: '', apply: false, expectedManifestSha256: '', expectedRevision: null,
        productionTarget: productionProjectRef,
        expectedServiceId: productionServiceId,
        expectedInstanceId: productionInstanceId
      }, {
        repo: { load: async () => structuredClone(healthyExportState) },
        env: productionEnv,
        fenceApi: {
          requireVerifiedFence: () => {
            changedFenceChecks += 1;
            return changedFenceChecks === 1
              ? structuredClone(productionFence)
              : { ...structuredClone(productionFence), digest: '9'.repeat(64) };
          }
        },
        now: new Date('2026-10-20T12:30:33.000Z')
      }),
      /MAINTENANCE_FENCE_CHANGED/
    );
    assert.equal(changedFenceChecks, 2);
    assert.deepEqual(fs.readdirSync(changedFenceOutput), [], 'a failed authoritative export leaves no accepted-looking recovery set');
    let finalFenceChecks = 0;
    const finalFenceOutput = path.join(destination, 'final-fence-production-export');
    await assert.rejects(
      () => execute({
        command: 'export', output: finalFenceOutput, backup: '',
        preRestoreOutput: '', apply: false, expectedManifestSha256: '', expectedRevision: null,
        productionTarget: productionProjectRef,
        expectedServiceId: productionServiceId,
        expectedInstanceId: productionInstanceId
      }, {
        repo: { load: async () => structuredClone(healthyExportState) },
        env: productionEnv,
        fenceApi: {
          requireVerifiedFence: () => {
            finalFenceChecks += 1;
            return finalFenceChecks < 3
              ? structuredClone(productionFence)
              : { ...structuredClone(productionFence), digest: '8'.repeat(64) };
          }
        },
        now: new Date('2026-10-20T12:30:34.000Z')
      }),
      /MAINTENANCE_FENCE_CHANGED/
    );
    assert.equal(finalFenceChecks, 3);
    assert.deepEqual(fs.readdirSync(finalFenceOutput), [], 'a fence change after the completion marker invalidates the generated set');
    await assert.rejects(
      () => execute({ command: 'export', output: path.join(destination, 'wrong-namespace'), backup: '', preRestoreOutput: '', apply: false, expectedManifestSha256: '', expectedRevision: null, disposableTarget: disposableProjectRef }, {
        repo: { load: async () => ({ ...healthyExportState, namespaceId: '11111111-1111-4111-8111-111111111111' }) },
        env: disposableEnv
      }),
      /namespace does not match/
    );
    await assert.rejects(
      () => execute({ command: 'export', output: path.join(destination, 'wrong-hash'), backup: '', preRestoreOutput: '', apply: false, expectedManifestSha256: '', expectedRevision: null, disposableTarget: disposableProjectRef }, {
        repo: { load: async () => ({ ...healthyExportState, contentHash: 'f'.repeat(64) }) },
        env: disposableEnv
      }),
      /content hash does not match/
    );

    const livePlatformSnapshot = { users: [{ id: 'owner-1', email: 'recovery-owner@example.test', role: 'platform_owner', status: 'Active', passwordHash: 'current-hash', passwordSalt: 'current-salt' }], sessions: [{ userId: 'owner-1', tokenHash: 'current-session' }] };
    let state = { snapshot: structuredClone(livePlatformSnapshot), revision: 9, contentHash: canonicalHash(livePlatformSnapshot), namespaceId: PLATFORM_NAMESPACE_ID };
    const repo = {
      load: async () => structuredClone(state),
      save: async (snapshot, { expectedRevision, changedBy }) => {
        assert.equal(expectedRevision, 9);
        assert.match(changedBy, /^verified-restore:/);
        state = { snapshot: structuredClone(snapshot), revision: 10, contentHash: canonicalHash(snapshot), namespaceId: PLATFORM_NAMESPACE_ID };
        return { ...state, records: 1 };
      }
    };
    const currentHashMismatchDirectory = path.join(destination, 'current-hash-mismatch');
    let currentHashMismatchStorageIo = 0;
    await assert.rejects(() => execute({
      command: 'restore', output: '', backup: backup.directory,
      preRestoreOutput: currentHashMismatchDirectory, apply: true,
      expectedManifestSha256: backup.manifestSha256,
      expectedCurrentContentHash: 'f'.repeat(64), expectedRevision: 9,
      disposableTarget: disposableProjectRef
    }, {
      repo,
      download: async () => { currentHashMismatchStorageIo += 1; throw new Error('unexpected download'); },
      upload: async () => { currentHashMismatchStorageIo += 1; },
      remove: async () => { currentHashMismatchStorageIo += 1; },
      fenceApi: stableFenceApi,
      env: disposableEnv
    }), /current platform content hash does not match the independently recorded value/);
    assert.equal(state.revision, 9, 'a mismatched independent current hash cannot reach the repository write');
    assert.equal(currentHashMismatchStorageIo, 0, 'a mismatched independent current hash performs no Storage I/O');
    assert.equal(fs.existsSync(currentHashMismatchDirectory), false, 'a mismatched independent current hash creates no rollback evidence');

    const rollbackDirectory = path.join(destination, 'rollback');
    const restored = await execute({ command: 'restore', output: '', backup: backup.directory, preRestoreOutput: rollbackDirectory, apply: true, expectedManifestSha256: backup.manifestSha256, expectedCurrentContentHash: canonicalHash(livePlatformSnapshot), expectedRevision: 9, disposableTarget: disposableProjectRef }, {
      repo,
      fenceApi: stableFenceApi,
      env: disposableEnv,
      now: new Date('2026-10-20T12:31:00.000Z')
    });
    assert.equal(restored.restored, true);
    assert.equal(restored.priorRevision, 9);
    assert.equal(restored.revision, 10);
    assert.deepEqual(state.snapshot, preparePlatformRestore(restoredSnapshot, livePlatformSnapshot, state.snapshot.supportGrants[0].revokedAt));
    assert.deepEqual(state.snapshot.sessions, []);
    assert.equal(state.snapshot.users[0].passwordHash, 'current-hash');
    assert.equal('resetTokenHash' in state.snapshot.users[0], false);
    assert.equal(state.snapshot.supportGrants[0].status, 'Revoked');
    assert.equal('tokenHash' in state.snapshot.supportGrants[0], false);
    assert.equal(restored.preRestoreBackup.verified, true);
    assert.ok(fs.existsSync(restored.preRestoreBackup.directory));

    let postCommitFenceState = { snapshot: structuredClone(livePlatformSnapshot), revision: 9, contentHash: canonicalHash(livePlatformSnapshot), namespaceId: PLATFORM_NAMESPACE_ID };
    let postCommitFenceCommitted = false;
    const postCommitFenceRepo = {
      load: async () => structuredClone(postCommitFenceState),
      save: async (next, { expectedRevision }) => {
        assert.equal(expectedRevision, 9);
        postCommitFenceState = { snapshot: structuredClone(next), revision: 10, contentHash: canonicalHash(next), namespaceId: PLATFORM_NAMESPACE_ID };
        postCommitFenceCommitted = true;
        return structuredClone(postCommitFenceState);
      }
    };
    let postCommitFenceError = null;
    await assert.rejects(() => execute({
      command: 'restore', output: '', backup: backup.directory,
      preRestoreOutput: path.join(destination, 'post-commit-fence-change'), apply: true,
      expectedManifestSha256: backup.manifestSha256,
      expectedCurrentContentHash: canonicalHash(livePlatformSnapshot), expectedRevision: 9,
      disposableTarget: disposableProjectRef
    }, {
      repo: postCommitFenceRepo,
      fenceApi: { requireVerifiedFence: () => structuredClone(postCommitFenceCommitted ? changedFence : verifiedFence) },
      env: disposableEnv,
      now: new Date('2026-10-20T12:31:10.000Z')
    }), error => {
      postCommitFenceError = error;
      return error.code === 'PDL_PLATFORM_RECOVERY_POST_COMMIT_RECONCILIATION_REQUIRED' && /do not retry/i.test(error.message);
    });
    assert.equal(postCommitFenceCommitted, true);
    assert.equal(postCommitFenceError.repositoryCommitted, true);
    assert.equal(sanitizedCliFailure(postCommitFenceError).code, 'PDL_PLATFORM_RECOVERY_POST_COMMIT_RECONCILIATION_REQUIRED');
    assert.equal(JSON.parse(fs.readFileSync(postCommitFenceError.evidenceFile, 'utf8')).status, 'repository-committed-reconciliation-failed');

    let postCommitReadState = { snapshot: structuredClone(livePlatformSnapshot), revision: 9, contentHash: canonicalHash(livePlatformSnapshot), namespaceId: PLATFORM_NAMESPACE_ID };
    let postCommitReadCommitted = false;
    const postCommitReadRepo = {
      load: async () => {
        if (postCommitReadCommitted) throw new Error('repository provider unavailable after commit');
        return structuredClone(postCommitReadState);
      },
      save: async (next, { expectedRevision }) => {
        assert.equal(expectedRevision, 9);
        postCommitReadState = { snapshot: structuredClone(next), revision: 10, contentHash: canonicalHash(next), namespaceId: PLATFORM_NAMESPACE_ID };
        postCommitReadCommitted = true;
        return structuredClone(postCommitReadState);
      }
    };
    let postCommitReadError = null;
    await assert.rejects(() => execute({
      command: 'restore', output: '', backup: backup.directory,
      preRestoreOutput: path.join(destination, 'post-commit-read-failure'), apply: true,
      expectedManifestSha256: backup.manifestSha256,
      expectedCurrentContentHash: canonicalHash(livePlatformSnapshot), expectedRevision: 9,
      disposableTarget: disposableProjectRef
    }, {
      repo: postCommitReadRepo,
      fenceApi: stableFenceApi,
      env: disposableEnv,
      now: new Date('2026-10-20T12:31:20.000Z')
    }), error => {
      postCommitReadError = error;
      return error.code === 'PDL_PLATFORM_RECOVERY_POST_COMMIT_RECONCILIATION_REQUIRED';
    });
    assert.equal(postCommitReadCommitted, true);
    assert.equal(postCommitReadError.repositoryCommitted, true);
    assert.equal(JSON.parse(fs.readFileSync(postCommitReadError.evidenceFile, 'utf8')).status, 'repository-committed-reconciliation-failed');

    const assetOne = `platform/fence-one.bin`, assetTwo = `platform/fence-two.bin`;
    const assetBytes = new Map([
      [objectId('platform-assets', assetOne), Buffer.from('first restored object')],
      [objectId('platform-assets', assetTwo), Buffer.from('second restored object')]
    ]);
    const fencedStorageSnapshot = {
      users: [{ id: 'owner-1', email: 'owner@example.test', role: 'platform_owner', status: 'Active', passwordHash: 'old-hash' }],
      sessions: [{ userId: 'owner-1', tokenHash: 'old-session' }],
      blogPosts: [
        { id: 'fence-assets', attachments: [
          { storageBucket: 'platform-assets', storageKey: assetOne },
          { storageBucket: 'platform-assets', storageKey: assetTwo }
        ] }
      ]
    };
    const fencedBackup = await createPlatformPortableBackup({
      snapshot: fencedStorageSnapshot,
      revision: 4,
      destination,
      download: async (bucket, objectKey) => storageResponse(assetBytes.get(objectId(bucket, objectKey))),
      now: new Date('2026-10-20T12:31:30.000Z')
    });
    const fencedDestination = memoryStorage();
    let fencedSaveCalls = 0;
    const fencedRepoState = { snapshot: structuredClone(livePlatformSnapshot), revision: 9, contentHash: canonicalHash(livePlatformSnapshot), namespaceId: PLATFORM_NAMESPACE_ID };
    const fencedRepo = {
      load: async () => structuredClone(fencedRepoState),
      save: async () => { fencedSaveCalls += 1; throw new Error('repository save must not run after fence replacement'); }
    };
    const midBatchFence = sequenceFenceApi([verifiedFence, verifiedFence, verifiedFence, changedFence]);
    await assert.rejects(() => execute({
      command: 'restore', output: '', backup: fencedBackup.directory,
      preRestoreOutput: path.join(destination, 'mid-batch-fence-rollback'), apply: true,
      expectedManifestSha256: fencedBackup.manifestSha256, expectedCurrentContentHash: fencedRepoState.contentHash, expectedRevision: 9,
      disposableTarget: disposableProjectRef
    }, {
      repo: fencedRepo,
      download: fencedDestination.download,
      upload: fencedDestination.upload,
      remove: fencedDestination.remove,
      fenceApi: midBatchFence,
      env: disposableEnv,
      now: new Date('2026-10-20T12:31:31.000Z')
    }), /MAINTENANCE_FENCE_CHANGED/);
    assert.equal(fencedDestination.calls.upload, 1, 'only one platform object is written before a mid-batch fence replacement');
    assert.equal(fencedDestination.calls.remove, 0, 'rollback performs no mutation after the authorizing fence is replaced');
    assert.equal(fencedSaveCalls, 0);
    assert.equal(fencedDestination.objects.size, 1, 'the already-written platform object is retained for manual reconciliation');
    assert.deepEqual(fencedDestination.objects.get(objectId('platform-assets', assetOne)), assetBytes.get(objectId('platform-assets', assetOne)));

    const rollbackFenceDestination = memoryStorage();
    const rollbackFenceRepo = {
      load: async () => structuredClone(fencedRepoState),
      save: async () => { throw new Error('PDL_PLATFORM_REVISION_CONFLICT'); }
    };
    let rollbackFenceError = null;
    await assert.rejects(() => execute({
      command: 'restore', output: '', backup: fencedBackup.directory,
      preRestoreOutput: path.join(destination, 'rollback-mid-batch-fence-loss'), apply: true,
      expectedManifestSha256: fencedBackup.manifestSha256, expectedCurrentContentHash: fencedRepoState.contentHash, expectedRevision: 9,
      disposableTarget: disposableProjectRef
    }, {
      repo: rollbackFenceRepo,
      download: rollbackFenceDestination.download,
      upload: rollbackFenceDestination.upload,
      remove: rollbackFenceDestination.remove,
      fenceApi: sequenceFenceApi([verifiedFence, verifiedFence, verifiedFence, verifiedFence, verifiedFence, verifiedFence, changedFence]),
      env: disposableEnv,
      now: new Date('2026-10-20T12:31:32.000Z')
    }), error => {
      rollbackFenceError = error;
      return /manual reconciliation is required.*MAINTENANCE_FENCE_CHANGED/i.test(error.message);
    });
    assert.deepEqual(rollbackFenceDestination.objects.get(objectId('platform-assets', assetOne)), assetBytes.get(objectId('platform-assets', assetOne)), 'rollback stops before a later object after fence loss');
    assert.equal(rollbackFenceDestination.objects.has(objectId('platform-assets', assetTwo)), false, 'one rollback mutation completed while its fence was still exact');
    assert.equal(rollbackFenceDestination.calls.remove, 1);
    const rollbackFenceEvidence = JSON.parse(fs.readFileSync(rollbackFenceError.evidenceFile, 'utf8'));
    assert.equal(rollbackFenceEvidence.status, 'storage-outcome-unknown-manual-reconciliation-required');
    assert.equal(rollbackFenceEvidence.storageRollback.haltedForFence, true);
    assert.equal(rollbackFenceEvidence.storageRollback.processed, 1);

    await assert.rejects(
      () => execute({ command: 'restore', output: '', backup: backup.directory, preRestoreOutput: rollbackDirectory, apply: true, expectedManifestSha256: backup.manifestSha256, expectedRevision: 8, disposableTarget: disposableProjectRef }, { repo, fenceApi: stableFenceApi, env: disposableEnv }),
      /Restore precondition failed/
    );
    let loadCallsWithoutFence = 0;
    await assert.rejects(
      () => execute({
        command: 'restore', output: '', backup: backup.directory,
        preRestoreOutput: path.join(destination, 'missing-fence-rollback'), apply: true,
        expectedManifestSha256: backup.manifestSha256, expectedRevision: 10,
        disposableTarget: disposableProjectRef
      }, {
        repo: { load: async () => { loadCallsWithoutFence += 1; return state; } },
        env: disposableEnv,
        fenceApi: { requireVerifiedFence: () => { throw new Error('MAINTENANCE_FENCE_NOT_VERIFIED'); } }
      }),
      /MAINTENANCE_FENCE_NOT_VERIFIED/
    );
    assert.equal(loadCallsWithoutFence, 0, 'restore requires the verified fence before reading or mutating the repository');
    let targetMismatchIo = 0;
    await assert.rejects(
      () => execute({
        command: 'restore', output: '', backup: backup.directory,
        preRestoreOutput: path.join(destination, 'target-mismatch-rollback'), apply: true,
        expectedManifestSha256: backup.manifestSha256, expectedRevision: 10,
        disposableTarget: disposableProjectRef
      }, {
        repo: { load: async () => { targetMismatchIo += 1; return state; } },
        download: async () => { targetMismatchIo += 1; throw new Error('unexpected download'); },
        fenceApi: { requireVerifiedFence: () => { targetMismatchIo += 1; return verifiedFence; } },
        env: { ...disposableEnv, PDL_DISPOSABLE_SUPABASE_PROJECT_REF: 'x'.repeat(20) }
      }),
      /PLATFORM_RECOVERY_DISPOSABLE_TARGET_MISMATCH/
    );
    assert.equal(targetMismatchIo, 0, 'target mismatch fails before fence, repository, or storage I/O');
    for (const [name, productionRef] of [
      ['missing', undefined],
      ['invalid', 'not-a-project-ref'],
      ['same-as-disposable', disposableProjectRef]
    ]) {
      let disposableGuardIo = 0;
      const guardedEnv = { ...disposableEnv };
      if (productionRef === undefined) delete guardedEnv.PDL_PRODUCTION_SUPABASE_PROJECT_REF;
      else guardedEnv.PDL_PRODUCTION_SUPABASE_PROJECT_REF = productionRef;
      await assert.rejects(
        () => execute({
          command: 'export', output: path.join(destination, `disposable-guard-${name}`), backup: '',
          preRestoreOutput: '', apply: false, expectedManifestSha256: '', expectedRevision: null,
          disposableTarget: disposableProjectRef
        }, {
          repo: { load: async () => { disposableGuardIo += 1; return healthyExportState; } },
          download: async () => { disposableGuardIo += 1; throw new Error('unexpected download'); },
          env: guardedEnv
        }),
        /PLATFORM_RECOVERY_DISPOSABLE_(?:PRODUCTION_GUARD_MISSING|TARGET_FORBIDDEN)/
      );
      assert.equal(disposableGuardIo, 0, `${name} production guard fails before repository or storage I/O`);
      assert.equal(fs.existsSync(path.join(destination, `disposable-guard-${name}`)), false);
    }
    let localProductionIo = 0;
    await assert.rejects(
      () => execute({
        command: 'restore', output: '', backup: backup.directory,
        preRestoreOutput: path.join(destination, 'local-production-rollback'), apply: true,
        expectedManifestSha256: backup.manifestSha256, expectedRevision: 10,
        productionTarget: productionProjectRef,
        expectedServiceId: productionServiceId,
        expectedInstanceId: productionInstanceId
      }, {
        repo: { load: async () => { localProductionIo += 1; return state; } },
        fenceApi: { requireVerifiedFence: () => { localProductionIo += 1; return verifiedFence; } },
        env: {
          NODE_ENV: 'test', RENDER: 'false', PDL_SUPABASE_ENABLED: '1',
          SUPABASE_URL: `https://${productionProjectRef}.supabase.co`,
          PDL_PRODUCTION_SUPABASE_PROJECT_REF: productionProjectRef,
          RENDER_SERVICE_ID: productionServiceId,
          RENDER_INSTANCE_ID: productionInstanceId
        }
      }),
      /PLATFORM_RECOVERY_PRODUCTION_RUNTIME_MISMATCH/
    );
    assert.equal(localProductionIo, 0, 'local process cannot target the acknowledged production project');
    await assert.rejects(
      () => execute({ command: 'restore-preview', output: '', backup: backup.directory, preRestoreOutput: '', apply: false, expectedManifestSha256: 'b'.repeat(64), expectedRevision: null }),
      /independently recorded SHA-256/
    );
  } finally {
    fs.rmSync(destination, { recursive: true, force: true });
  }
  console.log('Platform recovery command safety tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
