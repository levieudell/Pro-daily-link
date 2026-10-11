'use strict';
// Actual existing manual routes + signed preview/confirm + explicit memory
// repository. Owned localhost, synthetic records, no .env/provider/PG/browser.
const assert = require('node:assert/strict');
const crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { A, B, initial, credential, snapshot, memory } = require('./compat-account-fixture');
const { services } = require('./compat-lifecycle-fixture');
const { canonicalHash } = require('./database/transactional-repository');
const daily = require('./daily-access');
const { execFileSync } = require('node:child_process');
const sourceNames = ['server.js', 'resource-estimates.js', 'resource-estimates.test.js', 'resource-estimates-http.test.js', 'resource-inputs.js', 'resource-admission.js', 'resource-deltas.js', 'compat-workspace.js', 'compat-workspace-routes.js'];
const sourceHashes = () => Object.fromEntries(sourceNames.map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, name))).digest('hex')]));
const operation = (kind, method, route, details) => ({ kind, method, path: route, details });
const business = db => canonicalHash(Object.fromEntries(['company', 'users', 'projects', 'team', 'reports', 'workdays', 'timeCards', 'assignments', 'catalog', 'estimateImports'].map(key => [key, db[key] || []])));
async function main() {
  const startingSourceHashes = sourceHashes(), sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, encoding: 'utf8' }).trim();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-estimates-http-synthetic-')), file = path.join(directory, 'legacy.json'), platform = path.join(directory, 'platform.json');
  const legacy = snapshot(); legacy.company.id = B; legacy.users[0].companyId = B;
  fs.writeFileSync(file, JSON.stringify(legacy)); fs.writeFileSync(platform, JSON.stringify({ users: [], sessions: [] }));
  const legacyBytes = fs.readFileSync(file), platformBytes = fs.readFileSync(platform);
  for (const name of ['OPENAI_API_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SENTRY_DSN', 'SUPABASE_SECRET_KEY', 'PDL_PLATFORM_KEY']) process.env[name] = '';
  for (const name of ['PDL_COMPAT_GLOBAL_FENCE_FILE', 'DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']) delete process.env[name];
  Object.assign(process.env, { NODE_ENV: 'test', PDL_COMPAT_ACCOUNT_SYNTHETIC: '1', PDL_REQUIRE_AUTH: '1', PDL_DB_FILE: file, PDL_PLATFORM_FILE: platform, PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_WEEKLY_DIGEST: '0' });
  require('./database/supabase').loadLocalEnv = () => {};
  const realFetch = global.fetch; let origin, external = 0;
  global.fetch = (url, options) => { if (!origin || new URL(url).origin !== origin) { external++; throw Error('External fetch forbidden in manual estimate fixture.'); } return realFetch(url, options); };
  const seed = snapshot(), now = '2026-10-11T08:00:00.000Z'; seed.team[0].crew = 'Office'; seed.company.pricingAccess = { enabled: true, officeMode: 'all', userIds: [] };
  seed.projects[0].estimateItems = [{ id: 1, name: 'Synthetic retained linked scope', plannedQuantity: 10, unit: 'SF', budgetHours: null, cost: null }];
  seed.projects[0].estimateProposals = [{ id: 4, name: 'Synthetic original proposal', plannedQuantity: 5, unit: 'LF', sourceFile: null, createdAt: now, createdBy: 'Synthetic field', status: 'Needs office review' }];
  seed.projects.push({ id: 102, name: 'Synthetic unassigned project', status: 'Active', estimateItems: [], estimateProposals: [] });
  for (const [id, role] of [[2, 'admin'], [3, 'project_manager'], [4, 'foreman'], [5, 'field']]) {
    seed.users.push({ id, companyId: A, memberId: id + 10, name: 'Synthetic ' + role, email: role + '@example.invalid', status: 'Active', role, ...credential(initial), projectIds: [101], assignedCrews: ['North'], permissions: { scheduleCrews: true, viewTime: true, manageTime: true, viewDailies: true, approveDailies: true } });
    seed.team.push({ id: id + 10, name: 'Synthetic ' + role, crew: role === 'admin' ? 'Office' : 'North', role: 'Synthetic Mason', initials: 'SY', hours: 0 });
  }
  seed.crews = [{ id: 1, name: 'North' }];
  seed.assignments = [{ id: 1, projectId: 101, memberIds: [15], crew: 'North', date: '2026-10-11', start: '07:00', end: '15:00', activity: 'Synthetic manual work' }];
  seed.reports = [{ id: 1, project: 0, status: 'Approved', dateIso: '2026-10-11', foreman: 'Synthetic project_manager', notes: 'Synthetic approved work', laborEntries: [{ memberId: 13, hours: 2, crew: 'North' }], productionEntries: [{ estimateItemId: 1, quantity: 1 }], history: [{ action: 'Approved', by: 'Synthetic Owner', at: now }] }];
  seed.catalog = [{ id: 10, name: 'Synthetic wall tile', category: 'Tile', unit: 'SF', targetHoursPerUnit: 0.125, description: 'Synthetic matching tile', createdAt: now }];
  seed.estimateImports = [
    { id: 7, filename: 'Synthetic stored.pdf', url: '/uploads/estimates/synthetic-stored.pdf', createdAt: now, createdByUserId: 3, projectId: 101, status: 'Draft', lines: [{ description: 'Synthetic wall tile', quantity: 10, unit: 'SF', amount: null }], textPreview: 'Private synthetic PDF text' },
    { id: 8, filename: 'Synthetic foreign.pdf', url: '/uploads/estimates/synthetic-foreign.pdf', createdAt: now, createdByUserId: 1, projectId: 102, status: 'Draft', lines: [] },
    { id: 9, filename: 'Synthetic unassigned.pdf', url: '/uploads/estimates/synthetic-unassigned.pdf', createdAt: now, createdByUserId: 1, status: 'Draft', lines: [] }
  ];
  const store = memory(seed), key = crypto.randomBytes(32), tokens = {}, checks = [], signatures = [];
  const actualWrite = fs.writeFileSync, uploadRoot = path.resolve(__dirname, 'uploads'); let physicalWrites = 0;
  fs.writeFileSync = (target, ...args) => { if (typeof target === 'string' && path.resolve(target).startsWith(uploadRoot + path.sep)) { physicalWrites++; throw Error('This manual estimate process cannot write uploaded bytes.'); } return actualWrite(target, ...args); };
  let mod, uninstall, httpRequests = 0;
  async function request(route, method = 'GET', data, token = tokens.owner, tenant = A) {
    const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(10000), headers: { 'X-PDL-Company': tenant, ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
    httpRequests++; return { status: response.status, data: await response.json(), headers: Object.fromEntries(response.headers) };
  }
  async function mutate(change) { const current = await store.load(A); change(current.snapshot); await store.commit(current.snapshot, current.revision); }
  function privateCheck(data) { for (const field of ['resourcePreviews', 'resourceReceipts', 'resourceReconciliations', 'retained', 'tokenHash', 'passwordHash', 'sessionHash', 'sessionBinding', 'textPreview']) assert.equal(JSON.stringify(data).includes('"' + field + '"'), false, 'Private field leaked: ' + field); }
  async function preview(op, token = tokens.owner) {
    const identity = await request('/api/workspace-identity', 'GET', undefined, token); assert.equal(identity.status, 200, JSON.stringify(identity));
    return request('/api/resources/preview', 'POST', { operation: op, expectedRevision: identity.data.revision, reason: 'Synthetic manual estimate permission compatibility review' }, token);
  }
  const proof = result => ({ token: result.data.token, version: result.data.version, confirmed: true, requestId: crypto.randomUUID() });
  const confirm = (op, data, token = tokens.owner) => request(op.path, op.method, data, token);
  async function denied(op, token, statuses = [403, 404]) {
    const before = canonicalHash(store.current()), revision = store.revision(), result = await preview(op, token);
    assert.ok(statuses.includes(result.status), JSON.stringify(result)); assert.equal(canonicalHash(store.current()), before); assert.equal(store.revision(), revision);
  }
  async function save(op, token = tokens.owner) {
    const before = business(store.current()), p = await preview(op, token); assert.equal(p.status, 200, JSON.stringify(p)); assert.equal(business(store.current()), before); privateCheck(p.data);
    const e = proof(p), revision = store.revision(); assert.equal((await confirm(op, { ...e, confirmed: false }, token)).status, 400); assert.equal(store.revision(), revision);
    const result = await confirm(op, e, token); assert.ok([200, 201].includes(result.status), JSON.stringify(result)); privateCheck(result.data); assert.ok(result.headers['x-pdl-resource-receipt']);
    assert.ok(store.current().resourceReceipts.some(row => row.requestId === e.requestId && row.operation.kind === op.kind));
    assert.ok(store.current().auditLog.some(row => row.type === 'resource_changed' && row.requestId === e.requestId)); signatures.push(op.method + ' ' + op.path.replace(/\/\d+/g, '/:id'));
    return { p, e, result };
  }
  try {
    mod = require('./server'); await new Promise(resolve => mod.server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + mod.server.address().port;
    const fixture = services(store, origin, { key });
    const install = () => mod.installCompatibilityAccountTests({ synthetic: true, companyId: A, origin, globalOrigin: 'http://localhost:4999', repository: store, ...fixture, workspace: true, workspaceKey: key }); uninstall = install();
    for (const role of ['owner', 'admin', 'project_manager', 'foreman', 'field']) { const login = await request('/api/auth/login', 'POST', { email: role + '@example.invalid', password: initial }, null); assert.equal(login.status, 200, JSON.stringify(login)); tokens[role] = login.data.token; }
    const create = operation('estimateItemCreate', 'POST', '/api/projects/101/estimate-items', { name: 'Synthetic manual scope', plannedQuantity: 10, unit: 'SF', budgetHours: null, cost: 25 });
    assert.equal((await confirm(create, create.details)).status, 400);
    const created = await save(create), id = created.result.data.id; assert.equal(created.result.data.budgetHours, null);
    await save(operation('estimateItemEdit', 'PATCH', '/api/projects/101/estimate-items/' + id, { plannedQuantity: 12, budgetHours: 0, cost: 10.129 }), tokens.admin);
    assert.equal(store.current().projects[0].estimateItems.find(row => row.id === id).cost, 10.13);
    await save(operation('estimateItemEdit', 'PUT', '/api/projects/101/estimate-items/' + id, { unit: 'LF', budgetHours: null }));
    await save(operation('estimateItemRemove', 'DELETE', '/api/projects/101/estimate-items/' + id, {})); assert.equal(store.current().projects[0].estimateItems.some(row => row.id === id), false);
    await save(operation('estimateProposalCreate', 'POST', '/api/projects/101/estimate-proposals', { name: 'Synthetic field manual scope', plannedQuantity: 5, unit: 'sf' }), tokens.field);
    const proposed = await save(operation('estimateProposalApprove', 'POST', '/api/projects/101/estimate-proposals/4/approve', {}), tokens.project_manager);
    assert.equal(proposed.result.data.item.sourceProposalId, 4); assert.equal(proposed.result.data.item.budgetHours, null);
    const draft = operation('estimateImportDraft', 'PATCH', '/api/estimate-imports/7/draft', { projectId: 101, lines: [{ description: 'Synthetic reviewed wall tile', quantity: null, unit: '', amount: null, budgetHours: null, catalogItemId: 10 }] });
    await save(draft, tokens.project_manager);
    const savedDrafts = await request('/api/estimate-imports?projectId=101', 'GET', undefined, tokens.project_manager); assert.equal(savedDrafts.status, 200, JSON.stringify(savedDrafts)); privateCheck(savedDrafts.data); assert.equal(savedDrafts.data.length, 1); assert.equal(savedDrafts.data[0].reviewedLines[0].quantity, null);
    const imported = operation('estimateImportApprove', 'POST', '/api/estimate-imports/7/approve', { projectId: 101, lines: [{ description: 'Synthetic wall tile', quantity: 10, unit: 'SF', amount: null, catalogItemId: 10, budgetHours: null }, { description: 'Synthetic zero budget', quantity: 1, unit: 'EA', amount: 0, budgetHours: 0 }] });
    const approved = await save(imported, tokens.project_manager); assert.deepEqual(approved.result.data.items.map(row => row.budgetHours), [null, 0]); assert.deepEqual(approved.result.data.items.map(row => row.cost), [null, 0]);
    checks.push('All eight manual writer signatures execute actual handlers only after signed preview and explicit confirmation; IDs/source bindings/history, null/zero budgets and unknown costs retained');
    await denied(imported, tokens.project_manager, [409]);
    await denied(operation('estimateItemRemove', 'DELETE', '/api/projects/101/estimate-items/1', {}), tokens.admin, [409]);
    await denied(operation('estimateItemEdit', 'PATCH', '/api/projects/101/estimate-items/1', { name: 'Denied field edit' }), tokens.field);
    await denied({ ...create, path: '/api/projects/102/estimate-items' }, tokens.project_manager);
    await denied({ ...draft, path: '/api/estimate-imports/8/draft' }, tokens.project_manager);
    await denied({ ...draft, path: '/api/estimate-imports/9/draft' }, tokens.project_manager);
    await denied({ ...draft, details: { ...draft.details, projectId: 102 } }, tokens.project_manager);
    await denied({ ...create, details: { ...create.details, companyId: B } }, tokens.owner, [400]);
    await denied({ ...draft, path: '/api/estimate-imports/9/draft', details: { ...draft.details, lines: [{ description: 'Rejected catalog binding', quantity: 1, unit: 'SF', catalogItemId: 999 }] } }, tokens.owner, [404]);
    await denied({ ...draft, details: { ...draft.details, lines: [{ ...draft.details.lines[0], confidence: 'high', catalogSuggestions: [] }] } }, tokens.owner, [400]);
    await denied(operation('estimateProposalCreate', 'POST', '/api/projects/101/estimate-proposals', { name: 'Rejected PDF', plannedQuantity: 1, data: 'data:application/pdf;base64,eA==' }), tokens.field, [400]);
    assert.equal((await request('/api/estimate-imports/analyze', 'POST', { data: 'data:application/pdf;base64,eA==' })).status, 503);
    assert.equal((await request('/api/estimate-imports?projectId=102', 'GET', undefined, tokens.project_manager)).status, 404);
    assert.equal((await request('/api/estimate-imports?projectId=101', 'GET', undefined, tokens.field)).status, 403);
    assert.equal((await request('/api/estimate-imports?projectId=101', 'GET', undefined, tokens.owner, B)).status, 404);
    checks.push('Strict source/project/creator/catalog/role/pricing boundaries; duplicate approval and historical report references protected; PDF/provider paths remain fenced');
    await mutate(db => { db.company.dailyPolicyRequired = true; db.company.dailyRolePolicy = { version: 1, revision: 1, roles: Object.fromEntries(daily.roles.map(role => [role, Object.fromEntries(daily.actions.map(action => [action, false]))])) }; });
    const independent = await save({ ...create, details: { ...create.details, name: 'Independent financial scope' } }, tokens.project_manager); assert.equal(independent.result.data.name, 'Independent financial scope');
    await mutate(db => { db.company.pricingAccess.enabled = false; });
    await denied({ ...draft, path: '/api/estimate-imports/9/draft' }, tokens.project_manager, [403]);
    const noPricing = await save({ ...create, details: { name: 'Synthetic nonpricing zero cost', plannedQuantity: 1, budgetHours: 0, cost: 0 } }, tokens.field); assert.equal(Object.hasOwn(noPricing.result.data, 'cost'), false);
    await denied({ ...create, details: { name: 'Synthetic nonpricing attempted cost', plannedQuantity: 1, cost: 1 } }, tokens.field, [403]);
    checks.push('Editable daily masks do not revoke or broaden independent financial/library authority; field/nonpricing costs redacted and financial writes denied');
    await mutate(db => { db.company.pricingAccess.enabled = true; });
    const pending = await preview({ ...create, details: { ...create.details, name: 'Synthetic revoked source scope' } }, tokens.project_manager); assert.equal(pending.status, 200, JSON.stringify(pending));
    await mutate(db => { db.users.find(row => row.role === 'project_manager').projectIds = [102]; });
    const revokedBefore = business(store.current()), revoked = await confirm({ ...create, details: { ...create.details, name: 'Synthetic revoked source scope' } }, proof(pending), tokens.project_manager); assert.ok([403, 404, 409].includes(revoked.status), JSON.stringify(revoked)); assert.equal(business(store.current()), revokedBefore);
    await mutate(db => { db.users.find(row => row.role === 'project_manager').projectIds = [101]; });
    const adminChange = operation('estimateItemEdit', 'PATCH', '/api/projects/101/estimate-items/1', { name: 'Synthetic revoked account edit' }), adminPreview = await preview(adminChange, tokens.admin);
    assert.equal(adminPreview.status, 200, JSON.stringify(adminPreview));
    await mutate(db => { db.users.find(row => row.role === 'admin').status = 'Inactive'; });
    const beforeInactive = business(store.current()), inactive = await confirm(adminChange, proof(adminPreview), tokens.admin); assert.ok([401, 403].includes(inactive.status), JSON.stringify(inactive)); assert.equal(business(store.current()), beforeInactive);
    await mutate(db => { db.users.find(row => row.role === 'admin').status = 'Active'; });
    const unknownOp = { ...create, details: { ...create.details, name: 'Synthetic lost acknowledgement' } }, unknownPreview = await preview(unknownOp), envelope = proof(unknownPreview); assert.equal(unknownPreview.status, 200, JSON.stringify(unknownPreview));
    store.loseCommitAck = true; const unknown = await confirm(unknownOp, envelope); assert.equal(unknown.status, 503, JSON.stringify(unknown)); const committed = store.revision(), itemsCount = store.current().projects[0].estimateItems.length;
    uninstall(); uninstall = install(); const recovered = await confirm(unknownOp, envelope); assert.equal(recovered.status, 201, JSON.stringify(recovered)); assert.equal(store.revision(), committed); assert.equal(store.current().projects[0].estimateItems.length, itemsCount); assert.equal(Object.hasOwn(recovered.data, 'name'), false); assert.equal(Object.hasOwn(recovered.data, 'cost'), false);
    const recoveryRequest = { requestId: envelope.requestId, token: envelope.token, version: envelope.version, method: unknownOp.method, path: unknownOp.path };
    const recoveredStatus = await request('/api/resources/original-result', 'POST', recoveryRequest); assert.equal(recoveredStatus.status, 200, JSON.stringify(recoveredStatus)); assert.equal(store.revision(), committed);
    checks.push('Fresh source scope revocation rejects pending proof; committed lost acknowledgement recovers after restart with technical-only original receipt and no repeated write');
    assert.equal(new Set(signatures).size, 8); assert.equal(external, 0); assert.deepEqual(fs.readFileSync(file), legacyBytes); assert.deepEqual(fs.readFileSync(platform), platformBytes);
    assert.equal(physicalWrites, 0, 'No physical upload write was attempted by this owned process');
    const endingSourceHashes = sourceHashes(); assert.deepEqual(endingSourceHashes, startingSourceHashes, 'Named source unchanged during this proof');
    const evidence = { backend: 'synthetic-memory', sourceHead, startingSourceHashes, endingSourceHashes, writerSignatures: [...new Set(signatures)], checks, httpRequests, externalRequests: external, physicalFilesCreated: 0, passed: true, productionReady: false };
    if (process.env.PDL_ESTIMATES_EVIDENCE) fs.writeFileSync(process.env.PDL_ESTIMATES_EVIDENCE, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
  } finally {
    uninstall?.(); if (mod) { mod.server.closeAllConnections(); await new Promise(resolve => mod.server.close(resolve)); } global.fetch = realFetch; fs.writeFileSync = actualWrite;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
