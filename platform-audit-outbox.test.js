'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  assemblePlatformSnapshot,
  canonicalHash,
  splitPlatformSnapshot
} = require('./database/platform-repository');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-platform-audit-outbox-'));
const databaseFile = path.join(temporaryDirectory, 'db.json');
const platformFile = path.join(temporaryDirectory, 'platform.json');
const companyId = '11111111-1111-4111-8111-111111111111';
const platformToken = 'platform-audit-outbox-owner-session';
const tokenHash = value => crypto.createHash('sha256').update(value).digest('hex');
const now = new Date().toISOString();

const recoveredEvent = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  action: 'company_archive_recovery_probe',
  actorUserId: 'platform-owner',
  actorName: 'Platform Owner',
  actorRole: 'platform_owner',
  reason: 'Persisted before process restart',
  companyId,
  requestId: 'recovery-request',
  at: now
};

const tenant = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
tenant.company = {
  ...tenant.company,
  id: companyId,
  name: 'Outbox Concrete',
  features: { timeCards: false, templates: false },
  persistence: { revision: 3 }
};
tenant.platformAuditOutbox = [structuredClone(recoveredEvent)];
fs.writeFileSync(databaseFile, JSON.stringify(tenant, null, 2));

const platform = {
  users: [{
    id: 'platform-owner',
    name: 'Platform Owner',
    email: 'platform-owner@example.invalid',
    role: 'platform_owner',
    status: 'Active',
    mustSetPassword: false
  }],
  sessions: [{
    id: crypto.randomUUID(),
    userId: 'platform-owner',
    tokenHash: tokenHash(platformToken),
    createdAt: now,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
  }],
  auditEvents: [{
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    action: 'platform_seeded',
    actorName: 'System',
    actorRole: 'system',
    reason: 'Preserve the array collection through repository assembly',
    companyId: null,
    requestId: null,
    at: now
  }],
  helpItems: [{
    id: 'test-help',
    title: 'Test help seed',
    type: 'article',
    audience: 'all',
    category: 'Test',
    summary: 'Keeps the repository collection present in this focused fixture.',
    content: 'Test only.',
    url: '',
    status: 'Published',
    order: 1,
    createdAt: now,
    updatedAt: now
  }],
  supportGrants: [],
  growthOpportunities: [],
  supportTickets: [],
  followUps: [],
  onboardingOrders: []
};
fs.writeFileSync(platformFile, JSON.stringify(platform, null, 2));

Object.assign(process.env, {
  NODE_ENV: 'production',
  PDL_REQUIRE_AUTH: '1',
  PDL_DB_FILE: databaseFile,
  PDL_PLATFORM_FILE: platformFile,
  PDL_SUPABASE_ENABLED: '1',
  SUPABASE_URL: 'https://platform-audit-outbox.invalid',
  SUPABASE_SECRET_KEY: 'synthetic-service-role-secret',
  PDL_TRANSACTIONAL_DB: 'primary',
  PDL_PLATFORM_TRANSACTIONAL_DB: 'primary',
  PDL_EMAIL_DEV_MODE: '1'
});

const supabase = require('./database/supabase');
supabase.loadLocalEnv = () => {};

let authoritativeTenant = structuredClone(tenant);
let tenantRevision = 7;
let tenantSaveCount = 0;
let platformRevision = 1;
let platformSnapshot = structuredClone(platform);
let remainingAuditConflicts = 0;
let observedCommittedTenantBeforeConflict = false;

function platformLoadResult() {
  const split = splitPlatformSnapshot(platformSnapshot);
  return {
    namespaceId: 'ignored-by-loader',
    revision: platformRevision,
    scalarData: split.scalarData,
    records: split.records,
    contentHash: canonicalHash(platformSnapshot),
    updatedAt: now,
    updatedBy: 'test'
  };
}

function response(payload) {
  return { json: async () => structuredClone(payload) };
}

supabase.request = async (url, options) => {
  const input = JSON.parse(options.body);
  if (url.endsWith('/load_platform_repository')) return response(platformLoadResult());
  if (!url.endsWith('/replace_platform_repository')) throw new Error(`Unexpected Supabase request: ${url}`);

  const candidate = assemblePlatformSnapshot(
    input.p_scalar_data,
    input.p_records.map(row => ({
      collection: row.collection,
      recordKey: row.record_key,
      position: row.position,
      data: row.data
    }))
  );
  assert.equal(canonicalHash(candidate), input.p_content_hash, 'the platform repository write is integrity protected');

  const writesFeatureAudit = (candidate.auditEvents || []).some(row => row.action === 'time_cards_enabled');
  if (writesFeatureAudit && remainingAuditConflicts > 0) {
    remainingAuditConflicts -= 1;
    assert.equal(authoritativeTenant.company.features.timeCards, true, 'the customer mutation commits before platform audit delivery');
    assert.equal(authoritativeTenant.platformAuditOutbox?.length, 1, 'the committed tenant retains the undelivered audit');
    observedCommittedTenantBeforeConflict = true;
    platformSnapshot = { ...structuredClone(platformSnapshot), externalConflictRevision: platformRevision + 1 };
    platformRevision += 1;
    const error = new Error(`Supabase request failed (409): PDL_PLATFORM_REVISION_CONFLICT expected=${input.p_expected_revision} actual=${platformRevision}`);
    error.code = '40001';
    throw error;
  }

  if (input.p_expected_revision !== platformRevision) {
    const error = new Error(`Supabase request failed (409): PDL_PLATFORM_REVISION_CONFLICT expected=${input.p_expected_revision} actual=${platformRevision}`);
    error.code = '40001';
    throw error;
  }
  platformSnapshot = structuredClone(candidate);
  platformRevision += 1;
  return response({
    revision: platformRevision,
    recordCount: input.p_records.length,
    contentHash: input.p_content_hash,
    updatedAt: new Date().toISOString()
  });
};

supabase.loadTransactionalSnapshot = async id => String(id) === companyId
  ? { snapshot: structuredClone(authoritativeTenant), revision: tenantRevision }
  : null;
supabase.saveTransactionalSnapshot = async (snapshot, expectedRevision) => {
  assert.equal(expectedRevision, tenantRevision, 'tenant writes use optimistic concurrency');
  authoritativeTenant = structuredClone(snapshot);
  tenantRevision += 1;
  tenantSaveCount += 1;
  return { revision: tenantRevision, contentHash: canonicalHash(snapshot), records: 1 };
};
supabase.listTransactionalSnapshots = async () => [{
  companyId,
  snapshot: structuredClone(authoritativeTenant),
  revision: tenantRevision,
  contentHash: canonicalHash(authoritativeTenant)
}];
supabase.listCompanySnapshots = async () => [];
supabase.saveCompanySnapshot = async () => true;
supabase.createVerifiedBackup = async snapshot => {
  const bytes = Buffer.from(JSON.stringify(snapshot));
  return {
    bucket: 'tenant-backups',
    objectKey: `${snapshot.company.id}/audit-outbox-test.json`,
    hash: crypto.createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    verifiedAt: new Date().toISOString()
  };
};
supabase.upload = async () => ({});

const {
  initializePlatformPersistence,
  retryPendingPlatformAudits,
  server
} = require('./server');

function auditEvents(id) {
  return (platformSnapshot.auditEvents || []).filter(row => row.id === id);
}

(async () => {
  await initializePlatformPersistence();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const recovered = await retryPendingPlatformAudits();
    assert.deepEqual(recovered, { delivered: 1, failed: 0 });
    assert.equal(auditEvents(recoveredEvent.id).length, 1, 'a persisted pre-restart audit is recovered exactly once');
    assert.equal(authoritativeTenant.platformAuditOutbox, undefined, 'recovery clears the persisted outbox only after audit persistence');

    remainingAuditConflicts = 4;
    const responseFromMutation = await fetch(`${base}/api/platform/companies/${companyId}/features`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${platformToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ timeCards: true })
    });
    const mutationResult = await responseFromMutation.json();
    assert.equal(responseFromMutation.status, 200, JSON.stringify(mutationResult));
    assert.equal(mutationResult.timeCards, true);
    assert.equal(observedCommittedTenantBeforeConflict, true, 'the forced platform conflict happened after the tenant commit');
    assert.equal(remainingAuditConflicts, 0, 'audit delivery exhausted its bounded immediate retries');
    assert.equal(authoritativeTenant.company.features.timeCards, true, 'the successful customer mutation is never rolled back or misreported');
    assert.equal(authoritativeTenant.platformAuditOutbox?.length, 1, 'failed audit delivery remains durably queued');
    assert.equal((platformSnapshot.auditEvents || []).filter(row => row.action === 'time_cards_enabled').length, 0, 'a failed CAS attempt never creates a partial audit');

    const pendingFeatureAudit = structuredClone(authoritativeTenant.platformAuditOutbox[0]);
    const savesBeforeRecovery = tenantSaveCount;
    const retried = await retryPendingPlatformAudits();
    assert.deepEqual(retried, { delivered: 1, failed: 0 });
    assert.equal(tenantSaveCount, savesBeforeRecovery + 1, 'successful delivery durably clears the tenant outbox');
    assert.equal(authoritativeTenant.platformAuditOutbox, undefined);
    assert.equal(auditEvents(pendingFeatureAudit.id).length, 1, 'the recovered audit is persisted once');

    // Simulate a crash after the platform audit commit but before the tenant
    // outbox clear. Recovery must recognize the same event ID and clear it
    // without appending a duplicate audit event.
    authoritativeTenant.platformAuditOutbox = [structuredClone(pendingFeatureAudit)];
    tenantRevision += 1;
    const replay = await retryPendingPlatformAudits();
    assert.deepEqual(replay, { delivered: 1, failed: 0 });
    assert.equal(authoritativeTenant.platformAuditOutbox, undefined);
    assert.equal(auditEvents(pendingFeatureAudit.id).length, 1, 'outbox replay is idempotent by event ID');

    const persistedMirror = JSON.parse(fs.readFileSync(databaseFile, 'utf8'));
    assert.equal(persistedMirror.company.features.timeCards, true);
    assert.equal(persistedMirror.platformAuditOutbox, undefined, 'the local recovery mirror also reflects the cleared outbox');

    console.log('Platform audit outbox passed: tenant success stays truthful across platform CAS conflicts, recovery is durable, and replay is idempotent.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
