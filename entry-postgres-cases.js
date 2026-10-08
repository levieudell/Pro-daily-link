'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { workspace } = require('./fixtures/roles-workspace'), { companyA, companyB } = require('./fixtures/project-assistant');
const schedule = require('./scheduling-access');
const password = 'synthetic-entry-password-only';
function clean() {
  const db = workspace(); db.sessions = []; db.company.name = 'Synthetic entry company';
  for (const user of db.users) { user.passwordSalt = 'synthetic-entry-salt-' + user.id; user.passwordHash = crypto.scryptSync(password, user.passwordSalt, 64).toString('hex'); }
  db.company.schedulingRolePolicy = { version: 1, revision: 1, roles: Object.fromEntries(schedule.roles.map(role => [role, schedule.ceiling(role)])) }; db.company.schedulingRolePolicy.roles.project_manager.create = false;
  return db;
}
module.exports = async ({ repository, change, startWorker, controls, checkpoint, waitFor, providerEvents }) => {
  const original = structuredClone((await repository.load(companyA)).snapshot), foreign = await repository.load(companyB), providers = providerEvents.length;
  const reset = () => change(db => { for (const key of Object.keys(db)) delete db[key]; Object.assign(db, clean()); });
  await reset(); const base = await startWorker({ companyId: companyA });
  const post = async (path, body, headers = {}) => { const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '192.0.2.220', ...(path === '/api/auth/login' ? { 'X-PDL-Company': companyA } : {}), ...headers }, body: JSON.stringify(body) }); return { status: response.status, headers: response.headers, data: await response.json() }; };
  try {
    controls.tenantLookups = []; const before = await repository.load(companyA);
    for (const email of ['user2@example.invalid', 'unknown@example.invalid']) assert.deepEqual((await post('/api/auth/company', { email })).data, { companyId: companyA });
    for (const headers of [{ 'X-PDL-Company': companyB }, { Cookie: 'pdl_company=' + companyB }, { 'X-PDL-Company': companyA, Cookie: 'pdl_company=' + companyB }]) assert.ok([400, 401].includes((await post('/api/auth/company', { email: 'user2@example.invalid' }, headers)).status));
    assert.equal((await post('/api/auth/company', { email: 'a', companyId: companyB })).status, 400);
    assert.equal((await post('/api/auth/login', { email: 'a', password, permissions: { scheduleCrews: true } })).status, 400);
    assert.deepEqual(controls.tenantLookups, []); assert.deepEqual(await repository.load(companyA), before);
    const simple = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: 'https://outside.invalid', 'Sec-Fetch-Site': 'cross-site' }, body: JSON.stringify({ email: 'user2@example.invalid', password }) }); assert.equal(simple.status, 400); assert.equal(simple.headers.getSetCookie().length, 0); assert.deepEqual(controls.tenantLookups, []); assert.deepEqual(await repository.load(companyA), before);
    const signed = await post('/api/auth/login', { email: 'user2@example.invalid', password }); assert.equal(signed.status, 200); assert.equal(signed.data.user.permissions.scheduleCrews, true); assert.equal(signed.data.user.schedulingAccess.create, false); assert.deepEqual(signed.data.user.projectIds, [101]);
    assert.ok(!JSON.stringify(signed.data.user).includes('passwordHash')); const cookies = signed.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    assert.equal((await fetch(base + '/api/navigation', { headers: { Cookie: cookies } })).status, 200);
    const tokenHash = crypto.createHash('sha256').update(signed.data.token).digest('hex'); await change(db => { db.sessions = db.sessions.filter(row => row.tokenHash !== tokenHash); });
    const revoked = await repository.load(companyA); const logout = await post('/api/auth/logout', {}, { Cookie: cookies }); assert.equal(logout.status, 200); assert.ok(logout.headers.getSetCookie().every(value => value.includes('Max-Age=0'))); assert.deepEqual(await repository.load(companyA), revoked);
    await reset(); await change(db => { db.users.push({ ...db.users[1], id: 90 }); }); const duplicate = await repository.load(companyA); assert.equal((await post('/api/auth/login', { email: 'user2@example.invalid', password })).status, 409); assert.deepEqual(await repository.load(companyA), duplicate);
    for (const revoke of [db => { db.users[1].status = 'Inactive'; }, db => { db.users[1].passwordHash = '0'.repeat(128); }, db => { db.users[1].role = 'field'; db.users[1].memberId = 11; }, db => { db.company.schedulingRolePolicy.roles.project_manager.view = false; db.company.schedulingRolePolicy.roles.project_manager.edit = db.company.schedulingRolePolicy.roles.project_manager.remove = db.company.schedulingRolePolicy.roles.project_manager.acknowledge = false; }]) {
      await reset(); controls.gate = checkpoint(); const pending = post('/api/auth/login', { email: 'user2@example.invalid', password }); await waitFor(() => controls.gate.count === 1); await change(revoke); const expected = await repository.load(companyA); controls.gate.resolve(); controls.gate = null; const result = await pending; assert.equal(result.status, 409); assert.equal(result.headers.getSetCookie().length, 0); assert.deepEqual(await repository.load(companyA), expected);
    }
    await reset(); const longPassword = 'synthetic-long-password-'.repeat(80); await change(db => { db.users[1].passwordHash = crypto.scryptSync(longPassword, db.users[1].passwordSalt, 64).toString('hex'); }); assert.equal((await post('/api/auth/login', { email: 'user2@example.invalid', password: longPassword })).status, 200, 'Existing long permanent credentials remain usable');
    await reset(); await change(db => { db.users[1].status = 'Inactive'; }); assert.equal((await post('/api/auth/login', { email: 'user2@example.invalid', password })).status, 401);
    for (let attempt = 0; attempt < 2; attempt++) assert.equal((await post('/api/auth/login', { email: 'unknown@example.invalid', password })).status, 401);
    assert.equal((await post('/api/auth/login', { email: 'unknown@example.invalid', password })).status, 429);
    assert.deepEqual(await repository.load(companyB), foreign); assert.equal(providerEvents.length, providers);
    console.log('Entry native PostgreSQL: no-write/no-lookup discovery, closed foreign/malicious input, real restricted login, revoked logout, duplicate denial, concurrent credential/role/policy CAS and failed-login limits passed.');
  } finally { controls.gate?.resolve(); controls.gate = null; controls.tenantLookups = null; await change(db => { for (const key of Object.keys(db)) delete db[key]; Object.assign(db, original); }); }
};
module.exports.clean = clean; module.exports.password = password;
