'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

Object.assign(process.env, {
  PDL_SUPABASE_ENABLED: '0',
  PDL_TRANSACTIONAL_DB: 'off',
  PDL_PLATFORM_TRANSACTIONAL_DB: 'off',
  PDL_EMAIL_DEV_MODE: '1'
});

const {
  executePermanentTenantDeletion,
  persistTenantDeletionCleanupJob,
  retryPendingTenantDeletionCleanup,
  scrubTenantPlatformPii,
  tenantPlatformPiiReferences
} = require('./server');

const companyId = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
const otherRequestId = '44444444-4444-4444-8444-444444444444';
const authority = {
  databaseCompanyId: companyId,
  revision: 7,
  snapshot: { company: { id: companyId, deletionRequest: { id: requestId } } }
};
const request = { id: requestId };
const exactLock = { locked: true, companyId, deletionRequestId: requestId, lockedRevision: 7 };
const lockedStatus = { status: 'locked', companyId, deletionRequestId: requestId, lockedRevision: 7 };
const deletedStatus = {
  status: 'deleted', companyId, deletionRequestId: requestId, terminalRevision: 7,
  tombstoneVersion: 1, deletedAt: '2026-10-20T00:00:00.000Z'
};
const deletedReceipt = { ...deletedStatus, deleted: true };
const notStartedStatus = { status: 'not_started', companyId };
const noJob = async () => {};

function harness(overrides = {}) {
  const calls = { begin: 0, storage: 0, mirror: 0, prepare: 0, finalize: 0, pending: 0, complete: 0, status: 0 };
  const dependencies = {
    begin: async () => { calls.begin += 1; return exactLock; },
    removeStorage: async () => { calls.storage += 1; return { removed: 2, alreadyAbsent: 1, total: 3 }; },
    removeMirror: async () => { calls.mirror += 1; return { verifiedAbsent: true }; },
    prepareCleanupJob: async () => { calls.prepare += 1; },
    markCleanupPending: async () => { calls.pending += 1; },
    markCleanupComplete: async () => { calls.complete += 1; },
    finalize: async () => { calls.finalize += 1; return deletedReceipt; },
    deletionStatus: async () => { calls.status += 1; return lockedStatus; },
    captureException: () => {},
    ...overrides
  };
  return { calls, run: () => executePermanentTenantDeletion({ companyId, authority, request }, dependencies) };
}

(async () => {
  {
    const test = harness({ begin: async () => ({ ...exactLock, deletionRequestId: otherRequestId }) });
    await assert.rejects(test.run, error => error.deletionPhase === 'lock_mismatch');
    assert.equal(test.calls.storage, 0, 'an inexact lock receipt must never authorize object cleanup');
    assert.equal(test.calls.mirror, 0);
    assert.equal(test.calls.finalize, 0);
  }

  {
    const transport = new TypeError('BEGIN response lost after commit');
    const test = harness({
      begin: async () => { test.calls.begin += 1; throw transport; },
      deletionStatus: async () => { test.calls.status += 1; return lockedStatus; }
    });
    const result = await test.run();
    assert.equal(result.deleted, true);
    assert.equal(test.calls.storage, 1, 'an exact durable locked status resumes after an ambiguous BEGIN');
    assert.equal(test.calls.finalize, 1);
  }

  {
    const transport = new TypeError('BEGIN response lost after finalize committed');
    const test = harness({
      begin: async () => { test.calls.begin += 1; throw transport; },
      deletionStatus: async () => { test.calls.status += 1; return deletedStatus; }
    });
    const result = await test.run();
    assert.equal(result.recoveredCommit, true);
    assert.equal(test.calls.storage, 0, 'a matching terminal receipt must not repeat external deletion');
    assert.equal(test.calls.finalize, 0);
    assert.equal(test.calls.mirror, 1, 'local absence is still verified during terminal recovery');
  }

  for (const scenario of [
    { name: 'unavailable status', phase: 'lock_unconfirmed', status: async () => { throw new Error('status transport unavailable'); } },
    { name: 'not-started status', phase: 'lock', status: async () => notStartedStatus },
    { name: 'mismatched status', phase: 'lock_mismatch', status: async () => ({ ...lockedStatus, deletionRequestId: otherRequestId }) }
  ]) {
    const beginError = new TypeError(`ambiguous BEGIN: ${scenario.name}`);
    const test = harness({ begin: async () => { throw beginError; }, deletionStatus: scenario.status });
    await assert.rejects(test.run, error => error === beginError && error.deletionPhase === scenario.phase);
    assert.equal(test.calls.storage, 0, `${scenario.name} must perform zero storage cleanup`);
    assert.equal(test.calls.mirror, 0, `${scenario.name} must perform zero local cleanup`);
    assert.equal(test.calls.finalize, 0, `${scenario.name} must perform zero finalization`);
  }

  {
    let first = true;
    const shared = {
      begin: async () => exactLock,
      removeStorage: async () => {
        if (first) { first = false; throw new Error('provider stopped after deleting one object'); }
        return { removed: 1, alreadyAbsent: 1, total: 2 };
      },
      removeMirror: async () => ({ verifiedAbsent: true }),
      prepareCleanupJob: noJob,
      markCleanupPending: noJob,
      markCleanupComplete: noJob,
      finalize: async () => deletedReceipt,
      deletionStatus: async () => lockedStatus,
      captureException: () => {}
    };
    await assert.rejects(
      () => executePermanentTenantDeletion({ companyId, authority, request }, shared),
      error => error.deletionPhase === 'external_cleanup' && error.deletionLocked === true
    );
    const resumed = await executePermanentTenantDeletion({ companyId, authority, request }, shared);
    assert.equal(resumed.deleted, true, 'a restart resumes the same lock and tolerates already-absent storage');
    assert.equal(resumed.storage.alreadyAbsent, 1);
  }

  {
    const test = harness({ prepareCleanupJob: async () => { test.calls.prepare += 1; throw new Error('platform scrub could not be durably verified'); } });
    await assert.rejects(test.run, error => error.deletionPhase === 'external_cleanup');
    assert.equal(test.calls.finalize, 0, 'platform/local PII cleanup failure must stop authority finalization');
  }

  {
    const test = harness({
      finalize: async () => { test.calls.finalize += 1; throw new TypeError('FINALIZE response lost after commit'); },
      deletionStatus: async () => { test.calls.status += 1; return deletedStatus; }
    });
    const recovered = await test.run();
    assert.equal(recovered.recoveredCommit, true);
    assert.equal(recovered.cleanupStatus, 'complete');
    assert.equal(test.calls.mirror, 2, 'local absence is proven both before finalize and before a complete response');
  }

  for (const invalidReceipt of [
    { ...deletedReceipt, deletionRequestId: undefined },
    { ...deletedReceipt, deletionRequestId: otherRequestId }
  ]) {
    const test = harness({
      finalize: async () => { test.calls.finalize += 1; return invalidReceipt; },
      deletionStatus: async () => { test.calls.status += 1; return lockedStatus; }
    });
    await assert.rejects(test.run, error => error.deletionPhase === 'authority_finalize');
    assert.equal(test.calls.finalize, 1);
  }

  {
    let mirrorCalls = 0;
    const test = harness({
      removeMirror: async () => {
        test.calls.mirror += 1;
        mirrorCalls += 1;
        if (mirrorCalls === 2) throw new Error('synthetic post-authority verification failure');
        return { verifiedAbsent: true };
      }
    });
    const result = await test.run();
    assert.equal(result.deleted, true, 'the API must not claim authoritative deletion failed after its tombstone committed');
    assert.equal(result.cleanupStatus, 'pending', 'known post-authority cleanup trouble cannot receive a complete response');
    assert.equal(test.calls.pending, 1);
  }

  {
    const platform = {
      onboardingOrders: [{ id: 'o1', companyId, companyName: 'Private Company', notes: 'Owner private@example.invalid' }],
      supportTickets: [{ id: 't1', companyId, description: 'Customer secret' }],
      supportGrants: [{ id: 'g1', companyId, tokenHash: 'secret-token-hash' }],
      growthOpportunities: [{ id: 'p1', linkedCompanyId: companyId, companyName: 'Private Company', followUps: [{ note: 'Call owner' }] }],
      cachedCustomerSummaries: [{ companyId, summary: 'Private Company is at risk' }],
      tenantDeletionCleanupJobs: [{ id: `${companyId}:${requestId}`, companyId, deletionRequestId: requestId, terminalRevision: 7, status: 'cleanup_pending', lastError: 'Private Company private@example.invalid' }],
      unrelated: [{ id: 'safe', companyId: '55555555-5555-4555-8555-555555555555', note: 'keep me' }],
      auditEvents: [{ id: 'a1', action: 'account_deletion_requested', companyId, actorUserId: 'u1', actorName: 'Private Owner', reason: 'Owner private@example.invalid', at: '2026-10-01T00:00:00.000Z', details: { deletionRequestId: requestId, removed: 4, companyName: 'Private Company' } }]
    };
    const outcome = scrubTenantPlatformPii(platform, companyId);
    assert.equal(outcome.removed, 5);
    assert.deepEqual(tenantPlatformPiiReferences(platform, companyId), []);
    assert.equal(platform.unrelated.length, 1);
    assert.equal(platform.auditEvents[0].status, 'retained_after_tenant_deletion');
    assert.deepEqual(platform.auditEvents[0].details, { deletionRequestId: requestId, removed: 4 });
    assert.equal(platform.tenantDeletionCleanupJobs[0].lastError, undefined);
    assert.doesNotMatch(JSON.stringify(platform), /Private Company|private@example\.invalid|Customer secret|secret-token-hash|Call owner/);
  }

  {
    let active = { onboardingOrders: [{ id: 'o2', companyId, companyName: 'Private Company' }], auditEvents: [] };
    let durable = null;
    const job = await persistTenantDeletionCleanupJob({
      companyId, deletionRequestId: requestId, terminalRevision: 7,
      status: 'external_cleanup_verified', storage: { removed: 1, alreadyAbsent: 0, total: 1 }
    }, {
      read: () => active,
      write: async value => { durable = structuredClone(value); throw new TypeError('write response lost after commit'); },
      refresh: async () => { active = structuredClone(durable); }
    });
    assert.equal(job.status, 'external_cleanup_verified', 'an ambiguous platform write is recovered only by a durable re-read');
    assert.deepEqual(tenantPlatformPiiReferences(active, companyId), []);
  }

  {
    const platform = { tenantDeletionCleanupJobs: [{ id: `${companyId}:${requestId}`, companyId, deletionRequestId: requestId, terminalRevision: 7, status: 'cleanup_pending' }] };
    let writes = 0;
    const retry = await retryPendingTenantDeletionCleanup({
      read: () => platform,
      write: async () => { writes += 1; },
      deletionStatus: async () => deletedStatus,
      removeMirror: async () => ({ removed: true, verifiedAbsent: true })
    });
    assert.deepEqual(retry.map(row => row.status), ['complete']);
    assert.equal(platform.tenantDeletionCleanupJobs[0].status, 'complete');
    assert.equal(writes, 1);
  }

  const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.match(serverSource, /result\.cleanupStatus==='complete'\?200:202/, 'known cleanup trouble must not receive HTTP 200');
  assert.match(serverSource, /priorStatus\.status==='deleted'[\s\S]*cleanupStatus==='complete'\?200:202/, 'a retry after an ambiguous commit must reconcile the tombstone and local cleanup');
  assert.doesNotMatch(serverSource, /Permanent deletion did not complete\. The account remains disabled and the operation is safe to retry\./, 'the API must not describe a committed authoritative deletion as failed');

  console.log('Tenant deletion sequencing passed: exact durable locks precede cleanup, ambiguous commits reconcile safely, platform PII is scrubbed before finalize, and retries remain idempotent.');
})().catch(error => { console.error(error); process.exitCode = 1; });
