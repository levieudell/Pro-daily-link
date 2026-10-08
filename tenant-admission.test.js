'use strict';
const assert = require('node:assert/strict');
const { splitSnapshot, assembleSnapshot, canonicalHash, TransactionalTenantRepository } = require('./database/transactional-repository');
const { loadConsistentSnapshot } = require('./database/tenant-consistent-read');
const { createAdmission, requireRevision } = require('./database/tenant-admission');
const { supportedRoute } = require('./database/tenant-atomic-routes');
const companyId = '11111111-1111-4111-8111-111111111111';
const snapshot = { company: { id: companyId }, empty: [], missingNull: null, settings: {}, users: Array.from({ length: 1103 }, (_, id) => ({ id })) };
const packed = splitSnapshot(snapshot), rows = packed.records.map(({ collection, position, data }) => ({ collection, position, data }));
const state = revision => ({ revision, scalar_data: packed.scalarData, content_hash: canonicalHash(snapshot) });

async function main() {
  assert.deepEqual(assembleSnapshot(packed.scalarData, rows), snapshot);
  assert.equal(Object.hasOwn(assembleSnapshot(packed.scalarData, rows), 'missing'), false);
  for (const value of [null, undefined, '0', -1, Infinity, NaN, Number.MAX_SAFE_INTEGER]) assert.throws(() => requireRevision(value));
  assert.equal(requireRevision(0), 0);
  const repo = new TransactionalTenantRepository({ pool: { connect: () => assert.fail('Invalid revisions must not connect') } });
  await assert.rejects(repo.save(snapshot, null));
  let stateReads = 0, recordReads = 0;
  const request = async url => ({ json: async () => {
    if (url.includes('tenant_revisions')) return [state(++stateReads === 1 ? 1 : 2)];
    recordReads++; const parsed = new URL(url, 'http://synthetic.invalid');
    return rows.slice(Number(parsed.searchParams.get('offset')), Number(parsed.searchParams.get('offset')) + Number(parsed.searchParams.get('limit')));
  } });
  const loaded = await loadConsistentSnapshot(companyId, request);
  assert.deepEqual(loaded.snapshot, snapshot); assert.equal(loaded.revision, 2); assert.equal(recordReads, 6);
  for (const mutate of [items => items.slice(1), items => [...items, items[0]], items => items.map(row => ({ ...row, position: row.position + 1 }))]) {
    await assert.rejects(loadConsistentSnapshot(companyId, async url => ({ json: async () => url.includes('tenant_revisions') ? [state(1)] : mutate(rows.slice(0, 500)) })), { code: 'PDL_TENANT_INTEGRITY' });
  }
  await assert.rejects(loadConsistentSnapshot('22222222-2222-4222-8222-222222222222', request), { code: 'PDL_TENANT_INTEGRITY' });
  let authoritative = { snapshot, revision: 2, contentHash: canonicalHash(snapshot) }, mirrors = 0, commits = 0;
  const admission = createAdmission({ load: async () => structuredClone(authoritative), commit: async (candidate, revision) => {
    assert.equal(mirrors, commits === 0 ? 0 : 1); commits++;
    if (revision !== authoritative.revision) throw Object.assign(new Error('Conflict'), { code: 'PDL_REVISION_CONFLICT' });
    authoritative = { snapshot: candidate, revision: revision + 1, contentHash: canonicalHash(candidate) }; return authoritative;
  }, mirror: async candidate => { assert.equal(authoritative.contentHash, canonicalHash(candidate)); mirrors++; } });
  const a = await admission.begin(companyId), b = await admission.begin(companyId);
  a.db.settings.label = 'winner'; admission.stage(a, a.db); admission.stage(a, a.db);
  b.db.settings.label = 'loser'; admission.stage(b, b.db);
  assert.equal((await admission.finish(a)).committed, true); assert.equal(mirrors, 1);
  await assert.rejects(admission.finish(b), { code: 'PDL_REVISION_CONFLICT' });
  assert.equal(commits, 2); assert.equal(mirrors, 1); assert.equal(authoritative.snapshot.settings.label, 'winner');
  await assert.rejects(admission.finish(a));
  for (const [commit, mirror, expected] of [
    [async () => { throw Object.assign(new Error('Rejected'), { commitRejected: true }); }, async () => assert.fail('Rejected commit mirrored'), 'rejected'],
    [async () => { throw new Error('Connection lost after send'); }, async () => assert.fail('Unknown commit mirrored'), 'unknown'],
    [async candidate => ({ revision: 4, contentHash: canonicalHash(candidate) }), async () => { throw new Error('Mirror offline'); }, 'degraded']
  ]) {
    const boundary = createAdmission({ load: async () => authoritative, commit, mirror }), context = await boundary.begin(companyId);
    boundary.stage(context, context.db);
    if (expected === 'degraded') assert.deepEqual(await boundary.finish(context), { committed: true, revision: 4, mirrored: false });
    else await assert.rejects(boundary.finish(context), expected === 'unknown' ? { code: 'PDL_COMMIT_OUTCOME_UNKNOWN' } : /Rejected/);
  }
  for (const path of ['/api/signup', '/api/billing/webhook', '/api/billing/checkout', '/api/guest/token', '/api/platform/companies/x', '/api/company/logo', '/api/estimate-imports/analyze', '/api/action-center', '/api/company/export', '/api/assistant/interpret', '/api/projects/101/assistant/chat']) assert.equal(supportedRoute('POST', path), false);
  assert.equal(supportedRoute('POST', '/api/projects/101/assistant/confirm'), true);
  assert.equal(supportedRoute('PATCH', '/api/users/2'), true);
  const priorFlag = process.env.PDL_TENANT_ATOMIC, originalFetch = global.fetch;
  process.env.PDL_TENANT_ATOMIC = '1';
  global.fetch = () => assert.fail('Blocked effects must reject before network I/O');
  try {
    const adapter = require('./database/supabase');
    for (const call of [() => adapter.saveCompanySnapshot(snapshot), () => adapter.saveSnapshot(companyId, 'Synthetic', snapshot), () => adapter.upload('x', 'x', Buffer.from('x'), 'text/plain'), () => adapter.remove('x', 'x'), () => adapter.ensurePrivateBucket('x'), () => adapter.createVerifiedBackup(snapshot), () => require('./supabase').saveCompanySnapshot(snapshot)]) await assert.rejects(call(), { code: 'PDL_TENANT_ADMISSION' });
    await assert.rejects(adapter.saveTransactionalSnapshot(snapshot, null), { code: 'PDL_TENANT_ADMISSION' });
  } finally {
    global.fetch = originalFetch;
    if (priorFlag === undefined) delete process.env.PDL_TENANT_ATOMIC; else process.env.PDL_TENANT_ATOMIC = priorFlag;
  }
  console.log('Tenant admission: consistent reads, mandatory revision, CAS before mirror, rollback/unknown/degraded semantics and route bounds passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
