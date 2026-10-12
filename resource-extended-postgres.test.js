'use strict';
// Real loopback HTTP and native tenant CAS, exclusively in an explicitly owned
// synthetic fixture. Root runs this serially; this file never starts PostgreSQL.
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { A, B, initial, credential, snapshot } = require('./compat-account-fixture');
const { workspaceSnapshot } = require('./compat-workspace-fixture');
const { services } = require('./compat-lifecycle-fixture');
const { nativeFixture } = require('./compat-lifecycle-native-fixture');
const { CompatTenantRepository, split } = require('./database/compat-tenant-repository');
const { canonicalHash } = require('./database/transactional-repository');
const registry = require('./capability-registry');
const delivery = require('./compat-workspace-delivery');
const sourceFiles = ['resource-admission.js', 'resource-inputs.js', 'resource-deltas.js', 'resource-templates.js', 'resource-catalog-contract.js', 'resource-subcontractors.js', 'resource-project-tasks.js', 'compat-workspace.js', 'compat-workspace-delivery.js', 'compat-assignment-delivery.js', 'resource-extended-postgres.test.js'];
const closedSnapshot = db => Object.fromEntries(Object.entries(db).filter(([key]) => !['resourcePreviews', 'resourceReceipts', 'resourceReconciliations'].includes(key)));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function bounded(promise, label, ms = 12000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Synthetic native timeout: ' + label)), ms); timer.unref(); })]).finally(() => clearTimeout(timer));
}
function seed() {
  const db = workspaceSnapshot(); db.team[0].crew = 'Office'; db.team[1].crew = 'North';
  // The shared fixture's baseline shift uses today's date. Keep it outside this
  // fixed four-day task matrix; only the explicit bookings below define overlap.
  for(const assignment of db.assignments)assignment.date='2026-09-30';
  Object.assign(db.company, { contractValueTracking: true, defaultTemplateId: 'standard' });
  Object.assign(db.projects[0], { startDate: '2026-10-05', endDate: '2026-12-31', templateId: 21, templateIds: ['21'], templateVersion: 1 });
  db.projects.push({ id: 102, name: 'Native other project', status: 'Active', startDate: '2026-10-05', endDate: '2026-12-31', estimateItems: [], templateId: 'standard' });
  for (const [id, memberId, role, name] of [[3, 13, 'admin', 'admin'], [4, 14, 'project_manager', 'pm'], [5, 15, 'foreman', 'foreman']]) {
    db.users.push({ id, memberId, companyId: A, name: 'Native ' + name, email: name + '@example.invalid', status: 'Active', role, ...credential(initial), projectIds: [101], assignedCrews: ['North'], permissions: { scheduleCrews: true, viewDailies: true, approveDailies: true, viewTime: true, manageTime: true } });
    db.team.push({ id: memberId, name: 'Native ' + name, crew: role === 'admin' ? 'Office' : 'North', role: 'Synthetic employee', initials: 'NS', hours: 0 });
  }
  db.team.push({ id: 16, name: 'Native South member', crew: 'South', role: 'Synthetic employee', initials: 'SO', hours: 0 });
  db.crews = [{ id: 1, name: 'North' }, { id: 2, name: 'South' }];
  db.dailyTemplates = [{ id: 21, name: 'Native historical form', locked: false, category: 'daily', description: 'Historical pinned template', requirements: { photo: false, signature: false, acknowledgement: false }, assignment: { crewNames: [], workTypes: [] }, reviewNotice: '', versions: [{ version: 1, name: 'Native historical form', fields: [{ id: 'old-observation', label: 'Old observation', type: 'text', required: false, help: '' }], createdAt: '2026-09-01T00:00:00.000Z', createdBy: 'Synthetic Owner' }] }];
  Object.assign(db.reports[0], { templateId: 21, templateVersion: 1, customFields: { 'old-observation': 'Historical answer' }, subcontractorId: 7 });
  db.timeCards = [{ id: 1, memberId: 12, projectId: 101, date: '2026-10-01', hours: 2, status: 'Approved', history: [{ action: 'Historical approval', by: 'Synthetic Owner', at: '2026-10-01T00:00:00.000Z' }] }];
  db.projectTasks = [
    { id: 1, projectId: 101, name: 'Native first task', durationDays: 2, predecessorIds: [], memberIds: [14], crew: 'North', status: 'not-started', startDate: '2026-10-05', endDate: '2026-10-06', createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'Synthetic Owner' },
    { id: 2, projectId: 101, name: 'Native linked task', durationDays: 2, predecessorIds: [1], memberIds: [14], crew: 'North', status: 'in-progress', startDate: '2026-10-07', endDate: '2026-10-08', createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'Synthetic Owner' },
    { id: 3, projectId: 102, name: 'Native foreign task', durationDays: 1, predecessorIds: [], memberIds: [16], crew: 'South', status: 'done', startDate: '2026-10-05', endDate: '2026-10-05', createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'Synthetic Owner' }
  ];
  const compliance = { insuranceExpiration: '2027-12-31', workersCompExpiration: '2027-12-31', licenseNumber: 'NATIVE-LICENSE', licenseExpiration: '2027-12-31', w9Received: true, agreementSigned: true, autoComplianceReminders: false };
  db.subcontractors = [{ id: 7, name: 'Native subcontractor', contact: 'Native contact', email: 'sub@example.invalid', phone: '555-123-4567', trade: 'Tile', notes: 'Original native notes', ...compliance, status: 'Active', archivedAt: null, complianceReminderStages: { insurance: '30' }, complianceHistory: [{ action: 'Historical review', at: '2026-09-01T00:00:00.000Z' }], projectIds: [101, 102] }, { id: 8, name: 'Native other subcontractor', email: 'other-sub@example.invalid', ...compliance, status: 'Active', archivedAt: null }];
  db.subcontractorLinks = [{ id: 1, subcontractorId: 7, projectId: 101, status: 'Active', tokenHash: '1'.repeat(64) }, { id: 2, subcontractorId: 7, projectId: 102, status: 'Active', tokenHash: '2'.repeat(64) }, { id: 3, subcontractorId: 8, projectId: 102, status: 'Active', tokenHash: '3'.repeat(64) }];
  return db;
}

async function main() {
  if (!process.env.TEST_COMPAT_DATABASE_URL) { console.log('Extended native resource test skipped: TEST_COMPAT_DATABASE_URL absent.'); return; }
  const url = new URL(process.env.TEST_COMPAT_DATABASE_URL);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && /^\/(?:pdl_compat_|compat_test)/.test(url.pathname), 'Only an explicitly named local synthetic database may run this test');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-resource-extended-native-'));
  const legacyFile = path.join(dir, 'legacy.json'), platformFile = path.join(dir, 'platform.json');
  const legacy = snapshot(); legacy.company.id = B; legacy.users[0].companyId = B;
  fs.writeFileSync(legacyFile, JSON.stringify(legacy)); fs.writeFileSync(platformFile, JSON.stringify({ users: [], sessions: [], preservedSyntheticMarker: 'untouched' }));
  const legacyBytes = fs.readFileSync(legacyFile), platformBytes = fs.readFileSync(platformFile);
  for (const name of ['OPENAI_API_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SENTRY_DSN', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'PDL_PLATFORM_KEY']) process.env[name] = '';
  Object.assign(process.env, { NODE_ENV: 'test', PDL_COMPAT_ACCOUNT_SYNTHETIC: '1', PDL_REQUIRE_AUTH: '1', PDL_DB_FILE: legacyFile, PDL_PLATFORM_FILE: platformFile, PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_WEEKLY_DIGEST: '0' });
  require('./database/supabase').loadLocalEnv = () => {};
  const fixture = await nativeFixture(), repositories = [fixture.repository], key = crypto.randomBytes(32), checks = [], covered = new Set(), tokens = {}, assignmentMessages = [];
  const originalRow = await fixture.admin.query('SELECT revision FROM public.tenant_revisions WHERE company_id=$1', [A]);
  const original = originalRow.rowCount ? await fixture.repository.load(A) : null;
  let active = fixture.repository, uninstall = () => {}, mod, origin, releaseCommit, assignmentExpected, unexpectedCompliance = 0, externalAttempts = 0, restoration = null, success = false;
  const nativeSeed = seed(), historical = canonicalHash({ reports: nativeSeed.reports, timeCards: nativeSeed.timeCards }), foreignTask = structuredClone(nativeSeed.projectTasks[2]), originalFetch = globalThis.fetch;
  function authenticateSession(db, tokenHash) {
    const session = db.sessions.find(row => row.tokenHash === tokenHash), user = session && db.users.find(row => row.id === session.userId && row.status === 'Active');
    return user ? { companyId: A, session, user: registry.actor(db, registry.normalize(user)) } : null;
  }
  const compliance = () => delivery.createCompliance({ repository: active, companyId: A, key, requirements: () => [{ key: 'insurance', label: 'Insurance certificate', state: 'missing', stage: 'missing' }], send: () => { throw Error('Compliance send forbidden'); }, authenticateSession, accountAccess: () => ({ locked: false }) });
  async function assignmentSend(source, options) {
    const current = await active.load(A), receipt = current.snapshot.resourceReceipts.find(row => row.requestId === assignmentExpected?.requestId);
    assert.ok(receipt && receipt.operation.kind === 'projectTaskAssign', 'Native business receipt must precede fake assignment send');
    assert.ok(current.revision > receipt.committedRevision, 'Native sending claim must precede fake provider');
    const job = current.snapshot.workspaceAssignmentJobs.find(row => row.id === options.idempotencyKey);
    assert.ok(job && job.status === 'sending'); assert.equal(source.memberId, assignmentExpected.memberId); assert.equal(source.to, 'field@example.invalid');
    assignmentMessages.push({ source: structuredClone(source), idempotencyKey: options.idempotencyKey });
    return { status: 'accepted' };
  }
  function install(repository) {
    uninstall(); active = repository;
    uninstall = mod.installCompatibilityAccountTests({ synthetic: true, companyId: A, origin, globalOrigin: 'http://localhost:4999', repository: active, ...services(active, origin, { key }), workspace: true, workspaceKey: key, assignmentSend, complianceSend: async () => { unexpectedCompliance++; throw Error('Resource writes must not send compliance emails'); } });
  }
  async function request(route, { method = 'GET', data, token = tokens.owner, tenant = A } = {}) {
    const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(15000), headers: { 'X-PDL-Company': tenant, ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, value: await response.json() };
  }
  async function login(name = 'owner') {
    const result = await request('/api/auth/login', { method: 'POST', data: { email: name + '@example.invalid', password: initial }, token: null });
    assert.equal(result.status, 200, JSON.stringify(result.value)); tokens[name] = result.value.token; return tokens[name];
  }
  async function mutate(change) { const loaded = await active.load(A); change(loaded.snapshot); await active.commit(loaded.snapshot, loaded.revision); }
  async function preview(kind, method, route, details, token = tokens.owner) {
    const identity = await request('/api/workspace-identity', { token }); assert.equal(identity.status, 200, JSON.stringify(identity.value));
    return request('/api/resources/preview', { method: 'POST', token, data: { operation: { kind, method, path: route, details }, expectedRevision: identity.value.revision, reason: 'Synthetic native extended resource review' } });
  }
  const proof = p => ({ token: p.value.token, version: p.value.version, confirmed: true, requestId: crypto.randomUUID() });
  const lookupDetails = (identity, method, route) => ({ token: identity.token, version: identity.version, requestId: identity.requestId, method, path: route });
  async function save(kind, method, route, details, token = tokens.owner) {
    const before = await active.load(A), sends = assignmentMessages.length, p = await preview(kind, method, route, details, token);
    assert.equal(p.status, 200, kind + ' preview: ' + JSON.stringify(p.value));
    const reviewed = await active.load(A); assert.equal(reviewed.revision, before.revision + 1); assert.equal(canonicalHash(closedSnapshot(reviewed.snapshot)), canonicalHash(closedSnapshot(before.snapshot)), 'Preview may only retain its private review'); assert.equal(assignmentMessages.length, sends, 'Preview must never send');
    const identity = proof(p); if (kind === 'projectTaskAssign') assignmentExpected = { requestId: identity.requestId, memberId: details.memberId };
    const r = await request(route, { method, token, data: identity }), expected = ['templateCreate', 'catalogCreate', 'catalogApply', 'subcontractorCreate', 'projectTaskCreate'].includes(kind) ? 201 : 200;
    assert.equal(r.status, expected, kind + ' confirm: ' + JSON.stringify(r.value));
    const saved = await active.load(A), receipt = saved.snapshot.resourceReceipts.find(row => row.requestId === identity.requestId);
    assert.ok(receipt); assert.equal(receipt.committedRevision, reviewed.revision + 1); assert.equal(receipt.operation.kind, kind);
    const sent = assignmentMessages.length, replay = await request(route, { method, token, data: identity }); assert.equal(replay.status, expected, kind + ' replay: ' + JSON.stringify(replay.value)); assert.equal(replay.value.originalSaveResult, true);
    assert.deepEqual(await active.load(A), saved, 'Original replay must not mutate native data, history, receipts or revision'); assert.equal(assignmentMessages.length, sent, 'Replay must not resend');
    covered.add(kind + ':' + method); return { p, r, identity, receipt, saved };
  }
  async function deny(kind, method, route, details, token, status) {
    const before = await active.load(A), p = await preview(kind, method, route, details, token);
    assert.equal(p.status, status, kind + ' denial: ' + JSON.stringify(p.value)); assert.deepEqual(await active.load(A), before, 'Denied preview must not mutate native storage');
  }
  async function reopen() { const repository = new CompatTenantRepository({ connectionString: process.env.TEST_COMPAT_DATABASE_URL, companyId: A, synthetic: true }); repositories.push(repository); install(repository); }
  async function loseAck(kind, method, route, details) {
    const p = await preview(kind, method, route, details); assert.equal(p.status, 200, JSON.stringify(p.value));
    const identity = proof(p), commit = active.commit.bind(active), owner = active; let lost = false;
    if (kind === 'projectTaskAssign') assignmentExpected = { requestId: identity.requestId, memberId: details.memberId };
    owner.commit = async (candidate, ...args) => { const result = await commit(candidate, ...args); if (!lost && candidate.resourceReceipts?.at(-1)?.requestId === identity.requestId) { lost = true; throw Object.assign(Error('Synthetic native lost business COMMIT acknowledgement'), { statusCode: 503, code: 'PDL_COMMIT_OUTCOME_UNKNOWN' }); } return result; };
    try { assert.equal((await request(route, { method, data: identity })).status, 503); }
    finally { owner.commit = commit; }
    assert.equal(lost, true); const durable = await active.load(A), sends = assignmentMessages.length;
    assert.equal(durable.snapshot.resourceReceipts.filter(row => row.requestId === identity.requestId).length, 1);
    await reopen(); const lookup = await request('/api/resources/original-result', { method: 'POST', data: lookupDetails(identity, method, route) });
    assert.equal(lookup.status, 200, JSON.stringify(lookup.value)); assert.deepEqual(Object.keys(lookup.value).sort(), ['originalSaveResult', 'receipt']); assert.equal(lookup.value.receipt.status, 'committed');
    assert.deepEqual(await active.load(A), durable); assert.equal(assignmentMessages.length, sends, 'Technical outcome lookup must not send');
    return { identity, durable, sends };
  }
  async function expiryRollback(kind, method, route, details) {
    await login(); const expiry = new Date(Date.now() + 2200).toISOString(), tokenHash = hash(tokens.owner);
    await mutate(db => { db.sessions.find(row => row.tokenHash === tokenHash).expiresAt = expiry; });
    const p = await preview(kind, method, route, details); assert.equal(p.status, 200, JSON.stringify(p.value)); assert.equal(p.value.expiresAt, expiry);
    const identity = proof(p), unchanged = await active.load(A), sends = assignmentMessages.length;
    if (kind === 'projectTaskAssign') assignmentExpected = { requestId: identity.requestId, memberId: details.memberId };
    const connect = active.pool.connect.bind(active.pool), originals = new Map(); let signal, armed = true;
    const paused = new Promise(resolve => { signal = resolve; }), gate = new Promise(resolve => { releaseCommit = resolve; });
    active.pool.connect = async (...args) => {
      const client = await connect(...args); if (!originals.has(client)) originals.set(client, client.query.bind(client)); const query = originals.get(client); let written = false;
      client.query = async (text, ...rest) => { if (typeof text === 'string' && text.startsWith('SELECT * FROM public.replace_tenant_records')) written = true; if (armed && written && text === 'COMMIT') { armed = false; signal(); await gate; } return query(text, ...rest); }; return client;
    };
    try {
      const saving = request(route, { method, data: identity }); saving.catch(() => {});
      await bounded(paused, kind + ' actual SQL COMMIT'); await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(expiry) - Date.now() + 120))); releaseCommit();
      const rejected = await bounded(saving, kind + ' expiry result'); assert.ok([409, 503].includes(rejected.status), JSON.stringify(rejected.value));
    } finally { releaseCommit?.(); releaseCommit = null; active.pool.connect = connect; for (const [client, query] of originals) client.query = query; }
    assert.deepEqual(await active.load(A), unchanged, 'Deferred SQL session guard must roll back every business, receipt, audit, job, hash and revision change'); assert.equal(assignmentMessages.length, sends, 'Rolled-back assignment must never send');
  }
  try {
    // Preserve any pre-existing owned fixture snapshot. No reset/delete, history
    // cleanup, raw revision rewind or modification of another tenant occurs.
    if (original) await active.commit(nativeSeed, original.revision);
    else {
      const pieces = split(nativeSeed);
      await fixture.admin.query('INSERT INTO public.companies(id,slug,name) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING', [A, 'synthetic-extended-resources', 'Synthetic Extended Resources']);
      await fixture.admin.query('SELECT * FROM public.replace_tenant_records($1,0,$2::jsonb,$3,$4::jsonb)', [A, JSON.stringify(pieces.scalarData), canonicalHash(nativeSeed), JSON.stringify(pieces.records.map(row => ({ collection: row.collection, record_key: row.recordKey, position: row.position, data: row.data })))]);
    }
    mod = require('./server'); await new Promise(resolve => mod.server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + mod.server.address().port;
    globalThis.fetch = (target, options) => { const requested = new URL(typeof target === 'string' || target instanceof URL ? target : target.url); if (requested.origin !== origin) { externalAttempts++; throw Error('External requests forbidden in synthetic native resource test'); } return originalFetch(target, options); };
    install(active); await login(); await login('admin'); await login('pm'); await login('field'); await login('foreman');
    const added = await save('templateCreate', 'POST', '/api/daily-templates', { name: 'Native new form', category: 'quality', fields: [{ label: 'Quality checked', type: 'yesno', required: true }] });
    const templateId = added.r.value.id, templateRoute = '/api/daily-templates/' + templateId, firstVersion = structuredClone(added.saved.snapshot.dailyTemplates.find(row => row.id === templateId).versions[0]);
    await save('templateEdit', 'PATCH', templateRoute, { name: 'Native reviewed form', fields: [{ id: 'quality-checked', label: 'Quality checked', type: 'yesno', required: true, help: 'Review current work' }] });
    await save('templateDefault', 'POST', '/api/daily-templates/default', { templateId: String(templateId) });
    await save('projectTemplates', 'PATCH', '/api/projects/101/template', { templateIds: [String(templateId), 'standard'] });
    const unused = await save('templateCreate', 'POST', '/api/daily-templates', { name: 'Native disposable unreferenced form', fields: [] });
    const removed = await save('templateRemove', 'DELETE', '/api/daily-templates/' + unused.r.value.id, {}); assert.equal(removed.saved.snapshot.dailyTemplates.some(row => row.id === unused.r.value.id), false);
    assert.deepEqual((await active.load(A)).snapshot.dailyTemplates.find(row => row.id === templateId).versions[0], firstVersion); assert.equal((await active.load(A)).snapshot.projects[0].templateVersion, 2); checks.push('all five native template writers preserve version history and historical report pins');
    const catalog = await save('catalogCreate', 'POST', '/api/catalog', { name: 'Native catalog tile', category: 'Tile', unit: 'sf', targetHoursPerUnit: 0.25, description: 'Synthetic native catalog item' }, tokens.pm);
    const applied = await save('catalogApply', 'POST', '/api/catalog/' + catalog.r.value.id + '/apply', { projectId: 101, plannedQuantity: 12 }, tokens.pm); assert.equal(applied.r.value.budgetHours, 3);
    await deny('catalogApply', 'POST', '/api/catalog/' + catalog.r.value.id + '/apply', { projectId: 102, plannedQuantity: 1 }, tokens.pm, 404); checks.push('both native catalog writers enforce PM destination project scope and append one stable estimate row');
    const subcontractor = await save('subcontractorCreate', 'POST', '/api/subcontractors', { name: 'Native newly added subcontractor', email: 'new-sub@example.invalid', phone: '555-789-0123', insuranceExpiration: '2027-12-31', workersCompExpiration: '2027-12-31', licenseExpiration: '2027-12-31', w9Received: true, agreementSigned: true, autoComplianceReminders: false });
    await save('subcontractorProfile', 'PATCH', '/api/subcontractors/' + subcontractor.r.value.id + '/profile', { contact: 'Native current contact', notes: 'Native current notes' }, tokens.admin);
    await save('subcontractorCompliance', 'PATCH', '/api/subcontractors/' + subcontractor.r.value.id, { licenseNumber: 'NEW-NATIVE-LICENSE' });
    await mutate(db => { const sub = db.subcontractors.find(row => row.id === 7); sub.insuranceExpiration = ''; sub.autoComplianceReminders = true; sub.complianceReminderStages = {}; const actor = authenticateSession(db, hash(tokens.owner)); compliance().stage(db, { auth: actor }); });
    const beforeArchive = await active.load(A), archived = await save('subcontractorArchive', 'PATCH', '/api/subcontractors/7/archive', { archived: true, reason: 'Native bounded archive review' });
    assert.equal(archived.saved.snapshot.workspaceComplianceJobs.find(row => row.source.subcontractorId === 7).status, 'cancelled'); assert.equal(archived.saved.snapshot.subcontractorLinks.filter(row => row.subcontractorId === 7 && row.status === 'Active').length, 0);
    assert.deepEqual(archived.saved.snapshot.subcontractorLinks.find(row => row.subcontractorId === 8), beforeArchive.snapshot.subcontractorLinks.find(row => row.subcontractorId === 8)); assert.deepEqual(archived.saved.snapshot.subcontractors.find(row => row.id === 7).complianceHistory.slice(0, beforeArchive.snapshot.subcontractors.find(row => row.id === 7).complianceHistory.length), beforeArchive.snapshot.subcontractors.find(row => row.id === 7).complianceHistory);
    await deny('subcontractorCompliance', 'PATCH', '/api/subcontractors/7', { notes: 'No PM grant' }, tokens.pm, 403); checks.push('all four native subcontractor writers retain history and atomically revoke target links/cancel signed queued jobs without sending');
    await save('projectContract', 'PATCH', '/api/projects/101', { contractValue: 1234.56 }); await save('projectContract', 'PUT', '/api/projects/101', { contractValue: 2345.67 });
    await mutate(db => { db.company.contractValueTracking = false; }); await deny('projectContract', 'PUT', '/api/projects/101', { contractValue: 9 }, tokens.owner, 409); await mutate(db => { db.company.contractValueTracking = true; }); checks.push('native PATCH and PUT contract writers share immutable pricing/tracking boundaries');
    const dates = await save('projectDates', 'PATCH', '/api/projects/101', { startDate: '2026-10-06', endDate: '2026-12-30' }); assert.equal(dates.r.value.tasks.find(row => row.id === 1).startDate, '2026-10-06'); assert.equal(dates.r.value.tasks.find(row => row.id === 2).startDate, '2026-10-08');
    const createdTask = await save('projectTaskCreate', 'POST', '/api/projects/101/tasks', { name: 'Native task lane', durationDays: 4, predecessorIds: [2], memberIds: [14], crew: 'North' });
    const laneId = createdTask.r.value.tasks.find(row => row.name === 'Native task lane').id, laneRoute = '/api/project-tasks/' + laneId;
    await save('projectTaskEdit', 'PATCH', laneRoute, { name: 'Native reviewed task lane', status: 'in-progress' });
    const readTasks = await request('/api/projects/101/tasks', { token: tokens.pm }); assert.equal(readTasks.status, 200); assert.equal(readTasks.value.find(row => row.id === laneId).startDate, '2026-10-12'); assert.equal((await request('/api/projects/102/tasks', { token: tokens.pm })).status, 404); assert.equal((await request('/api/projects/102/tasks', { token: tokens.foreman })).status, 404);
    await mutate(db => { db.assignments.push({ id: 50, projectId: 101, memberIds: [14], date: '2026-10-13', start: '07:00', end: '15:30', activity: 'Native merge shift', crew: 'North', notifications: {}, acknowledgements: {} }, { id: 51, projectId: 102, memberIds: [12], date: '2026-10-14', start: '07:00', end: '15:30', activity: 'Native other booking', notifications: {}, acknowledgements: {} }); db.timeOffRequests.push({ id: 1, memberId: 12, startDate: '2026-10-15', endDate: '2026-10-15', allDay: true, type: 'vacation', status: 'approved', history: [] }); });
    const assignment = await save('projectTaskAssign', 'POST', laneRoute + '/assign', { memberId: 12 }, tokens.pm); assert.deepEqual([assignment.r.value.created, assignment.r.value.merged, assignment.r.value.skipped], [1, 1, 2]); assert.equal(assignmentMessages.length, 1); assert.deepEqual(assignmentMessages[0].source.assignments.map(row => row.date).sort(), ['2026-10-12', '2026-10-13']); assert.equal(assignment.saved.snapshot.workspaceAssignmentJobs.find(row => row.id === assignmentMessages[0].idempotencyKey).status, 'sent');
    const oldShifts = canonicalHash(assignment.saved.snapshot.assignments); await save('projectTaskRemove', 'DELETE', '/api/project-tasks/1', {}); assert.equal(canonicalHash((await active.load(A)).snapshot.assignments), oldShifts); assert.deepEqual((await active.load(A)).snapshot.projectTasks.find(row => row.id === 3), foreignTask); checks.push('native task read/create/edit/delete/date cascade and assignee-only fake outbox follow business and claim CAS; replay never duplicates shifts or sends');
    const requiredWriters = ['templateCreate:POST', 'templateEdit:PATCH', 'templateRemove:DELETE', 'templateDefault:POST', 'projectTemplates:PATCH', 'catalogCreate:POST', 'catalogApply:POST', 'subcontractorCreate:POST', 'subcontractorProfile:PATCH', 'subcontractorCompliance:PATCH', 'subcontractorArchive:PATCH', 'projectContract:PATCH', 'projectContract:PUT']; assert.ok(requiredWriters.every(value => covered.has(value))); checks.push('all thirteen remaining resource writer signatures confirmed and replayed against actual native SQL storage');
    const competingA = await preview('templateEdit', 'PATCH', templateRoute, { description: 'Native stale competing description' }), competingB = await preview('templateEdit', 'PATCH', templateRoute, { description: 'Native current competing description' }); assert.equal(competingA.status, 200); assert.equal(competingB.status, 200);
    assert.equal((await request(templateRoute, { method: 'PATCH', data: proof(competingA) })).status, 409); assert.equal((await request(templateRoute, { method: 'PATCH', data: proof(competingB) })).status, 200); assert.equal((await active.load(A)).snapshot.dailyTemplates.find(row => row.id === templateId).description, 'Native current competing description'); checks.push('competing compound template previews bind exact native review revision');
    await loseAck('templateEdit', 'PATCH', templateRoute, { description: 'Native durable lost template acknowledgement' }); checks.push('template history and original signed receipt survive native COMMIT ACK loss and fresh repository lookup');
    await loseAck('subcontractorArchive', 'PATCH', '/api/subcontractors/7/archive', { archived: false }); assert.equal((await active.load(A)).snapshot.subcontractors.find(row => row.id === 7).archivedAt, null); assert.equal((await active.load(A)).snapshot.subcontractorLinks.filter(row => row.subcontractorId === 7 && row.status === 'Active').length, 0); checks.push('compound archive/restore history survives lost ACK/reopen and never restores revoked guest grants');
    const recoveryLane = await save('projectTaskCreate', 'POST', '/api/projects/101/tasks', { name: 'Native lost-ACK assignment', durationDays: 1, predecessorIds: [], memberIds: [14], crew: 'North' });
    const recoveryLaneId = recoveryLane.r.value.tasks.find(row => row.name === 'Native lost-ACK assignment').id, recoveryPath = '/api/project-tasks/' + recoveryLaneId + '/assign';
    // The one-day lane may overlap an existing project shift; choosing its
    // current start date retains the actual merge/skip rules, not a fake date.
    const recoveryStart = recoveryLane.r.value.tasks.find(row => row.id === recoveryLaneId).startDate;
    assert.equal((await active.load(A)).snapshot.assignments.some(row => row.date === recoveryStart && row.memberIds.includes(12)), false, 'Recovery fixture uses a free current lane date and does not erase historical shifts');
    const lostAssignment = await loseAck('projectTaskAssign', 'POST', recoveryPath, { memberId: 12 });
    const queued = lostAssignment.durable.snapshot.workspaceAssignmentJobs.filter(row => row.status === 'queued' && row.source.memberId === 12); assert.equal(queued.length, 1); assert.equal(assignmentMessages.length, lostAssignment.sends);
    const originalAssignmentReceipt = lostAssignment.durable.snapshot.resourceReceipts.find(row => row.requestId === lostAssignment.identity.requestId);
    assert.deepEqual(originalAssignmentReceipt.retained.assignmentJobs, queued.map(row => ({ id: row.id, sourceHash: row.sourceHash })), 'Exact original delivery IDs and source hashes belong to the same durable signed business receipt');
    // A different correctly signed synthetic queued job can have the same
    // actor/session/recipient/shift source. It still is not this receipt's job.
    const unrelatedJob = { ...structuredClone(queued[0]), id: crypto.randomUUID() }; delete unrelatedJob.proof;
    unrelatedJob.proof = crypto.createHmac('sha256', key).update('assignment-email-v1:' + canonicalHash(unrelatedJob)).digest('hex');
    await mutate(db => { db.workspaceAssignmentJobs.push(unrelatedJob); });
    checks.push('lost task-assignment business ACK preserves durable queued job and technical lookup cannot send or duplicate');
    const savedTaskHash = canonicalHash(lostAssignment.durable.snapshot.projectTasks), savedShiftHash = canonicalHash(lostAssignment.durable.snapshot.assignments.map(({ notifications, ...row }) => row));
    const resumed = await request(recoveryPath, { method: 'POST', data: lostAssignment.identity }); assert.equal(resumed.status, 200, JSON.stringify(resumed.value)); assert.equal(resumed.value.originalSaveResult, true); assert.equal(assignmentMessages.length, lostAssignment.sends + 1);
    const delivered = await active.load(A); assert.equal(delivered.snapshot.workspaceAssignmentJobs.find(row => row.id === queued[0].id).status, 'sent'); assert.deepEqual(delivered.snapshot.workspaceAssignmentJobs.find(row => row.id === unrelatedJob.id), unrelatedJob, 'Original receipt cannot claim a different same-source queued job'); assert.equal(canonicalHash(delivered.snapshot.projectTasks), savedTaskHash); assert.equal(canonicalHash(delivered.snapshot.assignments.map(({ notifications, ...row }) => row)), savedShiftHash);
    assert.deepEqual(delivered.snapshot.resourceReceipts.find(row => row.requestId === lostAssignment.identity.requestId), lostAssignment.durable.snapshot.resourceReceipts.find(row => row.requestId === lostAssignment.identity.requestId));
    assert.equal((await request(recoveryPath, { method: 'POST', data: lostAssignment.identity })).status, 200); assert.equal(assignmentMessages.length, lostAssignment.sends + 1); assert.deepEqual(await active.load(A), delivered); checks.push('explicit original confirmation replay resumes only original eligible queued delivery through native claim/final CAS once; tasks/shifts/receipt never repeat');
    await expiryRollback('templateEdit', 'PATCH', templateRoute, { description: 'Must roll back expired native template edit' }); checks.push('actual deferred SQL COMMIT rolls back expired template history, receipt, audit and revision');
    await login(); await mutate(db => { db.subcontractorLinks.push({ id: 4, subcontractorId: 7, projectId: 101, status: 'Active', tokenHash: '4'.repeat(64) }); compliance().stage(db, { auth: authenticateSession(db, hash(tokens.owner)) }); });
    const archiveExpirySource = await active.load(A); assert.equal(archiveExpirySource.snapshot.subcontractorLinks.find(row => row.id === 4).status, 'Active'); assert.ok(archiveExpirySource.snapshot.workspaceComplianceJobs.some(row => row.source.subcontractorId === 7 && row.status === 'queued'));
    await expiryRollback('subcontractorArchive', 'PATCH', '/api/subcontractors/7/archive', { archived: true, reason: 'Must roll back expired native archive' }); checks.push('actual deferred SQL COMMIT rolls back expired archive history/active-link/queued-job changes and receipt');
    await login(); const expiryLane = await save('projectTaskCreate', 'POST', '/api/projects/101/tasks', { name: 'Native expiry assignment', durationDays: 1, predecessorIds: [], memberIds: [14], crew: 'North' });
    const expiryLaneId = expiryLane.r.value.tasks.find(row => row.name === 'Native expiry assignment').id;
    // Change to another current assignee on an untouched date. Its native
    // candidate stages an outbox, which must disappear with COMMIT rollback.
    await expiryRollback('projectTaskAssign', 'POST', '/api/project-tasks/' + expiryLaneId + '/assign', { memberId: 15 }); checks.push('actual deferred SQL COMMIT rolls back expired task assignment, shifts, private receipt and queued delivery before any fake send');
    const final = await active.load(A); assert.equal(canonicalHash({ reports: final.snapshot.reports, timeCards: final.snapshot.timeCards }), historical); assert.deepEqual(final.snapshot.dailyTemplates.find(row => row.id === 21), nativeSeed.dailyTemplates[0]); assert.equal(final.snapshot.reports[0].templateVersion, 1);
    assert.deepEqual(fs.readFileSync(legacyFile), legacyBytes); assert.deepEqual(fs.readFileSync(platformFile), platformBytes); assert.equal(unexpectedCompliance, 0); assert.equal(externalAttempts, 0); checks.push('historical reports/time cards/template pins and unrelated file bytes preserved; zero external or compliance sends'); success = true;
  } finally {
    releaseCommit?.(); uninstall(); globalThis.fetch = originalFetch;
    if (mod?.server.listening) { mod.server.closeAllConnections(); await new Promise(resolve => mod.server.close(resolve)); }
    try {
      if (original) { const current = await active.load(A); await active.commit(original.snapshot, current.revision); const restored = await active.load(A); assert.equal(restored.contentHash, original.contentHash); assert.deepEqual(restored.snapshot, original.snapshot); assert.ok(restored.revision > original.revision); restoration = { restored: true, originalRevision: original.revision, restoredRevision: restored.revision, contentHash: restored.contentHash }; }
      else restoration = { restored: false, originalAbsent: true, preservedOwnedSyntheticRecords: true };
    } finally {
      const result = { nativeExtendedResourceChecks: checks, passed: checks.length, writerCoverage: [...covered].sort(), assignmentFakeSendCount: assignmentMessages.length, unexpectedComplianceSendCount: unexpectedCompliance, externalAttemptCount: externalAttempts, fixtureRestoration: restoration, completed: success && (!original || restoration?.restored === true), syntheticOnly: true, productionReady: false, sourceSha: process.env.PDL_COMPAT_SOURCE_SHA || null, sourceHashes: Object.fromEntries(sourceFiles.map(name => [name, hash(fs.readFileSync(path.join(__dirname, name)))])) };
      if (process.env.PDL_COMPAT_BROWSER_EVIDENCE) { fs.mkdirSync(process.env.PDL_COMPAT_BROWSER_EVIDENCE, { recursive: true }); fs.writeFileSync(path.join(process.env.PDL_COMPAT_BROWSER_EVIDENCE, 'resource-extended-native-http.json'), JSON.stringify(result, null, 2)); }
      console.log(JSON.stringify(result)); await Promise.allSettled(repositories.slice(1).map(repository => repository.close())); await fixture.close();
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
