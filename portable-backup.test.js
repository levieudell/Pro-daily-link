'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const supabase = require('./database/supabase');
const { canonicalHash } = require('./database/transactional-repository');
const { parseArgs, collectStorageReferences, createPortableBackup, verifyPortableBackup, loadAuthoritativeTenantSnapshot, digest } = require('./database/portable-backup');

const id = '11111111-1111-1111-1111-111111111111';
const snapshot = {
  company: { id, name: 'QA Builders', persistence: { revision: 4 }, logo: { bucket: 'company-logos', objectKey: `${id}/logo.png` } },
  users: [], projects: [], reports: [],
  photos: [{ id: 1, storageBucket: 'project-photos', storageKey: `${id}/photo.jpg` }],
  projectPlans: [{ id: 2, storageBucket: 'estimate-documents', storageKey: `${id}/plan.pdf` }],
  projectTickets: [{ id: 3, bucket: 'project-tickets', objectKey: `${id}/ticket.pdf` }]
};

assert.deepEqual(parseArgs(['--company-id', id, '--output', 'D:\\backups']), { companyId: id, output: 'D:\\backups' });
assert.throws(() => parseArgs([]), /single synthetic or approved tenant/);
assert.throws(() => parseArgs(['--company-id', id]), /independent destination/);
assert.equal(collectStorageReferences(snapshot).length, 4);
assert.throws(() => collectStorageReferences({ company: { id }, photos: [{ id: 9, storageBucket: 'project-photos', storageKey: 'another-tenant/photo.jpg' }] }), /cross-tenant/);
assert.throws(() => collectStorageReferences({ company: { id }, photos: [{ id: 10, url: '/uploads/photo.jpg' }] }), /Non-portable local storage reference/);

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-portable-backup-test-'));
  try {
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
    assert.equal(result.verification.ok, true);
    assert.equal(result.manifest.snapshot.sha256, digest(fs.readFileSync(path.join(result.directory, 'snapshot.json'))));
    for (const object of result.manifest.objects) assert.equal(object.sha256, digest(fs.readFileSync(path.join(result.directory, object.filename))));
    assert.ok(fs.existsSync(path.join(result.directory, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(result.directory, 'manifest.sha256')));
    assert.equal(verifyPortableBackup(result.directory, { expectedCompanyId: id }).ok, true);

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
    assert.equal(legacyReads, 0, 'primary export never reads a potentially stale legacy mirror');
    delete process.env.PDL_TRANSACTIONAL_DB;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log('Portable backup tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
