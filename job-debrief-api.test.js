'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('job debrief API enforces access, redacts pricing and persists notes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-job-debrief-'));
  const companyId = '33443344-3344-4344-8344-334433443344';
  const users = [
    { id: 1, name: 'Owner', role: 'owner', permissionGrants: [] },
    { id: 2, name: 'Manager view', role: 'project_manager', projectIds: [10], permissionGrants: [] },
    { id: 3, name: 'Manager edit', role: 'project_manager', projectIds: [10], permissionGrants: ['debrief_edit'] },
    { id: 4, name: 'Foreman no grant', role: 'foreman', memberId: 4, permissionGrants: [] },
    { id: 5, name: 'Foreman view', role: 'foreman', memberId: 5, permissionGrants: ['debrief_view'] },
    { id: 6, name: 'Field', role: 'field', memberId: 6, permissionGrants: [] }
  ].map(user => ({ ...user, companyId, email: `user${user.id}@example.test`, status: 'Active' }));
  const tokens = Object.fromEntries(users.map(user => [user.id, `job-debrief-token-${user.id}`]));
  const reports = Array.from({ length: 200 }, (_, index) => ({
    id: index + 1, project: 0, status: 'Approved', dateIso: `2026-11-${String(index % 28 + 1).padStart(2, '0')}`,
    weatherDay: index === 0, delayDay: index === 1,
    laborEntries: [{ memberId: 5, hours: 1 }], productionEntries: [{ estimateItemId: 1, quantity: 1, laborHours: 1 }]
  }));
  const db = {
    company: { id: companyId, name: 'Debrief API fixture', billingExempt: true, pricingAccess: { enabled: true, officeMode: 'selected', userIds: [1] } },
    users,
    sessions: users.map(user => ({ companyId, userId: user.id, tokenHash: crypto.createHash('sha256').update(tokens[user.id]).digest('hex'), expiresAt: '2099-01-01' })),
    team: [4, 5, 6].map(id => ({ id, name: users.find(user => user.id === id).name, role: id === 6 ? 'Laborer' : 'Foreman' })),
    projects: [{ id: 10, name: 'Debrief project', lifecycleStatus: 'Active', startDate: '2026-11-01', endDate: '2026-11-30', estimateItems: [{ id: 1, name: 'Excavation', unit: 'CY', plannedQuantity: 180, budgetHours: 180 }] }],
    reports,
    assignments: [{ id: 1, projectId: 10, memberIds: [4, 5, 6], date: '2026-11-01' }],
    changes: [{ id: 1, projectId: 10, status: 'Approved', amount: 500 }],
    customers: [], photos: [], workdays: [], timeCards: [], auditLog: []
  };
  const dbFile = path.join(root, 'db.json'), platformFile = path.join(root, 'platform.json');
  fs.writeFileSync(dbFile, JSON.stringify(db));
  fs.writeFileSync(platformFile, JSON.stringify({ users: [], sessions: [] }));
  Object.assign(process.env, { PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: platformFile, PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1' });
  for (const key of ['OPENAI_API_KEY', 'SENTRY_DSN', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'DATABASE_URL']) delete process.env[key];
  require('./database/supabase').loadLocalEnv = () => {};
  const { server } = require('./server'), nativeFetch = global.fetch;
  let base;
  async function request(userId, method = 'GET', route = '/api/projects/10/debrief', data) {
    const response = await nativeFetch(base + route, { method, headers: { 'Content-Type': 'application/json', 'X-PDL-Company': companyId, Authorization: `Bearer ${tokens[userId]}` }, body: data === undefined ? undefined : JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
  }
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const owner = await request(1);
    assert.equal(owner.status, 200, JSON.stringify(owner.data));
    assert.equal(owner.data.weatherDays, 1);
    assert.equal(owner.data.delayDays, 1);
    assert.equal(owner.data.production.items[0].quantity.actual, 200);
    assert.equal(owner.data.changeOrders.approvedTotal, 500);
    assert.equal(owner.data.laborCost, null, 'rates are never guessed');

    assert.equal((await request(4)).status, 403, 'foreman without grant');
    assert.equal((await request(5)).status, 200, 'assigned foreman with view grant');
    assert.equal((await request(5, 'PATCH', undefined, { wentWell: 'Good' })).status, 403, 'foreman can never edit');
    assert.equal((await request(6)).status, 403, 'field cannot view');
    assert.equal((await request(2, 'PATCH', undefined, { wentWell: 'Good' })).status, 403, 'PM needs edit grant');
    assert.equal((await request(3, 'PATCH', undefined, { wentWell: '  Strong handoff  ', rating: 5 })).status, 200, 'granted PM edits');

    const noPricing = await request(2);
    assert.equal(noPricing.status, 200);
    assert.equal(Object.hasOwn(noPricing.data, 'laborCost'), false);
    assert.equal(Object.hasOwn(noPricing.data, 'laborRates'), false);
    assert.equal(Object.hasOwn(noPricing.data.changeOrders, 'approvedTotal'), false);
    assert.equal(noPricing.data.production.totals.hours.actual, 200);

    const saved = await request(1);
    assert.equal(saved.data.debrief.wentWell, 'Strong handoff');
    assert.equal(saved.data.debrief.rating, 5);
    assert.equal(saved.data.debrief.updatedBy.id, 3);
    assert.equal((await request(1, 'PATCH', undefined, { rating: 6 })).status, 400);
    assert.equal((await request(1, 'PATCH', undefined, { wentWell: 'Fine', extra: true })).status, 400);
    assert.equal((await request(1, 'GET', '/api/projects/999/debrief')).status, 404, 'another tenant project is not disclosed');

    await request(1); // warm the server before measuring the computation path
    const started = performance.now(), timed = await request(1), elapsed = performance.now() - started;
    assert.equal(timed.status, 200);
    assert(elapsed < 300, `200-report debrief took ${elapsed.toFixed(1)} ms`);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    global.fetch = nativeFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
