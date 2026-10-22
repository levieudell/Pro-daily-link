'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  collectStorageReferences,
  createPortableBackup,
  verifyPortableBackup
} = require('./database/portable-backup');

const companyId = '11111111-1111-4111-8111-111111111111';
const route = (bucket, objectKey) => `/api/files/${encodeURIComponent(bucket)}/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
const logoKey = `${companyId}/branding/company logo.png`;
const photoKey = `${companyId}/field/east wall #1.jpg`;
const snapshot = {
  company: {
    id: companyId,
    name: 'Legacy URL Builders',
    logo: { url: route('company-logos', logoKey) }
  },
  users: [{ id: 1, email: 'owner@legacy-url.example', role: 'owner', status: 'Active' }],
  projects: [],
  reports: [],
  photos: [{ id: 21, url: route('project-photos', photoKey) }]
};

assert.deepEqual(collectStorageReferences(snapshot), [
  { bucket: 'company-logos', objectKey: logoKey, source: 'company.logo' },
  { bucket: 'project-photos', objectKey: photoKey, source: 'photos:21' }
]);

assert.throws(
  () => collectStorageReferences({
    company: { id: companyId },
    photos: [{ id: 22, url: route('project-photos', '22222222-2222-4222-8222-222222222222/photo.jpg') }]
  }),
  /cross-tenant/,
  'a URL route cannot bypass tenant object-key isolation'
);
assert.throws(
  () => collectStorageReferences({ company: { id: companyId }, photos: [{ id: 23, url: `/api/files/project-photos/${companyId}/bad%ZZ.jpg` }] }),
  /invalid encoding/,
  'malformed percent encoding fails closed'
);
assert.throws(
  () => collectStorageReferences({ company: { id: companyId }, photos: [{ id: 24, url: `/api/files/project-photos/${companyId}/photo.jpg?download=1` }] }),
  /route .* invalid/,
  'query-bearing routes are not mistaken for object keys'
);
assert.throws(
  () => collectStorageReferences({ company: { id: companyId }, photos: [{ id: 25, url: `/api/files/project-photos/${companyId}/one.jpg`, downloadUrl: `/api/files/project-photos/${companyId}/two.jpg` }] }),
  /Conflicting private storage routes/,
  'an asset cannot silently point to two different private objects'
);
assert.throws(
  () => collectStorageReferences({
    company: { id: companyId },
    projectPlans: [{
      id: 26,
      storageBucket: 'estimate-documents',
      storageKey: `${companyId}/plans/current.pdf`,
      url: route('estimate-documents', `${companyId}/plans/other.pdf`)
    }]
  }),
  /Conflicting private storage routes/,
  'explicit bucket/key metadata cannot disagree with an API route on the same asset'
);
assert.deepEqual(
  collectStorageReferences({
    company: { id: companyId },
    projectPlans: [{
      id: 27,
      storageBucket: 'estimate-documents',
      storageKey: `${companyId}/plans/current.pdf`,
      url: route('estimate-documents', `${companyId}/plans/current.pdf`)
    }]
  }),
  [{ bucket: 'estimate-documents', objectKey: `${companyId}/plans/current.pdf`, source: 'projectPlans:27' }],
  'matching explicit and route metadata resolves to one object'
);
assert.throws(
  () => collectStorageReferences({
    company: { id: companyId },
    photos: [{ id: 28, url: route('project-photos', `${companyId}/valid.jpg`), downloadUrl: `/uploads/${companyId}/stale.jpg` }]
  }),
  /Non-portable local storage reference/,
  'a valid route cannot mask a local sibling pointer'
);
assert.throws(
  () => collectStorageReferences({
    company: { id: companyId },
    photos: [{ id: 29, storageBucket: 'project-photos', storageKey: `${companyId}/valid.jpg`, downloadUrl: `/api/local-files/${companyId}/stale.jpg` }]
  }),
  /Non-portable local storage reference/,
  'explicit metadata cannot mask a local sibling pointer'
);
for (const invalidKey of [
  `/${companyId}/leading.jpg`,
  `${companyId}//double.jpg`,
  `${companyId}/raw\\slash.jpg`,
  `${companyId}/./dot.jpg`
]) {
  assert.throws(
    () => collectStorageReferences({ company: { id: companyId }, photos: [{ id: 30, storageBucket: 'project-photos', storageKey: invalidKey }] }),
    /object key is invalid/,
    'explicit keys are not normalized into different Storage objects'
  );
}
for (const invalidRoute of [
  `/api/files/project-photos//${companyId}/leading.jpg`,
  `/api/files/project-photos/${companyId}//double.jpg`,
  `/api/files/project-photos/${companyId}/%2Fencoded-double.jpg`,
  `/api/files/project-photos/${companyId}/raw\\slash.jpg`,
  `/api/files/project-photos/${companyId}/encoded%5Cslash.jpg`,
  `/api/files/project-photos/%2F${companyId}/encoded-leading.jpg`,
  `/api/files/project-photos/${companyId}/./raw-dot.jpg`,
  `/api/files/project-photos/${companyId}/%2e/encoded-dot.jpg`
]) {
  assert.throws(
    () => collectStorageReferences({ company: { id: companyId }, photos: [{ id: 31, url: invalidRoute }] }),
    /object key is invalid/,
    'route keys with leading, double, raw-backslash, or encoded-backslash separators fail closed'
  );
}
assert.throws(
  () => collectStorageReferences({ company: { id: companyId }, photos: [{ id: 32, url: `/api/files/%70roject-photos/${companyId}/encoded-bucket.jpg` }] }),
  /bucket is invalid/,
  'the bucket segment is validated exactly as the live handler sees it and is never decoded into authority'
);
for (const unsupportedRoute of [
  `photos/${companyId}/relative.jpg`,
  `./photos/${companyId}/dot-relative.jpg`,
  `../photos/${companyId}/parent-relative.jpg`,
  `/assets/${companyId}/root-relative.jpg`,
  ` ${companyId}/whitespace-relative.jpg`,
  ` /api/files/project-photos/${companyId}/whitespace.jpg`,
  `/api/files/project-photos/${companyId}/trailing-space.jpg `,
  `https://app.prodailylink.com/api/files/project-photos/${companyId}/absolute.jpg`,
  `blob:https://app.prodailylink.com/opaque-object`,
  `s3:private-bucket/${companyId}/opaque-object`,
  `https:\\app.prodailylink.com\\api\\files\\project-photos\\${companyId}\\backslash.jpg`
]) {
  assert.throws(
    () => collectStorageReferences({ company: { id: companyId }, photos: [{ id: 33, url: unsupportedRoute }] }),
    /(?:Non-portable (?:local|external|unsupported) storage reference|Private storage route .* invalid)/,
    'whitespace-prefixed and absolute URLs do not silently bypass route validation'
  );
}
assert.doesNotThrow(
  () => collectStorageReferences({
    company: { id: companyId },
    photos: [{ id: 34, dataUrl: 'data:image/png;base64,aW5saW5lLWZpeHR1cmU=' }]
  }),
  'a valid inline data URL is already contained in snapshot.json and needs no external object'
);
for (const invalidInline of [
  ' data:image/png;base64,aW5saW5l',
  'data:image/png;base64',
  'data:,payload-without-a-media-type'
]) {
  assert.throws(
    () => collectStorageReferences({ company: { id: companyId }, photos: [{ id: 35, dataUrl: invalidInline }] }),
    /Non-portable external storage reference/,
    'only a canonical inline data URL may bypass external-object collection'
  );
}
for (const localReference of [
  `/uploads/${companyId}/estimate.pdf`,
  `/api/local-files/${companyId}/estimate.pdf`,
  `C:\\uploads\\${companyId}\\estimate.pdf`
]) {
  assert.throws(
    () => collectStorageReferences({ company: { id: companyId }, estimateImports: [{ id: 26, url: localReference }] }),
    /Non-portable local storage reference/,
    'local-disk references remain blockers and are never fabricated as Storage objects'
  );
}

(async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-api-files-backup-'));
  const requested = [];
  try {
    const result = await createPortableBackup({
      snapshot,
      destination: output,
      download: async (bucket, objectKey) => {
        requested.push(`${bucket}/${objectKey}`);
        const bytes = Buffer.from(`fixture:${bucket}/${objectKey}`);
        return {
          arrayBuffer: async () => bytes,
          headers: { get: () => objectKey.endsWith('.png') ? 'image/png' : 'image/jpeg' }
        };
      },
      now: new Date('2026-10-22T12:00:00.000Z')
    });
    assert.deepEqual(requested, [
      `company-logos/${logoKey}`,
      `project-photos/${photoKey}`
    ]);
    assert.equal(result.manifest.objects.length, 2);
    assert.equal(result.verification.missingObjects, 0);
    assert.equal(verifyPortableBackup(result.directory, { expectedCompanyId: companyId }).ok, true);
    console.log('Legacy /api/files routes are exported as tenant-scoped private Storage objects; local-disk references remain blocked.');
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
