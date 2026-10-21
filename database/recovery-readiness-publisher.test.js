'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  SOURCE_SCHEMA,
  CONFIRMATION,
  parseArgs,
  buildAttestation,
  execute,
  sanitizedFailure
} = require('./recovery-readiness-publisher');
const { productionTargetSha256 } = require('./recovery-readiness');

const projectRef = 'abcdefghijklmnopqrst';
const companyA = '11111111-1111-4111-8111-111111111111';
const companyB = '22222222-2222-4222-8222-222222222222';
const nowIso = '2026-10-20T20:00:00.000Z';
const nowMs = Date.parse(nowIso);
const cliSourcePath = path.resolve('backup', 'source.json');
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');

function recoveryEntry(seed, revision) {
  const manifest = sha(`manifest:${seed}`);
  return {
    revision,
    contentHash: sha(`content:${seed}`),
    portable: {
      manifestSha256: manifest,
      verifiedAt: '2026-10-20T18:00:00.000Z',
      complete: true,
      missingObjects: 0
    },
    independentCopy: {
      manifestSha256: manifest,
      verifiedAt: '2026-10-20T18:10:00.000Z',
      destinationEvidenceSha256: sha(`copy:${seed}`)
    },
    restoreDrill: {
      verifiedAt: '2026-10-10T18:00:00.000Z',
      evidenceSha256: sha(`restore:${seed}`),
      targetDestroyedAt: '2026-10-10T18:30:00.000Z'
    }
  };
}

function source() {
  return {
    schema: SOURCE_SCHEMA,
    attestedAt: nowIso,
    tenants: [
      { databaseCompanyId: companyB, ...recoveryEntry('b', 8) },
      { databaseCompanyId: companyA, ...recoveryEntry('a', 4) }
    ],
    platform: recoveryEntry('platform', 6)
  };
}

function tenantRows(revisionA = 4) {
  return [
    {
      databaseCompanyId: companyA,
      revision: revisionA,
      contentHash: recoveryEntry('a', 4).contentHash,
      snapshot: { company: { id: companyA, name: 'Never publish this company name' } }
    },
    {
      databaseCompanyId: companyB,
      revision: 8,
      contentHash: recoveryEntry('b', 8).contentHash,
      snapshot: { company: { id: companyB, name: 'Never publish this company name either' } }
    },
    {
      databaseCompanyId: '33333333-3333-4333-8333-333333333333',
      revision: 2,
      contentHash: sha('connector'),
      snapshot: { company: { id: 'connector', mcpConnector: true } }
    }
  ];
}

function platformAuthority() {
  return { revision: 6, contentHash: recoveryEntry('platform', 6).contentHash };
}

function env(keys = {}) {
  const pair = keys.pair || crypto.generateKeyPairSync('ed25519');
  return {
    PDL_SUPABASE_ENABLED: '1',
    SUPABASE_URL: `https://${projectRef}.supabase.co`,
    PDL_PRODUCTION_SUPABASE_PROJECT_REF: projectRef,
    PDL_TRANSACTIONAL_DB: 'primary',
    PDL_PLATFORM_TRANSACTIONAL_DB: 'primary',
    PDL_RECOVERY_ATTESTATION_PRIVATE_KEY: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    PDL_RECOVERY_ATTESTATION_PUBLIC_KEY: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    ...keys.overrides
  };
}

function args(command, expected = '') {
  return {
    command,
    source: 'C:\\independent\\recovery-source.json',
    productionTarget: projectRef,
    expectedAttestationSha256: expected,
    confirmAction: command === 'publish' ? CONFIRMATION : '',
    apply: command === 'publish'
  };
}

function response(bytes) {
  const data = Buffer.from(bytes);
  return { headers: { get: () => String(data.length) }, arrayBuffer: async () => data };
}

function memoryStorage(hooks = {}) {
  const objects = new Map();
  const operations = [];
  return {
    objects,
    operations,
    upload: async (bucket, objectKey, bytes, contentType, upsert) => {
      operations.push({ type: 'upload', bucket, objectKey, contentType, upsert });
      if (hooks.upload) await hooks.upload({ bucket, objectKey, bytes: Buffer.from(bytes), upsert, objects, operations });
      const id = `${bucket}/${objectKey}`;
      if (!upsert && objects.has(id)) throw Object.assign(new Error('conflict'), { statusCode: 409 });
      objects.set(id, Buffer.from(bytes));
      return { bucket, objectKey };
    },
    download: async (bucket, objectKey) => {
      operations.push({ type: 'download', bucket, objectKey });
      if (hooks.download) {
        const custom = await hooks.download({ bucket, objectKey, objects, operations });
        if (custom) return custom;
      }
      const bytes = objects.get(`${bucket}/${objectKey}`);
      if (!bytes) throw Object.assign(new Error('missing'), { statusCode: 404 });
      return response(bytes);
    }
  };
}

async function main() {
  assert.equal(parseArgs([
    'validate', '--source', cliSourcePath, '--production-target', projectRef
  ]).command, 'validate');
  assert.equal(parseArgs([
    'publish', '--source', cliSourcePath, '--production-target', projectRef,
    '--expected-attestation-sha256', 'a'.repeat(64), '--confirm-action', CONFIRMATION, '--apply'
  ]).apply, true);
  assert.throws(() => parseArgs(['publish', '--source', cliSourcePath, '--production-target', projectRef]), /--apply/);
  assert.throws(() => parseArgs([
    'validate', '--source', cliSourcePath, '--production-target', projectRef, '--apply'
  ]), /does not accept/);

  const built = buildAttestation(source(), productionTargetSha256(projectRef), nowMs);
  assert.equal(built.tenants.length, 2);
  assert.equal(JSON.stringify(built).includes(companyA), false, 'raw tenant UUIDs never enter the attestation');
  assert.equal(JSON.stringify(built).includes('Never publish'), false, 'company names never enter the attestation');
  assert.throws(() => buildAttestation({ ...source(), customerEmail: 'secret@example.com' }, productionTargetSha256(projectRef), nowMs), error => error.code === 'SOURCE_INVALID');

  const keyPair = crypto.generateKeyPairSync('ed25519');
  const publisherEnv = env({ pair: keyPair });
  const loadTenantAuthorities = async () => tenantRows();
  const loadPlatformAuthority = async () => platformAuthority();
  const validated = await execute(args('validate'), publisherEnv, {
    now: () => nowMs,
    readSource: source,
    loadTenantAuthorities,
    loadPlatformAuthority
  });
  assert.equal(validated.status, 'verified');
  assert.equal(validated.writesPerformed, false);
  assert.equal(validated.tenantCount, 2);
  assert.match(validated.attestationSha256, /^[a-f0-9]{64}$/);

  let targetMismatchReads = 0;
  await assert.rejects(() => execute({ ...args('validate'), productionTarget: 'z'.repeat(20) }, publisherEnv, {
    now: () => nowMs,
    readSource: source,
    loadTenantAuthorities: async () => { targetMismatchReads += 1; return tenantRows(); },
    loadPlatformAuthority: async () => { targetMismatchReads += 1; return platformAuthority(); }
  }), error => error.code === 'PRODUCTION_TARGET_MISMATCH');
  assert.equal(targetMismatchReads, 0, 'target mismatch fails before provider authority reads');

  let keyMismatchReads = 0;
  const otherPair = crypto.generateKeyPairSync('ed25519');
  const wrongPublicEnv = env({
    pair: keyPair,
    overrides: {
      PDL_RECOVERY_ATTESTATION_PUBLIC_KEY: otherPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    }
  });
  await assert.rejects(() => execute(args('publish', validated.attestationSha256), wrongPublicEnv, {
    now: () => nowMs,
    readSource: source,
    loadTenantAuthorities: async () => { keyMismatchReads += 1; return tenantRows(); },
    loadPlatformAuthority: async () => { keyMismatchReads += 1; return platformAuthority(); }
  }), error => error.code === 'SIGNING_KEY_MISMATCH');
  assert.equal(keyMismatchReads, 0, 'key mismatch fails before provider authority reads');

  let renderReads = 0;
  await assert.rejects(() => execute(args('publish', validated.attestationSha256), {
    ...publisherEnv,
    RENDER: 'true',
    RENDER_SERVICE_ID: 'srv-aaaaaaaaaaaaaaaaaaaa'
  }, {
    now: () => nowMs,
    readSource: source,
    loadTenantAuthorities: async () => { renderReads += 1; return tenantRows(); },
    loadPlatformAuthority: async () => { renderReads += 1; return platformAuthority(); }
  }), error => error.code === 'INDEPENDENT_RUNTIME_REQUIRED');
  assert.equal(renderReads, 0, 'publisher refuses to run on Render before provider reads');

  const storage = memoryStorage();
  const published = await execute(args('publish', validated.attestationSha256), publisherEnv, {
    now: () => nowMs,
    readSource: source,
    loadTenantAuthorities,
    loadPlatformAuthority,
    upload: storage.upload,
    download: storage.download
  });
  assert.deepEqual({
    status: published.status,
    writesPerformed: published.writesPerformed,
    pointerVerified: published.pointerVerified,
    immutableObjectVerified: published.immutableObjectVerified
  }, { status: 'verified', writesPerformed: true, pointerVerified: true, immutableObjectVerified: true });
  const uploads = storage.operations.filter(operation => operation.type === 'upload');
  assert.equal(uploads.length, 2);
  assert.match(uploads[0].objectKey, new RegExp(`^recovery-readiness/attestations/${validated.attestationSha256}\\.json$`));
  assert.equal(uploads[0].upsert, false, 'attestation upload is immutable');
  assert.equal(uploads[1].objectKey, 'recovery-readiness/current.json');
  assert.equal(uploads[1].upsert, true, 'only the pointer is mutable');
  const storedText = [...storage.objects.values()].map(value => value.toString('utf8')).join('\n');
  assert.equal(storedText.includes(companyA), false);
  assert.equal(storedText.includes('secret@example.com'), false);
  assert.equal(storedText.includes(publisherEnv.PDL_RECOVERY_ATTESTATION_PRIVATE_KEY), false);

  let corruptPointerWrites = 0;
  const corruptStorage = memoryStorage({
    download: async ({ objectKey, objects }) => {
      const bytes = objects.get(`tenant-backups/${objectKey}`);
      if (!bytes) return null;
      if (objectKey.startsWith('recovery-readiness/attestations/')) return response(Buffer.from(`${bytes.toString('utf8')} `));
      return response(bytes);
    },
    upload: async ({ objectKey }) => { if (objectKey === 'recovery-readiness/current.json') corruptPointerWrites += 1; }
  });
  await assert.rejects(() => execute(args('publish', validated.attestationSha256), publisherEnv, {
    now: () => nowMs,
    readSource: source,
    loadTenantAuthorities,
    loadPlatformAuthority,
    upload: corruptStorage.upload,
    download: corruptStorage.download
  }), error => error.code === 'IMMUTABLE_UPLOAD_MISMATCH');
  assert.equal(corruptPointerWrites, 0, 'pointer is never updated before immutable object verification');

  let authorityReads = 0;
  const driftStorage = memoryStorage();
  await assert.rejects(() => execute(args('publish', validated.attestationSha256), publisherEnv, {
    now: () => nowMs,
    readSource: source,
    loadTenantAuthorities: async () => {
      authorityReads += 1;
      return authorityReads === 1 ? tenantRows() : tenantRows(5);
    },
    loadPlatformAuthority,
    upload: driftStorage.upload,
    download: driftStorage.download
  }), error => error.code === 'authority_mismatch');
  assert.equal(authorityReads, 2, 'authority is checked both before and after pointer publication');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-readiness-source-'));
  try {
    const file = path.join(temp, 'source.json');
    fs.writeFileSync(file, JSON.stringify(source()));
    const fileValidated = await execute({ ...args('validate'), source: file }, publisherEnv, {
      now: () => nowMs,
      loadTenantAuthorities,
      loadPlatformAuthority
    });
    assert.equal(fileValidated.attestationSha256, validated.attestationSha256);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  const safe = sanitizedFailure(Object.assign(new Error(`leaked ${publisherEnv.PDL_RECOVERY_ATTESTATION_PRIVATE_KEY}`), { code: 'REMOTE_VERIFICATION_FAILED' }));
  assert.deepEqual(safe, {
    schema: 'pdl-recovery-readiness-publisher/v1',
    status: 'inconclusive',
    writesPerformed: null,
    reason: 'REMOTE_VERIFICATION_FAILED'
  });

  console.log('Recovery readiness publisher passed: exact target and authority checks precede immutable signed publication and verified pointer update.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
