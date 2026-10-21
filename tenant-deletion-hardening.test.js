'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

Object.assign(process.env, {
  PDL_SUPABASE_ENABLED: '1',
  SUPABASE_URL: 'https://tenant-hardening.invalid',
  SUPABASE_SECRET_KEY: 'synthetic-service-role-secret'
});

const calls = [];
let purgeHasTombstone = true;
let purgeRequestMode = 'exact';
let deletionStatusValue = 'locked';
const originalFetch = global.fetch;
global.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), options, body: options.body ? JSON.parse(options.body) : null });
  const pathname = new URL(String(url)).pathname;
  let payload;
  if (pathname.endsWith('/list_tenant_email_conflicts')) {
    payload = {
      rows: [{
        normalizedEmail: 'shared@example.invalid',
        retainedCompanyId: '11111111-1111-4111-8111-111111111111',
        conflictedCompanyId: '22222222-2222-4222-8222-222222222222',
        authorizedCompanyId: '11111111-1111-4111-8111-111111111111',
        detectedAt: '2026-10-20T00:00:00.000Z', resolvedAt: null, resolvedBy: null, resolutionNote: null
      }]
    };
  } else if (pathname.endsWith('/resolve_tenant_email_conflict')) {
    payload = {
      resolved: true,
      normalizedEmail: 'shared@example.invalid',
      authorizedCompanyId: '22222222-2222-4222-8222-222222222222',
      affectedConflicts: 1,
      resolvedAt: '2026-10-20T00:01:00.000Z'
    };
  } else if (pathname.endsWith('/purge_tenant_repository')) {
    payload = {
      deleted: true,
      companyId: '22222222-2222-4222-8222-222222222222',
      ...(purgeRequestMode === 'exact' ? { deletionRequestId: '33333333-3333-4333-8333-333333333333' } : purgeRequestMode === 'wrong' ? { deletionRequestId: '44444444-4444-4444-8444-444444444444' } : {}),
      deletedAt: '2026-10-20T00:02:00.000Z',
      ...(purgeHasTombstone ? { tombstoneVersion: 1, terminalRevision: 7 } : {})
    };
  } else if (pathname.endsWith('/begin_tenant_repository_purge')) {
    payload = {
      locked: true,
      companyId: '22222222-2222-4222-8222-222222222222',
      deletionRequestId: '33333333-3333-4333-8333-333333333333',
      lockedRevision: 7,
      startedAt: '2026-10-20T00:01:30.000Z',
      resumed: false
    };
  } else if (pathname.endsWith('/tenant_repository_deletion_status')) {
    payload = deletionStatusValue === 'locked' ? {
      status: 'locked',
      companyId: '22222222-2222-4222-8222-222222222222',
      deletionRequestId: '33333333-3333-4333-8333-333333333333',
      lockedRevision: 7,
      startedAt: '2026-10-20T00:01:30.000Z'
    } : {
      status: 'deleted',
      companyId: '22222222-2222-4222-8222-222222222222',
      deletionRequestId: '33333333-3333-4333-8333-333333333333',
      terminalRevision: 7,
      tombstoneVersion: 1,
      deletedAt: '2026-10-20T00:02:00.000Z'
    };
  } else {
    throw new Error(`Unexpected synthetic request: ${pathname}`);
  }
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
};

const supabase = require('./database/supabase');

(async () => {
  try {
    const queue = await supabase.listTenantEmailConflicts(900);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].normalizedEmail, 'shared@example.invalid');
    assert.equal(calls.at(-1).body.p_limit, 500, 'operator queue reads are bounded');

    const resolution = await supabase.resolveTenantEmailConflict({
      email: ' Shared@Example.Invalid ',
      authorizedCompanyId: '22222222-2222-4222-8222-222222222222',
      resolvedBy: 'Platform Owner',
      resolutionNote: 'Verified both account owners and retained the current contract.'
    });
    assert.equal(resolution.authorizedCompanyId, '22222222-2222-4222-8222-222222222222');
    assert.equal(resolution.affectedConflicts, 1);
    assert.deepEqual(calls.at(-1).body, {
      p_email: 'shared@example.invalid',
      p_authorized_company_id: '22222222-2222-4222-8222-222222222222',
      p_resolved_by: 'Platform Owner',
      p_resolution_note: 'Verified both account owners and retained the current contract.'
    });

    const lock = await supabase.beginTransactionalTenantDeletion(
      '22222222-2222-4222-8222-222222222222', 7, '33333333-3333-4333-8333-333333333333'
    );
    assert.equal(lock.lockedRevision, 7);
    assert.equal(lock.resumed, false);
    assert.deepEqual(calls.at(-1).body, {
      p_company_id: '22222222-2222-4222-8222-222222222222',
      p_expected_revision: 7,
      p_deletion_request_id: '33333333-3333-4333-8333-333333333333'
    });

    const lockedStatus = await supabase.transactionalTenantDeletionStatus('22222222-2222-4222-8222-222222222222');
    assert.equal(lockedStatus.status, 'locked');
    assert.equal(lockedStatus.lockedRevision, 7);
    deletionStatusValue = 'deleted';
    const deletedStatus = await supabase.transactionalTenantDeletionStatus('22222222-2222-4222-8222-222222222222');
    assert.equal(deletedStatus.status, 'deleted');
    assert.equal(deletedStatus.tombstoneVersion, 1);

    const deleted = await supabase.purgeTransactionalTenant(
      '22222222-2222-4222-8222-222222222222', 7, '33333333-3333-4333-8333-333333333333'
    );
    assert.equal(deleted.tombstoneVersion, 1);
    assert.equal(deleted.terminalRevision, 7);

    purgeHasTombstone = false;
    await assert.rejects(
      () => supabase.purgeTransactionalTenant(
        '22222222-2222-4222-8222-222222222222', 7, '33333333-3333-4333-8333-333333333333'
      ),
      /tombstone version|terminal tenant tombstone/i,
      'the adapter must not claim deletion without the independent tombstone/version receipt'
    );
    purgeHasTombstone = true;
    for (const mode of ['missing', 'wrong']) {
      purgeRequestMode = mode;
      await assert.rejects(
        () => supabase.purgeTransactionalTenant(
          '22222222-2222-4222-8222-222222222222', 7, '33333333-3333-4333-8333-333333333333'
        ),
        /Deletion request ID|did not confirm tenant deletion/i,
        `the adapter must reject a ${mode} deletion-request identity in the terminal receipt`
      );
    }
    purgeRequestMode = 'exact';

    const emailMigration = fs.readFileSync(path.join(__dirname, 'database', '010_signup_email_uniqueness.sql'), 'utf8');
    assert.match(emailMigration, /authorized_company_id\s+uuid\s+NOT NULL/i);
    assert.match(emailMigration, /keep_conflicted_tenant_email_quarantined[\s\S]*authorized_company_id\s*<>\s*NEW\.company_id[\s\S]*RETURN NULL/i);
    assert.match(emailMigration, /resolve_tenant_email_conflict[\s\S]*FOR UPDATE[\s\S]*public\.tenant_records[\s\S]*DELETE FROM private\.tenant_active_user_emails[\s\S]*INSERT INTO private\.tenant_active_user_emails/i);
    assert.match(emailMigration, /REVOKE ALL ON FUNCTION public\.resolve_tenant_email_conflict[\s\S]*PUBLIC, anon, authenticated/i);
    assert.match(emailMigration, /GRANT EXECUTE ON FUNCTION public\.resolve_tenant_email_conflict[\s\S]*service_role/i);

    const deletionMigration = fs.readFileSync(path.join(__dirname, 'database', '012_operator_reviewed_tenant_deletion.sql'), 'utf8');
    assert.match(deletionMigration, /CREATE TABLE IF NOT EXISTS private\.tenant_tombstones/i);
    assert.match(deletionMigration, /CREATE TABLE IF NOT EXISTS private\.tenant_deletion_operations/i);
    assert.match(deletionMigration, /begin_tenant_repository_purge[\s\S]*FOR UPDATE[\s\S]*INSERT INTO private\.tenant_deletion_operations/i);
    assert.match(deletionMigration, /reject_finalizing_tenant_company_write[\s\S]*reject_finalizing_tenant_revision_write[\s\S]*reject_finalizing_tenant_record_write/i);
    assert.match(deletionMigration, /purge_tenant_repository[\s\S]*Permanent deletion must be locked before object cleanup[\s\S]*DELETE FROM private\.tenant_deletion_operations/i);
    assert.match(deletionMigration, /tenant_repository_deletion_status[\s\S]*'status', 'locked'[\s\S]*'status', 'not_started'/i);
    assert.match(deletionMigration, /ALTER TABLE private\.tenant_tombstones FORCE ROW LEVEL SECURITY/i);
    assert.match(deletionMigration, /reject_deleted_tenant_company_write[\s\S]*BEFORE INSERT OR UPDATE ON public\.companies/i);
    assert.match(deletionMigration, /reject_deleted_tenant_revision_write[\s\S]*BEFORE INSERT OR UPDATE ON public\.tenant_revisions/i);
    assert.match(deletionMigration, /PDL_TENANT_DELETED/i);
    assert.match(deletionMigration, /DELETE FROM private\.tenant_email_conflicts[\s\S]*retained_company_id\s*=\s*p_company_id[\s\S]*conflicted_company_id\s*=\s*p_company_id[\s\S]*authorized_company_id\s*=\s*p_company_id/i);
    assert.match(deletionMigration, /INSERT INTO private\.tenant_tombstones[\s\S]*state\.revision[\s\S]*tombstoneVersion/i);

    const resumableDeletionMigration = fs.readFileSync(path.join(__dirname, 'database', '015_resumable_tenant_deletion.sql'), 'utf8');
    assert.match(resumableDeletionMigration, /guard_tenant_lifecycle_write[\s\S]*pg_advisory_xact_lock[\s\S]*tenant_deletion_operations/i);
    assert.match(resumableDeletionMigration, /IF TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = 'companies' THEN[\s\S]*target_company_id := CASE WHEN TG_OP = 'DELETE' THEN OLD\.id ELSE NEW\.id END;[\s\S]*ELSE[\s\S]*target_company_id := CASE WHEN TG_OP = 'DELETE' THEN OLD\.company_id ELSE NEW\.company_id END;[\s\S]*END IF;/i);
    assert.doesNotMatch(resumableDeletionMigration, /target_company_id\s*:=\s*CASE\s+WHEN TG_TABLE_SCHEMA/i);
    assert.match(resumableDeletionMigration, /DROP TRIGGER IF EXISTS reject_deleted_tenant_company_write ON public\.companies/i);
    assert.match(resumableDeletionMigration, /DROP TRIGGER IF EXISTS reject_deleted_tenant_revision_write ON public\.tenant_revisions/i);
    assert.match(resumableDeletionMigration, /DROP TRIGGER IF EXISTS reject_finalizing_tenant_company_write ON public\.companies/i);
    assert.match(resumableDeletionMigration, /DROP TRIGGER IF EXISTS reject_finalizing_tenant_revision_write ON public\.tenant_revisions/i);
    assert.match(resumableDeletionMigration, /DROP TRIGGER IF EXISTS reject_finalizing_tenant_record_write ON public\.tenant_records/i);
    assert.match(resumableDeletionMigration, /DROP TRIGGER IF EXISTS reject_finalizing_tenant_write ON public\.%I/i);
    assert.match(resumableDeletionMigration, /BEFORE INSERT OR UPDATE OR DELETE/i);
    assert.match(resumableDeletionMigration, /begin_tenant_repository_purge[\s\S]*pg_advisory_xact_lock[\s\S]*deletion_request_id <> p_deletion_request_id/i);
    assert.match(resumableDeletionMigration, /purge_tenant_repository[\s\S]*Permanent deletion must be locked before object cleanup[\s\S]*tenant_public_link_tokens/i);
    assert.match(resumableDeletionMigration, /jsonb_build_object\('deleted',true,'companyId',p_company_id,'deletionRequestId',p_deletion_request_id/i);

    console.log('Tenant conflict/deletion hardening passed: duplicate identities stay quarantined without blocking writes, resolution is bounded, and deletion is terminal.');
  } finally {
    global.fetch = originalFetch;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
