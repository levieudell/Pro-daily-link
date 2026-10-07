'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const restrictions = require('./company-role-policy');
const { splitSnapshot, assembleSnapshot } = require('./database/transactional-repository');
const caps = () => restrictions.policy({}).projectManager;
const full = { role: 'project_manager', permissions: caps() };
assert.equal(restrictions.effectiveUser({}, full), full, 'no policy preserves exact defaults');
for (const role of ['owner', 'admin', 'office', 'foreman', 'field', 'guest', 'unrecognized']) {
  const user = { role, permissions: { aiAssistant: true, ...caps() } };
  assert.equal(restrictions.effectiveUser({ roleRestrictions: null }, user), user, 'caps cannot configure ' + role);
}
for (const invalid of [null, {}, [], { ...caps(), aiAssistant: true }, { ...caps(), viewTime: 'false' }, { ...caps(), viewTime: false }, { ...caps(), viewDailies: false }, JSON.parse('{"__proto__":true}')]) assert.throws(() => restrictions.validateCaps(invalid));
for (const invalid of [null, [], {}, { schemaVersion: 2, revision: 1, projectManager: caps() }, { schemaVersion: 1, revision: '1', projectManager: caps() }, { schemaVersion: 1, revision: 1, projectManager: { ...caps(), owner: true } }]) {
  assert.equal(restrictions.policy({ roleRestrictions: invalid }).valid, false);
  assert.ok(Object.values(restrictions.effectiveUser({ roleRestrictions: invalid }, full).permissions).every(value => value === false));
}
const stored = projectManager => ({ roleRestrictions: { schemaVersion: 1, revision: 1, projectManager } });
const approved = { role: 'project_manager', permissions: { approveDailies: true, manageTime: true } };
assert.equal(restrictions.effectiveUser(stored(caps()), approved).permissions.viewDailies, true, 'retain existing approval implies view');
assert.equal(restrictions.effectiveUser(stored({ ...caps(), approveDailies: false }), approved).permissions.viewDailies, true);
assert.equal(restrictions.effectiveUser(stored({ ...caps(), manageTime: false }), approved).permissions.viewTime, true);
assert.equal(restrictions.effectiveUser(stored(caps()), { role: 'project_manager', permissions: {} }).permissions.manageTime, false, 'never creates a grant');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-role-restrictions-'));
const companyA = '11111111-1111-4111-8111-111111111111', companyB = '22222222-2222-4222-8222-222222222222';
process.env.PDL_DB_FILE = path.join(temp, 'db.json');
process.env.PDL_PLATFORM_FILE = path.join(temp, 'platform.json');
process.env.PDL_SUPABASE_ENABLED = '0'; process.env.PDL_TRANSACTIONAL_DB = 'off'; process.env.PDL_REQUIRE_AUTH = '1'; process.env.PDL_EMAIL_DEV_MODE = '1';
for (const key of ['SENTRY_DSN', 'RESEND_API_KEY', 'OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) delete process.env[key];
const fileFor = company => company === companyA ? process.env.PDL_DB_FILE : path.join(temp, 'tenants', company + '.json');
const read = (company = companyA) => JSON.parse(fs.readFileSync(fileFor(company), 'utf8'));
const mutate = (fn, company = companyA) => { const db = read(company); fn(db); fs.writeFileSync(fileFor(company), JSON.stringify(db)); };
const token = (id, company = companyA) => `synthetic-restrictions-${company}-${id}`;
function fixture(company) {
  const db = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/db.json'), 'utf8'));
  db.company = { id: company, name: 'Synthetic restrictions', demo: true, timezone: 'UTC', features: { timeCards: true }, pricingAccess: { enabled: false } };
  db.projects = [101, 102].map(id => ({ id, name: 'Synthetic project ' + id, status: 'Active', estimateItems: [] }));
  db.team = [{ id: 11, name: 'Synthetic crew member', crew: 'Crew A', role: 'Crew member' }, { id: 12, name: 'Other crew member', crew: 'Crew B' }];
  db.users = [
    { id: 1, role: 'owner' }, { id: 2, role: 'admin' },
    { id: 3, role: 'project_manager', permissions: caps(), projectIds: [101], assignedCrews: ['Crew A'] },
    { id: 4, role: 'project_manager', permissions: {}, projectIds: [101], assignedCrews: ['Crew A'] },
    { id: 5, role: 'foreman', memberId: 11 }, { id: 6, role: 'field', memberId: 11 },
    { id: 7, role: 'owner', mustSetPassword: true }, { id: 8, role: 'owner', companyId: companyB }
  ].map(user => ({ companyId: company, status: 'Active', name: 'Synthetic user ' + user.id, email: `qa${user.id}@example.invalid`, ...user }));
  db.sessions = db.users.map(user => ({ userId: user.id, companyId: company, tokenHash: crypto.createHash('sha256').update(token(user.id, company)).digest('hex'), expiresAt: '2099-01-01T00:00:00Z' }));
  db.assignments = [{ id: 1, projectId: 101, memberIds: [11], date: '2026-10-07', start: '07:00', end: '15:00', activity: 'Synthetic work' }];
  db.reports = [{ id: 1, project: 0, status: 'Needs review', dateIso: '2026-10-07', foreman: db.team[0].name, notes: 'Synthetic report', laborEntries: [{ memberId: 11, hours: 1 }], productionEntries: [], history: [] }];
  db.timeCards = [{ id: 1, projectId: 101, memberId: 11, status: 'submitted', inAt: '2026-10-07T07:00:00Z', outAt: '2026-10-07T08:00:00Z', date: '2026-10-07', hours: 1, breaks: [] }];
  db.workdays = []; db.photos = []; db.auditLog = []; db.timeOffRequests = []; db.changes = []; db.payPeriods = []; db.subcontractorLinks = [];
  return db;
}
fs.mkdirSync(path.join(temp, 'tenants'));
fs.writeFileSync(fileFor(companyA), JSON.stringify(fixture(companyA)));
fs.writeFileSync(fileFor(companyB), JSON.stringify(fixture(companyB)));
fs.copyFileSync(path.join(__dirname, 'data/platform.json'), process.env.PDL_PLATFORM_FILE);
const { server } = require('./server');
const route = '/api/company/role-restrictions';
let base;
async function request(url, method = 'GET', input, id = 1, company = companyA, extras = {}) {
  const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-PDL-Company': company, Cookie: `pdl_company=${company}`, ...(id ? { Authorization: 'Bearer ' + token(id, company) } : {}), ...extras }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  return { status: response.status, data: (response.headers.get('content-type') || '').includes('json') ? await response.json() : await response.text() };
}
const input = (projectManager, revision = 0) => ({ projectManager, revision, reason: 'Synthetic restriction review' });
async function preview(projectManager, revision = 0) { const result = await request(route + '/preview', 'POST', input(projectManager, revision)); assert.equal(result.status, 200, JSON.stringify(result)); return result.data; }
const confirm = value => ({ revision: value.revision, projectManager: value.projectManager, reason: value.reason, expiresAt: value.expiresAt, previewToken: value.previewToken, confirm: true });
async function apply(projectManager, revision) { const value = await preview(projectManager, revision); const result = await request(route, 'PUT', confirm(value)); assert.equal(result.status, 200, JSON.stringify(result)); return result.data; }
function slowAssignment() {
  const payload = JSON.stringify({ projectId: 101, memberIds: [11], date: '2026-10-08', start: '07:00', end: '15:00', activity: 'Synthetic slow request' });
  let req;
  const result = new Promise((resolve, reject) => {
    req = http.request(base + '/api/assignments', { method: 'POST', headers: { Authorization: 'Bearer ' + token(3), 'X-PDL-Company': companyA, Cookie: `pdl_company=${companyA}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => { let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) })); });
    req.on('error', reject); req.write(payload.slice(0, 1));
  });
  return { finish() { req.end(payload.slice(1)); }, result };
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;
  try {
    const initial = read();
    assert.equal((await request(route)).data.revision, 0);
    assert.deepEqual(read(), initial, 'reading does not save defaults');
    assert.equal((await request(route, 'GET', undefined, 2)).data.canEdit, false);
    for (const id of [0, 3, 4, 5, 6, 7, 8]) assert.equal((await request(route, 'GET', undefined, id)).status, 403, 'review role ' + id);
    assert.equal((await request(route + '/preview', 'POST', input({ ...caps(), scheduleCrews: false }), 2)).status, 403, 'admin cannot self-escalate');
    assert.equal((await request(route, 'GET', undefined, 1, companyB, { Authorization: 'Bearer ' + token(1, companyA) })).status, 403, 'cross-tenant token');
    for (const malicious of [{ ...input(caps()), role: 'field' }, { ...input(caps()), projectManager: { ...caps(), aiAssistant: true } }, { ...input(caps()), projectManager: { ...caps(), payroll: true } }, { ...input(caps()), revision: '0' }]) assert.equal((await request(route + '/preview', 'POST', malicious)).status, 400);
    const capOff = { ...caps(), scheduleCrews: false };
    const signed = await preview(capOff);
    assert.deepEqual(read(), initial, 'preview is read-only');
    assert.equal((await request(route, 'PUT', { ...confirm(signed), confirm: false })).status, 400);
    assert.equal((await request(route, 'PUT', { ...confirm(signed), previewToken: '0'.repeat(64) })).status, 409);
    assert.equal((await request(route, 'PUT', { ...confirm(signed), reason: 'Tampered reason' })).status, 409);
    assert.equal((await request(route, 'PUT', { ...confirm(signed), expiresAt: Date.now() - 1 })).status, 409);
    mutate(db => { db.users.find(user => user.id === 3).assignedCrews.push('Crew B'); });
    assert.equal((await request(route, 'PUT', confirm(signed))).status, 409, 'scope changed after preview');
    mutate(db => { db.users.find(user => user.id === 3).assignedCrews = ['Crew A']; });
    const meBefore = (await request('/api/auth/me', 'GET', undefined, 3)).data;
    assert.equal(meBefore.permissions.scheduleCrews, true);
    const slow = slowAssignment();
    await new Promise(resolve => setTimeout(resolve, 40));
    const changed = await apply(capOff, 0);
    slow.finish(); assert.equal((await slow.result).status, 403, 'restriction while request body is in flight');
    assert.equal(changed.revision, 1);
    assert.equal((await request(route, 'PUT', confirm(signed))).status, 409, 'stale or replayed preview');
    const me = (await request('/api/auth/me', 'GET', undefined, 3)).data;
    assert.equal(me.permissions.scheduleCrews, false, 'old session sees current cap');
    assert.equal((await request('/api/state', 'GET', undefined, 3)).data.currentUser.permissions.scheduleCrews, false);
    assert.equal((await request('/api/assignments/1', 'PATCH', { date: '2026-10-08' }, 3)).status, 403);
    assert.equal((await request('/api/assignments/1', 'DELETE', {}, 3)).status, 403);
    assert.equal((await request(route, 'GET', undefined, 1, companyB)).data.revision, 0, 'other tenant unchanged');
    assert.deepEqual(read().users.filter(user => user.role === 'project_manager'), initial.users.filter(user => user.role === 'project_manager'), 'caps do not replace stored grants');
    assert.equal((await request('/api/users', 'GET', undefined, 3)).status, 403);
    assert.equal((await request('/api/company', 'PATCH', { name: 'Tampered' }, 3)).status, 403);
    assert.equal((await request('/api/projects/101/tm-summary', 'GET', undefined, 3)).status, 403, 'financial boundary unchanged');
    await apply({ ...capOff, viewDailies: false, approveDailies: false, viewTime: false, manageTime: false }, 1);
    const blocked = (await request('/api/state', 'GET', undefined, 3)).data;
    assert.deepEqual(blocked.reports, []); assert.equal(Object.hasOwn(blocked, 'timeCards'), false);
    assert.equal((await request('/api/reports/1/approve', 'PATCH', {}, 3)).status, 403);
    assert.equal((await request('/api/reports/1', 'PATCH', { notes: 'Tampered' }, 3)).status, 403);
    assert.equal((await request('/api/time-cards/1/approve', 'POST', {}, 3)).status, 404);
    assert.equal((await request('/api/time-cards/1', 'PATCH', { reason: 'Tampered' }, 3)).status, 404);
    assert.equal((await request('/api/time-cards', 'POST', { memberId: 11, projectId: 101 }, 3)).status, 403);
    assert.equal((await request('/api/pay-periods', 'GET', undefined, 3)).status, 403);
    for (const url of ['/api/insights', '/api/exceptions', '/api/production', '/api/catalog', '/api/projects/101/tm-summary']) assert.equal((await request(url, 'GET', undefined, 3)).status, 403, 'report-derived route ' + url);
    assert.equal((await request('/api/reports', 'POST', { notes: 'Bypass' }, 3)).status, 403);
    assert.equal((await request('/api/workdays/start', 'POST', { projectId: 101, memberIds: [11] }, 3)).status, 403, 'workday cannot bypass time cap');
    assert.equal((await request('/api/reports/1/approve', 'PATCH', {}, 6)).status, 403, 'field cannot get office approval');
    assert.equal((await request('/api/state', 'GET', undefined, 6)).data.currentUser.role, 'field');
    const restore = await apply(caps(), 2);
    assert.equal(restore.revision, 3);
    assert.equal((await request('/api/auth/me', 'GET', undefined, 3)).data.permissions.scheduleCrews, true);
    assert.equal((await request('/api/auth/me', 'GET', undefined, 4)).data.permissions.scheduleCrews, false, 'restoring cap cannot grant');
    assert.equal((await request('/api/assignments', 'POST', { projectId: 102, memberIds: [11], date: '2026-10-08', start: '07:00', end: '15:00' }, 3)).status, 403, 'unassigned project');
    assert.equal((await request('/api/assignments', 'POST', { projectId: 101, memberIds: [12], date: '2026-10-08', start: '07:00', end: '15:00' }, 3)).status, 403, 'unassigned crew');
    assert.equal(read().auditLog.filter(row => row.type === 'role_restrictions_changed').length, 3);
    const saved = read(), parts = splitSnapshot(saved), restored = assembleSnapshot(parts.scalarData, parts.records);
    assert.deepEqual(restored.company, saved.company, 'transactional round-trip retains policy');
    assert.deepEqual(restored.auditLog, saved.auditLog, 'transactional round-trip retains audit');
    const afterRolePreview = await preview(capOff, 3);
    mutate(db => { db.users[0].role = 'admin'; });
    assert.equal((await request(route, 'PUT', confirm(afterRolePreview))).status, 403, 'owner demoted after preview');
    mutate(db => { db.users[0].role = 'owner'; db.sessions[0].expiresAt = '2000-01-01T00:00:00Z'; });
    assert.equal((await request(route, 'PUT', confirm(afterRolePreview))).status, 403, 'session expired');
    mutate(db => { db.sessions[0].expiresAt = '2099-01-01T00:00:00Z'; db.company.roleRestrictions.projectManager.aiAssistant = true; });
    assert.equal((await request('/api/auth/me', 'GET', undefined, 3)).data.permissions.scheduleCrews, false, 'invalid stored policy fails closed');
    assert.equal((await request(route)).data.valid, false, 'owner retains repair visibility');
    assert.equal((await request(route + '/preview', 'POST', input(capOff, 3))).status, 409);
    process.env.PDL_REQUIRE_AUTH = '0';
    assert.equal((await request(route, 'GET', undefined, 0)).status, 403, 'no demo bypass');
    assert.equal((await request(route + '/preview', 'POST', input(capOff, 3), 2)).status, 403);
    assert.equal((await request('/company-role-policy.js')).status, 404, 'server policy is not public');
    console.log('Role restriction caps, signed previews, stale sessions, tenant isolation and in-flight revocation passed');
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
