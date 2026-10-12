'use strict';
// Actual HTTP report workflows and actual PostgreSQL tenant transactions.
// This file never launches PG. Only a parent-owned loopback synthetic URL runs it.
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { A, B, initial, credential, snapshot } = require('./compat-account-fixture');
const { services } = require('./compat-lifecycle-fixture');
const { nativeFixture } = require('./compat-lifecycle-native-fixture');
const { CompatTenantRepository, split } = require('./database/compat-tenant-repository');
const { canonicalHash } = require('./database/transactional-repository');
const daily = require('./daily-access'), reportRates = require('./report-rate-policy');
const sourceFiles = ['resource-report-variants-postgres.test.js', 'resource-report-variants.js', 'resource-admission.js', 'resource-inputs.js', 'resource-deltas.js', 'daily-admission.js', 'daily-access.js', 'editor-commercial-reads.js', 'compat-workspace.js', 'compat-workspace-projections.js', 'compat-account-runtime.js', 'database/compat-tenant-repository.js', 'database/compat-synthetic-deadlines.sql', 'server.js'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const op = (kind, method, route, details) => ({ kind, method, path: route, details });
const business = db => canonicalHash(Object.fromEntries(['company', 'users', 'projects', 'team', 'reports', 'changes', 'photos', 'workdays', 'timeCards', 'assignments', 'projectTickets'].map(key => [key, db[key] || []])));
const closed = db => Object.fromEntries(Object.entries(db).filter(([name]) => !['resourcePreviews', 'resourceReceipts', 'resourceReconciliations'].includes(name)));
const dailyPolicy = () => ({ version: 1, revision: 1, roles: Object.fromEntries(daily.roles.map(role => [role, daily.ceiling(role)])) });
function bounded(promise, label, ms = 12000) { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Synthetic native report timeout: ' + label)), ms); timer.unref(); })]).finally(() => clearTimeout(timer)); }
function seed(filename) {
  const db = snapshot(); db.team[0].crew = 'Office'; db.company.pricingAccess = { enabled: true, officeMode: 'all', userIds: [] };
  Object.assign(db.projects[0], { contractType: 'tm', tmSettings: { defaultLaborRate: 100, materialMarkup: 10, equipmentMarkup: 5 } });
  db.projects.push({ id: 102, name: 'Native report other project', code: 'NAT2', status: 'Active', estimateItems: [], contractType: 'tm', tmSettings: { defaultLaborRate: 125, materialMarkup: 0, equipmentMarkup: 0 } });
  for (const [id, role] of [[2, 'admin'], [3, 'project_manager']]) {
    db.users.push({ id, memberId: id + 10, companyId: A, name: 'Native ' + role, email: role + '@example.invalid', status: 'Active', role, ...credential(initial), projectIds: [101], assignedCrews: ['North'], permissions: { viewDailies: true, approveDailies: true, scheduleCrews: true, viewTime: true, manageTime: true } });
    db.team.push({ id: id + 10, name: 'Native ' + role, crew: role === 'admin' ? 'Office' : 'North', role: 'Managed synthetic labor', initials: 'NR', hours: 0 });
  }
  db.team.push({ id: 99, name: 'Native hidden labor', crew: 'Hidden crew', role: 'Hidden native classification', initials: 'NH', hours: 0 });
  db.crews = [{ id: 1, name: 'North' }, { id: 2, name: 'Hidden crew' }];
  const rate = amount => ({ schemaVersion: 1, laborRate: amount, materialMarkup: 10, equipmentMarkup: 5, capturedAt: '2026-10-01T12:00:00.000Z', capturedBy: { id: 1, name: 'Synthetic Owner', role: 'owner' }, source: 'first-office-approval' });
  const row = (id, status, project, labor, extra = {}) => ({ id, project, status, dateIso: '2026-10-01', date: 'Oct 1', foreman: 'Native project_manager', notes: 'Native report ' + id, summary: 'Native scope ' + id + ((extra.flags || []).some(flag => flag.type === 'unplanned_work' && !flag.resolution) ? ' Unplanned work needs an office decision.' : ''), laborEntries: labor.map(([memberId, hours]) => ({ memberId, hours, crew: memberId === 99 ? 'Hidden crew' : 'North' })), productionEntries: [], flags: [], history: [{ action: status === 'Approved' ? 'Approved' : 'Submitted', by: 'Synthetic Owner', at: '2026-10-01T12:00:00.000Z' }], ...extra });
  db.reports = [
    row(1, 'Needs review', 0, [[13, 4]], { flags: [{ type: 'unplanned_work', message: 'Native unresolved work' }], productionEntries: [{ description: 'Native unplanned work', quantity: 1, unit: 'EA', laborHours: 4 }] }),
    row(2, 'Approved', 0, [[13, 4]], { rateSnapshot: rate(100), materials: 'Managed native materials', equipment: 'Managed native equipment' }),
    row(3, 'Draft', 0, [[13, 3]]), row(4, 'Needs review', 1, [[13, 2]]),
    row(5, 'Approved', 0, [[13, 2], [99, 8]], { rateSnapshot: rate(75), materials: 'Hidden mixed native materials', equipment: 'Hidden mixed native equipment' }),
    row(6, 'Approved', 0, [[99, 11]], { rateSnapshot: rate(500), materials: 'Fully hidden native materials' })
  ];
  db.workdays = [{ id: 201, projectId: 101, memberIds: [13], reportId: 3, status: 'ended', startedAt: '2026-10-01T08:00:00.000Z', endedAt: '2026-10-01T11:00:00.000Z' }];
  db.photos = [{ id: 301, project: 0, reportId: 3, workdayId: 201, source: 'field', caption: 'Native retained fixture photo', uploader: 'Native project_manager', createdAt: '2026-10-01T10:00:00.000Z', url: '/uploads/' + filename }];
  return db;
}
async function main() {
  if (!process.env.TEST_COMPAT_DATABASE_URL) { console.log('Native report variant test skipped: TEST_COMPAT_DATABASE_URL absent; no native acceptance claimed.'); return; }
  const url = new URL(process.env.TEST_COMPAT_DATABASE_URL);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && /^\/(?:pdl_compat_|compat_test)/.test(url.pathname), 'Only an explicitly named parent-owned loopback synthetic database may run');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-report-variants-native-synthetic-')), legacyFile = path.join(dir, 'legacy.json'), platformFile = path.join(dir, 'platform.json');
  const legacy = snapshot(); legacy.company.id = B; legacy.users[0].companyId = B;
  fs.writeFileSync(legacyFile, JSON.stringify(legacy)); fs.writeFileSync(platformFile, JSON.stringify({ users: [], sessions: [], preservedSyntheticMarker: 'untouched' }));
  const legacyBytes = fs.readFileSync(legacyFile), platformBytes = fs.readFileSync(platformFile);
  for (const name of ['OPENAI_API_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SENTRY_DSN', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'PDL_PLATFORM_KEY']) process.env[name] = '';
  for (const name of ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'PDL_COMPAT_GLOBAL_FENCE_FILE']) delete process.env[name];
  Object.assign(process.env, { NODE_ENV: 'test', PDL_COMPAT_ACCOUNT_SYNTHETIC: '1', PDL_REQUIRE_AUTH: '1', PDL_DB_FILE: legacyFile, PDL_PLATFORM_FILE: platformFile, PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_WEEKLY_DIGEST: '0' });
  require('./database/supabase').loadLocalEnv = () => {};
  const originalFetch = global.fetch; let origin, externalAttempts = 0;
  global.fetch = (target, options) => { const requested = new URL(typeof target === 'string' || target instanceof URL ? target : target.url); if (!origin || requested.origin !== origin) { externalAttempts++; throw Error('External provider forbidden in native report fixture'); } return originalFetch(target, options); };
  const filename = 'synthetic-native-report-' + crypto.randomUUID() + '.png', ownedFile = path.join(__dirname, 'uploads', filename), ownedBytes = Buffer.from('Native synthetic retained photo bytes\0' + crypto.randomUUID());
  fs.mkdirSync(path.dirname(ownedFile), { recursive: true }); fs.writeFileSync(ownedFile, ownedBytes, { flag: 'wx' });
  let fixture, original, originalAbsent = false, active, mod, uninstall = () => {}, releaseCommit, success = false, restoration = null, cleanupComplete = false;
  const repositories = [], key = crypto.randomBytes(32), tokens = {}, checks = [], covered = new Set(), credentialFixtures = [];
  let httpCalls = 0;
  function install(repository) { uninstall(); active = repository; const credentials = services(repository, origin, { key }); credentialFixtures.push(credentials); uninstall = mod.installCompatibilityAccountTests({ synthetic: true, companyId: A, origin, globalOrigin: 'http://localhost:4999', repository, ...credentials, workspace: true, workspaceKey: key }); }
  async function request(route, { method = 'GET', data, token = tokens.owner, tenant = A } = {}) {
    const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(15000), headers: { 'X-PDL-Company': tenant, ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
    httpCalls++; return { status: response.status, value: await response.json(), response };
  }
  async function login(role = 'owner') { const result = await request('/api/auth/login', { method: 'POST', token: null, data: { email: role + '@example.invalid', password: initial } }); assert.equal(result.status, 200, JSON.stringify(result.value)); tokens[role] = result.value.token; return tokens[role]; }
  async function mutate(fn, repository = active) { const loaded = await repository.load(A); fn(loaded.snapshot); await repository.commit(loaded.snapshot, loaded.revision); }
  async function preview(operation, token = tokens.owner) { const identity = await request('/api/workspace-identity', { token }); assert.equal(identity.status, 200, JSON.stringify(identity.value)); return request('/api/resources/preview', { method: 'POST', token, data: { operation, expectedRevision: identity.value.revision, reason: 'Synthetic native existing report workflow review' } }); }
  const proof = reviewed => ({ token: reviewed.value.token, version: reviewed.value.version, confirmed: true, requestId: crypto.randomUUID() });
  const confirm = (operation, identity, token = tokens.owner) => request(operation.path, { method: operation.method, data: identity, token });
  function assertPrivate(value) { const text = JSON.stringify(value); for (const name of ['resourcePreviews', 'resourceReceipts', 'resourceReconciliations', 'retained', 'sessions', 'tokenHash', 'passwordHash', 'passwordSalt', 'sessionBinding', 'sessionHash']) assert.equal(text.includes('"' + name + '"'), false, 'private native custody key leaked: ' + name); }
  async function save(operation, token = tokens.owner) {
    const before = await active.load(A), reviewed = await preview(operation, token); assert.equal(reviewed.status, 200, operation.kind + ': ' + JSON.stringify(reviewed.value)); assertPrivate(reviewed.value);
    const afterPreview = await active.load(A); assert.equal(afterPreview.revision, before.revision + 1); assert.equal(canonicalHash(closed(afterPreview.snapshot)), canonicalHash(closed(before.snapshot)), 'native resource preview changed data outside private proof');
    const identity = proof(reviewed), unchecked = await confirm(operation, { ...identity, confirmed: false }, token); assert.equal(unchecked.status, 400); assert.deepEqual(await active.load(A), afterPreview);
    const result = await confirm(operation, identity, token); assert.equal(result.status, 200, operation.kind + ': ' + JSON.stringify(result.value)); assertPrivate(result.value); assert.ok(result.response.headers.get('X-PDL-Resource-Receipt'));
    const saved = await active.load(A), receipt = saved.snapshot.resourceReceipts.find(row => row.requestId === identity.requestId); assert.ok(receipt); assert.equal(saved.revision, afterPreview.revision + 1); assert.equal(receipt.committedRevision, saved.revision); assert.equal(receipt.operation.kind, operation.kind);
    assert.ok(saved.snapshot.auditLog.some(row => row.type === 'resource_changed' && row.requestId === identity.requestId));
    const replay = await confirm(operation, identity, token); assert.equal(replay.status, 200, JSON.stringify(replay.value)); assert.equal(replay.value.originalSaveResult, true); assertPrivate(replay.value); assert.deepEqual(await active.load(A), saved, 'native replay repeated a business/receipt/history write');
    covered.add(operation.kind + ':' + operation.method); return { result, reviewed, identity, receipt, saved };
  }
  async function denied(operation, token, statuses) { const before = await active.load(A), reviewed = await preview(operation, token); assert.ok(statuses.includes(reviewed.status), operation.kind + ': ' + reviewed.status + ' ' + JSON.stringify(reviewed.value)); assert.deepEqual(await active.load(A), before); }
  async function reopen() { const repository = new CompatTenantRepository({ connectionString: process.env.TEST_COMPAT_DATABASE_URL, companyId: A, synthetic: true }); repositories.push(repository); install(repository); }
  const safetyFields = { reportType: 'superintendent', safetyItems: [{ observation: 'Native synthetic hazard', location: 'North work area', company: 'Synthetic Construction', notified: 'Native project_manager', action: 'Synthetic protection', owner: 'Native project_manager', dueDate: '2026-10-02', status: 'verified', verification: 'Synthetic checked' }], safetyTalk: 'Native synthetic safety talk', safetyTalkAttendees: 'North crew', safetyInspection: '', safetyIncident: '', noSafetyObservations: false };
  const safety = op('reportSafety', 'PATCH', '/api/reports/1/safety', safetyFields), disposition = op('reportDisposition', 'PATCH', '/api/reports/1/disposition', { resolution: 'potential_change', note: 'Native bounded daily exception' }), reportRate = op('reportRate', 'PATCH', '/api/reports/2/rate', { laborRate: '110', reason: 'Native approved historical rate review' }), projectRate = op('projectRateSettings', 'PATCH', '/api/projects/101/rate-settings', { defaultLaborRate: '120', reason: 'Native future default review' }), remove = op('reportRemove', 'DELETE', '/api/reports/3', { reason: 'Native duplicate daily review' });
  try {
    fixture = await nativeFixture(); active = fixture.repository;
    const exists = await fixture.admin.query('SELECT revision FROM public.tenant_revisions WHERE company_id=$1', [A]);
    if (!exists.rowCount) {
      originalAbsent = true; const baseline = snapshot(), pieces = split(baseline);
      await fixture.admin.query('INSERT INTO public.companies(id,slug,name) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING', [A, 'synthetic-native-report-fixture', 'Synthetic Native Report Fixture']);
      await fixture.admin.query('SELECT * FROM public.replace_tenant_records($1,0,$2::jsonb,$3,$4::jsonb)', [A, JSON.stringify(pieces.scalarData), canonicalHash(baseline), JSON.stringify(pieces.records.map(row => ({ collection: row.collection, record_key: row.recordKey, position: row.position, data: row.data })))]);
    }
    original = await active.load(A); await active.commit(seed(filename), original.revision);
    mod = require('./server'); await new Promise(resolve => mod.server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + mod.server.address().port; install(active);
    for (const role of ['owner', 'admin', 'project_manager']) await login(role);

    const source = await active.load(A), approved = source.snapshot.reports.filter(row => row.project === 0 && row.status === 'Approved'), ownerSummary = await request('/api/projects/101/tm-summary'); assert.equal(ownerSummary.status, 200, JSON.stringify(ownerSummary.value));
    assert.deepEqual(ownerSummary.value, { projectId: 101, ...reportRates.summarizeRates(source.snapshot, 0, approved), materialEntries: approved.filter(row => row.materials).length, equipmentEntries: approved.filter(row => row.equipment).length, currentDefaults: source.snapshot.projects[0].tmSettings });
    const pmSummary = await request('/api/projects/101/tm-summary', { token: tokens.project_manager }); assert.equal(pmSummary.status, 200, JSON.stringify(pmSummary.value)); assert.equal(pmSummary.value.approvedDailies, 2); assert.equal(pmSummary.value.laborHours, 6); assert.equal(pmSummary.value.laborAmount, 550); assert.equal(pmSummary.value.materialEntries, 1); assert.equal(pmSummary.value.equipmentEntries, 1); assert.equal(JSON.stringify(pmSummary.value).includes('Hidden native classification'), false); assert.deepEqual(await active.load(A), source);
    checks.push('actual native scoped T&M read preserves no-policy Owner shape and excludes hidden PM member/classification and mixed-report material/equipment facts without a write');

    await save(safety, tokens.project_manager); const dispositionSave = await save(disposition, tokens.project_manager); assert.equal(dispositionSave.saved.snapshot.changes.length, 1); assert.equal(dispositionSave.saved.snapshot.changes[0].amount, 0); assert.equal(dispositionSave.saved.snapshot.changes[0].reportId, 1);
    const oldRate = (await active.load(A)).snapshot.reports.find(row => row.id === 2).rateSnapshot; await save(reportRate, tokens.admin); let current = await active.load(A); assert.deepEqual(current.snapshot.reports.find(row => row.id === 2).rateHistory[0].previous, oldRate); assert.equal(current.snapshot.reports.find(row => row.id === 2).rateSnapshot.laborRate, 110);
    const historicalRates = canonicalHash(current.snapshot.reports); await save(projectRate, tokens.admin); current = await active.load(A); assert.equal(current.snapshot.projects[0].tmSettings.defaultLaborRate, 120); assert.equal(canonicalHash(current.snapshot.reports), historicalRates);
    checks.push('four actual report/rate handlers run behind real native preview/confirmation CAS, preserving audited historical rates and bounded zero-dollar disposition coupling');

    const exportBefore = await active.load(A), exported = await request('/api/company/export'); assert.equal(exported.status, 200, JSON.stringify(exported.value)); assert.equal(exported.value.exportMetadata.companyId, A); assert.deepEqual(exported.value.reports, exportBefore.snapshot.reports); assert.deepEqual(exported.value.projects, exportBefore.snapshot.projects); assertPrivate(exported.value); assert.equal(Object.hasOwn(exported.value, 'dailyActionPreviews'), false); assert.equal(Object.hasOwn(exported.value, 'dailyActionReceipts'), false); assert.deepEqual(await active.load(A), exportBefore); assert.equal((await request('/api/company/export', { token: tokens.admin })).status, 403);
    checks.push('actual Owner Company export after genuine native custody retains business IDs/history but excludes private proof, receipt, session and credential fields; Admin denied and no native revision advances');

    await mutate(db => { db.company.dailyRolePolicy = dailyPolicy(); db.company.dailyRolePolicy.roles.project_manager.editReports = false; }); await denied(safety, tokens.project_manager, [403]);
    const compound = { action: 'createReport', details: { projectId: 101, dateIso: '2026-10-03', status: 'Draft', foreman: 'Native project_manager', notes: 'Native compound superintendent create', laborEntries: [{ memberId: 13, hours: 3, crew: 'North' }], productionEntries: [], ...safetyFields } };
    const compoundBefore = await active.load(A), compoundPreview = await request('/api/daily-actions/preview', { method: 'POST', token: tokens.project_manager, data: compound }); assert.equal(compoundPreview.status, 200, JSON.stringify(compoundPreview.value)); let previewState = await active.load(A); assert.equal(business(previewState.snapshot), business(compoundBefore.snapshot)); assert.equal(previewState.revision, compoundBefore.revision + 1); assert.equal(compoundPreview.value.proposed.reportType, 'superintendent');
    const compoundProof = proof(compoundPreview); assert.equal((await request('/api/reports', { method: 'POST', token: tokens.project_manager, data: { ...compoundProof, confirmed: false } })).status, 400); assert.deepEqual(await active.load(A), previewState);
    const compoundSaved = await request('/api/reports', { method: 'POST', token: tokens.project_manager, data: compoundProof }); assert.equal(compoundSaved.status, 201, JSON.stringify(compoundSaved.value)); let saved = await active.load(A); assert.equal(saved.revision, previewState.revision + 1); const compoundId = compoundSaved.value.id;
    for (const [name, value] of Object.entries(safetyFields)) assert.deepEqual(saved.snapshot.reports.find(row => row.id === compoundId)[name], value, 'native compound create dropped ' + name);
    await mutate(db => { db.company.dailyRolePolicy.revision++; db.company.dailyRolePolicy.roles.project_manager.editReports = true; });
    const edit = { action: 'editReport', id: compoundId, details: { status: 'Draft', notes: 'Native compound superintendent edit', ...safetyFields, safetyTalk: 'Native atomic revised talk' } }, editBefore = await active.load(A), editPreview = await request('/api/daily-actions/preview', { method: 'POST', token: tokens.project_manager, data: edit }); assert.equal(editPreview.status, 200, JSON.stringify(editPreview.value)); previewState = await active.load(A); assert.equal(business(previewState.snapshot), business(editBefore.snapshot)); assert.equal(previewState.revision, editBefore.revision + 1);
    const editProof = proof(editPreview), editSaved = await request('/api/reports/' + compoundId, { method: 'PATCH', token: tokens.project_manager, data: editProof }); assert.equal(editSaved.status, 200, JSON.stringify(editSaved.value)); saved = await active.load(A); assert.equal(saved.revision, previewState.revision + 1); assert.equal(saved.snapshot.reports.find(row => row.id === compoundId).notes, edit.details.notes); assert.equal(saved.snapshot.reports.find(row => row.id === compoundId).safetyTalk, edit.details.safetyTalk);
    await mutate(db => { delete db.company.dailyRolePolicy; });
    checks.push('normal superintendent create without edit and subsequent edit each run main plus actual safety handler inside one native confirmation CAS with private-only preview and complete safety fields');

    const rolePreview = await preview(safety, tokens.project_manager); assert.equal(rolePreview.status, 200); const roleProof = proof(rolePreview); await mutate(db => { db.users.find(row => row.id === 3).role = 'field'; }); const roleBefore = await active.load(A); assert.ok([403, 409].includes((await confirm(safety, roleProof, tokens.project_manager)).status)); assert.deepEqual(await active.load(A), roleBefore); await mutate(db => { db.users.find(row => row.id === 3).role = 'project_manager'; });
    const stale = await preview(safety); assert.equal(stale.status, 200); const staleProof = proof(stale); await save({ ...projectRate, details: { defaultLaborRate: 130, reason: 'Native competing original financial authority' } }); const staleBefore = await active.load(A); assert.equal((await confirm(safety, staleProof)).status, 409); assert.deepEqual(await active.load(A), staleBefore);
    const foreignBefore = await active.load(A), foreign = await request('/api/resources/preview', { method: 'POST', tenant: B, data: { operation: safety, expectedRevision: foreignBefore.revision, reason: 'Native foreign tenant probe' } }); assert.ok([401, 403, 404, 409, 503].includes(foreign.status)); assert.deepEqual(await active.load(A), foreignBefore);
    checks.push('actual native current-role change, competing revision and other-company ingress prevent stale report effects, receipt/audit writes and revision changes');

    const raced = await preview(safety, tokens.project_manager); assert.equal(raced.status, 200); const racedProof = proof(raced), raceOwner = active, commit = active.commit.bind(active); let signal, armed = true;
    const paused = new Promise(resolve => { signal = resolve; }), gate = new Promise(resolve => { releaseCommit = resolve; });
    raceOwner.commit = async (candidate, ...args) => { if (armed && candidate.resourceReceipts?.at(-1)?.requestId === racedProof.requestId) { armed = false; signal(); await gate; } return commit(candidate, ...args); };
    let restricted;
    try {
      const saving = confirm(safety, racedProof, tokens.project_manager); saving.catch(() => {}); await bounded(paused, 'report native authority admission');
      const competitor = new CompatTenantRepository({ connectionString: process.env.TEST_COMPAT_DATABASE_URL, companyId: A, synthetic: true }); repositories.push(competitor);
      await mutate(db => { db.company.dailyRolePolicy = dailyPolicy(); db.company.dailyRolePolicy.roles.project_manager.editReports = false; }, competitor); restricted = await competitor.load(A); releaseCommit();
      const rejected = await bounded(saving, 'native restricted actor result'); assert.ok([403, 409].includes(rejected.status), JSON.stringify(rejected.value));
    } finally { releaseCommit?.(); releaseCommit = null; raceOwner.commit = commit; }
    assert.deepEqual(await active.load(A), restricted); await mutate(db => { delete db.company.dailyRolePolicy; });
    checks.push('a separate native connection commits current policy revocation while first report confirmation is in flight; stale candidate loses actual tenant CAS and cannot overwrite authority');

    const lostOperation = { ...safety, details: { ...safetyFields, safetyTalk: 'Native durable unknown-result safety talk' } }, lostPreview = await preview(lostOperation); assert.equal(lostPreview.status, 200); const lostProof = proof(lostPreview), lostOwner = active, nativeCommit = active.commit.bind(active); let discarded = false;
    lostOwner.commit = async (candidate, ...args) => { const result = await nativeCommit(candidate, ...args); if (!discarded && candidate.resourceReceipts?.at(-1)?.requestId === lostProof.requestId) { discarded = true; throw Object.assign(Error('Synthetic lost native COMMIT acknowledgement'), { statusCode: 503, code: 'PDL_COMMIT_OUTCOME_UNKNOWN' }); } return result; };
    try { assert.equal((await confirm(lostOperation, lostProof)).status, 503); } finally { lostOwner.commit = nativeCommit; }
    assert.equal(discarded, true); const durable = await active.load(A); assert.equal(durable.snapshot.reports.find(row => row.id === 1).safetyTalk, lostOperation.details.safetyTalk); assert.equal(durable.snapshot.resourceReceipts.filter(row => row.requestId === lostProof.requestId).length, 1);
    await reopen(); const lookup = await request('/api/resources/original-result', { method: 'POST', data: { token: lostProof.token, version: lostProof.version, requestId: lostProof.requestId, method: lostOperation.method, path: lostOperation.path } }); assert.equal(lookup.status, 200, JSON.stringify(lookup.value)); assert.deepEqual(Object.keys(lookup.value).sort(), ['originalSaveResult', 'receipt']); assert.equal(lookup.value.receipt.status, 'committed'); assertPrivate(lookup.value); assert.deepEqual(await active.load(A), durable);
    const lostReplay = await confirm(lostOperation, lostProof); assert.equal(lostReplay.status, 200, JSON.stringify(lostReplay.value)); assert.equal(lostReplay.value.originalSaveResult, true); assertPrivate(lostReplay.value); assert.deepEqual(await active.load(A), durable);
    checks.push('actual native COMMIT survives an intentionally lost acknowledgement; a fresh repository recovers the original technical receipt and exact replay never repeats report/safety/history writes');

    const beforeDelete = await active.load(A), oldReport = beforeDelete.snapshot.reports.find(row => row.id === 3), oldPhoto = beforeDelete.snapshot.photos[0], oldDay = beforeDelete.snapshot.workdays[0]; const deleted = await save(remove, tokens.project_manager);
    assert.equal(deleted.saved.snapshot.reports.some(row => row.id === 3), false); assert.deepEqual(deleted.saved.snapshot.photos[0], { ...oldPhoto, reportId: null }); assert.deepEqual(deleted.saved.snapshot.workdays[0], { ...oldDay, reportId: null }); assert.deepEqual(deleted.receipt.retained.report, oldReport); assert.deepEqual(deleted.receipt.retained.photos, [oldPhoto]); assert.deepEqual(deleted.receipt.retained.workdays, [oldDay]); assert.deepEqual(fs.readFileSync(ownedFile), ownedBytes);
    checks.push('fifth actual native writer removes only its reviewed daily, privately retains exact report/photo/workday history and references, detaches live links and preserves actual owned attachment bytes through replay');

    // Use a real SQL deadline and hold the actual COMMIT, including the deferred
    // trigger. Date.now is never overridden and cannot simulate SQL expiry.
    await login(); const expiryResult = await fixture.admin.query("SELECT clock_timestamp() + interval '3 seconds' AS expires_at"), expiry = new Date(expiryResult.rows[0].expires_at).toISOString(), ownerHash = hash(tokens.owner);
    await mutate(db => { db.sessions.find(row => row.tokenHash === ownerHash).expiresAt = expiry; });
    const expires = await preview({ ...safety, details: { ...safetyFields, safetyTalk: 'Native expired COMMIT must roll back' } }); assert.equal(expires.status, 200, JSON.stringify(expires.value)); assert.equal(expires.value.expiresAt, expiry); const expiryProof = proof(expires), unchanged = await active.load(A);
    const expiryOwner = active, connect = active.pool.connect.bind(active.pool), originals = new Map(); let commitSignal, commitArmed = true, sqlExpired = false;
    const commitPaused = new Promise(resolve => { commitSignal = resolve; }), commitGate = new Promise(resolve => { releaseCommit = resolve; });
    expiryOwner.pool.connect = async (...args) => { const client = await connect(...args); if (!originals.has(client)) originals.set(client, client.query.bind(client)); const query = originals.get(client); let written = false; client.query = async (text, ...rest) => { if (typeof text === 'string' && text.startsWith('SELECT * FROM public.replace_tenant_records')) written = true; if (commitArmed && written && text === 'COMMIT') { commitArmed = false; commitSignal(); await commitGate; } return query(text, ...rest); }; return client; };
    try {
      const saving = confirm(safety, expiryProof); saving.catch(() => {}); await bounded(commitPaused, 'actual report SQL COMMIT');
      await fixture.admin.query("SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp()))) + 0.08)", [expiry]);
      const clock = await fixture.admin.query('SELECT clock_timestamp() >= $1::timestamptz AS expired', [expiry]); sqlExpired = clock.rows[0].expired === true; assert.equal(sqlExpired, true); releaseCommit();
      const rejected = await bounded(saving, 'actual SQL deferred deadline result'); assert.ok([409, 503].includes(rejected.status), JSON.stringify(rejected.value));
    } finally { releaseCommit?.(); releaseCommit = null; expiryOwner.pool.connect = connect; for (const [client, query] of originals) client.query = query; }
    assert.deepEqual(await active.load(A), unchanged); assert.deepEqual(fs.readFileSync(ownedFile), ownedBytes);
    checks.push('actual PostgreSQL COMMIT held until SQL clock expiry rolls back report/safety/history/audit/receipt/hash/revision through the deferred deadline trigger; no simulated JavaScript clock');
    assert.deepEqual(fs.readFileSync(legacyFile), legacyBytes); assert.deepEqual(fs.readFileSync(platformFile), platformBytes); assert.equal(externalAttempts, 0); assert.equal(credentialFixtures.reduce((sum, item) => sum + item.messages.length, 0), 0); success = true;
  } finally {
    releaseCommit?.(); uninstall(); global.fetch = originalFetch;
    if (mod?.server.listening) { mod.server.closeAllConnections(); await new Promise(resolve => mod.server.close(resolve)); }
    let restorationError, cleanupError;
    try {
      if (original && active) { const current = await active.load(A); await active.commit(original.snapshot, current.revision); const restored = await active.load(A); assert.deepEqual(restored.snapshot, original.snapshot); assert.equal(restored.contentHash, original.contentHash); assert.ok(restored.revision > original.revision); restoration = { restored: true, originalRevision: original.revision, restoredRevision: restored.revision, contentHash: restored.contentHash, initialTenantAbsent: originalAbsent, ...(originalAbsent ? { newlyOwnedBaselinePreserved: true } : {}) }; }
      else restoration = { restored: false, fixtureUnavailable: true };
    } catch (error) { restorationError = error; }
    try {
      const failures = [], results = await Promise.allSettled(repositories.map(repository => repository.close()));
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason);
      try { await fixture?.close(); } catch (error) { failures.push(error); }
      try { if (fs.existsSync(ownedFile)) fs.unlinkSync(ownedFile); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'Owned native report fixture cleanup failed');
      cleanupComplete = true;
    } catch (error) { cleanupError = error; }
    const result = { nativeReportVariantChecks: checks, passed: checks.length, httpCalls, backend: 'owned-native-postgres', writerCoverage: [...covered].sort(), compoundDailySignatures: 2, scopedReadSignatures: 2, externalAttemptCount: externalAttempts, syntheticCredentialMessageCount: credentialFixtures.reduce((sum, item) => sum + item.messages.length, 0), actualDeferredSqlDeadline: checks.some(item => item.startsWith('actual PostgreSQL COMMIT')), fixtureRestoration: restoration, ownedCleanupComplete: cleanupComplete, completed: success && restoration?.restored === true && cleanupComplete && !restorationError && !cleanupError, syntheticOnly: true, productionReady: false, sourceSha: process.env.PDL_COMPAT_SOURCE_SHA || null, sourceHashes: Object.fromEntries(sourceFiles.map(name => [name, hash(fs.readFileSync(path.join(__dirname, name)))])) };
    if (process.env.PDL_COMPAT_BROWSER_EVIDENCE) { fs.mkdirSync(process.env.PDL_COMPAT_BROWSER_EVIDENCE, { recursive: true }); fs.writeFileSync(path.join(process.env.PDL_COMPAT_BROWSER_EVIDENCE, 'resource-report-variants-native-http.json'), JSON.stringify(result, null, 2)); }
    console.log(JSON.stringify(result)); if (restorationError) throw restorationError; if (cleanupError) throw cleanupError;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
