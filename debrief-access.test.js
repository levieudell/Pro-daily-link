'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { canViewDebrief, canEditDebrief } = require('./debrief-access');

test('debrief permissions follow durable roles and narrow grants', () => {
  const cases = [
    ['owner', [], true, true], ['owner', ['debrief_view', 'debrief_edit'], true, true],
    ['admin', [], true, true], ['admin', ['debrief_view', 'debrief_edit'], true, true],
    ['project_manager', [], true, false], ['project_manager', ['debrief_edit'], true, true],
    ['foreman', [], false, false], ['foreman', ['debrief_view'], true, false], ['foreman', ['debrief_edit'], false, false],
    ['field', [], false, false], ['field', ['debrief_view', 'debrief_edit'], false, false]
  ];
  for (const [role, permissionGrants, view, edit] of cases) {
    const user = { role, permissionGrants };
    assert.equal(canViewDebrief(user), view, `${role} view with ${permissionGrants}`);
    assert.equal(canEditDebrief(user), edit, `${role} edit with ${permissionGrants}`);
  }
  const foremanSession = { role: 'field', accessRole: 'foreman', permissionGrants: ['debrief_view', 'debrief_edit'] };
  assert.equal(canViewDebrief(foremanSession), true);
  assert.equal(canEditDebrief(foremanSession), false);
});

test('owner-only debrief grant endpoint enforces role rules without changing payroll', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-debrief-access-'));
  const companyId = '11331133-1133-4133-8133-113311331133';
  const users = [
    { id: 1, name: 'Owner', email: 'owner@example.test', role: 'owner', status: 'Active' },
    { id: 2, name: 'Admin', email: 'admin@example.test', role: 'admin', status: 'Active' },
    { id: 3, name: 'Manager', email: 'manager@example.test', role: 'project_manager', status: 'Active' },
    { id: 4, name: 'Foreman', email: 'foreman@example.test', role: 'foreman', status: 'Active', memberId: 4 },
    { id: 5, name: 'Field', email: 'field@example.test', role: 'field', status: 'Active', memberId: 5 }
  ].map(user => ({ ...user, companyId, permissionGrants: [] }));
  const tokens = Object.fromEntries(users.map(user => [user.id, `debrief-token-${user.id}`]));
  const db = { company: { id: companyId, name: 'Debrief fixture', billingExempt: true }, users, sessions: users.map(user => ({ companyId, userId: user.id, tokenHash: crypto.createHash('sha256').update(tokens[user.id]).digest('hex'), expiresAt: '2099-01-01' })), team: [{ id: 4, name: 'Foreman' }, { id: 5, name: 'Field' }], projects: [], reports: [], assignments: [], customers: [], changes: [], photos: [], workdays: [], timeCards: [], auditLog: [] };
  const dbFile = path.join(root, 'db.json');
  fs.writeFileSync(dbFile, JSON.stringify(db));
  fs.writeFileSync(path.join(root, 'platform.json'), JSON.stringify({ users: [], sessions: [] }));
  Object.assign(process.env, { PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: path.join(root, 'platform.json'), PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1' });
  for (const key of ['OPENAI_API_KEY', 'SENTRY_DSN', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'DATABASE_URL']) delete process.env[key];
  require('./database/supabase').loadLocalEnv = () => {};
  const { server } = require('./server'), nativeFetch = global.fetch;
  let base;
  async function patch(route, data, userId = 1) {
    const response = await nativeFetch(base + route, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-PDL-Company': companyId, Authorization: `Bearer ${tokens[userId]}` }, body: JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
  }
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await patch('/api/users/3/debrief-access', { edit: true }, 2)).status, 403, 'admin caller is rejected');
    assert.equal((await patch('/api/users/5/debrief-access', { view: true })).status, 400, 'field target is rejected');
    assert.equal((await patch('/api/users/4/debrief-access', { edit: true })).status, 400, 'foreman edit is rejected');
    const managerView = await patch('/api/users/3/debrief-access', { view: false });
    assert.equal(managerView.status, 200);
    assert.equal(canViewDebrief(managerView.data), true, 'PM view stays on by role');
    assert.equal(managerView.data.permissionGrants.includes('debrief_view'), false, 'PM view is not stored as a grant');
    const managerEdit = await patch('/api/users/3/debrief-access', { edit: true });
    assert.equal(managerEdit.status, 200);
    assert.equal(canEditDebrief(managerEdit.data), true);
    const foremanView = await patch('/api/users/4/debrief-access', { view: true });
    assert.equal(foremanView.status, 200);
    assert.equal(canViewDebrief(foremanView.data), true);
    assert.equal(canEditDebrief(foremanView.data), false);
    assert.equal((await patch('/api/users/4/payroll-access', { payroll: true })).status, 403, 'payroll still hard-denies foremen');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    global.fetch = nativeFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
