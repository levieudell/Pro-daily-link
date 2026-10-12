'use strict';
// Actual exported product clients; deterministic memory transport/storage only.
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const Recovery = require('./original-operation-recovery');
const manual = require('./roles-manual-credential-client'), report = require('./roles-report-client');
const tests = [], test = (name, run) => tests.push({ name, run });
const companyId = '10000000-0000-4000-8000-000000000001', otherCompany = '10000000-0000-4000-8000-000000000002';
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(yes => resolve = yes); return { promise, resolve }; };
const error = status => Object.assign(Error('Synthetic response unavailable'), { status });
function storage() {
  const values = new Map(), fault = {};
  return { values, fault, get length() { return values.size; }, key: index => [...values.keys()][index] ?? null, getItem(key) { if (fault.read) throw Error('synthetic storage read'); return values.get(key) ?? null; }, setItem(key, value) { if (fault.quota) throw Error('synthetic quota'); values.set(key, fault.replace ? value + ' ' : value); }, removeItem(key) { if (fault.cleanupChange) fault.cleanupChange(); if (fault.cleanup) throw Error('synthetic cleanup'); values.delete(key); } };
}
function harness(kind) {
  const store = storage(), calls = [], records = new Map();
  const state = { scope: { companyId, actorId: 7, role: 'field', sessionBinding: 'a'.repeat(64) }, owner: { manualCredentialCustody: true, id: 71, role: 'platform_owner', email: 'owner@example.invalid', accountSessionBinding: 'b'.repeat(64) }, writes: 0, retired: 0, readError: null, ackError: null, authorityError: null, readChange: null, writeGate: null, readGate: null, receiptChange: null };
  const journal = () => Recovery.create(store, { crypto: crypto.webcrypto });
  const call = async (route, options = {}) => {
    calls.push({ route, options });
    if (route === '/api/platform/auth/me') { if (state.authorityError) throw state.authorityError; return clone(state.owner); }
    if (options.method === 'POST' || options.method === 'PATCH') {
      const operationId = options.headers['X-PDL-Operation'];
      assert.ok(journal().entries().some(row => row.operationId === operationId), 'original handle must be persisted/read back before send');
      state.writes++;
      const result = kind === 'manual' ? { operationId, id: 901, name: 'SYNTHETIC-PRIVATE-NAME', email: 'SYNTHETIC-PRIVATE-EMAIL@example.invalid', role: 'support', companyId, setupCode: 'SYNTHETIC-PRIVATE-SETUP-CODE', expiresAt: new Date(Date.now() + 3600000).toISOString() } : { operationId, report: { id: route === '/api/reports' ? 501 : 502, projectId: 101, notes: 'SYNTHETIC-PRIVATE-REPORT' }, files: [{ id: 601, caption: 'SYNTHETIC-PRIVATE-PHOTO' }], intake: { state: 'complete', complete: true, retryAllowed: false } };
      records.set(operationId, clone(result));
      if (state.writeGate) { state.writeGate.entered.resolve(); await state.writeGate.release.promise; }
      if (state.ackError) throw state.ackError;
      return clone(result);
    }
    const operationId = route.split('/').at(-1);
    if (!records.has(operationId)) throw error(404);
    if (state.readGate) { state.readGate.entered.resolve(); await state.readGate.release.promise; }
    if (state.readError) throw state.readError;
    const result = clone(records.get(operationId));
    if (kind === 'report') Object.assign(result, result.intake, { reportId: result.report.id });
    if (state.receiptChange) state.receiptChange(result);
    if (state.readChange) state.readChange();
    return result;
  };
  const create = () => kind === 'manual' ? manual.create(call, { journal: journal(), retire: () => state.retired++ }) : report.createIntakeClient({ call, journal: journal(), identity: async () => { if (state.authorityError) throw state.authorityError; return clone(state.scope); }, retire: () => state.retired++ });
  const route = kind === 'manual' ? '/api/platform/users' : '/api/reports';
  const input = () => kind === 'manual' ? { method: 'POST', body: JSON.stringify({ name: 'SYNTHETIC-PRIVATE-NAME', email: 'SYNTHETIC-PRIVATE-EMAIL@example.invalid', role: 'support' }), manualAccept: () => true } : { body: { report: { projectId: 101, notes: 'SYNTHETIC-PRIVATE-REPORT', signature: 'SYNTHETIC-PRIVATE-SIGNATURE' }, files: [{ data: 'SYNTHETIC-PRIVATE-PHOTO-BYTES' }], caption: 'SYNTHETIC-PRIVATE-CAPTION', tags: ['SYNTHETIC-PRIVATE-TAGS'] }, target: { companyId, projectId: 101, resourceId: null }, accept: () => true };
  const submit = (client, options = input(), path = route) => kind === 'manual' ? client(path, options) : client.submit(path, options);
  const original = client => client.originalOperations()[0];
  const gate = type => { state[type + 'Gate'] = { entered: deferred(), release: deferred() }; return state[type + 'Gate']; };
  return { store, state, calls, records, create, route, input, submit, original, gate };
}
for (const kind of ['manual', 'report']) {
  test(kind + ': successful ACK persists only closed opaque metadata until explicit original review', async () => {
    const h = harness(kind), client = h.create(), result = await h.submit(client), handle = h.original(client);
    assert.equal(result.operationId, handle.operationId); assert.equal(h.state.writes, 1);
    const raw = [...h.store.values.values()].join(''); assert.ok(!raw.includes('SYNTHETIC-PRIVATE')); assert.ok(!raw.includes('owner@example.invalid')); assert.ok(!raw.includes(h.state.scope.sessionBinding)); assert.ok(!raw.includes(h.state.owner.accountSessionBinding));
    await assert.rejects(client.reviewOriginal(handle.operationId, { confirmed: false })); assert.equal(h.store.values.size, 1);
    const reviewed = await client.reviewOriginal(handle.operationId, { confirmed: true, accept: () => true }); assert.equal(reviewed.operationId, handle.operationId); assert.equal(h.store.values.size, 0); assert.equal(h.state.writes, 1);
  });
  test(kind + ': reload/restart recovers original GET with no old form, files, credential or new POST', async () => {
    const h = harness(kind), old = h.create(); h.state.ackError = error(503); h.state.readError = error(503); await assert.rejects(h.submit(old)); const handle = h.original(old), before = [...h.store.values];
    const current = h.create(); h.state.readError = null; const recovered = await current.recoverOriginal(handle.operationId); assert.equal(recovered.operationId, handle.operationId); assert.equal(h.state.writes, 1); assert.deepEqual([...h.store.values], before);
    assert.ok(h.calls.some(row => !row.options.method && row.route.endsWith(handle.operationId))); await assert.rejects(h.submit(current, kind === 'manual' ? { ...h.input(), body: '{}' } : { ...h.input(), body: { report: { projectId: 101 } } })); assert.equal(h.state.writes, 1);
  });
  test(kind + ': same live factory retains erased original handle and cannot submit a replacement', async () => {
    const h = harness(kind), client = h.create(); h.state.ackError = error(503); h.state.readError = error(404); await assert.rejects(h.submit(client)); const handle = h.original(client); h.store.values.clear();
    assert.equal(h.original(client).operationId, handle.operationId); await assert.rejects(h.submit(client)); assert.equal(h.state.writes, 1); assert.equal(h.store.values.size, 0);
    h.state.readError = null; const original = await client.recoverOriginal(handle.operationId); assert.equal(original.operationId, handle.operationId); assert.equal(h.state.writes, 1); assert.equal(h.store.values.size, 0);
    await client.reviewOriginal(handle.operationId, { confirmed: true }); assert.equal(client.originalOperations().length, 0); assert.equal(h.state.writes, 1);
  });
  for (const status of [401, 402, 403, 404, 409, 500, 503]) test(kind + ': recovery status ' + status + ' retains original ID and retires private UI without replacement', async () => {
    const h = harness(kind), old = h.create(); await h.submit(old); const handle = h.original(old), bytes = [...h.store.values]; h.state.readError = error(status); const current = h.create();
    await assert.rejects(current.recoverOriginal(handle.operationId)); await assert.rejects(h.submit(current)); assert.equal(h.state.writes, 1); assert.deepEqual([...h.store.values], bytes); assert.ok(h.state.retired > 0);
  });
  for (const field of ['account', 'role', 'session', 'company']) test(kind + ': different current ' + field + ' cannot recover private bytes or dispatch anew', async () => {
    const h = harness(kind), old = h.create(); await h.submit(old); const handle = h.original(old), bytes = [...h.store.values];
    if (kind === 'manual') { if (field === 'account') h.state.owner.id++; if (field === 'role') h.state.owner.role = 'support'; if (field === 'session') h.state.owner.accountSessionBinding = 'c'.repeat(64); if (field === 'company') h.state.owner.manualCredentialCustody = false; }
    else { if (field === 'account') h.state.scope.actorId++; if (field === 'role') h.state.scope.role = 'foreman'; if (field === 'session') h.state.scope.sessionBinding = 'c'.repeat(64); if (field === 'company') h.state.scope.companyId = otherCompany; }
    const current = h.create(); await assert.rejects(current.recoverOriginal(handle.operationId)); await assert.rejects(h.submit(current)); assert.equal(h.state.writes, 1); assert.deepEqual([...h.store.values], bytes);
  });
  test(kind + ': buffered original result rechecks current authority after delivery', async () => {
    const h = harness(kind), client = h.create(); await h.submit(client); const handle = h.original(client), wait = h.gate('read'); const recovering = h.create().recoverOriginal(handle.operationId); await wait.entered.promise; h.state.authorityError = error(401); wait.release.resolve(); await assert.rejects(recovering); assert.ok(h.state.retired); assert.equal(h.original(client).operationId, handle.operationId); assert.equal(h.state.writes, 1);
  });
  test(kind + ': malformed storage after reload blocks POST and keeps bytes', async () => {
    const h = harness(kind), client = h.create(); await h.submit(client); const handle = h.original(client), key = Recovery.PREFIX + handle.operationId; const row = JSON.parse(h.store.values.get(key)); row.privateBody = { secret: 'SYNTHETIC-PRIVATE' }; h.store.values.set(key, JSON.stringify(row)); const bytes = [...h.store.values]; await assert.rejects(h.submit(h.create())); assert.equal(h.state.writes, 1); assert.deepEqual([...h.store.values], bytes);
  });
  for (const fault of ['quota', 'replace']) test(kind + ': ' + fault + ' persistence cannot dispatch a POST', async () => { const h = harness(kind); h.store.fault[fault] = true; await assert.rejects(h.submit(h.create())); assert.equal(h.state.writes, 0); });
  test(kind + ': known result with cleanup failure stays known, retains original handle and fresh authority fence', async () => {
    const h = harness(kind), client = h.create(); await h.submit(client); const handle = h.original(client); h.store.fault.cleanup = true;
    const result = await h.create().reviewOriginal(handle.operationId, { confirmed: true }); assert.equal(result.operationId, handle.operationId); assert.equal(result.originalHandleRetained, true); assert.equal(h.original(client).operationId, handle.operationId); assert.equal(h.state.writes, 1);
  });
  test(kind + ': cleanup failure never skips fresh authority before returning known private bytes', async () => {
    const h = harness(kind), client = h.create(); await h.submit(client); const handle = h.original(client); h.store.fault.cleanup = true; h.store.fault.cleanupChange = () => h.state.authorityError = error(403);
    await assert.rejects(h.create().reviewOriginal(handle.operationId, { confirmed: true }), value => value.knownResult === true && !value.setupCode && !value.report && value.status === 403);
    assert.equal(h.original(client).operationId, handle.operationId); assert.ok(h.state.retired); assert.equal(h.state.writes, 1);
  });
  test(kind + ': false/unknown acceptance suppresses original read and private result', async () => {
    const h = harness(kind), client = h.create(); await h.submit(client); const handle = h.original(client), before = h.calls.length;
    for (const accept of [false, null, 0, 'true', () => false, () => undefined]) await assert.rejects(h.create().recoverOriginal(handle.operationId, { accept })); assert.equal(h.state.writes, 1); assert.ok(!h.calls.slice(before).some(row => row.route.endsWith(handle.operationId)));
  });
}
test('manual: natural setup expiry does not release original custody or return setup bytes', async () => {
  const h = harness('manual'), client = h.create(); await h.submit(client); const handle = h.original(client); h.state.receiptChange = value => value.expiresAt = '2000-01-01T00:00:00.000Z'; await assert.rejects(h.create().recoverOriginal(handle.operationId)); assert.equal(h.original(client).operationId, handle.operationId); assert.equal(h.state.writes, 1);
});
test('manual: owner-reset recovery binds exact original tenant', async () => {
  const h = harness('manual'), route = '/api/platform/companies/' + companyId + '/owner-reset', client = h.create(); await h.submit(client, { method: 'POST', body: '{}' }, route); const handle = h.original(client); assert.equal(handle.target.companyId, companyId); h.state.receiptChange = value => value.companyId = otherCompany; await assert.rejects(h.create().recoverOriginal(handle.operationId)); assert.equal(h.state.writes, 1);
});
for (const state of ['pending', 'unknown', 'changed']) test('report: ' + state + ' original status remains read-only and cannot be cleared/resubmitted', async () => {
  const h = harness('report'), client = h.create(); await h.submit(client); const handle = h.original(client); h.state.receiptChange = value => { value.state = state; value.complete = false; delete value.report; delete value.files; };
  const recovered = await h.create().recoverOriginal(handle.operationId); assert.equal(recovered.state, state); assert.equal(recovered.complete, false); assert.equal(recovered.retryAllowed, false); await assert.rejects(h.create().reviewOriginal(handle.operationId, { confirmed: true })); assert.equal(h.original(client).operationId, handle.operationId); assert.equal(h.state.writes, 1);
});
test('report: edited target binds original resource and project on readback', async () => {
  const h = harness('report'), client = h.create(), options = h.input(); options.target.resourceId = 502; await h.submit(client, options, '/api/reports/502'); const handle = h.original(client); h.state.receiptChange = value => { value.reportId = 599; value.report.id = 599; }; await assert.rejects(h.create().recoverOriginal(handle.operationId)); assert.equal(h.state.writes, 1);
});
test('report: immutable captured body prevents a caller mutation during dispatch await', async () => {
  const h = harness('report'), client = h.create(), options = h.input(), wait = h.gate('write'), sending = h.submit(client, options); await wait.entered.promise; options.body.report.notes = 'CHANGED-AFTER-DISPATCH'; options.target.projectId = 999; wait.release.resolve(); await sending; const posted = h.calls.find(value => value.options.method === 'POST'); assert.equal(JSON.parse(posted.options.body).report.notes, 'SYNTHETIC-PRIVATE-REPORT'); assert.equal(h.original(client).target.projectId, 101);
});
test('report: foreign project/company target is rejected before any POST', async () => {
  for (const change of [options => options.target.companyId = otherCompany, options => options.target.projectId = 999]) { const h = harness('report'), options = h.input(); change(options); await assert.rejects(h.submit(h.create(), options)); assert.equal(h.state.writes, 0); assert.equal(h.store.values.size, 0); }
});
(async () => { for (const { name, run } of tests) { try { await run(); } catch (error) { console.error(name); throw error; } } console.log(JSON.stringify({ passed: true, checks: tests.length, actualProductFactories: true, syntheticOnly: true, externalCalls: 0, providerCalls: 0 })); })().catch(error => { console.error(error); process.exitCode = 1; });
