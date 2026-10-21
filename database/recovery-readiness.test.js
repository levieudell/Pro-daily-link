'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  SCHEMA,
  POINTER_SCHEMA,
  EVIDENCE_BUCKET,
  POINTER_OBJECT_KEY,
  productionTargetSha256,
  populationSha256,
  publicStatus
} = require('./recovery-readiness');
const { opaqueTenantRef } = require('./shadow-reconciliation');

const NOW = Date.parse('2026-10-20T20:00:00.000Z');
const PROJECT_REF = 'abcdefghijklmnopqrst';
const TENANT_A = '7176abe8-07e4-4336-a372-1163d2f21ff9';
const TENANT_B = '11111111-1111-4111-8111-111111111111';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_PLATFORM = 'c'.repeat(64);
const MANIFEST = 'd'.repeat(64);
const { publicKey: attestationPublicKey, privateKey: attestationPrivateKey } = crypto.generateKeyPairSync('ed25519');
const ATTESTATION_PUBLIC_KEY = attestationPublicKey.export({ format: 'der', type: 'spki' }).toString('base64');

function authority(databaseCompanyId, revision, contentHash, company = {}) {
  return {
    databaseCompanyId,
    revision,
    contentHash,
    snapshot: { company: { id: databaseCompanyId, name: 'Private company name', ...company } }
  };
}

function recoveryEntry(revision, contentHash, tenantRef = null) {
  return {
    ...(tenantRef ? { tenantRef } : {}),
    revision,
    contentHash,
    portable: {
      manifestSha256: MANIFEST,
      verifiedAt: '2026-10-20T18:00:00.000Z',
      complete: true,
      missingObjects: 0
    },
    independentCopy: {
      manifestSha256: MANIFEST,
      verifiedAt: '2026-10-20T18:30:00.000Z',
      destinationEvidenceSha256: 'e'.repeat(64)
    },
    restoreDrill: {
      verifiedAt: '2026-10-10T18:00:00.000Z',
      evidenceSha256: 'f'.repeat(64),
      targetDestroyedAt: '2026-10-10T19:00:00.000Z'
    }
  };
}

const tenantRows = [
  authority(TENANT_A, 7, HASH_A),
  authority(TENANT_B, 9, HASH_B),
  authority('22222222-2222-4222-8222-222222222222', 2, '2'.repeat(64), { mcpConnector: true }),
  { ...authority('33333333-3333-4333-8333-333333333333', 3, '3'.repeat(64)), snapshot: { company: { id: 'archived', archivedDuplicate: true } } },
  { ...authority('44444444-4444-4444-8444-444444444444', 4, '4'.repeat(64)), snapshot: { company: { id: 'deleted', deletedAt: '2026-01-01T00:00:00Z' } } }
];

function attestation() {
  const tenants = [
    recoveryEntry(7, HASH_A, opaqueTenantRef(TENANT_A)),
    recoveryEntry(9, HASH_B, opaqueTenantRef(TENANT_B))
  ].sort((a, b) => a.tenantRef.localeCompare(b.tenantRef));
  return {
    schema: SCHEMA,
    attestedAt: '2026-10-20T19:00:00.000Z',
    productionTargetSha256: productionTargetSha256(PROJECT_REF),
    populationSha256: populationSha256(tenants.map(row => row.tenantRef)),
    tenants,
    platform: recoveryEntry(12, HASH_PLATFORM)
  };
}

function remoteEvidence(value, { wrongChecksum = false, wrongSignature = false, pointerOverrides = {} } = {}) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const digest = wrongChecksum ? '0'.repeat(64) : crypto.createHash('sha256').update(bytes).digest('hex');
  const objectKey = `recovery-readiness/attestations/${digest}.json`;
  const pointer = {
    schema: POINTER_SCHEMA,
    attestationObjectKey: objectKey,
    attestationSha256: digest,
    attestationSignature: (wrongSignature ? Buffer.alloc(64, 7) : crypto.sign(null, bytes, attestationPrivateKey)).toString('base64'),
    updatedAt: '2026-10-20T19:05:00.000Z',
    ...pointerOverrides
  };
  const objects = new Map([
    [`${EVIDENCE_BUCKET}/${POINTER_OBJECT_KEY}`, Buffer.from(JSON.stringify(pointer))],
    [`${EVIDENCE_BUCKET}/${objectKey}`, bytes]
  ]);
  return async (bucket, key) => {
    const body = objects.get(`${bucket}/${key}`);
    if (!body) throw new Error('remote object unavailable');
    return {
      headers: { get: name => String(name).toLowerCase() === 'content-length' ? String(body.length) : null },
      arrayBuffer: async () => body
    };
  };
}

function environment(overrides = {}) {
  return {
    NODE_ENV: 'production',
    PDL_SUPABASE_ENABLED: '1',
    SUPABASE_URL: `https://${PROJECT_REF}.supabase.co`,
    PDL_PRODUCTION_SUPABASE_PROJECT_REF: PROJECT_REF,
    PDL_TRANSACTIONAL_DB: 'primary',
    PDL_PLATFORM_TRANSACTIONAL_DB: 'primary',
    PDL_RECOVERY_ATTESTATION_PUBLIC_KEY: ATTESTATION_PUBLIC_KEY,
    ...overrides
  };
}

async function assess({ value = attestation(), env = environment(), rows = tenantRows, platform = { revision: 12, contentHash: HASH_PLATFORM }, download = null } = {}) {
  return publicStatus({
    env,
    now: () => NOW,
    download: download || remoteEvidence(value),
    loadTenantAuthorities: async () => structuredClone(rows),
    loadPlatformAuthority: async () => structuredClone(platform)
  });
}

(async () => {
  const ready = await assess();
  assert.deepEqual(ready, {
    scope: 'all-eligible-tenants-and-platform',
    configured: true,
    ready: true,
    tenantCount: 2,
    tenantBackupsVerified: 2,
    platformBackupVerified: true,
    independentCopy: 'verified',
    restore: 'verified',
    lastVerifiedAt: '2026-10-20T19:00:00.000Z',
    reason: null
  });
  const serialized = JSON.stringify(ready);
  for (const privateValue of [TENANT_A, TENANT_B, HASH_A, HASH_B, MANIFEST, 'Private company name', PROJECT_REF]) {
    assert.equal(serialized.includes(privateValue), false, `public status leaked ${privateValue}`);
  }

  let evidenceReads = 0, authorityReads = 0;
  const noDownloader = await publicStatus({
    env: environment(), now: () => NOW,
    loadTenantAuthorities: async () => { authorityReads += 1; return tenantRows; },
    loadPlatformAuthority: async () => { authorityReads += 1; return { revision: 12, contentHash: HASH_PLATFORM }; }
  });
  assert.equal(noDownloader.reason, 'not_configured');
  assert.equal(authorityReads, 0, 'missing durable evidence adapter must fail before authority reads');

  for (const env of [
    environment({ PDL_PRODUCTION_SUPABASE_PROJECT_REF: 'zzzzzzzzzzzzzzzzzzzz' }),
    environment({ SUPABASE_URL: 'https://custom.example.test' }),
    environment({ PDL_RECOVERY_ATTESTATION_PUBLIC_KEY: '' }),
    environment({ PDL_TRANSACTIONAL_DB: 'shadow' })
  ]) {
    evidenceReads = 0;
    authorityReads = 0;
    const result = await publicStatus({
      env, now: () => NOW,
      download: async () => { evidenceReads += 1; throw new Error('must not read'); },
      loadTenantAuthorities: async () => { authorityReads += 1; return tenantRows; },
      loadPlatformAuthority: async () => { authorityReads += 1; return { revision: 12, contentHash: HASH_PLATFORM }; }
    });
    assert.equal(result.ready, false);
    assert.equal(evidenceReads, 0, 'runtime/target mismatch must fail before remote evidence reads');
    assert.equal(authorityReads, 0, 'runtime/target mismatch must fail before authority reads');
  }

  const missingTenant = structuredClone(tenantRows).filter(row => row.databaseCompanyId !== TENANT_B);
  assert.equal((await assess({ rows: missingTenant })).reason, 'population_mismatch');
  const extraTenant = [...tenantRows, authority('55555555-5555-4555-8555-555555555555', 1, '5'.repeat(64))];
  assert.equal((await assess({ rows: extraTenant })).reason, 'population_mismatch');
  const changedTenant = structuredClone(tenantRows);
  changedTenant[0].revision += 1;
  assert.equal((await assess({ rows: changedTenant })).reason, 'authority_mismatch');
  assert.equal((await assess({ platform: { revision: 13, contentHash: HASH_PLATFORM } })).reason, 'platform_authority_mismatch');

  const badCopy = attestation();
  badCopy.tenants[0].independentCopy.manifestSha256 = '1'.repeat(64);
  authorityReads = 0;
  const copyResult = await publicStatus({
    env: environment(), now: () => NOW, download: remoteEvidence(badCopy),
    loadTenantAuthorities: async () => { authorityReads += 1; return tenantRows; },
    loadPlatformAuthority: async () => { authorityReads += 1; return { revision: 12, contentHash: HASH_PLATFORM }; }
  });
  assert.equal(copyResult.reason, 'independent_copy_unverified');
  assert.equal(authorityReads, 0, 'invalid independent-copy proof must fail before authority reads');

  const staleRestore = attestation();
  staleRestore.platform.restoreDrill.verifiedAt = '2026-08-01T00:00:00.000Z';
  staleRestore.platform.restoreDrill.targetDestroyedAt = '2026-08-01T01:00:00.000Z';
  assert.equal((await assess({ value: staleRestore })).reason, 'restore_stale');

  const extraPii = attestation();
  extraPii.tenants[0].companyName = 'must not be accepted';
  assert.equal((await assess({ value: extraPii })).reason, 'evidence_invalid');

  assert.equal((await assess({ download: remoteEvidence(attestation(), { wrongChecksum: true }) })).reason, 'evidence_checksum_mismatch');
  assert.equal((await assess({ download: remoteEvidence(attestation(), { wrongSignature: true }) })).reason, 'signature_unverified');
  assert.equal((await assess({ download: remoteEvidence(attestation(), { pointerOverrides: { attestationObjectKey: '../unsafe.json' } }) })).reason, 'evidence_invalid');

  const malformedRows = [{ databaseCompanyId: TENANT_A, revision: 1, contentHash: HASH_A, snapshot: {} }];
  assert.equal((await assess({ rows: malformedRows })).reason, 'authority_unavailable');

  const remoteFailure = await assess({ download: async () => { throw new Error('provider included a secret in this error'); } });
  assert.equal(remoteFailure.reason, 'evidence_unavailable');
  assert.equal(JSON.stringify(remoteFailure).includes('secret'), false);

  console.log('Recovery readiness passed: durable checksummed remote evidence must match every live tenant/platform authority and never exposes tenant data.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
