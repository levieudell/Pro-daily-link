'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectStorageReferences, createPortableBackup, verifyPortableBackup } = require('./database/portable-backup');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const route = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `route markers found: ${start}`);
  return source.slice(from, to);
};

const officeEstimate = route("if(req.method==='POST'&&url.pathname==='/api/estimate-imports/analyze')", "const approveImport=");
assert.match(officeEstimate, /saveAsset\(db,'estimate-documents'/);
assert.match(officeEstimate, /storageBucket:stored\.bucket,storageKey:stored\.objectKey/);
assert.doesNotMatch(officeEstimate, /fs\.(?:writeFileSync|mkdirSync)/, 'office estimate PDFs never use Render local disk');

const guestDaily = route("if(req.method==='POST'&&guestAccess)", 'const tmSummary=');
assert.match(guestDaily, /saveAsset\(db,'project-photos'/);
assert.match(guestDaily, /saveAsset\(db,'project-tickets'/);
assert.match(guestDaily, /storageBucket:stored\.bucket,storageKey:stored\.objectKey/);
assert.doesNotMatch(guestDaily, /fs\.(?:writeFileSync|mkdirSync)/, 'subcontractor evidence never uses Render local disk');

const fieldProposal = route('const estimateProposals=', 'const userTimeAccess=');
assert.match(fieldProposal, /saveAsset\(db,'estimate-documents'/);
assert.match(fieldProposal, /storageBucket:stored\.bucket,storageKey:stored\.objectKey/);
assert.doesNotMatch(fieldProposal, /fs\.(?:writeFileSync|mkdirSync)/, 'field estimate PDFs never use Render local disk');

const saveAsset = route('async function saveAsset(', 'function credentialHash(');
assert.match(saveAsset, /transactionalMode\(\)==='primary'/, 'primary storage fails closed instead of falling back to ephemeral disk');

const companyId = '11111111-1111-4111-8111-111111111111';
const snapshot = {
  company: { id: companyId, name: 'Durable Uploads' },
  photos: [{ id: 1, storageBucket: 'project-photos', storageKey: `${companyId}/subcontractor.jpg` }],
  estimateImports: [{ id: 2, storageBucket: 'estimate-documents', storageKey: `${companyId}/office.pdf` }],
  projects: [{ id: 3, estimateProposals: [{ id: 4, sourceFile: { storageBucket: 'estimate-documents', storageKey: `${companyId}/field.pdf` } }] }]
};
assert.deepEqual(collectStorageReferences(snapshot).map(row => `${row.bucket}/${row.objectKey}`), [
  `estimate-documents/${companyId}/field.pdf`,
  `estimate-documents/${companyId}/office.pdf`,
  `project-photos/${companyId}/subcontractor.jpg`
]);
assert.throws(
  () => collectStorageReferences({ company: { id: companyId }, estimateImports: [{ id: 99, url: '/uploads/estimate-99.pdf' }] }),
  /Non-portable local storage reference/,
  'portable export must expose legacy Render-disk dependencies instead of silently omitting their bytes'
);

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-durable-uploads-'));
  try {
    const backup = await createPortableBackup({
      snapshot,
      destination: root,
      download: async (bucket, objectKey) => ({
        arrayBuffer: async () => Buffer.from(`${bucket}/${objectKey}`),
        headers: { get: () => objectKey.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg' }
      })
    });
    assert.equal(backup.verification.objects, 3);
    assert.equal(backup.verification.missingObjects, 0);

    // Even a self-consistent, re-signed manifest cannot omit a referenced
    // object: inventory reconciliation against the snapshot fails closed.
    const incomplete = path.join(root, 'inventory-tamper');
    fs.cpSync(backup.directory, incomplete, { recursive: true });
    const manifestFile = path.join(incomplete, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.objects.pop();
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
    fs.writeFileSync(manifestFile, manifestBytes);
    fs.writeFileSync(path.join(incomplete, 'manifest.sha256'), `${crypto.createHash('sha256').update(manifestBytes).digest('hex')}  manifest.json\n`);
    assert.throws(() => verifyPortableBackup(incomplete, { expectedCompanyId: companyId }), /inventory does not match/);
    console.log('Durable upload routes passed: private Storage only, primary fail-closed behavior, and complete portable backup inventory.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
