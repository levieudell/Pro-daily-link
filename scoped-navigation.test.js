'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { workspace } = require('./fixtures/roles-workspace'), registry = require('./capability-registry');
const { projection, createHandler } = require('./scoped-navigation');
// Exercise the unchanged original scope helpers without starting the application.
const source = fs.readFileSync(require.resolve('./server'), 'utf8'), context = vm.createContext({});
for (const name of ['fieldRole', 'managerScope', 'fieldProjectIds', 'baselineNotesProjectAllowed']) {
  const start = source.indexOf('function ' + name + '('), end = source.indexOf('\n}', start);
  const body = name === 'baselineNotesProjectAllowed' ? source.slice(start, end + 2) : source.slice(start, source.indexOf('\n', start));
  vm.runInContext(body, context);
}
const baseline = context.baselineNotesProjectAllowed;
const policy = module => ({ version: 1, revision: 1, roles: Object.fromEntries(module.roles.map(role => [role, module.ceiling(role)])) });
async function main() {
  let db = workspace(); const pristine = structuredClone(db), view = id => projection(db, registry.actor(db, db.users.find(row => row.id === id), true), baseline, 17);
  const owner = view(1), manager = view(2), field = view(4), foreman = view(5);
  assert.deepEqual(manager.projects.map(row => row.id), [101]); assert.deepEqual(manager.team.map(row => row.id), [11]); assert.deepEqual(manager.customers.map(row => row.id), [1]);
  assert.deepEqual(field.customers, []); assert.deepEqual(foreman.customers, []); assert.deepEqual(field.projects.map(row => row.id), [101, 102]);
  assert.equal(manager.projects[0].views.scheduling, true); assert.equal(manager.projects[0].views.reports, false);
  assert.equal(owner.settings.roles, true); assert.equal(view(7).settings.roles, false); assert.equal(owner.immutableMetadataDirectory, true);
  assert.ok(!JSON.stringify(owner).includes('PRIVATE-')); assert.deepEqual(db, pristine);
  db.company.notesRolePolicy = policy(require('./notes-access')); assert.deepEqual(view(4).projects.map(row => row.id), [101]);
  db.company.notesRolePolicy.roles.project_manager = { view: false, create: false, edit: false, complete: false };
  db.company.schedulingRolePolicy = policy(require('./scheduling-access')); db.company.schedulingRolePolicy.roles.project_manager = { view: false, create: false, edit: false, remove: false, acknowledge: false };
  assert.deepEqual(view(2).projects, []); assert.deepEqual(view(2).team, []); assert.deepEqual(view(2).customers, []);
  assert.equal(view(7).projects.length, 2); assert.equal(view(7).projects[0].views.notes, true);
  db = structuredClone(pristine); db.projects[0].customerId = '1'; assert.deepEqual(view(2).customers, []); assert.equal(view(2).missingCustomerLinks, 1);
  for (const mutate of [db => { db.customers.unshift({ id: '01', name: 'PRIVATE-NESTED' }); }, db => { db.team[2].name = { secret: 'PRIVATE-NESTED' }; }, db => { db.projects[0].companyId = 'foreign'; }, db => { db.customers = false; }, db => { db.timeCards = null; }, db => { db.assignments[0].memberIds = [[11]]; }, db => { db.assignments[0].memberIds = [999]; }, db => { db.workdays = [{ id: 1, projectId: 999, memberIds: [11] }]; }, db => { db.reports[0].project = [1]; }, db => { db.users[1].name = { secret: 'PRIVATE-NESTED' }; }]) {
    db = structuredClone(pristine); mutate(db); assert.throws(() => view(1), { statusCode: 409 });
  }
  db = structuredClone(pristine); let response, locked = false, revoked = false;
  const handler = createHandler({ readDb: () => db, json: (_res, status, data) => { response = { status, data }; }, revision: () => 17, assertCurrent: async () => { if (revoked) throw Object.assign(Error('Revoked synthetic read'), { statusCode: 401 }); }, accountAccess: () => ({ locked }), baselineProjectAllowed: baseline });
  const req = { method: 'GET', auth: { user: db.users[0], session: db.sessions[0] } };
  await handler(req, {}, new URL('http://localhost/api/navigation')); assert.equal(response.status, 200); assert.match(response.data.sessionBinding, /^[a-f0-9]{64}$/); assert.notEqual(response.data.sessionBinding, db.sessions[0].tokenHash); assert.deepEqual(db, pristine);
  revoked = true; await handler(req, {}, new URL('http://localhost/api/navigation')); assert.equal(response.status, 401); assert.ok(!response.data.actor);
  locked = true; await handler(req, {}, new URL('http://localhost/api/navigation')); assert.equal(response.status, 402);
  console.log('Scoped navigation tests passed: finite fields, original notes/name evidence, strict customer links, actual mixed-crew view projection, deny-first policy scopes, malformed identities and revoked/locked read delivery.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
