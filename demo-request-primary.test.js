'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(__dirname, '.tmp-demo-request-primary-'));
const dbFile = path.join(temp, 'db.json');
const platformFile = path.join(temp, 'platform.json');
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), dbFile);
const initial = { users: [], sessions: [], notes: [], demoRequests: [], auditEvents: [], helpItems: [] };
fs.writeFileSync(platformFile, JSON.stringify(initial, null, 2));

Object.assign(process.env, {
  NODE_ENV: 'test', PDL_REQUIRE_AUTH: '0', PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: platformFile,
  PDL_SUPABASE_ENABLED: '1', SUPABASE_URL: 'https://demo-primary.invalid', SUPABASE_SECRET_KEY: 'synthetic-service-role-secret',
  PDL_PLATFORM_TRANSACTIONAL_DB: 'primary'
});

const { canonicalHash, splitPlatformSnapshot, assemblePlatformSnapshot } = require('./database/platform-repository');
const supabase = require('./database/supabase');
supabase.loadLocalEnv = () => {};
let remote = structuredClone(initial), revision = 2, failSave = false, holdSave = false, releaseSave = null, replaceCalls = 0;
const response = payload => ({ json: async () => structuredClone(payload) });
supabase.request = async (pathname, options = {}) => {
  if (pathname.endsWith('/load_platform_repository')) {
    const split = splitPlatformSnapshot(remote);
    return response({ revision, scalarData: split.scalarData, records: split.records.map(row => ({ collection: row.collection, data: row.data })), contentHash: canonicalHash(remote), updatedAt: new Date().toISOString(), updatedBy: 'test' });
  }
  assert.ok(pathname.endsWith('/replace_platform_repository'), `unexpected request ${pathname}`);
  replaceCalls += 1;
  if (holdSave) {
    holdSave = false;
    await new Promise(resolve => { releaseSave = resolve; });
  }
  if (failSave) throw new Error('synthetic primary repository outage');
  const input = JSON.parse(options.body);
  if (input.p_expected_revision !== revision) {
    const error = new Error(`PDL_PLATFORM_REVISION_CONFLICT expected=${input.p_expected_revision} actual=${revision}`);
    error.code = '40001';
    throw error;
  }
  remote = assemblePlatformSnapshot(input.p_scalar_data, input.p_records.map(row => ({ collection: row.collection, data: row.data })));
  revision += 1;
  return response({ revision, recordCount: input.p_records.length, contentHash: input.p_content_hash, updatedAt: new Date().toISOString() });
};

const { server, initializePlatformPersistence } = require('./server');
const lead = { name: 'Primary Buyer', email: 'primary@example.test', company: 'Primary Concrete', requestId: '11111111-1111-4111-8111-111111111111' };

(async () => {
  try {
    await initializePlatformPersistence();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const submit = async payload => {
      const res = await fetch(`${base}/api/demo-requests`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      return { status: res.status, data: await res.json() };
    };

    let settled = false;
    holdSave = true;
    const pending = submit(lead).then(result => { settled = true; return result; });
    const deadline = Date.now() + 2000;
    while (!releaseSave) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the primary save');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(settled, false, 'success waits for the authoritative platform repository');
    releaseSave();
    const created = await pending;
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(remote.demoRequests.length, 1);
    assert.equal(remote.auditEvents.filter(row => row.action === 'demo_requested').length, 1);

    const beforeRetry = replaceCalls;
    const retry = await submit(lead);
    assert.equal(retry.status, 201);
    assert.equal(retry.data.id, created.data.id);
    assert.equal(replaceCalls, beforeRetry, 'idempotent retry does not create a second repository revision');

    failSave = true;
    const failed = await submit({ ...lead, requestId: '22222222-2222-4222-8222-222222222222', company: 'Outage Concrete' });
    assert.equal(failed.status, 503, JSON.stringify(failed.data));
    assert.equal(remote.demoRequests.length, 1, 'failed authoritative save is never presented as durable');
    console.log('Primary demo-request durability passed: delayed saves wait, retries dedupe, and repository outages never acknowledge success.');
  } finally {
    releaseSave?.();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
