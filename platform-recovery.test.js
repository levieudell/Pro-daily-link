'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PLATFORM_NAMESPACE_ID, canonicalHash } = require('./database/platform-repository');
const { createPlatformPortableBackup } = require('./database/platform-portable-backup');
const { parseArgs, execute, preparePlatformRestore } = require('./database/platform-recovery');

assert.deepEqual(parseArgs(['export', '--output', 'D:\\backups']), {
  command: 'export', output: 'D:\\backups', backup: '', preRestoreOutput: '', apply: false, expectedManifestSha256: '', expectedRevision: null
});
assert.equal(parseArgs(['verify', '--backup', 'D:\\backup-1']).command, 'verify');
assert.equal(parseArgs(['restore-preview', '--backup', 'D:\\backup-1', '--expected-manifest-sha256', 'a'.repeat(64)]).command, 'restore-preview');
assert.deepEqual(parseArgs(['restore', '--backup', 'D:\\backup-1', '--expected-revision', '9', '--expected-manifest-sha256', 'a'.repeat(64), '--pre-restore-output', 'D:\\rollback', '--apply']), {
  command: 'restore', output: '', backup: 'D:\\backup-1', preRestoreOutput: 'D:\\rollback', apply: true, expectedManifestSha256: 'a'.repeat(64), expectedRevision: 9
});
assert.throws(() => parseArgs(['restore', '--backup', 'D:\\backup-1', '--expected-revision', '9']), /Refusing a restore/);
assert.throws(() => parseArgs(['restore', '--backup', 'D:\\backup-1', '--apply']), /expected-revision/);
assert.throws(() => parseArgs(['restore', '--backup', 'D:\\backup-1', '--expected-revision', '9', '--apply']), /pre-restore-output/);
assert.throws(() => parseArgs(['restore-preview', '--backup', 'D:\\backup-1']), /expected-manifest-sha256/);
assert.throws(() => parseArgs(['export']), /independent-directory/);

(async () => {
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-platform-recovery-test-'));
  try {
    const restoredSnapshot = {
      users: [{ id: 'owner-1', passwordHash: 'hash', resetTokenHash: 'old-reset', setupHash: 'old-setup' }],
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

    const preview = await execute({ command: 'restore-preview', output: '', backup: backup.directory, preRestoreOutput: '', apply: false, expectedManifestSha256: backup.manifestSha256, expectedRevision: null });
    assert.equal(preview.verified, true);
    assert.equal(preview.sourceRevision, 4);

    let state = { snapshot: { users: [] }, revision: 9, contentHash: canonicalHash({ users: [] }), namespaceId: PLATFORM_NAMESPACE_ID };
    const repo = {
      load: async () => structuredClone(state),
      save: async (snapshot, { expectedRevision, changedBy }) => {
        assert.equal(expectedRevision, 9);
        assert.match(changedBy, /^verified-restore:/);
        state = { snapshot: structuredClone(snapshot), revision: 10, contentHash: canonicalHash(snapshot), namespaceId: PLATFORM_NAMESPACE_ID };
        return { ...state, records: 1 };
      }
    };
    const rollbackDirectory = path.join(destination, 'rollback');
    const restored = await execute({ command: 'restore', output: '', backup: backup.directory, preRestoreOutput: rollbackDirectory, apply: true, expectedManifestSha256: backup.manifestSha256, expectedRevision: 9 }, { repo, now: new Date('2026-10-20T12:31:00.000Z') });
    assert.equal(restored.restored, true);
    assert.equal(restored.priorRevision, 9);
    assert.equal(restored.revision, 10);
    assert.deepEqual(state.snapshot, preparePlatformRestore(restoredSnapshot, state.snapshot.supportGrants[0].revokedAt));
    assert.deepEqual(state.snapshot.sessions, []);
    assert.equal(state.snapshot.users[0].passwordHash, 'hash');
    assert.equal('resetTokenHash' in state.snapshot.users[0], false);
    assert.equal(state.snapshot.supportGrants[0].status, 'Revoked');
    assert.equal('tokenHash' in state.snapshot.supportGrants[0], false);
    assert.equal(restored.preRestoreBackup.verified, true);
    assert.ok(fs.existsSync(restored.preRestoreBackup.directory));

    await assert.rejects(
      () => execute({ command: 'restore', output: '', backup: backup.directory, preRestoreOutput: rollbackDirectory, apply: true, expectedManifestSha256: backup.manifestSha256, expectedRevision: 8 }, { repo }),
      /Restore precondition failed/
    );
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
