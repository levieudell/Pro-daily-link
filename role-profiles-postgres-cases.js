'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { workspace } = require('./fixtures/roles-workspace'), { companyA, companyB } = require('./fixtures/project-assistant');
const profiles = require('./role-profiles'), registry = require('./capability-registry'), api = require('./role-policy-api');
const copy = value => structuredClone(value), id = () => crypto.randomUUID();
module.exports = async function ({ repository, change, request, slowRequest, bases, startWorker, checkpoint, waitFor, controls, providerEvents }) {
  const original = copy((await repository.load(companyA)).snapshot), foreign = await repository.load(companyB), providerCount = providerEvents.length;
  const load = () => repository.load(companyA), ROOT = api.ROOT, clean = workspace(); clean.users.find(row => row.id === 7).role = 'office'; clean.users.find(row => row.id === 7).permissions = { manageTime: true };
  const restore = snapshot => change(db => { for (const key of Object.keys(db)) delete db[key]; Object.assign(db, copy(snapshot)); });
  const call = async (method, route, input, user = 1, expected = 200, worker = 0) => { const result = await request(bases[worker], method, route, input, user); assert.equal(result.status, expected, method + ' ' + route + ': ' + JSON.stringify(result.data)); return result; };
  const proposal = async profileChange => ({ requestId: id(), expectedRevision: (await call('GET', ROOT + '/profiles')).data.tenantRevision, reason: 'Synthetic reviewed profile lifecycle', profileChange });
  const confirmInput = proof => ({ previewId: proof.data.previewId, version: proof.data.version, requestId: id(), confirmed: true });
  async function save(profileChange) { const input = await proposal(profileChange), preview = await call('POST', ROOT + '/profiles/preview', input), confirmation = confirmInput(preview), saved = await call('POST', ROOT + '/confirm', confirmation); return { preview, confirmation, saved }; }
  const gate = () => { controls.gate = checkpoint(); controls.gate.expected = 99; controls.commitFilter = url => url.pathname.endsWith('replace_tenant_policy_records'); return controls.gate; };
  const release = () => { controls.gate.resolve(); controls.gate = null; controls.commitFilter = null; };
  try {
    await restore(clean); const initial = await load(), effectiveBefore = clean.users.map(user => registry.effective(clean, user));
    await call('GET', ROOT + '/profiles'); assert.deepEqual(await load(), initial);
    for (const actor of [2, 4, 5, 7]) { await call('GET', ROOT + '/profiles', undefined, actor, 403); await call('POST', ROOT + '/profiles/preview', {}, actor, 403); }
    assert.equal((await request(bases[0], 'GET', ROOT + '/profiles', undefined, 1, companyB)).status, 401);
    const office = await save({ operation: 'createOffice' }); assert.equal(office.preview.data.impact.changedAccounts, 0);
    let snapshot = (await load()).snapshot; assert.deepEqual(snapshot.users, initial.snapshot.users); assert.deepEqual(snapshot.sessions, initial.snapshot.sessions); assert.deepEqual(snapshot.assignments, initial.snapshot.assignments); assert.deepEqual(snapshot.users.map(user => registry.effective(snapshot, user)), effectiveBefore);
    for (const [, , prefix] of registry.families) assert.equal(Object.hasOwn(snapshot.company, prefix + 'RolePolicy'), false);
    const assignedOffice = await save({ operation: 'assign', accountId: 7, profileId: profiles.OFFICE_ID }); assert.equal(assignedOffice.preview.data.impact.changedAccounts, 1);
    const me = await call('GET', '/api/auth/me', undefined, 7); assert.equal(me.data.roleProfile.name, 'Office'); assert.equal(me.data.roleProfile.baseRole, 'admin'); assert.equal(me.data.immutableAccess.assistantEligible, true); assert.equal(me.data.notesPermissions.view, true); assert.equal(me.data.notesPermissions.create, false); assert.equal(me.data.timeWriteAccess.captureExports, false);
    await call('POST', '/api/projects/101/notes-todos', { kind: 'note', text: 'Office denied actual note create', requestId: id() }, 7, 403);
    await call('POST', '/api/assignments', { projectId: 101, memberIds: [11], date: '2098-10-12', start: '08:00', end: '09:00', activity: 'Office denied actual schedule', requestId: id() }, 7, 403);
    assert.equal((await load()).snapshot.users.find(row => row.id === 7).role, 'office');
    let protectedBefore = await load(); await call('PATCH', '/api/users/7', { role: 'field' }, 1, 409); assert.deepEqual(await load(), protectedBefore);
    const customId = id(), mask = profiles.defaults('project_manager'); mask.notes.create = mask.notes.edit = false;
    await save({ operation: 'create', profileId: customId, name: 'Site coordinator', baseRole: 'project_manager', capabilities: mask });
    await save({ operation: 'assign', accountId: 2, profileId: customId });
    protectedBefore = await load(); await call('PATCH', '/api/users/2', { role: 'admin' }, 1, 409); assert.deepEqual(await load(), protectedBefore);
    await call('POST', '/api/projects/101/notes-todos', { kind: 'note', text: 'Profile denies real note create', requestId: id() }, 2, 403);
    await call('GET', '/api/projects/102/notes-todos', undefined, 2, 404);
    await call('POST', '/api/assignments', { projectId: 102, memberIds: [13], date: '2098-10-12', start: '08:00', end: '09:00', activity: 'Scope bypass denied', requestId: id() }, 2, 403);
    await call('POST', ROOT + '/profiles/preview', await proposal({ operation: 'assign', accountId: 4, profileId: customId }), 1, 400);
    await call('POST', ROOT + '/profiles/preview', await proposal({ operation: 'assign', accountId: 1, profileId: profiles.OFFICE_ID }), 1, 400);
    const beforeDelete = await load(); await call('POST', ROOT + '/profiles/preview', await proposal({ operation: 'delete', profileId: customId, expectedProfileRevision: 1 }), 1, 409); assert.deepEqual(await load(), beforeDelete);
    const reduced = copy(mask); reduced.scheduling.create = reduced.scheduling.edit = reduced.scheduling.remove = false;
    const edited = await save({ operation: 'edit', profileId: customId, expectedProfileRevision: 1, name: 'Coordinator → café 工程', capabilities: reduced });
    assert.equal(edited.preview.data.impact.changedAccounts, 1); assert.equal((await load()).snapshot.users.find(row => row.id === 2).permissions.scheduleCrews, true);
    await call('POST', '/api/assignments', { projectId: 101, memberIds: [11], date: '2098-10-12', start: '08:00', end: '09:00', activity: 'Actual scheduling revoked', requestId: id() }, 2, 403);
    await call('POST', '/api/projects/101/assistant/preview', { action: 'schedule', memberId: 11, date: '2098-10-12', start: '08:00', end: '09:00', timezone: 'America/Los_Angeles', activity: 'Assistant cannot override profile' }, 2, 403);
    await call('GET', '/api/projects/101/assistant/context', undefined, 4, 403);
    await call('POST', ROOT + '/confirm', assignedOffice.confirmation, 1, 409);
    const remove = await save({ operation: 'assign', accountId: 2, profileId: null }); assert.equal(remove.preview.data.impact.changedAccounts, 1);
    await save({ operation: 'delete', profileId: customId, expectedProfileRevision: 2 });
    await call('POST', ROOT + '/profiles/preview', await proposal({ operation: 'create', profileId: customId, name: 'Retired cannot return', baseRole: 'project_manager', capabilities: mask }), 1, 409);
    const stable = (await load()).snapshot; assert.deepEqual(stable.users, initial.snapshot.users); assert.deepEqual(stable.assignments, initial.snapshot.assignments); api.ledger(stable);
    console.log('Profiles PostgreSQL: real Office/custom lifecycle, unchanged defaults/roles/grants/scopes, actual notes/scheduling/Assistant gates, affected accounts, in-use refusal and retired identities passed.');

    // Profile edits use the same private delivery and business CAS fences as policies.
    for (const route of ['/api/assignments', '/api/time-cards', '/api/projects/101/notes-todos']) {
      await restore(clean); const profileId = id(), allowed = profiles.defaults('project_manager');
      await save({ operation: 'create', profileId, name: 'Delivery coordinator', baseRole: 'project_manager', capabilities: allowed }); await save({ operation: 'assign', accountId: 2, profileId });
      const reduced = copy(allowed); for (const family of ['scheduling', 'timeReview', 'timeWrite', 'notes']) for (const action of Object.keys(reduced[family])) reduced[family][action] = false;
      const proof = await call('POST', ROOT + '/profiles/preview', await proposal({ operation: 'edit', profileId, expectedProfileRevision: 1, name: 'Delivery coordinator', capabilities: reduced }));
      controls.readGate = checkpoint(); const buffered = request(bases[0], 'GET', route, undefined, 2); await waitFor(() => controls.readGate.count === 3);
      await call('POST', ROOT + '/confirm', confirmInput(proof), 1, 200, 1); const before = await load(); controls.readGate.resolve(); controls.readGate = null;
      const denied = await buffered; assert.equal(denied.status, 409, route); assert.ok(!JSON.stringify(denied.data).includes('PRIVATE-')); assert.deepEqual(await load(), before);
    }
    await restore(clean); const raceId = id(), raceMask = profiles.defaults('project_manager'); await save({ operation: 'create', profileId: raceId, name: 'Racing coordinator', baseRole: 'project_manager', capabilities: raceMask }); await save({ operation: 'assign', accountId: 2, profileId: raceId });
    raceMask.notes.create = false; const raceProof = await call('POST', ROOT + '/profiles/preview', await proposal({ operation: 'edit', profileId: raceId, expectedProfileRevision: 1, name: 'Racing coordinator', capabilities: raceMask }));
    let raceGate = gate(); controls.commitFilter = url => !url.pathname.endsWith('replace_tenant_policy_records'); const racing = request(bases[0], 'POST', '/api/projects/101/notes-todos', { kind: 'note', text: 'Revoked inflight profile note', requestId: id() }, 2); await waitFor(() => raceGate.count === 1);
    await call('POST', ROOT + '/confirm', confirmInput(raceProof), 1, 200, 1); const afterRestriction = await load(); release(); assert.equal((await racing).status, 409); assert.deepEqual(await load(), afterRestriction);
    await save({ operation: 'assign', accountId: 2, profileId: null }); await call('PATCH', '/api/users/2', { role: 'admin' }); assert.equal((await load()).snapshot.users[1].role, 'admin');
    console.log('Profiles PostgreSQL: actual guarded account-role edit, buffered private response revocation and profile-first business CAS rejection passed.');

    // Full tenant CAS and the same durable guard protect profile previews/confirms.
    await restore(clean); let input = await proposal({ operation: 'createOffice' }), barrier = gate();
    let pending = [0, 1].map(worker => request(bases[worker], 'POST', ROOT + '/profiles/preview', input));
    await waitFor(() => barrier.count === 2); release(); let results = await Promise.all(pending); assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
    const winner = results.find(row => row.status === 200), confirmation = confirmInput(winner); barrier = gate();
    pending = [0, 1].map(worker => request(bases[worker], 'POST', ROOT + '/confirm', confirmation)); await waitFor(() => barrier.count === 2); release(); results = await Promise.all(pending); assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
    let before = await load(); await call('POST', ROOT + '/confirm', confirmation, 1, 200, 1); assert.deepEqual(await load(), before); assert.equal(before.snapshot.rolePolicyReceipts.length, 1);
    await restore(clean); input = await proposal({ operation: 'createOffice' }); controls.rejectCommit = true;
    before = await load(); await call('POST', ROOT + '/profiles/preview', input, 1, 503); controls.rejectCommit = false; assert.deepEqual(await load(), before);
    controls.dropAck = true; const unknownPreview = await call('POST', ROOT + '/profiles/preview', input, 1, 503); controls.dropAck = false; assert.equal(unknownPreview.data.code, 'COMMIT_OUTCOME_UNKNOWN');
    const restarted = await startWorker(), recovered = await request(restarted, 'POST', ROOT + '/profiles/preview', input); assert.equal(recovered.status, 200);
    const originalConfirm = confirmInput(recovered); controls.dropAck = true; const unknownConfirm = await request(restarted, 'POST', ROOT + '/confirm', originalConfirm); controls.dropAck = false; assert.equal(unknownConfirm.status, 503);
    before = await load(); assert.equal((await request(restarted, 'POST', ROOT + '/confirm', originalConfirm)).status, 200); assert.deepEqual(await load(), before); assert.equal(before.snapshot.rolePolicyReceipts.length, 1);
    await restore(clean); input = await proposal({ operation: 'createOffice' }); const preview = await call('POST', ROOT + '/profiles/preview', input);
    await change(db => { db.users[0].status = 'Deactivated'; }); before = await load(); await call('POST', ROOT + '/confirm', confirmInput(preview), 1, 401); assert.deepEqual(await load(), before);
    await restore(clean); input = await proposal({ operation: 'createOffice' }); barrier = gate(); const committing = request(bases[0], 'POST', ROOT + '/profiles/preview', input); await waitFor(() => barrier.count === 1);
    await change(db => { db.users[0].role = 'admin'; }); before = await load(); release(); assert.equal((await committing).status, 409); assert.deepEqual(await load(), before);
    await restore(clean); const officeAgain = await save({ operation: 'createOffice' }); const toAssign = await proposal({ operation: 'assign', accountId: 7, profileId: profiles.OFFICE_ID });
    const slow = await slowRequest(bases[0], 1, toAssign, ROOT + '/profiles/preview'); await change(db => { db.users[0].status = 'Deactivated'; }); before = await load(); slow.done(); assert.ok([401, 409].includes((await slow.result).status)); assert.deepEqual(await load(), before);
    assert.equal(officeAgain.preview.data.impact.changedAccounts, 0);
    console.log('Profiles PostgreSQL: two-worker CAS, rejected/lost acknowledgments and restart recovery, revoked owner, inflight commit/slow-body authority and exact receipts passed.');

    await restore(clean); await save({ operation: 'createOffice' }); await save({ operation: 'assign', accountId: 7, profileId: profiles.OFFICE_ID }); const intact = copy((await load()).snapshot);
    for (const corrupt of [db => { delete db.company.roleProfiles; }, db => { db.company.roleProfilesRequired = false; }, db => { db.company.roleProfiles.assignments.push(copy(db.company.roleProfiles.assignments[0])); }, db => { db.company.roleProfiles.assignments[0].accountId = 99999; }, db => { db.company.roleProfiles.assignments[0].accountId = 1; }, db => { db.company.roleProfiles.profiles[0].capabilities.notes.private = 'PRIVATE-PROFILE-SENTINEL'; }]) {
      await restore(intact); await change(corrupt); before = await load();
      const denied = await call('GET', ROOT + '/profiles', undefined, 1, 409); assert.ok(!JSON.stringify(denied.data).includes('PRIVATE-PROFILE-SENTINEL'));
      for (const route of ['/api/assignments', '/api/time-off-requests', '/api/time-cards', '/api/pay-periods', '/api/reports', '/api/projects/101/notes-todos']) await call('GET', route, undefined, 7, 403);
      await call('GET', '/api/projects/101/notes-todos'); assert.deepEqual(await load(), before);
    }
    await restore(intact); before = await load(); const foreignProof = before.snapshot.rolePolicyPreviews.at(-1); assert.equal((await request(bases[1], 'POST', ROOT + '/confirm', { previewId: foreignProof.id, version: foreignProof.version, requestId: id(), confirmed: true }, 1, companyB, companyB)).status, 409);
    const other = await request(bases[1], 'GET', ROOT + '/profiles', undefined, 1, companyB, companyB); assert.equal(other.status, 200); assert.equal(other.data.model, null);
    const foreignBody = await proposal({ operation: 'assign', accountId: 7, profileId: profiles.OFFICE_ID }); foreignBody.companyId = companyB; await call('POST', ROOT + '/profiles/preview', foreignBody, 1, 400); assert.deepEqual(await load(), before);
    console.log('Profiles PostgreSQL: malformed/required-missing/global identity/owner marker denial, finite errors and independent tenant namespaces passed.');
  } finally {
    if (controls.readGate) { controls.readGate.resolve(); controls.readGate = null; }
    if (controls.gate) release(); controls.rejectCommit = controls.dropAck = false;
    await restore(original); assert.deepEqual(await repository.load(companyB), foreign); assert.equal(providerEvents.length, providerCount);
  }
};
