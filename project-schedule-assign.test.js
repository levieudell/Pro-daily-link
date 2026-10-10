'use strict';
// Assign an unscheduled project task to a person from the team schedule:
// the endpoint fans the task out into daily assignment rows (business days,
// merging into same-project shifts), skips days the person cannot work, and
// only claims the task when at least one day landed.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-task-assign-')), companyId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', ownerToken = 'synthetic-assign-owner', fieldToken = 'synthetic-assign-field';
const hash = token => crypto.createHash('sha256').update(token).digest('hex');
const db = {
  company: { id: companyId, name: 'Synthetic assign', demo: true, timezone: 'UTC' },
  projects: [
    { id: 101, name: 'North Ridge', customer: 'Test Customer', site: 'Site A', startDate: '2026-10-12', endDate: '2026-12-31', status: 'Active' },
    { id: 102, name: 'Other Job', customer: 'Test Customer', site: 'Site B', startDate: '2026-10-12', endDate: '2026-12-31', status: 'Active' }
  ],
  team: [{ id: 7, name: 'Chloe', crew: 'A' }, { id: 8, name: 'Andi', crew: 'A' }],
  assignments: [], workdays: [], timeCards: [], timeOffRequests: [], reports: [], photos: [], auditLog: [], projectTasks: [], customers: [], changes: [], catalog: [],
  users: [
    { id: 1, name: 'Synthetic owner', role: 'owner', status: 'Active', companyId },
    { id: 2, name: 'Field Assigned', role: 'field', status: 'Active', companyId, memberId: 7 }
  ],
  sessions: [
    { companyId, userId: 1, tokenHash: hash(ownerToken), expiresAt: '2099-01-01' },
    { companyId, userId: 2, tokenHash: hash(fieldToken), expiresAt: '2099-01-01' }
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
  const patchDb = mutate => { const current = reload(); mutate(current); fs.writeFileSync(file, JSON.stringify(current)); };
  try {
    // Task 1: Mon–Wed 2026-10-12..14 (project starts Monday).
    const first = await call('POST', '/api/projects/101/tasks', { name: 'Excavate', durationDays: 3 });
    assert.equal(first.status, 201);
    const task1 = first.data.tasks[0].id;

    // Assign to Chloe: three business-day rows, standard shift, task claimed.
    const assign = await call('POST', `/api/project-tasks/${task1}/assign`, { memberId: 7 });
    assert.equal(assign.status, 200);
    assert.equal(assign.data.created, 3);
    assert.equal(assign.data.merged, 0);
    assert.equal(assign.data.skipped, 0);
    assert.equal(assign.data.memberName, 'Chloe');
    const rows = reload().assignments.filter(a => a.projectId === 101);
    assert.deepEqual(rows.map(a => a.date).sort(), ['2026-10-12', '2026-10-13', '2026-10-14']);
    for (const row of rows) {
      assert.deepEqual(row.memberIds, [7]);
      assert.equal(row.start, '07:00');
      assert.equal(row.end, '15:30');
      assert.equal(row.activity, 'Excavate');
      assert.ok(row.notifications[7].inAppAt, 'the new assignee is notified in-app');
    }
    assert.deepEqual(reload().projectTasks.find(t => t.id === task1).memberIds, [7], 'the task is claimed by Chloe');

    // Re-assign the same task to Andi: she joins Chloe's existing shifts (no duplicate rows).
    const reassign = await call('POST', `/api/project-tasks/${task1}/assign`, { memberId: 8 });
    assert.equal(reassign.status, 200);
    assert.equal(reassign.data.created, 0);
    assert.equal(reassign.data.merged, 3, 'the new assignee merges into the task’s existing shifts');
    assert.equal(reassign.data.skipped, 0);
    assert.equal(reload().assignments.filter(a => a.projectId === 101).length, 3, 'no duplicate rows');
    assert.deepEqual(reload().assignments.filter(a => a.date === '2026-10-12')[0].memberIds, [7, 8]);
    assert.deepEqual(reload().projectTasks.find(t => t.id === task1).memberIds, [8], 'the task now belongs to Andi');

    // Task 2: Thu–Fri 2026-10-15..16 after Excavate.
    const second = await call('POST', '/api/projects/101/tasks', { name: 'Footings', durationDays: 2, predecessorIds: [task1] });
    const task2 = second.data.tasks.find(t => t.name === 'Footings').id;
    assert.equal(second.data.tasks.find(t => t.id === task2).startDate, '2026-10-15');

    // Chloe already holds a same-project shift on 10/15: Andi merges into it, 10/16 creates a new row.
    patchDb(current => current.assignments.push({ id: 900, projectId: 101, date: '2026-10-15', start: '07:00', end: '15:30', memberIds: [7], crew: 'A', activity: 'Prep', notifications: {}, acknowledgements: {} }));
    const merge = await call('POST', `/api/project-tasks/${task2}/assign`, { memberId: 8 });
    assert.equal(merge.status, 200);
    assert.equal(merge.data.created, 1);
    assert.equal(merge.data.merged, 1);
    const mergedRow = reload().assignments.find(a => a.id === 900);
    assert.deepEqual(mergedRow.memberIds, [7, 8], 'Andi joins Chloe’s existing shift');
    assert.ok(mergedRow.notifications[8], 'the merged-in member is notified');

    // Task 3: Mon 2026-10-19 after Footings. Andi is booked on another job that day → day skipped.
    const third = await call('POST', '/api/projects/101/tasks', { name: 'Walls', durationDays: 1, predecessorIds: [task2] });
    const task3 = third.data.tasks.find(t => t.name === 'Walls').id;
    assert.equal(third.data.tasks.find(t => t.id === task3).startDate, '2026-10-19');
    patchDb(current => current.assignments.push({ id: 901, projectId: 102, date: '2026-10-19', start: '07:00', end: '15:30', memberIds: [8], crew: 'A', activity: 'Booked', notifications: {}, acknowledgements: {} }));
    const conflicted = await call('POST', `/api/project-tasks/${task3}/assign`, { memberId: 8 });
    assert.equal(conflicted.status, 200);
    assert.equal(conflicted.data.created, 0);
    assert.equal(conflicted.data.skipped, 1);
    assert.equal(reload().projectTasks.find(t => t.id === task3).memberIds.length, 0, 'a task with no schedulable days stays unassigned');
    assert.ok(!reload().assignments.some(a => a.projectId === 101 && a.date === '2026-10-19' && a.memberIds.includes(8)), 'the conflicting day is not written');

    // Weekend tasks skip Saturday/Sunday: task 4 spans Fri 10/16 → Tue 10/20.
    const friday = await call('POST', '/api/projects/101/tasks', { name: 'Grade', durationDays: 1, predecessorIds: [task1] });
    const gradeId = friday.data.tasks.find(t => t.name === 'Grade').id;
    assert.equal(friday.data.tasks.find(t => t.id === gradeId).startDate, '2026-10-15');
    const span = await call('POST', '/api/projects/101/tasks', { name: 'Cure & strip', durationDays: 3, predecessorIds: [gradeId] });
    const task4 = span.data.tasks.find(t => t.name === 'Cure & strip').id;
    assert.equal(span.data.tasks.find(t => t.id === task4).startDate, '2026-10-16');
    assert.equal(span.data.tasks.find(t => t.id === task4).endDate, '2026-10-20', 'Friday + 3 business days rolls across the weekend');
    const weekend = await call('POST', `/api/project-tasks/${task4}/assign`, { memberId: 7 });
    assert.equal(weekend.status, 200);
    assert.equal(weekend.data.created, 2, 'Mon+Tue create rows');
    assert.equal(weekend.data.merged, 1, 'Friday Chloe simply joins Andi’s existing Footings shift instead of double-booking the project');
    assert.equal(weekend.data.skipped, 0);
    assert.deepEqual(reload().assignments.filter(a => a.projectId === 101 && a.date >= '2026-10-16' && a.date <= '2026-10-20' && a.memberIds.includes(7)).map(a => a.date).sort(), ['2026-10-16', '2026-10-19', '2026-10-20'], 'no rows on the weekend');

    // Approved time off skips the day too: task 5 is Wed 2026-10-21 and Chloe is off that day.
    const fifth = await call('POST', '/api/projects/101/tasks', { name: 'Backfill', durationDays: 1, predecessorIds: [task4] });
    const task5 = fifth.data.tasks.find(t => t.name === 'Backfill').id;
    assert.equal(fifth.data.tasks.find(t => t.id === task5).startDate, '2026-10-21');
    patchDb(current => current.timeOffRequests.push({ id: 'leave-1', memberId: 7, startDate: '2026-10-21', endDate: '2026-10-21', allDay: true, type: 'vacation', status: 'approved', requestedAt: '2026-10-01T00:00:00Z' }));
    const onLeave = await call('POST', `/api/project-tasks/${task5}/assign`, { memberId: 7 });
    assert.equal(onLeave.status, 200);
    assert.equal(onLeave.data.created, 0);
    assert.equal(onLeave.data.skipped, 1);
    assert.equal(reload().projectTasks.find(t => t.id === task5).memberIds.length, 0);

    // fromDate clamps the fan-out: task 6 is Thu–Fri 2026-10-22..23, but assigning
    // from Friday only schedules Friday.
    const sixth = await call('POST', '/api/projects/101/tasks', { name: 'Punch list', durationDays: 2, predecessorIds: [task5] });
    const task6 = sixth.data.tasks.find(t => t.name === 'Punch list').id;
    assert.equal(sixth.data.tasks.find(t => t.id === task6).startDate, '2026-10-22');
    const clamp = await call('POST', `/api/project-tasks/${task6}/assign`, { memberId: 8, fromDate: '2026-10-23' });
    assert.equal(clamp.status, 200);
    assert.equal(clamp.data.created, 1);
    assert.ok(reload().assignments.some(a => a.projectId === 101 && a.date === '2026-10-23' && a.memberIds.includes(8)), 'Friday picks up the new assignee');
    assert.ok(!reload().assignments.some(a => a.projectId === 101 && a.date === '2026-10-22' && a.memberIds.includes(8)), 'Thursday before the picked day stays untouched');

    // Same person, same task, same start: pure idempotency, nothing doubles up.
    const again = await call('POST', `/api/project-tasks/${task6}/assign`, { memberId: 8, fromDate: '2026-10-23' });
    assert.equal(again.status, 200);
    assert.equal(again.data.created, 0);
    assert.equal(again.data.merged, 0);
    assert.equal(again.data.skipped, 1);

    // Gates: field role, unknown task, unknown member, and a fromDate past the end.
    assert.equal((await call('POST', `/api/project-tasks/${task1}/assign`, { memberId: 7 }, fieldToken)).status, 403);
    assert.equal((await call('POST', '/api/project-tasks/999/assign', { memberId: 7 })).status, 404);
    assert.equal((await call('POST', `/api/project-tasks/${task2}/assign`, { memberId: 4242 })).status, 400);
    const afterEnd = await call('POST', `/api/project-tasks/${task2}/assign`, { memberId: 7, fromDate: '2027-01-05' });
    assert.equal(afterEnd.status, 400);
    assert.match(afterEnd.data.error, /on or before the task ends/);

    console.log('project-task assign API: ok');
  } finally {
    server.close();
  }
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
