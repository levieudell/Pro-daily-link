'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, collectStorageReferences, createPortableBackup, digest } = require('./database/portable-backup');

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
    assert.equal(result.manifest.snapshot.sha256, digest(fs.readFileSync(path.join(result.directory, 'snapshot.json'))));
    for (const object of result.manifest.objects) assert.equal(object.sha256, digest(fs.readFileSync(path.join(result.directory, object.filename))));
    assert.ok(fs.existsSync(path.join(result.directory, 'manifest.json')));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log('Portable backup tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
