'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const family = require('./resource-catalog-contract'), input = require('./resource-inputs');
const { A, B, initial, credential, snapshot, memory } = require('./compat-account-fixture');
const { services } = require('./compat-lifecycle-fixture');
const { canonicalHash } = require('./database/transactional-repository');
const op = (kind, method, path, details) => family.parse({ kind, method, path, details }, input);
const rejects = (fn, status) => assert.throws(fn, error => error.statusCode === status);
const auth = role => ({ user: { id: 3, status: 'Active', role, projectIds: [101], permissions: {} } });
const h = {
  canAccessProject: (db, user, id) => ['owner', 'admin'].includes(user.role) || user.role === 'project_manager' && user.projectIds.includes(id),
  canViewPricing: (db, user) => ['owner', 'admin'].includes(user.role) || user.role === 'project_manager' && db.company.pricingAccess?.enabled !== false
};
function moduleChecks() {
  const db = snapshot(); db.company.contractValueTracking = true;
  db.catalog = [{ id: 1, name: 'Tile', category: 'Floors', unit: 'SF', targetHoursPerUnit: 0.125, description: '', createdAt: '2026-10-01T00:00:00.000Z' }];
  db.projects.push({ id: 102, name: 'Other project', estimateItems: [], secret: 'Private project evidence' });
  db.projects[0].estimateItems = [{ id: 4, name: 'Old scope', plannedQuantity: 2, unit: 'EA', budgetHours: 3, cost: 5 }];
  db.projects[0].rateSettingsHistory = [{ reason: 'Private historic rate', laborRate: 999 }];
  const create = op('catalogCreate', 'POST', '/api/catalog', { name: '  Tile trim ', unit: 'lf', category: '', targetHoursPerUnit: 0, description: '' });
  assert.deepEqual(create.details, { name: 'Tile trim', unit: 'LF', category: 'General', targetHoursPerUnit: 0, description: '' });
  const apply = op('catalogApply', 'POST', '/api/catalog/1/apply', { projectId: 101, plannedQuantity: 9 });
  const contract = op('projectContract', 'PATCH', '/api/projects/101', { contractValue: 1200.25 });
  assert.equal(family.route('PUT', '/api/projects/101'), 'projectContract');
  for (const route of ['/api/catalog/01/apply', '/api/catalog/1/apply?projectId=102', '/api/projects/101/archive', '/api/projects/101/estimate-items']) assert.equal(family.route('PATCH', route), null);
  for (const details of [{ name: 'Tile', unit: 'SF', permissions: { owner: true } }, { name: 'Tile', unit: 'SF', targetHoursPerUnit: '1' }, { name: 'Tile', unit: 'SF', targetHoursPerUnit: Infinity }, { name: 'Tile\u0000', unit: 'SF' }, { name: 'Tile', unit: 'SF', companyId: B }]) rejects(() => op('catalogCreate', 'POST', '/api/catalog', details), 400);
  for (const details of [{ projectId: '101', plannedQuantity: 1 }, { projectId: 101, plannedQuantity: 0 }, { projectId: 101, plannedQuantity: -1 }, { projectId: 101, plannedQuantity: 1, cost: 10 }]) rejects(() => op('catalogApply', 'POST', '/api/catalog/1/apply', details), 400);
  for (const details of [{ contractValue: '1200' }, { contractValue: NaN }, { contractValue: -1 }, { contractValue: 1, startDate: '2026-10-01' }, { contractValue: 1, budget: '$1' }]) rejects(() => op('projectContract', 'PUT', '/api/projects/101', details), 400);
  rejects(() => op('catalogApply', 'POST', '/api/catalog/9007199254740992/apply', { projectId: 101, plannedQuantity: 1 }), 400);
  rejects(() => family.parse({ ...create, reason: 'Injected' }, input), 400);
  for (const role of ['owner', 'admin', 'project_manager']) family.authorize(db, auth(role), create, h, input);
  for (const role of ['field', 'foreman', 'crew', 'platform_admin', 'office']) rejects(() => family.authorize(db, auth(role), create, h, input), 403);
  rejects(() => family.authorizeActor({ user: { ...auth('owner').user, status: 'Inactive' } }, create, input), 403);
  family.authorize(db, auth('project_manager'), apply, h, input);
  rejects(() => family.authorize(db, auth('project_manager'), { ...apply, details: { ...apply.details, projectId: 102 } }, h, input), 404);
  rejects(() => family.authorize(db, auth('project_manager'), apply, {}, input), 503);
  rejects(() => family.authorize(db, auth('project_manager'), contract, h, input), 403);
  for (const method of ['PATCH', 'PUT']) rejects(() => family.authorize({ ...db, company: { ...db.company, contractValueTracking: false } }, auth('owner'), { ...contract, method }, h, input), 409);
  rejects(() => family.authorize(db, auth('admin'), contract, { ...h, canViewPricing: () => false }, input), 403);
  const poisoned = structuredClone(db); poisoned.catalog.push({ ...poisoned.catalog[0] }); rejects(() => family.authorize(poisoned, auth('owner'), apply, h, input), 409);
  const huge = structuredClone(db); huge.catalog[0].targetHoursPerUnit = 1e12; rejects(() => family.authorize(huge, auth('owner'), apply, h, input), 400);

  const created = structuredClone(db); created.catalog.push({ id: 2, ...create.details, createdAt: '2026-10-02T00:00:00.000Z' });
  assert.deepEqual(family.validate(db, created, create, auth('owner'), h, input).data, created.catalog.at(-1));
  const applied = structuredClone(db); applied.projects[0].estimateItems.push({ id: 5, catalogItemId: 1, name: 'Tile', plannedQuantity: 9, unit: 'SF', budgetHours: 1.13, cost: 0 });
  const checked = family.validate(db, applied, apply, auth('project_manager'), h, input);
  assert.deepEqual(checked.retained.project, db.projects[0]); assert.deepEqual(checked.data, applied.projects[0].estimateItems.at(-1));
  const contracted = structuredClone(db); Object.assign(contracted.projects[0], { contractValue: 1200.25, budget: '$1,200.25' });
  for (const method of ['PATCH', 'PUT']) { const result = family.validate(db, contracted, { ...contract, method }, auth('admin'), h, input); assert.equal(result.data.contractValue, 1200.25); assert.equal(result.data.rateSettingsHistory, undefined); assert.deepEqual(result.retained.project.rateSettingsHistory, db.projects[0].rateSettingsHistory); }
  for (const mutation of [next => next.users[0].role = 'admin', next => next.catalog[0].description = 'Unexpected mutation', next => next.projects[1].name = 'Changed foreign project', next => next.projects.push(structuredClone(next.projects[0])), next => next.projects.reverse(), next => next.projects[0].rateSettingsHistory[0].laborRate = 1, next => next.projects[0].estimateItems[0].cost = 0, next => next.projects[0].estimateItems.at(-1).cost = 100]) {
    const bad = structuredClone(applied); mutation(bad); rejects(() => family.validate(db, bad, apply, auth('owner'), h, input), 409);
  }
  const receipt = { id: 'technical-receipt', operation: apply, result: checked.data };
  const fresh = structuredClone(applied); fresh.projects[0].estimateItems.at(-1).name = 'Fresh current title'; fresh.projects[0].estimateItems.at(-1).secret = 'Do not project';
  const current = family.currentResult(fresh, auth('project_manager'), receipt, false, h, input);
  assert.equal(current.name, 'Fresh current title'); assert.equal(current.secret, undefined);
  assert.equal(family.currentResult(fresh, { user: { ...auth('project_manager').user, projectIds: [102] } }, receipt, false, h, input).name, undefined);
  assert.equal(family.currentResult(fresh, auth('project_manager'), receipt, false, { ...h, canViewPricing: () => false }, input).cost, undefined);
  fresh.projects[0].estimateItems.at(-1).catalogItemId = 2;
  assert.deepEqual(family.currentResult(fresh, auth('project_manager'), receipt, false, h, input), { id: 5, receiptId: 'technical-receipt' });
  const catalogReceipt = { id: 'catalog-receipt', operation: create, result: created.catalog.at(-1) };
  created.catalog.at(-1).description = 'Fresh description'; created.catalog.at(-1).privateAudit = 'Hidden';
  assert.equal(family.currentResult(created, auth('admin'), catalogReceipt, false, h, input).privateAudit, undefined);
  created.catalog.at(-1).createdAt = '2026-10-03T00:00:00.000Z';
  // Use a separate immutable receipt; readback never borrows historical values.
  catalogReceipt.result = { ...catalogReceipt.result, createdAt: '2026-10-02T00:00:00.000Z' };
  assert.deepEqual(family.currentResult(created, auth('admin'), catalogReceipt, false, h, input), { id: 2, receiptId: 'catalog-receipt' });
  const contractReceipt = { id: 'contract-receipt', operation: contract, result: { id: 101, contractValue: 1200.25 } };
  contracted.projects[0].contractValue = 9999;
  assert.equal(family.currentResult(contracted, auth('admin'), contractReceipt, false, h, input).contractValue, 9999);
  contracted.company.contractValueTracking = false;
  assert.deepEqual(family.currentResult(contracted, auth('admin'), contractReceipt, false, h, input), { id: 101, receiptId: 'contract-receipt' });
  console.log('catalog/contract module: closed payloads, fixed roles, current PM scope, pricing/tracking gates, exact compound deltas, retained history and fresh finite readback passed');
}

async function httpChecks() {
  assert.equal(input.route('POST', '/api/catalog'), 'catalogCreate', 'Install the finite catalog/contract dispatcher before running the HTTP integration.');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-catalog-contract-synthetic-'));
  for (const name of ['OPENAI_API_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'SENTRY_DSN', 'SUPABASE_SECRET_KEY', 'PDL_PLATFORM_KEY']) process.env[name] = '';
  for (const name of ['PDL_COMPAT_GLOBAL_FENCE_FILE', 'DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']) delete process.env[name];
  const legacy = snapshot(); legacy.company.id = B; legacy.users[0].companyId = B;
  const file = path.join(directory, 'legacy.json'); fs.writeFileSync(file, JSON.stringify(legacy)); const oldBytes = fs.readFileSync(file);
  Object.assign(process.env, { NODE_ENV: 'test', PDL_COMPAT_ACCOUNT_SYNTHETIC: '1', PDL_REQUIRE_AUTH: '1', PDL_DB_FILE: file, PDL_PLATFORM_FILE: path.join(directory, 'platform.json'), PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_WEEKLY_DIGEST: '0' });
  const mod = require('./server'); await new Promise(resolve => mod.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + mod.server.address().port, seed = snapshot(); seed.team[0].crew = 'Office'; seed.company.contractValueTracking = true;
  seed.company.pricingAccess = { enabled: true, officeMode: 'all', userIds: [] };
  seed.projects[0].budget = '$1,000'; seed.projects[0].contractValue = 1000; seed.projects[0].rateSettingsHistory = [{ reason: 'Synthetic historic pricing', laborRate: 123 }];
  seed.projects.push({ id: 102, name: 'Synthetic unassigned destination', estimateItems: [] });
  for (const [id, role] of [[2, 'admin'], [3, 'project_manager'], [4, 'foreman'], [5, 'field']]) { seed.users.push({ id, companyId: A, memberId: id + 10, name: 'Synthetic ' + role, email: role + '@example.invalid', status: 'Active', role, ...credential(initial), projectIds: [101], assignedCrews: ['North'], permissions: { viewTime: true, manageTime: true, scheduleCrews: true, viewDailies: true, approveDailies: true } }); seed.team.push({ id: id + 10, name: 'Synthetic ' + role, crew: role === 'admin' ? 'Office' : 'North', role: 'Synthetic employee', initials: 'SE', hours: 0 }); }
  const store = memory(seed), key = crypto.randomBytes(32), fixture = services(store, origin, { key });
  const uninstall = mod.installCompatibilityAccountTests({ synthetic: true, companyId: A, origin, globalOrigin: 'http://localhost:4999', repository: store, ...fixture, workspace: true, workspaceKey: key });
  const tokens = {}; let checks = 0;
  const request = async (route, { method = 'GET', data, token = tokens.owner, tenant = A } = {}) => { const response = await fetch(origin + route, { method, headers: { 'X-PDL-Company': tenant, ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }); checks++; return { status: response.status, value: await response.json(), response }; };
  const identity = async token => { const result = await request('/api/workspace-identity', { token }); assert.equal(result.status, 200, JSON.stringify(result.value)); return result.value; };
  const preview = async (operation, token = tokens.owner) => request('/api/resources/preview', { method: 'POST', token, data: { operation, expectedRevision: (await identity(token)).revision, reason: 'Synthetic catalog/contract review' } });
  const save = async (operation, token = tokens.owner) => { const reviewed = await preview(operation, token); assert.equal(reviewed.status, 200, JSON.stringify(reviewed.value)); const proof = { token: reviewed.value.token, version: reviewed.value.version, confirmed: true, requestId: crypto.randomUUID() }; const saved = await request(operation.path, { method: operation.method, token, data: proof }); assert.ok([200, 201].includes(saved.status), JSON.stringify(saved.value)); return { saved, proof, reviewed }; };
  const mutate = async change => { const loaded = await store.load(A); change(loaded.snapshot); await store.commit(loaded.snapshot, loaded.revision); };
  try {
    for (const role of ['owner', 'admin', 'project_manager', 'foreman', 'field']) { const login = await request('/api/auth/login', { method: 'POST', token: null, data: { email: role + '@example.invalid', password: initial } }); assert.equal(login.status, 200, JSON.stringify(login.value)); tokens[role] = login.value.token; }
    const create = op('catalogCreate', 'POST', '/api/catalog', { name: 'Synthetic tile', unit: 'sf', targetHoursPerUnit: 0.125 });
    assert.equal((await request('/api/catalog', { method: 'POST', data: create.details })).status, 400);
    for (const role of ['foreman', 'field']) assert.equal((await preview(create, tokens[role])).status, 403);
    for (const role of ['owner', 'admin', 'project_manager']) { const item = await save({ ...create, details: { ...create.details, name: 'Synthetic tile ' + role } }, tokens[role]); assert.equal(item.saved.value.unit, 'SF'); assert.ok(item.saved.response.headers.get('X-PDL-Resource-Receipt')); }
    const apply = op('catalogApply', 'POST', '/api/catalog/1/apply', { projectId: 101, plannedQuantity: 9 });
    const beforePreview = canonicalHash(store.current().projects);
    const scoped = await preview(apply, tokens.project_manager); assert.equal(scoped.status, 200, JSON.stringify(scoped.value)); assert.equal(canonicalHash(store.current().projects), beforePreview);
    assert.equal((await preview({ ...apply, details: { ...apply.details, projectId: 102 } }, tokens.project_manager)).status, 404);
    assert.equal((await preview({ ...apply, path: '/api/catalog/999/apply' }, tokens.project_manager)).status, 404);
    assert.equal((await preview({ ...apply, details: { ...apply.details, projectId: 999 } })).status, 404);
    const originalHistory = structuredClone(store.current().projects[0].rateSettingsHistory);
    const applied = await save(apply, tokens.project_manager); assert.equal(applied.saved.status, 201); assert.equal(applied.saved.value.budgetHours, 1.13); assert.equal(applied.saved.value.catalogItemId, 1);
    const count = store.current().projects[0].estimateItems.length, revision = store.revision();
    assert.equal((await request(apply.path, { method: 'POST', data: applied.proof, token: tokens.project_manager })).status, applied.saved.status);
    assert.equal(store.current().projects[0].estimateItems.length, count); assert.equal(store.revision(), revision);
    await mutate(db => { db.company.pricingAccess.enabled = false; });
    const noPricing = await save(apply, tokens.project_manager); assert.equal(noPricing.saved.value.cost, undefined); assert.equal(noPricing.reviewed.value.proposed.cost, undefined); assert.equal(noPricing.saved.value.budgetHours, 1.13);
    await mutate(db => { db.company.pricingAccess.enabled = true; });
    for (const method of ['PATCH', 'PUT']) { const contract = op('projectContract', method, '/api/projects/101', { contractValue: method === 'PATCH' ? 1500.25 : 2500 }); const saved = await save(contract, tokens.admin); assert.equal(saved.saved.value.contractValue, contract.details.contractValue); assert.equal(saved.saved.value.rateSettingsHistory, undefined); assert.deepEqual(store.current().projects[0].rateSettingsHistory, originalHistory); assert.equal((await preview(contract, tokens.project_manager)).status, 403); }
    await mutate(db => { db.company.contractValueTracking = false; });
    for (const method of ['PATCH', 'PUT']) assert.equal((await preview(op('projectContract', method, '/api/projects/101', { contractValue: 9000 }))).status, 409);
    await mutate(db => { db.company.contractValueTracking = true; });
    const revoked = await preview(apply, tokens.project_manager); assert.equal(revoked.status, 200);
    const revokedProof = { token: revoked.value.token, version: revoked.value.version, confirmed: true, requestId: crypto.randomUUID() };
    await mutate(db => { db.users.find(user => user.id === 3).projectIds = [102]; });
    const oldProjects = canonicalHash(store.current().projects);
    assert.equal((await request(apply.path, { method: 'POST', data: revokedProof, token: tokens.project_manager })).status, 409); assert.equal(canonicalHash(store.current().projects), oldProjects);
    await mutate(db => { db.users.find(user => user.id === 3).projectIds = [101]; });
    const lost = await preview(apply, tokens.project_manager); assert.equal(lost.status, 200);
    const lostProof = { token: lost.value.token, version: lost.value.version, confirmed: true, requestId: crypto.randomUUID() }; store.loseCommitAck = true;
    assert.equal((await request(apply.path, { method: 'POST', data: lostProof, token: tokens.project_manager })).status, 503);
    const savedCount = store.current().projects[0].estimateItems.length, lookup = { token: lostProof.token, version: lostProof.version, requestId: lostProof.requestId, method: 'POST', path: apply.path };
    await mutate(db => { db.users.find(user => user.id === 3).projectIds = [102]; });
    const outcome = await request('/api/resources/original-result', { method: 'POST', token: tokens.project_manager, data: lookup }); assert.equal(outcome.status, 200, JSON.stringify(outcome.value)); assert.equal(outcome.value.receipt.status, 'committed'); assert.equal(outcome.value.name, undefined); assert.equal(store.current().projects[0].estimateItems.length, savedCount);
    const newLogin = await request('/api/auth/login', { method: 'POST', token: null, data: { email: 'project_manager@example.invalid', password: initial } }); assert.equal(newLogin.status, 200);
    assert.equal((await request('/api/resources/original-result', { method: 'POST', token: newLogin.value.token, data: lookup })).status, 409);
    assert.equal((await request('/api/resources/preview', { method: 'POST', tenant: B, data: {} })).status, 404);
    const malformed = { ...create, details: { ...create.details, companyId: B } }; assert.equal((await preview(malformed)).status, 400);
    const state = await request('/api/state'); assert.equal(state.status, 200); for (const name of ['resourcePreviews', 'resourceReceipts']) assert.equal(JSON.stringify(state.value).includes('"' + name + '"'), false);
    assert.deepEqual(fs.readFileSync(file), oldBytes);
    console.log(`catalog/contract HTTP: ${checks} requests, four named writers, PM destination scope, tracking parity, preview/replay/revocation/lost-ACK/private lookup and unchanged legacy bytes passed`);
  } finally { uninstall(); await new Promise(resolve => mod.server.close(resolve)); }
}

moduleChecks(); httpChecks().catch(error => { console.error(error); process.exitCode = 1; });
