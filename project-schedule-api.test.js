'use strict';
// Linked project tasks API: CRUD, dependency cascades, cycle rejection,
// role gates (office writes; field reads only assigned projects), and
// per-tenant isolation through the real server.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-project-schedule-')), companyId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ownerToken = 'synthetic-schedule-owner', fieldToken = 'synthetic-schedule-field', otherFieldToken = 'synthetic-schedule-other';
const hash = token => crypto.createHash('sha256').update(token).digest('hex');
const db = {
  company: { id: companyId, name: 'Synthetic schedule', demo: true, timezone: 'UTC' },
  projects: [{ id: 101, name: 'North Ridge', customer: 'Test Customer', site: 'Site A', startDate: '2026-10-12', endDate: '2026-12-31', status: 'Active' }],
  team: [{ id: 7, name: 'Chloe', crew: 'A' }, { id: 8, name: 'Andi', crew: 'A' }],
  assignments: [], workdays: [], timeCards: [], timeOffRequests: [], reports: [], photos: [], auditLog: [], projectTasks: [], customers: [], changes: [], catalog: [],
  users: [
    { id: 1, name: 'Synthetic owner', role: 'owner', status: 'Active', companyId },
    { id: 2, name: 'Field Assigned', role: 'field', status: 'Active', companyId, memberId: 7 },
    { id: 3, name: 'Field Other', role: 'field', status: 'Active', companyId, memberId: 8 }
  ],
  sessions: [
    { companyId, userId: 1, tokenHash: hash(ownerToken), expiresAt: '2099-01-01' },
    { companyId, userId: 2, tokenHash: hash(fieldToken), expiresAt: '2099-01-01' },
    { companyId, userId: 3, tokenHash: hash(otherFieldToken), expiresAt: '2099-01-01' }
  ]
};
const file = path.join(root, 'db.json'); fs.writeFileSync(file, JSON.stringify(db)); fs.writeFileSync(path.join(root, 'platform.json'), JSON.stringify({ users: [], sessions: [] }));
Object.assign(process.env, { PDL_DB_FILE: file, PDL_PLATFORM_FILE: path.join(root, 'platform.json'), PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1' });
for (const name of ['OPENAI_API_KEY', 'SENTRY_DSN', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) delete process.env[name];
require('./database/supabase').loadLocalEnv = () => {};
const { server } = require('./server');
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = (method, route, input, token = ownerToken) => fetch(base + route, { method, signal: AbortSignal.timeout(10000), headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'x-pdl-company': companyId }, ...(input !== undefined ? { body: JSON.stringify(input) } : {}) }).then(async response => ({ status: response.status, data: await response.json() }));
  const reload = () => JSON.parse(fs.readFileSync(file));
  try {
    // Create: dates computed from the project start date (Monday 2026-10-12).
    const first = await call('POST', '/api/projects/101/tasks', { name: 'Excavate', durationDays: 3 });
    assert.equal(first.status, 201);
    const byId = new Map(first.data.tasks.map(t => [t.id, t]));
    assert.equal(byId.get(1).startDate, '2026-10-12');
    assert.equal(byId.get(1).endDate, '2026-10-14');

    // Chain: the second task starts the next working day after the first ends.
    const second = await call('POST', '/api/projects/101/tasks', { name: 'Footings', durationDays: 2, predecessorIds: [1] });
    assert.equal(second.status, 201);
    const chained = new Map(second.data.tasks.map(t => [t.id, t]));
    assert.equal(chained.get(2).startDate, '2026-10-15');
    assert.equal(chained.get(2).endDate, '2026-10-16');

    // Growing the first task cascades: the dependent reports a date change.
    const grow = await call('PATCH', '/api/project-tasks/1', { durationDays: 5 });
    assert.equal(grow.status, 200);
    const grown = new Map(grow.data.tasks.map(t => [t.id, t]));
    assert.equal(grown.get(1).endDate, '2026-10-16');
    assert.equal(grown.get(2).startDate, '2026-10-19', 'Friday finish rolls the successor past the weekend');
    assert.ok(grow.data.changed.includes(2), 'the dependent task is reported as moved');
    const stored = reload();
    assert.equal(stored.projectTasks.find(t => t.id === 2).startDate, '2026-10-19', 'cascade persisted to disk');

    // Status-only PATCH does not move dates but validates roles.
    const status = await call('PATCH', '/api/project-tasks/2', { status: 'in-progress' });
    assert.equal(status.status, 200);
    assert.equal(new Map(status.data.tasks.map(t => [t.id, t])).get(2).startDate, '2026-10-19');

    // Validation and cycles.
    const noName = await call('POST', '/api/projects/101/tasks', { name: '', durationDays: 1 });
    assert.equal(noName.status, 400);
    const badDuration = await call('POST', '/api/projects/101/tasks', { name: 'X', durationDays: 0 });
    assert.equal(badDuration.status, 400);
    const foreignPred = await call('POST', '/api/projects/101/tasks', { name: 'X', durationDays: 1, predecessorIds: [999] });
    assert.equal(foreignPred.status, 400, 'predecessors must be tasks in the same project');
    const cycle = await call('PATCH', '/api/project-tasks/1', { predecessorIds: [2] });
    assert.equal(cycle.status, 400);
    assert.match(cycle.data.error, /link back on themselves/);
    assert.equal(reload().projectTasks.find(t => t.id === 1).predecessorIds.length, 0, 'a rejected cycle leaves storage untouched');

    // Assignment fields ride along.
    const assign = await call('PATCH', '/api/project-tasks/2', { memberIds: [7], crew: 'A' });
    assert.equal(assign.status, 200);
    assert.deepEqual(reload().projectTasks.find(t => t.id === 2).memberIds, [7]);
    const badMember = await call('PATCH', '/api/project-tasks/2', { memberIds: [4242] });
    assert.equal(badMember.status, 400);

    // Field role: read only when assigned to the project; never write.
    const fieldReadDenied = await call('GET', '/api/projects/101/tasks', undefined, otherFieldToken);
    assert.equal(fieldReadDenied.status, 403);
    const fieldWrite = await call('POST', '/api/projects/101/tasks', { name: 'Nope', durationDays: 1 }, otherFieldToken);
    assert.equal(fieldWrite.status, 403);
    const dbNow = reload(); dbNow.assignments.push({ id: 1, projectId: 101, date: '2026-10-12', memberIds: [8], activity: 'Site work' }); fs.writeFileSync(file, JSON.stringify(dbNow));
    const fieldReadAllowed = await call('GET', '/api/projects/101/tasks', undefined, otherFieldToken);
    assert.equal(fieldReadAllowed.status, 200);
    assert.equal(fieldReadAllowed.data.length, 2);

    // Unknown project / task.
    assert.equal((await call('GET', '/api/projects/999/tasks')).status, 404);
    assert.equal((await call('PATCH', '/api/project-tasks/999', { name: 'X' })).status, 404);

    // Delete removes the task and unlinks dependents, then reschedules them up.
    const addThird = await call('POST', '/api/projects/101/tasks', { name: 'Walls', durationDays: 1, predecessorIds: [2] });
    const thirdId = addThird.data.tasks.find(t => t.name === 'Walls').id;
    const beforeDelete = new Map(addThird.data.tasks.map(t => [t.id, t]));
    assert.equal(beforeDelete.get(thirdId).startDate, '2026-10-21', 'task 2 ends Tuesday, so Walls waits for Wednesday');
    const del = await call('DELETE', '/api/project-tasks/2');
    assert.equal(del.status, 200);
    const after = new Map(del.data.tasks.map(t => [t.id, t]));
    assert.equal(after.get(thirdId).startDate, '2026-10-19', 'deleting its predecessor re-links it to task 1, so it pulls up to the next working day');
    const postDelete = reload();
    assert.equal(postDelete.projectTasks.some(t => t.id === 2), false);
    assert.deepEqual(postDelete.projectTasks.find(t => t.id === thirdId).predecessorIds, [1], 'the dependent is re-linked to the deleted task’s predecessor');

    // Cascade crossing a weekend stays business-day aligned.
    const w1 = await call('POST', '/api/projects/101/tasks', { name: 'Friday task', durationDays: 1 });
    const fridayId = w1.data.tasks.find(t => t.name === 'Friday task').id;
    await call('PATCH', `/api/project-tasks/${fridayId}`, { predecessorIds: [1] });
    const w2 = await call('POST', '/api/projects/101/tasks', { name: 'After Friday', durationDays: 1, predecessorIds: [fridayId] });
    const afterFriday = w2.data.tasks.find(t => t.name === 'After Friday');
    assert.equal(new Map(w2.data.tasks.map(t => [t.id, t])).get(fridayId).endDate, '2026-10-19');
    assert.equal(afterFriday.startDate, '2026-10-20');

    console.log('project-schedule API: ok');
  } finally {
    server.close();
  }
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
