'use strict';
// Linked project tasks API: CRUD, dependency cascades, cycle rejection,
// role gates (office writes; field reads only assigned projects), and
// per-tenant isolation through the real server.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-project-schedule-')), companyId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ownerToken = 'synthetic-schedule-owner', fieldToken = 'synthetic-schedule-field', otherFieldToken = 'synthetic-schedule-other', managerToken = 'synthetic-schedule-manager', readOnlyManagerToken = 'synthetic-schedule-manager-readonly';
const hash = token => crypto.createHash('sha256').update(token).digest('hex');
const db = {
  company: { id: companyId, name: 'Synthetic schedule', demo: true, timezone: 'UTC' },
  projects: [{ id: 101, name: 'North Ridge', customer: 'Test Customer', site: 'Site A', startDate: '2026-10-12', endDate: '2026-12-31', status: 'Active' }, { id: 102, name: 'Hidden Job', customer: 'Test Customer', site: 'Site B', startDate: '2026-10-12', endDate: '2026-12-31', status: 'Active' }],
  team: [{ id: 7, name: 'Chloe', crew: 'A' }, { id: 8, name: 'Andi', crew: 'A' }, { id: 9, name: 'Hidden Worker', crew: 'B' }],
  assignments: [], workdays: [], timeCards: [], timeOffRequests: [], reports: [], photos: [], auditLog: [], projectTasks: [], customers: [], changes: [], catalog: [], crews: [{ id: 1, name: 'A' }],
  users: [
    { id: 1, name: 'Synthetic owner', role: 'owner', status: 'Active', companyId },
    { id: 2, name: 'Field Assigned', role: 'field', status: 'Active', companyId, memberId: 7 },
    { id: 3, name: 'Field Other', role: 'field', status: 'Active', companyId, memberId: 8 },
    { id: 4, name: 'Scoped PM', role: 'project_manager', status: 'Active', companyId, projectIds: [101], assignedCrews: ['A'], permissions: { scheduleCrews: true } },
    { id: 5, name: 'Read-only PM', role: 'project_manager', status: 'Active', companyId, projectIds: [101], assignedCrews: ['A'], permissions: { scheduleCrews: false } }
  ],
  sessions: [
    { companyId, userId: 1, tokenHash: hash(ownerToken), expiresAt: '2099-01-01' },
    { companyId, userId: 2, tokenHash: hash(fieldToken), expiresAt: '2099-01-01' },
    { companyId, userId: 3, tokenHash: hash(otherFieldToken), expiresAt: '2099-01-01' },
    { companyId, userId: 4, tokenHash: hash(managerToken), expiresAt: '2099-01-01' },
    { companyId, userId: 5, tokenHash: hash(readOnlyManagerToken), expiresAt: '2099-01-01' }
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

    // Project managers can read assigned projects, but task writes require the
    // schedule permission and may target only their assigned project + crews.
    assert.equal((await call('GET', '/api/projects/101/tasks', undefined, managerToken)).status, 200);
    assert.equal((await call('GET', '/api/projects/102/tasks', undefined, managerToken)).status, 403, 'a guessed project id cannot expose another manager’s task schedule');
    assert.equal((await call('GET', '/api/projects/101/tasks', undefined, readOnlyManagerToken)).status, 200, 'read-only PMs may inspect their assigned project plan');
    assert.equal((await call('POST', '/api/projects/101/tasks', { name: 'No permission', durationDays: 1 }, readOnlyManagerToken)).status, 403);
    assert.equal((await call('PATCH', '/api/project-tasks/1', { durationDays: 1 }, readOnlyManagerToken)).status, 403);
    assert.equal((await call('DELETE', '/api/project-tasks/1', undefined, readOnlyManagerToken)).status, 403);
    assert.equal((await call('POST', '/api/project-tasks/1/assign', { memberId: 7 }, readOnlyManagerToken)).status, 403);
    assert.equal((await call('POST', '/api/projects/102/tasks', { name: 'Foreign project', durationDays: 1 }, managerToken)).status, 403);
    assert.equal((await call('POST', '/api/projects/101/tasks', { name: 'Foreign crew', durationDays: 1, memberIds: [9], crew: 'B' }, managerToken)).status, 403);
    const ownTask = await call('POST', '/api/projects/101/tasks', { name: 'PM task', durationDays: 1 }, managerToken);
    assert.equal(ownTask.status, 201, 'a PM with schedule permission can add unassigned work to an assigned project');
    const ownTaskId = ownTask.data.tasks.find(task => task.name === 'PM task').id;
    assert.equal((await call('DELETE', `/api/project-tasks/${ownTaskId}`, undefined, managerToken)).status, 200);
    const foreignCrewTask = await call('POST', '/api/projects/101/tasks', { name: 'Other crew task', durationDays: 1, memberIds: [9], crew: 'B' });
    assert.equal(foreignCrewTask.status, 201);
    const foreignCrewTaskId = foreignCrewTask.data.tasks.find(task => task.name === 'Other crew task').id;
    assert.equal((await call('PATCH', `/api/project-tasks/${foreignCrewTaskId}`, { durationDays: 2 }, managerToken)).status, 403, 'a PM cannot mutate another crew’s task by id');
    assert.equal((await call('DELETE', `/api/project-tasks/${foreignCrewTaskId}`, undefined, managerToken)).status, 403, 'a PM cannot delete another crew’s task by id');
    assert.equal((await call('POST', `/api/project-tasks/${foreignCrewTaskId}/assign`, { memberId: 7 }, managerToken)).status, 403, 'a PM cannot take over another crew’s task by id');

    // Renaming a crew preserves every PM scope and current scheduling record.
    const scopedAssignment = await call('POST', '/api/assignments', { projectId: 101, memberIds: [7], crew: 'A', date: '2099-12-30', start: '07:00', end: '15:30', activity: 'Future scoped work' });
    assert.equal(scopedAssignment.status, 201);
    const archivedHistoryAssignment = await call('POST', '/api/assignments', { projectId: 102, memberIds: [7], crew: 'A', date: '2099-12-29', start: '07:00', end: '15:30', activity: 'Existing historical work' });
    assert.equal(archivedHistoryAssignment.status, 201);
    const hiddenProjectTask = await call('POST', '/api/projects/102/tasks', { name: 'Existing hidden-project task', durationDays: 1 });
    assert.equal(hiddenProjectTask.status, 201);
    const hiddenProjectTaskId = hiddenProjectTask.data.tasks.find(task => task.name === 'Existing hidden-project task').id;
    const hiddenProjectEvent = await call('POST', '/api/projects/102/events', { date: '2026-10-20', type: 'inspection', title: 'Existing hidden-project inspection' });
    assert.equal(hiddenProjectEvent.status, 201);
    const renameCrew = await call('PATCH', '/api/crews/1', { name: 'Alpha', memberIds: [7, 8] });
    assert.equal(renameCrew.status, 200);
    const afterCrewRename = reload();
    assert.deepEqual(afterCrewRename.users.find(user => user.id === 4).assignedCrews, ['Alpha'], 'schedule PM keeps the renamed crew in scope');
    assert.deepEqual(afterCrewRename.users.find(user => user.id === 5).assignedCrews, ['Alpha'], 'read-only PM keeps the renamed crew in scope');
    assert.equal(afterCrewRename.assignments.find(row => row.id === scopedAssignment.data.id).crew, 'Alpha', 'future assignment carries the renamed crew label');
    assert.equal(afterCrewRename.projectTasks.find(row => row.id === 2).crew, 'Alpha', 'linked project task carries the renamed crew label');
    assert.equal((await call('PATCH', '/api/project-tasks/2', { status: 'in-progress' }, managerToken)).status, 200, 'crew rename does not revoke PM scheduling access');
    const mixedRoster = await call('POST', '/api/assignments', { projectId: 101, memberIds: [7, 9], crew: 'Mixed crew', date: '2099-12-27', start: '07:00', end: '15:30', activity: 'Shared-site work' });
    assert.equal(mixedRoster.status, 201);
    const managerState = await call('GET', '/api/state', undefined, managerToken);
    assert.equal(managerState.status, 200);
    const projectedMixedRoster = managerState.data.assignments.find(row => Number(row.id) === Number(mixedRoster.data.id));
    assert.ok(projectedMixedRoster, 'a mixed-roster assignment remains visible to the PM responsible for one member');
    assert.deepEqual(projectedMixedRoster.memberIds, [7], 'the PM receives only their own assigned crew member');
    assert.deepEqual(Object.keys(projectedMixedRoster.notifications || {}), ['7'], 'delivery state for another crew is not exposed');
    assert.deepEqual(Object.keys(projectedMixedRoster.acknowledgements || {}), [], 'acknowledgements for another crew are not exposed');
    assert.ok(managerState.data.projectTasks.some(task => Number(task.id) === 1), 'unassigned project work remains available for the PM to staff');
    assert.ok(managerState.data.projectTasks.some(task => Number(task.id) === 2), 'the PM receives work already assigned to their crew');
    assert.equal(managerState.data.projectTasks.some(task => Number(task.id) === Number(foreignCrewTaskId)), false, 'another crew’s project task is not exposed in workspace state');
    const managerTaskList = await call('GET', '/api/projects/101/tasks', undefined, managerToken);
    assert.equal(managerTaskList.status, 200);
    assert.equal(managerTaskList.data.some(task => Number(task.id) === Number(foreignCrewTaskId)), false, 'the direct project-task endpoint uses the same crew scope');

    // Archived jobs remain readable historically but cannot receive new work or
    // become the target of an assignment edit through a stale/direct client.
    const archiveHidden = await call('PATCH', '/api/projects/102/archive', { archived: true });
    assert.equal(archiveHidden.status, 200);
    assert.equal(archiveHidden.data.archived, true);
    const createOnArchived = await call('POST', '/api/assignments', { projectId: 102, memberIds: [7], crew: 'Alpha', date: '2099-12-31', start: '07:00', end: '15:30', activity: 'Must not schedule' });
    assert.equal(createOnArchived.status, 409);
    assert.match(createOnArchived.data.error, /restore this project/i);
    const editArchivedHistory = await call('PATCH', `/api/assignments/${archivedHistoryAssignment.data.id}`, { edit: true, projectId: 102, memberIds: [7], crew: 'Alpha', date: '2099-12-29', start: '07:00', end: '15:30', activity: 'Corrected historical work' });
    assert.equal(editArchivedHistory.status, 200, 'historical work may be corrected without moving it onto an archived project');
    const rescheduleArchivedHistory = await call('PATCH', `/api/assignments/${archivedHistoryAssignment.data.id}`, { edit: true, projectId: 102, memberIds: [7], crew: 'Alpha', date: '2099-12-28', start: '07:00', end: '15:30', activity: 'Must not move' });
    assert.equal(rescheduleArchivedHistory.status, 409, 'historical work on an archived project cannot be moved to a different day');
    const dragArchivedHistory = await call('PATCH', `/api/assignments/${archivedHistoryAssignment.data.id}`, { memberId: 7, targetMemberId: 7, date: '2099-12-28' });
    assert.equal(dragArchivedHistory.status, 409, 'dragging cannot bypass archived-project schedule protection');
    const moveToArchived = await call('PATCH', `/api/assignments/${scopedAssignment.data.id}`, { edit: true, projectId: 102, memberIds: [7], crew: 'Alpha', date: '2099-12-30', start: '07:00', end: '15:30', activity: 'Must remain on active project' });
    assert.equal(moveToArchived.status, 409);
    assert.equal(reload().assignments.find(row => row.id === scopedAssignment.data.id).projectId, 101, 'rejected move leaves the stored assignment untouched');
    assert.equal((await call('POST', '/api/projects/102/tasks', { name: 'Archived task', durationDays: 1 })).status, 409, 'archived projects reject new schedule tasks');
    assert.equal((await call('POST', `/api/project-tasks/${hiddenProjectTaskId}/assign`, { memberId: 9 })).status, 409, 'tasks on archived projects cannot create assignments');
    assert.equal((await call('PATCH', `/api/project-tasks/${hiddenProjectTaskId}`, { status: 'complete' })).status, 409, 'archived project tasks cannot be changed');
    assert.equal((await call('DELETE', `/api/project-tasks/${hiddenProjectTaskId}`)).status, 409, 'archived project tasks cannot be erased');
    assert.equal((await call('DELETE', `/api/project-events/${hiddenProjectEvent.data.id}`)).status, 409, 'archived project events cannot be erased');

    // The same project boundary protects schedule-adjacent events and messages.
    // These direct requests ensure a PM cannot bypass the UI with guessed ids.
    const ownEvent = await call('POST', '/api/projects/101/events', { date: '2026-10-20', type: 'delivery', title: 'Forms delivery' }, managerToken);
    assert.equal(ownEvent.status, 201, 'a scheduling PM can add an event to an assigned project');
    assert.equal((await call('POST', '/api/projects/102/events', { date: '2026-10-20', type: 'delivery', title: 'Hidden delivery' }, managerToken)).status, 403, 'a PM cannot add events to another project');
    assert.equal((await call('POST', '/api/projects/101/events', { date: '2026-10-20', type: 'delivery', title: 'No permission' }, readOnlyManagerToken)).status, 403, 'event changes require schedule permission');
    const hiddenEvent = await call('POST', '/api/projects/102/events', { date: '2026-10-20', type: 'inspection', title: 'Owner-only inspection' });
    assert.equal(hiddenEvent.status, 409, 'archived projects reject new schedule events');
    assert.equal((await call('DELETE', `/api/project-events/${ownEvent.data.id}`, undefined, managerToken)).status, 200, 'a scheduling PM can remove an event from an assigned project');
    assert.equal((await call('POST', '/api/projects/101/messages', { text: 'Crew update' }, managerToken)).status, 201, 'a PM can message an assigned project');
    assert.equal((await call('POST', '/api/projects/102/messages', { text: 'Hidden crew update' }, managerToken)).status, 403, 'a PM cannot message another project');
    assert.equal((await call('POST', '/api/projects/101/messages', { text: 'Read-only project update' }, readOnlyManagerToken)).status, 201, 'message access follows project scope rather than schedule-edit permission');
    assert.equal((await call('POST', '/api/projects/102/messages/read', {}, managerToken)).status, 403, 'a PM cannot mark another project’s messages read');
    assert.equal((await call('POST', '/api/projects/101/messages/read', {}, managerToken)).status, 200, 'a PM can mark assigned-project messages read');

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

    // Project dates PATCH: persists, validates, and re-anchors linked tasks.
    const moveStart = await call('PATCH', '/api/projects/101', { startDate: '2026-10-19' });
    assert.equal(moveStart.status, 200, 'dates PATCH works even with contract tracking off');
    assert.equal(moveStart.data.startDate, '2026-10-19');
    const moved = new Map(moveStart.data.tasks.map(t => [t.id, t]));
    assert.equal(moved.get(1).startDate, '2026-10-19', 'an unlinked task re-anchors to the new start date');
    assert.ok(moveStart.data.changed.includes(1), 're-anchoring reports the moved tasks');
    assert.equal(reload().projects.find(p => p.id === 101).startDate, '2026-10-19', 'start date persisted to disk');

    // End date must be on/after the start date; fake calendar dates are rejected.
    assert.equal((await call('PATCH', '/api/projects/101', { endDate: '2026-10-01' })).status, 400);
    assert.equal((await call('PATCH', '/api/projects/101', { startDate: '2026-13-40' })).status, 400);
    assert.equal((await call('PATCH', '/api/projects/101', { startDate: 'soon' })).status, 400);
    const setEnd = await call('PATCH', '/api/projects/101', { endDate: '2026-11-30' });
    assert.equal(setEnd.status, 200);
    assert.equal(setEnd.data.endDate, '2026-11-30');

    // Clearing the start date is allowed (tasks fall back to today); setting a
    // start date later re-anchors every task to the new anchor.
    const clearStart = await call('PATCH', '/api/projects/101', { startDate: '' });
    assert.equal(clearStart.status, 200);
    assert.equal(clearStart.data.startDate, '');
    assert.equal(reload().projects.find(p => p.id === 101).startDate, '');
    const reanchor = await call('PATCH', '/api/projects/101', { startDate: '2026-10-26' });
    assert.equal(reanchor.status, 200);
    assert.equal(new Map(reanchor.data.tasks.map(t => [t.id, t])).get(1).startDate, '2026-10-26');

    // Field role cannot change project dates; unknown project 404s.
    const fieldDates = await call('PATCH', '/api/projects/101', { startDate: '2026-10-12' }, otherFieldToken);
    assert.equal(fieldDates.status, 403);
    assert.equal((await call('PATCH', '/api/projects/999', { startDate: '2026-10-12' })).status, 404);

    console.log('project-schedule API: ok');
  } finally {
    server.close();
  }
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
