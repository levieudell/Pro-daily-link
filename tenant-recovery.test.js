'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canonicalHash } = require('./database/transactional-repository');
const { createPortableBackup, validateTenantRestoreSnapshot, validateTenantFinalRestoreSnapshot } = require('./database/portable-backup');
const { parseArgs, execute, prepareTenantRestore, sanitizedCliFailure, sanitizedCliResult } = require('./database/tenant-recovery');

const companyId = '11111111-1111-4111-8111-111111111111';
const productionRef = 'p'.repeat(20);
const disposableRef = 'd'.repeat(20);
const serviceId = `srv-${'a'.repeat(20)}`;
const instanceId = 'instance-recovery-01';
const oid = (bucket, key) => `${bucket}/${key}`;
const response = (bytes, contentType = 'application/octet-stream') => ({ arrayBuffer: async () => Buffer.from(bytes), headers: { get: () => contentType } });
const missing = key => Object.assign(new Error(`Object not found: ${key}`), { statusCode: 404 });

const productionEnv = {
  PDL_SUPABASE_ENABLED: '1', SUPABASE_URL: `https://${productionRef}.supabase.co`,
  PDL_PRODUCTION_SUPABASE_PROJECT_REF: productionRef, PDL_DISPOSABLE_SUPABASE_PROJECT_REF: disposableRef,
  PDL_TRANSACTIONAL_DB: 'primary', PDL_MAINTENANCE_MODE: '1', NODE_ENV: 'production', RENDER: 'true',
  RENDER_SERVICE_TYPE: 'web', RENDER_SERVICE_ID: serviceId, RENDER_INSTANCE_ID: instanceId,
  RENDER_GIT_COMMIT: 'a'.repeat(40), IS_PULL_REQUEST: 'false'
};
const disposableEnv = {
  PDL_SUPABASE_ENABLED: '1', SUPABASE_URL: `https://${disposableRef}.supabase.co`,
  PDL_PRODUCTION_SUPABASE_PROJECT_REF: productionRef, PDL_DISPOSABLE_SUPABASE_PROJECT_REF: disposableRef,
  PDL_TRANSACTIONAL_DB: 'primary', PDL_MAINTENANCE_MODE: '1', NODE_ENV: 'test', RENDER: 'false'
};
const fence = {
  active: true, enforced: true, environmentEnabled: true, verified: true, mode: 'global-read-only',
  source: 'environment_and_lock', digest: 'f'.repeat(64), openedAt: '2026-10-20T12:00:00.000Z',
  identity: { provider: 'render', serviceId, instanceId, releaseSha: 'a'.repeat(40) }
};
const changedFence = { ...fence, digest: 'e'.repeat(64), openedAt: '2026-10-20T12:01:00.000Z' };
const stableFenceApi = { requireVerifiedFence: () => structuredClone(fence) };
function sequenceFenceApi(states) {
  let calls = 0;
  return { get calls() { return calls; }, requireVerifiedFence() { const value = states[Math.min(calls++, states.length - 1)]; if (value instanceof Error) throw value; return structuredClone(value); } };
}

function memoryStorage(initial = {}, hooks = {}) {
  const objects = new Map(Object.entries(initial).map(([key, value]) => [key, Buffer.from(value)]));
  const calls = { download: 0, upload: 0, remove: 0 };
  return {
    objects, calls,
    async download(bucket, objectKey) {
      calls.download += 1;
      if (hooks.download) await hooks.download({ bucket, objectKey, calls, objects });
      const bytes = objects.get(oid(bucket, objectKey));
      if (!bytes) throw missing(objectKey);
      return response(bytes, objectKey.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
    },
    async upload(bucket, objectKey, bytes, _contentType, upsert) {
      calls.upload += 1;
      if (hooks.upload) { const handled = await hooks.upload({ bucket, objectKey, bytes: Buffer.from(bytes), upsert, calls, objects }); if (handled?.handled) return handled.value; }
      const key = oid(bucket, objectKey);
      if (objects.has(key) && !upsert) throw Object.assign(new Error('object already exists'), { statusCode: 409 });
      objects.set(key, Buffer.from(bytes));
      return { bucket, objectKey };
    },
    async remove(bucket, objectKey) {
      calls.remove += 1;
      if (hooks.remove) { const handled = await hooks.remove({ bucket, objectKey, calls, objects }); if (handled?.handled) return handled.value; }
      objects.delete(oid(bucket, objectKey));
      return true;
    }
  };
}

function memoryRepository(snapshot, initialRevision = 9, hooks = {}) {
  let state = snapshot ? { snapshot: structuredClone(snapshot), revision: initialRevision, contentHash: canonicalHash(snapshot) } : null;
  let saveCalls = 0, loadCalls = 0;
  return {
    get saveCalls() { return saveCalls; }, get loadCalls() { return loadCalls; }, get state() { return state ? structuredClone(state) : null; },
    async load(id) {
      loadCalls += 1; assert.equal(id, companyId);
      if (hooks.load) { const handled = await hooks.load({ loadCalls, state: state ? structuredClone(state) : null }); if (handled?.handled) return handled.value; }
      return state ? structuredClone(state) : null;
    },
    async save(next, { expectedRevision }) {
      saveCalls += 1;
      if (hooks.save) { const handled = await hooks.save({ next: structuredClone(next), expectedRevision, state: state ? structuredClone(state) : null }); if (handled?.handled) return handled.value; }
      const actual = state?.revision || 0;
      if (actual !== expectedRevision) throw new Error('PDL_REVISION_CONFLICT');
      state = { snapshot: structuredClone(next), revision: actual + 1, contentHash: canonicalHash(next) };
      return structuredClone(state);
    }
  };
}

function restoreArgs(backup, preRestoreOutput, manifestHash, current, expectedRevision = 9, overrides = {}) {
  return {
    command: 'restore', companyId, confirmCompanyId: companyId, backup, preRestoreOutput, output: '', apply: true,
    expectedRevision, expectedContentHash: canonicalHash(current), expectedManifestSha256: manifestHash,
    expectedServiceId: '', expectedInstanceId: '', productionTarget: '', disposableTarget: disposableRef, ...overrides
  };
}
function productionRestoreArgs(backup, preRestoreOutput, manifestHash, current, expectedRevision = 9, overrides = {}) {
  return restoreArgs(backup, preRestoreOutput, manifestHash, current, expectedRevision, {
    disposableTarget: '', productionTarget: productionRef, expectedServiceId: serviceId, expectedInstanceId: instanceId, ...overrides
  });
}

assert.deepEqual(parseArgs(['restore-preview', '--company-id', companyId, '--backup', 'D:\\one', '--expected-manifest-sha256', 'a'.repeat(64)]), {
  command: 'restore-preview', companyId, output: '', backup: 'D:\\one', preRestoreOutput: '', apply: false,
  expectedRevision: null, expectedManifestSha256: 'a'.repeat(64), expectedContentHash: '', expectedServiceId: '',
  expectedInstanceId: '', productionTarget: '', disposableTarget: '', confirmCompanyId: ''
});
assert.throws(() => parseArgs(['restore-preview', '--company-id', companyId, '--backup', 'x']), /expected-manifest/);
assert.throws(() => parseArgs(['restore', '--company-id', companyId, '--backup', 'x', '--expected-manifest-sha256', 'a'.repeat(64)]), /without --apply/);
assert.throws(() => parseArgs(['verify', '--company-id', 'legacy-name', '--backup', 'x']), /database UUID/);
assert.throws(() => parseArgs(['export', '--company-id', companyId, '--output', 'x']), /exactly one/);
assert.throws(() => parseArgs(['export', '--company-id', companyId, '--output', 'x', '--disposable-target', disposableRef, '--expected-service-id', serviceId, '--expected-instance-id', instanceId]), /Render identity/);
assert.throws(() => parseArgs(['verify', '--company-id', companyId, '--backup', 'x', '--expected-service-id', serviceId, '--expected-instance-id', instanceId]), /Render identity/);
assert.throws(() => parseArgs(['verify', '--company-id', companyId, '--backup', 'x', '--unknown']), /Unsupported tenant recovery argument/);
assert.equal(sanitizedCliFailure(new Error('TENANT_RECOVERY_PRODUCTION_TARGET_MISMATCH')).code, 'PDL_TENANT_RECOVERY_TARGET');
assert.equal(sanitizedCliFailure(new Error('MAINTENANCE_FENCE_CHANGED')).code, 'PDL_TENANT_RECOVERY_FENCE');
assert.equal(sanitizedCliFailure(new Error('rollback conflict')).code, 'PDL_TENANT_RECOVERY_OUTCOME_UNKNOWN');
const tenantPostCommitFailure = Object.assign(new Error('do not expose provider detail'), { code: 'PDL_TENANT_RECOVERY_POST_COMMIT_RECONCILIATION_REQUIRED' });
assert.deepEqual(sanitizedCliFailure(tenantPostCommitFailure), {
  ok: false,
  code: 'PDL_TENANT_RECOVERY_POST_COMMIT_RECONCILIATION_REQUIRED',
  message: 'Tenant recovery committed repository state, but final verification did not complete. Do not retry automatically; use the retained evidence for manual reconciliation.'
});

const identityRestoreTime = '2026-10-20T12:29:00.000Z';
const tenantIdentitySource = {
  company: {
    id: companyId, name: 'Historical Identity Builders',
    pricingAccess: { enabled: true, officeMode: 'all', userIds: [1, 2, 3] },
    plan: 'pro', billingCycle: 'annual', planPrice: 3990, billingExempt: true,
    accountType: 'legacy', subscriptionStatus: 'Active', trialEndsAt: '2030-01-01T00:00:00.000Z',
    stripeCustomerId: 'cus_stale', stripeSubscriptionId: 'sub_stale', stripeCheckoutSessionId: 'cs_stale',
    stripeTrialUsed: false, stripeFreePeriod: { subscriptionId: 'sub_stale', end: 2000000000 },
    retiredStripeSubscriptionIds: ['sub_very_old'], stripeWebhookEvents: ['evt_old'],
    pendingCheckout: { id: 'cs_stale', status: 'open' }, founder: { requested: true }, demo: true,
    platformGrowthSync: { status: 'pending', requestedAt: '2020-01-01T00:00:00.000Z' },
    legalAcceptance: { acceptedAt: '2020-01-01T00:00:00.000Z', version: 'old', email: 'old@example.test' },
    emailVerificationRequiredAt: '2020-01-01T00:00:00.000Z', archivedDuplicate: false,
    closureHold: false, deletionRequest: { id: 'old-request', status: 'Cancelled' }
  },
  users: [
    { id: 1, email: 'worker@example.test', role: 'owner', status: 'Active', passwordHash: 'old-password', passwordSalt: 'old-salt', resetTokenHash: 'old-reset' },
    { id: 2, email: 'former-owner@example.test', role: 'owner', status: 'Active', passwordHash: 'former-password', passwordSalt: 'former-salt', setupHash: 'former-setup' },
    { id: 3, email: 'manager@example.test', role: 'owner', status: 'Active', passwordHash: 'old-manager-password' }
  ],
  sessions: [{ userId: 1, tokenHash: 'old-session' }]
};
const tenantIdentityCurrent = {
  company: {
    id: companyId, name: 'Current Identity Builders',
    pricingAccess: { enabled: true, officeMode: 'selected', userIds: [30] },
    plan: 'growth', billingCycle: 'monthly', planPrice: 199, billingExempt: false,
    accountType: 'standard', subscriptionStatus: 'Cancelled', trialEndsAt: null,
    stripeCustomerId: 'cus_current', stripeSubscriptionId: 'sub_current', stripeTrialUsed: true,
    retiredStripeSubscriptionIds: ['sub_stale'], stripeWebhookEvents: ['evt_current'],
    pendingCheckout: { id: 'cs_current', status: 'creating' }, founder: { requested: false }, demo: false,
    platformGrowthSync: { status: 'synced', syncedAt: '2026-10-20T00:00:00.000Z' },
    legalAcceptance: { acceptedAt: '2026-10-01T00:00:00.000Z', version: '2026-10', email: 'owner@example.test' },
    emailVerificationRequiredAt: '2026-10-20T00:00:00.000Z', archivedDuplicate: true,
    archivedAt: '2026-10-19T00:00:00.000Z', closureHold: true,
    deletionRequest: { id: 'current-request', status: 'Recovery hold', legalHold: true, holdEndsAt: '2026-11-20T00:00:00.000Z' }
  },
  users: [
    { id: 1, email: 'worker@example.test', role: 'field', status: 'Deactivated', passwordHash: 'rotated-password', passwordSalt: 'rotated-salt', resetTokenHash: 'current-reset', permissions: {} },
    { id: 30, email: 'MANAGER@example.test', role: 'project_manager', status: 'Active', passwordHash: 'current-manager-password', passwordSalt: 'current-manager-salt', projectIds: [91], assignedCrews: ['Crew Safe'], permissions: { approveDailies: false } },
    { id: 4, email: 'current-owner@example.test', role: 'owner', status: 'Active', passwordHash: 'current-owner-password', passwordSalt: 'current-owner-salt' }
  ],
  sessions: [{ userId: 4, tokenHash: 'current-session' }]
};
const tenantIdentityRestored = prepareTenantRestore(tenantIdentitySource, tenantIdentityCurrent, identityRestoreTime);
assert.deepEqual(tenantIdentityRestored.sessions, [], 'all bearer sessions are revoked across recovery');
const restoredWorker = tenantIdentityRestored.users.find(user => user.id === 1);
assert.equal(restoredWorker.role, 'field');
assert.equal(restoredWorker.status, 'Deactivated', 'a scoped live user cannot be reactivated against historical scope');
assert.equal(restoredWorker.recoveryDeactivationReason, 'historical-scope-reconciliation-required');
assert.equal('passwordHash' in restoredWorker, false, 'quarantined scoped identities have no usable credential');
assert.equal('permissions' in restoredWorker, false, 'quarantined scoped identities retain no authorization payload');
assert.equal('resetTokenHash' in restoredWorker, false, 'transient live recovery tokens are revoked too');
const restoredFormerOwner = tenantIdentityRestored.users.find(user => user.id === 2);
assert.equal(restoredFormerOwner.status, 'Deactivated', 'a backup-only former owner is not restored as active');
assert.equal(restoredFormerOwner.recoveryAccessState, 'reenrollment-required');
assert.equal('passwordHash' in restoredFormerOwner, false, 'backup-only identities have no usable credential');
assert.equal('setupHash' in restoredFormerOwner, false);
const restoredManager = tenantIdentityRestored.users.find(user => user.id === 30);
assert.equal(restoredManager.id, 30, 'canonical email still resolves the live principal whose numeric ID changed');
assert.equal(restoredManager.role, 'project_manager');
assert.equal(restoredManager.status, 'Deactivated');
assert.equal(restoredManager.recoveryDeactivationReason, 'historical-scope-reconciliation-required');
assert.equal('passwordHash' in restoredManager, false);
assert.equal('projectIds' in restoredManager, false);
assert.equal('assignedCrews' in restoredManager, false);
assert.equal('permissions' in restoredManager, false);
const restoredCurrentOwner = tenantIdentityRestored.users.find(user => user.id === 4);
assert.equal(restoredCurrentOwner.email, 'current-owner@example.test', 'current-only owners survive a business-data rollback');
assert.equal(restoredCurrentOwner.status, 'Active');
assert.equal(restoredCurrentOwner.passwordHash, 'current-owner-password', 'the live break-glass owner credential moves forward');
assert.deepEqual(tenantIdentityRestored.company.pricingAccess, tenantIdentityCurrent.company.pricingAccess, 'live pricing authorization does not roll back');
for (const key of [
  'plan', 'billingCycle', 'planPrice', 'billingExempt', 'accountType', 'subscriptionStatus', 'trialEndsAt',
  'stripeCustomerId', 'stripeSubscriptionId', 'stripeTrialUsed', 'retiredStripeSubscriptionIds',
  'stripeWebhookEvents', 'pendingCheckout', 'founder', 'demo', 'emailVerificationRequiredAt',
  'platformGrowthSync', 'legalAcceptance', 'archivedDuplicate', 'archivedAt', 'closureHold', 'deletionRequest'
]) assert.deepEqual(tenantIdentityRestored.company[key], tenantIdentityCurrent.company[key], `${key} stays at the live control-plane value`);
const currentWithoutLegalOrGrowth = structuredClone(tenantIdentityCurrent);
delete currentWithoutLegalOrGrowth.company.legalAcceptance;
delete currentWithoutLegalOrGrowth.company.platformGrowthSync;
const noStaleLegalOrGrowth = prepareTenantRestore(tenantIdentitySource, currentWithoutLegalOrGrowth, identityRestoreTime);
assert.equal('legalAcceptance' in noStaleLegalOrGrowth.company, false, 'source-only legal acceptance is not revived');
assert.equal('platformGrowthSync' in noStaleLegalOrGrowth.company, false, 'source-only platform growth sync is not revived');
assert.equal('stripeCheckoutSessionId' in tenantIdentityRestored.company, false, 'a stale checkout identity absent from live state is not revived');
assert.equal('stripeFreePeriod' in tenantIdentityRestored.company, false, 'a stale free-period grant absent from live state is not revived');
const pastDueCompany = structuredClone(tenantIdentityCurrent);
pastDueCompany.company.subscriptionStatus = 'Past due';
pastDueCompany.company.stripeCustomerId = 'cus_past_due';
pastDueCompany.company.stripeSubscriptionId = 'sub_past_due';
const pastDueRestore = prepareTenantRestore(tenantIdentitySource, pastDueCompany, identityRestoreTime);
assert.equal(pastDueRestore.company.subscriptionStatus, 'Past due', 'recovery cannot reactivate a past-due workspace');
assert.equal(pastDueRestore.company.billingExempt, false);
assert.equal(pastDueRestore.company.demo, false);
assert.equal(pastDueRestore.company.stripeCustomerId, 'cus_past_due');
assert.equal(pastDueRestore.company.stripeSubscriptionId, 'sub_past_due');
assert.throws(() => prepareTenantRestore(
  { company: { id: companyId }, users: [{ id: 1, email: 'one@example.test' }] },
  { users: [{ id: 1, email: 'first@example.test' }, { id: 2, email: 'one@example.test' }] },
  identityRestoreTime
), /TENANT_RECOVERY_IDENTITY_AMBIGUOUS/, 'conflicting ID/email identity matches fail closed');

const legacyTenantSource = {
  company: { id: companyId, name: 'Legacy Recovery Builders' },
  users: [
    { id: 'owner', email: 'owner@legacy.example.test', role: 'owner', status: 'Active', passwordHash: 'stale-owner' },
    { id: 'guest', email: 'guest@legacy.example.test', role: 'guest', status: 'Active', passwordHash: 'stale-guest', apiToken: 'stale-token' },
    { id: 'import', email: 'import@legacy.example.test', role: 'unrecognized', status: 'Quarantined', credentialBlob: 'stale-credential' }
  ],
  sessions: [{ userId: 'guest', tokenHash: 'stale-session' }]
};
const legacyTenantCurrent = {
  company: { id: companyId, name: 'Current Recovery Builders' },
  users: [{ id: 'current-owner', email: 'current-owner@legacy.example.test', role: 'owner', status: 'Active', passwordHash: 'current-hash', passwordSalt: 'current-salt' }]
};
const safeLegacyTenantRestore = prepareTenantRestore(legacyTenantSource, legacyTenantCurrent, identityRestoreTime);
for (const historicalId of ['owner', 'guest', 'import']) {
  const historical = safeLegacyTenantRestore.users.find(user => user.id === historicalId);
  assert.equal(historical.status, 'Deactivated', `${historicalId} backup-only identity stays historical`);
  assert.equal(historical.mustSetPassword, true);
  assert.equal(historical.recoveryAccessState, 'reenrollment-required');
  assert.equal(Object.keys(historical).filter(key => key !== 'mustSetPassword').some(key => /password|credential|token|session/i.test(key)), false, `${historicalId} has no usable credential`);
}
assert.doesNotThrow(() => validateTenantRestoreSnapshot(safeLegacyTenantRestore), 'deactivated legacy identities remain structurally recoverable');
const matchedLegacyTenantRestore = prepareTenantRestore(legacyTenantSource, {
  ...legacyTenantCurrent,
  users: [
    legacyTenantCurrent.users[0],
    { id: 'guest', email: 'guest@legacy.example.test', role: 'field', status: 'Active', passwordHash: 'rotated-current', passwordSalt: 'rotated-salt', resetTokenHash: 'one-time-reset', projectIds: [91] }
  ]
}, identityRestoreTime);
const matchedLegacyTenant = matchedLegacyTenantRestore.users.find(user => user.id === 'guest');
assert.equal(matchedLegacyTenant.role, 'field', 'a current supported role replaces a matching legacy role');
assert.equal(matchedLegacyTenant.status, 'Deactivated', 'a matching scoped principal is quarantined until explicit scope reconciliation');
assert.equal(matchedLegacyTenant.recoveryDeactivationReason, 'historical-scope-reconciliation-required');
assert.equal('passwordHash' in matchedLegacyTenant, false);
assert.equal('projectIds' in matchedLegacyTenant, false);
assert.equal('resetTokenHash' in matchedLegacyTenant, false);
assert.throws(
  () => prepareTenantRestore(legacyTenantSource, {
    ...legacyTenantCurrent,
    users: [
      legacyTenantCurrent.users[0],
      { id: 'guest', email: 'guest@legacy.example.test', role: 'guest', status: 'Active', passwordHash: 'current-guest', passwordSalt: 'current-guest-salt' }
    ]
  }, identityRestoreTime),
  /unsupported role/,
  'the merge itself rejects an unknown current role before callers can persist it'
);

const scopeCollisionSource = {
  company: { id: companyId, name: 'Historical Scope Builders' },
  users: [
    { id: 'source-owner', email: 'source-owner@scope.example.test', role: 'owner', status: 'Active', passwordHash: 'stale-owner' },
    { id: 'matching-field', email: 'field@scope.example.test', role: 'field', status: 'Active', memberId: 7, passwordHash: 'stale-field' },
    { id: 'matching-foreman', email: 'foreman@scope.example.test', role: 'foreman', status: 'Active', memberId: 8, crew: 'Crew Reused', passwordHash: 'stale-foreman' },
    { id: 'matching-pm', email: 'pm@scope.example.test', role: 'project_manager', status: 'Active', projectIds: [44], assignedCrews: ['Crew Reused'], passwordHash: 'stale-pm' }
  ],
  sessions: [{ id: 'source-session', userId: 'matching-field', tokenHash: 'stale-session' }],
  team: [
    { id: 7, name: 'Historical Worker Reusing Current ID', crew: 'Crew Reused' },
    { id: 8, name: 'Same Display Name', crew: 'Crew Reused' }
  ],
  projects: [{ id: 44, name: 'Historical Project Reusing Current ID' }],
  crews: [{ id: 1, name: 'Crew Reused' }],
  assignments: [{ id: 1, projectId: 44, memberIds: [7, 8], crew: 'Crew Reused' }]
};
const scopedCredential = suffix => ({ passwordHash: `current-${suffix}-hash`, passwordSalt: `current-${suffix}-salt` });
const scopeCollisionCurrent = {
  company: { id: companyId, name: 'Current Scope Builders' },
  users: [
    { id: 'break-glass-owner', email: 'owner@scope.example.test', role: 'owner', status: 'Active', ...scopedCredential('owner') },
    { id: 'matching-field', email: 'field@scope.example.test', role: 'field', status: 'Active', memberId: 7, permissions: { fileDaily: true }, ...scopedCredential('matching-field') },
    { id: 'matching-foreman', email: 'foreman@scope.example.test', role: 'foreman', status: 'Active', memberId: 8, crew: 'Crew Reused', crewId: 1, ...scopedCredential('matching-foreman') },
    { id: 'matching-pm', email: 'pm@scope.example.test', role: 'project_manager', status: 'Active', projectIds: [44], assignedCrews: ['Crew Reused'], allowedProjectIds: [44], ...scopedCredential('matching-pm') },
    { id: 'current-only-field', email: 'new-field@scope.example.test', role: 'field', status: 'Active', memberId: 7, crewIds: [1], ...scopedCredential('current-only-field') },
    { id: 'current-only-foreman', email: 'new-foreman@scope.example.test', role: 'foreman', status: 'Active', memberId: 8, assignedCrewIds: [1], ...scopedCredential('current-only-foreman') },
    { id: 'current-only-pm', email: 'new-pm@scope.example.test', role: 'project_manager', status: 'Active', projectIds: [44], assignedCrews: ['Crew Reused'], permissions: { approveDailies: true }, ...scopedCredential('current-only-pm') }
  ],
  team: [
    { id: 7, name: 'Different Current Worker', crew: 'Crew Reused' },
    { id: 8, name: 'Same Display Name', crew: 'Crew Reused' }
  ],
  projects: [{ id: 44, name: 'Different Current Project' }],
  crews: [{ id: 77, name: 'Crew Reused' }],
  sessions: [{ id: 'current-session', userId: 'current-only-field', tokenHash: 'current-session' }]
};
const scopeCollisionRestored = prepareTenantRestore(scopeCollisionSource, scopeCollisionCurrent, identityRestoreTime);
assert.deepEqual(scopeCollisionRestored.sessions, [], 'restore revokes scoped sessions before re-enrollment');
for (const id of ['matching-field', 'matching-foreman', 'matching-pm', 'current-only-field', 'current-only-foreman', 'current-only-pm']) {
  const user = scopeCollisionRestored.users.find(candidate => candidate.id === id);
  assert.ok(user, `${id} remains as an auditable principal`);
  assert.equal(user.status, 'Deactivated', `${id} cannot inherit restored scope`);
  assert.equal(user.mustSetPassword, true);
  assert.equal(user.recoveryAccessState, 'reenrollment-required');
  assert.equal(user.recoveryDeactivationReason, 'historical-scope-reconciliation-required');
  assert.equal(Object.keys(user).some(key => /password|passcode|credential|token|secret|session|setup|verification|mfa|totp|webauthn/i.test(key) && key !== 'mustSetPassword'), false, `${id} is credentialless`);
  for (const scopeField of ['memberId', 'projectIds', 'assignedCrews', 'permissions', 'crew', 'crewId', 'crewIds', 'assignedCrewIds', 'allowedProjectIds']) {
    assert.equal(scopeField in user, false, `${id} does not retain ${scopeField}`);
  }
}
const collisionOwner = scopeCollisionRestored.users.find(user => user.id === 'break-glass-owner');
assert.equal(collisionOwner.status, 'Active', 'the current break-glass owner remains available');
assert.equal(collisionOwner.passwordHash, 'current-owner-hash');
assert.doesNotThrow(() => validateTenantFinalRestoreSnapshot(scopeCollisionRestored));
const illegallyReactivatedScope = structuredClone(scopeCollisionRestored);
illegallyReactivatedScope.users.find(user => user.id === 'matching-field').status = 'Active';
assert.throws(
  () => validateTenantFinalRestoreSnapshot(illegallyReactivatedScope),
  /active scoped access without recovery identity reconciliation/,
  'final validation rejects a scoped principal reactivated after merge'
);
const retainedHistoricalScope = structuredClone(scopeCollisionRestored);
retainedHistoricalScope.users.find(user => user.id === 'current-only-pm').projectIds = [44];
assert.throws(
  () => validateTenantFinalRestoreSnapshot(retainedHistoricalScope),
  /unreconciled historical authorization scope/,
  'final validation rejects a deactivated scoped principal that retains a reused project reference'
);

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-tenant-recovery-'));
  try {
    const photoKey = `${companyId}/photo.jpg`, estimateKey = `${companyId}/estimate.pdf`, proposalKey = `${companyId}/proposal.pdf`;
    const photo = oid('project-photos', photoKey), estimate = oid('estimate-documents', estimateKey), proposal = oid('estimate-documents', proposalKey);
    const targetPhoto = Buffer.from('known-good-photo'), targetEstimate = Buffer.from('known-good-estimate'), targetProposal = Buffer.from('known-good-proposal');
    const target = {
      company: { id: companyId, name: 'Recovery Builders', pendingCheckout: { id: 'old' } },
      users: [{ id: 1, email: 'recovery-owner@example.test', role: 'owner', status: 'Active', passwordHash: 'keep', resetTokenHash: 'reset', setupHash: 'setup', emailVerificationTokenHash: 'verify' }],
      sessions: [{ id: 'session' }], projects: [{ id: 5, estimateProposals: [{ id: 7, sourceFile: { storageBucket: 'estimate-documents', storageKey: proposalKey } }] }],
      photos: [{ id: 1, storageBucket: 'project-photos', storageKey: photoKey }],
      estimateImports: [{ id: 2, storageBucket: 'estimate-documents', storageKey: estimateKey }],
      subcontractorLinks: [{ id: 3, status: 'Active', tokenHash: 'guest' }],
      changes: [{ id: 4, customerTokenHash: 'customer', customerLinkExpiresAt: '2030-01-01T00:00:00.000Z' }]
    };
    const sourceBytes = new Map([[photo, targetPhoto], [estimate, targetEstimate], [proposal, targetProposal]]);
    const source = await createPortableBackup({
      snapshot: target, destination: path.join(root, 'source'), now: new Date('2026-10-20T12:00:00.000Z'),
      authority: { mode: 'transactional-primary', repositoryRevision: 4, contentHash: canonicalHash(target) },
      download: async (bucket, key) => response(sourceBytes.get(oid(bucket, key)), key.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg')
    });
    const uninitializedOutput = path.join(root, 'uninitialized-target');
    const uninitializedStorage = memoryStorage();
    await assert.rejects(() => execute(restoreArgs(source.directory, uninitializedOutput, source.manifestSha256, {}, 0), {
      repo: memoryRepository(null, 0), download: uninitializedStorage.download, upload: uninitializedStorage.upload,
      remove: uninitializedStorage.remove, now: new Date('2026-10-20T12:20:00.000Z'), env: disposableEnv,
      fenceApi: stableFenceApi
    }), /TENANT_RECOVERY_TARGET_OWNER_REQUIRED/);
    assert.equal(fs.existsSync(uninitializedOutput), false, 'an unseeded target fails before creating rollback evidence');
    assert.deepEqual(uninitializedStorage.calls, { download: 0, upload: 0, remove: 0 }, 'an unseeded target performs no Storage I/O');
    const unusableOwnerTarget = {
      company: { id: companyId, name: 'Disposable target' },
      users: [{ id: 99, email: 'break-glass@example.test', role: 'owner', status: 'Active', mustSetPassword: true }]
    };
    const unusableOwnerOutput = path.join(root, 'unusable-owner-target');
    await assert.rejects(() => execute(restoreArgs(source.directory, unusableOwnerOutput, source.manifestSha256, unusableOwnerTarget, 0), {
      repo: memoryRepository(unusableOwnerTarget, 0), download: uninitializedStorage.download, upload: uninitializedStorage.upload,
      remove: uninitializedStorage.remove, now: new Date('2026-10-20T12:21:00.000Z'), env: disposableEnv,
      fenceApi: stableFenceApi
    }), /TENANT_RECOVERY_TARGET_OWNER_REQUIRED.*permanent credential/);
    assert.equal(fs.existsSync(unusableOwnerOutput), false, 'a pending-setup owner is not accepted as the break-glass identity');
    assert.deepEqual(uninitializedStorage.calls, { download: 0, upload: 0, remove: 0 });
    const nonAuthoritative = await createPortableBackup({ snapshot: target, destination: path.join(root, 'untrusted'), download: async (b, k) => response(sourceBytes.get(oid(b, k))) });
    await assert.rejects(() => execute({ command: 'restore-preview', companyId, backup: nonAuthoritative.directory, expectedManifestSha256: nonAuthoritative.manifestSha256 }), /not an authoritative/);
    const previewIo = { repo: 0, download: 0 };
    const preview = await execute({ command: 'restore-preview', companyId, backup: source.directory, expectedManifestSha256: source.manifestSha256 }, {
      repo: { load: async () => { previewIo.repo += 1; } }, download: async () => { previewIo.download += 1; }
    });
    assert.equal(preview.writesPerformed, false); assert.equal(preview.complete, true); assert.deepEqual(previewIo, { repo: 0, download: 0 });

    const current = { company: { id: companyId, name: 'Current' }, users: [{ id: 1, email: 'recovery-owner@example.test', role: 'owner', status: 'Active', passwordHash: 'current-password', passwordSalt: 'current-salt' }], sessions: [{ id: 'current-session', userId: 1, tokenHash: 'current-token' }], projects: [], reports: [], photos: [{ id: 1, storageBucket: 'project-photos', storageKey: photoKey }] };
    const oldPhoto = Buffer.from('current-photo');
    const storage = memoryStorage({ [photo]: oldPhoto });
    const repo = memoryRepository(current);
    const restoreTime = new Date('2026-10-20T12:30:00.000Z');
    const restored = await execute(productionRestoreArgs(source.directory, path.join(root, 'rollback'), source.manifestSha256, current), {
      repo, download: storage.download, upload: storage.upload, remove: storage.remove, now: restoreTime,
      env: productionEnv, fenceApi: stableFenceApi, maintenanceRoot: root
    });
    assert.equal(restored.revision, 10); assert.deepEqual(restored.storage, { total: 3, created: 2, overwritten: 1, unchanged: 0, verified: 3 });
    const restoredState = await repo.load(companyId);
    assert.equal(restoredState.snapshot.sessions.length, 0); assert.equal(restoredState.snapshot.users[0].passwordHash, 'current-password');
    assert.equal(restoredState.snapshot.users[0].resetTokenHash, undefined);
    assert.equal(restoredState.snapshot.subcontractorLinks[0].revokedAt, restoreTime.toISOString());
    assert.equal(restoredState.snapshot.changes[0].customerLinkRevokedAt, restoreTime.toISOString());
    assert.equal(restoredState.snapshot.company.pendingCheckout, undefined);
    const evidence = JSON.parse(fs.readFileSync(restored.evidenceFile, 'utf8'));
    assert.equal(evidence.target.mode, 'production'); assert.equal(evidence.maintenanceFence.digest, fence.digest); assert.equal(evidence.priorContentHash, canonicalHash(current));
    assert.equal(JSON.stringify(sanitizedCliResult(restored)).includes(root), false);

    const replay = await execute(productionRestoreArgs(source.directory, path.join(root, 'replay'), source.manifestSha256, restoredState.snapshot, 10), {
      repo, download: storage.download, upload: storage.upload, remove: storage.remove, now: restoreTime,
      env: productionEnv, fenceApi: stableFenceApi, maintenanceRoot: root
    });
    assert.equal(replay.alreadyRestored, true); assert.equal(repo.saveCalls, 1); assert.equal(replay.storage.unchanged, 3);

    let mismatchIo = 0;
    let mismatchFilesystemIo = 0;
    const mismatchOut = path.join(root, 'target-mismatch');
    const originalExistsSync = fs.existsSync;
    fs.existsSync = (...values) => { mismatchFilesystemIo += 1; return originalExistsSync(...values); };
    try {
      await assert.rejects(() => execute(productionRestoreArgs(source.directory, mismatchOut, source.manifestSha256, current, 9, { productionTarget: 'q'.repeat(20) }), {
        env: productionEnv, repo: { load: async () => { mismatchIo += 1; } }, download: async () => { mismatchIo += 1; },
        fenceApi: { requireVerifiedFence: () => { mismatchIo += 1; return fence; } }
      }), /TENANT_RECOVERY_PRODUCTION_TARGET_MISMATCH/);
    } finally {
      fs.existsSync = originalExistsSync;
    }
    assert.equal(mismatchIo, 0); assert.equal(mismatchFilesystemIo, 0, 'target mismatch fails before filesystem I/O'); assert.equal(fs.existsSync(mismatchOut), false);

    let disposableIo = 0;
    await assert.rejects(() => execute(restoreArgs(source.directory, path.join(root, 'bad-disposable'), source.manifestSha256, current), {
      env: { ...disposableEnv, RENDER: 'true' }, repo: { load: async () => { disposableIo += 1; } }, download: async () => { disposableIo += 1; }, fenceApi: stableFenceApi
    }), /TENANT_RECOVERY_DISPOSABLE_TARGET_FORBIDDEN/);
    assert.equal(disposableIo, 0);
    await assert.rejects(() => execute(restoreArgs(source.directory, path.join(root, 'missing-prod-ref'), source.manifestSha256, current), {
      env: { ...disposableEnv, PDL_PRODUCTION_SUPABASE_PROJECT_REF: '' }, repo: { load: async () => { disposableIo += 1; } }, fenceApi: stableFenceApi
    }), /TENANT_RECOVERY_DISPOSABLE_TARGET_MISMATCH/);
    await assert.rejects(() => execute(restoreArgs(source.directory, path.join(root, 'invalid-prod-ref'), source.manifestSha256, current), {
      env: { ...disposableEnv, PDL_PRODUCTION_SUPABASE_PROJECT_REF: 'not-a-project-ref' }, repo: { load: async () => { disposableIo += 1; } }, fenceApi: stableFenceApi
    }), /TENANT_RECOVERY_DISPOSABLE_TARGET_MISMATCH/);
    await assert.rejects(() => execute(restoreArgs(source.directory, path.join(root, 'production-as-disposable'), source.manifestSha256, current), {
      env: { ...disposableEnv, SUPABASE_URL: `https://${productionRef}.supabase.co` }, repo: { load: async () => { disposableIo += 1; } }, fenceApi: stableFenceApi
    }), /TENANT_RECOVERY_DISPOSABLE_TARGET_MISMATCH|TENANT_RECOVERY_DISPOSABLE_TARGET_FORBIDDEN/);
    assert.equal(disposableIo, 0);

    const nested = path.join(source.directory, 'rollback');
    assert.throws(() => parseArgs([
      'restore', '--company-id', companyId, '--backup', source.directory, '--expected-manifest-sha256', source.manifestSha256,
      '--expected-revision', '9', '--expected-content-hash', canonicalHash(current), '--pre-restore-output', nested,
      '--confirm-company-id', companyId, '--apply', '--disposable-target', disposableRef
    ]), /filesystem-disjoint/);
    assert.equal(fs.existsSync(nested), false);

    const aliasedBackupRoot = path.join(root, 'source-root-alias');
    let aliasCreated = false;
    try {
      fs.symlinkSync(source.directory, aliasedBackupRoot, process.platform === 'win32' ? 'junction' : 'dir');
      aliasCreated = true;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOSYS', 'UNKNOWN'].includes(error.code)) throw error;
    }
    if (aliasCreated) {
      let aliasedPathIo = 0;
      const aliasedChild = path.join(aliasedBackupRoot, 'must-not-be-created-through-alias');
      await assert.rejects(() => execute(restoreArgs(source.directory, aliasedChild, source.manifestSha256, current), {
        env: disposableEnv,
        repo: { load: async () => { aliasedPathIo += 1; return null; } },
        download: async () => { aliasedPathIo += 1; throw new Error('unexpected download'); },
        fenceApi: { requireVerifiedFence: () => { aliasedPathIo += 1; return fence; } }
      }), /filesystem-disjoint/);
      assert.equal(aliasedPathIo, 0, 'aliased overlap fails before fence, repository, or storage I/O');
      assert.equal(fs.existsSync(aliasedChild), false, 'alias rejection does not create the evidence directory');
    }

    const missingFenceOut = path.join(root, 'missing-disposable-fence');
    await assert.rejects(() => execute(restoreArgs(source.directory, missingFenceOut, source.manifestSha256, current), {
      env: disposableEnv, repo: memoryRepository(current), fenceApi: { requireVerifiedFence: () => { throw new Error('MAINTENANCE_FENCE_NOT_VERIFIED'); } }
    }), /MAINTENANCE_FENCE_NOT_VERIFIED/);
    assert.equal(fs.existsSync(missingFenceOut), false);

    const fenceRaceStorage = memoryStorage({ [photo]: oldPhoto });
    const fenceRaceRepo = memoryRepository(current);
    await assert.rejects(() => execute(productionRestoreArgs(source.directory, path.join(root, 'fence-race'), source.manifestSha256, current), {
      repo: fenceRaceRepo, download: fenceRaceStorage.download, upload: fenceRaceStorage.upload, remove: fenceRaceStorage.remove,
      now: restoreTime, env: productionEnv, fenceApi: sequenceFenceApi([fence, fence, changedFence]), maintenanceRoot: root
    }), /MAINTENANCE_FENCE_CHANGED/);
    assert.equal(fenceRaceRepo.saveCalls, 0); assert.deepEqual(fenceRaceStorage.objects.get(photo), oldPhoto); assert.equal(fenceRaceStorage.objects.has(estimate), false);

    const midBatchFenceStorage = memoryStorage({ [photo]: oldPhoto });
    const midBatchFenceRepo = memoryRepository(current);
    await assert.rejects(() => execute(productionRestoreArgs(source.directory, path.join(root, 'mid-batch-fence-race'), source.manifestSha256, current), {
      repo: midBatchFenceRepo, download: midBatchFenceStorage.download, upload: midBatchFenceStorage.upload, remove: midBatchFenceStorage.remove,
      now: restoreTime, env: productionEnv, fenceApi: sequenceFenceApi([fence, fence, fence, changedFence]), maintenanceRoot: root
    }), /MAINTENANCE_FENCE_CHANGED/);
    assert.equal(midBatchFenceStorage.calls.upload, 1, 'only the first storage mutation is dispatched before a mid-batch fence replacement');
    assert.equal(midBatchFenceStorage.calls.remove, 0, 'rollback performs no mutation after the authorizing fence is replaced');
    assert.equal(midBatchFenceRepo.saveCalls, 0);
    assert.deepEqual(midBatchFenceStorage.objects.get(photo), oldPhoto);
    assert.deepEqual(midBatchFenceStorage.objects.get(estimate), targetEstimate, 'the already-written object is retained for manual reconciliation');
    assert.equal(midBatchFenceStorage.objects.has(proposal), false);

    const rollbackFenceStorage = memoryStorage({ [photo]: oldPhoto });
    const rollbackFenceRepo = memoryRepository(current, 9, { save: () => { throw new Error('PDL_REVISION_CONFLICT'); } });
    let rollbackFenceError = null;
    await assert.rejects(() => execute(restoreArgs(source.directory, path.join(root, 'rollback-mid-batch-fence-loss'), source.manifestSha256, current), {
      repo: rollbackFenceRepo, download: rollbackFenceStorage.download, upload: rollbackFenceStorage.upload, remove: rollbackFenceStorage.remove,
      now: restoreTime, env: disposableEnv,
      fenceApi: sequenceFenceApi([fence, fence, fence, fence, fence, fence, fence, changedFence])
    }), error => {
      rollbackFenceError = error;
      return /manual reconciliation is required.*MAINTENANCE_FENCE_CHANGED/i.test(error.message);
    });
    assert.deepEqual(rollbackFenceStorage.objects.get(photo), oldPhoto, 'the first rollback mutation restores the preserved prior object');
    assert.deepEqual(rollbackFenceStorage.objects.get(estimate), targetEstimate, 'rollback stops before touching any later object after fence loss');
    assert.deepEqual(rollbackFenceStorage.objects.get(proposal), targetProposal);
    assert.equal(rollbackFenceStorage.calls.remove, 0, 'no remove is dispatched after rollback loses its fence');
    const rollbackFenceEvidence = JSON.parse(fs.readFileSync(rollbackFenceError.evidenceFile, 'utf8'));
    assert.equal(rollbackFenceEvidence.status, 'storage-outcome-unknown-manual-reconciliation-required');
    assert.equal(rollbackFenceEvidence.storageRollback.haltedForFence, true);
    assert.equal(rollbackFenceEvidence.storageRollback.processed, 1);

    const disposableFenceRaceRepo = memoryRepository(current);
    await assert.rejects(() => execute(restoreArgs(source.directory, path.join(root, 'disposable-fence-race'), source.manifestSha256, current), {
      repo: disposableFenceRaceRepo, download: memoryStorage({ [photo]: oldPhoto }).download,
      now: restoreTime, env: disposableEnv, fenceApi: sequenceFenceApi([fence, changedFence])
    }), /MAINTENANCE_FENCE_CHANGED/);
    assert.equal(disposableFenceRaceRepo.saveCalls, 0, 'a replaced disposable drill fence blocks the restore before any CAS');

    const postCommitStorage = memoryStorage({ [photo]: oldPhoto });
    const postCommitRepo = memoryRepository(current);
    const postCommitEvidenceRoot = path.join(root, 'post-commit-fence-change');
    let postCommitError = null;
    await assert.rejects(() => execute(productionRestoreArgs(source.directory, postCommitEvidenceRoot, source.manifestSha256, current), {
      repo: postCommitRepo, download: postCommitStorage.download, upload: postCommitStorage.upload, remove: postCommitStorage.remove,
      now: restoreTime, env: productionEnv, fenceApi: sequenceFenceApi([fence, fence, fence, fence, fence, fence, changedFence]), maintenanceRoot: root
    }), error => {
      postCommitError = error;
      return error.code === 'PDL_TENANT_RECOVERY_POST_COMMIT_RECONCILIATION_REQUIRED' && /do not retry/i.test(error.message);
    });
    assert.equal(postCommitRepo.saveCalls, 1, 'the CAS may commit before a final fence loss, but success must not be claimed');
    assert.equal(postCommitError.repositoryCommitted, true);
    assert.equal(sanitizedCliFailure(postCommitError).code, 'PDL_TENANT_RECOVERY_POST_COMMIT_RECONCILIATION_REQUIRED');
    assert.deepEqual(postCommitStorage.objects.get(photo), targetPhoto, 'committed restore storage is retained after the final fence check fails');
    const postCommitSet = fs.readdirSync(postCommitEvidenceRoot).map(name => path.join(postCommitEvidenceRoot, name))[0];
    assert.equal(JSON.parse(fs.readFileSync(path.join(postCommitSet, 'restore-evidence.json'), 'utf8')).status, 'repository-committed-reconciliation-failed');

    const postCommitReadStorage = memoryStorage({ [photo]: oldPhoto });
    const postCommitReadRepo = memoryRepository(current, 9, {
      load: ({ loadCalls }) => {
        if (loadCalls === 3) throw new Error('repository provider unavailable after commit');
        return null;
      }
    });
    let postCommitReadError = null;
    const postCommitReadRoot = path.join(root, 'post-commit-read-failure');
    await assert.rejects(() => execute(productionRestoreArgs(source.directory, postCommitReadRoot, source.manifestSha256, current), {
      repo: postCommitReadRepo, download: postCommitReadStorage.download, upload: postCommitReadStorage.upload, remove: postCommitReadStorage.remove,
      now: restoreTime, env: productionEnv, fenceApi: stableFenceApi, maintenanceRoot: root
    }), error => {
      postCommitReadError = error;
      return error.code === 'PDL_TENANT_RECOVERY_POST_COMMIT_RECONCILIATION_REQUIRED';
    });
    assert.equal(postCommitReadRepo.saveCalls, 1);
    assert.equal(postCommitReadError.repositoryCommitted, true);
    assert.equal(JSON.parse(fs.readFileSync(postCommitReadError.evidenceFile, 'utf8')).status, 'repository-committed-reconciliation-failed');

    const wrongHashOutput = path.join(root, 'wrong-current-hash');
    await assert.rejects(() => execute(restoreArgs(source.directory, wrongHashOutput, source.manifestSha256, current, 9, { expectedContentHash: '0'.repeat(64) }), {
      repo: memoryRepository(current), download: storage.download, env: disposableEnv, fenceApi: stableFenceApi
    }), /current tenant content hash/);
    assert.equal(fs.existsSync(wrongHashOutput), false, 'current-state hash mismatch fails before pre-restore set creation');

    const oneTarget = { company: { id: companyId, name: 'One' }, users: [{ id: 1, email: 'one-owner@example.test', role: 'owner', status: 'Active' }], sessions: [], projects: [], photos: [{ id: 1, storageBucket: 'project-photos', storageKey: photoKey }] };
    const oneBackup = await createPortableBackup({
      snapshot: oneTarget, destination: path.join(root, 'one-source'), authority: { mode: 'transactional-primary', repositoryRevision: 2, contentHash: canonicalHash(oneTarget) },
      download: async () => response(targetPhoto), now: new Date('2026-10-20T13:00:00.000Z')
    });
    const oneCurrent = { company: { id: companyId, name: 'One current' }, users: [{ id: 1, email: 'one-owner@example.test', role: 'owner', status: 'Active', passwordHash: 'current-hash', passwordSalt: 'current-salt', mustSetPassword: false }], sessions: [], projects: [], photos: [{ id: 1, storageBucket: 'project-photos', storageKey: photoKey }] };
    const concurrent = Buffer.from('concurrent-unchanged-race');
    const unchangedRace = memoryStorage({ [photo]: targetPhoto }, { download: ({ calls, objects }) => { if (calls.download === 3) objects.set(photo, concurrent); } });
    const unchangedRepo = memoryRepository(oneCurrent);
    await assert.rejects(() => execute(restoreArgs(oneBackup.directory, path.join(root, 'unchanged-race'), oneBackup.manifestSha256, oneCurrent), {
      repo: unchangedRepo, download: unchangedRace.download, upload: unchangedRace.upload, remove: unchangedRace.remove,
      now: restoreTime, env: disposableEnv, fenceApi: stableFenceApi
    }), /changed before repository commit/);
    assert.equal(unchangedRepo.saveCalls, 0); assert.deepEqual(unchangedRace.objects.get(photo), concurrent);

    let rollbackPhase = false;
    const newer = Buffer.from('newer-concurrent-writer');
    const rollbackStorage = memoryStorage({ [photo]: oldPhoto }, { download: ({ objects }) => { if (rollbackPhase) { objects.set(photo, newer); rollbackPhase = false; } } });
    const rollbackRepo = memoryRepository(current, 9, { save: () => { rollbackPhase = true; throw new Error('PDL_REVISION_CONFLICT'); } });
    await assert.rejects(() => execute(restoreArgs(source.directory, path.join(root, 'rollback-conflict'), source.manifestSha256, current), {
      repo: rollbackRepo, download: rollbackStorage.download, upload: rollbackStorage.upload, remove: rollbackStorage.remove,
      now: restoreTime, env: disposableEnv, fenceApi: stableFenceApi
    }), /manual reconciliation is required/);
    assert.deepEqual(rollbackStorage.objects.get(photo), newer);

    const concurrentSnapshot = structuredClone(current);
    concurrentSnapshot.company.name = 'Concurrent repository writer';
    const higherRevisionStorage = memoryStorage({ [photo]: oldPhoto });
    const higherRevisionRepo = memoryRepository(current, 9, {
      save: () => { throw new Error('repository response lost'); },
      load: ({ loadCalls }) => loadCalls >= 3
        ? {
            handled: true,
            value: {
              snapshot: concurrentSnapshot,
              revision: 11,
              contentHash: canonicalHash(concurrentSnapshot)
            }
          }
        : null
    });
    let higherRevisionError = null;
    await assert.rejects(() => execute(restoreArgs(source.directory, path.join(root, 'higher-revision-outcome'), source.manifestSha256, current), {
      repo: higherRevisionRepo,
      download: higherRevisionStorage.download,
      upload: higherRevisionStorage.upload,
      remove: higherRevisionStorage.remove,
      now: restoreTime,
      env: disposableEnv,
      fenceApi: stableFenceApi
    }), error => {
      higherRevisionError = error;
      return /manual reconciliation is required/.test(error.message);
    });
    assert.equal(higherRevisionRepo.saveCalls, 1);
    assert.deepEqual(higherRevisionStorage.objects.get(photo), targetPhoto, 'target bytes are retained when a newer repository revision makes the commit outcome unknowable');
    assert.deepEqual(higherRevisionStorage.objects.get(estimate), targetEstimate);
    assert.deepEqual(higherRevisionStorage.objects.get(proposal), targetProposal);
    assert.equal(higherRevisionStorage.calls.remove, 0, 'unknown repository outcomes never delete restored storage');
    assert.ok(higherRevisionError?.evidenceFile);
    const higherRevisionEvidence = JSON.parse(fs.readFileSync(higherRevisionError.evidenceFile, 'utf8'));
    assert.equal(higherRevisionEvidence.status, 'repository-outcome-unknown');
    assert.equal(higherRevisionEvidence.repositoryOutcomeUnknown, true);

    let ambiguous = false;
    const ambiguousStorage = memoryStorage({ [photo]: oldPhoto }, {
      upload: ({ bucket, objectKey, bytes, objects }) => { objects.set(oid(bucket, objectKey), Buffer.from(bytes)); ambiguous = true; throw new Error('provider timeout'); },
      download: () => { if (ambiguous) throw new Error('provider unavailable during reconciliation'); }
    });
    const ambiguousRepo = memoryRepository(current);
    await assert.rejects(() => execute(restoreArgs(source.directory, path.join(root, 'ambiguous'), source.manifestSha256, current), {
      repo: ambiguousRepo, download: ambiguousStorage.download, upload: ambiguousStorage.upload, remove: ambiguousStorage.remove,
      now: restoreTime, env: disposableEnv, fenceApi: stableFenceApi
    }), /manual reconciliation is required/);
    assert.equal(ambiguousRepo.saveCalls, 0);
    assert.deepEqual(ambiguousStorage.objects.get(estimate), targetEstimate, 'ambiguous provider bytes are retained for manual reconciliation');
    assert.deepEqual(ambiguousStorage.objects.get(photo), oldPhoto);

    const exportStorage = memoryStorage({ [photo]: oldPhoto });
    const exported = await execute({
      command: 'export', companyId, output: path.join(root, 'production-export'), productionTarget: productionRef,
      disposableTarget: '', expectedServiceId: serviceId, expectedInstanceId: instanceId
    }, { repo: memoryRepository(current), download: exportStorage.download, now: restoreTime, env: productionEnv, fenceApi: stableFenceApi, maintenanceRoot: root });
    assert.equal(exported.authority.mode, 'transactional-primary'); assert.equal(exported.maintenanceFenceDigest, fence.digest);

    const changed = structuredClone(current); changed.company.name = 'Changed during export';
    const unstableRoot = path.join(root, 'unstable-export');
    const unstableRepo = memoryRepository(current, 9, { load: ({ loadCalls }) => loadCalls === 2 ? { handled: true, value: { snapshot: changed, revision: 10, contentHash: canonicalHash(changed) } } : null });
    await assert.rejects(() => execute({
      command: 'export', companyId, output: unstableRoot, productionTarget: productionRef, disposableTarget: '', expectedServiceId: serviceId, expectedInstanceId: instanceId
    }, { repo: unstableRepo, download: exportStorage.download, now: restoreTime, env: productionEnv, fenceApi: stableFenceApi, maintenanceRoot: root }), /source changed during capture/);
    assert.deepEqual(fs.readdirSync(unstableRoot), []);

    const changedFenceRoot = path.join(root, 'changed-fence-export');
    await assert.rejects(() => execute({
      command: 'export', companyId, output: changedFenceRoot, productionTarget: productionRef, disposableTarget: '', expectedServiceId: serviceId, expectedInstanceId: instanceId
    }, { repo: memoryRepository(current), download: exportStorage.download, now: restoreTime, env: productionEnv, fenceApi: sequenceFenceApi([fence, changedFence]), maintenanceRoot: root }), /MAINTENANCE_FENCE_CHANGED/);
    assert.deepEqual(fs.readdirSync(changedFenceRoot), []);

    const finalFenceRoot = path.join(root, 'final-fence-export');
    await assert.rejects(() => execute({
      command: 'export', companyId, output: finalFenceRoot, productionTarget: productionRef, disposableTarget: '', expectedServiceId: serviceId, expectedInstanceId: instanceId
    }, { repo: memoryRepository(current), download: exportStorage.download, now: restoreTime, env: productionEnv, fenceApi: sequenceFenceApi([fence, fence, changedFence]), maintenanceRoot: root }), /MAINTENANCE_FENCE_CHANGED/);
    assert.deepEqual(fs.readdirSync(finalFenceRoot), [], 'a fence loss after capture invalidates the otherwise complete set');

    assert.equal(canonicalHash(prepareTenantRestore(target, current, restoreTime.toISOString())), canonicalHash(prepareTenantRestore(target, current, restoreTime.toISOString())));
    console.log('Tenant recovery passed: target binding, exact tenant state, fenced export/restore, final object reads, conditional rollback, provider ambiguity, and sanitized evidence.');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
