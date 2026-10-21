'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ShadowReconciliationError,
  captureCatalog,
  readOnlyTransport,
  streamLegacyCatalog,
  streamTransactionalCatalog
} = require('./shadow-reconciliation');
const { splitSnapshot, canonicalHash: tenantCanonicalHash } = require('./transactional-repository');
const {
  PLATFORM_NAMESPACE_ID,
  splitPlatformSnapshot,
  canonicalHash: platformCanonicalHash
} = require('./platform-repository');

const TENANT_COUNT = 43;
const LARGE_RECORDS_PER_TENANT = 64;
const LARGE_SENTINEL = 'PRIVATE-LARGE-RECORD-SENTINEL-';

function tenantId(index) {
  return `00000000-0000-4000-8000-${Number(index).toString(16).padStart(12, '0')}`;
}

function tenantSnapshot(id) {
  return {
    company: { id, persistence: { revision: 12 } },
    reports: Array.from({ length: LARGE_RECORDS_PER_TENANT }, (_, index) => ({
      id: index + 1,
      notes: `${LARGE_SENTINEL}${id}:${index}:${'x'.repeat(1024)}`
    })),
    users: [{ id: 1, email: `${id}@private.example.test` }]
  };
}

function platformSnapshot() {
  return { users: [{ id: 1, email: 'platform-private@example.test' }] };
}

function transactionalRow(snapshot) {
  const { scalarData, records } = splitSnapshot(snapshot);
  return {
    company_id: snapshot.company.id,
    revision: 12,
    scalar_data: scalarData,
    records,
    content_hash: tenantCanonicalHash(snapshot)
  };
}

function platformRow(snapshot) {
  const { scalarData, records } = splitPlatformSnapshot(snapshot);
  return {
    namespace_id: PLATFORM_NAMESPACE_ID,
    revision: 4,
    scalar_data: scalarData,
    records,
    content_hash: platformCanonicalHash(snapshot)
  };
}

function response(payload) {
  return { ok: true, async json() { return payload; } };
}

function errorCode(code) {
  return error => error instanceof ShadowReconciliationError && error.code === code;
}

function assertCompactEntry(entry, transactional = false) {
  assert.deepEqual(Object.keys(entry).sort(), ['id', 'state']);
  const allowed = [
    'canonicalSha256',
    'collectionCounts',
    'persistenceRevision',
    'records',
    'topLevelKeys',
    ...(transactional ? ['integrity', 'repositoryRevision', 'storedSha256'] : [])
  ].sort();
  assert.deepEqual(Object.keys(entry.state).sort(), allowed);
  assert.equal(entry.state.collectionCounts.reports, LARGE_RECORDS_PER_TENANT);
  assert.doesNotMatch(JSON.stringify(entry), /PRIVATE-LARGE-RECORD-SENTINEL|private\.example\.test/i);
  assert.equal(Object.hasOwn(entry, 'snapshot'), false);
  assert.equal(Object.hasOwn(entry, 'data'), false);
  assert.equal(Object.hasOwn(entry.state, 'snapshot'), false);
  assert.equal(Object.hasOwn(entry.state, 'recordsData'), false);
}

(async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-shadow-streaming-'));
  try {
    const ids = Array.from({ length: TENANT_COUNT }, (_, index) => tenantId(index + 1));
    const legacyIds = [...ids, PLATFORM_NAMESPACE_ID].sort();
    const pageEvidence = [];
    const platform = platformSnapshot();
    const baseRequest = async (relativePath, options = {}) => {
      const url = new URL(relativePath, 'https://mock-supabase.invalid');
      if (url.pathname === '/rest/v1/companies') {
        const limit = Number(url.searchParams.get('limit'));
        const after = String(url.searchParams.get('id') || '').replace(/^gt\./, '');
        const pageIds = legacyIds.filter(id => !after || id > after).slice(0, limit);
        pageEvidence.push({ source: 'legacy', limit, returned: pageIds.length });
        return response(pageIds.map(id => id === PLATFORM_NAMESPACE_ID
          ? { id, data: { platform } }
          : { id, data: tenantSnapshot(id) }));
      }
      if (url.pathname === '/rest/v1/rpc/list_tenant_repository_page') {
        const body = JSON.parse(String(options.body));
        const after = body.p_after_company_id || '';
        const pageIds = ids.filter(id => !after || id > after).slice(0, body.p_limit);
        pageEvidence.push({ source: 'transactional', limit: body.p_limit, returned: pageIds.length });
        return response({
          rows: pageIds.map(id => transactionalRow(tenantSnapshot(id))),
          nextCompanyId: pageIds.length === body.p_limit ? pageIds.at(-1) : null
        });
      }
      if (url.pathname === '/rest/v1/rpc/load_platform_repository') return response(platformRow(platform));
      throw new Error(`Unexpected request: ${url.pathname}`);
    };

    const dbFile = path.join(tempRoot, 'db.json');
    const platformFile = path.join(tempRoot, 'platform.json');
    fs.writeFileSync(dbFile, `${JSON.stringify(tenantSnapshot(ids[0]))}\n`);
    fs.writeFileSync(platformFile, `${JSON.stringify(platform)}\n`);
    const catalog = await captureCatalog({
      request: readOnlyTransport(baseRequest, 5_000),
      dbFile,
      platformFile,
      scope: 'all',
      companyId: ''
    });

    assert.equal(catalog.tenants.legacy.size, TENANT_COUNT);
    assert.equal(catalog.tenants.transactional.size, TENANT_COUNT);
    assert.equal(catalog.excludedLegacyRows.platform, 1);
    for (const entry of catalog.tenants.legacy.values()) assertCompactEntry(entry, false);
    for (const entry of catalog.tenants.transactional.values()) assertCompactEntry(entry, true);
    assert.doesNotMatch(JSON.stringify(catalog.platform), /platform-private@example\.test/i);
    assert.ok(pageEvidence.length > 8, 'the fixture must exercise multiple pages per source');
    assert.ok(pageEvidence.every(page => page.limit <= 10), 'full snapshots must use small bounded pages');
    assert.ok(pageEvidence.every(page => page.returned <= page.limit), 'a provider page exceeded its requested bound');
    assert.equal(Math.max(...pageEvidence.filter(page => page.source === 'transactional').map(page => page.returned)), 10);

    const exactMultipleIds = ids.slice(0, 20);
    let exactLegacyPages = 0;
    const exactLegacy = await streamLegacyCatalog(async relativePath => {
      exactLegacyPages += 1;
      const url = new URL(relativePath, 'https://mock-supabase.invalid');
      const after = String(url.searchParams.get('id') || '').replace(/^gt\./, '');
      const limit = Number(url.searchParams.get('limit'));
      const pageIds = exactMultipleIds.filter(id => !after || id > after).slice(0, limit);
      return response(pageIds.map(id => ({ id, data: tenantSnapshot(id) })));
    }, { pageSize: 10, maxPages: 4 });
    assert.equal(exactLegacy.map.size, 20);
    assert.equal(exactLegacyPages, 3, 'an exact page multiple requires a final empty keyset page');

    let exactTransactionalPages = 0;
    const exactTransactional = await streamTransactionalCatalog(async (relativePath, options) => {
      exactTransactionalPages += 1;
      const body = JSON.parse(String(options.body));
      const after = body.p_after_company_id || '';
      const pageIds = exactMultipleIds.filter(id => !after || id > after).slice(0, body.p_limit);
      return response({
        rows: pageIds.map(id => transactionalRow(tenantSnapshot(id))),
        nextCompanyId: pageIds.length === body.p_limit ? pageIds.at(-1) : null
      });
    }, { pageSize: 10, maxPages: 4 });
    assert.equal(exactTransactional.map.size, 20);
    assert.equal(exactTransactionalPages, 3, 'transactional exact multiples require a final empty keyset page');

    const duplicateId = ids[0];
    await assert.rejects(
      () => streamLegacyCatalog(async () => response([
        { id: duplicateId, data: tenantSnapshot(duplicateId) },
        { id: duplicateId, data: tenantSnapshot(duplicateId) }
      ]), { pageSize: 2, maxPages: 2 }),
      errorCode('PROVIDER_PAYLOAD_INVALID')
    );

    const oneRow = transactionalRow(tenantSnapshot(ids[0]));
    await assert.rejects(
      () => streamTransactionalCatalog(async () => response({
        rows: [oneRow],
        nextCompanyId: ids[1]
      }), { pageSize: 1, maxPages: 2 }),
      errorCode('PROVIDER_PAYLOAD_INVALID')
    );

    console.log('Shadow reconciliation streams bounded full-snapshot pages into compact fingerprint catalogs.');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
