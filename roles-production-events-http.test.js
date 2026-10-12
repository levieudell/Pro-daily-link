'use strict';
// Actual normal server only. All rows, actors, sessions and transport responses
// are generated here; outside fetch, Storage and paid providers are forbidden.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const { canonicalHash } = require('./database/transactional-repository');
const flagOff = process.argv.includes('--flag-off'), nativeFetch = globalThis.fetch, nativeConsoleError = console.error;
let origin, requests = 0, externalAttempts = 0, commitAttempts = 0, commitSuccesses = 0, commitHook = null, checks = 0, expectedLoggedStatuses = null, expectedDenialLogs = 0, flagOffSummary = null;
console.error = (...args) => { if (expectedLoggedStatuses?.includes(args[1]?.statusCode) && ['PDL_PROJECT_EVENT', 'PDL_ROLES_EVIDENCE'].includes(args[1]?.code)) { expectedDenialLogs++; return; } nativeConsoleError(...args); };
for (const name of Object.keys(process.env)) if (/SUPABASE|OPENAI|ANTHROPIC|RESEND|STRIPE|SENTRY|SENDGRID|TWILIO|DATABASE_URL|PGPASSWORD|AWS_|AZURE_|PDL_(?:ROLE_POLICY_KEY|ASSISTANT|API_KEY|PLATFORM_KEY|BOOTSTRAP_KEY)/i.test(name)) delete process.env[name];
globalThis.fetch = (input, options) => { const target = String(input?.url || input); if (!origin || !target.startsWith(origin + '/')) { externalAttempts++; throw Error('Only this fixture-owned loopback origin is permitted'); } return nativeFetch(input, options); };
const supabase = require('./database/supabase'); supabase.loadLocalEnv = () => {};
for (const name of ['upload', 'download', 'remove']) supabase[name] = async () => { externalAttempts++; throw Error('Event tests admit no file/provider effects'); };
function addActors(db, tokens) {
  db.projects.push({ id: 102, name: 'Synthetic separate event project', status: 'Active', estimateItems: [] });
  db.team.push({ id: 13, name: 'Synthetic event foreman', role: 'Foreman', crew: 'Synthetic Crew' }, { id: 99, name: 'Synthetic outside crew', role: 'Field', crew: 'Foreign Crew' });
  db.assignments.push({ id: 2, projectId: 101, memberIds: [13], crew: 'Synthetic Crew', date: '2026-10-13', start: '08:00', end: '16:00', activity: 'Synthetic event foreman assignment', acknowledgements: {}, notifications: {} });
  for (const [id, role, permissions, memberId] of [[4, 'project_manager', { scheduleCrews: true, viewDailies: true }, null], [5, 'project_manager', { scheduleCrews: false, viewDailies: true }, null], [6, 'foreman', {}, 13]]) {
    const user = { id, companyId: db.company.id, name: 'Synthetic event account ' + id, email: 'event' + id + '@example.invalid', role, status: 'Active', permissions, projectIds: [101], assignedCrews: ['Synthetic Crew'], ...(memberId ? { memberId } : {}) };
    const token = crypto.randomBytes(32).toString('base64url'); tokens.set(id, token); db.users.push(user); db.sessions.push({ id: crypto.randomUUID(), companyId: db.company.id, userId: id, tokenHash: crypto.createHash('sha256').update(token).digest('hex'), createdAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z' });
  }
  db.projectEvents = [{ id: 11, projectId: 101, date: '2026-10-13', type: 'delivery', title: 'Synthetic assigned event', notes: '', createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'Synthetic Owner' }, { id: 12, projectId: 102, date: '2026-10-13', type: 'inspection', title: 'Synthetic foreign event', notes: '', createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'Synthetic Owner' }];
}
let fixture;
if (flagOff) {
  const { workspaceSnapshot } = require('./compat-workspace-fixture'), { A, B } = require('./compat-account-fixture'), db = workspaceSnapshot(), tokens = new Map(); db.team[0].crew = 'Office';
  db.users.push({ id: 3, companyId: A, name: 'Synthetic event Admin', role: 'admin', status: 'Active', permissions: {}, projectIds: [], assignedCrews: [] });
  for (const user of db.users) { const token = crypto.randomBytes(32).toString('base64url'); tokens.set(user.id, token); db.sessions.push({ id: crypto.randomUUID(), companyId: A, userId: user.id, tokenHash: crypto.createHash('sha256').update(token).digest('hex'), createdAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z' }); }
  addActors(db, tokens); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-events-flag-off-')), file = path.join(dir, 'db.json'); fs.writeFileSync(file, JSON.stringify(db)); fs.writeFileSync(path.join(dir, 'platform.json'), '{"users":[],"sessions":[]}');
  Object.assign(process.env, { NODE_ENV: 'test', PDL_REQUIRE_AUTH: '1', PDL_DB_FILE: file, PDL_PLATFORM_FILE: path.join(dir, 'platform.json'), PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1' }); delete process.env.PDL_ROLES_COMPANIES; delete process.env.PDL_COMPAT_ACCOUNT_SYNTHETIC; supabase.configured = () => false;
  fixture = { A, B, tokens, server: require('./server').server, read: () => JSON.parse(fs.readFileSync(file, 'utf8')), alter: task => { const next = JSON.parse(fs.readFileSync(file, 'utf8')); task(next); fs.writeFileSync(file, JSON.stringify(next)); } };
} else {
  fixture = require('./roles-production-http.test'); fixture.alter(db => addActors(db, fixture.tokens));
  const request = supabase.request; supabase.request = async (route, options) => {
    if (!/^\/rest\/v1\/rpc\/commit_roles_snapshot(?:_with_platform)?$/.test(route)) return request(route, options);
    commitAttempts++; if (commitHook) { const hook = commitHook; commitHook = null; await hook(JSON.parse(options.body)); }
    const response = await request(route, options); commitSuccesses++; return response;
  };
}
const { server } = fixture, initial = fixture.read(), owned = path.resolve(path.dirname(process.env.PDL_DB_FILE));
assert.ok(owned.startsWith(path.resolve(os.tmpdir()) + path.sep) && /^pdl-(roles-production-http|events-flag-off)-/.test(path.basename(owned)), 'Cleanup is confined to this generated fixture');
const scheduling = require('./scheduling-access'), profiles = require('./role-profiles');
const reset = () => fixture.alter(db => { for (const name of Object.keys(db)) delete db[name]; Object.assign(db, structuredClone(initial)); });
const eq = (actual, expected, label) => { checks++; assert.deepEqual(actual, expected, label); };
const valid = (type = 'delivery', title = 'Synthetic reviewed event') => ({ date: '2026-10-13', type, title, notes: 'Synthetic fixture only' });
const cases = [], journeys = [];
async function call(method, route, userId = 1, body, company = fixture.A, eventVersion) {
  const target = method === 'DELETE' && /^\/api\/project-events\/([1-9]\d*)$/.exec(route);
  const original = target && fixture.read().projectEvents.find(row => row.id === Number(target[1]));
  const version = eventVersion === undefined ? original && canonicalHash(original) : eventVersion;
  requests++; const commits = commitAttempts, response = await fetch(origin + route, { method, signal: AbortSignal.timeout(10000), headers: { 'X-PDL-Company': company, Authorization: 'Bearer ' + fixture.tokens.get(userId), 'Content-Type': 'application/json', ...(method === 'GET' ? {} : { 'X-PDL-Operation': crypto.randomUUID() }), ...(version == null || version === false ? {} : { 'X-PDL-Event-Version': version }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); cases.push({ method, route, actorId: userId, status: response.status, commitAttempts: commitAttempts - commits }); return { status: response.status, data };
}
async function deny(method, route, userId, body, statuses, label, company, eventVersion) {
  const before = canonicalHash(fixture.read()), commits = commitAttempts, providers = externalAttempts; let result;
  expectedLoggedStatuses = statuses; try { result = await call(method, route, userId, body, company, eventVersion); } finally { expectedLoggedStatuses = null; }
  checks++; assert.ok(statuses.includes(result.status), label + ': ' + JSON.stringify(result)); eq(canonicalHash(fixture.read()), before, label + ' preserves the complete source'); eq(commitAttempts, commits, label + ' performs no CAS'); eq(externalAttempts, providers, label + ' performs no provider/file effect'); return result;
}
function mask(db, role, flags) { db.company.schedulingPolicyRequired = true; db.company.schedulingRolePolicy = { version: 1, revision: 1, roles: Object.fromEntries(scheduling.roles.map(name => [name, scheduling.ceiling(name)])) }; Object.assign(db.company.schedulingRolePolicy.roles[role], flags); }
function custom(db, userId, flags) { const profileId = crypto.randomUUID(), user = db.users.find(row => row.id === userId), capabilities = profiles.defaults(user.role); Object.assign(capabilities.scheduling, flags); db.company.roleProfilesRequired = true; db.company.roleProfiles = { version: 1, revision: 1, profiles: [{ id: profileId, name: 'Synthetic event limits', kind: 'custom', baseRole: user.role, scopeInheritance: profiles.SCOPE, revision: 1, capabilities }], assignments: [{ accountId: userId, profileId }], retiredIds: [] }; }
const business = db => canonicalHash(Object.fromEntries(Object.entries(db).filter(([name]) => !['company', 'users', 'sessions'].includes(name))));
async function baseline() {
  for (const userId of [1, 3, 4]) {
    reset(); const created = await call('POST', '/api/projects/101/events', userId, valid()); eq(created.status, 201, 'No-policy Office in-scope create: ' + JSON.stringify(created.data)); eq(created.data.projectId, 101); eq(fixture.read().projectEvents.find(row => row.id === created.data.id).title, valid().title); eq(created.data.version, canonicalHash(fixture.read().projectEvents.find(row => row.id === created.data.id)), 'POST exposes the current source-content precondition'); eq(Object.hasOwn(created.data, 'memberIds'), false, 'A project/day event is not a fake assignment');
    const removed = await call('DELETE', '/api/project-events/' + created.data.id, userId); eq(removed.status, 200, 'No-policy Office remove'); eq(fixture.read().projectEvents.some(row => row.id === created.data.id), false);
  }
  reset(); for (const type of ['delivery', 'inspection', 'trade', 'safety', 'other']) { const created = await call('POST', '/api/projects/101/events', 4, valid(type, 'Synthetic ' + type)); eq(created.status, 201, 'All existing event types work'); eq(created.data.type, type); }
  journeys.push('No-policy actual Office/PM in-scope create/remove and all five project/day event types');
  for (const userId of [2, 6, 5]) { reset(); await deny('POST', '/api/projects/101/events', userId, valid(), [403], 'Immutable Field/Foreman/PM stored grant create floor'); await deny('DELETE', '/api/project-events/11', userId, undefined, [403], 'Immutable Field/Foreman/PM stored grant remove floor'); }
  reset(); await deny('POST', '/api/projects/102/events', 4, valid(), [403, 404], 'PM foreign project create'); await deny('DELETE', '/api/project-events/12', 4, undefined, [403, 404], 'PM original foreign event delete');
  await deny('POST', '/api/projects/101/events', 4, valid(), [404], 'Cross-company request hint', fixture.B); await deny('DELETE', '/api/project-events/11', 4, undefined, [404], 'Cross-company original event', fixture.B);
  journeys.push('Fixed role, current stored scheduleCrews floor and original project scope before any effect');
  reset(); for (const userId of [2, 4, 5, 6]) { const before = canonicalHash(fixture.read()), state = await call('GET', '/api/state', userId); eq(state.status, 200, 'Read-only scoped state'); eq(state.data.projectEvents.map(row => row.projectId), [101], 'Readonly project scope without a write grant'); eq(state.data.projectEvents[0].version, canonicalHash(fixture.read().projectEvents.find(row => row.id === state.data.projectEvents[0].id)), 'State DTO includes a source-content version without persisting it'); eq(canonicalHash(fixture.read()), before, 'State changes no source'); }
  journeys.push('Field/Foreman and PM readonly projections retain only current assigned projects');
  reset();
  for (const [version, status, label] of [[null, 409, 'Missing delete version'], ['synthetic-invalid', 400, 'Malformed delete version'], ['A'.repeat(64), 400, 'Noncanonical delete version'], ['0'.repeat(64), 409, 'Stale delete version']]) await deny('DELETE', '/api/project-events/11', 4, undefined, [status], label, fixture.A, version);
  await deny('DELETE', '/api/project-events/11', 5, undefined, [403], 'Current grant is checked before missing source version', fixture.A, null);
  await deny('DELETE', '/api/project-events/12', 4, undefined, [404], 'Current project scope is checked before missing source version', fixture.A, null);
  const first = await call('POST', '/api/projects/101/events', 4, valid('delivery', 'Synthetic original reused target')); eq(first.status, 201); const originalVersion = first.data.version;
  const removeOriginal = await call('DELETE', '/api/project-events/' + first.data.id, 4, undefined, fixture.A, originalVersion); eq(removeOriginal.status, 200);
  const recycled = await call('POST', '/api/projects/101/events', 4, valid('inspection', 'Synthetic replacement reused target')); eq(recycled.status, 201); eq(recycled.data.id, first.data.id, 'Actual max-ID allocator reuses the removed highest numeric ID'); eq(recycled.data.version === originalVersion, false, 'Different content has a different precondition');
  await deny('DELETE', '/api/project-events/' + recycled.data.id, 4, undefined, [409], 'A reviewed original cannot remove recycled changed-content target', fixture.A, originalVersion);
  eq(fixture.read().projectEvents.find(row => row.id === recycled.data.id).title, 'Synthetic replacement reused target'); const freshDelete = await call('DELETE', '/api/project-events/' + recycled.data.id, 4, undefined, fixture.A, recycled.data.version); eq(freshDelete.status, 200);
  journeys.push('DELETE requires current content equality; missing/malformed/stale versions and actual changed-content numeric-ID recycling are denied without CAS');
}
async function flagOffViewLimits() {
  const actors = [[2, 'field'], [6, 'foreman'], [4, 'project_manager'], [3, 'admin']], disabled = Object.fromEntries(scheduling.actions.map(action => [action, false]));
  async function hidden(userId, label) {
    const before = canonicalHash(fixture.read()), grants = structuredClone(fixture.read().users.map(row => [row.id, row.permissions])), commits = commitAttempts;
    const state = await call('GET', '/api/state', userId); eq(state.status, 200, label + ': ' + JSON.stringify(state.data)); eq(state.data.projectEvents, [], label + ' excludes every event fact'); eq(state.data.currentUser.schedulingAccess, disabled, label + ' publishes finite denied scheduling controls'); eq(canonicalHash(fixture.read()), before, label + ' changes no source'); eq(fixture.read().users.map(row => [row.id, row.permissions]), grants, label + ' changes no stored grant'); eq(commitAttempts, commits); Object.assign(cases.at(-1), { label, eventCount: 0, schedulingView: false, sourceUnchanged: true, grantsUnchanged: true });
  }
  async function owner(label) {
    const before = canonicalHash(fixture.read()), state = await call('GET', '/api/state', 1); eq(state.status, 200, label + ' current Owner is readable'); eq(state.data.projectEvents.map(row => row.projectId), [101, 102], label + ' preserves immutable Owner event view'); eq(state.data.currentUser.schedulingAccess.view, true); eq(canonicalHash(fixture.read()), before); Object.assign(cases.at(-1), { label: label + ' immutable Owner', eventCount: 2, schedulingView: true, sourceUnchanged: true });
  }
  for (const [userId, role] of actors) {
    reset(); fixture.alter(db => mask(db, role, disabled)); await hidden(userId, 'Flag-off typed ' + role + ' View=false'); await owner('Flag-off typed ' + role + ' mask');
    reset(); fixture.alter(db => custom(db, userId, disabled)); await hidden(userId, 'Flag-off custom ' + role + ' profile View=false'); await owner('Flag-off custom ' + role + ' profile');
  }
  journeys.push('Flag-off typed policy and custom profile View=false suppress events and publish denied controls for Field/Foreman/PM/Admin; Owner view stays immutable');
  for (const [name, corrupt] of [
    ['missing required scheduling policy', db => { db.company.schedulingPolicyRequired = true; delete db.company.schedulingRolePolicy; }],
    ['invalid typed scheduling policy', db => { mask(db, 'admin', {}); db.company.schedulingRolePolicy.roles.admin.view = 'synthetic-invalid'; }],
    ['missing required profile model', db => { db.company.roleProfilesRequired = true; delete db.company.roleProfiles; }],
    ['invalid profile model', db => { db.company.roleProfilesRequired = true; db.company.roleProfiles = { version: 1, revision: 1, profiles: [], assignments: [{ accountId: 4, profileId: crypto.randomUUID() }], retiredIds: [] }; }]
  ]) {
    reset(); fixture.alter(corrupt); for (const [userId, role] of actors) await hidden(userId, 'Flag-off ' + name + ' for ' + role); await owner('Flag-off ' + name);
  }
  journeys.push('Flag-off missing/invalid stored policy or profile source conceals event facts for every unprotected actor while preserving current Owner view');
}
async function main() {
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); origin = 'http://127.0.0.1:' + server.address().port;
    await baseline();
    if (flagOff) await flagOffViewLimits();
    if (!flagOff) {
      for (const role of ['admin', 'project_manager']) { reset(); const id = role === 'admin' ? 3 : 4; fixture.alter(db => mask(db, role, { create: false, remove: false })); await deny('POST', '/api/projects/101/events', id, valid(), [403], 'Typed event create restriction'); await deny('DELETE', '/api/project-events/11', id, undefined, [403], 'Typed event remove restriction'); const state = await call('GET', '/api/state', id); eq(state.status, 200); eq(state.data.projectEvents.length, role === 'admin' ? 2 : 1); }
      const current = await call('GET', '/api/auth/me', 4); eq(current.status, 200); eq(current.data.permissions.scheduleCrews, true, 'Auth projection retains the stored scheduling grant'); eq(current.data.schedulingAccess.create, false); eq(current.data.schedulingAccess.remove, false);
      reset(); fixture.alter(db => mask(db, 'project_manager', Object.fromEntries(scheduling.actions.map(action => [action, false])))); const hidden = await call('GET', '/api/state', 4); eq(hidden.status, 200); eq(hidden.data.projectEvents, [], 'Typed view restriction removes event-derived facts'); eq(fixture.read().users.find(row => row.id === 4).permissions.scheduleCrews, true, 'Typed masks preserve stored grants');
      reset(); fixture.alter(db => mask(db, 'field', Object.fromEntries(scheduling.actions.map(action => [action, false])))); const fieldHidden = await call('GET', '/api/state', 2); eq(fieldHidden.status, 200); eq(fieldHidden.data.projectEvents, [], 'Field scheduling view-off conceals event facts');
      const immutableOwner = await call('POST', '/api/projects/102/events', 1, valid()); eq(immutableOwner.status, 201, 'Owner remains protected');
      journeys.push('Typed create/remove/view masks and immutable Owner apply to normal event routes and projections');
      reset(); fixture.alter(db => custom(db, 4, { create: false, remove: false })); await deny('POST', '/api/projects/101/events', 4, valid(), [403], 'Named profile event create limit'); await deny('DELETE', '/api/project-events/11', 4, undefined, [403], 'Named profile event remove limit');
      reset(); fixture.alter(db => custom(db, 5, {})); await deny('POST', '/api/projects/101/events', 5, valid(), [403], 'A permissive profile cannot restore missing stored scheduleCrews');
      reset(); fixture.alter(db => custom(db, 4, Object.fromEntries(scheduling.actions.map(action => [action, false])))); const profileHidden = await call('GET', '/api/state', 4); eq(profileHidden.status, 200); eq(profileHidden.data.projectEvents, []); journeys.push('Custom profile masks only restrict inherited role, grant and project authority');
      for (const bad of [null, [], { ...valid(), id: 99 }, { ...valid(), projectId: 102 }, { ...valid(), memberIds: [12] }, { ...valid(), permissions: { scheduleCrews: true } }, { ...valid(), createdBy: 'Synthetic Owner' }, { ...valid(), title: '' }, { ...valid(), title: 5 }, { ...valid(), title: 'x'.repeat(141) }, { ...valid(), notes: 'x'.repeat(501) }, { ...valid(), notes: [] }, { ...valid(), type: 'spaceship' }, { ...valid(), type: [] }, { ...valid(), date: '2026-02-30' }, { ...valid(), date: '2026-10-13T00:00:00Z' }, { ...valid(), date: 20261013 }]) { reset(); await deny('POST', '/api/projects/101/events', 4, bad, [400], 'Closed event input/date'); }
      reset(); await deny('POST', '/api/projects/999/events', 4, valid(), [404], 'Missing target project'); await deny('DELETE', '/api/project-events/999', 4, undefined, [404], 'Missing original event');
      for (const id of ['0101', '0', '9007199254740992']) await deny('POST', '/api/projects/' + id + '/events', 1, valid(), [400], 'Canonical project identity');
      for (const id of ['011', '0', '9007199254740992']) await deny('DELETE', '/api/project-events/' + id, 1, undefined, [400], 'Canonical event identity');
      await deny('DELETE', '/api/project-events/11', 4, { projectId: 102 }, [400], 'Delete cannot remap its original source'); journeys.push('Closed finite UI inputs, real calendar dates and canonical project/event IDs');
      for (const corrupt of [db => { db.projectEvents.push(structuredClone(db.projectEvents[0])); }, db => { db.projectEvents[0].projectId = 999; }, db => { db.projectEvents[0].date = '2026-02-30'; }, db => { db.projectEvents[0].permissions = { scheduleCrews: true }; }]) {
        reset(); fixture.alter(corrupt); await deny('GET', '/api/state', 1, undefined, [409, 503], 'Malformed event graph stops DTO ingress'); await deny('POST', '/api/projects/101/events', 1, valid(), [409, 503], 'Malformed source stops create before effects'); await deny('DELETE', '/api/project-events/11', 1, undefined, [409, 503], 'Malformed source stops original deletion');
      }
      journeys.push('Malformed, duplicate, dangling and authority-bearing event source stops normal load/DTO/write ingress');
      for (const [name, revoke] of [
        ['stored permission', db => { db.users.find(row => row.id === 4).permissions.scheduleCrews = false; }],
        ['project scope', db => { db.users.find(row => row.id === 4).projectIds = [102]; }],
        ['role', db => { db.users.find(row => row.id === 4).role = 'owner'; }],
        ['account status', db => { db.users.find(row => row.id === 4).status = 'Deactivated'; }],
        ['session', db => { const tokenHash = crypto.createHash('sha256').update(fixture.tokens.get(4)).digest('hex'); db.sessions = db.sessions.filter(row => row.tokenHash !== tokenHash); }],
        ['typed permission', db => mask(db, 'project_manager', { create: false, remove: false })]
      ]) {
        reset(); const before = business(fixture.read()), successes = commitSuccesses; commitHook = input => { eq(input.p_snapshot.projectEvents.some(row => row.title === 'Synthetic admission race'), true, 'Race is held after actual event candidate assembly'); fixture.alter(revoke); };
        const result = await call('POST', '/api/projects/101/events', 4, valid('delivery', 'Synthetic admission race')); eq(result.status, 409, 'Current ' + name + ' revocation rejects original CAS'); eq(commitSuccesses, successes); eq(business(fixture.read()), before, 'Late revocation leaves all business/event history unchanged'); eq(commitHook, null); eq(externalAttempts, 0);
      }
      reset(); const beforeDelete = business(fixture.read()), success = commitSuccesses; commitHook = input => { eq(input.p_snapshot.projectEvents.some(row => row.id === 11), false, 'Delete candidate is assembled against the original source'); fixture.alter(db => { db.users.find(row => row.id === 4).permissions.scheduleCrews = false; }); };
      const revokedDelete = await call('DELETE', '/api/project-events/11', 4); eq(revokedDelete.status, 409); eq(commitSuccesses, success); eq(business(fixture.read()), beforeDelete); journeys.push('Permission/project/role/status/session/policy revocation after candidate assembly blocks original CAS with no business rewrite');
      reset(); let rebound; const beforeRebindSuccess = commitSuccesses; commitHook = input => { eq(input.p_snapshot.projectEvents.some(row => row.id === 11), false, 'Original version-authorized delete candidate is held before CAS'); fixture.alter(db => { const original = db.projectEvents.find(row => row.id === 11); db.projectEvents = db.projectEvents.filter(row => row.id !== 11); db.projectEvents.unshift({ ...original, title: 'Synthetic concurrent changed-content replacement', notes: 'Synthetic concurrent replacement retained', createdAt: '2026-10-12T12:00:00.000Z' }); }); rebound = fixture.read(); };
      const changedAtCommit = await call('DELETE', '/api/project-events/11', 4); eq(changedAtCommit.status, 409); eq(commitSuccesses, beforeRebindSuccess); eq(business(fixture.read()), business(rebound), 'After-candidate target replacement survives original stale CAS unchanged'); eq(commitHook, null); journeys.push('Target content changed after candidate assembly cannot be deleted or rebased by the original CAS');
      reset(); fixture.alter(db => mask(db, 'project_manager', { create: false })); await deny('POST', '/api/projects/101/events/unknown', 4, valid(), [400, 403, 404], 'Unsupported event writer fails closed'); journeys.push('Unsupported event route cannot escape the managed inventory');
      const childEvidence = process.env.PDL_EVENTS_HTTP_EVIDENCE ? path.join(path.dirname(path.resolve(process.env.PDL_EVENTS_HTTP_EVIDENCE)), path.basename(process.env.PDL_EVENTS_HTTP_EVIDENCE, '.json') + '-flag-off.json') : '';
      const child = cp.spawnSync(process.execPath, [__filename, '--flag-off'], { cwd: __dirname, env: { ...process.env, PDL_EVENTS_HTTP_EVIDENCE: childEvidence }, encoding: 'utf8', timeout: 30000, windowsHide: true }); eq(child.status, 0, 'Independent normal flag-off worker: ' + child.stdout + child.stderr); const result = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1)); eq(result.passed, true); eq(result.flagOff, true); eq(result.externalCalls, 0); flagOffSummary = { ...result, ...(childEvidence ? { evidence: childEvidence } : {}) }; journeys.push('Independent flag-off normal server preserves role/stored grant/project floor and readonly controls');
    }
    eq(externalAttempts, 0);
    const result = { passed: true, flagOff, checks, journeys, requests, commitAttempts, commitSuccesses, normalServer: true, testInstallerUsed: false, authStub: false, externalCalls: 0, storageCalls: 0, nativeDeadlineClaim: false, expectedDenialLogs, flagOffSummary, statusCounts: Object.fromEntries([...new Set(cases.map(row => row.status))].sort().map(status => [status, cases.filter(row => row.status === status).length])) };
    if (process.env.PDL_EVENTS_HTTP_EVIDENCE) { const output = path.resolve(process.env.PDL_EVENTS_HTTP_EVIDENCE); assert.equal(path.dirname(output), path.dirname(__dirname), 'Diagnostic output remains in the parent task workspace'); assert.match(path.basename(output), /^roles-events-integrated-http-evidence-[a-zA-Z0-9-]+\.json$/); fs.writeFileSync(output, JSON.stringify({ capturedAt: new Date().toISOString(), ...result, cases }, null, 2) + '\n'); }
    console.log(JSON.stringify(result));
  } finally { commitHook = null; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); globalThis.fetch = nativeFetch; console.error = nativeConsoleError; const target = path.resolve(owned); assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep) && /^pdl-(roles-production-http|events-flag-off)-/.test(path.basename(target))); fs.rmSync(target, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
