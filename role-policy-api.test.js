'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const api = require('./role-policy-api'), registry = require('./capability-registry'), accounts = require('./account-projections'), outbox = require('./assignment-email-outbox');
const { fixture, companyA, companyB } = require('./fixtures/project-assistant');
const { canonicalHash } = require('./database/transactional-repository');
const defaults = () => Object.fromEntries(registry.families.map(([id, , , , module]) => [id, Object.fromEntries(module.roles.map(role => [role, module.ceiling(role)]))]));
const baselineProjectAllowed = (db, user, projectId) => ['owner', 'admin'].includes(user.role) || user.role === 'project_manager' && user.projectIds.map(Number).includes(projectId) || ['field', 'foreman'].includes(user.role) && ((db.assignments || []).some(row => row.projectId === projectId && row.memberIds.includes(Number(user.memberId))) || (db.reports || []).some(row => db.projects[row.project]?.id === projectId && row.foreman === db.team.find(member => member.id === Number(user.memberId))?.name));
function harness() {
  let db = fixture(), revision = 10, loadedRevision, clock = Date.now(), response, guard, writes = 0, fenceError;
  db.company.features.timeCards = true;
  Object.assign(db.users[1].permissions, { manageTime: true, viewTime: true, viewDailies: true, approveDailies: true });
  db.assignments = [{ id: 91, projectId: 101, memberIds: [11], date: '2098-10-12', start: '08:00', end: '16:00', activity: 'Synthetic', notifications: { 11: { emailStatus: 'queued' } } }];
  db.reports = [{ id: 92, project: 1, foreman: 'Jordan Sample', laborEntries: [] }];
  const handle = api.createHandler({ readDb: () => db, writeDb: candidate => { db = structuredClone(candidate); revision++; writes++; }, body: async req => req.input, json: (_res, status, data) => { response = { status, data }; }, revision: () => loadedRevision, assertCurrent: async req => { if (fenceError) throw Object.assign(Error('Synthetic stale policy response'), { statusCode: fenceError }); if (revision !== loadedRevision) throw Object.assign(Error('Synthetic revision conflict'), { statusCode: 409 }); }, baselineProjectAllowed, accountAccess: () => ({ locked: false, status: 'Demo' }), guardCommit: value => { guard = value; }, now: () => clock });
  return { get db() { return db; }, set db(value) { db = value; }, get revision() { return revision; }, get guard() { return guard; }, get writes() { return writes; }, advance: ms => { clock += ms; }, bump: () => revision++, fence: status => { fenceError = status; }, call: async (method, path, input, user = 1, sessionIndex) => { loadedRevision = revision; response = undefined; const account = db.users.find(row => row.id === user); const session = sessionIndex == null ? db.sessions.find(row => row.userId === user) : db.sessions[sessionIndex]; const req = { method, input, auth: { user: registry.actor(db, account, true), session, companyId: db.company.id } }; const handled = await handle(req, {}, new URL('http://localhost' + path)); return { handled, ...response }; } };
}
const proposal = (h, policies = defaults()) => ({ requestId: crypto.randomUUID(), expectedRevision: h.revision, reason: 'Synthetic role-policy review', policies });
const confirm = proof => ({ previewId: proof.previewId, version: proof.version, requestId: crypto.randomUUID(), confirmed: true });
async function main() {
  const h = harness(), root = api.ROOT, initial = structuredClone(h.db);
  let read = await h.call('GET', root); assert.equal(read.status, 200); assert.equal(read.data.tenantRevision, 10); assert.ok(Object.values(read.data.policies).every(row => row === null)); assert.deepEqual(h.db, initial);
  assert.equal((await h.call('POST', root + '/preview', proposal(h))).status, 400); assert.equal(h.writes, 0, 'Ceiling defaults stay absent with no requested change');
  for (const mutate of [input => { input.policies.security = {}; }, input => { input.policies.notes.owner = {}; }, input => { input.policies.notes.field.aiAssistant = true; }, input => { input.policies.timeWrite.field.configurePeriods = true; }, input => { input.reason = {}; }, input => { input.expectedRevision = '10'; }]) { const input = proposal(h); mutate(input); assert.equal((await h.call('POST', root + '/preview', input)).status, 400); assert.equal(h.writes, 0); }
  for (const user of [2, 4, 5, 7]) { assert.equal((await h.call('GET', root, undefined, user)).status, 403); assert.equal((await h.call('POST', root + '/preview', proposal(h), user)).status, 403); }
  const rows = defaults(); rows.notes.field.create = false;
  const input = proposal(h, rows), preview = await h.call('POST', root + '/preview', input); assert.equal(preview.status, 200); assert.equal(h.writes, 1); assert.equal(h.guard.kind, 'preview'); assert.deepEqual(h.db.company, initial.company); assert.deepEqual(h.db.sessions, initial.sessions); assert.deepEqual(h.db.assignments, initial.assignments); assert.equal(h.db.rolePolicyAudit[0].kind, 'previewed');
  assert.deepEqual(preview.data.changedFamilies, ['notes']); const foreman = preview.data.impact.accounts.find(row => row.accountId === 5); assert.equal(foreman.changes.length, 0); assert.deepEqual(foreman.notesProjectsBefore, [101, 102]); assert.deepEqual(foreman.notesProjectsAfter, [101]); const owner = preview.data.impact.accounts.find(row => row.accountId === 1); assert.deepEqual(owner.before, owner.after);
  const same = await h.call('POST', root + '/preview', input); assert.deepEqual(same.data, preview.data); assert.equal(h.writes, 1); assert.equal((await h.call('POST', root + '/preview', { ...input, reason: 'Changed input' })).status, 409);
  const commit = confirm(preview.data); assert.equal((await h.call('POST', root + '/confirm', { ...commit, confirmed: false })).status, 400);
  const saved = await h.call('POST', root + '/confirm', commit); assert.equal(saved.status, 200); assert.equal(saved.data.policyRevision, 1); assert.equal(h.guard.kind, 'confirm'); assert.equal(h.db.rolePolicyReceipts.length, 1); assert.equal(h.db.rolePolicyAudit.length, 2); assert.ok(!Object.hasOwn(h.db.company, 'schedulingRolePolicy')); assert.ok(!Object.hasOwn(h.db.company, 'timeReviewRolePolicy')); assert.equal(h.db.company.notesRolePolicy.revision, 1); assert.equal(h.db.company.notesPolicyRequired, true); assert.deepEqual(h.db.users, initial.users); assert.deepEqual(h.db.sessions, initial.sessions);
  const beforeReplay = structuredClone(h.db); const replay = await h.call('POST', root + '/confirm', commit); assert.deepEqual(replay.data, saved.data); assert.deepEqual(h.db, beforeReplay); assert.equal(h.writes, 2);
  h.db.syntheticUnrelated = true; h.bump(); assert.equal((await h.call('POST', root + '/confirm', commit)).status, 200); assert.equal(h.writes, 2, 'Unrelated tenant revisions do not duplicate a committed save');
  assert.equal((await h.call('POST', root + '/confirm', { ...commit, requestId: crypto.randomUUID() })).status, 409);
  const historical = await h.call('GET', root + '/audit'); assert.equal(historical.data.entries.length, 2); assert.ok(!JSON.stringify(historical.data).includes('sessionHash'));
  h.db.company.notesRolePolicy.roles.field.create = true; h.bump(); assert.equal((await h.call('POST', root + '/confirm', commit)).status, 409, 'Later policy effects cannot replay stale confirmation');
  const q = harness(); outbox.enqueue(q.db, { user: q.db.users[1], session: q.db.sessions[1] }, q.db.assignments, new Date().toISOString()); const queueBefore = structuredClone(q.db.assignmentEmailOutbox); const queueRows = defaults(); queueRows.scheduling.project_manager.create = false;
  const queuedPreview = await q.call('POST', root + '/preview', proposal(q, queueRows)); assert.equal(queuedPreview.status, 200); assert.deepEqual(queuedPreview.data.impact.queuedAssignmentEmails.newlyIneligibleIds.sort(), queueBefore.map(row => row.id).sort()); assert.deepEqual(q.db.assignmentEmailOutbox, queueBefore); await q.call('POST', root + '/confirm', confirm(queuedPreview.data)); assert.deepEqual(q.db.assignmentEmailOutbox, queueBefore);
  const existing = harness(); existing.db.company.schedulingRolePolicy = { version: 1, revision: 17, roles: defaults().scheduling }; existing.db.company.schedulingPolicyRequired = false; const plan = api.plan(existing.db, rows); assert.deepEqual(plan.after.company.schedulingRolePolicy, existing.db.company.schedulingRolePolicy); assert.equal(plan.after.company.schedulingPolicyRequired, false);
  for (const invalid of [false, 0, '', null]) { const corrupt = harness(); corrupt.db.rolePolicyPreviews = invalid; assert.equal((await corrupt.call('GET', root)).status, 409); assert.equal(corrupt.writes, 0); }
  const malicious = harness(), p = await malicious.call('POST', root + '/preview', proposal(malicious, rows)); malicious.db.rolePolicyPreviews[0].private = { tokenHash: 'Private sentinel' }; assert.equal((await malicious.call('POST', root + '/confirm', confirm(p.data))).status, 409);
  const expire = harness(), expires = await expire.call('POST', root + '/preview', proposal(expire, rows)); expire.advance(api.TTL); assert.equal((await expire.call('POST', root + '/confirm', confirm(expires.data))).status, 409); assert.equal(expire.writes, 1);
  const source = harness(), stale = await source.call('POST', root + '/preview', proposal(source, rows)); source.db.users[1].projectIds = [102]; source.bump(); assert.equal((await source.call('POST', root + '/confirm', confirm(stale.data))).status, 409);
  const denied = harness(); denied.fence(401); assert.equal((await denied.call('POST', root + '/preview', proposal(denied, rows))).status, 401); assert.equal(denied.writes, 0);
  const profile = harness(); profile.db.users[1].notesCustomRoleId = 'unreconciled'; assert.equal((await profile.call('POST', root + '/preview', proposal(profile, rows))).status, 409); assert.equal(profile.writes, 0);
  const unresolved = harness(); unresolved.db.users[1].projectIds.push(999999); assert.equal((await unresolved.call('POST', root + '/preview', proposal(unresolved, rows))).status, 409);
  assert.throws(() => api.validateCommitGuard({ kind: 'confirm', actorId: 1, sessionHash: 'a'.repeat(64), previewId: crypto.randomUUID(), version: 'b'.repeat(64), requestId: crypto.randomUUID(), authorizedUntil: {} }), { statusCode: 409 });
  // Valid retained history near the byte limit must reserve the future receipt
  // and audit before issuing another preview; no authority/history is pruned.
  const capacity = harness(), capacityPreview = await capacity.call('POST', root + '/preview', proposal(capacity, rows));
  const seed = structuredClone(capacity.db), proofTemplate = seed.rolePolicyPreviews[0], auditTemplate = seed.rolePolicyAudit[0];
  await capacity.call('POST', root + '/confirm', confirm(capacityPreview.data));
  const confirmationBytes = api.controlBytes(capacity.db) - api.controlBytes(seed) + 2 * (128 - 36);
  capacity.db = structuredClone(seed); capacity.db.rolePolicyPreviews = []; capacity.db.rolePolicyReceipts = []; capacity.db.rolePolicyAudit = [];
  const pairBytes = api.controlBytes(seed) - api.controlBytes(capacity.db), target = api.LEDGER_BYTES - pairBytes - confirmationBytes + 1;
  while (api.controlBytes(capacity.db) + pairBytes < target) {
    const proof = structuredClone(proofTemplate), audit = structuredClone(auditTemplate); proof.id = crypto.randomUUID();
    proof.inputHash = canonicalHash({ requestId: proof.id, expectedRevision: proof.expectedRevision - 1, reason: proof.reason, policies: proof.policies });
    proof.version = canonicalHash(Object.fromEntries(Object.entries(proof).filter(([key]) => key !== 'version')));
    audit.id = crypto.randomUUID(); audit.previewId = proof.id; audit.requestId = proof.id;
    capacity.db.rolePolicyPreviews.push(proof); capacity.db.rolePolicyAudit.push(audit);
  }
  let padding = target - api.controlBytes(capacity.db); const last = capacity.db.rolePolicyPreviews.at(-1);
  for (const account of last.impact.accounts) { const added = Math.min(padding, 5000 - account.name.length); account.name += 'x'.repeat(added); padding -= added; }
  assert.equal(padding, 0); last.version = canonicalHash(Object.fromEntries(Object.entries(last).filter(([key]) => key !== 'version'))); capacity.db.rolePolicyAudit.at(-1).impactHash = canonicalHash(last.impact);
  api.ledger(capacity.db); assert.equal(api.controlBytes(capacity.db), target); const retained = structuredClone(capacity.db), priorWrites = capacity.writes;
  assert.equal((await capacity.call('POST', root + '/preview', proposal(capacity, rows))).status, 409); assert.equal(capacity.writes, priorWrites); assert.deepEqual(capacity.db, retained);
  const padded = last.impact.accounts.find(account => account.name.length > 512); padded.name = padded.name.slice(0, -512);
  last.version = canonicalHash(Object.fromEntries(Object.entries(last).filter(([key]) => key !== 'version'))); capacity.db.rolePolicyAudit.at(-1).impactHash = canonicalHash(last.impact);
  const fits = await capacity.call('POST', root + '/preview', proposal(capacity, rows)); assert.equal(fits.status, 200); assert.equal((await capacity.call('POST', root + '/confirm', confirm(fits.data))).status, 200); api.ledger(capacity.db); assert.ok(api.controlBytes(capacity.db) <= api.LEDGER_BYTES);
  console.log('Durable role-policy unit passed: closed six-family inputs, exact absent defaults/family revisions/immutable owner, full32 and real notes-project impacts, queued cancellation metadata with unchanged payloads, preview/confirm idempotency, unrelated-revision recovery/current-effect replay, closed historical ledgers, expiry/source revocation/reconciliation and guarded complete deltas.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
