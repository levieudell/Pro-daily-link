'use strict';
// Independent, synthetic acceptance for the finite role-policy surface. This
// process owns its server, sessions, temporary files and in-memory repository.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const registry = require('./capability-registry');
const profiles = require('./role-profiles');
const { A, B, initial, credential, snapshot, memory } = require('./compat-account-fixture');
const { services } = require('./compat-lifecycle-fixture');
const grantNames = ['scheduleCrews', 'viewTime', 'manageTime', 'viewDailies', 'approveDailies'];
const policyNames = {
  scheduling: ['schedulingRolePolicy', 'schedulingPolicyRequired'], timeOff: ['timeOffRolePolicy', 'timeOffPolicyRequired'],
  timeReview: ['timeReviewRolePolicy', 'timeReviewPolicyRequired'], timeWrite: ['timeWriteRolePolicy', 'timeWritePolicyRequired'],
  daily: ['dailyRolePolicy', 'dailyPolicyRequired'], notes: ['notesRolePolicy', 'notesPolicyRequired']
};
const actionNames = registry.families.flatMap(([family, , , , controller]) => controller.actions.map(action => family + '.' + action));
const clone = value => structuredClone(value);
const allGrants = Object.fromEntries(grantNames.map(name => [name, true]));
const noActions = controller => Object.fromEntries(controller.actions.map(action => [action, false]));
const PERIOD = '71000000-0000-4000-8000-000000000001';
const NOTE = '71000000-0000-4000-8000-000000000002';
const LEAVE = '71000000-0000-4000-8000-000000000003';
const PRIVATE = 'synthetic-excluded-private-leave';
const EXCLUDED = 'synthetic-excluded-project';

function policy(controller) {
  return { version: 1, revision: 1, roles: Object.fromEntries(registry.roles.map(role => [role, controller.ceiling(role)])) };
}
function defaults(db) {
  for (const [family, , , , controller] of registry.families) {
    const [name, required] = policyNames[family]; db.company[name] = policy(controller); db.company[required] = true;
  }
  return db;
}
function disable(row, family, action) {
  row[action] = false;
  if (family === 'scheduling' && action === 'view' || family === 'notes' && action === 'view') for (const name of Object.keys(row)) row[name] = false;
  if (family === 'timeOff' && action === 'viewRequests') row.createRequest = false;
  if (family === 'timeReview' && action === 'viewCards') { row.approveCards = false; row.unapproveCards = false; }
  if (family === 'timeWrite' && action === 'viewPayroll') for (const name of ['configurePeriods', 'captureExports', 'downloadExports']) row[name] = false;
  if (family === 'daily' && action === 'viewReports') for (const name of ['createReports', 'editReports', 'approveReports', 'runWorkdays']) row[name] = false;
  if (family === 'daily' && ['createReports', 'viewWorkdays'].includes(action)) row.runWorkdays = false;
}
function subset(actual, baseline, message) {
  for (const name of actionNames) {
    const [family, action] = name.split('.'); assert.equal(typeof actual[family][action], 'boolean', message + ': ' + name);
    if (actual[family][action]) assert.equal(baseline[family][action], true, message + ' broadened ' + name);
  }
}
// Read the actual pre-policy helpers, without booting a legacy server or copying
// its database. These helpers supply the original individual-grant semantics.
function legacyHelpers() {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const names = ['managerCan', 'managerScope', 'managerAssignmentAllowed', 'fieldRole', 'foremanRole', 'officeTimeCardUser', 'officeTimeCardViewer', 'timeCardCrewMemberIds', 'scopedTimeCards', 'fieldProjectIds', 'pricingPolicy', 'canViewPricing'];
  const code = names.map(name => {
    const line = source.split(/\r?\n/).find(value => value.startsWith('function ' + name + '('));
    assert.ok(line, 'Existing server baseline helper ' + name); return line;
  }).join('\n');
  const context = vm.createContext({ process: { env: { PDL_REQUIRE_AUTH: '1' } } });
  return vm.runInContext(code + '\n({' + names.join(',') + '})', context);
}
function legacyAccess(db, user, legacy) {
  const role = user.role, own = legacy.fieldRole(user), office = ['owner', 'admin', 'project_manager'].includes(role);
  const req = { auth: { user } }, manage = legacy.officeTimeCardUser(req), view = own || legacy.officeTimeCardViewer(req);
  const dailies = legacy.managerCan(user, 'viewDailies'), approve = role === 'owner' || role === 'admin' || role === 'project_manager' && legacy.managerCan(user, 'approveDailies');
  const schedule = office && legacy.managerCan(user, 'scheduleCrews');
  const leave = own || role === 'owner' || role === 'admin' && manage || role === 'project_manager' && legacy.managerCan(user, 'viewTime');
  const enabled = db.company.features.timeCards === true;
  return {
    scheduling: { view: true, create: schedule, edit: schedule, remove: schedule, acknowledge: true },
    timeOff: { viewRequests: leave, createRequest: own },
    timeReview: { viewCards: enabled && view, reviewLeave: manage && leave, approveCards: enabled && manage, unapproveCards: enabled && manage },
    timeWrite: { createCards: enabled && manage && view, correctCards: enabled && (manage || own) && view, removeCards: enabled && manage && view, submitCards: enabled && (manage || own) && view, clockCards: enabled && own && view, downloadCards: enabled && office && view, viewPayroll: enabled && office && view, configurePeriods: enabled && ['owner', 'admin'].includes(role) && manage && view, captureExports: enabled && ['owner', 'admin'].includes(role) && manage && view, downloadExports: enabled && ['owner', 'admin'].includes(role) && manage && view, viewActivities: enabled },
    daily: { viewReports: dailies, createReports: dailies, editReports: dailies, approveReports: approve, viewWorkdays: dailies, runWorkdays: dailies && (!enabled || (own ? view : manage && view)) },
    notes: { view: true, create: true, edit: true, complete: true }
  };
}
function seed() {
  const db = snapshot(), verified = '2026-10-01T00:00:00Z'; db.users[0].emailVerifiedAt = verified; db.team[0].crew = 'Office';
  db.company.pricingAccess = { enabled: true, officeMode: 'selected', userIds: [] };
  db.projects[0] = { ...db.projects[0], customerId: 21, crew: 'Synthetic Crew', site: 'Synthetic Site', contractValue: 876543, budget: '$876543', tmSettings: { defaultLaborRate: 89 }, estimateItems: [{ id: 1, name: 'Synthetic tile', unit: 'SF', plannedQuantity: 100, budgetHours: 10, cost: 98765 }] };
  db.projects.push({ id: 102, name: EXCLUDED, code: 'OTHER', customer: 0, customerId: 21, status: 'Active', estimateItems: [{ id: 2, name: 'Synthetic excluded tile', unit: 'SF', plannedQuantity: 9999, budgetHours: 999, cost: 777777 }], templateId: 'standard' });
  for (const [id, name, crew] of [[12, 'Synthetic Field', 'Synthetic Crew'], [13, 'Synthetic Foreman', 'Synthetic Crew'], [14, 'Synthetic Coworker', 'Synthetic Crew'], [15, 'Synthetic Other Crew', 'Other Crew']]) db.team.push({ id, companyId: A, name, crew, role: 'Crew', email: 'member' + id + '@example.invalid', hours: id, initials: 'SY' });
  for (const [id, role, memberId] of [[2, 'admin', null], [3, 'project_manager', null], [4, 'foreman', 13], [5, 'field', 12]]) db.users.push({ id, role, memberId, companyId: A, name: 'Synthetic ' + role, email: role + '@example.invalid', emailVerifiedAt: verified, status: 'Active', ...credential(initial), projectIds: role === 'project_manager' ? [101] : [], assignedCrews: role === 'project_manager' ? ['Synthetic Crew'] : [], permissions: ['admin', 'project_manager'].includes(role) ? clone(allGrants) : {} });
  for (const [id, projectId, memberIds] of [[1, 101, [12]], [2, 101, [13]], [3, 102, [12]], [4, 101, [15]], [10, 101, [11]]]) db.assignments.push({ id, companyId: A, projectId, memberIds, crew: db.team.find(row => row.id === memberIds[0]).crew, date: id === 3 ? '2026-10-03' : '2026-10-01', start: '08:00', end: '10:00', activity: 'Synthetic shift', acknowledgements: {}, notifications: {} });
  for (const [id, project, memberId, quantity, status] of [[1, 0, 12, 1, 'Needs review'], [2, 0, 13, 2, 'Needs review'], [3, 1, 12, 1000, 'Approved'], [4, 0, 15, 2000, 'Approved'], [5, 0, 12, 10, 'Approved'], [6, 0, 13, 20, 'Approved']]) {
    const member = db.team.find(row => row.id === memberId);
    db.reports.push({ id, companyId: A, project, dateIso: '2026-10-01', date: 'Oct 1', foreman: member.name, crew: member.crew, status, sourceAssignmentId: null, notes: 'Synthetic report ' + id, signature: 'Synthetic signature', productionEntries: [{ estimateItemId: project ? 2 : 1, description: 'Synthetic tile', quantity, unit: 'SF', laborHours: 2 }], laborEntries: [{ memberId, hours: 2, crew: member.crew }], flags: id === 2 ? [{ id: 'flag' + id, type: 'missing_data', message: 'Synthetic review ' + id }] : [], history: [], ...(status === 'Approved' ? { rateSnapshot: { schemaVersion: 1, laborRate: 89, source: 'synthetic-fixture', capturedAt: verified, capturedBy: { id: 1, name: db.users[0].name, role: 'owner' } } } : {}) });
  }
  for (const [id, memberId, projectId, status] of [[1, 12, 101, 'draft'], [2, 13, 101, 'draft'], [3, 14, 101, 'submitted'], [4, 12, 102, 'approved'], [5, 15, 101, 'approved'], [6, 12, 101, 'approved'], [7, 13, 101, 'approved']]) {
    const date = id === 4 ? '2026-10-03' : '2026-10-02';
    db.timeCards.push({ id, companyId: A, memberId, projectId, date, inAt: date + 'T' + (id >= 6 ? '12' : '08') + ':00:00Z', outAt: date + 'T' + (id >= 6 ? '14' : '10') + ':00:00Z', hours: 2, status, reportId: null, workdayId: null, history: [], ...(status === 'approved' ? { approvedBy: 'Synthetic Owner', approvedAt: verified } : {}) });
  }
  for (const [id, memberId, note] of [[LEAVE, 12, 'Synthetic own private leave'], ['71000000-0000-4000-8000-000000000004', 13, 'Synthetic crew private leave'], ['71000000-0000-4000-8000-000000000005', 15, PRIVATE]]) db.timeOffRequests.push({ id, companyId: A, memberId, startDate: '2026-10-20', endDate: '2026-10-20', allDay: true, type: 'vacation', note, status: 'approved', requestedAt: verified, history: [] });
  db.payPeriods.push({ id: PERIOD, companyId: A, label: 'Synthetic empty completed period', from: '2026-09-01', to: '2026-09-02', timeZone: 'UTC', status: 'open', createdAt: verified, updatedAt: verified });
  const content = { text: 'Synthetic shared todo', completed: false, dueDate: null, revision: 1 };
  db.projectNotesTodos.push({ id: NOTE, companyId: A, projectId: 101, kind: 'todo', ...content, createdByUserId: 1, updatedByUserId: 1, createdBy: 'Synthetic Owner', updatedBy: 'Synthetic Owner', createdAt: verified, updatedAt: verified, requestId: 'synthetic-note-seed', history: [{ userId: 1, action: 'create', by: 'Synthetic Owner', at: verified, before: null, after: clone(content) }] });
  return db;
}
function assigned(db, role, capabilities) {
  const user = db.users.find(row => row.role === role), id = crypto.randomUUID();
  const created = profiles.plan(db, { operation: 'create', profileId: id, name: 'Synthetic limits ' + role, baseRole: role, capabilities });
  return profiles.plan(created, { operation: 'assign', accountId: user.id, profileId: id });
}
function moduleMatrix() {
  assert.deepEqual(actionNames, [
    'scheduling.view', 'scheduling.create', 'scheduling.edit', 'scheduling.remove', 'scheduling.acknowledge', 'timeOff.viewRequests', 'timeOff.createRequest',
    'timeReview.viewCards', 'timeReview.reviewLeave', 'timeReview.approveCards', 'timeReview.unapproveCards',
    'timeWrite.createCards', 'timeWrite.correctCards', 'timeWrite.removeCards', 'timeWrite.submitCards', 'timeWrite.clockCards', 'timeWrite.downloadCards', 'timeWrite.viewPayroll', 'timeWrite.configurePeriods', 'timeWrite.captureExports', 'timeWrite.downloadExports', 'timeWrite.viewActivities',
    'daily.viewReports', 'daily.createReports', 'daily.editReports', 'daily.approveReports', 'daily.viewWorkdays', 'daily.runWorkdays', 'notes.view', 'notes.create', 'notes.edit', 'notes.complete'
  ]);
  const db = seed(), legacy = legacyHelpers(), variants = db.users.map(clone);
  variants.push({ ...clone(db.users[1]), permissions: {} });
  for (let mask = 0; mask < 32; mask++) variants.push({ ...clone(db.users[2]), permissions: Object.fromEntries(grantNames.map((name, bit) => [name, Boolean(mask & (1 << bit))])) });
  for (const enabled of [true, false]) {
    const plain = clone(db); plain.company.features.timeCards = enabled;
    for (const user of variants) {
      const expected = legacyAccess(plain, user, legacy);
      assert.deepEqual(registry.effective(plain, user), expected, user.role + ' original grants ' + JSON.stringify(user.permissions) + ' feature=' + enabled);
      assert.deepEqual(registry.effective(defaults(clone(plain)), user), expected, user.role + ' default typed-policy parity');
      assert.deepEqual(registry.effective(plain, { ...user, permissions: { ...user.permissions, owner: true, billing: true, assistant: true, platform: true, 'daily.approveReports': true, canManageEverything: true } }), expected, 'Unknown generic flags cannot grant actions');
    }
  }
  for (const [family, , , field, controller] of registry.families) {
    const [policyName, required] = policyNames[family];
    for (const user of db.users) for (const action of controller.actions) {
      const restricted = defaults(clone(db));
      if (user.role !== 'owner') disable(restricted.company[policyName].roles[user.role], family, action);
      else for (const role of registry.roles) restricted.company[policyName].roles[role] = noActions(controller);
      controller.validatePolicy(restricted.company[policyName]);
      const actual = registry.effective(restricted, user), baseline = registry.effective(db, user);
      subset(actual, baseline, user.role + ' family restriction ' + family + '.' + action);
      assert.equal(actual[family][action], user.role === 'owner' ? baseline[family][action] : false);
      assert.deepEqual(controller.actor(restricted, user, true)[field], actual[family]);
      assert.equal(controller.actor(restricted, user, false) === null, user.role !== 'owner', 'Policy needs atomic evidence');
    }
    const corruptions = [value => { value.roles.admin[controller.actions[0]] = 'true'; }, value => { value.roles.admin.genericPermission = true; }, value => { delete value.roles.field; }, value => { value.roles.owner = controller.ceiling('owner'); }, value => { value.revision = 0; }, value => { value.roles.admin[controller.actions[0]] = { allowed: true }; }];
    for (const change of corruptions) {
      const bad = clone(db); bad.company[policyName] = policy(controller); bad.company[required] = true; change(bad.company[policyName]);
      assert.throws(() => controller.validatePolicy(bad.company[policyName]));
      for (const user of db.users) assert.deepEqual(controller.access(bad, user), user.role === 'owner' ? controller.access(db, user) : noActions(controller), 'Malformed family fails closed ' + family + '/' + user.role);
    }
    const missing = clone(db); missing.company[required] = true;
    for (const user of db.users) assert.deepEqual(controller.access(missing, user), user.role === 'owner' ? controller.access(db, user) : noActions(controller), 'Required policy missing ' + family);
  }
  for (const role of registry.roles) {
    const user = db.users.find(row => row.role === role), baseline = registry.effective(db, user);
    const full = assigned(clone(db), role, profiles.defaults(role));
    assert.deepEqual(full.users, db.users, 'A named profile retains original accounts, grants, member links and scopes');
    assert.deepEqual(registry.effective(full, user), baseline, 'Full custom profile cannot promote ' + role);
    for (const [family, , , , controller] of registry.families) for (const action of controller.actions) {
      const capabilities = profiles.defaults(role); disable(capabilities[family], family, action);
      const restricted = assigned(clone(db), role, capabilities), actual = registry.effective(restricted, user);
      assert.equal(actual[family][action], false, 'Custom profile denies ' + role + '/' + family + '.' + action);
      subset(actual, baseline, 'Custom profile ceiling ' + role);
      assert.deepEqual(registry.effective(restricted, db.users[0]), registry.effective(db, db.users[0]), 'Owner immutable while another account is profiled');
    }
  }
  const pm = db.users.find(row => row.role === 'project_manager');
  const fullProfile = assigned(clone(db), pm.role, profiles.defaults(pm.role));
  for (let mask = 0; mask < 32; mask++) {
    const current = clone(fullProfile), user = current.users.find(row => row.id === pm.id);
    user.permissions = Object.fromEntries(grantNames.map((name, bit) => [name, Boolean(mask & (1 << bit))]));
    assert.deepEqual(registry.effective(current, user), legacyAccess(current, user, legacy), 'A custom profile cannot supply any missing original PM grant, mask=' + mask);
  }
  const full = assigned(clone(db), 'admin', profiles.defaults('admin'));
  assert.throws(() => profiles.plan(full, { operation: 'assign', accountId: 1, profileId: full.company.roleProfiles.profiles[0].id }), /same existing base role/);
  for (const role of ['owner', 'platform', 'billing', 'office', 'security']) assert.throws(() => profiles.capabilities(profiles.defaults('admin'), role));
  const forged = profiles.defaults('admin'); forged.notes.genericPermission = true; assert.throws(() => profiles.capabilities(forged, 'admin'));
  const invalid = clone(full); invalid.company.roleProfiles.profiles[0].capabilities.notes.view = 'true';
  for (const user of db.users) for (const [family, , , , controller] of registry.families) assert.deepEqual(controller.access(invalid, user), user.role === 'owner' ? controller.access(db, user) : noActions(controller), 'Invalid profile model ' + family + '/' + user.role);
  for (const role of ['platform', 'billing', 'security', 'unknown']) for (const [family, , , , controller] of registry.families) assert.deepEqual(controller.access(db, { ...pm, role, permissions: allGrants }), noActions(controller), 'Unknown role cannot enter ' + family);
  for (const user of db.users) {
    const oldCards = Array.from(legacy.scopedTimeCards(db, { auth: { user } }), row => row.id);
    const newCards = db.timeCards.filter(row => require('./time-review-access').cardInScope(db, user, row)).map(row => row.id);
    assert.deepEqual(newCards, oldCards, 'Default time-card resource parity ' + user.role);
    for (const row of db.assignments) if (user.role === 'project_manager') assert.equal(require('./scheduling-access').inScope(db, user, row, 'edit'), legacy.managerAssignmentAllowed(db, user, row));
  }
  console.log('policy matrix modules: six families, 32 actions, original PM grant combinations, defaults, family limits and custom profiles passed');
}

function operations(user, db) {
  const self = user.role === 'foreman' ? 13 : user.role === 'owner' ? 11 : 12;
  const ownCard = user.role === 'foreman' ? 2 : 1, ownReport = user.role === 'foreman' ? 2 : 1;
  const correction = db && ['foreman', 'field'].includes(user.role) ? { revision: require('./time-card-field-access').revision(db.timeCards.find(row => row.id === ownCard)) } : {};
  const get = route => [route, {}];
  const post = (route, data) => [route, { method: 'POST', data }];
  const direct = (family, method, route, details) => post('/api/workspace-direct-preview', { family, method, path: route, details });
  const time = (action, details = {}, id) => post('/api/time-cards/action-preview', { action, ...(id ? { id } : {}), details });
  const daily = (action, details = {}, id) => post('/api/daily-actions/preview', { action, ...(id ? { id } : {}), details });
  return {
    'scheduling.view': get('/api/assignments'),
    'scheduling.create': direct('scheduling', 'POST', '/api/assignments', { projectId: 101, memberIds: [12], crew: 'Synthetic Crew', date: '2026-11-03', start: '08:00', end: '10:00', activity: 'Synthetic new shift', requestId: crypto.randomUUID() }),
    'scheduling.edit': direct('scheduling', 'PATCH', '/api/assignments/1', { edit: true, projectId: 101, memberIds: [12], crew: 'Synthetic Crew', date: '2026-10-01', start: '09:00', end: '11:00', activity: 'Synthetic corrected shift' }),
    'scheduling.remove': direct('scheduling', 'DELETE', '/api/assignments/1', {}),
    'scheduling.acknowledge': direct('scheduling', 'POST', '/api/assignments/' + (self === 11 ? 10 : self === 13 ? 2 : 1) + '/acknowledge', {}),
    'timeOff.viewRequests': get('/api/time-off-requests'),
    'timeOff.createRequest': direct('timeOff', 'POST', '/api/time-off-requests', { startDate: '2026-11-10', endDate: '2026-11-10', allDay: true, type: 'vacation', note: 'Synthetic request', requestId: crypto.randomUUID() }),
    'timeReview.viewCards': get('/api/time-cards'),
    'timeReview.reviewLeave': post('/api/time-off-requests/' + LEAVE + '/review-preview', { decision: 'approve', note: 'Synthetic review' }),
    'timeReview.approveCards': post('/api/time-cards/review-preview', { decision: 'approve', ids: [3] }),
    'timeReview.unapproveCards': post('/api/time-cards/review-preview', { decision: 'unapprove', ids: [6] }),
    'timeWrite.createCards': time('create', { memberId: 12, projectId: 101, inAt: '2026-11-03T08:00:00Z', outAt: '2026-11-03T10:00:00Z', reason: 'Synthetic manual entry' }),
    'timeWrite.correctCards': time('correct', { inAt: '2026-10-02T08:15:00Z', outAt: '2026-10-02T10:00:00Z', reason: 'Synthetic clock correction', ...correction }, ownCard),
    'timeWrite.removeCards': time('remove', { reason: 'Synthetic duplicate cleanup' }, ownCard),
    'timeWrite.submitCards': time('submit', {}, ownCard),
    'timeWrite.clockCards': time('companyClock', { activityCodeId: 'company-1' }),
    'timeWrite.downloadCards': get('/api/time-cards.csv'),
    'timeWrite.viewPayroll': get('/api/pay-periods'),
    'timeWrite.configurePeriods': post('/api/pay-periods/action-preview', { action: 'createPeriod', details: { label: 'Synthetic November period', from: '2026-11-01', to: '2026-11-02' } }),
    'timeWrite.captureExports': post('/api/pay-periods/action-preview', { action: 'captureExport', id: PERIOD, details: {} }),
    'timeWrite.downloadExports': get('/api/pay-periods/' + PERIOD + '/exports'),
    'timeWrite.viewActivities': get('/api/company-activities'),
    'daily.viewReports': get('/api/reports'),
    'daily.createReports': daily('createReport', { projectId: 101, dateIso: '2026-11-03', status: 'Needs review', notes: 'Synthetic tile work', signature: 'Synthetic signature', foreman: user.name, productionEntries: [{ estimateItemId: 1, description: 'Synthetic tile', quantity: 5, unit: 'SF', laborHours: 1 }], laborEntries: [{ memberId: self, hours: 1, crew: self === 11 ? 'Office' : 'Synthetic Crew' }] }),
    'daily.editReports': daily('editReport', { notes: 'Synthetic corrected report' }, ownReport),
    'daily.approveReports': daily('approveReport', {}, ownReport),
    'daily.viewWorkdays': get('/api/workdays'),
    'daily.runWorkdays': daily('startWorkday', { projectId: 101, memberIds: [self], startNote: 'Synthetic start' }),
    'notes.view': get('/api/projects/101/notes-todos'),
    'notes.create': direct('notes', 'POST', '/api/projects/101/notes-todos', { kind: 'todo', text: 'Synthetic new todo', dueDate: '2026-11-03', requestId: crypto.randomUUID() }),
    'notes.edit': direct('notes', 'PATCH', '/api/projects/101/notes-todos/' + NOTE, { revision: 1, text: 'Synthetic corrected todo' }),
    'notes.complete': direct('notes', 'PATCH', '/api/projects/101/notes-todos/' + NOTE, { revision: 1, completed: true })
  };
}

async function httpMatrix(mode) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-policy-matrix-'));
  for (const name of ['OPENAI_API_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'SENTRY_DSN', 'SUPABASE_SECRET_KEY', 'PDL_PLATFORM_KEY']) process.env[name] = '';
  for (const name of ['PDL_COMPAT_GLOBAL_FENCE_FILE', 'DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']) delete process.env[name];
  const legacy = snapshot(); legacy.company.id = B; legacy.users[0].companyId = B;
  const file = path.join(directory, 'legacy.json'); fs.writeFileSync(file, JSON.stringify(legacy)); const oldBytes = fs.readFileSync(file);
  Object.assign(process.env, { NODE_ENV: 'test', PDL_COMPAT_ACCOUNT_SYNTHETIC: '1', PDL_REQUIRE_AUTH: '1', PDL_DB_FILE: file, PDL_PLATFORM_FILE: path.join(directory, 'platform.json'), PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off' });
  const mod = require('./server'); await new Promise(resolve => mod.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + mod.server.address().port, store = memory(seed()), key = crypto.randomBytes(32);
  const uninstall = mod.installCompatibilityAccountTests({ synthetic: true, companyId: A, origin, globalOrigin: 'http://localhost:4999', repository: store, ...services(store, origin, { key }), workspace: true, workspaceKey: key });
  let checks = 0;
  const request = async (route, { method = 'GET', data, token, tenant = A } = {}) => {
    const response = await fetch(origin + route, { method, headers: { 'X-PDL-Company': tenant, ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
    const raw = await response.text(); let value; try { value = JSON.parse(raw); } catch { value = raw; }
    checks++; return { status: response.status, value };
  };
  const mutate = async fn => { const loaded = await store.load(A); const next = fn(loaded.snapshot) || loaded.snapshot; await store.commit(next, loaded.revision); };
  const expect = async (route, options, status, label = route) => { const result = await request(route, options); assert.equal(result.status, status, label + ': ' + JSON.stringify(result.value)); return result.value; };
  try {
    assert.equal((await request('/api/state')).status, 401);
    const actors = [];
    for (const user of store.current().users) {
      const login = await expect('/api/auth/login', { method: 'POST', data: { email: user.email, password: initial } }, 200, 'Real login ' + user.role);
      assert.ok(login.token); actors.push({ user, token: login.token });
    }
    const pm = actors.find(row => row.user.role === 'project_manager'), field = actors.find(row => row.user.role === 'field'), foreman = actors.find(row => row.user.role === 'foreman'), owner = actors[0];
    if (mode === 'baseline') {
    for (const phase of ['no policy', 'default family policy']) {
      if (phase === 'default family policy') await mutate(defaults);
      for (const { user, token } of actors) {
        const baseline = registry.effective(store.current(), user), state = await expect('/api/state', { token }, 200, phase + ' state ' + user.role);
        assert.deepEqual(state.currentUser.effectiveCapabilities, baseline);
        for (const [name, [route, options]] of Object.entries(operations(user, store.current()))) {
          const [family, action] = name.split('.'), result = await request(route, { ...options, token });
          // Acknowledgement always has a linked-member condition in addition to
          // the typed role grant; office roles have no linked crew identity.
          const allowed = baseline[family][action] && !(name === 'scheduling.acknowledge' && user.memberId === null);
          if (allowed) assert.equal(result.status, 200, phase + ' ' + user.role + ' ' + name + ': ' + JSON.stringify(result.value));
          else assert.ok([403, 404].includes(result.status), phase + ' denies ' + user.role + ' ' + name + ': ' + JSON.stringify(result.value));
        }
      }
    }
    const pmState = await expect('/api/state', { token: pm.token }, 200);
    assert.deepEqual(pmState.projects.map(row => row.id), [101]); assert.deepEqual(pmState.team.map(row => row.id), [12, 13, 14]);
    assert.deepEqual(pmState.reports.map(row => row.id), [1, 2, 5, 6]);
    assert.deepEqual((await expect('/api/time-cards', { token: pm.token }, 200)).map(row => row.id), [1, 2, 3, 6, 7]);
    assert.deepEqual((await expect('/api/time-cards', { token: field.token }, 200)).map(row => row.id), [1, 4, 6]);
    assert.deepEqual((await expect('/api/time-cards', { token: foreman.token }, 200)).map(row => row.id), [1, 2, 3, 4, 6, 7]);
    for (const actor of [pm, field, foreman]) {
      const state = await expect('/api/state', { token: actor.token }, 200);
      for (const project of state.projects) {
        for (const name of ['budget', 'contractValue', 'tmSettings']) assert.equal(Object.hasOwn(project, name), false, actor.user.role + ' pricing ' + name);
        assert.ok(project.estimateItems.every(item => !Object.hasOwn(item, 'cost')));
      }
      assert.ok(state.reports.every(row => !Object.hasOwn(row, 'rateSnapshot')));
      const leave = await expect('/api/time-off-requests', { token: actor.token }, 200);
      assert.equal(JSON.stringify(leave).includes(PRIVATE), false);
      assert.deepEqual(leave.map(row => row.memberId), actor === pm ? [12, 13] : [actor.user.memberId]);
      const busy = await expect('/api/schedule-availability', { token: actor.token }, 200);
      assert.equal(JSON.stringify(busy).includes('private leave'), false); assert.ok(busy.every(row => !Object.hasOwn(row, 'type') && !Object.hasOwn(row, 'note')));
      await expect('/api/billing', { token: actor.token }, 403);
      await expect('/api/reporting-exports', { token: actor.token }, 403);
      await expect('/api/state?userId=1', { token: actor.token }, 403);
      await expect('/api/state', { token: actor.token, tenant: B }, 404);
    }
    await expect('/api/production', { token: pm.token }, 403, 'Typed action grants cannot supply pricing access');
    await mutate(db => { db.company.pricingAccess.userIds = [pm.user.id]; });
    const production = await expect('/api/production', { token: pm.token }, 200);
    assert.equal(production.approvedReports, 2); assert.deepEqual(production.projects.map(row => row.projectId), [101]);
    assert.equal(production.projects[0].items[0].actualQuantity, 30); assert.equal(production.projects[0].items[0].actualLaborHours, 4);
    const insights = await expect('/api/insights', { token: pm.token }, 200); assert.deepEqual(insights.records.map(row => row.reportId).sort(), [5, 6]);
    for (const route of ['/api/action-center', '/api/exceptions']) {
      const result = await expect(route, { token: pm.token }, 200); assert.equal(JSON.stringify(result).includes(EXCLUDED), false);
      const rows = Array.isArray(result) ? result : result.items; assert.ok(rows.every(row => row.projectId == null || row.projectId === 101));
    }
    await expect('/api/reports/3', { token: pm.token }, 404);
    await expect('/api/projects/102/notes-todos', { token: pm.token }, 404);
    await expect('/api/time-cards/review-preview', { token: pm.token, method: 'POST', data: { decision: 'approve', ids: [5] } }, 404);
    await expect('/api/time-off-requests/71000000-0000-4000-8000-000000000005/review-preview', { token: pm.token, method: 'POST', data: { decision: 'approve' } }, 404);
    const create = operations(pm.user)['timeWrite.createCards'];
    for (const details of [{ ...create[1].data.details, projectId: 102 }, { ...create[1].data.details, memberId: 15 }]) await expect(create[0], { token: pm.token, method: 'POST', data: { action: 'create', details } }, 403);
    const dailyCreate = operations(field.user)['daily.createReports'];
    await expect(dailyCreate[0], { token: field.token, method: 'POST', data: { ...dailyCreate[1].data, details: { ...dailyCreate[1].data.details, dateIso: '2026-10-01', sourceAssignmentId: 4 } } }, 403, 'A source assignment cannot supply another crew identity');
    for (const { user, token } of actors.filter(row => row.user.role !== 'owner')) {
      for (const route of ['/api/assistant/context', '/api/projects/101/assistant/context']) await expect(route, { token }, 503);
      for (const route of ['/api/platform', '/api/platform/revenue']) assert.ok((await request(route, { token })).status >= 400, 'Tenant token cannot access platform ' + route);
      await expect('/api/company', { token, method: 'PATCH', data: { name: 'Synthetic forbidden change' } }, 503);
      await expect('/api/users/1/time-access', { token, method: 'PATCH', data: { manageTime: false } }, 403);
    }
    } else {
    await mutate(db => { db.company.pricingAccess.userIds = [pm.user.id]; });
    // Denying a whole family must block every one of its HTTP actions for each
    // non-owner role, even when all original individual grants remain true.
    for (const [family, , , , controller] of registry.families) {
      await mutate(db => {
        defaults(db); for (const role of registry.roles) db.company[policyNames[family][0]].roles[role] = noActions(controller);
      });
      for (const { user, token } of actors.filter(row => row.user.role !== 'owner')) {
        const routes = operations(user, store.current());
        for (const action of controller.actions) {
          const [route, options] = routes[family + '.' + action], result = await request(route, { ...options, token });
          assert.ok([403, 404].includes(result.status), 'Family restriction HTTP ' + user.role + '/' + family + '.' + action + ': ' + JSON.stringify(result.value));
        }
      }
      const state = await expect('/api/state', { token: owner.token }, 200); assert.deepEqual(state.currentUser.effectiveCapabilities, registry.effective(seed(), owner.user));
    }
    await mutate(db => {
      defaults(db); let next = db;
      for (const role of registry.roles) next = assigned(next, role, Object.fromEntries(registry.families.map(([family, , , , controller]) => [family, noActions(controller)])));
      return next;
    });
    for (const { user, token } of actors.filter(row => row.user.role !== 'owner')) {
      for (const [name, [route, options]] of Object.entries(operations(user, store.current()))) {
        const result = await request(route, { ...options, token }); assert.ok([403, 404].includes(result.status), 'Named profile HTTP ' + user.role + '/' + name + ': ' + JSON.stringify(result.value));
      }
      const state = await expect('/api/state', { token }, 200);
      for (const name of ['reports', 'workdays', 'assignments', 'scheduleAvailability']) assert.deepEqual(state[name], [], 'Profile suppresses scoped records ' + name);
      assert.ok(state.team.every(row => !Object.hasOwn(row, 'hours')));
    }
    assert.equal((await expect('/api/production', { token: pm.token }, 200)).approvedReports, 0);
    assert.deepEqual((await expect('/api/insights', { token: pm.token }, 200)).records, []);
    assert.deepEqual(await expect('/api/exceptions', { token: pm.token }, 200), []);
    await mutate(db => { db.company.roleProfiles.profiles[0].capabilities.notes.view = 'true'; });
    for (const actor of actors.filter(row => row.user.role !== 'owner')) await expect('/api/projects/101/notes-todos', { token: actor.token }, 403);
    await expect('/api/billing', { token: owner.token }, 200);
    // Restore only our synthetic fixture, retaining the real login sessions.
    await mutate(db => { const next = seed(); next.sessions = db.sessions; return next; });
    const clean = store.current();
    const reportError = console.error;
    console.error = (...args) => {
      // Hide only the expected reconciliation stack emitted by the real server;
      // unexpected errors still appear and every HTTP status is asserted below.
      if (args.some(value => value instanceof Error && value.statusCode === 409 && value.message === 'Workspace identity bindings need reconciliation.')) return;
      reportError(...args);
    };
    try {
      for (const change of [db => { db.team[1].companyId = B; }, db => { db.projects[0].companyId = B; }, db => { db.assignments[0].memberIds = [999]; }, db => { db.assignments[0].projectId = 999; }, db => { db.reports[0].project = 99; }, db => { db.team.push(clone(db.team[1])); }]) {
        await mutate(db => { const next = clone(clean); change(next); return next; });
        for (const route of ['/api/state', '/api/assignments', '/api/time-cards', '/api/projects/101/notes-todos']) await expect(route, { token: owner.token }, 409, 'Invalid tenant/source IDs ' + route);
      }
    } finally { console.error = reportError; }
    }
    assert.deepEqual(fs.readFileSync(file), oldBytes, 'The legacy synthetic tenant file remains byte-identical');
    console.log('policy matrix HTTP ' + mode + ': ' + checks + ' real-session requests passed');
  } finally {
    uninstall(); await new Promise(resolve => mod.server.close(resolve));
    // The absolute temporary directory is generated and owned by this process.
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
async function main() {
  if (process.argv.includes('--restrictions')) { await httpMatrix('restrictions'); return; }
  moduleMatrix(); await httpMatrix('baseline');
  // Each independently owned server stays below the real 600/minute limiter.
  // No limiter, clock, auth middleware or production code is mocked or disabled.
  const result = spawnSync(process.execPath, [__filename, '--restrictions'], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Isolated family/profile HTTP matrix');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
