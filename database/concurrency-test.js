'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { TransactionalTenantRepository, canonicalHash } = require('./transactional-repository');
const supabase = require('./supabase');

supabase.loadLocalEnv(path.resolve(__dirname, '..'));

function staleConflict(result) {
  return result.status === 'rejected' && (result.reason?.code === 'PDL_REVISION_CONFLICT' || /PDL_REVISION_CONFLICT|40001/.test(String(result.reason?.message)));
}

async function assertConcurrentResult(results, load) {
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, 'exactly one concurrent writer must commit');
  assert(results.some(staleConflict), 'the stale writer must receive an explicit conflict');
  const stored = await load();
  assert.equal(stored.snapshot.projects.length, 1, 'no merged or silently overwritten project set is allowed');
  assert(['Writer A', 'Writer B'].includes(stored.snapshot.projects[0].name));
  return stored;
}

async function testPostgres() {
  const repository = new TransactionalTenantRepository();
  const companyId = crypto.randomUUID();
  try {
    await repository.pool.query('INSERT INTO companies(id, slug, name) VALUES($1,$2,$3)', [companyId, `pdl-concurrency-${companyId}`, 'PDL isolated concurrency test']);
    const base = { company: { id: companyId, name: 'PDL isolated concurrency test' }, users: [], projects: [], auditLog: [] };
    const first = await repository.save(base, 0);
    assert.equal(first.revision, 1);
    const copyA = structuredClone(base), copyB = structuredClone(base);
    copyA.projects.push({ id: 1, name: 'Writer A' });
    copyB.projects.push({ id: 2, name: 'Writer B' });
    const results = await Promise.allSettled([repository.save(copyA, first.revision), repository.save(copyB, first.revision)]);
    const stored = await assertConcurrentResult(results, () => repository.load(companyId));
    assert.equal(stored.revision, 2);
  } finally {
    await repository.pool.query('DELETE FROM companies WHERE id=$1', [companyId]).catch(() => {});
    await repository.close();
  }
}

async function testSupabase(companyId) {
  const snapshots = await supabase.listCompanySnapshots();
  const source = snapshots.find(snapshot => String(snapshot?.company?.id) === companyId);
  if (!source) throw new Error(`Supabase concurrency test tenant ${companyId} was not found`);
  if (!/(?:test|qa|demo|delete me)/i.test(String(source.company.name))) throw new Error('Refusing to run concurrency writes against a non-test company');
  const verifiedBackup = await supabase.createVerifiedBackup(source);
  const original = await supabase.loadTransactionalSnapshot(companyId);
  const restoreSnapshot = original?.snapshot || source;
  let currentRevision = original?.revision || 0;
  try {
    const base = { company: { id: companyId, name: `${source.company.name} concurrency test` }, users: [], projects: [], auditLog: [] };
    const first = await supabase.saveTransactionalSnapshot(base, currentRevision);
    currentRevision = first.revision;
    const copyA = structuredClone(base), copyB = structuredClone(base);
    copyA.projects.push({ id: 1, name: 'Writer A' });
    copyB.projects.push({ id: 2, name: 'Writer B' });
    const results = await Promise.allSettled([supabase.saveTransactionalSnapshot(copyA, currentRevision), supabase.saveTransactionalSnapshot(copyB, currentRevision)]);
    const stored = await assertConcurrentResult(results, () => supabase.loadTransactionalSnapshot(companyId));
    currentRevision = stored.revision;
  } finally {
    const latest = await supabase.loadTransactionalSnapshot(companyId).catch(() => null);
    if (latest) currentRevision = latest.revision;
    const restored = await supabase.saveTransactionalSnapshot(restoreSnapshot, currentRevision);
    const checked = await supabase.loadTransactionalSnapshot(companyId);
    assert.equal(checked.contentHash, canonicalHash(restoreSnapshot), 'the pre-test tenant state must be restored');
    console.log(`Restored test tenant at revision ${restored.revision}; verified backup ${verifiedBackup.objectKey}.`);
  }
}

async function main() {
  const companyArg = process.argv.find(value => value.startsWith('--supabase-company='));
  if (companyArg) {
    if (!supabase.configured()) throw new Error('Supabase configuration is missing');
    await testSupabase(companyArg.split('=')[1]);
  } else if (process.env.DATABASE_URL) {
    await testPostgres();
  } else {
    console.log('SKIP transactional concurrency test (set DATABASE_URL or pass --supabase-company=<test tenant uuid>).');
    return;
  }
  console.log('Transactional concurrent-write test passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });

