'use strict';
// Actual exported client factory and actual platform caller closures. This file
// uses only memory transport/DOM; it never creates a real account or credential.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, 'roles-manual-credential-client.js'), 'utf8');
const platformSource = fs.readFileSync(path.join(__dirname, 'platform.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const tests = [], test = (name, run) => tests.push({ name, run });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const identity = () => ({ manualCredentialCustody: true, id: 71, role: 'platform_owner', email: 'synthetic-owner@example.invalid', accountSessionBinding: 'a'.repeat(64) });
const staffRoute = '/api/platform/users', resetRoute = '/api/platform/companies/synthetic-company-a/owner-reset';
const staffBody = { name: 'Synthetic staff', email: 'synthetic-staff@example.invalid', role: 'platform_admin' };
const error = status => Object.assign(Error('Synthetic original status ' + status), { status });
function harness({ role, binding, flag = true, writeError = null, receipt = 'complete' } = {}) {
  const state = { identity: { ...identity(), manualCredentialCustody: flag, ...(role === undefined ? {} : { role }), ...(binding === undefined ? {} : { accountSessionBinding: binding }) }, formCurrent: true, acceptedGenerations: 0, uuidCount: 0, records: new Map(), writeError, receipt, identityGates: [], writeGates: [], receiptGates: [] }, calls = [];
  const call = async (route, options = {}) => {
    calls.push({ route, options: { ...options, ...(options.headers ? { headers: { ...options.headers } } : {}) } });
    if (route === '/api/platform/auth/me') { const gate = state.identityGates.shift(); if (gate) await gate.promise; return clone(state.identity); }
    if (options.method === 'POST' && (route === staffRoute || /^\/api\/platform\/companies\/[^/]+\/owner-reset$/.test(route))) {
      const originalError = state.writeError, operationId = options.headers?.['X-PDL-Operation'], gate = state.writeGates.shift();
      const result = { operationId, setupCode: 'SYNTHETIC-SETUP-CODE-ONE', name: 'Synthetic staff', email: route === staffRoute ? staffBody.email : 'synthetic-company-owner@example.invalid' };
      if (!originalError || ![400, 403, 409].includes(originalError.status)) { state.acceptedGenerations++; state.records.set(operationId, result); }
      if (gate) await gate.promise; if (originalError) throw originalError; return clone(result);
    }
    if (/^\/api\/platform\/manual-credentials\/[^/]+$/.test(route) || /^\/api\/platform\/companies\/[^/]+\/owner-reset\/[^/]+$/.test(route)) {
      const gate = state.receiptGates.shift(); if (gate) await gate.promise;
      const operationId = route.split('/').at(-1), row = state.records.get(operationId);
      if (state.receipt instanceof Error) throw state.receipt;
      if (state.receipt === 'missing') throw Object.assign(Error('Synthetic original operation absent'), { status: 404 });
      if (state.receipt === 'pending') return { operationId, state: 'pending', retryAllowed: false };
      if (state.receipt === 'wrong-id') return { ...row, operationId: '00000000-0000-4000-8000-000000000099' };
      if (state.receipt === 'bad-code') return { ...row, setupCode: {} };
      if (!row) throw Object.assign(Error('Synthetic original operation absent'), { status: 404 });
      return clone(row);
    }
    return { passthrough: true, route };
  };
  const context = { module: { exports: {} }, crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++state.uuidCount).padStart(12, '0')}` } };
  vm.createContext(context); vm.runInContext(source, context, { filename: 'roles-manual-credential-client.js' }); const request = context.module.exports.create(call);
  const options = (body = staffBody, extra = {}) => ({ method: 'POST', body: JSON.stringify(body), manualAccept: () => state.formCurrent, ...extra });
  const writes = () => calls.filter(row => row.options.method === 'POST' && (row.route === staffRoute || row.route.endsWith('/owner-reset')));
  const reads = () => calls.filter(row => /\/manual-credentials\//.test(row.route) || /\/owner-reset\//.test(row.route));
  const defer = kind => { const gate = deferred(); state[kind + 'Gates'].push(gate); return gate; };
  return { state, calls, request, options, writes, reads, defer, context };
}

test('module exposes its actual create(call) factory', () => { const h = harness(); assert.equal(typeof h.context.module.exports.create, 'function'); assert.equal(typeof h.request, 'function'); });
for (const [route, body] of [[staffRoute, staffBody], [resetRoute, {}]]) {
  const label = route === staffRoute ? 'staff create' : 'company Owner reset';
  test(label + ' checks fresh fixed Owner identity, preserves options and emits one stable operation header', async () => {
    const h = harness(), options = h.options(body, { headers: { 'X-Synthetic': 'preserved', 'X-PDL-Operation': 'untrusted-caller-operation' }, redirectOnUnauthorized: false }); const result = await h.request(route, options);
    assert.equal(h.writes().length, 1); assert.equal(h.state.acceptedGenerations, 1); assert.equal(h.state.uuidCount, 1); const sent = h.writes()[0]; assert.equal(sent.options.body, JSON.stringify(body)); assert.equal(sent.options.headers['X-Synthetic'], 'preserved'); assert.equal(sent.options.redirectOnUnauthorized, false); assert.equal(sent.options.manualAccept, undefined); assert.match(sent.options.headers['X-PDL-Operation'], /^00000000-0000-4000-8000-/); assert.equal(result.operationId, sent.options.headers['X-PDL-Operation']); assert.equal(result.setupCode, 'SYNTHETIC-SETUP-CODE-ONE'); assert.equal(options.headers['X-PDL-Operation'], 'untrusted-caller-operation'); assert.ok(h.calls.filter(row => row.route === '/api/platform/auth/me').length >= 3);
  });
  test(label + ' lost ACK reads the same original operation and never generates or submits twice', async () => {
    const h = harness({ writeError: error(503) }), result = await h.request(route, h.options(body)); assert.equal(h.writes().length, 1); assert.equal(h.reads().length, 1); assert.equal(h.state.acceptedGenerations, 1); assert.equal(h.state.uuidCount, 1); const id = h.writes()[0].options.headers['X-PDL-Operation']; assert.equal(result.operationId, id); assert.equal(h.reads()[0].route, route === staffRoute ? '/api/platform/manual-credentials/' + id : route + '/' + id); assert.equal(h.reads()[0].options.method, undefined);
  });
  for (const receipt of ['pending', 'wrong-id', 'bad-code']) test(label + ' ' + receipt + ' readback retains original custody for read-only retry', async () => {
    const h = harness({ writeError: error(503), receipt }); await assert.rejects(h.request(route, h.options(body)), /original setup operation/i); const id = h.writes()[0].options.headers['X-PDL-Operation']; await assert.rejects(h.request(route, h.options(body))); assert.equal(h.writes().length, 1); assert.equal(h.state.acceptedGenerations, 1); assert.equal(h.state.uuidCount, 1); assert.equal(h.reads().length, 2); assert.ok(h.reads().every(row => row.route.endsWith(id))); h.state.receipt = 'complete'; const original = await h.request(route, h.options(body)); assert.equal(original.operationId, id); assert.equal(h.writes().length, 1);
  });
}
for (const role of ['platform_admin', 'owner', 'admin', 'project_manager', 'field', 'foreman']) test('managed request rejects non-platform-Owner role ' + role + ' without generation or dispatch', async () => {
  const h = harness({ role }); await assert.rejects(h.request(staffRoute, h.options()), /Current platform Owner session/); assert.equal(h.writes().length, 0); assert.equal(h.state.uuidCount, 0); assert.equal(h.state.acceptedGenerations, 0);
});
for (const binding of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), 123]) test('managed request rejects noncanonical session binding ' + JSON.stringify(binding).slice(0, 25), async () => {
  const h = harness({ binding }); await assert.rejects(h.request(staffRoute, h.options()), /Current platform Owner session/); assert.equal(h.writes().length, 0); assert.equal(h.state.uuidCount, 0);
});
test('nonmanaged existing routes and explicit custody-off preserve exact baseline call without an operation header', async () => {
  const h = harness({ flag: false }), original = { method: 'POST', body: '{}', headers: { 'X-Synthetic': 'kept' } }; await h.request(staffRoute, original); assert.equal(h.calls.length, 2); assert.equal(h.calls[1].options.headers['X-PDL-Operation'], undefined); assert.equal(h.state.uuidCount, 0);
  const other = harness(); for (const [route, method] of [[staffRoute, 'GET'], [resetRoute, 'PATCH'], ['/api/platform/other-work', 'POST']]) await other.request(route, { method, body: '{}' }); assert.equal(other.calls.length, 3); assert.equal(other.state.uuidCount, 0);
});
test('pending same-route different staff body cannot generate or query a substitute request', async () => {
  const h = harness({ writeError: error(503), receipt: 'pending' }); await assert.rejects(h.request(staffRoute, h.options())); const before = h.calls.length; await assert.rejects(h.request(staffRoute, h.options({ ...staffBody, email: 'different-staff@example.invalid' })), /different account request/); assert.equal(h.calls.length, before + 1); assert.equal(h.writes().length, 1); assert.equal(h.reads().length, 1); assert.equal(h.state.uuidCount, 1);
});
for (const route of ['/api/platform/companies/synthetic-company-b/owner-reset', resetRoute]) test('pending staff intent blocks different operation target ' + route, async () => {
  const h = harness({ writeError: error(503), receipt: 'pending' }); await assert.rejects(h.request(staffRoute, h.options())); await assert.rejects(h.request(route, h.options({})), /different account request/); assert.equal(h.writes().length, 1); assert.equal(h.state.uuidCount, 1); assert.equal(h.reads().length, 1);
});
test('pending Owner-reset target blocks a different company and a staff-create generation', async () => {
  const h = harness({ writeError: error(503), receipt: 'pending' }); await assert.rejects(h.request(resetRoute, h.options({}))); for (const route of ['/api/platform/companies/synthetic-company-b/owner-reset', staffRoute]) await assert.rejects(h.request(route, h.options(route === staffRoute ? staffBody : {})), /different account request/); assert.equal(h.writes().length, 1); assert.equal(h.state.uuidCount, 1);
});
for (const [key, value] of [['id', 72], ['role', 'platform_admin'], ['email', 'other-owner@example.invalid'], ['accountSessionBinding', 'b'.repeat(64)]]) test('pending original is retired by changed current ' + key + ' without a new operation or stale code', async () => {
  const h = harness({ writeError: error(503), receipt: 'pending' }); await assert.rejects(h.request(staffRoute, h.options())); h.state.identity[key] = value; await assert.rejects(h.request(staffRoute, h.options())); assert.equal(h.writes().length, 1); assert.equal(h.state.uuidCount, 1); assert.equal(h.reads().length, 1);
});
for (const status of [400, 403, 409]) test('known original rejection ' + status + ' plus confirmed readonly absence permits one corrected new intent', async () => {
  const h = harness({ writeError: error(status), receipt: 'missing' }); await assert.rejects(h.request(staffRoute, h.options())); assert.equal(h.state.acceptedGenerations, 0); const old = h.writes()[0].options.headers['X-PDL-Operation']; h.state.writeError = null; h.state.receipt = 'complete'; const result = await h.request(staffRoute, h.options({ ...staffBody, name: 'Synthetic corrected staff' })); assert.equal(h.writes().length, 2); assert.equal(h.state.acceptedGenerations, 1); assert.equal(h.state.uuidCount, 2); assert.notEqual(result.operationId, old);
});
for (const status of [401, 404, 422, 500, 503]) test('uncertain original status ' + status + ' plus lookup404 preserves custody and cannot issue a replacement', async () => {
  const h = harness({ writeError: error(status), receipt: 'missing' }); await assert.rejects(h.request(staffRoute, h.options()), /original setup operation/i); const id = h.writes()[0].options.headers['X-PDL-Operation']; await assert.rejects(h.request(staffRoute, h.options())); assert.equal(h.writes().length, 1); assert.equal(h.state.uuidCount, 1); assert.equal(h.reads().length, 2); assert.ok(h.reads().every(row => row.route.endsWith(id)));
});
for (const originalStatus of [400, 403, 409]) test('known rejection ' + originalStatus + ' without confirmed absence still cannot clear original custody', async () => {
  const h = harness({ writeError: error(originalStatus), receipt: error(503) }); await assert.rejects(h.request(staffRoute, h.options())); await assert.rejects(h.request(staffRoute, h.options())); assert.equal(h.writes().length, 1); assert.equal(h.state.uuidCount, 1); assert.equal(h.reads().length, 2);
});
for (const value of [false, undefined, 0, 'true']) test('manualAccept must return true before first mutation: ' + String(value), async () => {
  const h = harness(); await assert.rejects(h.request(staffRoute, h.options(staffBody, { manualAccept: () => value })), /Current account or form changed/); assert.equal(h.writes().length, 0); assert.equal(h.state.acceptedGenerations, 0); assert.equal(h.reads().length, 0);
});
for (const [label, change] of [['form', h => { h.state.formCurrent = false; }], ['session', h => { h.state.identity.accountSessionBinding = 'b'.repeat(64); }], ['actor', h => { h.state.identity.id = 72; }], ['custody flag', h => { h.state.identity.manualCredentialCustody = false; }]]) test('late original ACK after changed ' + label + ' rejects secret bytes and preserves original intent', async () => {
  const h = harness(), wait = h.defer('write'), sending = h.request(staffRoute, h.options()); await flush(); assert.equal(h.writes().length, 1); const id = h.writes()[0].options.headers['X-PDL-Operation']; change(h); wait.resolve(); await assert.rejects(sending, /original setup operation/i); assert.equal(h.writes().length, 1); assert.equal(h.state.acceptedGenerations, 1);
  h.state.formCurrent = true; h.state.identity = identity(); const recovered = await h.request(staffRoute, h.options()); assert.equal(recovered.operationId, id); assert.equal(h.writes().length, 1); assert.equal(h.state.uuidCount, 1);
});
test('retiring custody while original is uncertain cannot fall through to a new baseline credential generation', async () => {
  const h = harness({ writeError: error(503), receipt: 'pending' }); await assert.rejects(h.request(staffRoute, h.options())); h.state.identity.manualCredentialCustody = false; await assert.rejects(h.request(staffRoute, h.options())); assert.equal(h.writes().length, 1); assert.equal(h.state.uuidCount, 1); assert.equal(h.state.acceptedGenerations, 1);
});
test('late readonly original recovery checks manualAccept before returning setup bytes and does not resend', async () => {
  const h = harness({ writeError: error(503), receipt: 'pending' }); await assert.rejects(h.request(staffRoute, h.options())); h.state.receipt = 'complete'; const wait = h.defer('receipt'), recovering = h.request(staffRoute, h.options()); await flush(); h.state.formCurrent = false; wait.resolve(); await assert.rejects(recovering, /Current account or form changed/); assert.equal(h.writes().length, 1); assert.equal(h.state.uuidCount, 1); h.state.formCurrent = true; assert.equal((await h.request(staffRoute, h.options())).setupCode, 'SYNTHETIC-SETUP-CODE-ONE'); assert.equal(h.writes().length, 1);
});
test('simultaneous same-intent calls share one operation and only one write generation', async () => {
  const h = harness(), wait = h.defer('write'), first = h.request(staffRoute, h.options()); await flush(); const second = h.request(staffRoute, h.options()); await flush(); wait.resolve(); const results = await Promise.all([first, second]); assert.equal(results[0].operationId, results[1].operationId); assert.equal(h.writes().length, 1); assert.equal(h.state.uuidCount, 1); assert.equal(h.state.acceptedGenerations, 1);
});

// Execute the existing dialog version logic and the actual named platform call
// sites. This catches removal of manualAccept even if the pure factory is sound.
function platformHarness(h) {
  const nodes = new Map(), listeners = {}, alerts = [];
  const node = id => { if (!nodes.has(id)) nodes.set(id, { id, value: '', innerHTML: '', textContent: '', open: id === 'staff-modal', dataset: {}, showModal() { this.open = true; }, close() { this.open = false; }, closest: () => nodes.get(id.startsWith('staff-') ? 'staff-modal' : 'work-modal') }); return nodes.get(id); };
  for (const id of ['staff-modal', 'work-modal', 'staff-name', 'staff-email', 'staff-role', 'staff-code', 'save-staff', 'add-staff', 'work-title', 'work-fields', 'work-message']) node(id);
  node('staff-name').value = staffBody.name; node('staff-email').value = staffBody.email; node('staff-role').value = staffBody.role;
  const context = { $: selector => node(selector.slice(1)), document: { addEventListener: (type, listener) => (listeners[type] ||= []).push(listener) }, api: h.request, reload: async () => {}, alert: value => alerts.push(value), currentView: 'customers', activeCompanyId: 'synthetic-company-a', viewVersion: 0, platformUser: identity(), safe: value => String(value ?? '') };
  vm.createContext(context);
  const lines = platformSource.split('\n'), helpers = lines.slice(lines.findIndex(line => line.startsWith('const dialogVersions=')), lines.findIndex(line => line.startsWith('function renderAccountContext('))).filter(line => !line.startsWith('let reloadVersion='));
  vm.runInContext(helpers.join('\n'), context, { filename: 'platform.js:actual-dialog-current' });
  const staff = lines.find(line => line.startsWith("$('#add-staff').onclick=")), actions = lines.find(line => line.startsWith("document.addEventListener('change',async e=>")); assert.ok(staff && actions);
  vm.runInContext(staff + '\n' + actions, context, { filename: 'platform.js:actual-manual-credential-callers' });
  return { context, node, alerts, input: async id => { for (const listener of listeners.input || []) await listener({ target: node(id) }); }, staff: () => node('save-staff').onclick(), reset: async companyId => { for (const listener of listeners.click || []) await listener({ target: { dataset: { ownerReset: companyId } } }); } };
}
test('actual staff caller provides current-dialog acceptance and renders one accepted original code', async () => {
  const h = harness(), p = platformHarness(h); await p.staff(); assert.equal(h.writes().length, 1); assert.equal(h.writes()[0].options.manualAccept, undefined); assert.ok(p.node('staff-code').innerHTML.includes('SYNTHETIC-SETUP-CODE-ONE')); assert.deepEqual(JSON.parse(h.writes()[0].options.body), staffBody);
});
test('actual staff caller editing its form during ACK await suppresses old bytes and blocks replacement for changed staff', async () => {
  const h = harness(), p = platformHarness(h), wait = h.defer('write'), sending = p.staff(); await flush(); p.node('staff-email').value = 'different-staff@example.invalid'; await p.input('staff-email'); wait.resolve(); await sending; assert.equal(p.node('staff-code').innerHTML, ''); assert.equal(h.writes().length, 1); await p.staff(); assert.equal(h.writes().length, 1); assert.match(p.node('staff-code').textContent, /original setup operation/i);
});
test('actual staff caller closed during initial identity await cannot dispatch a credential mutation', async () => {
  const h = harness(), p = platformHarness(h), wait = h.defer('identity'), sending = p.staff(); await flush(); p.node('staff-modal').close(); wait.resolve(); await sending; assert.equal(h.writes().length, 0); assert.equal(h.state.acceptedGenerations, 0); assert.equal(p.node('staff-code').innerHTML, '');
});
test('actual Owner-reset caller binds the current account view and blocks late code after another account is selected', async () => {
  const h = harness(), p = platformHarness(h), wait = h.defer('write'), sending = p.reset('synthetic-company-a'); await flush(); assert.equal(h.writes().length, 1); p.context.activeCompanyId = 'synthetic-company-b'; wait.resolve(); await sending; assert.equal(p.node('work-fields').innerHTML, ''); assert.equal(p.node('work-modal').open, false); assert.equal(p.alerts.length, 0); await p.reset('synthetic-company-b'); assert.equal(h.writes().length, 1); assert.match(p.alerts.at(-1), /original setup operation/i);
});

(async () => {
  let failed = 0; for (const { name, run } of tests) { try { await run(); } catch (failure) { failed++; console.error('FAIL:', name); console.error(failure); } }
  console.log(JSON.stringify({ passed: failed === 0, checks: tests.length, failed, syntheticOnly: true, runtime: 'Actual client factory and platform caller closures in Node VM; memory transport only', clientSha256: crypto.createHash('sha256').update(source).digest('hex'), platformSha256: crypto.createHash('sha256').update(platformSource).digest('hex'), externalCalls: 0, providerCalls: 0, realCredentialGenerations: 0, realAccounts: 0 })); if (failed) process.exitCode = 1;
})().catch(failure => { console.error(failure); process.exitCode = 1; });
