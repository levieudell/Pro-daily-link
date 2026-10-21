'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CONFIRMATION_PHRASE,
  GUARDED_EVENTS,
  GUARDED_TABLES,
  assertManifestHash,
  assertApplySafety,
  createPool,
  guardedWriteCases,
  lockBehindInFlightWrite,
  parseArgs,
  parseDatabaseUrl,
  preLockLifecycleCases,
  readRecoveryEvidence,
  safeError,
  serverFingerprint,
  syntheticTenant,
  tenantMoveCases,
  usage,
  validateSyntheticProvenanceRows,
  writeBehindUncommittedDeletion
} = require('./deletion-concurrency-acceptance');

async function main() {
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-delete-acceptance-unit-'));

try {
  assert.deepEqual(parseArgs(['--fingerprint']), {
    mode: 'fingerprint', expectedFingerprint: '', confirmation: '', evidencePath: '', cleanupEvidencePath: '', manifestSha256: ''
  });
  assert.equal(parseArgs(['--preview']).mode, 'preview');
  assert.equal(parseArgs(['--help']).mode, 'help');
  assert.throws(() => parseArgs([]), /exactly one mode/i);
  assert.throws(() => parseArgs(['--preview', '--apply']), /exactly one mode/i);
  assert.throws(() => parseArgs(['--apply']), /confirm-disposable/i);
  assert.throws(
    () => parseArgs(['--preview', '--database-url=postgresql://user:secret@example.test/postgres']),
    error => /Unknown option/.test(error.message) && !/secret|example\.test/.test(error.message)
  );
  assert.throws(() => parseArgs(['--fingerprint', '--evidence=C:\\not-used.json']), /does not accept destructive-mode options/);
  assert.throws(() => parseArgs(['--fingerprint', '--evidence=']), /does not accept destructive-mode options/);
  assert.throws(() => parseArgs(['--help', '--preview']), /cannot be combined/);
  assert.throws(() => parseArgs(['--apply', '--evidence=one', '--evidence=two']), /only once/);
  assert.throws(() => parseArgs(['--cleanup-evidence=relative.json']), /confirm-disposable/i);

  const firstUrl = 'postgresql://postgres.branch_a:first-secret@pooler.example.test:5432/postgres?sslmode=require';
  assert.equal(parseDatabaseUrl(firstUrl).hostname, 'pooler.example.test');
  assert.throws(() => parseDatabaseUrl('https://example.test'), /postgres:\/\/ or postgresql:\/\//);

  const expectedFingerprint = serverFingerprint({ systemIdentifier: '7629384756102938475', databaseOid: '16422', databaseName: 'postgres' });
  const productionFingerprint = serverFingerprint({ systemIdentifier: '7629384756102938476', databaseOid: '16422', databaseName: 'postgres' });
  assert.notEqual(expectedFingerprint, productionFingerprint, 'server/database identity must affect the fingerprint');
  assert.throws(() => serverFingerprint({ systemIdentifier: '', databaseOid: '1', databaseName: 'postgres' }), /stable cluster/i);
  const evidencePath = path.join(temp, 'acceptance-evidence.json');
  const applyArgs = parseArgs([
    '--apply',
    `--expected-fingerprint=${expectedFingerprint}`,
    `--confirm-disposable=${CONFIRMATION_PHRASE}`,
    `--evidence=${evidencePath}`
  ]);
  const identity = { fingerprint: expectedFingerprint };
  const inventory = {
    privilegedVisibility: true,
    schemaReady: true,
    companyCount: 0,
    userCount: 0,
    deletionOperationCount: 0,
    deletionFinalizerCount: 0,
    tombstoneCount: 0,
    directoryCount: 0,
    activeEmailCount: 0,
    publicLinkTokenCount: 0,
    emailConflictCount: 0,
    platformStateCount: 0,
    platformRecordCount: 0,
    platformRevisionLogCount: 0
  };
  const safeEnvironment = {
    PDL_DELETION_ACCEPTANCE_DISPOSABLE: '1',
    PDL_PRODUCTION_DATABASE_FINGERPRINT: productionFingerprint
  };
  assert.doesNotThrow(() => assertApplySafety({ args: applyArgs, env: safeEnvironment, databaseUrl: firstUrl, identity, inventory }));
  assert.throws(
    () => assertApplySafety({ args: applyArgs, env: { ...safeEnvironment, PDL_DELETION_ACCEPTANCE_DISPOSABLE: '0' }, databaseUrl: firstUrl, identity, inventory }),
    /PDL_DELETION_ACCEPTANCE_DISPOSABLE/
  );
  assert.throws(
    () => assertApplySafety({ args: applyArgs, env: { ...safeEnvironment, PDL_PRODUCTION_DATABASE_FINGERPRINT: expectedFingerprint }, databaseUrl: firstUrl, identity, inventory }),
    /matches production/
  );
  assert.throws(
    () => assertApplySafety({ args: applyArgs, env: safeEnvironment, databaseUrl: firstUrl, identity, inventory: { ...inventory, companyCount: 1 } }),
    /zero companies/
  );
  assert.throws(
    () => assertApplySafety({ args: applyArgs, env: safeEnvironment, databaseUrl: firstUrl, identity, inventory: { ...inventory, privilegedVisibility: false } }),
    /BYPASSRLS/
  );
  assert.throws(
    () => assertApplySafety({ args: applyArgs, env: safeEnvironment, databaseUrl: firstUrl, identity, inventory: { ...inventory, platformRecordCount: 1 } }),
    /platform repository rows/
  );
  assert.throws(
    () => assertApplySafety({ args: applyArgs, env: safeEnvironment, databaseUrl: firstUrl, identity, inventory: { ...inventory, schemaReady: false } }),
    /migrations through 015/
  );
  const loopbackUrl = 'postgresql://postgres:local-secret@127.0.0.1:5432/pdl_disposable';
  assert.throws(
    () => assertApplySafety({
      args: applyArgs,
      env: { PDL_DELETION_ACCEPTANCE_DISPOSABLE: '1' },
      databaseUrl: loopbackUrl,
      identity,
      inventory
    }),
    /PDL_PRODUCTION_DATABASE_FINGERPRINT/
  );
  assert.doesNotThrow(() => assertApplySafety({
    args: applyArgs,
    env: safeEnvironment,
    databaseUrl: loopbackUrl,
    identity,
    inventory
  }));
  const noTlsUrl = firstUrl.replace('sslmode=require', 'sslmode=disable');
  assert.throws(
    () => assertApplySafety({
      args: applyArgs,
      env: safeEnvironment,
      databaseUrl: noTlsUrl,
      identity,
      inventory
    }),
    /require TLS/
  );

  const recoveryManifestPath = path.join(temp, 'interrupted-manifest.json');
  const recoveryRunId = crypto.randomUUID();
  const recoveryTenants = ['future-hold', 'legal-hold', 'wrong-status', 'primary'].map(scenario =>
    syntheticTenant(recoveryRunId, scenario)
  );
  fs.writeFileSync(recoveryManifestPath, JSON.stringify({
    schemaVersion: 2,
    kind: 'pdl-deletion-concurrency-acceptance',
    runId: recoveryRunId,
    target: { fingerprint: expectedFingerprint },
    syntheticTenants: recoveryTenants.map(recoveryTenant => ({
      scenario: recoveryTenant.scenario,
      companyId: recoveryTenant.companyId,
      deletionRequestId: recoveryTenant.deletionRequestId,
      userId: recoveryTenant.ids.user
    }))
  }));
  const manifestSha256 = crypto.createHash('sha256').update(fs.readFileSync(recoveryManifestPath)).digest('hex');
  assert.equal(assertManifestHash(recoveryManifestPath, manifestSha256), manifestSha256);
  assert.throws(() => assertManifestHash(recoveryManifestPath, '0'.repeat(64)), /independently retained SHA-256/i);
  const cleanupArgs = parseArgs([
    `--cleanup-evidence=${recoveryManifestPath}`,
    `--manifest-sha256=${manifestSha256}`,
    `--expected-fingerprint=${expectedFingerprint}`,
    `--confirm-disposable=${CONFIRMATION_PHRASE}`
  ]);
  assert.equal(cleanupArgs.mode, 'cleanup');
  assert.equal(cleanupArgs.cleanupEvidencePath, recoveryManifestPath);
  assert.equal(cleanupArgs.manifestSha256, manifestSha256);
  assert.equal(readRecoveryEvidence(recoveryManifestPath).syntheticTenants.length, 4);
  const provenanceTenant = recoveryTenants.find(item => item.scenario === 'primary');
  const provenanceManifest = { runId: recoveryRunId };
  const activeProvenance = {
    company: [{ slug: `company-${provenanceTenant.companyId}`, name: 'PDL DELETE ACCEPTANCE primary', data: {} }],
    revision: [{
      revision: 1,
      scalar_data: {
        company: {
          id: provenanceTenant.companyId,
          name: 'PDL DELETE ACCEPTANCE primary',
          deletionRequest: { id: provenanceTenant.deletionRequestId }
        }
      }
    }],
    marker: [{ data: { id: `${recoveryRunId}:primary`, synthetic: true } }],
    tombstone: [],
    user: [{
      email: `pdl-delete-${provenanceTenant.companyId}@example.invalid`,
      name: 'Synthetic Acceptance User',
      status: 'active'
    }],
    scopedRows: 5
  };
  assert.deepEqual(
    validateSyntheticProvenanceRows(provenanceManifest, provenanceTenant, activeProvenance),
    { scenario: 'primary', state: 'active_synthetic' }
  );
  assert.throws(() => validateSyntheticProvenanceRows(provenanceManifest, provenanceTenant, {
    ...activeProvenance,
    marker: [{ data: { id: 'forged', synthetic: true } }]
  }), /not proven synthetic/i);
  assert.deepEqual(validateSyntheticProvenanceRows(provenanceManifest, provenanceTenant, {
    company: [{
      slug: `deleted-${provenanceTenant.companyId}`,
      name: 'Deleted tenant',
      data: { company: { id: provenanceTenant.companyId, deletionRequestId: provenanceTenant.deletionRequestId } }
    }],
    revision: [],
    marker: [],
    user: [],
    scopedRows: 0,
    tombstone: [{
      deletion_request_id: provenanceTenant.deletionRequestId,
      terminal_revision: 1,
      tombstone_version: 1
    }]
  }), { scenario: 'primary', state: 'finalized_synthetic' });
  assert.deepEqual(validateSyntheticProvenanceRows(provenanceManifest, provenanceTenant, {
    company: [], revision: [], marker: [], tombstone: [], user: [], scopedRows: 0
  }), { scenario: 'primary', state: 'not_seeded' });
  assert.throws(() => validateSyntheticProvenanceRows(provenanceManifest, provenanceTenant, {
    company: [], revision: [], marker: [], tombstone: [], user: [], scopedRows: 1
  }), /orphaned provenance rows/i);
  const nonFullTenant = recoveryTenants.find(item => item.scenario === 'future-hold');
  assert.throws(() => validateSyntheticProvenanceRows(provenanceManifest, nonFullTenant, {
    company: [], revision: [], marker: [], tombstone: [],
    user: [{ email: 'rogue@example.invalid', name: 'Rogue', status: 'active' }],
    scopedRows: 0
  }), /unexpectedly owns a user row/i);
  assert.doesNotThrow(() => assertApplySafety({ args: cleanupArgs, env: safeEnvironment, databaseUrl: firstUrl, identity, inventory }));
  assert.throws(() => parseArgs([
    `--cleanup-evidence=${recoveryManifestPath}`,
    `--expected-fingerprint=${expectedFingerprint}`,
    `--confirm-disposable=${CONFIRMATION_PHRASE}`
  ]), /manifest-sha256/i);
  fs.writeFileSync(path.join(temp, 'bad-manifest.json'), '{"kind":"wrong"}');
  assert.throws(() => readRecoveryEvidence(path.join(temp, 'bad-manifest.json')), /supported PDL/i);

  const tenant = syntheticTenant('unit-run', 'primary', { full: true });
  const cases = guardedWriteCases(tenant);
  assert.equal(cases.length, GUARDED_TABLES.length * GUARDED_EVENTS.length);
  for (const table of GUARDED_TABLES) {
    assert.deepEqual(
      cases.filter(item => item.table === table).map(item => item.operation).sort(),
      [...GUARDED_EVENTS].sort(),
      `${table} must exercise INSERT, UPDATE, and DELETE after the durable lock`
    );
  }
  assert(cases.every(item => /^\s*(INSERT|UPDATE|DELETE)\s/i.test(item.sql)));
  const preLockCases = preLockLifecycleCases(tenant);
  assert.equal(preLockCases.length, GUARDED_TABLES.length);
  assert.deepEqual(preLockCases.map(item => item.table).sort(), [...GUARDED_TABLES].sort());
  assert(preLockCases.every(item => item.insert && item.update && item.remove));
  const receiver = syntheticTenant('unit-run', 'receiver');
  const moves = tenantMoveCases(tenant, receiver.companyId);
  assert.equal(moves.length, GUARDED_TABLES.length);
  assert.deepEqual(moves.map(item => item.table).sort(), [...GUARDED_TABLES].sort());
  assert(moves.every(item => item.operation === 'TENANT_MOVE' && /^\s*UPDATE\s/i.test(item.sql)));

  const migration015 = fs.readFileSync(path.join(__dirname, '015_resumable_tenant_deletion.sql'), 'utf8');
  assert.match(migration015, /OLD\.company_id IS DISTINCT FROM NEW\.company_id/);
  assert.match(migration015, /PDL_TENANT_ID_IMMUTABLE/);
  assert.match(migration015, /CREATE TABLE IF NOT EXISTS private\.tenant_deletion_finalizers/);
  assert.match(migration015, /ALTER TABLE private\.tenant_deletion_finalizers DISABLE ROW LEVEL SECURITY/);
  assert.match(migration015, /finalizer\.transaction_id = pg_current_xact_id\(\)::text/);
  assert.match(migration015, /REVOKE ALL ON TABLE private\.tenant_deletion_finalizers FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(migration015, /GRANT SELECT, INSERT, DELETE ON TABLE private\.tenant_deletion_finalizers TO %I/);
  assert.match(migration015, /GRANT SELECT ON TABLE private\.tenant_tombstones, private\.tenant_deletion_operations TO %I/);
  assert.match(migration015, /role\.rolsuper OR role\.rolbypassrls/);
  assert.match(migration015, /GRANT USAGE ON SCHEMA public TO service_role/);
  assert.match(migration015, /REVOKE ALL PRIVILEGES ON TABLE private\.tenant_deletion_finalizers FROM %I/);
  assert.match(migration015, /effective access to the deletion finalizer capability/);
  const migrationPredefinedRoleExemptions = migration015.match(
    /candidate\.rolname IN \('pg_read_all_data','pg_write_all_data'\)[\s\S]{0,120}AND NOT candidate\.rolcanlogin[\s\S]{0,120}AND candidate\.oid < 16384::oid/g
  ) || [];
  assert.equal(
    migrationPredefinedRoleExemptions.length,
    2,
    'migration enforcement and deployment evidence must share the exact predefined NOLOGIN-role exception'
  );
  assert.match(
    migration015,
    /Any login or custom role inheriting either remains its own[\s\S]{0,100}has_table_privilege/
  );
  assert.match(migration015, /REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(migration015, /missing direct EXECUTE/);
  assert.match(migration015, /grantable EXECUTE/);

  const harnessSource = fs.readFileSync(path.join(__dirname, 'deletion-concurrency-acceptance.js'), 'utf8');
  assert.match(harnessSource, /AS service_public_schema_usage/);
  assert.match(harnessSource, /SET LOCAL ROLE service_role/);
  assert.match(harnessSource, /untrusted_table_owner/);
  assert.match(harnessSource, /unexpected_explicit_execute/);
  assert.match(harnessSource, /service_grantable_execute/);
  const harnessPredefinedRoleExemptions = harnessSource.match(
    /candidate\.rolname IN \('pg_read_all_data','pg_write_all_data'\)[\s\S]{0,120}AND NOT candidate\.rolcanlogin[\s\S]{0,120}AND candidate\.oid < 16384::oid/g
  ) || [];
  assert.equal(
    harnessPredefinedRoleExemptions.length,
    1,
    'acceptance preflight must use the same exact predefined NOLOGIN-role exception'
  );
  assert.match(harnessSource, /pg_catalog\.has_table_privilege\(candidate\.oid,finalizer\.oid,'SELECT'\)/);
  assert.match(harnessSource, /writeAfterUncommittedLockSerialized/);
  assert.match(harnessSource, /LOCK TABLE \$\{RECOVERY_LOCK_TABLES\.join\(', '\)\} IN ACCESS EXCLUSIVE MODE/);
  assert.match(harnessSource, /cleanupRecordedSyntheticTenants\(pool, recoveryManifest, tenants\)/);
  assert.match(harnessSource, /email=\$2[\s\S]*name='Synthetic Acceptance User'[\s\S]*status='active'/);
  assert.doesNotMatch(harnessSource, /fileSha256\(/);

  const boundedPool = createPool('postgresql://postgres:secret@127.0.0.1:5432/disposable');
  assert.equal(boundedPool.options.connectionTimeoutMillis, 10_000);
  await boundedPool.end();

  for (const helper of [lockBehindInFlightWrite, writeBehindUncommittedDeletion]) {
    let connections = 0;
    let released = false;
    const firstClient = { release() { released = true; } };
    const failingPool = {
      async connect() {
        connections += 1;
        if (connections === 1) return firstClient;
        throw new Error('synthetic second connection failure');
      }
    };
    await assert.rejects(() => helper(failingPool, tenant), /synthetic second connection failure/);
    assert.equal(released, true, `${helper.name} must release the first client when the second acquisition fails`);
  }

  const redacted = safeError(new Error('connection postgresql://user:secret@example.test/postgres failed'));
  assert.doesNotMatch(redacted.message, /secret/);
  assert.match(redacted.message, /database-url-redacted/);
  assert.match(usage(), /--preview/);
  assert.match(usage(), /--cleanup-evidence/);
  assert.match(usage(), /--manifest-sha256/);
  assert.match(usage(), new RegExp(CONFIRMATION_PHRASE));

  fs.writeFileSync(evidencePath, '{}');
  assert.throws(
    () => assertApplySafety({ args: applyArgs, env: safeEnvironment, databaseUrl: firstUrl, identity, inventory }),
    /already exists/
  );

  console.log('Deletion/concurrency acceptance safety tests passed: destructive execution is explicit, fingerprint-bound, empty-database-only, and covers every guarded event.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
