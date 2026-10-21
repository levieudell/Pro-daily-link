'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  TARGET_COMPANY_ID,
  SURVIVING_COMPANY_ID,
  CONFIRMATION,
  opaqueCompanyRef,
  parseArgs,
  execute
} = require('./legacy-normalized-artifact-quarantine');

const PROJECT_REF = 'abcdefghijklmnopqrst';
const SERVICE_ID = 'srv-abcdefghijklmnopqrst';
const INSTANCE_ID = 'artifact-quarantine-instance';
const RELEASE_SHA = 'a'.repeat(40);
const ARCHIVE_AT = '2026-10-20T18:00:00.000Z';
const DIGESTS = Object.freeze({
  preimage: '1'.repeat(64),
  preserved: '2'.repeat(64),
  survivor: '3'.repeat(64),
  archive: '4'.repeat(64),
  archivedPreimage: '5'.repeat(64)
});

function environment(overrides = {}) {
  return {
    NODE_ENV: 'production',
    PDL_SUPABASE_ENABLED: '1',
    SUPABASE_URL: `https://${PROJECT_REF}.supabase.co`,
    SUPABASE_SECRET_KEY: 'test-secret-that-must-never-be-written',
    PDL_PRODUCTION_SUPABASE_PROJECT_REF: PROJECT_REF,
    PDL_TRANSACTIONAL_DB: 'shadow',
    PDL_MAINTENANCE_MODE: '1',
    RENDER: 'true',
    RENDER_SERVICE_TYPE: 'web',
    RENDER_SERVICE_ID: SERVICE_ID,
    RENDER_INSTANCE_ID: INSTANCE_ID,
    RENDER_EXTERNAL_URL: 'https://pro-daily-link-demo.onrender.com',
    RENDER_GIT_COMMIT: RELEASE_SHA,
    IS_PULL_REQUEST: 'false',
    PORT: '10000',
    ...overrides
  };
}

function artifactState({ archived = false, preserved = DIGESTS.preserved, archive = DIGESTS.archive } = {}) {
  return {
    schema: 'pdl-legacy-normalized-artifact-state/v1',
    targetRef: opaqueCompanyRef(TARGET_COMPANY_ID),
    survivingTenantRef: opaqueCompanyRef(SURVIVING_COMPANY_ID),
    classification: archived ? 'archived-quarantine' : 'malformed-empty',
    readyForQuarantine: !archived,
    archiveSnapshotExact: archived,
    preimageSha256: archived ? DIGESTS.archivedPreimage : DIGESTS.preimage,
    preservedRowsSha256: preserved,
    survivorSnapshotSha256: DIGESTS.survivor,
    archiveDataSha256: archive,
    counts: {
      memberships: 1, publicUsers: 1, customers: 5, projects: 6, teamMembers: 8,
      reports: 5, assignments: 4, unexpectedScoped: 0, privateOrTransactional: 0,
      storageObjects: 0, crossTenantReferences: 0, externalSnapshotReferences: 0
    },
    identity: {
      activePublicUsers: 1, passwordHashesPresent: 0, authUsers: 0,
      otherMemberships: 0, ownerSnapshotMatches: 1, companyFieldsMatch: true
    },
    coverage: { customers: 5, projects: 6, teamMembers: 8, reports: 5, assignments: 4 },
    survivorCounts: { users: 2, customers: 5, projects: 6, teamMembers: 9, reports: 6, assignments: 4 }
  };
}

function response(payload) {
  return { ok: true, status: 200, async json() { return structuredClone(payload); } };
}

function transport({ mutation = 'success', before = artifactState(), after = artifactState({ archived: true }) } = {}) {
  let current = structuredClone(before);
  const calls = [];
  const request = async (relativePath, options = {}) => {
    calls.push({ relativePath, method: options.method, body: options.body ? JSON.parse(options.body) : null });
    if (relativePath === '/rest/v1/rpc/inspect_legacy_normalized_artifact') return response(current);
    if (relativePath === '/rest/v1/rpc/quarantine_legacy_normalized_artifact') {
      if (mutation === 'timeout-before') throw new TypeError('fetch failed before commit');
      current = structuredClone(after);
      if (mutation === 'timeout-after') throw new TypeError('fetch failed after commit');
      return response({
        status: 'quarantined',
        classification: 'archived-quarantine',
        targetRef: after.targetRef,
        survivingTenantRef: after.survivingTenantRef,
        preservedRowsSha256: after.preservedRowsSha256,
        archiveDataSha256: after.archiveDataSha256
      });
    }
    throw new Error(`unexpected request ${relativePath}`);
  };
  return { request, calls, get state() { return current; } };
}

function fenceApi({ changeAfter = Infinity, verified = true } = {}) {
  let reads = 0;
  return {
    requireVerifiedFence() {
      reads += 1;
      if (!verified) throw Object.assign(new Error('MAINTENANCE_FENCE_NOT_VERIFIED'), { code: 'MAINTENANCE_FENCE_NOT_VERIFIED' });
      return {
        digest: reads > changeAfter ? 'b'.repeat(64) : 'a'.repeat(64),
        openedAt: '2026-10-20T17:55:00.000Z',
        mode: 'read_only',
        source: 'environment_and_lock',
        identity: { provider: 'render', serviceId: SERVICE_ID, instanceId: INSTANCE_ID, releaseSha: RELEASE_SHA }
      };
    }
  };
}

function previewArgs(directory) {
  return parseArgs([
    '--evidence', path.join(directory, 'preview.json'),
    '--production-target', PROJECT_REF,
    '--expected-service-id', SERVICE_ID,
    '--expected-instance-id', INSTANCE_ID,
    '--target-company-id', TARGET_COMPANY_ID,
    '--surviving-company-id', SURVIVING_COMPANY_ID,
    '--archive-at', ARCHIVE_AT
  ]);
}

function applyArgs(directory, preview) {
  return parseArgs([
    '--apply',
    '--evidence', path.join(directory, 'apply.json'),
    '--production-target', PROJECT_REF,
    '--expected-service-id', SERVICE_ID,
    '--expected-instance-id', INSTANCE_ID,
    '--target-company-id', TARGET_COMPANY_ID,
    '--surviving-company-id', SURVIVING_COMPANY_ID,
    '--archive-at', ARCHIVE_AT,
    '--preview-evidence', path.join(directory, 'preview.json'),
    '--preview-sha256', preview.evidence.sha256,
    '--confirm-preview-sha256', preview.evidence.sha256,
    '--confirm-target-company-id', TARGET_COMPANY_ID,
    '--confirm-preimage-sha256', DIGESTS.preimage,
    '--confirm-preserved-rows-sha256', DIGESTS.preserved,
    '--confirm-archive-data-sha256', DIGESTS.archive,
    '--confirm-action', CONFIRMATION
  ]);
}

function workspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-artifact-quarantine-'));
}

const dependencies = extra => ({
  verifyAttachedRuntime: async () => true,
  maintenanceFence: fenceApi(),
  ...extra
});

test('preview is read-only, double-reads, and writes sanitized immutable preimage evidence', async () => {
  const directory = workspace();
  const remote = transport();
  const result = await execute(previewArgs(directory), environment(), dependencies({ request: remote.request }));
  assert.equal(result.status, 'ready');
  assert.equal(result.writesPerformed, false);
  assert.equal(remote.calls.length, 2);
  assert.ok(remote.calls.every(call => call.relativePath.endsWith('inspect_legacy_normalized_artifact')));
  const bytes = fs.readFileSync(path.join(directory, 'preview.json'), 'utf8');
  assert.equal(bytes.includes(TARGET_COMPANY_ID), false);
  assert.equal(bytes.includes(SURVIVING_COMPANY_ID), false);
  assert.equal(bytes.includes('test-secret-that-must-never-be-written'), false);
  assert.equal(JSON.parse(bytes).preimage.companyDataCanonical, '{}');
  assert.equal(fs.readFileSync(path.join(directory, 'preview.json.sha256'), 'utf8'), `${result.evidence.sha256}\n`);
});

test('apply requires reviewed evidence, exact confirmations, a stable fence, CAS RPC, and two post-write reads', async () => {
  const directory = workspace();
  const previewRemote = transport();
  const preview = await execute(previewArgs(directory), environment(), dependencies({ request: previewRemote.request }));
  const applyRemote = transport();
  const result = await execute(applyArgs(directory, preview), environment(), dependencies({ request: applyRemote.request }));
  assert.equal(result.status, 'verified');
  assert.equal(result.after.classification, 'archived-quarantine');
  assert.equal(result.after.preservedRowsSha256, DIGESTS.preserved);
  assert.equal(result.outcomeRecoveredAfterError, false);
  assert.equal(applyRemote.calls.filter(call => call.relativePath.endsWith('inspect_legacy_normalized_artifact')).length, 4);
  assert.equal(applyRemote.calls.filter(call => call.relativePath.endsWith('quarantine_legacy_normalized_artifact')).length, 1);
  const mutation = applyRemote.calls.find(call => call.relativePath.endsWith('quarantine_legacy_normalized_artifact'));
  assert.deepEqual(mutation.body, {
    p_archived_at: ARCHIVE_AT,
    p_expected_preimage_sha256: DIGESTS.preimage,
    p_expected_preserved_rows_sha256: DIGESTS.preserved,
    p_expected_archive_data_sha256: DIGESTS.archive,
    p_confirmation: CONFIRMATION
  });
});

test('wrong UUIDs and missing digest confirmations fail argument parsing', () => {
  const directory = workspace();
  const base = [
    '--evidence', path.join(directory, 'preview.json'), '--production-target', PROJECT_REF,
    '--expected-service-id', SERVICE_ID, '--expected-instance-id', INSTANCE_ID,
    '--target-company-id', '11111111-1111-4111-8111-111111111111',
    '--surviving-company-id', SURVIVING_COMPANY_ID, '--archive-at', ARCHIVE_AT
  ];
  assert.throws(() => parseArgs(base), /guarded artifact UUID/);
});

test('apply refuses an unverified maintenance fence before dispatch', async () => {
  const directory = workspace();
  const previewRemote = transport();
  const preview = await execute(previewArgs(directory), environment(), dependencies({ request: previewRemote.request }));
  const applyRemote = transport();
  await assert.rejects(
    execute(applyArgs(directory, preview), environment(), dependencies({
      request: applyRemote.request,
      maintenanceFence: fenceApi({ verified: false })
    })),
    error => error.code === 'MAINTENANCE_FENCE_NOT_VERIFIED'
  );
  assert.equal(applyRemote.calls.length, 0);
});

test('apply refuses a different maintenance fence than the reviewed preview', async () => {
  const directory = workspace();
  const preview = await execute(previewArgs(directory), environment(), dependencies({ request: transport().request }));
  const applyRemote = transport();
  const differentFence = {
    requireVerifiedFence() {
      return {
        digest: '9'.repeat(64),
        openedAt: '2026-10-20T17:56:00.000Z',
        mode: 'read_only',
        source: 'environment_and_lock',
        identity: { provider: 'render', serviceId: SERVICE_ID, instanceId: INSTANCE_ID, releaseSha: RELEASE_SHA }
      };
    }
  };
  await assert.rejects(
    execute(applyArgs(directory, preview), environment(), dependencies({
      request: applyRemote.request,
      maintenanceFence: differentFence
    })),
    error => error.code === 'PREVIEW_FENCE_MISMATCH'
  );
  assert.equal(applyRemote.calls.length, 0);
});

test('preview refuses a configured Supabase project mismatch', async () => {
  const directory = workspace();
  const remote = transport();
  await assert.rejects(
    execute(previewArgs(directory), environment({
      SUPABASE_URL: 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co'
    }), dependencies({ request: remote.request })),
    error => error.code === 'PRODUCTION_TARGET_MISMATCH'
  );
  assert.equal(remote.calls.length, 0);
});

test('preview fails closed when the structural safety proof drifts', async () => {
  const directory = workspace();
  const unsafe = artifactState();
  unsafe.counts.projects = 7;
  unsafe.readyForQuarantine = false;
  const remote = transport({ before: unsafe });
  await assert.rejects(
    execute(previewArgs(directory), environment(), dependencies({ request: remote.request })),
    error => error.code === 'ARTIFACT_NOT_SAFE_TO_QUARANTINE'
  );
  assert.equal(fs.existsSync(path.join(directory, 'preview.json')), false);
});

test('apply refuses state drift since preview without dispatching mutation', async () => {
  const directory = workspace();
  const preview = await execute(previewArgs(directory), environment(), dependencies({ request: transport().request }));
  const drifted = artifactState();
  drifted.survivorSnapshotSha256 = '6'.repeat(64);
  const remote = transport({ before: drifted });
  await assert.rejects(
    execute(applyArgs(directory, preview), environment(), dependencies({ request: remote.request })),
    error => error.code === 'ARTIFACT_CHANGED_SINCE_PREVIEW'
  );
  assert.equal(remote.calls.some(call => call.relativePath.endsWith('quarantine_legacy_normalized_artifact')), false);
});

test('ambiguous response after commit is recovered only by two exact archived reads', async () => {
  const directory = workspace();
  const preview = await execute(previewArgs(directory), environment(), dependencies({ request: transport().request }));
  const remote = transport({ mutation: 'timeout-after' });
  const result = await execute(applyArgs(directory, preview), environment(), dependencies({ request: remote.request }));
  assert.equal(result.status, 'verified');
  assert.equal(result.outcomeRecoveredAfterError, true);
  assert.ok(remote.calls.filter(call => call.relativePath.endsWith('inspect_legacy_normalized_artifact')).length >= 6);
});

test('ambiguous response before commit is inconclusive and never reported as success', async () => {
  const directory = workspace();
  const preview = await execute(previewArgs(directory), environment(), dependencies({ request: transport().request }));
  const remote = transport({ mutation: 'timeout-before' });
  await assert.rejects(
    execute(applyArgs(directory, preview), environment(), dependencies({ request: remote.request })),
    error => error.code === 'WRITE_OUTCOME_UNKNOWN' && /^[a-f0-9]{64}$/.test(error.evidenceSha256)
  );
  const evidence = JSON.parse(fs.readFileSync(path.join(directory, 'apply.json'), 'utf8'));
  assert.equal(evidence.status, 'inconclusive');
  assert.equal(evidence.writesPerformed, null);
  assert.equal(evidence.writeOutcome, 'outcome-unproven');
});

test('a changed maintenance fence aborts before mutation', async () => {
  const directory = workspace();
  const preview = await execute(previewArgs(directory), environment(), dependencies({ request: transport().request }));
  const remote = transport();
  await assert.rejects(
    execute(applyArgs(directory, preview), environment(), dependencies({
      request: remote.request,
      maintenanceFence: fenceApi({ changeAfter: 1 })
    })),
    error => error.code === 'MAINTENANCE_FENCE_CHANGED'
  );
  assert.equal(remote.calls.some(call => call.relativePath.endsWith('quarantine_legacy_normalized_artifact')), false);
});
