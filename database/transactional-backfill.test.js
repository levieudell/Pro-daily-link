'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CONFIRMATION,
  parseArgs,
  buildPlan,
  execute
} = require('./transactional-backfill');
const {
  EXPECTED_POPULATION_SCHEMA,
  canonicalSnapshotState,
  opaqueTenantRef
} = require('./shadow-reconciliation');
const { splitSnapshot, canonicalHash } = require('./transactional-repository');

const IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333'
];
const PROJECT_REF = 'abcdefghijklmnopqrst';
const SERVICE_ID = 'srv-abcdefghijklmnopqrst';
const INSTANCE_ID = 'instance-transactional-backfill';
const RELEASE_SHA = 'a'.repeat(40);

function snapshot(id, name = `Tenant ${id[0]}`) {
  return {
    company: { id, name, createdAt: '2026-10-20T00:00:00.000Z' },
    users: [{ id: `user-${id[0]}`, email: `${id[0]}@example.test`, status: 'Active' }],
    projects: [{ id: `project-${id[0]}`, name: `Project ${id[0]}` }],
    reports: []
  };
}

function transactionalRow(value, revision = 0) {
  const { scalarData, records } = splitSnapshot(value);
  return {
    companyId: value.company.id,
    revision,
    scalarData,
    contentHash: canonicalHash(value),
    records: records.map(row => ({
      collection: row.collection,
      recordKey: row.recordKey,
      position: row.position,
      data: row.data
    }))
  };
}

function response(payload, ok = true, status = ok ? 200 : 500) {
  return { ok, status, async json() { return structuredClone(payload); } };
}

function transport({ legacySnapshots, transactional = new Map(), timeoutAfterCommit = false, timeoutBeforeCommit = false, serverErrorAfterCommit = false }) {
  const legacy = new Map(legacySnapshots.map(value => [value.company.id, structuredClone(value)]));
  const writes = [];
  let timeoutUsed = false;
  const request = async (relativePath, options = {}) => {
    if (options.signal?.aborted) throw new TypeError('fetch failed');
    if (relativePath.startsWith('/rest/v1/companies?select=id,data&order=id.asc')) {
      const url = new URL(`https://example.invalid${relativePath}`);
      const cursor = String(url.searchParams.get('id') || '').replace(/^gt\./, '');
      const limit = Number(url.searchParams.get('limit'));
      const rows = [...legacy.entries()].sort(([a], [b]) => a.localeCompare(b))
        .filter(([id]) => !cursor || id > cursor)
        .slice(0, limit)
        .map(([id, data]) => ({ id, data }));
      return response(rows);
    }
    if (relativePath.startsWith('/rest/v1/companies?id=eq.')) {
      const match = /id=eq\.([^&]+)/.exec(relativePath);
      const id = decodeURIComponent(match?.[1] || '');
      return response(legacy.has(id) ? [{ id, data: legacy.get(id) }] : []);
    }
    if (relativePath === '/rest/v1/rpc/list_tenant_repository_page') {
      const body = JSON.parse(options.body);
      const cursor = body.p_after_company_id;
      const limit = Number(body.p_limit);
      const rows = [...transactional.entries()].sort(([a], [b]) => a.localeCompare(b))
        .filter(([id]) => !cursor || id > cursor)
        .slice(0, limit)
        .map(([, row]) => row);
      return response({ rows, nextCompanyId: rows.length === limit ? rows.at(-1).companyId : null });
    }
    if (relativePath === '/rest/v1/rpc/load_tenant_repository') {
      const id = JSON.parse(options.body).p_company_id;
      return response(transactional.get(id) || null);
    }
    if (relativePath === '/rest/v1/rpc/initialize_tenant_repository_from_legacy') {
      const body = JSON.parse(options.body);
      writes.push(body.p_company_id);
      if (timeoutBeforeCommit) throw new TypeError('fetch failed before an observable commit');
      assert.equal(transactional.has(body.p_company_id), false, 'initializer must never overwrite an existing tenant');
      assert.deepEqual(body.p_source_snapshot, legacy.get(body.p_company_id));
      const value = body.p_source_snapshot;
      transactional.set(body.p_company_id, transactionalRow(value, 0));
      if (timeoutAfterCommit && !timeoutUsed) {
        timeoutUsed = true;
        throw new TypeError('fetch failed after commit');
      }
      if (serverErrorAfterCommit && !timeoutUsed) {
        timeoutUsed = true;
        return response({ code: 'gateway_error' }, false, 503);
      }
      return response({
        status: 'initialized',
        companyId: body.p_company_id,
        revision: 0,
        recordCount: body.p_records.length,
        contentHash: body.p_content_hash
      });
    }
    throw new Error(`unexpected request ${relativePath}`);
  };
  return { request, legacy, transactional, writes };
}

function environment() {
  return {
    NODE_ENV: 'production',
    PDL_SUPABASE_ENABLED: '1',
    SUPABASE_URL: `https://${PROJECT_REF}.supabase.co`,
    SUPABASE_SECRET_KEY: 'not-printed-test-secret',
    PDL_PRODUCTION_SUPABASE_PROJECT_REF: PROJECT_REF,
    PDL_TRANSACTIONAL_DB: 'shadow',
    PDL_PLATFORM_TRANSACTIONAL_DB: 'shadow',
    PDL_MAINTENANCE_MODE: '1',
    RENDER: 'true',
    RENDER_SERVICE_TYPE: 'web',
    RENDER_SERVICE_ID: SERVICE_ID,
    RENDER_INSTANCE_ID: INSTANCE_ID,
    RENDER_EXTERNAL_URL: 'https://pro-daily-link-demo.onrender.com',
    RENDER_GIT_COMMIT: RELEASE_SHA,
    IS_PULL_REQUEST: 'false',
    PORT: '10000'
  };
}

function fenceApi({ changeAfter = Infinity } = {}) {
  let reads = 0;
  return {
    requireVerifiedFence() {
      reads += 1;
      return {
        digest: reads > changeAfter ? 'b'.repeat(64) : 'a'.repeat(64),
        openedAt: '2026-10-20T00:00:00.000Z',
        mode: 'read_only',
        source: 'environment_and_lock',
        identity: { provider: 'render', serviceId: SERVICE_ID, instanceId: INSTANCE_ID, releaseSha: RELEASE_SHA }
      };
    }
  };
}

function workspace(ids, { apply = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-backfill-test-'));
  const manifest = {
    schema: EXPECTED_POPULATION_SCHEMA,
    tenantCount: ids.length,
    tenantRefs: ids.map(opaqueTenantRef).sort()
  };
  const manifestFile = path.join(root, 'population.json');
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(manifestFile, bytes, { flag: 'wx', mode: 0o600 });
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const evidence = path.join(root, apply ? 'apply.json' : 'preview.json');
  const argv = [
    '--all', '--evidence', evidence,
    '--production-target', PROJECT_REF,
    '--expected-service-id', SERVICE_ID,
    '--expected-instance-id', INSTANCE_ID,
    '--expected-population-manifest', manifestFile,
    '--expected-population-sha256', sha256
  ];
  if (apply) argv.push(
    '--apply',
    '--confirm-population-sha256', sha256,
    '--confirm-action', CONFIRMATION
  );
  return { root, manifest, manifestFile, sha256, evidence, args: parseArgs(argv) };
}

function dependencies(adapter, options = {}) {
  return {
    request: adapter.request,
    maintenanceFence: options.maintenanceFence || fenceApi(),
    verifyAttachedRuntime: async () => true
  };
}

async function run() {
  assert.throws(() => parseArgs([]), /requires --all/);
  assert.throws(() => parseArgs(['--all']), /evidence.*absolute/i);
  const parsedWorkspace = workspace([IDS[0]], { apply: true });
  assert.equal(parsedWorkspace.args.apply, true);
  assert.equal(parsedWorkspace.args.confirmAction, CONFIRMATION);
  assert.throws(() => parseArgs([
    '--all', '--apply', '--evidence', parsedWorkspace.evidence,
    '--production-target', PROJECT_REF,
    '--expected-service-id', SERVICE_ID,
    '--expected-instance-id', INSTANCE_ID,
    '--expected-population-manifest', parsedWorkspace.manifestFile,
    '--expected-population-sha256', parsedWorkspace.sha256,
    '--confirm-population-sha256', parsedWorkspace.sha256,
    '--confirm-action', 'OVERWRITE TENANTS'
  ]), /INITIALIZE ONLY MISSING/);
  fs.rmSync(parsedWorkspace.root, { recursive: true, force: true });

  const first = snapshot(IDS[0]);
  const second = snapshot(IDS[1]);

  const unavailableEvidenceWorkspace = workspace([IDS[0]], { apply: true });
  unavailableEvidenceWorkspace.args.evidence = path.join(unavailableEvidenceWorkspace.root, 'missing-directory', 'apply.json');
  const unavailableEvidenceAdapter = transport({ legacySnapshots: [first] });
  await assert.rejects(
    execute(unavailableEvidenceWorkspace.args, environment(), dependencies(unavailableEvidenceAdapter)),
    error => error.code === 'EVIDENCE_DESTINATION_UNAVAILABLE'
  );
  assert.equal(unavailableEvidenceAdapter.writes.length, 0, 'an unusable evidence destination must fail before provider mutation');
  fs.rmSync(unavailableEvidenceWorkspace.root, { recursive: true, force: true });

  const expectedPopulation = {
    schema: EXPECTED_POPULATION_SCHEMA,
    tenantCount: 2,
    tenantRefs: [opaqueTenantRef(IDS[0]), opaqueTenantRef(IDS[1])].sort()
  };
  const legacyMap = new Map([
    [IDS[0], { id: IDS[0], state: canonicalSnapshotState(first) }],
    [IDS[1], { id: IDS[1], state: canonicalSnapshotState(second) }]
  ]);
  const transactionalMap = new Map([
    [IDS[0], { id: IDS[0], state: { ...canonicalSnapshotState(first), repositoryRevision: 9, storedSha256: canonicalHash(first), integrity: true } }]
  ]);
  const plan = buildPlan({
    legacy: { map: legacyMap, excluded: { platform: 1, connector: 2, archived: 3, deleted: 4 } },
    transactional: { map: transactionalMap, excluded: { connector: 0, archived: 0, deleted: 0 } }
  }, expectedPopulation);
  assert.equal(plan.status, 'ready');
  assert.equal(plan.initializeTenants, 1);
  assert.equal(plan.exactTenants, 1);
  assert.deepEqual(plan.excludedLegacyRows, { platform: 1, connector: 2, archived: 3, deleted: 4 });

  const previewWorkspace = workspace([IDS[0], IDS[1]]);
  const previewAdapter = transport({ legacySnapshots: [first, second], transactional: new Map([[IDS[0], transactionalRow(first, 9)]]) });
  const preview = await execute(previewWorkspace.args, environment(), dependencies(previewAdapter));
  assert.equal(preview.status, 'ready');
  assert.equal(preview.writesPerformed, false);
  assert.equal(preview.plan.initializeTenants, 1);
  assert.equal(previewAdapter.writes.length, 0);
  assert.equal(fs.existsSync(previewWorkspace.evidence), true);
  assert.equal(fs.existsSync(`${previewWorkspace.evidence}.sha256`), true);
  fs.rmSync(previewWorkspace.root, { recursive: true, force: true });

  const connector = snapshot(IDS[2]);
  connector.mcpOauth = { provider: 'synthetic' };
  const filteredWorkspace = workspace([IDS[0], IDS[1]]);
  const filteredAdapter = transport({ legacySnapshots: [first, second, connector] });
  const filtered = await execute(filteredWorkspace.args, environment(), dependencies(filteredAdapter));
  assert.equal(filtered.status, 'ready');
  assert.equal(filtered.plan.eligibleLegacyTenants, 2);
  assert.equal(filtered.plan.excludedLegacyRows.connector, 1);
  assert.equal(filteredAdapter.writes.length, 0);
  fs.rmSync(filteredWorkspace.root, { recursive: true, force: true });

  const malformedWorkspace = workspace([IDS[0]]);
  const malformed = { company: { name: 'No tenant identity' }, users: [] };
  const malformedAdapter = transport({ legacySnapshots: [{ ...malformed, company: { ...malformed.company, id: IDS[0] } }] });
  malformedAdapter.legacy.set(IDS[0], malformed);
  await assert.rejects(
    execute(malformedWorkspace.args, environment(), dependencies(malformedAdapter)),
    error => error.code === 'PROVIDER_PAYLOAD_INVALID'
  );
  assert.equal(malformedAdapter.writes.length, 0);
  fs.rmSync(malformedWorkspace.root, { recursive: true, force: true });

  const applyWorkspace = workspace([IDS[0], IDS[1]], { apply: true });
  const applyAdapter = transport({ legacySnapshots: [first, second], transactional: new Map([[IDS[0], transactionalRow(first, 9)]]) });
  const applied = await execute(applyWorkspace.args, environment(), dependencies(applyAdapter));
  assert.equal(applied.status, 'verified');
  assert.equal(applied.target.attachedLiveness, true);
  assert.equal(applied.initialized.length, 1);
  assert.deepEqual(applyAdapter.writes, [IDS[1]]);
  assert.equal(applyAdapter.transactional.get(IDS[0]).revision, 9, 'exact existing tenant must remain untouched');
  assert.equal(applyAdapter.transactional.get(IDS[1]).revision, 0, 'missing tenant must initialize at revision zero');
  const evidenceText = fs.readFileSync(applyWorkspace.evidence, 'utf8');
  assert.doesNotMatch(evidenceText, new RegExp(IDS[0], 'i'));
  assert.doesNotMatch(evidenceText, /Tenant 1|Tenant 2/);
  const persistedDigest = crypto.createHash('sha256').update(fs.readFileSync(applyWorkspace.evidence)).digest('hex');
  assert.equal(fs.readFileSync(`${applyWorkspace.evidence}.sha256`, 'utf8'), `${persistedDigest}\n`);
  fs.rmSync(applyWorkspace.root, { recursive: true, force: true });

  const timeoutWorkspace = workspace([IDS[0]], { apply: true });
  const timeoutAdapter = transport({ legacySnapshots: [first], timeoutAfterCommit: true });
  const recovered = await execute(timeoutWorkspace.args, environment(), dependencies(timeoutAdapter));
  assert.equal(recovered.status, 'verified');
  assert.equal(recovered.initialized[0].outcomeRecoveredAfterError, true);
  assert.equal(timeoutAdapter.writes.length, 1, 'an ambiguous committed response must be reconciled, not written twice');
  fs.rmSync(timeoutWorkspace.root, { recursive: true, force: true });

  const serverErrorWorkspace = workspace([IDS[0]], { apply: true });
  const serverErrorAdapter = transport({ legacySnapshots: [first], serverErrorAfterCommit: true });
  const serverErrorRecovered = await execute(serverErrorWorkspace.args, environment(), dependencies(serverErrorAdapter));
  assert.equal(serverErrorRecovered.status, 'verified');
  assert.equal(serverErrorRecovered.initialized[0].outcomeRecoveredAfterError, true);
  assert.equal(serverErrorAdapter.writes.length, 1, 'a committed 5xx response must reconcile before any retry');
  fs.rmSync(serverErrorWorkspace.root, { recursive: true, force: true });

  const unknownWorkspace = workspace([IDS[0]], { apply: true });
  const unknownAdapter = transport({ legacySnapshots: [first], timeoutBeforeCommit: true });
  await assert.rejects(
    execute(unknownWorkspace.args, environment(), dependencies(unknownAdapter)),
    error => error.code === 'WRITE_OUTCOME_UNKNOWN'
  );
  assert.equal(unknownAdapter.writes.length, 2, 'an ambiguous write may be retried only after exact absence is observed');
  const unknownEvidence = JSON.parse(fs.readFileSync(unknownWorkspace.evidence, 'utf8'));
  assert.equal(unknownEvidence.writesPerformed, null, 'evidence must never claim no write after a mutation was dispatched');
  assert.equal(unknownEvidence.writeOutcome, 'outcome-unknown');
  assert.deepEqual(unknownEvidence.mutationAttempts.map(item => item.status), ['dispatched-outcome-unverified']);
  assert.deepEqual(unknownEvidence.mutationAttempts.map(item => item.dispatches), [2]);
  fs.rmSync(unknownWorkspace.root, { recursive: true, force: true });

  const driftWorkspace = workspace([IDS[0]], { apply: true });
  const changed = snapshot(IDS[0], 'Divergent');
  const driftAdapter = transport({ legacySnapshots: [first], transactional: new Map([[IDS[0], transactionalRow(changed, 2)]]) });
  await assert.rejects(
    execute(driftWorkspace.args, environment(), dependencies(driftAdapter)),
    error => error.code === 'BACKFILL_DRIFT'
  );
  assert.equal(driftAdapter.writes.length, 0);
  const driftEvidence = JSON.parse(fs.readFileSync(driftWorkspace.evidence, 'utf8'));
  assert.equal(driftEvidence.status, 'inconclusive');
  assert.equal(driftEvidence.writesPerformed, false);
  assert.equal(driftEvidence.reason, 'BACKFILL_DRIFT');
  fs.rmSync(driftWorkspace.root, { recursive: true, force: true });

  const excludedTransactionalWorkspace = workspace([IDS[0]], { apply: true });
  const archivedTransactional = snapshot(IDS[0]);
  archivedTransactional.company.archivedDuplicate = true;
  const excludedTransactionalAdapter = transport({
    legacySnapshots: [first],
    transactional: new Map([[IDS[0], transactionalRow(archivedTransactional, 0)]])
  });
  await assert.rejects(
    execute(excludedTransactionalWorkspace.args, environment(), dependencies(excludedTransactionalAdapter)),
    error => error.code === 'BACKFILL_DRIFT'
  );
  assert.equal(excludedTransactionalAdapter.writes.length, 0);
  const excludedTransactionalEvidence = JSON.parse(fs.readFileSync(excludedTransactionalWorkspace.evidence, 'utf8'));
  assert.equal(excludedTransactionalEvidence.before.driftTenants, 1);
  assert.deepEqual(excludedTransactionalEvidence.before.tenants[0].issues, ['transactional_archived']);
  fs.rmSync(excludedTransactionalWorkspace.root, { recursive: true, force: true });

  const unexpectedWorkspace = workspace([IDS[0]], { apply: true });
  const unexpectedAdapter = transport({ legacySnapshots: [first, snapshot(IDS[2])], transactional: new Map() });
  await assert.rejects(
    execute(unexpectedWorkspace.args, environment(), dependencies(unexpectedAdapter)),
    error => error.code === 'BACKFILL_DRIFT'
  );
  assert.equal(unexpectedAdapter.writes.length, 0);
  fs.rmSync(unexpectedWorkspace.root, { recursive: true, force: true });

  const fenceWorkspace = workspace([IDS[0]], { apply: true });
  const fenceAdapter = transport({ legacySnapshots: [first] });
  await assert.rejects(
    execute(fenceWorkspace.args, environment(), dependencies(fenceAdapter, { maintenanceFence: fenceApi({ changeAfter: 2 }) })),
    error => error.code === 'MAINTENANCE_FENCE_CHANGED'
  );
  assert.equal(fenceAdapter.writes.length, 0);
  fs.rmSync(fenceWorkspace.root, { recursive: true, force: true });

  const targetWorkspace = workspace([IDS[0]]);
  const wrongEnv = { ...environment(), PDL_PRODUCTION_SUPABASE_PROJECT_REF: 'zzzzzzzzzzzzzzzzzzzz' };
  await assert.rejects(
    execute(targetWorkspace.args, wrongEnv, dependencies(transport({ legacySnapshots: [first] }))),
    error => error.code === 'PRODUCTION_TARGET_MISMATCH'
  );
  fs.rmSync(targetWorkspace.root, { recursive: true, force: true });

  const controller = new AbortController();
  controller.abort();
  const interruptedWorkspace = workspace([IDS[0]]);
  await assert.rejects(
    execute(interruptedWorkspace.args, environment(), { ...dependencies(transport({ legacySnapshots: [first] })), signal: controller.signal }),
    error => error.code === 'INTERRUPTED'
  );
  fs.rmSync(interruptedWorkspace.root, { recursive: true, force: true });

  console.log('Transactional legacy backfill safety tests passed.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
