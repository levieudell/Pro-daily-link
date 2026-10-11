'use strict';
// Actual report/rate handlers behind the current signed resource boundary.
// Owned localhost + memory tenant + synthetic bytes only; no .env/provider/PG/browser.
const assert = require('node:assert/strict');
const crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { A, B, initial, credential, snapshot, memory } = require('./compat-account-fixture');
const { services } = require('./compat-lifecycle-fixture');
const { canonicalHash } = require('./database/transactional-repository');
const daily = require('./daily-access'), reportRates = require('./report-rate-policy');
const op = (kind, method, route, details) => ({ kind, method, path: route, details });
const business = db => canonicalHash(Object.fromEntries(['company', 'users', 'projects', 'team', 'reports', 'changes', 'photos', 'workdays', 'timeCards', 'assignments', 'projectTickets'].map(key => [key, db[key] || []])));
const dailyPolicy = () => ({ version: 1, revision: 1, roles: Object.fromEntries(daily.roles.map(role => [role, daily.ceiling(role)])) });
const row = (id, status, project, members, extra = {}) => ({ id, status, project, date: 'Oct 1', dateIso: '2026-10-01', foreman: 'Synthetic PM', notes: 'Synthetic report ' + id, summary: 'Synthetic scope ' + id + ((extra.flags || []).some(flag => flag.type === 'unplanned_work' && !flag.resolution) ? ' Unplanned work needs an office decision.' : ''), laborEntries: members.map(([memberId, hours]) => ({ memberId, hours, crew: memberId === 99 ? 'Hidden crew' : 'North' })), productionEntries: [], flags: [], history: [{ action: status === 'Approved' ? 'Approved' : 'Submitted', by: 'Synthetic Owner', at: '2026-10-01T12:00:00.000Z' }], ...extra });
const rate = laborRate => ({ schemaVersion: 1, laborRate, materialMarkup: 10, equipmentMarkup: 5, capturedAt: '2026-10-01T12:00:00.000Z', capturedBy: { id: 1, name: 'Synthetic Owner', role: 'owner' }, source: 'first-office-approval' });
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-report-variants-http-synthetic-'));
  const file = path.join(dir, 'legacy.json'), platformFile = path.join(dir, 'platform.json');
  const legacy = snapshot(); legacy.company.id = B; legacy.users[0].companyId = B;
  fs.writeFileSync(file, JSON.stringify(legacy)); fs.writeFileSync(platformFile, JSON.stringify({ users: [], sessions: [] }));
  const legacyBytes = fs.readFileSync(file), platformBytes = fs.readFileSync(platformFile);
  for (const name of ['OPENAI_API_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SENTRY_DSN', 'SUPABASE_SECRET_KEY', 'PDL_PLATFORM_KEY']) process.env[name] = '';
  for (const name of ['PDL_COMPAT_GLOBAL_FENCE_FILE', 'DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']) delete process.env[name];
  Object.assign(process.env, { NODE_ENV: 'test', PDL_COMPAT_ACCOUNT_SYNTHETIC: '1', PDL_REQUIRE_AUTH: '1', PDL_DB_FILE: file, PDL_PLATFORM_FILE: platformFile, PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_WEEKLY_DIGEST: '0' });
  require('./database/supabase').loadLocalEnv = () => {};
  const realFetch = global.fetch, realNow = Date.now;
  let origin, externalCalls = 0;
  global.fetch = (url, options) => { if (!origin || new URL(url).origin !== origin) { externalCalls++; throw Error('External fetch forbidden in report variant fixture.'); } return realFetch(url, options); };
  const ownedFilename = 'synthetic-report-variants-' + crypto.randomUUID() + '.png';
  const ownedFile = path.join(__dirname, 'uploads', ownedFilename), ownedBytes = Buffer.from('Synthetic retained report photo bytes\0' + crypto.randomUUID());
  fs.mkdirSync(path.dirname(ownedFile), { recursive: true }); fs.writeFileSync(ownedFile, ownedBytes, { flag: 'wx' });
  const seed = snapshot(); seed.team[0].crew = 'Office'; seed.company.pricingAccess = { enabled: true, officeMode: 'all', userIds: [] };
  seed.projects[0].contractType = 'tm'; seed.projects[0].tmSettings = { defaultLaborRate: 100, materialMarkup: 10, equipmentMarkup: 5 };
  seed.projects.push({ id: 102, name: 'Foreign scoped synthetic project', code: 'SYN2', status: 'Active', estimateItems: [], contractType: 'tm', tmSettings: { defaultLaborRate: 125, materialMarkup: 0, equipmentMarkup: 0 } });
  for (const [id, role] of [[2, 'admin'], [3, 'project_manager'], [4, 'foreman'], [5, 'field']]) {
    seed.users.push({ id, companyId: A, memberId: id + 10, name: 'Synthetic ' + role, email: role + '@example.invalid', status: 'Active', role, ...credential(initial), projectIds: [101], assignedCrews: ['North'], permissions: { scheduleCrews: true, viewTime: true, manageTime: true, viewDailies: true, approveDailies: true } });
    seed.team.push({ id: id + 10, name: 'Synthetic ' + role, crew: role === 'admin' ? 'Office' : 'North', role: 'Visible labor', initials: 'SY', hours: 0 });
  }
  seed.team.push({ id: 99, name: 'Hidden synthetic member', crew: 'Hidden crew', role: 'Hidden synthetic classification', initials: 'HS', hours: 0 });
  seed.crews = [{ id: 1, name: 'North' }, { id: 2, name: 'Hidden crew' }];
  seed.reports = [
    row(1, 'Needs review', 0, [[13, 4]], { flags: [{ type: 'unplanned_work', message: 'Synthetic unresolved work' }], productionEntries: [{ description: 'Synthetic unplanned work', quantity: 1, unit: 'EA', laborHours: 4 }] }),
    row(2, 'Approved', 0, [[13, 4]], { rateSnapshot: rate(100), materials: 'Visible synthetic materials', equipment: 'Visible synthetic equipment', flags: [{ type: 'unplanned_work', message: 'Synthetic approved follow-up' }] }),
    row(3, 'Needs review', 0, [[13, 2], [99, 8]]),
    row(4, 'Needs review', 1, [[13, 4]]),
    row(5, 'Draft', 0, [[13, 3]]),
    row(6, 'Approved', 0, [[13, 2], [99, 8]], { rateSnapshot: rate(75), materials: 'Hidden mixed-report materials', equipment: 'Hidden mixed-report equipment' }),
    row(7, 'Approved', 0, [[99, 11]], { rateSnapshot: rate(500), materials: 'Fully hidden materials' }),
    row(8, 'Approved', 0, [], { rateSnapshot: rate(30), materials: 'No managed labor materials' }),
    row(9, 'Approved', 0, [[13, 3]], { rateReview: { status: 'Required', reason: 'legacy_missing_rate_snapshot' } }),
    row(10, 'Draft', 0, [[13, 1]])
  ];
  seed.workdays = [{ id: 201, projectId: 101, memberIds: [13], status: 'ended', reportId: 5, startedAt: '2026-10-01T08:00:00.000Z', endedAt: '2026-10-01T11:00:00.000Z' }, { id: 202, projectId: 101, memberIds: [99], status: 'ended', reportId: 10, startedAt: '2026-10-01T08:00:00.000Z', endedAt: '2026-10-01T09:00:00.000Z' }];
  seed.photos = [{ id: 301, project: 0, reportId: 5, workdayId: 201, source: 'field', caption: 'Synthetic retained report photo', uploader: 'Synthetic PM', createdAt: '2026-10-01T10:00:00.000Z', url: '/uploads/' + ownedFilename }];
  const store = memory(seed), key = crypto.randomBytes(32), checks = [], tokens = {};
  let mod, uninstall, fixtureServices, httpCalls = 0;
  const request = async (route, { method = 'GET', data, token = tokens.owner, tenant = A } = {}) => {
    const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(10000), headers: { 'X-PDL-Company': tenant, ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
    httpCalls++; return { status: response.status, value: await response.json(), response };
  };
  const login = async role => { const result = await request('/api/auth/login', { token: null, method: 'POST', data: { email: role + '@example.invalid', password: initial } }); assert.equal(result.status, 200, JSON.stringify(result.value)); return result.value.token; };
  const mutate = async fn => { const loaded = await store.load(A); fn(loaded.snapshot); await store.commit(loaded.snapshot, loaded.revision); };
  const preview = async (operation, token = tokens.owner) => { const identity = await request('/api/workspace-identity', { token }); assert.equal(identity.status, 200, JSON.stringify(identity.value)); return request('/api/resources/preview', { method: 'POST', token, data: { operation, expectedRevision: identity.value.revision, reason: 'Synthetic existing report workflow review' } }); };
  const proof = reviewed => ({ token: reviewed.value.token, version: reviewed.value.version, confirmed: true, requestId: crypto.randomUUID() });
  const confirm = (operation, data, token = tokens.owner) => request(operation.path, { method: operation.method, data, token });
  const assertPrivate = value => { const body = JSON.stringify(value); for (const name of ['resourcePreviews', 'resourceReceipts', 'resourceReconciliations', 'retained', 'tokenHash', 'passwordHash', 'passwordSalt', 'sessionHash', 'sessionBinding']) assert.equal(body.includes('"' + name + '"'), false, 'private key leaked: ' + name); };
  const denied = async (operation, token, expected = [403, 404]) => { const before = canonicalHash(store.current()), revision = store.revision(), reviewed = await preview(operation, token); assert.ok(expected.includes(reviewed.status), operation.kind + ': ' + reviewed.status + ' ' + JSON.stringify(reviewed.value)); assert.equal(canonicalHash(store.current()), before); assert.equal(store.revision(), revision); };
  const save = async (operation, token = tokens.owner) => {
    const before = business(store.current()), reviewed = await preview(operation, token);
    assert.equal(reviewed.status, 200, operation.kind + ': ' + JSON.stringify(reviewed.value)); assert.equal(business(store.current()), before, 'preview mutated business data'); assertPrivate(reviewed.value);
    const p = proof(reviewed), uncheckedBefore = canonicalHash(store.current()), uncheckedRevision = store.revision();
    assert.equal((await confirm(operation, { ...p, confirmed: false }, token)).status, 400, operation.kind + ' accepted unchecked confirmation'); assert.equal(canonicalHash(store.current()), uncheckedBefore); assert.equal(store.revision(), uncheckedRevision);
    const saved = await confirm(operation, p, token); assert.equal(saved.status, 200, operation.kind + ': ' + JSON.stringify(saved.value)); assert.ok(saved.response.headers.get('X-PDL-Resource-Receipt'), operation.kind + ' omitted current receipt'); assertPrivate(saved.value);
    const receipt = store.current().resourceReceipts.find(item => item.requestId === p.requestId); assert.ok(receipt, operation.kind + ' omitted durable receipt'); assert.equal(receipt.operation.kind, operation.kind);
    assert.ok(store.current().auditLog.some(item => item.type === 'resource_changed' && item.requestId === p.requestId));
    return { reviewed, proof: p, saved, receipt };
  };
  const safety = op('reportSafety', 'PATCH', '/api/reports/1/safety', { reportType: 'superintendent', safetyItems: [{ observation: 'Synthetic guarded edge', location: 'North work area', company: 'Synthetic Construction', notified: 'Synthetic PM', action: 'Synthetic guard installed', owner: 'Synthetic PM', dueDate: '2026-10-02', status: 'verified', verification: 'Synthetic checked' }], safetyTalk: 'Synthetic reviewed hazards', safetyTalkAttendees: 'North crew', safetyInspection: '', safetyIncident: '', noSafetyObservations: false });
  const disposition = op('reportDisposition', 'PATCH', '/api/reports/1/disposition', { resolution: 'potential_change', note: 'Synthetic bounded daily exception' });
  const remove = op('reportRemove', 'DELETE', '/api/reports/5', { reason: 'Synthetic duplicate report review' });
  const reportRate = op('reportRate', 'PATCH', '/api/reports/2/rate', { laborRate: '110', reason: 'Synthetic approved rate adjustment' });
  const projectRate = op('projectRateSettings', 'PATCH', '/api/projects/101/rate-settings', { defaultLaborRate: '120', reason: 'Synthetic future rate adjustment' });
  try {
    mod = require('./server'); await new Promise(resolve => mod.server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + mod.server.address().port;
    fixtureServices = services(store, origin, { key });
    uninstall = mod.installCompatibilityAccountTests({ synthetic: true, companyId: A, origin, globalOrigin: 'http://localhost:4999', repository: store, ...fixtureServices, workspace: true, workspaceKey: key });
    for (const role of ['owner', 'admin', 'project_manager', 'foreman', 'field']) tokens[role] = await login(role);

    const ownerSummary = await request('/api/projects/101/tm-summary'); assert.equal(ownerSummary.status, 200, JSON.stringify(ownerSummary.value));
    const current = store.current(), approved = current.reports.filter(item => item.project === 0 && item.status === 'Approved');
    assert.deepEqual(ownerSummary.value, { projectId: 101, ...reportRates.summarizeRates(current, 0, approved), materialEntries: approved.filter(item => item.materials).length, equipmentEntries: approved.filter(item => item.equipment).length, currentDefaults: current.projects[0].tmSettings }); assertPrivate(ownerSummary.value);
    const managerSummary = await request('/api/projects/101/tm-summary', { token: tokens.project_manager }); assert.equal(managerSummary.status, 200, JSON.stringify(managerSummary.value));
    assert.equal(managerSummary.value.approvedDailies, 3); assert.equal(managerSummary.value.laborHours, 9); assert.equal(managerSummary.value.knownLaborAmount, 550); assert.equal(managerSummary.value.laborAmount, null); assert.equal(managerSummary.value.materialEntries, 1); assert.equal(managerSummary.value.equipmentEntries, 1);
    assert.equal(JSON.stringify(managerSummary.value).includes('Hidden synthetic classification'), false); assert.deepEqual(managerSummary.value.missingRateReports.map(item => item.reportId), [9]);
    assert.equal((await request('/api/projects/102/tm-summary', { token: tokens.project_manager })).status, 404); assert.equal((await request('/api/projects/101/tm-summary', { token: tokens.field })).status, 403);
    checks.push('Owner no-policy T&M shape matches legacy computation; PM totals use only managed labor and exclude mixed-report materials/equipment and fully hidden reports');

    for (const operation of [safety, disposition, remove, reportRate, projectRate]) { const before = canonicalHash(store.current()); assert.equal((await confirm(operation, operation.details)).status, 400, operation.kind + ' accepted a raw legacy body'); assert.equal(canonicalHash(store.current()), before); }
    const safetySaved = await save(safety, tokens.project_manager); assert.equal(store.current().reports.find(item => item.id === 1).reportType, 'superintendent'); assert.equal(store.current().reports.find(item => item.id === 1).safetyItems[0].status, 'verified');
    const dispositionSaved = await save(disposition, tokens.project_manager); const changed = store.current(); assert.equal(changed.changes.length, 1); assert.equal(changed.changes[0].reportId, 1); assert.equal(changed.changes[0].amount, 0); assert.equal(changed.changes[0].status, 'Potential'); assert.equal(changed.reports.find(item => item.id === 1).flags[0].resolution, 'potential_change');
    const originalRate = structuredClone(store.current().reports.find(item => item.id === 2).rateSnapshot); await save(reportRate, tokens.admin); assert.equal(store.current().reports.find(item => item.id === 2).rateSnapshot.laborRate, 110); assert.deepEqual(store.current().reports.find(item => item.id === 2).rateHistory[0].previous, originalRate);
    const reportRatesBefore = canonicalHash(store.current().reports); await save(projectRate, tokens.admin); assert.equal(store.current().projects[0].tmSettings.defaultLaborRate, 120); assert.equal(canonicalHash(store.current().reports), reportRatesBefore, 'future project defaults rewrote approved historical rates');
    checks.push('actual safety, disposition, audited report-rate and future project-rate handlers require preview/explicit confirmation and persist exact bounded effects, history, audit and receipt');

    const exportBefore = canonicalHash(store.current()), exportRevision = store.revision(), companyExport = await request('/api/company/export');
    assert.equal(companyExport.status, 200, JSON.stringify(companyExport.value)); assert.equal(companyExport.value.exportMetadata.companyId, A); assert.equal(companyExport.value.exportMetadata.format, 'pro-daily-link-company-export');
    assert.deepEqual(companyExport.value.reports, store.current().reports); assert.deepEqual(companyExport.value.projects, store.current().projects); assertPrivate(companyExport.value);
    for (const name of ['sessions', 'dailyActionPreviews', 'dailyActionReceipts', 'notesActionPreviews', 'notesActionReceipts', 'accountPreviews', 'accountReceipts']) assert.equal(Object.hasOwn(companyExport.value, name), false, 'Company export leaked private ledger: ' + name);
    assert.match(companyExport.response.headers.get('Content-Disposition'), /attachment/); assert.equal(companyExport.response.headers.get('Cache-Control'), 'no-store');
    assert.equal(canonicalHash(store.current()), exportBefore); assert.equal(store.revision(), exportRevision);
    for (const role of ['admin', 'project_manager', 'foreman', 'field']) assert.equal((await request('/api/company/export', { token: tokens[role] })).status, 403);
    checks.push('actual Owner Company JSON export preserves business IDs/history while stripping signed resource custody, sessions and credentials; every other role is denied and export performs no rewrite');

    const manualChange = { id: 2, projectId: 101, number: 'PC-MANUAL', title: 'Synthetic independent commercial change', status: 'Potential', amount: 432, createdAt: '2026-10-01T12:00:00.000Z', history: [{ action: 'Synthetic standalone commercial history', by: 'Synthetic Owner', at: '2026-10-01T12:00:00.000Z' }] };
    const hiddenChange = { ...manualChange, id: 3, reportId: 7, title: 'Synthetic foreign-crew derived secret', history: [{ action: 'Synthetic foreign-crew derived history', by: 'Synthetic Owner', at: '2026-10-01T12:00:00.000Z' }] }, danglingChange = { ...manualChange, id: 4, reportId: 999, title: 'Synthetic dangling derived secret' };
    await mutate(db => { db.changes.push(manualChange, hiddenChange, danglingChange); });
    const ownerChanges = await request('/api/changes?projectId=101'); assert.equal(ownerChanges.status, 200, JSON.stringify(ownerChanges.value)); assert.ok(ownerChanges.value.some(item => item.id === 1)); assert.ok(ownerChanges.value.some(item => item.id === manualChange.id));
    const pmChanges = await request('/api/changes?projectId=101', { token: tokens.project_manager }); assert.equal(pmChanges.status, 200, JSON.stringify(pmChanges.value)); assert.deepEqual(pmChanges.value.map(item => item.id), [2]); assert.equal(JSON.stringify(pmChanges.value).includes('foreign-crew derived'), false); assert.equal(JSON.stringify(pmChanges.value).includes('dangling derived'), false); assert.equal(JSON.stringify(pmChanges.value).includes('Synthetic bounded daily exception'), false);
    const hiddenOriginal = structuredClone(store.current().reports.find(item => item.id === 7));
    await mutate(db => { db.reports[db.reports.findIndex(item => item.id === 7)] = row(7, 'Approved', 0, [[13, 2]], { rateSnapshot: rate(100), notes: 'Synthetic recycled permitted daily', summary: 'Synthetic recycled permitted scope' }); });
    const recycledSource = await request('/api/changes?projectId=101', { token: tokens.project_manager }); assert.equal(recycledSource.status, 200, JSON.stringify(recycledSource.value)); assert.deepEqual(recycledSource.value.map(item => item.id), [2], 'a recycled allowed numeric report ID exposed original hidden change title/history'); assert.equal(JSON.stringify(recycledSource.value).includes('foreign-crew derived'), false);
    await mutate(db => { db.reports[db.reports.findIndex(item => item.id === 7)] = hiddenOriginal; });
    await mutate(db => { db.company.dailyRolePolicy = dailyPolicy(); for (const action of ['viewReports', 'createReports', 'editReports', 'approveReports', 'runWorkdays']) db.company.dailyRolePolicy.roles.admin[action] = false; });
    const restrictedChanges = await request('/api/changes?projectId=101', { token: tokens.admin }); assert.equal(restrictedChanges.status, 200, JSON.stringify(restrictedChanges.value)); assert.deepEqual(restrictedChanges.value.map(item => item.id), [2]); assert.equal(restrictedChanges.value[0].title, manualChange.title); assert.equal(restrictedChanges.value[0].amount, 432); assert.deepEqual(restrictedChanges.value[0].history, manualChange.history); assert.equal(JSON.stringify(restrictedChanges.value).includes('Synthetic bounded daily exception'), false); assert.equal(Object.hasOwn(restrictedChanges.value[0], 'reportId'), false);
    await mutate(db => { db.company.pricingAccess.enabled = false; db.company.dailyRolePolicy.revision++; for (const action of ['viewReports', 'createReports', 'editReports', 'approveReports', 'runWorkdays']) db.company.dailyRolePolicy.roles.project_manager[action] = false; });
    const redactedManual = await request('/api/changes?projectId=101', { token: tokens.project_manager }); assert.equal(redactedManual.status, 200, JSON.stringify(redactedManual.value)); assert.deepEqual(redactedManual.value.map(item => item.id), [2]); assert.equal(redactedManual.value[0].title, manualChange.title); assert.equal(Object.hasOwn(redactedManual.value[0], 'amount'), false, 'standalone commercial read bypassed existing PM pricing policy');
    const immutableAdminPricing = await request('/api/changes?projectId=101', { token: tokens.admin }); assert.equal(immutableAdminPricing.status, 200); assert.equal(immutableAdminPricing.value.find(item => item.id === manualChange.id).amount, 432, 'pricing policy changed inherited Admin financial authority');
    const immutableOwnerChanges = await request('/api/changes?projectId=101'); assert.equal(immutableOwnerChanges.status, 200, JSON.stringify(immutableOwnerChanges.value)); assert.ok(immutableOwnerChanges.value.some(item => item.id === 1)); assert.equal(immutableOwnerChanges.value.find(item => item.id === manualChange.id).amount, 432);
    await mutate(db => { db.company.pricingAccess.enabled = true; delete db.company.dailyRolePolicy; db.changes.push({ ...manualChange, id: 5, reportId: 4, title: 'Synthetic mismatched source project' }); });
    for (const token of [tokens.owner, tokens.project_manager]) assert.equal((await request('/api/changes?projectId=101', { token })).status, 409, 'mismatched daily-source project was treated as authorized change evidence');
    await mutate(db => { db.changes = db.changes.filter(item => item.id === 1); });
    checks.push('daily-derived changes retain fixed Owner/Admin archival view with typed report restrictions; PM derived rows are concealed without immutable source identity, including recycled numeric report IDs; standalone commercial changes retain independent project/pricing authority');

    for (const operation of [safety, disposition, remove]) {
      await denied({ ...operation, path: '/api/reports/3' + (operation.kind === 'reportSafety' ? '/safety' : operation.kind === 'reportDisposition' ? '/disposition' : '') }, tokens.project_manager);
      await denied({ ...operation, path: '/api/reports/4' + (operation.kind === 'reportSafety' ? '/safety' : operation.kind === 'reportDisposition' ? '/disposition' : '') }, tokens.project_manager);
    }
    await denied({ ...remove, path: '/api/reports/10' }, tokens.project_manager);
    for (const operation of [reportRate, projectRate]) for (const role of ['project_manager', 'foreman', 'field']) await denied(operation, tokens[role], [403]);
    const tenantBefore = canonicalHash(store.current()), tenantRevision = store.revision(); const foreignTenant = await request('/api/resources/preview', { method: 'POST', tenant: B, data: { operation: safety, expectedRevision: tenantRevision, reason: 'Synthetic cross-company target' } }); assert.ok([401, 403, 404, 409, 503].includes(foreignTenant.status), JSON.stringify(foreignTenant.value)); assert.equal(canonicalHash(store.current()), tenantBefore); assert.equal(store.revision(), tenantRevision);
    checks.push('whole original report crew/project and related workday scope required; foreign company/project/member targets denied; report and project rates retain fixed financial role ceilings');

    await mutate(db => { db.company.dailyRolePolicy = dailyPolicy(); db.company.dailyRolePolicy.roles.project_manager.editReports = false; });
    assert.equal(store.current().users.find(item => item.id === 3).permissions.approveDailies, true);
    for (const operation of [safety, disposition, remove]) await denied(operation, tokens.project_manager, [403]);
    await mutate(db => { db.company.dailyRolePolicy.revision++; db.company.dailyRolePolicy.roles.project_manager.editReports = true; db.company.dailyRolePolicy.roles.project_manager.approveReports = false; });
    for (const operation of [safety, disposition, remove]) await denied({ ...operation, path: '/api/reports/2' + (operation.kind === 'reportSafety' ? '/safety' : operation.kind === 'reportDisposition' ? '/disposition' : '') }, tokens.project_manager, [403]);
    await mutate(db => { db.company.dailyRolePolicy.revision++; db.company.dailyRolePolicy.roles.admin.editReports = false; });
    await denied(reportRate, tokens.admin, [403]);
    await mutate(db => { db.company.dailyRolePolicy.revision++; db.company.dailyRolePolicy.roles.admin.editReports = true; db.company.dailyRolePolicy.roles.admin.approveReports = false; db.reports.find(item => item.id === 2).status = 'Needs review'; });
    await denied(reportRate, tokens.admin, [403]);
    assert.ok(store.current().reports.find(item => item.id === 2).history.some(item => item.action === 'Approved')); assert.ok(store.current().reports.find(item => item.id === 2).rateSnapshot);
    await mutate(db => { db.reports.find(item => item.id === 2).status = 'Approved'; });
    await save({ ...projectRate, details: { defaultLaborRate: 130, reason: 'Immutable project financial authority' } }, tokens.admin);
    await mutate(db => { const policy = db.company.dailyRolePolicy; policy.revision++; for (const action of ['viewReports', 'createReports', 'editReports', 'approveReports', 'runWorkdays']) policy.roles.project_manager[action] = false; });
    const summaryBefore = canonicalHash(store.current()); assert.equal((await request('/api/projects/101/tm-summary', { token: tokens.project_manager })).status, 403); assert.equal(canonicalHash(store.current()), summaryBefore);
    await mutate(db => { db.company.dailyRolePolicy.roles.project_manager.tenantAdmin = true; });
    await denied(safety, tokens.project_manager, [403]); assert.equal((await request('/api/projects/101/tm-summary')).status, 200, 'malicious role flags locked out immutable Owner reads');
    await mutate(db => { delete db.company.dailyRolePolicy; });
    checks.push('current typed edit/approval/view restrictions override stored grants; approved corrections and reopened historical rate reviews retain separate approval; project future-rate administration remains immutable outside editor flags');

    const compoundFields = { ...safety.details, safetyTalk: 'Synthetic single-save superintendent talk' };
    const createDaily = { action: 'createReport', details: { projectId: 101, dateIso: '2026-10-03', status: 'Draft', foreman: 'Synthetic project_manager', notes: 'Synthetic compound superintendent draft', laborEntries: [{ memberId: 13, hours: 3, crew: 'North' }], productionEntries: [], ...compoundFields } };
    const dailyPreview = data => request('/api/daily-actions/preview', { method: 'POST', token: tokens.project_manager, data });
    const dailyProof = reviewed => ({ token: reviewed.value.token, version: reviewed.value.version, confirmed: true, requestId: crypto.randomUUID() });
    await mutate(db => { db.company.dailyRolePolicy = dailyPolicy(); db.company.dailyRolePolicy.roles.project_manager.editReports = false; });
    const createBefore = business(store.current()), compoundPreview = await dailyPreview(createDaily); assert.equal(compoundPreview.status, 200, JSON.stringify(compoundPreview.value)); assert.equal(business(store.current()), createBefore, 'compound superintendent preview changed business data');
    assert.equal(compoundPreview.value.proposed.reportType, 'superintendent'); assert.equal(compoundPreview.value.proposed.safetyTalk, compoundFields.safetyTalk);
    const compoundProof = dailyProof(compoundPreview), noConfirmHash = canonicalHash(store.current()), noConfirmRevision = store.revision();
    assert.equal((await request('/api/reports', { method: 'POST', token: tokens.project_manager, data: { ...compoundProof, confirmed: false } })).status, 400); assert.equal(canonicalHash(store.current()), noConfirmHash); assert.equal(store.revision(), noConfirmRevision);
    const compoundSaved = await request('/api/reports', { method: 'POST', token: tokens.project_manager, data: compoundProof }); assert.equal(compoundSaved.status, 201, JSON.stringify(compoundSaved.value)); assert.equal(store.revision(), noConfirmRevision + 1, 'compound create required more than one business CAS');
    const compoundId = compoundSaved.value.id, storedCompound = store.current().reports.find(item => item.id === compoundId); assert.ok(storedCompound); assert.equal(storedCompound.notes, createDaily.details.notes);
    for (const [name, value] of Object.entries(compoundFields)) assert.deepEqual(storedCompound[name], value, 'compound create dropped ' + name);
    const deniedEdit = await dailyPreview({ action: 'editReport', id: compoundId, details: { notes: 'Synthetic forbidden edit', ...compoundFields } }); assert.equal(deniedEdit.status, 403); assert.equal(store.current().reports.find(item => item.id === compoundId).notes, createDaily.details.notes);
    await mutate(db => { db.company.dailyRolePolicy.revision++; db.company.dailyRolePolicy.roles.project_manager.editReports = true; });
    const editDaily = { action: 'editReport', id: compoundId, details: { status: 'Draft', notes: 'Synthetic compound revised main notes', ...compoundFields, safetyTalk: 'Synthetic compound revised safety talk' } };
    const editBefore = business(store.current()), compoundEditPreview = await dailyPreview(editDaily); assert.equal(compoundEditPreview.status, 200, JSON.stringify(compoundEditPreview.value)); assert.equal(business(store.current()), editBefore);
    const compoundEditProof = dailyProof(compoundEditPreview), deniedCommitHash = canonicalHash(store.current()), deniedCommitRevision = store.revision(); store.rejectCommit = true;
    try { assert.equal((await request('/api/reports/' + compoundId, { method: 'PATCH', token: tokens.project_manager, data: compoundEditProof })).status, 409); } finally { store.rejectCommit = false; }
    assert.equal(canonicalHash(store.current()), deniedCommitHash); assert.equal(store.revision(), deniedCommitRevision); assert.equal(store.current().reports.find(item => item.id === compoundId).safetyTalk, compoundFields.safetyTalk);
    const compoundEdited = await request('/api/reports/' + compoundId, { method: 'PATCH', token: tokens.project_manager, data: compoundEditProof }); assert.equal(compoundEdited.status, 200, JSON.stringify(compoundEdited.value)); assert.equal(store.revision(), deniedCommitRevision + 1); assert.equal(store.current().reports.find(item => item.id === compoundId).notes, editDaily.details.notes); assert.equal(store.current().reports.find(item => item.id === compoundId).safetyTalk, editDaily.details.safetyTalk);
    const secondCreate = { ...createDaily, details: { ...createDaily.details, dateIso: '2026-10-04', notes: 'Synthetic revoked compound create' } }, revokedCreatePreview = await dailyPreview(secondCreate); assert.equal(revokedCreatePreview.status, 200, JSON.stringify(revokedCreatePreview.value));
    await mutate(db => { db.company.dailyRolePolicy.revision++; db.company.dailyRolePolicy.roles.project_manager.createReports = false; db.company.dailyRolePolicy.roles.project_manager.runWorkdays = false; });
    const revokedCreateBefore = canonicalHash(store.current()), revokedCreateRevision = store.revision(); assert.equal((await request('/api/reports', { method: 'POST', token: tokens.project_manager, data: dailyProof(revokedCreatePreview) })).status, 403); assert.equal(canonicalHash(store.current()), revokedCreateBefore); assert.equal(store.revision(), revokedCreateRevision); assert.equal(store.current().reports.some(item => item.notes === secondCreate.details.notes), false);
    await mutate(db => { db.company.dailyRolePolicy.revision++; db.company.dailyRolePolicy.roles.project_manager.createReports = true; db.company.dailyRolePolicy.roles.project_manager.approveReports = false; });
    assert.equal((await dailyPreview({ action: 'editReport', id: 2, details: { notes: 'Synthetic forbidden approved compound edit', ...compoundFields } })).status, 403);
    await mutate(db => { delete db.company.dailyRolePolicy; });
    checks.push('normal superintendent create/edit includes main and complete safety fields in one daily preview and one CAS; create without edit works, unchecked/revoked/rejected saves leave no partial main or safety writes, approved edits retain approval');

    for (const operation of [safety, disposition, remove, reportRate, projectRate]) await denied({ ...operation, details: { ...operation.details, permissions: { owner: true } } }, tokens.owner, [400]);
    await denied({ ...reportRate, details: { laborRate: -1, reason: 'Synthetic invalid negative rate' } }, tokens.owner, [400]);
    await denied({ ...safety, details: { ...safety.details, noSafetyObservations: true } }, tokens.owner, [400]);
    await denied({ ...safety, path: '/api/reports/999/safety' }, tokens.owner, [404]);
    checks.push('closed report/rate payloads reject arbitrary grants, unknown targets, invalid financial values and contradictory safety evidence');

    const pendingPolicy = await preview(safety, tokens.project_manager); assert.equal(pendingPolicy.status, 200); const policyProof = proof(pendingPolicy);
    await mutate(db => { db.company.dailyRolePolicy = dailyPolicy(); db.company.dailyRolePolicy.roles.project_manager.editReports = false; });
    let before = canonicalHash(store.current()), revision = store.revision(); assert.ok([403, 409].includes((await confirm(safety, policyProof, tokens.project_manager)).status)); assert.equal(canonicalHash(store.current()), before); assert.equal(store.revision(), revision); await mutate(db => { delete db.company.dailyRolePolicy; });
    const pendingRole = await preview(safety, tokens.project_manager); assert.equal(pendingRole.status, 200); const roleProof = proof(pendingRole);
    await mutate(db => { db.users.find(item => item.id === 3).role = 'field'; }); before = canonicalHash(store.current()); revision = store.revision(); assert.ok([403, 409].includes((await confirm(safety, roleProof, tokens.project_manager)).status)); assert.equal(canonicalHash(store.current()), before); assert.equal(store.revision(), revision); await mutate(db => { db.users.find(item => item.id === 3).role = 'project_manager'; });
    const pendingGrant = await preview(safety, tokens.project_manager); assert.equal(pendingGrant.status, 200); const grantProof = proof(pendingGrant);
    await mutate(db => { db.users.find(item => item.id === 3).permissions.viewDailies = false; db.users.find(item => item.id === 3).permissions.approveDailies = false; }); before = canonicalHash(store.current()); revision = store.revision(); assert.ok([403, 409].includes((await confirm(safety, grantProof, tokens.project_manager)).status)); assert.equal(canonicalHash(store.current()), before); assert.equal(store.revision(), revision); await mutate(db => { db.users.find(item => item.id === 3).permissions.viewDailies = true; db.users.find(item => item.id === 3).permissions.approveDailies = true; });
    const pendingSession = await preview(safety, tokens.project_manager); assert.equal(pendingSession.status, 200); const sessionProof = proof(pendingSession), pmHash = crypto.createHash('sha256').update(tokens.project_manager).digest('hex');
    await mutate(db => { db.sessions.find(item => item.tokenHash === pmHash).expiresAt = new Date(realNow() - 1000).toISOString(); }); before = canonicalHash(store.current()); revision = store.revision(); assert.equal((await confirm(safety, sessionProof, tokens.project_manager)).status, 401); assert.equal(canonicalHash(store.current()), before); assert.equal(store.revision(), revision); tokens.project_manager = await login('project_manager');
    checks.push('policy, role, stored grant and originating-session revocation between preview and first confirmation each prevent all business/audit/receipt/revision writes');

    const pendingScope = await preview(safety, tokens.project_manager); assert.equal(pendingScope.status, 200); const scopeProof = proof(pendingScope); await mutate(db => { db.team.find(item => item.id === 13).crew = 'Hidden crew'; }); before = canonicalHash(store.current()); revision = store.revision(); assert.ok([403, 404, 409].includes((await confirm(safety, scopeProof, tokens.project_manager)).status)); assert.equal(canonicalHash(store.current()), before); assert.equal(store.revision(), revision); await mutate(db => { db.team.find(item => item.id === 13).crew = 'North'; });
    const competing = await preview(safety); assert.equal(competing.status, 200); const competingProof = proof(competing); await save({ ...projectRate, details: { defaultLaborRate: 140, reason: 'Synthetic concurrent existing settings writer' } }); before = canonicalHash(store.current()); revision = store.revision(); assert.equal((await confirm(safety, competingProof)).status, 409); assert.equal(canonicalHash(store.current()), before); assert.equal(store.revision(), revision);
    const expiry = await preview(safety); assert.equal(expiry.status, 200); before = canonicalHash(store.current()); revision = store.revision(); Date.now = () => Date.parse(expiry.value.expiresAt) + 1;
    try { assert.equal((await confirm(safety, proof(expiry))).status, 409); } finally { Date.now = realNow; }
    assert.equal(canonicalHash(store.current()), before); assert.equal(store.revision(), revision);
    checks.push('crew movement, competing revisions and expired signed previews fail closed without stale business mutation');

    const revokedInFlight = await preview(safety, tokens.project_manager); assert.equal(revokedInFlight.status, 200); const revokedInFlightProof = proof(revokedInFlight), revokedReportHash = canonicalHash(store.current().reports);
    let revocationOnlyHash, revocationOnlyRevision;
    store.beforeCommit = async candidate => {
      if (!candidate.resourceReceipts?.some(item => item.requestId === revokedInFlightProof.requestId)) return;
      store.beforeCommit = null;
      await mutate(db => { db.company.dailyRolePolicy = dailyPolicy(); db.company.dailyRolePolicy.roles.project_manager.editReports = false; });
      revocationOnlyHash = canonicalHash(store.current()); revocationOnlyRevision = store.revision();
    };
    try { assert.equal((await confirm(safety, revokedInFlightProof, tokens.project_manager)).status, 409); } finally { store.beforeCommit = null; }
    assert.ok(revocationOnlyHash, 'in-flight hook was not exercised'); assert.equal(canonicalHash(store.current()), revocationOnlyHash); assert.equal(store.revision(), revocationOnlyRevision); assert.equal(canonicalHash(store.current().reports), revokedReportHash);
    await mutate(db => { delete db.company.dailyRolePolicy; });
    checks.push('a current policy restriction committed while first confirmation is in flight wins CAS and prevents the stale report candidate, receipt and audit from committing');

    const ownerHash = crypto.createHash('sha256').update(tokens.owner).digest('hex'); let sessionDeadline;
    await mutate(db => { sessionDeadline = realNow() + 5000; db.sessions.find(item => item.tokenHash === ownerHash).expiresAt = new Date(sessionDeadline).toISOString(); });
    const inFlight = await preview({ ...safety, details: { ...safety.details, safetyTalk: 'Synthetic must not commit after session deadline' } }); assert.equal(inFlight.status, 200, JSON.stringify(inFlight.value));
    const inFlightProof = proof(inFlight), inFlightBefore = canonicalHash(store.current()), inFlightRevision = store.revision();
    store.beforeCommit = candidate => { if (candidate.resourceReceipts?.some(item => item.requestId === inFlightProof.requestId)) Date.now = () => sessionDeadline + 1; };
    try { assert.equal((await confirm(safety, inFlightProof)).status, 409); } finally { Date.now = realNow; store.beforeCommit = null; }
    assert.equal(canonicalHash(store.current()), inFlightBefore); assert.equal(store.revision(), inFlightRevision);
    await mutate(db => { db.sessions.find(item => item.tokenHash === ownerHash).expiresAt = new Date(realNow() + 600000).toISOString(); });
    checks.push('in-flight confirmation crossing its originating session deadline rolls back report/safety effects, audit, receipt and revision at the actual memory commit guard');

    const lost = { ...safety, details: { ...safety.details, safetyTalk: 'Synthetic original unknown-result save' } }, lostPreview = await preview(lost); assert.equal(lostPreview.status, 200); const lostProof = proof(lostPreview); store.loseCommitAck = true;
    assert.equal((await confirm(lost, lostProof)).status, 503); assert.equal(store.current().reports.find(item => item.id === 1).safetyTalk, lost.details.safetyTalk);
    const lostRevision = store.revision(), lostHash = canonicalHash(store.current()), lookup = { token: lostProof.token, version: lostProof.version, requestId: lostProof.requestId, method: lost.method, path: lost.path };
    const recovered = await request('/api/resources/original-result', { method: 'POST', data: lookup }); assert.equal(recovered.status, 200, JSON.stringify(recovered.value)); assert.equal(recovered.value.receipt.status, 'committed'); assert.equal(recovered.value.report, undefined); assert.equal(recovered.value.safetyTalk, undefined); assertPrivate(recovered.value); assert.equal(store.revision(), lostRevision); assert.equal(canonicalHash(store.current()), lostHash);
    const replay = await confirm(lost, lostProof); assert.equal(replay.status, 200, JSON.stringify(replay.value)); assert.equal(replay.value.originalSaveResult, true); assertPrivate(replay.value); assert.equal(store.revision(), lostRevision); assert.equal(canonicalHash(store.current()), lostHash);
    const otherOwner = await login('owner'), afterLogin = canonicalHash(store.current()), afterLoginRevision = store.revision(); assert.equal((await request('/api/resources/original-result', { method: 'POST', data: lookup, token: otherOwner })).status, 409); assert.equal(canonicalHash(store.current()), afterLogin); assert.equal(store.revision(), afterLoginRevision);
    checks.push('lost COMMIT acknowledgement resolves its original technical receipt; replay performs no rewrite or repeated history and another session cannot recover private custody');

    await mutate(db => { db.reports.find(item => item.id === 9).laborExclusions = [{ memberId: 13, hours: 1, sourceReportId: 2, by: 'Synthetic Owner', at: '2026-10-01T12:00:00.000Z' }]; }); await denied({ ...remove, path: '/api/reports/2' }, tokens.owner, [409]); await mutate(db => { delete db.reports.find(item => item.id === 9).laborExclusions; });
    const photoBefore = structuredClone(store.current().photos[0]), dayBefore = structuredClone(store.current().workdays[0]), removedReport = structuredClone(store.current().reports.find(item => item.id === 5));
    const removed = await save(remove, tokens.project_manager); assert.equal(store.current().reports.some(item => item.id === 5), false); assert.deepEqual(store.current().photos[0], { ...photoBefore, reportId: null }); assert.deepEqual(store.current().workdays[0], { ...dayBefore, reportId: null }); assert.deepEqual(fs.readFileSync(ownedFile), ownedBytes); assert.ok(JSON.stringify(removed.receipt.retained).includes(removedReport.notes), 'original deleted report beforeimage was not retained privately'); assert.ok(JSON.stringify(removed.receipt.retained).includes(photoBefore.url), 'original photo reference beforeimage was not retained privately');
    const deleteRevision = store.revision(), deleteHash = canonicalHash(store.current()); const removeReplay = await confirm(remove, removed.proof, tokens.project_manager); assert.equal(removeReplay.status, 200, JSON.stringify(removeReplay.value)); assert.equal(removeReplay.value.originalSaveResult, true); assert.equal(JSON.stringify(removeReplay.value).includes(removedReport.notes), false); assertPrivate(removeReplay.value); assert.equal(store.revision(), deleteRevision); assert.equal(canonicalHash(store.current()), deleteHash); assert.deepEqual(fs.readFileSync(ownedFile), ownedBytes);
    assert.equal((await request('/api/reports/5', { token: tokens.project_manager })).status, 404);
    checks.push('report removal blocks referenced labor sources, detaches scoped report links, retains original history/reference beforeimages privately and preserves actual owned attachment bytes on confirm/replay');

    const sameRevision = store.revision(), sameHash = canonicalHash(store.current());
    const staleSafetyReplay = await confirm(safety, safetySaved.proof, tokens.project_manager); assert.ok([200, 409].includes(staleSafetyReplay.status), JSON.stringify(staleSafetyReplay.value)); assertPrivate(staleSafetyReplay.value); assert.equal(store.revision(), sameRevision); assert.equal(canonicalHash(store.current()), sameHash);
    const staleDispositionReplay = await confirm(disposition, dispositionSaved.proof, tokens.project_manager); assert.ok([200, 409].includes(staleDispositionReplay.status), JSON.stringify(staleDispositionReplay.value)); assertPrivate(staleDispositionReplay.value); assert.equal(store.revision(), sameRevision); assert.equal(canonicalHash(store.current()), sameHash);
    assert.deepEqual(fs.readFileSync(file), legacyBytes); assert.deepEqual(fs.readFileSync(platformFile), platformBytes); assert.equal(externalCalls, 0); assert.equal(fixtureServices.messages.length, 0);
    console.log(JSON.stringify({ passed: checks.length, httpCalls, backend: 'owned-memory', actualWriterSignatures: 5, scopedReadSignatures: 3, compoundDailySignatures: 2, syntheticMessages: fixtureServices.messages.length, allowedExternalCalls: externalCalls, checks }));
  } finally {
    Date.now = realNow; global.fetch = realFetch; store.beforeCommit = null;
    uninstall?.(); if (mod?.server.listening) await new Promise(resolve => mod.server.close(resolve));
    if (fs.existsSync(ownedFile)) fs.unlinkSync(ownedFile);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
