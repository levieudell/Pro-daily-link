'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { workspace } = require('./fixtures/roles-workspace'), { projection, createHandler } = require('./workspace-options');
const schedule = require('./scheduling-access'), daily = require('./daily-access'), review = require('./time-review-access');
const source = fs.readFileSync(require.resolve('./server'), 'utf8'), context = vm.createContext({});
for (const name of ['fieldRole', 'managerScope', 'fieldProjectIds', 'baselineNotesProjectAllowed']) { const start = source.indexOf('function ' + name + '('); vm.runInContext(source.slice(start, name === 'baselineNotesProjectAllowed' ? source.indexOf('\n}', start) + 2 : source.indexOf('\n', start)), context); }
async function main() {
  const db = workspace(), baseline = context.baselineNotesProjectAllowed;
  for (const workflow of ['schedule', 'cards']) {
    const options = projection(db, db.users[1], workflow, baseline);
    for (const project of options.projects) for (const member of options.team) assert.equal(workflow === 'schedule' ? schedule.inScope(db, db.users[1], { projectId: project.id, memberIds: [member.id] }, 'create') : review.cardInScope(db, db.users[1], { projectId: project.id, memberId: member.id }), true);
    assert.ok(!JSON.stringify(options).includes('PRIVATE-')); assert.ok(!options.team.some(row => row.id === 13));
  }
  for (const workflow of ['dailies', 'workdays']) { const options = projection(db, db.users[3], workflow, baseline); for (const project of options.projects) assert.equal(daily.projectAllowed(db, db.users[3], project.id), true); for (const member of options.team) assert.equal(daily.memberAllowed(db, db.users[3], member.id), true); }
  const restricted = structuredClone(db); restricted.users[1].permissions.scheduleCrews = false; assert.throws(() => projection(restricted, restricted.users[1], 'schedule', baseline), error => error.statusCode === 403);
  assert.throws(() => projection(db, db.users[3], 'cards', baseline), error => error.statusCode === 403);
  for (const bad of [false, {}, null]) { const malformed = structuredClone(db); malformed.team = bad; assert.throws(() => projection(malformed, malformed.users[0], 'schedule', baseline), error => error.statusCode === 409); }
  const foreign = structuredClone(db); foreign.projects[0].companyId = 'foreign'; assert.throws(() => projection(foreign, foreign.users[0], 'schedule', baseline), error => error.statusCode === 409);
  const alias = structuredClone(db); alias.team.push({ ...alias.team[0], id: String(alias.team[0].id) }); assert.throws(() => projection(alias, alias.users[0], 'schedule', baseline), error => error.statusCode === 409);
  for (const items of [null, {}, [{ id: 1, name: 'Scope', unit: 'SF', companyId: 'foreign' }], [{ id: 1, name: 'Scope', unit: 'SF' }, { id: '1', name: 'Alias', unit: 'SF' }]]) { const malformed = structuredClone(db); malformed.projects[0].estimateItems = items; assert.throws(() => projection(malformed, malformed.users[0], 'dailies', baseline), error => error.statusCode === 409); }
  for (const role of ['crew', 'platform_owner']) assert.throws(() => projection(db, { ...db.users[0], role }, 'schedule', baseline), error => error.statusCode === 403);
  for (const record of [{ id: 9001, companyId: 'foreign', projectId: 102, memberIds: [11] }, { id: '09001', projectId: 102, memberIds: [11] }, { id: 9001, projectId: '0102', memberIds: [11] }, { id: 9001, projectId: 102, memberIds: [11, '11'] }, { id: 9001, projectId: 102, memberIds: true }]) { const malformed = structuredClone(db); malformed.reports = []; malformed.assignments = [record]; for (const workflow of ['workdays','dailies']) assert.throws(() => projection(malformed, malformed.users[3], workflow, baseline), error => error.statusCode === 409); }
  let status, writes = 0;
  const handler = createHandler({ readDb: () => db, accountAccess: () => ({ locked: false }), baselineProjectAllowed: baseline, assertCurrent: async () => { throw Object.assign(Error('Revoked'), { statusCode: 401 }); }, json: (_, code) => { status = code; } });
  await handler({ method: 'GET', auth: { user: db.users[0] } }, {}, new URL('http://local/api/workspace/options?workflow=schedule')); assert.equal(status, 401); assert.equal(writes, 0);
  await handler({ method: 'GET', auth: { user: db.users[0] } }, {}, new URL('http://local/api/workspace/options?workflow=schedule&workflow=cards')); assert.equal(status, 400);
  console.log('Workspace options: original action/scope oracles, restricted grants, finite names, malformed/foreign/alias containment, fixed roles and zero-write revoked delivery passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
