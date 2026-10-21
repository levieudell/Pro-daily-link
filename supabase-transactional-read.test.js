'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const supabase = require('./database/supabase');
const { canonicalHash, splitSnapshot, databaseCompanyId } = require('./database/transactional-repository');

const ids = {
  first: '11111111-1111-4111-8111-111111111111',
  second: '22222222-2222-4222-8222-222222222222'
};

function repositoryRow(snapshot, revision) {
  const { scalarData, records } = splitSnapshot(snapshot);
  return {
    companyId: databaseCompanyId(snapshot),
    revision,
    scalarData,
    contentHash: canonicalHash(snapshot),
    records: records.map(row => ({
      collection: row.collection,
      recordKey: row.recordKey,
      position: row.position,
      data: row.data
    }))
  };
}

function directoryRow(id, index = 1) {
  return {
    companyId: id,
    databaseCompanyId: id,
    revision: index,
    company: { id, name: `Company ${index}`, plan: 'starter' },
    users: index % 25,
    projects: index % 17,
    reports: index % 41,
    lastReport: `2026-10-${String((index % 28) + 1).padStart(2, '0')}`,
    updatedAt: '2026-10-20T12:00:00.000Z'
  };
}

function uuidFor(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

async function expectIntegrityFailure(task) {
  await assert.rejects(task, /integrity check failed/i);
}

const previous = {
  url: process.env.SUPABASE_URL,
  key: process.env.SUPABASE_SECRET_KEY,
  enabled: process.env.PDL_SUPABASE_ENABLED,
  fetch: global.fetch
};
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
process.env.PDL_SUPABASE_ENABLED = '1';

(async () => {
  const snapshotBefore = {
    company: { id: ids.first, name: 'Atomic Before' },
    users: [{ id: 1, name: 'Before User', email: 'owner@example.test', status: 'Active' }],
    projects: [{ id: 1, name: 'Before Project' }]
  };
  const snapshotAfter = {
    company: { id: ids.first, name: 'Atomic After' },
    users: [{ id: 1, name: 'After User', email: 'owner@example.test', status: 'Active' }],
    projects: [{ id: 1, name: 'After Project' }, { id: 2, name: 'Concurrent Project' }]
  };

  // The response captures one database statement before the simulated writer
  // commits. Releasing it after the writer advances must still return one
  // coherent revision, never old scalar state plus new records.
  let releaseRead;
  let requestStarted;
  const readStarted = new Promise(resolve => { requestStarted = resolve; });
  const readRelease = new Promise(resolve => { releaseRead = resolve; });
  let generation = repositoryRow(snapshotBefore, 7);
  const atomicCalls = [];
  global.fetch = async (url, options = {}) => {
    atomicCalls.push({ url: String(url), options });
    assert.match(String(url), /\/rest\/v1\/rpc\/load_tenant_repository$/);
    assert.equal(options.method, 'POST');
    const captured = structuredClone(generation);
    requestStarted();
    await readRelease;
    return new Response(JSON.stringify(captured), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const pendingAtomicRead = supabase.loadTransactionalSnapshot(ids.first);
  await readStarted;
  generation = repositoryRow(snapshotAfter, 8);
  releaseRead();
  const atomic = await pendingAtomicRead;
  assert.equal(atomic.revision, 7);
  assert.deepEqual(atomic.snapshot, snapshotBefore);
  assert.equal(atomicCalls.length, 1, 'an atomic tenant read must use one RPC request');
  assert.doesNotMatch(atomicCalls[0].url, /tenant_(?:revisions|records)/);

  // Idempotent read RPCs retry only transient provider failures.
  let retryCalls = 0;
  global.fetch = async url => {
    assert.match(String(url), /\/rest\/v1\/rpc\/load_tenant_repository$/);
    retryCalls += 1;
    if (retryCalls === 1) return new Response('temporary outage', { status: 503 });
    return new Response(JSON.stringify(repositoryRow(snapshotAfter, 8)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  assert.equal((await supabase.loadTransactionalSnapshot(ids.first)).revision, 8);
  assert.equal(retryCalls, 2);

  // A syntactically valid but mismatched hash is corruption, not something to
  // paper over with a retry or a partially assembled response.
  const corrupted = repositoryRow(snapshotAfter, 8);
  corrupted.records[0].data = { ...corrupted.records[0].data, name: 'Tampered' };
  let corruptCalls = 0;
  global.fetch = async () => {
    corruptCalls += 1;
    return new Response(JSON.stringify(corrupted), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  await expectIntegrityFailure(() => supabase.loadTransactionalSnapshot(ids.first));
  assert.equal(corruptCalls, 1);

  // Full maintenance enumeration is keyset-paged. Every tenant is assembled
  // by PostgreSQL inside its page statement and independently hash checked.
  const secondSnapshot = { company: { id: ids.second, name: 'Second' }, users: [], reports: [{ id: 2, dateIso: '2026-10-20' }] };
  const fullListCalls = [];
  global.fetch = async (url, options = {}) => {
    fullListCalls.push(String(url));
    assert.match(String(url), /\/rest\/v1\/rpc\/list_tenant_repository_page$/);
    const input = JSON.parse(options.body);
    const payload = input.p_after_company_id
      ? { rows: [repositoryRow(secondSnapshot, 3)], nextCompanyId: null }
      : { rows: [repositoryRow(snapshotBefore, 7)], nextCompanyId: ids.first };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const allSnapshots = await supabase.listTransactionalSnapshots();
  assert.deepEqual(allSnapshots.map(row => row.companyId), [ids.first, ids.second]);
  assert.deepEqual(allSnapshots.map(row => row.revision), [7, 3]);
  assert.equal(fullListCalls.length, 2);
  assert.ok(fullListCalls.every(url => !/tenant_(?:revisions|records)\?/.test(url)));

  // Platform list scale stays proportional to tenant count, not to the total
  // number of projects/reports. The client receives only compact summaries.
  const firstSummaryPage = Array.from({ length: 500 }, (_, index) => directoryRow(uuidFor(index + 1), index + 1));
  const finalSummary = directoryRow(uuidFor(501), 501);
  const summaryBodies = [];
  global.fetch = async (url, options = {}) => {
    assert.match(String(url), /\/rest\/v1\/rpc\/list_tenant_directory_page$/);
    const input = JSON.parse(options.body);
    summaryBodies.push(input);
    const payload = input.p_after_company_id
      ? { rows: [finalSummary], nextCompanyId: null }
      : { rows: firstSummaryPage, nextCompanyId: uuidFor(500) };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const summaries = await supabase.listTransactionalTenantSummaries();
  assert.equal(summaries.length, 501);
  assert.equal(summaries[0].company.name, 'Company 1');
  assert.equal(summaries.at(-1).reports, 501 % 41);
  assert.deepEqual(summaryBodies, [
    { p_after_company_id: null, p_limit: 500 },
    { p_after_company_id: uuidFor(500), p_limit: 500 }
  ]);
  assert.ok(summaryBodies.every(body => !Object.hasOwn(body, 'records')));

  let lookupBody;
  global.fetch = async (url, options = {}) => {
    assert.match(String(url), /\/rest\/v1\/rpc\/find_tenant_company_by_email$/);
    lookupBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ companyId: ids.second, databaseCompanyId: ids.second, revision: 3 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  assert.equal(await supabase.findTransactionalCompanyIdByUserEmail('  OWNER@Example.Test '), ids.second);
  assert.deepEqual(lookupBody, { p_email: 'owner@example.test' });
  assert.equal(await supabase.findTransactionalCompanyIdByUserEmail(''), null);

  let publicTokenBody;
  global.fetch = async (url, options = {}) => {
    assert.match(String(url), /\/rest\/v1\/rpc\/find_tenant_company_by_public_token$/);
    publicTokenBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ companyId: ids.first, databaseCompanyId: ids.first, revision: 7 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  const publicTokenHash = 'a'.repeat(64);
  assert.equal(await supabase.findTransactionalCompanyIdByPublicToken('guest', publicTokenHash), ids.first);
  assert.deepEqual(publicTokenBody, { p_kind: 'guest', p_token_hash: publicTokenHash });
  await assert.rejects(() => supabase.findTransactionalCompanyIdByPublicToken('session', publicTokenHash), /kind is invalid/);
  await assert.rejects(() => supabase.findTransactionalCompanyIdByPublicToken('guest', 'raw-secret'), /must be SHA-256/);

  const migration = fs.readFileSync(path.join(__dirname, 'database', '009_transactional_read_models.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS private\.tenant_directory/i);
  assert.match(migration, /PRIMARY KEY \(normalized_email, company_id\)/i);
  assert.match(migration, /ALTER FUNCTION public\.app_company_id\(\) SET search_path = ''/i);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS tenant_active_user_emails_company_idx\s+ON private\.tenant_active_user_emails\(company_id\)/i);
  assert.match(migration, /LOCK TABLE public\.tenant_revisions, public\.tenant_records IN SHARE ROW EXCLUSIVE MODE/i);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.load_tenant_repository/i);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.list_tenant_repository_page/i);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.list_tenant_directory_page/i);
  assert.doesNotMatch(migration, /max\(payload\.company_id\)/i, 'PostgreSQL has no max(uuid) aggregate');
  assert.equal((migration.match(/array_agg\(payload\.company_id ORDER BY payload\.company_id DESC\)/gi) || []).length, 2);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.find_tenant_company_by_email/i);
  assert.match(migration, /REVOKE ALL ON TABLE private\.tenant_directory FROM PUBLIC, anon, authenticated, service_role/i);
  assert.match(migration, /REVOKE ALL ON TABLE public\.tenant_records FROM PUBLIC, anon, authenticated, service_role/i);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.find_tenant_company_by_email\(text\)\s+TO service_role/i);
  assert.match(migration, /NOTIFY pgrst, 'reload schema'/i);

  console.log('Supabase atomic transactional read and directory tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  global.fetch = previous.fetch;
  if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
  if (previous.key === undefined) delete process.env.SUPABASE_SECRET_KEY; else process.env.SUPABASE_SECRET_KEY = previous.key;
  if (previous.enabled === undefined) delete process.env.PDL_SUPABASE_ENABLED; else process.env.PDL_SUPABASE_ENABLED = previous.enabled;
});
