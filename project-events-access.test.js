'use strict';
// Finite event deltas and inherited authority over generated source only.
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const events = require('./project-events-access'), scheduling = require('./scheduling-access'), profiles = require('./role-profiles');
const { canonicalHash } = require('./database/transactional-repository');
let checks = 0;
const eq = (actual, expected, label) => { checks++; assert.deepEqual(actual, expected, label); };
const rejects = (run, status, label) => { checks++; assert.throws(run, error => error.statusCode === status, label); };
function seed() {
  const companyId = crypto.randomUUID(), users = [
    { id: 1, companyId, role: 'owner', status: 'Active', name: 'Synthetic Owner' }, { id: 2, companyId, role: 'admin', status: 'Active', name: 'Synthetic Admin' },
    { id: 3, companyId, role: 'project_manager', status: 'Active', name: 'Synthetic PM', projectIds: [101], assignedCrews: ['A'], permissions: { scheduleCrews: true } },
    { id: 4, companyId, role: 'field', status: 'Active', name: 'Synthetic Field', memberId: 7 }, { id: 5, companyId, role: 'foreman', status: 'Active', name: 'Synthetic Foreman', memberId: 8 }
  ];
  const rows = [101, 102].map((projectId, index) => ({ id: index + 1, projectId, date: '2026-10-13', type: 'delivery', title: 'Synthetic event ' + projectId, notes: '', createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'Synthetic Owner' }));
  return { company: { id: companyId }, users, projects: [{ id: 101, name: 'Synthetic assigned' }, { id: 102, name: 'Synthetic foreign' }], team: [{ id: 7, name: 'Synthetic Field', crew: 'A' }, { id: 8, name: 'Synthetic Foreman', crew: 'A' }], assignments: [{ id: 1, projectId: 101, memberIds: [7, 8] }], workdays: [], reports: [], projectEvents: rows, auditLog: [] };
}
function add(before, user, operation) { const after = structuredClone(before); after.projectEvents.push({ id: Math.max(...before.projectEvents.map(row => row.id), 0) + 1, projectId: operation.projectId, ...operation.details, createdAt: '2026-10-12T12:00:00.000Z', createdBy: user.name }); return after; }
function mask(db, role, flags) { db.company.schedulingPolicyRequired = true; db.company.schedulingRolePolicy = { version: 1, revision: 1, roles: Object.fromEntries(scheduling.roles.map(name => [name, scheduling.ceiling(name)])) }; Object.assign(db.company.schedulingRolePolicy.roles[role], flags); }
const create = events.parse(events.route('POST', '/api/projects/101/events'), { date: '2026-10-13', type: 'delivery', title: ' Synthetic reviewed event ', notes: ' Synthetic notes ' });
eq(create.details, { date: '2026-10-13', type: 'delivery', title: 'Synthetic reviewed event', notes: 'Synthetic notes' });
eq(events.parse(events.route('POST', '/api/projects/101/events'), { date: '2028-02-29', title: 'Synthetic leap date' }).details, { date: '2028-02-29', type: 'other', title: 'Synthetic leap date', notes: '' });
eq(events.date('2026-02-30'), false); eq(events.date('2026-10-13T00:00:00Z'), false);
for (const type of events.types) eq(events.parse({ action: 'create', projectId: 101 }, { date: '2026-10-13', type, title: 'Synthetic' }).details.type, type);
for (const input of [null, [], { date: '2026-10-13', title: 'Synthetic', memberIds: [7] }, { date: '2026-10-13', title: 'Synthetic', id: 55 }, { date: '2026-10-13', title: 'Synthetic', projectId: 102 }, { date: '2026-02-30', title: 'Synthetic' }, { date: '2026-10-13', title: 'x'.repeat(141) }, { date: '2026-10-13', title: 'Synthetic', notes: 'x'.repeat(501) }, { date: '2026-10-13', title: 'Synthetic', type: 'safety\u0000' }]) rejects(() => events.parse({ action: 'create', projectId: 101 }, input), 400, 'Closed event input');
rejects(() => events.parse({ action: 'remove', id: 1 }, { projectId: 102 }), 400); rejects(() => events.route('POST', '/api/projects/9007199254740992/events'), 400); rejects(() => events.route('DELETE', '/api/project-events/9007199254740992'), 400); eq(events.route('PATCH', '/api/project-events/1'), null);
let db = seed(), pm = db.users.find(row => row.id === 3);
for (const user of db.users) eq(events.visible(db, user).map(row => row.projectId), [1, 2].includes(user.id) ? [101, 102] : [101]);
eq(events.authorize(db, pm, create), null); rejects(() => events.authorize(db, pm, { ...create, projectId: 102 }), 404); rejects(() => events.authorize(db, pm, { action: 'remove', id: 2 }), 404);
for (const user of db.users.filter(row => ['field', 'foreman'].includes(row.role))) rejects(() => events.authorize(db, user, create), 403);
pm.permissions.scheduleCrews = false; rejects(() => events.authorize(db, pm, create), 403); rejects(() => events.authorize(db, pm, { action: 'remove', id: 1 }), 403); eq(events.visible(db, pm).length, 1);
mask(db, 'project_manager', scheduling.ceiling('project_manager')); rejects(() => events.authorize(db, pm, create), 403, 'Typed policy cannot grant missing stored scheduling authority');
pm.permissions.scheduleCrews = true; mask(db, 'project_manager', { create: false, remove: false }); rejects(() => events.authorize(db, pm, create), 403); rejects(() => events.authorize(db, pm, { action: 'remove', id: 1 }), 403);
eq(events.authorize(db, db.users[0], { ...create, projectId: 102 }), null, 'Immutable Owner authority');
mask(db, 'field', Object.fromEntries(scheduling.actions.map(action => [action, false]))); eq(events.visible(db, db.users.find(row => row.id === 4)), []);
db = seed(); pm = db.users.find(row => row.id === 3); const capabilities = profiles.defaults(pm.role); capabilities.scheduling.create = false; const profileId = crypto.randomUUID();
db.company.roleProfilesRequired = true; db.company.roleProfiles = { version: 1, revision: 1, profiles: [{ id: profileId, name: 'Synthetic event restriction', kind: 'custom', baseRole: pm.role, scopeInheritance: profiles.SCOPE, revision: 1, capabilities }], assignments: [{ accountId: pm.id, profileId }], retiredIds: [] }; rejects(() => events.authorize(db, pm, create), 403); eq(events.visible(db, pm).length, 1); eq(pm.permissions.scheduleCrews, true);
// PM events target projects/days. Crew membership is not invented as an event
// target; the existing project scope remains authoritative even with no crew.
db = seed(); pm = db.users.find(row => row.id === 3); pm.assignedCrews = []; eq(events.authorize(db, pm, create), null); eq(Object.hasOwn(create, 'memberIds'), false);
const foreign = { ...pm, companyId: crypto.randomUUID() }; rejects(() => events.authorize(db, foreign, create), 403);
for (const change of [source => { source.projectEvents.push(structuredClone(source.projectEvents[0])); }, source => { source.projectEvents[0].date = '2026-02-30'; }, source => { source.projectEvents[0].projectId = 999; }, source => { source.projectEvents[0].id = '1'; }, source => { source.projectEvents[0].permissions = { scheduleCrews: true }; }, source => { source.projects.push(structuredClone(source.projects[0])); }, source => { source.projectEvents = new Array(50001); }]) { const source = seed(); change(source); rejects(() => events.graph(source), 409, 'Malformed or ambiguous original source'); }
db = seed(); pm = db.users.find(row => row.id === 3); const beforeHash = canonicalHash(db), good = add(db, pm, create); events.validateDelta(db, good, pm, create); checks++; eq(canonicalHash(db), beforeHash, 'Delta validation has no source mutation');
for (const change of [candidate => { candidate.company.name = 'Synthetic unexpected mutation'; }, candidate => { candidate.users.find(row => row.id === 3).permissions.scheduleCrews = false; }, candidate => { candidate.assignments = []; }, candidate => { candidate.auditLog.push({ id: 'Synthetic unrelated audit' }); }, candidate => { candidate.projectEvents[0].notes = 'Synthetic original rewritten'; }]) { const candidate = structuredClone(good); change(candidate); rejects(() => events.validateDelta(db, candidate, pm, create), 403, 'Event create cannot change unrelated business/authority/history'); }
for (const change of [candidate => { candidate.projectEvents.at(-1).id = 99; }, candidate => { candidate.projectEvents.at(-1).title = 'Synthetic unreviewed title'; }, candidate => { candidate.projectEvents.at(-1).createdBy = 'Synthetic another account'; }, candidate => { candidate.projectEvents.push({ ...candidate.projectEvents.at(-1), id: 4 }); }]) { const candidate = structuredClone(good); change(candidate); rejects(() => events.validateDelta(db, candidate, pm, create), 409, 'Only exact admitted single event may be created'); }
rejects(() => events.validateDelta(db, good, pm, null), 403, 'An unrelated route cannot mutate event records'); events.validateDelta(db, structuredClone(db), pm, null); checks++;
const remove = events.parse(events.route('DELETE', '/api/project-events/1'), {}, canonicalHash(db.projectEvents[0])), removed = structuredClone(db); eq(remove.expectedVersion, canonicalHash(db.projectEvents[0])); removed.projectEvents = removed.projectEvents.filter(row => row.id !== 1); events.validateDelta(db, removed, pm, remove); checks++;
const collateral = structuredClone(removed); collateral.projectEvents = []; rejects(() => events.validateDelta(db, collateral, pm, remove), 403, 'Remove cannot delete hidden foreign history');
const remapped = structuredClone(removed); remapped.projects[0].id = 999; rejects(() => events.validateDelta(db, remapped, pm, remove), 403, 'Remove cannot remap the original project');
const unchanged = structuredClone(db); rejects(() => events.validateDelta(db, unchanged, pm, remove), 403, 'Remove must apply exactly its original target');
eq(events.visible(db, pm)[0], { ...db.projectEvents[0], version: canonicalHash(db.projectEvents[0]) }, 'Finite read DTO preserves business fields and adds current content equality'); eq(Object.keys(events.visible(db, pm)[0]), [...events.fields, 'version']);
rejects(() => events.authorize(db, pm, events.parse({ action: 'remove', id: 1 }, {})), 409, 'Missing current content version cannot remove an event');
for (const version of ['invalid', 'A'.repeat(64)]) rejects(() => events.authorize(db, pm, events.parse({ action: 'remove', id: 1 }, {}, version)), 400, 'Malformed/noncanonical content version');
rejects(() => events.authorize(db, pm, events.parse({ action: 'remove', id: 1 }, {}, '0'.repeat(64))), 409, 'Stale current content version');
const recycled = structuredClone(db); recycled.projectEvents[0] = { ...recycled.projectEvents[0], title: 'Synthetic changed-content recycled ID', createdAt: '2026-10-12T12:00:00.000Z' }; const recycledRemoval = structuredClone(recycled); recycledRemoval.projectEvents = recycledRemoval.projectEvents.filter(row => row.id !== 1);
rejects(() => events.authorize(recycled, pm, remove), 409, 'Same numeric ID with changed content is not the reviewed target'); rejects(() => events.validateDelta(recycled, recycledRemoval, pm, remove), 409, 'Original removal delta cannot claim a replaced source');
const identical = structuredClone(db); identical.projectEvents[0] = structuredClone(db.projectEvents[0]); eq(events.authorize(identical, pm, remove), identical.projectEvents[0], 'Content equality makes no generation/lifetime identity claim');
const persistedVersion = structuredClone(db); persistedVersion.projectEvents[0].version = canonicalHash(persistedVersion.projectEvents[0]); rejects(() => events.graph(persistedVersion), 409, 'A read-only DTO version cannot be persisted into source');
console.log(JSON.stringify({ passed: true, checks, finiteDelta: true, syntheticOnly: true, externalCalls: 0 }));
