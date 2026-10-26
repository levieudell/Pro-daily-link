'use strict';

// Acceptance uses only synthetic local tenants and disables all providers.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { splitSnapshot, assembleSnapshot } = require('./database/transactional-repository');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-safety-api-'));
const dbFile = path.join(temp, 'db.json');
const companyA = '11111111-1111-4111-8111-111111111111';
const companyB = '22222222-2222-4222-8222-222222222222';
const date = '2026-10-26';
const guestToken = 'ab'.repeat(24);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const token = (company, user) => `synthetic-safety-${company}-${user}`;
const safety = project => `/api/projects/${project}/safety`;
const dayRoute = project => `${safety(project)}/days/${date}`;

function fixture(companyId) {
  const users = [
    { id: 1, role: 'owner' }, { id: 2, role: 'admin' },
    { id: 3, role: 'project_manager', projectIds: [101], assignedCrews: ['Safety crew'], permissions: { viewDailies: true, approveDailies: true, scheduleCrews: true } },
    { id: 4, role: 'foreman', memberId: 11 }, { id: 5, role: 'field', memberId: 12 },
    { id: 6, role: 'project_manager', projectIds: [101], assignedCrews: ['Safety crew'], permissions: {} },
    { id: 7, role: 'guest' }, { id: 8, role: 'owner', status: 'Inactive' }
  ].map(user => ({ companyId, status: 'Active', name: `Synthetic safety user ${user.id}`, email: `safety${user.id}@example.invalid`, ...user }));
  return {
    company: { id: companyId, name: 'Synthetic safety company', demo: true, timezone: 'America/Los_Angeles', features: {} },
    projects: [101, 102].map(id => ({ id, name: `Synthetic project ${id}`, site: '100 Synthetic Way, Portland, OR 97201', status: 'Active', customerId: 1, estimateItems: [] })),
    customers: [{ id: 1, name: 'Synthetic customer' }],
    team: [11, 12].map(id => ({ id, name: `Synthetic member ${id}`, crew: 'Safety crew', role: 'Crew member' })),
    assignments: [{ id: 1, projectId: 101, memberIds: [11, 12], crew: 'Safety crew', date, start: '08:00', end: '16:00', task: 'Roofing work' }],
    users,
    sessions: users.map(user => ({ userId: user.id, companyId, tokenHash: hash(token(companyId, user.id)), expiresAt: '2099-01-01T00:00:00Z' })),
    photos: [{ id: 1, project: 0, caption: 'Synthetic roof photo' }, { id: 2, project: 1, caption: 'Other project photo' }],
    workdays: [], reports: [],
    subcontractors: [{ id: 1, name: 'Synthetic subcontractor', trade: 'Roofing' }],
    subcontractorLinks: [{ id: 1, projectId: 101, subcontractorId: 1, tokenHash: hash(guestToken), status: 'Active', mode: 'progress', expiresAt: '2099-01-01T00:00:00Z' }],
    // Deliberately malformed tenant provenance must never win same-project/day lookup.
    safetyDays: companyId === companyA ? [{ id: 'foreign-day-first', companyId: companyB, projectId: 101, date, revision: 999, ruleVersion: 'FOREIGN_TENANT_SENTINEL', coverage: 'foreign', activities: [], checks: [{ id: 'foreign-check', notes: 'FOREIGN_TENANT_SENTINEL' }], hazards: [], history: [] }] : [],
    changes: [], catalog: []
  };
}

fs.mkdirSync(path.join(temp, 'tenants'));
fs.writeFileSync(dbFile, JSON.stringify(fixture(companyA)));
fs.writeFileSync(path.join(temp, 'tenants', `${companyB}.json`), JSON.stringify(fixture(companyB)));
fs.writeFileSync(path.join(temp, 'platform.json'), JSON.stringify({ users: [], sessions: [], notes: [] }));

let child, base, serverLog = '';
async function startServer(authRequired = true) {
  const env = { ...process.env, PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: path.join(temp, 'platform.json'), PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_PLATFORM_TRANSACTIONAL_DB: 'off', PDL_REQUIRE_AUTH: authRequired ? '1' : '0', PDL_EMAIL_DEV_MODE: '1', NODE_ENV: 'test' };
  for (const key of ['PDL_STAGING', 'SENTRY_DSN', 'RESEND_API_KEY', 'OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'DATABASE_URL']) delete env[key];
  serverLog = '';
  child = spawn(process.execPath, ['-e', "const {server}=require('./server');server.listen(0,'127.0.0.1',()=>console.log('SAFETY_TEST_PORT='+server.address().port));"], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Synthetic safety server did not start: ' + serverLog)), 15000);
    child.stdout.on('data', bytes => {
      serverLog += String(bytes);
      const match = serverLog.match(/SAFETY_TEST_PORT=(\d+)/);
      if (match) { base = `http://127.0.0.1:${match[1]}`; clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', bytes => { serverLog += String(bytes); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Synthetic safety server exited ${code}: ${serverLog}`)); });
  });
}
async function stopServer() {
  if (!child || child.exitCode != null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; child = null;
}
async function request(method, url, user = 1, input, company = companyA, overrideHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', 'x-pdl-company': company, ...(user == null ? {} : { Authorization: `Bearer ${token(company, user)}` }), ...overrideHeaders };
  const response = await fetch(base + url, { method, headers, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  return { status: response.status, data: await response.json() };
}
async function expectStatus(status, ...args) {
  const result = await request(...args);
  assert.equal(result.status, status, `${args[0]} ${args[1]} user ${args[2] ?? 'anonymous'}: ${JSON.stringify(result.data)}`);
  return result.data;
}
const profileInput = (revision = 0, extra = {}) => ({ revision, enabled: true, state: 'OR', employer: 'Synthetic responsible employer', activities: ['roofing'], ...extra });
const reportInput = status => ({ projectId: 101, project: 0, dateIso: date, notes: 'Synthetic roofing work and inspection notes.', status, reportType: 'superintendent', extracted: { reportType: 'superintendent' }, productionEntries: [], laborEntries: [] });
const pass = (day, check, extra = {}) => ({ revision: day.revision, status: 'pass', inspector: 'Synthetic inspector', notes: 'Synthetic inspection evidence recorded before work.', ...(check.requiresCompetentPerson ? { competentPerson: 'Synthetic designated competent person' } : {}), ...extra });

(async () => {
  try {
    await startServer();
    for (const asset of ['/safety-pm-ui.js', '/safety-pm-ui.css']) assert.equal((await fetch(base + asset)).status, 200, 'public UI asset: ' + asset);
    for (const asset of ['/safety-engine.js', '/safety-api.test.js']) assert.equal((await fetch(base + asset)).status, 404, 'server-only safety file: ' + asset);
    await expectStatus(401, 'GET', safety(101) + '?date=' + date, null);
    await expectStatus(401, 'GET', safety(101) + '?date=' + date, 8);
    await expectStatus(403, 'GET', safety(101) + '?date=' + date, 7);
    await expectStatus(404, 'GET', safety(102) + '?date=' + date, 3);
    await expectStatus(404, 'GET', safety(101) + '?date=' + date, 6);
    await expectStatus(400, 'GET', safety(101) + '?date=2026-02-30', 1);
    await expectStatus(403, 'PUT', safety(101) + '/profile', 5, profileInput());
    await expectStatus(400, 'PUT', safety(101) + '/profile', 1, { ...profileInput(), state: 'WA' });
    const setup = await expectStatus(200, 'PUT', safety(101) + '/profile', 1, profileInput());
    assert.equal(setup.profile.revision, 1);
    await expectStatus(409, 'PUT', safety(101) + '/profile', 1, profileInput());
    let read = await expectStatus(200, 'GET', safety(101) + '?date=' + date, 3);
    assert.equal(read.day, null); assert.equal(read.canManage, true); assert.equal(read.coverage, 'oregon-starter');
    const gated = await expectStatus(409, 'POST', '/api/reports', 1, reportInput('Submitted'));
    assert.equal(gated.code, 'SAFETY_CHECKS_REQUIRED', 'server gate is enforced with templates disabled');
    const guestBlocked = await expectStatus(409, 'POST', `/api/guest/${guestToken}?c=${companyA}`, null, { notes: 'Synthetic subcontractor work', startedAt: date + 'T08:00:00Z', endedAt: date + 'T16:00:00Z', crewCount: 2, tickets: [] });
    assert.equal(guestBlocked.code, 'SAFETY_CHECKS_REQUIRED', 'subcontractor guest report cannot bypass safety gate');
    assert.equal(JSON.parse(fs.readFileSync(dbFile, 'utf8')).reports.length, 0, 'blocked guest submission does not persist a report');
    const draft = await expectStatus(201, 'POST', '/api/reports', 1, { ...reportInput('Draft'), extracted: { reportType: 'superintendent', safetyEvidence: { ruleVersion: 'FORGED_CLIENT_EVIDENCE', checks: [{ status: 'pass' }] } } });
    assert.equal(draft.status, 'Draft', 'incomplete safety must not block preserving a draft');
    assert.equal(Object.hasOwn(draft, 'safetyEvidence'), false, 'forged extracted safety evidence is stripped from new Draft');
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(dbFile, 'utf8')).reports.find(row => row.id === draft.id), 'safetyEvidence'), false, 'forged Draft evidence is not persisted');
    assert.equal((await expectStatus(409, 'PATCH', `/api/reports/${draft.id}`, 1, { ...reportInput('Submitted'), updatedAt: draft.updatedAt })).code, 'SAFETY_CHECKS_REQUIRED');
    assert.equal((await expectStatus(409, 'PATCH', `/api/reports/${draft.id}/approve`, 1, {})).code, 'SAFETY_CHECKS_REQUIRED');
    let day = await expectStatus(201, 'POST', safety(101) + '/days', 4, { date, revision: 0 });
    assert.ok(day.checks.some(check => check.activity === 'roofing'));
    assert.equal(day.summary.canSubmit, false);
    assert.deepEqual(await expectStatus(200, 'POST', safety(101) + '/days', 4, { date, revision: day.revision }), day, 'unchanged generation is idempotent');
    const firstCheck = day.checks[0];
    await expectStatus(400, 'PATCH', `${dayRoute(101)}/checks/${firstCheck.id}`, 4, { revision: day.revision, status: 'pass' });
    await expectStatus(400, 'PATCH', `${dayRoute(101)}/checks/${firstCheck.id}`, 4, { ...pass(day, firstCheck), updatedByUserId: 1 });
    const oldRevision = day.revision;
    day = await expectStatus(200, 'PATCH', `${dayRoute(101)}/checks/${firstCheck.id}`, 4, pass(day, firstCheck));
    await expectStatus(409, 'PATCH', `${dayRoute(101)}/checks/${firstCheck.id}`, 4, { ...pass(day, firstCheck), revision: oldRevision });
    assert.equal(day.checks[0].updatedByUserId, 4, 'actor comes from authenticated account');
    const concurrent = await Promise.all(['First synthetic reviewer', 'Second synthetic reviewer'].map(inspector => request('PATCH', `${dayRoute(101)}/checks/${firstCheck.id}`, 4, { ...pass(day, firstCheck), inspector })));
    assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409], 'parallel edits have one winner and one stale conflict');
    day = concurrent.find(result => result.status === 200).data;
    for (const check of day.checks.filter(check => check.status === 'pending')) day = await expectStatus(200, 'PATCH', `${dayRoute(101)}/checks/${check.id}`, 4, pass(day, check));
    assert.equal(day.summary.canSubmit, true); assert.equal(day.summary.readyForWork, true);
    await expectStatus(400, 'POST', `${dayRoute(101)}/hazards`, 4, { revision: day.revision, observation: 'Synthetic unguarded hole', location: 'Synthetic west roof', photoId: 2 });
    day = await expectStatus(200, 'POST', `${dayRoute(101)}/hazards`, 4, { revision: day.revision, observation: '<img src=x onerror=alert(1)> Synthetic unguarded hole', location: 'Synthetic west roof', photoId: 1 });
    assert.equal(day.summary.canSubmit, false, 'undocumented open hazard blocks finalization');
    assert.equal(day.summary.readyForWork, false);
    const hazard = day.hazards[0];
    await expectStatus(403, 'PATCH', `${dayRoute(101)}/hazards/${hazard.id}`, 5, { revision: day.revision, status: 'verified', action: 'Synthetic cover installed', verification: 'Synthetic verification' });
    day = await expectStatus(200, 'PATCH', `${dayRoute(101)}/hazards/${hazard.id}`, 3, { revision: day.revision, status: 'verified', action: 'Synthetic cover installed', verification: 'Synthetic PM inspected cover' });
    assert.equal(day.summary.unresolved, 0); assert.equal(day.hazards[0].verifiedByUserId, 3);
    const check = day.checks[0];
    await expectStatus(400, 'PATCH', `${dayRoute(101)}/checks/${check.id}`, 4, { ...pass(day, check), status: 'deferred', notes: 'Synthetic deferred inspection' });
    day = await expectStatus(200, 'PATCH', `${dayRoute(101)}/checks/${check.id}`, 4, { ...pass(day, check), status: 'deferred', notes: 'Synthetic inspection deferred', action: 'Keep affected work stopped until inspection', owner: 'Synthetic foreman', dueDate: date, workStopped: true });
    assert.equal(day.summary.canSubmit, true, 'documented unresolved condition can be recorded in daily');
    assert.equal(day.summary.readyForWork, false, 'deferred check never becomes clearance to work');
    assert.equal(day.summary.unresolved, 1);
    const submitted = await expectStatus(201, 'POST', '/api/reports', 1, { ...reportInput('Submitted'), clientTag: 'synthetic-safety-accepted' });
    assert.notEqual(submitted.status, 'Draft');
    assert.equal(submitted.safetyEvidence.dayRevision, day.revision);
    assert.equal(JSON.stringify(submitted.safetyEvidence).includes('FOREIGN_TENANT_SENTINEL'), false, 'foreign same-project/date row cannot leak into daily evidence');
    assert.equal(submitted.safetyEvidence.summary.unresolved, 1, 'daily retains the unresolved condition honestly');
    const capturedSafety = structuredClone(submitted.safetyEvidence);
    day = await expectStatus(200, 'PATCH', `${dayRoute(101)}/checks/${check.id}`, 4, pass(day, check));
    const savedReport = JSON.parse(fs.readFileSync(dbFile, 'utf8')).reports.find(row => row.id === submitted.id);
    assert.deepEqual(savedReport.safetyEvidence, capturedSafety, 'later safety responses do not rewrite the submitted daily evidence');
    const beforeRestart = await expectStatus(200, 'GET', safety(101) + '?date=' + date, 1);
    const onDisk = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    assert.ok(onDisk.safetyDays.find(row => row.companyId === companyA).history.length > day.checks.length, 'audit trail survives persistence');
    const { scalarData, records } = splitSnapshot(onDisk);
    assert.deepEqual(assembleSnapshot(scalarData, records).safetyDays, onDisk.safetyDays, 'transactional snapshot assembly retains safety evidence');
    for (const user of [1, 3, 4, 5]) assert.equal(Object.hasOwn(await expectStatus(200, 'GET', '/api/state', user), 'safetyDays'), false, 'generic state does not bypass safety scope');
    const ownerExport = await expectStatus(200, 'GET', '/api/company/export', 1);
    assert.ok(ownerExport.safetyDays.length > 0, 'owner export retains own safety history');
    assert.ok(ownerExport.safetyDays.every(row => row.companyId === companyA), 'owner export excludes foreign safety days');
    assert.equal(JSON.stringify(ownerExport.safetyDays).includes('FOREIGN_TENANT_SENTINEL'), false);
    const tenantB = await expectStatus(200, 'GET', safety(101) + '?date=' + date, 1, undefined, companyB);
    assert.equal(tenantB.profile.revision, 0); assert.equal(tenantB.day, null, 'same project ID in another tenant has independent safety state');
    await expectStatus(401, 'GET', safety(101) + '?date=' + date, 1, undefined, companyB, { Authorization: `Bearer ${token(companyA, 1)}` });
    await stopServer(); await startServer();
    assert.deepEqual(await expectStatus(200, 'GET', safety(101) + '?date=' + date, 1), beforeRestart, 'restart preserves responses and audit history');
    await expectStatus(200, 'PUT', safety(101) + '/profile', 1, profileInput(1, { activities: ['roofing', 'excavation'] }));
    read = await expectStatus(200, 'GET', safety(101) + '?date=' + date, 1);
    assert.equal(read.day.summary.stale, true);
    assert.equal((await expectStatus(409, 'PATCH', `/api/reports/${draft.id}/approve`, 1, {})).code, 'SAFETY_CHECKS_REQUIRED');
    day = await expectStatus(200, 'POST', safety(101) + '/days', 1, { date, revision: read.day.revision });
    assert.ok(day.checks.every(row => row.status === 'pending'), 'changed applicability requires fresh responses');
    assert.ok(day.history.some(row => row.after?.status === 'deferred' || row.before?.checks?.some(check => check.status === 'deferred')), 'previous responses remain in history');
    const excavation = day.checks.find(check => check.requiresCompetentPerson);
    await expectStatus(400, 'PATCH', `${dayRoute(101)}/checks/${excavation.id}`, 4, { revision: day.revision, status: 'pass', inspector: 'Synthetic inspector', notes: 'Synthetic excavation inspection' });
    day = await expectStatus(200, 'PATCH', `${dayRoute(101)}/checks/${excavation.id}`, 4, pass(day, excavation));
    assert.equal(day.checks.find(check => check.id === excavation.id).competentPerson, 'Synthetic designated competent person');
    await stopServer(); await startServer(false);
    await expectStatus(401, 'GET', safety(101) + '?date=' + date, null);
    await expectStatus(401, 'PUT', safety(101) + '/profile', null, profileInput(2));
    await expectStatus(403, 'GET', safety(101) + '?date=' + date, 7);
    assert.equal(Object.hasOwn(await expectStatus(200, 'GET', '/api/state', null), 'safetyDays'), false, 'legacy demo mode cannot leak safety evidence');
    assert.equal(Object.hasOwn(await expectStatus(200, 'GET', '/api/company/export', null), 'safetyDays'), false, 'unauthenticated legacy export cannot expose safety days');
    const demoOwnerExport = await expectStatus(200, 'GET', '/api/company/export', 1);
    assert.ok(demoOwnerExport.safetyDays.every(row => row.companyId === companyA), 'authenticated owner export stays tenant-scoped in legacy mode');
    console.log('Safety API acceptance passed: authenticated scoped workflow, tenant isolation, inspections, hazards, audit/restart persistence, optimistic revisions, private projections and daily submission/approval gates.');
  } finally {
    await stopServer();
    const resolved = path.resolve(temp), prefix = path.resolve(os.tmpdir()) + path.sep;
    if (!resolved.startsWith(prefix)) throw new Error('Synthetic test cleanup escaped temp directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); if (serverLog) console.error(serverLog); process.exitCode = 1; });
