'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const profiles = require('./role-profiles'), registry = require('./capability-registry'), accounts = require('./account-projections'), api = require('./role-policy-api');
const { workspace } = require('./fixtures/roles-workspace'), { companyB } = require('./fixtures/project-assistant');
const { canonicalHash } = require('./database/transactional-repository');
const copy = value => structuredClone(value), ROOT = api.ROOT;
function harness() {
  let db = workspace(), revision = 10, loaded, response, clock = Date.now(), writes = 0;
  db.users.find(row => row.id === 7).role = 'office'; db.users.find(row => row.id === 7).permissions = { manageTime: true };
  const handle = api.createHandler({ readDb: () => db, writeDb: value => { db = copy(value); revision++; writes++; }, body: async req => req.input, json: (_res, status, data) => { response = { status, data }; }, revision: () => loaded, assertCurrent: async () => { if (loaded !== revision) throw Object.assign(Error('Synthetic stale revision'), { statusCode: 409 }); }, baselineProjectAllowed: (snapshot, user, projectId) => ['owner', 'admin'].includes(user.role) || user.role === 'project_manager' && user.projectIds.includes(projectId) || ['field', 'foreman'].includes(user.role) && snapshot.assignments.some(row => row.projectId === projectId && row.memberIds.includes(user.memberId)), accountAccess: () => ({ locked: false, status: 'Demo' }), guardCommit: value => api.validateCommitGuard(value), now: () => clock });
  return { get db() { return db; }, get revision() { return revision; }, get writes() { return writes; }, bump: () => revision++, advance: ms => { clock += ms; }, call: async (method, path, input, id = 1) => { loaded = revision; response = undefined; const user = db.users.find(row => row.id === id), session = db.sessions.find(row => row.userId === id); await handle({ method, input, auth: { user: registry.actor(db, registry.normalize(user), true), session, companyId: db.company.id } }, {}, new URL('http://localhost' + path)); return response; } };
}
const preview = (h, change) => h.call('POST', ROOT + '/profiles/preview', { requestId: crypto.randomUUID(), expectedRevision: h.revision, reason: 'Synthetic reviewed named profile', profileChange: change });
const confirmInput = proof => ({ previewId: proof.previewId, version: proof.version, requestId: crypto.randomUUID(), confirmed: true });
async function save(h, change) { const reviewed = await preview(h, change); assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data)); const input = confirmInput(reviewed.data), saved = await h.call('POST', ROOT + '/confirm', input); assert.equal(saved.status, 200, JSON.stringify(saved.data)); return { reviewed: reviewed.data, saved: saved.data, input }; }
async function main() {
  const h = harness(), initial = copy(h.db), before = h.db.users.map(user => registry.effective(h.db, user));
  for (const operation of ['constructor', 'hasOwnProperty', '__proto__', 'toString', null, 1]) assert.throws(() => profiles.parseChange({ operation }), { statusCode: 400 });
  assert.equal((await h.call('GET', ROOT + '/profiles')).data.model, null); assert.deepEqual(h.db, initial); assert.equal(h.writes, 0);
  const office = await save(h, { operation: 'createOffice' }); assert.equal(office.reviewed.impact.changedAccounts, 0);
  assert.deepEqual(h.db.users, initial.users); assert.deepEqual(h.db.sessions, initial.sessions); assert.deepEqual(h.db.assignments, initial.assignments); assert.deepEqual(h.db.users.map(user => registry.effective(h.db, user)), before);
  for (const [, , prefix] of registry.families) assert.equal(Object.hasOwn(h.db.company, prefix + 'RolePolicy'), false);
  assert.deepEqual(Object.entries(profiles.defaults('admin', true)).flatMap(([family, flags]) => Object.entries(flags).filter(([, value]) => value).map(([action]) => family + '.' + action)), [...profiles.OFFICE_INITIAL_ACTIONS]);
  const officeAssigned = await save(h, { operation: 'assign', accountId: 7, profileId: profiles.OFFICE_ID });
  assert.equal(officeAssigned.reviewed.impact.changedAccounts, 1); assert.equal(h.db.users.find(row => row.id === 7).role, 'office');
  const officeUser = accounts.dto(h.db, h.db.users.find(row => row.id === 7)); assert.equal(officeUser.roleProfile.name, 'Office'); assert.equal(officeUser.roleProfile.baseRole, 'admin'); assert.equal(officeUser.notesPermissions.view, true); assert.equal(officeUser.notesPermissions.create, false); assert.equal(officeUser.timeWriteAccess.captureExports, false); assert.equal(officeUser.immutableAccess.assistantEligible, true);
  assert.deepEqual(registry.baseline(h.db, h.db.users.find(row => row.id === 7)), before[6]);
  const field = h.db.users.find(row => row.id === 4); assert.equal(registry.immutable(h.db, field).assistantEligible, false);
  const customId = crypto.randomUUID(), custom = profiles.defaults('project_manager'); custom.notes.create = false; custom.notes.edit = false;
  await save(h, { operation: 'create', profileId: customId, name: 'Site coordinator', baseRole: 'project_manager', capabilities: custom });
  const assigned = await save(h, { operation: 'assign', accountId: 2, profileId: customId }); assert.equal(assigned.reviewed.impact.changedAccounts, 1);
  const pm = h.db.users.find(row => row.id === 2); assert.deepEqual(pm, initial.users[1]); assert.equal(require('./notes-access').access(h.db, pm).create, false); assert.equal(require('./notes-access').access(h.db, pm).complete, true);
  assert.equal(require('./scheduling-access').inScope(h.db, pm, { projectId: 102, memberIds: [13] }, 'create'), false);
  assert.equal(require('./scheduling-access').inScope(h.db, pm, { projectId: 101, memberIds: [11] }, 'create'), true);
  const snapshot = copy(h.db), writes = h.writes;
  for (const change of [{ operation: 'assign', accountId: 1, profileId: customId }, { operation: 'assign', accountId: 4, profileId: customId }, { operation: 'assign', accountId: 99999, profileId: customId }, { operation: 'delete', profileId: customId, expectedProfileRevision: 1 }, { operation: 'edit', profileId: customId, expectedProfileRevision: 1, name: 'Site coordinator', baseRole: 'admin', capabilities: custom }]) {
    assert.ok([400, 404, 409].includes((await preview(h, change)).status)); assert.equal(h.writes, writes); assert.deepEqual(h.db, snapshot);
  }
  for (const mutate of [row => { row.notes.aiAssistant = true; }, row => { row.timeWrite.configurePeriods = true; }]) {
    const flags = profiles.defaults('field'); mutate(flags); assert.equal((await preview(h, { operation: 'create', profileId: crypto.randomUUID(), name: 'Invalid profile', baseRole: 'field', capabilities: flags })).status, 400);
  }
  for (const id of [2, 4, 5, 7]) { assert.equal((await h.call('GET', ROOT + '/profiles', undefined, id)).status, 403); assert.equal((await previewAs(id)).status, 403); }
  function previewAs(id) { return h.call('POST', ROOT + '/profiles/preview', { requestId: crypto.randomUUID(), expectedRevision: h.revision, reason: 'Unauthorized synthetic change', profileChange: { operation: 'createOffice' } }, id); }
  const changed = copy(custom); changed.scheduling.create = changed.scheduling.edit = changed.scheduling.remove = false;
  const edited = await save(h, { operation: 'edit', profileId: customId, expectedProfileRevision: 1, name: 'Reviewed coordinator → café 工程', capabilities: changed });
  assert.equal(edited.reviewed.impact.changedAccounts, 1); assert.equal(require('./scheduling-access').access(h.db, pm).create, false);
  assert.equal(h.db.users.find(row => row.id === 2).permissions.scheduleCrews, true); assert.equal(registry.immutable(h.db, pm).assistantEligible, true);
  assert.equal((await h.call('POST', ROOT + '/confirm', assigned.input)).status, 409, 'Older receipt cannot certify a changed profile effect');
  assert.equal((await preview(h, { operation: 'edit', profileId: customId, expectedProfileRevision: 1, name: 'Old revision', capabilities: changed })).status, 409);
  const removed = await save(h, { operation: 'assign', accountId: 2, profileId: null }); assert.equal(removed.reviewed.impact.changedAccounts, 1); assert.equal(require('./scheduling-access').access(h.db, pm).create, true);
  await save(h, { operation: 'delete', profileId: customId, expectedProfileRevision: 2 }); assert.ok(h.db.company.roleProfiles.retiredIds.includes(customId));
  assert.equal((await preview(h, { operation: 'create', profileId: customId, name: 'Cannot reuse', baseRole: 'project_manager', capabilities: custom })).status, 409);
  assert.equal((await preview(h, { operation: 'delete', profileId: profiles.OFFICE_ID, expectedProfileRevision: 1 })).status, 409);
  const me = h.db.users.find(row => row.id === 7), intact = copy(h.db);
  const mismatch = copy(intact); mismatch.users.find(row => row.id === 7).role = 'project_manager';
  assert.equal(profiles.binding(mismatch, mismatch.users[6]).state, 'role-mismatch'); assert.ok(Object.values(registry.effective(mismatch, mismatch.users[6])).every(flags => Object.values(flags).every(value => !value))); assert.deepEqual(registry.effective(mismatch, mismatch.users[0]), before[0]);
  for (const mutate of [db => { delete db.company.roleProfiles; }, db => { db.company.roleProfilesRequired = false; }, db => { db.company.roleProfiles.assignments.push(copy(db.company.roleProfiles.assignments[0])); }, db => { db.company.roleProfiles.assignments[0].accountId = 1; }, db => { db.company.roleProfiles.assignments[0].accountId = 9999; }, db => { db.users.find(row => row.id === 7).companyId = companyB; }, db => { db.company.roleProfiles.profiles[0].capabilities.notes.aiAssistant = true; }, db => { db.company.roleProfiles.retiredIds.push(profiles.OFFICE_ID); }]) {
    const broken = copy(intact); mutate(broken);
    for (const user of broken.users.filter(row => row.role !== 'owner')) assert.ok(Object.values(registry.effective(broken, user)).every(flags => Object.values(flags).every(value => !value)));
    assert.deepEqual(registry.effective(broken, broken.users[0]), before[0]); assert.equal(registry.actor(broken, registry.normalize(me), false), null);
    assert.doesNotThrow(() => profiles.authority(broken, broken.users[0]), 'Malformed restrictive stores cannot lock out immutable owner action authority');
  }
  const stale = harness(), staged = await preview(stale, { operation: 'createOffice' }); stale.db.users[0].role = 'admin'; stale.bump(); assert.equal((await stale.call('POST', ROOT + '/confirm', confirmInput(staged.data))).status, 403); assert.equal(Object.hasOwn(stale.db.company, 'roleProfiles'), false);
  const expired = harness(), expiring = await preview(expired, { operation: 'createOffice' }); expired.advance(api.TTL); assert.equal((await expired.call('POST', ROOT + '/confirm', confirmInput(expiring.data))).status, 409);
  const source = harness(), pending = await preview(source, { operation: 'createOffice' }); source.db.users[1].permissions.scheduleCrews = false; source.bump(); assert.equal((await source.call('POST', ROOT + '/confirm', confirmInput(pending.data))).status, 409);
  const legacy = harness(), rows = Object.fromEntries(registry.families.map(([id, , , , module]) => [id, Object.fromEntries(module.roles.map(role => [role, module.ceiling(role)]))])); rows.notes.field.create = false;
  const old = await legacy.call('POST', ROOT + '/preview', { requestId: crypto.randomUUID(), expectedRevision: legacy.revision, reason: 'Original typed policy', policies: rows }); assert.equal(old.status, 200);
  const oldConfirm = confirmInput(old.data); assert.equal((await legacy.call('POST', ROOT + '/confirm', oldConfirm)).status, 200); const originalProof = copy(legacy.db.rolePolicyPreviews[0]);
  await save(legacy, { operation: 'createOffice' }); api.ledger(legacy.db); assert.deepEqual(legacy.db.rolePolicyPreviews[0], originalProof); assert.equal((await legacy.call('POST', ROOT + '/confirm', oldConfirm)).status, 409);
  const currentPolicyHash = api.policyHash(legacy.db); legacy.db.company.roleProfiles.assignments.push({ accountId: 7, profileId: profiles.OFFICE_ID }); assert.notEqual(api.policyHash(legacy.db), currentPolicyHash);
  assert.equal(canonicalHash(h.db.users), canonicalHash(initial.users));
  // Profile before/after snapshots must reserve durable confirmation capacity too.
  const capacity = harness(), first = await preview(capacity, { operation: 'createOffice' }), seed = copy(capacity.db), template = seed.rolePolicyPreviews[0], auditTemplate = seed.rolePolicyAudit[0];
  assert.equal((await capacity.call('POST', ROOT + '/confirm', confirmInput(first.data))).status, 200);
  const confirmationBytes = api.controlBytes(capacity.db) - api.controlBytes(seed) + 2 * (128 - 36);
  for (const key of Object.keys(capacity.db)) delete capacity.db[key]; Object.assign(capacity.db, copy(seed)); capacity.db.rolePolicyPreviews = []; capacity.db.rolePolicyReceipts = []; capacity.db.rolePolicyAudit = [];
  const pairBytes = api.controlBytes(seed) - api.controlBytes(capacity.db), target = api.LEDGER_BYTES - pairBytes - confirmationBytes + 1;
  while (api.controlBytes(capacity.db) + pairBytes < target) {
    const proof = copy(template), audit = copy(auditTemplate); proof.id = crypto.randomUUID(); proof.inputHash = canonicalHash({ requestId: proof.id, expectedRevision: proof.expectedRevision - 1, reason: proof.reason, profileChange: proof.policies.profileChange }); proof.version = canonicalHash(Object.fromEntries(Object.entries(proof).filter(([key]) => key !== 'version'))); audit.id = crypto.randomUUID(); audit.previewId = audit.requestId = proof.id; capacity.db.rolePolicyPreviews.push(proof); capacity.db.rolePolicyAudit.push(audit);
  }
  let padding = target - api.controlBytes(capacity.db); const last = capacity.db.rolePolicyPreviews.at(-1);
  for (const account of last.impact.accounts) { const added = Math.min(padding, 5000 - account.name.length); account.name += 'x'.repeat(added); padding -= added; }
  assert.equal(padding, 0); last.version = canonicalHash(Object.fromEntries(Object.entries(last).filter(([key]) => key !== 'version'))); capacity.db.rolePolicyAudit.at(-1).impactHash = canonicalHash(last.impact); api.ledger(capacity.db);
  const retained = copy(capacity.db), priorWrites = capacity.writes; assert.equal((await preview(capacity, { operation: 'createOffice' })).status, 409); assert.equal(capacity.writes, priorWrites); assert.deepEqual(capacity.db, retained);
  const padded = last.impact.accounts.find(row => row.name.length > 512); padded.name = padded.name.slice(0, -512); last.version = canonicalHash(Object.fromEntries(Object.entries(last).filter(([key]) => key !== 'version'))); capacity.db.rolePolicyAudit.at(-1).impactHash = canonicalHash(last.impact);
  const fits = await preview(capacity, { operation: 'createOffice' }); assert.equal(fits.status, 200); assert.equal((await capacity.call('POST', ROOT + '/confirm', confirmInput(fits.data))).status, 200); api.ledger(capacity.db); assert.ok(api.controlBytes(capacity.db) <= api.LEDGER_BYTES);
  const large = workspace(); large.users = Array.from({ length: 1000 }, (_, index) => ({ id: index + 1, companyId: large.company.id, name: 'Synthetic account ' + index, email: 'profile' + index + '@example.invalid', role: 'admin', status: 'Active', permissions: { manageTime: true } }));
  const masks = Array.from({ length: profiles.MAX_PROFILES }, (_, index) => ({ id: crypto.randomUUID(), name: 'Synthetic profile ' + index, kind: 'custom', baseRole: 'admin', scopeInheritance: profiles.SCOPE, revision: 1, capabilities: profiles.defaults('admin') }));
  large.company.roleProfilesRequired = true; large.company.roleProfiles = { version: 1, revision: 1, profiles: masks, assignments: large.users.map((user, index) => ({ accountId: user.id, profileId: masks[index % masks.length].id })), retiredIds: [] };
  const started = Date.now(), directory = accounts.directory(large), elapsed = Date.now() - started; assert.equal(directory.length, 1000); assert.ok(elapsed < 5000, 'A full supported 1000-account/50-profile directory must avoid repeated quadratic model resolution: ' + elapsed + 'ms');
  large.company.roleProfiles.profiles[0].capabilities.notes.view = false; assert.ok(Object.values(registry.effective(large, large.users[0])).every(flags => Object.values(flags).every(value => !value)), 'Validated evidence cannot survive a later mutable candidate corruption');
  assert.throws(() => profiles.evaluate(large, async () => {}), /must be synchronous/);
  console.log('Profile upper-bound directory: ' + elapsed + 'ms for 1000 accounts/50 profiles; later-candidate corruption revalidated.');
  console.log('Named profile tests passed: exact unassigned defaults, explicit Office profile, real dependent typed gates, immutable base/scope/grants/Assistant/owner, lifecycle retirement/in-use denial, affected users, malformed/missing/foreign denial, stale/revoked/expired confirmation and preserved legacy history/effect hashes.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
