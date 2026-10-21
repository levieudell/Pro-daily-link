'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const supabase = require('./database/supabase');
const { canonicalHash } = require('./database/transactional-repository');
const { parseArgs, collectStorageReferences, createPortableBackup, verifyPortableBackup, validateTenantSnapshot, validateTenantRestoreSnapshot, SNAPSHOT_SCHEMA, loadAuthoritativeTenantSnapshot, assertLegacyDirectExportAuthority, assertLegacyDirectExportMode, digest, sanitizedCliResult, sanitizedCliFailure } = require('./database/portable-backup');

const id = '11111111-1111-1111-1111-111111111111';
const backupScripts = require('./package.json').scripts;
assert.equal(backupScripts['backup:portable'], 'node database/tenant-recovery.js export', 'default portable backup script must use the fenced primary exporter');
assert.equal(backupScripts['backup:portable:legacy'], 'node database/portable-backup.js', 'legacy exporter must remain explicitly named');
const snapshot = {
  company: { id, name: 'QA Builders', persistence: { revision: 4 }, logo: { bucket: 'company-logos', objectKey: `${id}/logo.png` } },
  users: [{ id: 1, name: 'QA Owner', email: 'owner@qa-builders.example', role: 'owner', status: 'Active' }], projects: [], reports: [],
  photos: [{ id: 1, storageBucket: 'project-photos', storageKey: `${id}/photo.jpg` }],
  projectPlans: [{ id: 2, storageBucket: 'estimate-documents', storageKey: `${id}/plan.pdf` }],
  projectTickets: [{ id: 3, bucket: 'project-tickets', objectKey: `${id}/ticket.pdf` }]
};

const owner = snapshot.users[0];
assert.throws(() => validateTenantSnapshot({}), /company object/);
assert.throws(() => validateTenantSnapshot({ company: snapshot.company }), /at least one user/);
assert.throws(() => validateTenantSnapshot({ company: snapshot.company, users: [owner, { ...owner }] }), /duplicate id/);
assert.throws(() => validateTenantSnapshot({ company: snapshot.company, users: [owner, { ...owner, id: 2 }] }), /duplicate user email/);
const legacyUsers = [
  owner,
  { id: 2, name: 'Legacy Guest', email: 'legacy-guest@example.test', role: 'guest', status: 'Active' },
  { id: 3, name: 'Quarantined Import', email: 'legacy-import@example.test', role: 'unrecognized', status: 'Quarantined' }
];
assert.doesNotThrow(() => validateTenantSnapshot({ company: snapshot.company, users: legacyUsers }), 'backup validation preserves bounded legacy identity fields');
assert.throws(() => validateTenantRestoreSnapshot({ company: snapshot.company, users: legacyUsers }), /unsupported role/, 'an unknown active role is never restorable authority');
assert.throws(() => validateTenantRestoreSnapshot({ company: snapshot.company, users: [owner, { ...legacyUsers[2], role: 'field' }] }), /unsupported status/);
assert.doesNotThrow(() => validateTenantRestoreSnapshot({ company: snapshot.company, users: [owner, { ...legacyUsers[1], status: 'Deactivated' }] }), 'deactivated legacy rows remain recoverable as history');
assert.throws(() => validateTenantSnapshot({ company: snapshot.company, users: [owner, { ...legacyUsers[1], role: 'x'.repeat(81) }] }), /role is invalid/);
assert.throws(() => validateTenantSnapshot({ company: snapshot.company, users: [owner, { ...legacyUsers[1], status: 'Quarantined\nActive' }] }), /status is invalid/);
assert.throws(() => validateTenantSnapshot({ company: snapshot.company, users: [{ ...owner, status: 'Deactivated' }] }), /active owner/);
assert.throws(() => validateTenantSnapshot({ company: snapshot.company, users: [owner], projects: {} }), /collection projects must be an array/);
assert.throws(() => validateTenantSnapshot({ company: snapshot.company, users: [owner], surpriseRows: [] }), /unsupported collection/);

assert.deepEqual(parseArgs(['--company-id', id, '--output', 'D:\\backups']), { companyId: id, output: 'D:\\backups' });
assert.throws(() => parseArgs([]), /single synthetic or approved tenant/);
assert.throws(() => parseArgs(['--company-id', id]), /independent destination/);
assert.equal(collectStorageReferences(snapshot).length, 4);
assert.throws(() => collectStorageReferences({ company: { id }, photos: [{ id: 9, storageBucket: 'project-photos', storageKey: 'another-tenant/photo.jpg' }] }), /cross-tenant/);
assert.throws(() => collectStorageReferences({ company: { id }, photos: [{ id: 10, url: '/uploads/photo.jpg' }] }), /Non-portable local storage reference/);
assert.throws(() => assertLegacyDirectExportMode('primary'), error => error.code === 'PDL_TENANT_BACKUP_PRIMARY_REQUIRES_RECOVERY');
assert.equal(assertLegacyDirectExportMode('shadow'), 'shadow');
const primaryFailure = sanitizedCliFailure(Object.assign(new Error('do not leak this'), { code: 'PDL_TENANT_BACKUP_PRIMARY_REQUIRES_RECOVERY' }));
assert.equal(primaryFailure.code, 'PDL_TENANT_BACKUP_PRIMARY_REQUIRES_RECOVERY');
assert.equal(primaryFailure.message.includes('do not leak this'), false);
for (const localReference of [
  '\\uploads\\photo.jpg', '//fileserver/photo.jpg', '/api/files/project-photos/photo.jpg',
  '/api/local-files/project-photos/photo.jpg', 'file:///tmp/photo.jpg', 'C:\\photos\\photo.jpg'
]) {
  assert.throws(
    () => collectStorageReferences({ company: { id }, photos: [{ id: 11, url: localReference }] }),
    /Non-portable local storage reference/
  );
}

function rewriteManifest(directory, mutate) {
  const manifestFile = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  mutate(manifest);
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2));
  fs.writeFileSync(manifestFile, bytes);
  fs.writeFileSync(path.join(directory, 'manifest.sha256'), `${digest(bytes)}  manifest.json\n`);
}

function rewriteSnapshotAndManifest(directory, replacement) {
  const snapshotFile = path.join(directory, 'snapshot.json');
  const snapshotBytes = Buffer.from(JSON.stringify(replacement, null, 2));
  fs.writeFileSync(snapshotFile, snapshotBytes);
  rewriteManifest(directory, manifest => {
    manifest.snapshot.bytes = snapshotBytes.length;
    manifest.snapshot.sha256 = digest(snapshotBytes);
    manifest.snapshot.canonicalSha256 = canonicalHash(replacement);
    manifest.authority.contentHash = canonicalHash(replacement);
  });
}

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-portable-backup-test-'));
  try {
    await assert.rejects(
      () => createPortableBackup({ snapshot: {}, destination: directory }),
      /company object/
    );
    await assert.rejects(
      () => createPortableBackup({ snapshot: { company: snapshot.company }, destination: directory }),
      /at least one user/
    );
    assert.deepEqual(fs.readdirSync(directory), [], 'unsafe tenant snapshots must fail before export filesystem I/O');
    const blockedOutput = path.join(directory, 'blocked-primary-cli');
    const blockedCli = spawnSync(process.execPath, [
      path.join(__dirname, 'database', 'portable-backup.js'),
      '--company-id', id,
      '--output', blockedOutput
    ], {
      cwd: __dirname,
      env: { ...process.env, PDL_TRANSACTIONAL_DB: 'primary' },
      encoding: 'utf8'
    });
    assert.notEqual(blockedCli.status, 0, 'legacy CLI must fail closed in primary mode');
    const blockedFailure = JSON.parse(String(blockedCli.stderr || '').trim());
    assert.equal(blockedFailure.code, 'PDL_TENANT_BACKUP_PRIMARY_REQUIRES_RECOVERY');
    assert.equal(String(blockedCli.stderr).includes(blockedOutput), false, 'failure output must not expose destination paths');
    assert.equal(fs.existsSync(blockedOutput), false, 'primary guard must run before destination I/O');

    const bytesByKey = new Map([
      [`company-logos/${id}/logo.png`, Buffer.from('logo')],
      [`project-photos/${id}/photo.jpg`, Buffer.from('photo')],
      [`estimate-documents/${id}/plan.pdf`, Buffer.from('plan')],
      [`project-tickets/${id}/ticket.pdf`, Buffer.from('ticket')]
    ]);
    const download = async (bucket, objectKey) => {
      const bytes = bytesByKey.get(`${bucket}/${objectKey}`);
      assert.ok(bytes, `Unexpected object ${bucket}/${objectKey}`);
      return { arrayBuffer: async () => bytes, headers: { get: () => 'application/octet-stream' } };
    };
    const result = await createPortableBackup({ snapshot, destination: directory, download, now: new Date('2026-10-04T12:00:00.000Z') });
    assert.equal(result.manifest.objects.length, 4);
    assert.equal(result.manifest.snapshot.schema, SNAPSHOT_SCHEMA);
    assert.equal(result.verification.ok, true);
    assert.equal(result.manifest.snapshot.sha256, digest(fs.readFileSync(path.join(result.directory, 'snapshot.json'))));
    for (const object of result.manifest.objects) assert.equal(object.sha256, digest(fs.readFileSync(path.join(result.directory, object.filename))));
    assert.ok(fs.existsSync(path.join(result.directory, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(result.directory, 'manifest.sha256')));
    assert.equal(verifyPortableBackup(result.directory, { expectedCompanyId: id }).ok, true);
    assert.equal(JSON.stringify(sanitizedCliResult(result)).includes(result.directory), false, 'CLI output must not expose absolute backup paths');

    const legacySnapshot = { ...snapshot, users: legacyUsers };
    const legacyBackup = await createPortableBackup({
      snapshot: legacySnapshot,
      destination: directory,
      download,
      now: new Date('2026-10-04T12:00:30.000Z')
    });
    const legacyVerified = verifyPortableBackup(legacyBackup.directory, { expectedCompanyId: id });
    assert.deepEqual(legacyVerified.snapshot.users, legacyUsers, 'portable verification preserves legacy/quarantined identity records exactly');

    const missingSchema = path.join(directory, 'missing-tenant-schema-copy');
    fs.cpSync(result.directory, missingSchema, { recursive: true });
    rewriteManifest(missingSchema, manifest => { delete manifest.snapshot.schema; });
    assert.throws(() => verifyPortableBackup(missingSchema), /Unsupported tenant snapshot schema/);

    for (const [name, unsafe, message] of [
      ['empty', {}, /company object/],
      ['company-only', { company: snapshot.company }, /at least one user/],
      ['duplicate', { company: snapshot.company, users: [owner, { ...owner }] }, /duplicate id/],
      ['oversized-role', { company: snapshot.company, users: [owner, { ...legacyUsers[1], role: 'x'.repeat(81) }] }, /role is invalid/],
      ['control-status', { company: snapshot.company, users: [owner, { ...legacyUsers[1], status: 'Bad\nStatus' }] }, /status is invalid/]
    ]) {
      const copy = path.join(directory, `resigned-unsafe-tenant-${name}`);
      fs.cpSync(result.directory, copy, { recursive: true });
      rewriteSnapshotAndManifest(copy, unsafe);
      assert.throws(() => verifyPortableBackup(copy), message, `re-signed ${name} tenant snapshot must fail domain validation`);
    }

    const extraObject = path.join(result.directory, 'objects', 'unexpected.bin');
    fs.writeFileSync(extraObject, 'unexpected');
    assert.throws(() => verifyPortableBackup(result.directory), /does not exactly match/);
    fs.unlinkSync(extraObject);

    const traversal = path.join(directory, 'traversal-copy');
    fs.cpSync(result.directory, traversal, { recursive: true });
    rewriteManifest(traversal, manifest => { manifest.objects[0].filename = 'objects/../snapshot.json'; });
    assert.throws(() => verifyPortableBackup(traversal), /invalid or duplicate object filename/);

    const incompleteRoot = path.join(directory, 'incomplete-export');
    let sawNoCompletenessMarker = false;
    await assert.rejects(
      () => createPortableBackup({
        snapshot,
        destination: incompleteRoot,
        download,
        beforeComplete: ({ directory: pending }) => {
          sawNoCompletenessMarker = !fs.existsSync(path.join(pending, 'manifest.sha256'));
          throw new Error('source stability proof failed');
        }
      }),
      /source stability proof failed/
    );
    assert.equal(sawNoCompletenessMarker, true);
    assert.deepEqual(fs.readdirSync(incompleteRoot), [], 'failed final source proof leaves no accepted recovery set');

    const actualDestination = path.join(directory, 'actual-destination');
    const linkedDestination = path.join(directory, 'linked-destination');
    fs.mkdirSync(actualDestination);
    try {
      fs.symlinkSync(actualDestination, linkedDestination, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(
        () => createPortableBackup({ snapshot, destination: linkedDestination, download }),
        /regular directory/
      );
    } catch (error) {
      if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error;
    }

    const [parallelA, parallelB] = await Promise.all([1, 2].map(() => createPortableBackup({
      snapshot,
      destination: directory,
      download,
      now: new Date('2026-10-04T12:01:00.000Z')
    })));
    assert.notEqual(parallelA.directory, parallelB.directory, 'same-time exports cannot collide or delete one another');
    assert.equal(verifyPortableBackup(parallelA.directory).ok, true);
    assert.equal(verifyPortableBackup(parallelB.directory).ok, true);

    const authoritative = structuredClone(snapshot);
    authoritative.company.name = 'Transactional Authority';
    const staleLegacy = structuredClone(snapshot);
    staleLegacy.company.name = 'Stale Legacy Mirror';
    let legacyReads = 0;
    process.env.PDL_TRANSACTIONAL_DB = 'primary';
    supabase.loadTransactionalSnapshot = async () => ({ snapshot: authoritative, revision: 17, contentHash: canonicalHash(authoritative) });
    supabase.loadCompanySnapshot = async () => { legacyReads += 1; return staleLegacy; };
    const selected = await loadAuthoritativeTenantSnapshot(id);
    assert.equal(selected.snapshot.company.name, 'Transactional Authority');
    assert.deepEqual(selected.authority, { mode: 'transactional-primary', repositoryRevision: 17, contentHash: canonicalHash(authoritative) });
    assert.throws(() => assertLegacyDirectExportAuthority(selected.authority), /target-bound tenant-recovery export/);
    assert.equal(assertLegacyDirectExportAuthority({ mode: 'legacy-snapshot' }).mode, 'legacy-snapshot');
    assert.equal(legacyReads, 0, 'primary export never reads a potentially stale legacy mirror');
    delete process.env.PDL_TRANSACTIONAL_DB;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log('Portable backup tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
