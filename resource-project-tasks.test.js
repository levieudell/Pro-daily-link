'use strict';
// Test authority and malicious source data directly. CRUD effects are exercised
// through the actual named HTTP handlers in resource-project-tasks-http.test.js.
const assert = require('node:assert/strict');
const tasks = require('./resource-project-tasks');
const input = require('./resource-inputs');
const scheduling = require('./scheduling-access');
const { A, B, snapshot } = require('./compat-account-fixture');
const make = () => {
  const db = snapshot();
  db.projects[0].startDate = '2026-10-05';
  db.projects.push({ id: 102, name: 'Separate synthetic project', startDate: '2026-10-05' });
  db.team.push({ id: 12, name: 'North member', crew: 'North' }, { id: 13, name: 'South member', crew: 'South' });
  db.projectTasks = [
    { id: 1, projectId: 101, name: 'North task', durationDays: 2, predecessorIds: [], memberIds: [12], crew: 'North', status: 'not-started', startDate: '2026-10-05', endDate: '2026-10-06' },
    { id: 2, projectId: 101, name: 'South task in shared project', durationDays: 1, predecessorIds: [1], memberIds: [13], crew: 'South', status: 'in-progress', startDate: '2026-10-07', endDate: '2026-10-07' },
    { id: 3, projectId: 102, name: 'Other project task', durationDays: 1, predecessorIds: [], memberIds: [13], crew: 'South', status: 'not-started', startDate: '2026-10-05', endDate: '2026-10-05' }
  ];
  db.assignments = [{ id: 1, projectId: 101, memberIds: [12, 13], date: '2026-10-05', start: '07:00', end: '15:30' }];
  return db;
};
const actor = (role, extra = {}) => ({ id: 2, companyId: A, name: 'Synthetic ' + role, status: 'Active', role, memberId: 12, projectIds: [101], assignedCrews: ['North'], permissions: { scheduleCrews: true }, ...extra });
const auth = user => ({ user });
const op = (kind, method, path, details = {}) => input.parse({ kind, method, path, details });
const rejects = (fn, status) => assert.throws(fn, error => error.statusCode === status);
const policy = () => ({ version: 1, revision: 1, roles: Object.fromEntries(scheduling.roles.map(role => [role, scheduling.ceiling(role)])) });

assert.equal(tasks.route('GET', '/api/projects/101/tasks'), 'projectTasksView');
assert.equal(input.route('POST', '/api/projects/101/tasks'), 'projectTaskCreate');
assert.equal(tasks.route('PATCH', '/api/project-tasks/1'), 'projectTaskEdit');
assert.equal(tasks.route('DELETE', '/api/project-tasks/1'), 'projectTaskRemove');
assert.equal(tasks.route('PATCH', '/api/projects/101'), 'projectDates');
assert.equal(tasks.route('POST', '/api/project-tasks/1/assign'), 'projectTaskAssign');
assert.equal(tasks.route('PATCH', '/api/project-tasks/01'), null);
assert.equal(tasks.route('POST', '/api/projects/101/tasks?companyId=' + B), null);

const create = op('projectTaskCreate', 'POST', '/api/projects/101/tasks', { name: '  Synthetic bounded task  ', durationDays: 2, memberIds: [12], predecessorIds: [1], crew: 'North' });
assert.equal(create.details.name, 'Synthetic bounded task');
for (const details of [
  { name: 'Bad', durationDays: '2' },
  { name: 'Bad', durationDays: 0 },
  { name: 'Bad', durationDays: 366 },
  { name: 'Bad', durationDays: 2, memberIds: [12, 12] },
  { name: 'Bad', durationDays: 2, memberIds: ['12'] },
  { name: 'Bad', durationDays: 2, predecessorIds: [1, 1] },
  { name: 'Bad', durationDays: 2, status: 'approved' },
  { name: 'Bad', durationDays: 2, companyId: B },
  { name: 'Bad', durationDays: 2, startDate: '2026-10-05' },
  { name: 'Bad', durationDays: 2, budget: 500 }
]) rejects(() => op('projectTaskCreate', 'POST', '/api/projects/101/tasks', details), 400);
for (const details of [{ startDate: '2026-02-30' }, { endDate: '2026-10-01', startDate: '2026-10-05' }, { startDate: '2026-10-05', contractValue: 500 }, { startDate: '2026-10-05', name: 'Change other metadata' }]) rejects(() => op('projectDates', 'PATCH', '/api/projects/101', details), 400);
rejects(() => op('projectTaskRemove', 'DELETE', '/api/project-tasks/1', { memberIds: [12] }), 400);
rejects(() => op('projectTaskAssign', 'POST', '/api/project-tasks/1/assign', { memberId: 12, fromDate: '2026-02-30' }), 400);

const db = make(), pm = actor('project_manager');
tasks.authorize(db, auth(pm), create, {}, input);
rejects(() => tasks.authorize(db, auth(actor('project_manager', { permissions: { scheduleCrews: false } })), create, {}, input), 403);
rejects(() => tasks.authorize(db, auth(pm), op('projectTaskCreate', 'POST', '/api/projects/102/tasks', { name: 'Other project', durationDays: 1 }), {}, input), 404);
rejects(() => tasks.authorize(db, auth(pm), op('projectTaskCreate', 'POST', '/api/projects/101/tasks', { name: 'Mixed crews', durationDays: 1, memberIds: [12, 13] }), {}, input), 403);
rejects(() => tasks.authorize(db, auth(pm), op('projectTaskEdit', 'PATCH', '/api/project-tasks/2', { name: 'Steal South task', memberIds: [12] }), {}, input), 403);
rejects(() => tasks.authorize(db, auth(pm), op('projectTaskCreate', 'POST', '/api/projects/101/tasks', { name: 'Foreign dependency', durationDays: 1, predecessorIds: [3] }), {}, input), 400);
for (const role of ['field', 'foreman']) rejects(() => tasks.authorize(db, auth(actor(role)), create, {}, input), 403);
for (const role of ['crew', 'platform_admin']) rejects(() => tasks.authorizeActor(auth(actor(role)), create, input), 403);

const restricted = make(); restricted.company.schedulingRolePolicy = policy(); restricted.company.schedulingRolePolicy.roles.project_manager.create = false;
rejects(() => tasks.authorize(restricted, auth(pm), create, {}, input), 403);
restricted.company.schedulingRolePolicy.roles.admin.view = false;
for (const action of ['create', 'edit', 'remove', 'acknowledge']) restricted.company.schedulingRolePolicy.roles.admin[action] = false;
rejects(() => tasks.visible(restricted, actor('admin'), 101, input), 403);
assert.equal(tasks.visible(restricted, actor('owner'), 101, input).length, 2, 'Owner cannot be locked out by an editable role row');

const pmRows = tasks.visible(db, pm, 101, input);
assert.deepEqual(pmRows.map(row => row.memberIds), [[12], []]);
assert.equal(pmRows[1].crew, '');
assert.deepEqual(pmRows.map(row => row.readOnly), [false, true], 'mixed/outside original membership is visibly read-only without exposing the hidden employee IDs');
for (const role of ['field', 'foreman']) {
  assert.deepEqual(tasks.visible(db, actor(role), 101, input).map(row => row.memberIds), [[12], []]);
  assert.ok(tasks.visible(db, actor(role), 101, input).every(row => row.crew === ''));
  assert.ok(tasks.visible(db, actor(role), 101, input).every(row => row.readOnly === true));
  rejects(() => tasks.visible(db, actor(role), 102, input), 404);
}
const archived = make(); archived.team.find(row => row.id === 12).archivedAt = '2026-10-01T00:00:00.000Z';
rejects(() => tasks.authorize(archived, auth(pm), create, {}, input), 409);
for (const poison of [
  value => value.projectTasks[0].predecessorIds = [3],
  value => value.projectTasks[2].predecessorIds = [1],
  value => value.projectTasks[0].predecessorIds = [2],
  value => value.projectTasks[0].companyId = B,
  value => value.projectTasks[0].memberIds = [999],
  value => value.projectTasks[1].id = 1
]) { const value = make(); poison(value); rejects(() => tasks.graph(value, input), 409); }
console.log('resource project tasks: finite parsing, immutable Owner, stored/typed scheduling restrictions, whole-crew authority, scoped views and poisoned dependencies passed');
