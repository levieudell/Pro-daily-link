'use strict';
const assert = require('node:assert/strict');
const { createRepository, PLATFORM_ID, PLATFORM_NAME, envelope } = require('./platform-snapshot-repository');
const { canonicalHash } = require('./transactional-repository');
const snapshot = () => ({ company: { id: PLATFORM_ID, name: PLATFORM_NAME }, platform: { users: [{ id: 1, role: 'platform_owner', status: 'Active' }], auditEvents: [] } });
const deadline = () => ({ deadline: new Date(Date.now() + 30000).toISOString() });
const unavailable = error => error.code === 'PDL_PLATFORM_STORAGE';
async function main() {
  let requests = 0, readiness = true, result = [{ id: PLATFORM_ID, data: snapshot(), platform_revision: '4', platform_managed: true, roles_managed: false }], handler;
  const transport = { async request(path, options) { requests++; if (handler) return handler(path, options); if (path === '/rest/v1/rpc/platform_snapshot_trigger_contract') { assert.equal(options.method, 'POST'); assert.equal(options.body, '{}'); return { json: async () => readiness }; } return { json: async () => structuredClone(result) }; } };
  assert.throws(() => createRepository(transport), unavailable);
  assert.throws(() => createRepository(transport, 'a0527b09-7132-4e31-84f8-41ff6512a41b'), unavailable);
  const repository = createRepository(transport, PLATFORM_ID);
  const loaded = await repository.load(); assert.equal(loaded.revision, 4); assert.equal(loaded.managed, true); assert.equal(loaded.contentHash, canonicalHash(snapshot()));
  const prior = requests; await assert.rejects(repository.load('foreign-company'), unavailable); assert.equal(requests, prior);
  for (const change of [row => row.platform_managed = false, row => delete row.platform_managed, row => row.roles_managed = true, row => row.platform_revision = null, row => row.platform_revision = '04', row => row.platform_revision = Number.MAX_SAFE_INTEGER, row => row.id = 'foreign', row => row.data.company.id = 'foreign', row => row.data.users = [], row => row.data.platform = [], row => row.data.company.name = 'Tenant']) {
    result = [{ id: PLATFORM_ID, data: snapshot(), platform_revision: 4, platform_managed: true, roles_managed: false }]; change(result[0]); await assert.rejects(repository.load(), unavailable);
  }
  result = [{ id: PLATFORM_ID, data: snapshot(), platform_revision: 4, platform_managed: true, roles_managed: false }];
  for (const value of [false, null, {}, [], [true], 'true']) { readiness = value; await assert.rejects(repository.load(), unavailable); }
  readiness = true; handler = async route => { if (route === '/rest/v1/rpc/platform_snapshot_trigger_contract') throw Error('Synthetic metadata RPC unavailable'); return { json: async () => result }; }; await assert.rejects(repository.load(), unavailable); handler = null;
  for (const value of [{ ...snapshot(), users: [] }, { ...snapshot(), platform: null }, { ...snapshot(), company: { ...snapshot().company, roles_managed: true } }, { ...snapshot(), platform: { value: Infinity } }, { ...snapshot(), platform: { missing: undefined } }]) assert.equal(envelope(value, PLATFORM_ID), false);
  const cycle = snapshot(); cycle.platform.cycle = cycle; assert.equal(envelope(cycle, PLATFORM_ID), false);
  handler = async (path, options) => { assert.equal(path, '/rest/v1/rpc/commit_platform_snapshot'); const payload = JSON.parse(options.body); assert.equal(payload.p_platform_id, PLATFORM_ID); assert.equal(payload.p_expected_revision, 4); assert.deepEqual(payload.p_snapshot, snapshot()); return { json: async () => [{ revision: '5' }] }; };
  const saved = await repository.commit(snapshot(), 4, deadline()); assert.equal(saved.revision, 5); assert.equal(saved.contentHash, canonicalHash(snapshot()));
  for (const guard of [null, {}, { ...deadline(), platformId: 'foreign' }, { deadline: 'invalid' }]) await assert.rejects(repository.commit(snapshot(), 4, guard), unavailable);
  await assert.rejects(repository.commit(snapshot(), -1, deadline()), unavailable);
  const candidate = snapshot(), expectedHash = canonicalHash(candidate); let release, started;
  const entered = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  handler = async (path, options) => { started(); await gate; assert.equal(JSON.parse(options.body).p_snapshot.platform.users[0].status, 'Active'); return { json: async () => [{ revision: 5 }] }; };
  const pending = repository.commit(candidate, 4, deadline()); await entered; candidate.platform.users[0].status = 'Inactive'; release(); assert.equal((await pending).contentHash, expectedHash);
  for (const failure of [Object.assign(Error('PDL_REVISION_CONFLICT'), { code: '40001' }), Error('PDL_PLATFORM_DEADLINE')]) { handler = async () => { throw failure; }; await assert.rejects(repository.commit(snapshot(), 4, deadline()), error => error.code === 'PDL_REVISION_CONFLICT'); }
  handler = async () => { throw Error('Synthetic lost acknowledgement after commit'); }; await assert.rejects(repository.commit(snapshot(), 4, deadline()), error => error.code === 'PDL_COMMIT_OUTCOME_UNKNOWN');
  for (const rows of [[], [{ revision: 6 }], [{ revision: '05' }], [{ revision: 5 }, { revision: 5 }]]) { handler = async () => ({ json: async () => rows }); await assert.rejects(repository.commit(snapshot(), 4, deadline()), error => error.code === 'PDL_COMMIT_OUTCOME_UNKNOWN'); }
  console.log(JSON.stringify({ platformRepository: 'passed', dedicatedEnvelope: true, freshFlagRevisionHash: true, initializesOrActivates: false, transportRequests: requests, externalCalls: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
