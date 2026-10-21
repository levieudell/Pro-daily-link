'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  SCHEMA,
  EXPECTED_POPULATION_SCHEMA,
  ShadowReconciliationError,
  canonicalSnapshotState,
  opaqueTenantRef,
  loadExpectedPopulationManifest,
  listLocalTenantEntries,
  readOnlyTransport,
  streamLegacyCatalog,
  captureCatalog,
  catalogSignature,
  compareCatalog,
  validateRuntime,
  releaseSha,
  writeEvidenceExclusive
} = require('./shadow-reconciliation');
const { main, verifyAttachedRuntime } = require('./reconcile-shadow');
const {
  splitSnapshot,
  canonicalHash: tenantCanonicalHash
} = require('./transactional-repository');
const {
  PLATFORM_NAMESPACE_ID,
  splitPlatformSnapshot,
  canonicalHash: platformCanonicalHash
} = require('./platform-repository');

const RELEASE_SHA = '0123456789abcdef0123456789abcdef01234567';
const PII = Object.freeze({
  company: 'SENTINEL SHADOW CONTRACTOR',
  person: 'SENTINEL PRIVATE OWNER',
  email: 'sentinel.shadow.owner@example.test',
  token: 'sentinel-shadow-session-token',
  notes: 'sentinel confidential field note',
  storage: 'private/sentinel/customer-object.jpg'
});

function response(payload, ok = true) {
  return { ok, async json() { return structuredClone(payload); } };
}

function tenantId(index) {
  const value = Number(index).toString(16);
  return `${value.padStart(8, '0')}-1111-4111-8111-${value.padStart(12, '0')}`;
}

function tenantSnapshot(id, marker = 'exact') {
  return {
    company: {
      id,
      name: PII.company,
      persistence: { revision: 7, updatedAt: '2026-10-20T20:00:00.000Z' }
    },
    users: [{ id: 1, name: PII.person, email: PII.email, passwordHash: PII.token }],
    reports: [{ id: 1, notes: `${PII.notes}:${marker}`, photos: [{ storagePath: PII.storage }] }],
    sessions: [{ tokenHash: PII.token }],
    settings: { marker }
  };
}

function platformSnapshot(marker = 'exact') {
  return {
    users: [{ id: 1, name: PII.person, email: PII.email, role: 'platform_owner' }],
    notes: [{ id: 1, body: `${PII.notes}:${marker}` }]
  };
}

function transactionalRow(snapshot) {
  const { scalarData, records } = splitSnapshot(snapshot);
  return {
    company_id: snapshot.company.id,
    revision: 7,
    scalar_data: scalarData,
    records: records.map(({ collection, data }) => ({ collection, data })),
    content_hash: tenantCanonicalHash(snapshot)
  };
}

function platformRow(snapshot, namespaceId = PLATFORM_NAMESPACE_ID) {
  const { scalarData, records } = splitPlatformSnapshot(snapshot);
  return {
    namespaceId,
    revision: 3,
    scalar_data: scalarData,
    records: records.map(({ collection, data }) => ({ collection, data })),
    content_hash: platformCanonicalHash(snapshot)
  };
}

function cloneCatalog(catalog) {
  return {
    tenants: {
      local: new Map([...catalog.tenants.local].map(([key, value]) => [key, structuredClone(value)])),
      legacy: new Map([...catalog.tenants.legacy].map(([key, value]) => [key, structuredClone(value)])),
      transactional: new Map([...catalog.tenants.transactional].map(([key, value]) => [key, structuredClone(value)]))
    },
    excludedLegacyRows: structuredClone(catalog.excludedLegacyRows),
    excludedTransactionalRows: structuredClone(catalog.excludedTransactionalRows),
    platform: structuredClone(catalog.platform)
  };
}

function assertNoPii(value, label = 'value') {
  const encoded = typeof value === 'string' ? value : JSON.stringify(value);
  for (const sentinel of Object.values(PII)) {
    assert.doesNotMatch(encoded, new RegExp(sentinel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `${label} leaked ${sentinel}`);
  }
}

function errorCode(code) {
  return error => {
    assert.ok(error instanceof ShadowReconciliationError, `expected a bounded reconciliation error, received ${error}`);
    assert.equal(error.code, code);
    assertNoPii(String(error), 'error message');
    assertNoPii(error, 'serialized error');
    return true;
  };
}

function mockSupabase({ legacyRows, transactionalRows, transactionalPlatform }) {
  const calls = [];
  const orderedLegacy = [...legacyRows].sort((left, right) => left.id.localeCompare(right.id));
  const orderedTransactional = [...transactionalRows].sort((left, right) => left.company_id.localeCompare(right.company_id));

  const baseRequest = async (relativePath, options = {}) => {
    calls.push({
      relativePath,
      method: String(options.method || 'GET').toUpperCase(),
      body: options.body == null ? null : String(options.body)
    });
    const url = new URL(relativePath, 'https://mock-supabase.invalid');
    const method = String(options.method || 'GET').toUpperCase();

    if (method === 'GET' && url.pathname === '/rest/v1/companies') {
      const exact = url.searchParams.get('id');
      if (exact?.startsWith('eq.')) {
        const id = exact.slice(3).toLowerCase();
        return response(orderedLegacy.filter(row => row.id === id).slice(0, 1));
      }
      const after = url.searchParams.get('id')?.replace(/^gt\./, '') || '';
      const limit = Number(url.searchParams.get('limit'));
      const page = orderedLegacy.filter(row => !after || row.id > after).slice(0, limit);
      return response(page);
    }

    if (method === 'POST' && url.pathname === '/rest/v1/rpc/list_tenant_repository_page') {
      const body = JSON.parse(String(options.body));
      const after = body.p_after_company_id || '';
      const remaining = orderedTransactional.filter(row => !after || row.company_id > after);
      const rows = remaining.slice(0, body.p_limit);
      return response({
        rows,
        nextCompanyId: remaining.length > rows.length && rows.length ? rows.at(-1).company_id : null
      });
    }

    if (method === 'POST' && url.pathname === '/rest/v1/rpc/load_tenant_repository') {
      const body = JSON.parse(String(options.body));
      return response(orderedTransactional.find(row => row.company_id === body.p_company_id) || null);
    }

    if (method === 'POST' && url.pathname === '/rest/v1/rpc/load_platform_repository') {
      return response(transactionalPlatform);
    }

    throw new Error(`unexpected mock request: ${method} ${url.pathname}`);
  };

  return { request: readOnlyTransport(baseRequest, 2_000), baseRequest, calls };
}

function findTenant(result, id) {
  const ref = crypto.createHash('sha256').update(`pdl-shadow-reconciliation:v1:${id}`).digest('hex').slice(0, 24);
  return result.tenants.find(tenant => tenant.tenantRef === ref);
}

(async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-shadow-adapters-'));
  try {
    const dataDirectory = path.join(tempRoot, 'data');
    const tenantDirectory = path.join(dataDirectory, 'tenants');
    fs.mkdirSync(tenantDirectory, { recursive: true });

    // Exercise both local runtime layouts: the primary db.json and a tenant
    // shard, plus the separate platform repository file.
    const ids = Array.from({ length: 1005 }, (_, index) => tenantId(index + 1));
    const snapshots = ids.map(id => tenantSnapshot(id));
    const archived = tenantSnapshot(tenantId(1006), 'archived');
    archived.company.archivedDuplicate = true;
    const connector = tenantSnapshot(tenantId(1007), 'connector');
    connector.company.mcpConnector = true;
    const deleted = tenantSnapshot(tenantId(1008), 'deleted');
    deleted.company.deletedAt = '2026-10-20T19:00:00.000Z';
    const platform = platformSnapshot();
    const dbFile = path.join(dataDirectory, 'db.json');
    const platformFile = path.join(dataDirectory, 'platform.json');
    fs.writeFileSync(dbFile, `${JSON.stringify(snapshots[0])}\n`);
    fs.writeFileSync(path.join(tenantDirectory, `${ids[1]}.json`), `${JSON.stringify(snapshots[1])}\n`);
    fs.writeFileSync(path.join(tenantDirectory, `${archived.company.id}.json`), `${JSON.stringify(archived)}\n`);
    fs.writeFileSync(platformFile, `${JSON.stringify(platform)}\n`);

    const localAll = listLocalTenantEntries({ dbFile, scope: 'all' });
    assert.equal(localAll.size, 2);
    assert.deepEqual([...localAll.keys()].sort(), [ids[0], ids[1]].sort());
    const localTenant = listLocalTenantEntries({ dbFile, scope: 'tenant', companyId: ids[1] });
    assert.deepEqual([...localTenant.keys()], [ids[1]]);
    assert.throws(
      () => listLocalTenantEntries({ dbFile: path.join(tempRoot, 'missing', 'db.json'), scope: 'all' }),
      errorCode('LOCAL_SOURCE_MISSING')
    );

    const malformedRoot = path.join(tempRoot, 'malformed-local');
    fs.mkdirSync(malformedRoot, { recursive: true });
    const malformedPrimary = path.join(malformedRoot, 'db.json');
    fs.writeFileSync(malformedPrimary, '{}\n');
    assert.throws(
      () => listLocalTenantEntries({ dbFile: malformedPrimary, scope: 'all' }),
      errorCode('LOCAL_SOURCE_INVALID'),
      'a malformed primary snapshot must not be silently treated as an empty tenant catalog'
    );

    const wrongShardRoot = path.join(tempRoot, 'wrong-shard');
    const wrongShardDirectory = path.join(wrongShardRoot, 'tenants');
    fs.mkdirSync(wrongShardDirectory, { recursive: true });
    const wrongShardPrimary = path.join(wrongShardRoot, 'db.json');
    fs.writeFileSync(wrongShardPrimary, `${JSON.stringify(snapshots[0])}\n`);
    fs.writeFileSync(path.join(wrongShardDirectory, `${ids[2]}.json`), `${JSON.stringify(snapshots[1])}\n`);
    assert.throws(
      () => listLocalTenantEntries({ dbFile: wrongShardPrimary, scope: 'all' }),
      errorCode('LOCAL_SOURCE_ID_MISMATCH'),
      'a shard filename must be the database company ID inside that shard'
    );

    await assert.rejects(
      () => streamLegacyCatalog(async () => response([{ id: ids[0], data: { company: {} } }]), {
        pageSize: 10,
        maxPages: 2
      }),
      errorCode('PROVIDER_PAYLOAD_INVALID'),
      'a malformed legacy row must not disappear from the expected population'
    );
    await assert.rejects(
      () => streamLegacyCatalog(async () => response([{
        id: PLATFORM_NAMESPACE_ID,
        data: { platform, company: snapshots[0].company }
      }]), { pageSize: 10, maxPages: 2 }),
      errorCode('PROVIDER_PAYLOAD_INVALID'),
      'the reserved platform namespace must not carry tenant data or extra wrapper keys'
    );

    // The --all adapter path must cross the usual PostgREST 1,000-row edge
    // for both legacy JSON and normalized transactional storage. Platform is
    // captured through the same transport and compared at the same release.
    const legacyRows = snapshots.map(snapshot => ({ id: snapshot.company.id, data: snapshot }));
    legacyRows.push({ id: archived.company.id, data: archived });
    legacyRows.push({ id: connector.company.id, data: connector });
    legacyRows.push({ id: deleted.company.id, data: deleted });
    legacyRows.push({ id: PLATFORM_NAMESPACE_ID, data: { platform } });
    const transactionalRows = [
      ...snapshots.map(transactionalRow),
      transactionalRow(archived),
      transactionalRow(connector),
      transactionalRow(deleted)
    ];
    const transport = mockSupabase({
      legacyRows,
      transactionalRows,
      transactionalPlatform: platformRow(platform)
    });
    const catalog = await captureCatalog({
      request: transport.request,
      dbFile,
      platformFile,
      scope: 'all',
      companyId: ''
    });
    const exact = compareCatalog(catalog, { scope: 'all', companyId: '', releaseSha: RELEASE_SHA });
    assert.equal(exact.schema, SCHEMA);
    assert.equal(exact.status, 'reconciled');
    assert.equal(exact.writesPerformed, false);
    assert.equal(exact.releaseSha, RELEASE_SHA);
    assert.equal(exact.aggregate.tenantCount, 1005);
    assert.equal(exact.aggregate.reconciledTenants, 1005);
    assert.equal(exact.aggregate.legacyTenantRows, 1005);
    assert.equal(exact.aggregate.transactionalTenantRows, 1005);
    assert.equal(exact.aggregate.runtimeLocalTenantFiles, 2);
    assert.equal(exact.aggregate.excludedLegacyRows.platform, 1);
    assert.equal(exact.aggregate.excludedLegacyRows.archived, 1);
    assert.equal(exact.aggregate.excludedLegacyRows.connector, 1);
    assert.equal(exact.aggregate.excludedLegacyRows.deleted, 1);
    assert.equal(exact.aggregate.excludedTransactionalRows.archived, 1);
    assert.equal(exact.aggregate.excludedTransactionalRows.connector, 1);
    assert.equal(exact.aggregate.excludedTransactionalRows.deleted, 1);
    assert.equal(exact.aggregate.platformReconciled, true);
    assert.equal(exact.platform.status, 'reconciled');
    assertNoPii(exact, 'exact result');

    const expectedPopulationPath = path.join(tempRoot, 'expected-population.json');
    const expectedPopulationDocument = {
      schema: EXPECTED_POPULATION_SCHEMA,
      tenantCount: ids.length,
      tenantRefs: ids.map(opaqueTenantRef).sort()
    };
    const expectedPopulationBytes = Buffer.from(`${JSON.stringify(expectedPopulationDocument, null, 2)}\n`);
    const expectedPopulationSha256 = crypto.createHash('sha256').update(expectedPopulationBytes).digest('hex');
    fs.writeFileSync(expectedPopulationPath, expectedPopulationBytes);
    const expectedPopulation = loadExpectedPopulationManifest(expectedPopulationPath, expectedPopulationSha256);
    assert.equal(expectedPopulation.tenantCount, ids.length);
    assert.equal(expectedPopulation.sha256, expectedPopulationSha256);
    const populationExact = compareCatalog(catalog, {
      scope: 'all',
      companyId: '',
      releaseSha: RELEASE_SHA,
      expectedPopulation
    });
    assert.equal(populationExact.status, 'reconciled');
    assert.equal(populationExact.population.status, 'reconciled');
    assert.equal(populationExact.aggregate.expectedPopulationReconciled, true);
    assertNoPii(populationExact, 'expected population evidence');
    assert.throws(
      () => loadExpectedPopulationManifest(expectedPopulationPath, '0'.repeat(64)),
      errorCode('EXPECTED_POPULATION_SHA_MISMATCH')
    );
    const invalidPopulationPath = path.join(tempRoot, 'invalid-expected-population.json');
    const invalidPopulationBytes = Buffer.from(JSON.stringify({
      ...expectedPopulationDocument,
      tenantRefs: [...expectedPopulationDocument.tenantRefs].reverse()
    }));
    fs.writeFileSync(invalidPopulationPath, invalidPopulationBytes);
    assert.throws(
      () => loadExpectedPopulationManifest(
        invalidPopulationPath,
        crypto.createHash('sha256').update(invalidPopulationBytes).digest('hex')
      ),
      errorCode('EXPECTED_POPULATION_INVALID')
    );

    const missingExpectedRef = opaqueTenantRef(tenantId(2000));
    const missingExpectedPopulation = {
      ...expectedPopulation,
      tenantCount: expectedPopulation.tenantCount + 1,
      tenantRefs: [...expectedPopulation.tenantRefs, missingExpectedRef].sort()
    };
    const missingPopulation = compareCatalog(catalog, {
      scope: 'all',
      companyId: '',
      releaseSha: RELEASE_SHA,
      expectedPopulation: missingExpectedPopulation
    });
    assert.equal(missingPopulation.status, 'drift');
    assert.deepEqual(missingPopulation.population.missingTenantRefs, [missingExpectedRef]);

    const unexpectedPopulation = compareCatalog(catalog, {
      scope: 'all',
      companyId: '',
      releaseSha: RELEASE_SHA,
      expectedPopulation: {
        ...expectedPopulation,
        tenantCount: expectedPopulation.tenantCount - 1,
        tenantRefs: expectedPopulation.tenantRefs.slice(1)
      }
    });
    assert.equal(unexpectedPopulation.status, 'drift');
    assert.deepEqual(unexpectedPopulation.population.unexpectedTenantRefs, [expectedPopulation.tenantRefs[0]]);

    const legacyPageCalls = transport.calls.filter(call => call.method === 'GET' && call.relativePath.includes('/companies?'));
    const transactionalPageCalls = transport.calls.filter(call => call.relativePath.includes('/rpc/list_tenant_repository_page'));
    assert.ok(legacyPageCalls.length >= 5, `legacy pagination stopped after ${legacyPageCalls.length} pages`);
    assert.ok(transactionalPageCalls.length >= 11, `transactional pagination stopped after ${transactionalPageCalls.length} pages`);
    assert.ok(legacyPageCalls.every(call => call.body === null));
    assert.ok(transactionalPageCalls.every(call => {
      const keys = Object.keys(JSON.parse(call.body)).sort();
      return keys.join(',') === 'p_after_company_id,p_limit';
    }));
    assert.ok(transport.calls.every(call => ['GET', 'POST'].includes(call.method)));
    assert.ok(transport.calls.every(call => !/(?:save|replace|delete|purge|upload)/i.test(call.relativePath)));

    const changedExcludedPopulation = cloneCatalog(catalog);
    changedExcludedPopulation.excludedLegacyRows.archived += 1;
    assert.notEqual(
      catalogSignature(catalog),
      catalogSignature(changedExcludedPopulation),
      'excluded population changes must reset the stability window'
    );
    const changedTransactionalExclusions = cloneCatalog(catalog);
    changedTransactionalExclusions.excludedTransactionalRows.deleted += 1;
    assert.notEqual(
      catalogSignature(catalog),
      catalogSignature(changedTransactionalExclusions),
      'transactional exclusion changes must reset the stability window'
    );

    const privateKeySnapshot = tenantSnapshot(ids[0]);
    privateKeySnapshot[PII.email] = [];
    const privateKeyState = canonicalSnapshotState(privateKeySnapshot);
    assertNoPii(privateKeyState, 'unknown collection evidence');
    assert.ok(Object.keys(privateKeyState.collectionCounts).some(key => /^unknown_[a-f0-9]{24}$/.test(key)));

    const wrongNamespace = mockSupabase({
      legacyRows,
      transactionalRows,
      transactionalPlatform: platformRow(platform, tenantId(2000))
    });
    await assert.rejects(
      () => captureCatalog({
        request: wrongNamespace.request,
        dbFile,
        platformFile,
        scope: 'platform',
        companyId: ''
      }),
      errorCode('PROVIDER_PAYLOAD_INVALID')
    );

    // Every missing or divergent tenant source independently blocks a clean
    // gate. Local absence is intentionally tolerated for remote-only tenants.
    for (const source of ['legacy', 'transactional']) {
      const candidate = cloneCatalog(catalog);
      candidate.tenants[source].delete(ids[0]);
      const result = compareCatalog(candidate, { scope: 'all', companyId: '', releaseSha: RELEASE_SHA });
      assert.equal(result.status, 'drift');
      assert.ok(findTenant(result, ids[0]).issues.includes(`missing_${source}`));
      assert.equal(result.writesPerformed, false);
      assertNoPii(result, `missing tenant ${source}`);
    }
    {
      const candidate = cloneCatalog(catalog);
      candidate.tenants.legacy.get(ids[0]).state.canonicalSha256 = 'f'.repeat(64);
      const result = compareCatalog(candidate, { scope: 'all', companyId: '', releaseSha: RELEASE_SHA });
      assert.equal(result.status, 'drift');
      assert.ok(findTenant(result, ids[0]).issues.includes('hash_mismatch'));
      assertNoPii(result, 'tenant drift');
    }
    {
      const candidate = cloneCatalog(catalog);
      candidate.tenants.transactional.get(ids[0]).state.integrity = false;
      const result = compareCatalog(candidate, { scope: 'all', companyId: '', releaseSha: RELEASE_SHA });
      assert.equal(result.status, 'drift');
      assert.ok(findTenant(result, ids[0]).issues.includes('transactional_integrity'));
    }

    // Platform requires all three sources. Cover each absence plus divergent
    // content and a corrupt transactional stored hash.
    for (const source of ['local', 'legacy', 'transactional']) {
      const candidate = cloneCatalog(catalog);
      candidate.platform[source] = null;
      const result = compareCatalog(candidate, { scope: 'all', companyId: '', releaseSha: RELEASE_SHA });
      assert.equal(result.status, 'drift');
      assert.ok(result.platform.issues.includes(`missing_${source}`));
      assertNoPii(result, `missing platform ${source}`);
    }
    {
      const candidate = cloneCatalog(catalog);
      candidate.platform.legacy.canonicalSha256 = 'e'.repeat(64);
      const result = compareCatalog(candidate, { scope: 'all', companyId: '', releaseSha: RELEASE_SHA });
      assert.equal(result.status, 'drift');
      assert.ok(result.platform.issues.includes('hash_mismatch'));
    }
    {
      const candidate = cloneCatalog(catalog);
      candidate.platform.transactional.integrity = false;
      const result = compareCatalog(candidate, { scope: 'all', companyId: '', releaseSha: RELEASE_SHA });
      assert.equal(result.status, 'drift');
      assert.ok(result.platform.issues.includes('transactional_integrity'));
    }

    // The network boundary rejects any mutation verb, unknown endpoint,
    // absolute origin, query expansion, or unexpected body before dispatch.
    const dispatched = [];
    const guarded = readOnlyTransport(async (...args) => {
      dispatched.push(args);
      return response([]);
    }, 1_000);
    const exactRead = `/rest/v1/companies?id=eq.${ids[0]}&select=id,data&limit=1`;
    for (const [label, invoke] of [
      ['PATCH company', () => guarded(exactRead, { method: 'PATCH', body: '{}' })],
      ['DELETE company', () => guarded(exactRead, { method: 'DELETE' })],
      ['mutation RPC', () => guarded('/rest/v1/rpc/save_tenant_repository', { method: 'POST', body: '{}' })],
      ['extra RPC body key', () => guarded('/rest/v1/rpc/load_tenant_repository', {
        method: 'POST',
        body: JSON.stringify({ p_company_id: ids[0], snapshot: PII.notes })
      })],
      ['extra query key', () => guarded(`${exactRead}&${encodeURIComponent(PII.email)}=1`, { method: 'GET' })],
      ['GET request body', () => guarded(exactRead, { method: 'GET', body: JSON.stringify({ sentinel: PII.token }) })],
      ['absolute cross-origin URL', () => guarded(`https://attacker.invalid${exactRead}`, { method: 'GET' })]
    ]) {
      await assert.rejects(invoke, errorCode('PROVIDER_REQUEST_BLOCKED'), `${label} must be blocked before dispatch`);
    }
    assert.equal(dispatched.length, 0, 'a rejected request reached the Supabase transport');

    const allowed = await guarded(exactRead, { method: 'GET' });
    assert.equal(allowed.ok, true);
    assert.equal(dispatched.length, 1);
    const unsafeFailure = readOnlyTransport(async () => {
      throw new Error(`provider failed for ${PII.email} with ${PII.token}`);
    }, 1_000);
    await assert.rejects(() => unsafeFailure(exactRead, { method: 'GET' }), errorCode('PROVIDER_UNREACHABLE'));

    const externalAbort = new AbortController();
    const abortableRead = readOnlyTransport((relativePath, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }), 60_000, { signal: externalAbort.signal });
    const abortedRead = abortableRead(exactRead, { method: 'GET' });
    externalAbort.abort();
    await assert.rejects(() => abortedRead, errorCode('INTERRUPTED'));

    const slowBodyRead = readOnlyTransport(async () => ({
      ok: true,
      status: 200,
      json: () => new Promise(() => {})
    }), 30);
    const slowBodyResponse = await slowBodyRead(exactRead, { method: 'GET' });
    await assert.rejects(
      () => slowBodyResponse.json(),
      errorCode('PROVIDER_TIMEOUT'),
      'the request deadline must include reading and parsing the response body'
    );

    let timedCaptureStarted = 0;
    let timedCaptureAborted = 0;
    const timedCaptureRequest = readOnlyTransport((relativePath, options) => new Promise((resolve, reject) => {
      timedCaptureStarted += 1;
      const abort = () => {
        timedCaptureAborted += 1;
        reject(new Error(`cancelled:${relativePath}`));
      };
      options.signal.addEventListener('abort', abort, { once: true });
      if (options.signal.aborted) abort();
    }), 5_000);
    await assert.rejects(
      () => captureCatalog({
        request: timedCaptureRequest,
        dbFile,
        platformFile,
        scope: 'all',
        companyId: '',
        captureTimeoutMs: 35
      }),
      errorCode('CAPTURE_TIMEOUT')
    );
    assert.equal(timedCaptureStarted, 3, 'all three independent source scans should start under one capture boundary');
    assert.equal(timedCaptureAborted, 3, 'a capture deadline must cancel every sibling scan');

    let failedCaptureSiblingStarted = 0;
    let failedCaptureSiblingAborted = 0;
    const failedCaptureRequest = readOnlyTransport((relativePath, options) => {
      const url = new URL(relativePath, 'https://mock-supabase.invalid');
      if (url.pathname === '/rest/v1/companies') {
        return response([{ id: ids[0], data: { company: {} } }]);
      }
      failedCaptureSiblingStarted += 1;
      return new Promise((resolve, reject) => {
        const abort = () => {
          failedCaptureSiblingAborted += 1;
          reject(new Error('cancelled sibling'));
        };
        options.signal.addEventListener('abort', abort, { once: true });
        if (options.signal.aborted) abort();
      });
    }, 5_000);
    await assert.rejects(
      () => captureCatalog({
        request: failedCaptureRequest,
        dbFile,
        platformFile,
        scope: 'all',
        companyId: '',
        captureTimeoutMs: 1_000
      }),
      errorCode('PROVIDER_PAYLOAD_INVALID')
    );
    assert.equal(failedCaptureSiblingStarted, 2);
    assert.equal(failedCaptureSiblingAborted, 2, 'a failed source must not leave sibling scans running');

    // Runtime gating requires Supabase plus the exact shadow modes for the
    // chosen scope. Production evidence is tied to an immutable release SHA.
    const runtime = {
      PDL_SUPABASE_ENABLED: '1',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SECRET_KEY: 'not-printed',
      PDL_TRANSACTIONAL_DB: 'shadow',
      PDL_PLATFORM_TRANSACTIONAL_DB: 'shadow'
    };
    assert.doesNotThrow(() => validateRuntime({ scope: 'all', env: runtime }));
    assert.doesNotThrow(() => validateRuntime({ scope: 'tenant', env: { ...runtime, PDL_PLATFORM_TRANSACTIONAL_DB: 'off' } }));
    assert.doesNotThrow(() => validateRuntime({ scope: 'platform', env: { ...runtime, PDL_TRANSACTIONAL_DB: 'off' } }));
    assert.throws(() => validateRuntime({ scope: 'all', env: { ...runtime, PDL_TRANSACTIONAL_DB: 'primary' } }), errorCode('TENANT_MODE_NOT_SHADOW'));
    assert.throws(() => validateRuntime({ scope: 'all', env: { ...runtime, PDL_PLATFORM_TRANSACTIONAL_DB: 'primary' } }), errorCode('PLATFORM_MODE_NOT_SHADOW'));
    assert.throws(() => validateRuntime({ scope: 'all', env: { ...runtime, SUPABASE_URL: 'http://example.test' } }), errorCode('CONFIG_INVALID'));
    assert.throws(() => validateRuntime({ scope: 'all', env: { ...runtime, SUPABASE_SECRET_KEY: '' } }), errorCode('CONFIG_MISSING'));
    assert.throws(() => validateRuntime({
      scope: 'all',
      env: {
        ...runtime,
        RENDER: 'true',
        RENDER_SERVICE_TYPE: 'web',
        RENDER_SERVICE_ID: 'srv-dal9vt5bedkc73bpru30',
        RENDER_INSTANCE_ID: 'abc12',
        RENDER_EXTERNAL_URL: 'https://pro-daily-link-demo.onrender.com'
      }
    }), errorCode('RUNTIME_IDENTITY_MISSING'));
    const productionProjectRef = 'abcdefghijklmnopqrst';
    const renderRuntime = {
      ...runtime,
      SUPABASE_URL: `https://${productionProjectRef}.supabase.co`,
      PDL_PRODUCTION_SUPABASE_PROJECT_REF: productionProjectRef,
      NODE_ENV: 'production',
      RENDER: 'true',
      RENDER_SERVICE_TYPE: 'web',
      RENDER_SERVICE_ID: 'srv-dal9vt5bedkc73bpru30',
      RENDER_INSTANCE_ID: 'abc12',
      RENDER_EXTERNAL_URL: 'https://pro-daily-link-demo.onrender.com',
      RENDER_GIT_COMMIT: RELEASE_SHA,
      IS_PULL_REQUEST: 'false'
    };
    const identity = validateRuntime({
      scope: 'all',
      env: renderRuntime,
      expectedServiceId: renderRuntime.RENDER_SERVICE_ID,
      expectedInstanceId: renderRuntime.RENDER_INSTANCE_ID
    });
    assert.deepEqual(identity, {
      provider: 'render',
      serviceId: renderRuntime.RENDER_SERVICE_ID,
      serviceType: 'web',
      instanceId: renderRuntime.RENDER_INSTANCE_ID,
      externalHostname: 'pro-daily-link-demo.onrender.com',
      supabaseTargetSha256: crypto.createHash('sha256').update(`pdl-shadow-supabase:v1:https://${productionProjectRef}.supabase.co`).digest('hex').slice(0, 24),
      tenantRepositoryMode: 'shadow',
      platformRepositoryMode: 'shadow'
    });
    for (const key of ['RENDER', 'RENDER_SERVICE_TYPE', 'RENDER_SERVICE_ID', 'RENDER_INSTANCE_ID', 'RENDER_EXTERNAL_URL']) {
      assert.throws(() => validateRuntime({
        scope: 'all',
        env: { ...renderRuntime, [key]: '' },
        expectedServiceId: renderRuntime.RENDER_SERVICE_ID,
        expectedInstanceId: renderRuntime.RENDER_INSTANCE_ID
      }), errorCode('RUNTIME_IDENTITY_MISSING'));
    }
    assert.throws(() => validateRuntime({
      scope: 'all',
      env: { ...renderRuntime, IS_PULL_REQUEST: 'true' },
      expectedServiceId: renderRuntime.RENDER_SERVICE_ID,
      expectedInstanceId: renderRuntime.RENDER_INSTANCE_ID
    }), errorCode('RUNTIME_IDENTITY_MISSING'));
    assert.throws(() => validateRuntime({
      scope: 'all',
      env: renderRuntime,
      expectedServiceId: 'srv-aaaaaaaaaaaaaaaaaaaa',
      expectedInstanceId: renderRuntime.RENDER_INSTANCE_ID
    }), errorCode('RUNTIME_IDENTITY_MISMATCH'));
    assert.throws(() => validateRuntime({
      scope: 'all',
      env: { ...renderRuntime, PDL_PRODUCTION_SUPABASE_PROJECT_REF: '' },
      expectedServiceId: renderRuntime.RENDER_SERVICE_ID,
      expectedInstanceId: renderRuntime.RENDER_INSTANCE_ID
    }), errorCode('PRODUCTION_TARGET_INVALID'));
    assert.throws(() => validateRuntime({
      scope: 'all',
      env: { ...renderRuntime, PDL_PRODUCTION_SUPABASE_PROJECT_REF: 'zzzzzzzzzzzzzzzzzzzz' },
      expectedServiceId: renderRuntime.RENDER_SERVICE_ID,
      expectedInstanceId: renderRuntime.RENDER_INSTANCE_ID
    }), errorCode('PRODUCTION_TARGET_MISMATCH'));
    assert.throws(() => validateRuntime({
      scope: 'all',
      env: { ...renderRuntime, SUPABASE_URL: 'https://custom.example.test' },
      expectedServiceId: renderRuntime.RENDER_SERVICE_ID,
      expectedInstanceId: renderRuntime.RENDER_INSTANCE_ID
    }), errorCode('PRODUCTION_TARGET_INVALID'));
    assert.equal(releaseSha({ NODE_ENV: 'production', RENDER_GIT_COMMIT: RELEASE_SHA.toUpperCase() }), RELEASE_SHA);
    assert.equal(releaseSha({ NODE_ENV: 'test' }), 'local');
    assert.throws(() => releaseSha({ NODE_ENV: 'production' }), errorCode('RELEASE_SHA_MISSING'));
    assert.throws(() => releaseSha({ NODE_ENV: 'production', RENDER_GIT_COMMIT: 'not-a-sha' }), errorCode('RELEASE_SHA_MISSING'));
    assert.equal(await verifyAttachedRuntime(renderRuntime, {
      fetchImpl: async (url, options) => {
        assert.equal(url, 'http://127.0.0.1:10000/api/health/live');
        assert.equal(options.method, 'GET');
        assert.equal(options.signal.aborted, false);
        return response({ ok: true, kind: 'liveness' });
      }
    }), true);
    await assert.rejects(() => verifyAttachedRuntime(renderRuntime, {
      fetchImpl: async () => response({ ok: false, kind: 'liveness' }, false)
    }), error => error?.code === 'ATTACHED_RUNTIME_UNVERIFIED');
    await assert.rejects(() => verifyAttachedRuntime(renderRuntime, {
      fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }),
      timeoutMs: 25
    }), error => error?.code === 'ATTACHED_RUNTIME_UNVERIFIED');

    const cutoverDataDirectory = path.join(tempRoot, 'cutover-data');
    fs.mkdirSync(cutoverDataDirectory, { recursive: true });
    const cutoverDbFile = path.join(cutoverDataDirectory, 'db.json');
    const cutoverPlatformFile = path.join(cutoverDataDirectory, 'platform.json');
    fs.writeFileSync(cutoverDbFile, `${JSON.stringify(snapshots[0])}\n`);
    fs.writeFileSync(cutoverPlatformFile, `${JSON.stringify(platform)}\n`);
    const cutoverPopulationPath = path.join(tempRoot, 'cutover-expected-population.json');
    const cutoverPopulationBytes = Buffer.from(`${JSON.stringify({
      schema: EXPECTED_POPULATION_SCHEMA,
      tenantCount: 1,
      tenantRefs: [opaqueTenantRef(ids[0])]
    }, null, 2)}\n`);
    fs.writeFileSync(cutoverPopulationPath, cutoverPopulationBytes);
    const cutoverPopulationSha = crypto.createHash('sha256').update(cutoverPopulationBytes).digest('hex');
    const cutoverTransport = mockSupabase({
      legacyRows: [
        { id: ids[0], data: snapshots[0] },
        { id: PLATFORM_NAMESPACE_ID, data: { platform } }
      ],
      transactionalRows: [transactionalRow(snapshots[0])],
      transactionalPlatform: platformRow(platform)
    });
    const cutoverRuntime = {
      ...renderRuntime,
      PDL_DB_FILE: cutoverDbFile,
      PDL_PLATFORM_FILE: cutoverPlatformFile
    };
    const evidenceDirectory = path.join(tempRoot, 'evidence');
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    const cutoverArguments = evidencePath => [
      '--all',
      '--evidence', evidencePath,
      '--expected-service-id', cutoverRuntime.RENDER_SERVICE_ID,
      '--expected-instance-id', cutoverRuntime.RENDER_INSTANCE_ID,
      '--expected-population-manifest', cutoverPopulationPath,
      '--expected-population-sha256', cutoverPopulationSha,
      '--max-samples', '2',
      '--stable-samples', '2',
      '--interval-ms', '0',
      '--request-timeout-ms', '1000',
      '--capture-timeout-ms', '5000'
    ];
    const livenessFetch = async () => response({ ok: true, kind: 'liveness' });
    await assert.rejects(
      () => main([
        '--all',
        '--evidence', path.join(evidenceDirectory, 'missing-population.json'),
        '--expected-service-id', cutoverRuntime.RENDER_SERVICE_ID,
        '--expected-instance-id', cutoverRuntime.RENDER_INSTANCE_ID
      ], cutoverRuntime, { request: cutoverTransport.baseRequest }),
      error => error?.code === 'EXPECTED_POPULATION_REQUIRED'
    );

    const fenceIdentity = {
      serviceId: cutoverRuntime.RENDER_SERVICE_ID,
      instanceId: cutoverRuntime.RENDER_INSTANCE_ID
    };
    const initialFence = {
      digest: 'a'.repeat(64),
      openedAt: '2026-10-20T20:00:00.000Z',
      identity: fenceIdentity,
      mode: 'shadow-cutover',
      source: 'operator-lock'
    };
    const changedFenceEvidence = path.join(evidenceDirectory, 'changed-fence.json');
    let changedFenceChecks = 0;
    await assert.rejects(
      () => main(cutoverArguments(changedFenceEvidence), cutoverRuntime, {
        request: cutoverTransport.baseRequest,
        fetch: livenessFetch,
        maintenanceFence: {
          requireVerifiedFence() {
            changedFenceChecks += 1;
            return changedFenceChecks === 1 ? structuredClone(initialFence) : { ...structuredClone(initialFence), digest: 'b'.repeat(64) };
          }
        },
        stdout: { write() {} },
        setExitCode() {}
      }),
      error => error?.code === 'MAINTENANCE_FENCE_CHANGED'
    );
    assert.equal(changedFenceChecks, 2, 'the same maintenance fence must be verified again after capture');
    assert.equal(fs.existsSync(changedFenceEvidence), false, 'changed-fence evidence must not be written');
    assert.equal(fs.existsSync(`${changedFenceEvidence}.sha256`), false, 'changed-fence checksum must not be written');

    const stableFenceEvidence = path.join(evidenceDirectory, 'stable-fence.json');
    let stableFenceChecks = 0;
    const cutoverResult = await main(cutoverArguments(stableFenceEvidence), cutoverRuntime, {
      request: cutoverTransport.baseRequest,
      fetch: livenessFetch,
      maintenanceFence: {
        requireVerifiedFence() {
          stableFenceChecks += 1;
          return structuredClone(initialFence);
        }
      },
      stdout: { write() {} },
      setExitCode(code) { assert.equal(code, 0); }
    });
    assert.equal(stableFenceChecks, 2);
    assert.equal(cutoverResult.status, 'reconciled');
    assert.equal(cutoverResult.population.status, 'reconciled');
    assert.equal(fs.existsSync(stableFenceEvidence), true);
    assert.equal(fs.existsSync(`${stableFenceEvidence}.sha256`), true);

    // Evidence is an exclusive, non-overwriting pair: formatted JSON plus a
    // SHA-256 sidecar over the exact bytes written.
    const evidence = path.join(tempRoot, 'evidence', 'shadow.json');
    fs.mkdirSync(path.dirname(evidence), { recursive: true });
    const digest = writeEvidenceExclusive(evidence, exact);
    const evidenceBytes = fs.readFileSync(evidence);
    const expectedDigest = crypto.createHash('sha256').update(evidenceBytes).digest('hex');
    assert.equal(digest, expectedDigest);
    assert.equal(fs.readFileSync(`${evidence}.sha256`, 'utf8'), `${expectedDigest}\n`);
    assert.deepEqual(JSON.parse(evidenceBytes.toString('utf8')), exact);
    assertNoPii(evidenceBytes.toString('utf8'), 'evidence file');
    assert.throws(() => writeEvidenceExclusive(evidence, exact), /already exists/i);

    const sidecarFirst = path.join(tempRoot, 'evidence', 'sidecar-first.json');
    fs.writeFileSync(`${sidecarFirst}.sha256`, `${'0'.repeat(64)}\n`);
    assert.throws(() => writeEvidenceExclusive(sidecarFirst, exact), /already exists/i);
    assert.equal(fs.existsSync(sidecarFirst), false);

    const partial = path.join(tempRoot, 'evidence', 'partial.json');
    const originalOpenSync = fs.openSync;
    fs.openSync = function failSidecarOpen(target, ...args) {
      if (String(target) === `${partial}.sha256`) throw new Error('synthetic sidecar failure');
      return originalOpenSync.call(this, target, ...args);
    };
    try {
      assert.throws(() => writeEvidenceExclusive(partial, exact), /synthetic sidecar failure/);
    } finally {
      fs.openSync = originalOpenSync;
    }
    assert.equal(fs.existsSync(partial), false, 'partial evidence must be removed');
    assert.equal(fs.existsSync(`${partial}.sha256`), false, 'partial sidecar must not remain');

    const corrupt = path.join(tempRoot, 'evidence', 'corrupt.json');
    const originalReadFileSync = fs.readFileSync;
    fs.readFileSync = function corruptEvidenceRead(target, ...args) {
      if (String(target) === corrupt) return Buffer.from('corrupt');
      return originalReadFileSync.call(this, target, ...args);
    };
    try {
      assert.throws(() => writeEvidenceExclusive(corrupt, exact), /verification failed/i);
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
    assert.equal(fs.existsSync(corrupt), false, 'unverified evidence must be removed');
    assert.equal(fs.existsSync(`${corrupt}.sha256`), false, 'unverified sidecar must be removed');

    const cli = spawnSync(process.execPath, [path.join(__dirname, 'reconcile-shadow.js')], {
      encoding: 'utf8',
      env: { ...process.env, SUPABASE_SECRET_KEY: PII.token }
    });
    assert.equal(cli.status, 2);
    assert.equal(cli.stdout, '');
    assertNoPii(cli.stderr, 'CLI failure output');
    const cliFailure = JSON.parse(cli.stderr.trim());
    assert.equal(cliFailure.status, 'inconclusive');
    assert.equal(cliFailure.writesPerformed, false);

    console.log('Shadow reconciliation adapter, catalog, runtime, evidence, read-only, and privacy tests passed.');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
