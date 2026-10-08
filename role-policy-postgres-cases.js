'use strict';
// Called only by the fresh disposable localhost PostgreSQL fixture.
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { companyA, companyB, fixture, token } = require('./fixtures/project-assistant');
const registry = require('./capability-registry'), api = require('./role-policy-api');
const outbox = require('./assignment-email-outbox');
const { splitSnapshot, canonicalHash } = require('./database/transactional-repository');
module.exports = async function ({ repository, change, request, slowRequest, bases, startWorker, checkpoint, waitFor, controls, providerEvents, pool }) {
  const load = () => repository.load(companyA), foreign = await repository.load(companyB), providers = providerEvents.length;
  const root = api.ROOT, id = () => crypto.randomUUID(), copy = value => structuredClone(value);
  const call = async (method, route, input, user = 1, expected = 200, worker = 0) => {
    const result = await request(bases[worker], method, route, input, user);
    assert.equal(result.status, expected, method + ' ' + route + ': ' + JSON.stringify(result.data)); return result;
  };
  await change(db => {
    const clean = fixture(), excluded = db.users.filter(row => [8, 9].includes(row.id));
    clean.users.push(...excluded.map(row => ({ id: row.id, companyId: companyA, name: 'Synthetic excluded role', email: 'excluded' + row.id + '@example.invalid', role: row.role, status: 'Active', projectIds: [101], assignedCrews: ['A'], permissions: { scheduleCrews: true, aiAssistant: true, manageRoles: true } })));
    clean.sessions.push(...excluded.map(row => ({ userId: row.id, companyId: companyA, tokenHash: crypto.createHash('sha256').update(token(companyA, row.id)).digest('hex'), expiresAt: '2099-01-01T00:00:00Z' })));
    clean.company.features.timeCards = true;
    clean.users.find(row => row.id === 2).permissions = { scheduleCrews: true, viewTime: true, manageTime: true, viewDailies: true, approveDailies: true };
    clean.reports = [{ id: 9101, project: 0, foreman: clean.team[0].name, laborEntries: [{ memberId: 11, hours: 1 }] }, { id: 9102, project: 1, foreman: clean.team[0].name, laborEntries: [{ memberId: 12, hours: 1 }] }];
    clean.assignments = [{ id: 9001, projectId: 101, memberIds: [11], date: '2098-10-12', start: '08:00', end: '16:00', activity: 'Synthetic assignment', notifications: { 11: { emailStatus: 'queued' } } }];
    clean.timeCards = [{ id: 9201, memberId: 11, projectId: 101, date: '2026-01-05', inAt: '2026-01-05T08:00:00Z', outAt: '2026-01-05T16:00:00Z', hours: 7.25, status: 'submitted', submittedAt: '2026-01-06', submittedBy: 'Synthetic field', breaks: [{ type: 'unpaid_meal', startedAt: '2026-01-05T12:00:00Z', endedAt: '2026-01-05T12:45:00Z' }], history: [] }];
    for (const key of Object.keys(db)) delete db[key]; Object.assign(db, clean);
  });
  const baseline = copy((await load()).snapshot);
  const restore = async () => change(db => { for (const key of Object.keys(db)) delete db[key]; Object.assign(db, copy(baseline)); });
  const input = async (mutate = rows => { rows.notes.field.create = false; }) => {
    const state = (await call('GET', root)).data, policies = copy(state.defaults);
    for (const [family] of registry.families) if (state.policies[family]) policies[family] = copy(state.policies[family].roles);
    mutate(policies); return { requestId: id(), expectedRevision: state.tenantRevision, reason: 'Synthetic reviewed role-policy change', policies };
  };
  const preview = async (mutate, worker = 0) => call('POST', root + '/preview', await input(mutate), 1, 200, worker);
  const confirmBody = result => ({ previewId: result.data.previewId, version: result.data.version, requestId: id(), confirmed: true });
  const confirm = async result => call('POST', root + '/confirm', confirmBody(result));
  const withoutControls = db => Object.fromEntries(Object.entries(db).filter(([key]) => !['rolePolicyPreviews', 'rolePolicyReceipts', 'rolePolicyAudit'].includes(key)));
  const gate = filter => { controls.gate = checkpoint(); controls.gate.expected = 99; controls.commitFilter = filter || null; return controls.gate; };
  const release = () => { controls.gate.resolve(); controls.gate = null; controls.commitFilter = null; };
  const isPolicy = url => url.pathname.endsWith('replace_tenant_policy_records');

  let before = await load(); const defaults = await call('GET', root);
  assert.equal(defaults.data.uiAvailable, false); assert.equal(defaults.data.policyRevision, 0); assert.deepEqual(await load(), before);
  await call('GET', root + '/audit'); assert.deepEqual(await load(), before);
  for (const user of [2, 4, 5, 7, 8, 9]) for (const [method, route, body] of [['GET', root], ['GET', root + '/audit'], ['POST', root + '/preview', {}], ['POST', root + '/confirm', {}]]) await call(method, route, body, user, 403);
  assert.equal((await request(bases[0], 'GET', root, undefined, 1, companyB)).status, 401);
  assert.equal((await request(bases[1], 'GET', root, undefined, 1, companyB, companyB)).status, 200);
  await call('POST', root + '/preview', await input(() => {}), 1, 400);
  for (const mutate of [rows => { rows.notes.owner = { view: false }; }, rows => { rows.notes.field.aiAssistant = true; }, rows => { rows.scheduling.admin.manageRoles = true; }, rows => { rows.timeWrite.admin.billing = true; }]) await call('POST', root + '/preview', await input(mutate), 1, 400);
  assert.deepEqual(await load(), before);

  const proposed = await input(), reviewed = await call('POST', root + '/preview', proposed), staged = await load();
  assert.equal(staged.revision, before.revision + 1); assert.deepEqual(withoutControls(staged.snapshot), before.snapshot);
  assert.deepEqual(reviewed.data.changedFamilies, ['notes']);
  const foreman = reviewed.data.impact.accounts.find(row => row.accountId === 5);
  assert.deepEqual(foreman.changes, []); assert.deepEqual(foreman.notesProjectsBefore, [101, 102]); assert.deepEqual(foreman.notesProjectsAfter, [101]);
  assert.equal((await call('POST', root + '/preview', proposed, 1, 200, 1)).data.version, reviewed.data.version); assert.deepEqual(await load(), staged);
  await call('POST', root + '/preview', { ...proposed, reason: 'Different input' }, 1, 409);
  await call('POST', root + '/confirm', { ...confirmBody(reviewed), confirmed: false }, 1, 400);
  const savedInput = confirmBody(reviewed), saved = await call('POST', root + '/confirm', savedInput), committed = await load();
  assert.equal(saved.data.committed, true); assert.equal(committed.snapshot.company.rolePolicyRevision, 1);
  assert.equal(committed.snapshot.company.notesRolePolicy.roles.field.create, false);
  for (const [, , prefix] of registry.families.filter(row => row[0] !== 'notes')) assert.equal(Object.hasOwn(committed.snapshot.company, prefix + 'RolePolicy'), false);
  api.validateDelta(staged.snapshot, committed.snapshot, 'confirm', ['notes']);
  await call('POST', root + '/confirm', savedInput, 1, 200, 1); assert.deepEqual(await load(), committed);
  await call('POST', root + '/confirm', { ...savedInput, requestId: id() }, 1, 409);
  await call('GET', '/api/projects/102/notes-todos', undefined, 5, 404);
  await call('POST', '/api/projects/101/notes-todos', { kind: 'note', text: 'Denied by saved role policy', requestId: id() }, 4, 403);
  await call('GET', '/api/projects/101/assistant/context', undefined, 4, 403);
  const me = await call('GET', '/api/auth/me', undefined, 4); assert.equal(me.data.notesPermissions.create, false); assert.equal(me.data.immutableAccess.assistantEligible, false);
  await change(db => { db.syntheticUnrelatedRevision = 'Committed after save'; });
  before = await load(); assert.deepEqual((await call('POST', root + '/confirm', savedInput)).data, saved.data); assert.deepEqual(await load(), before);
  const alternateToken = 'synthetic-policy-alternate-owner-session', originalSessions = copy(before.snapshot.sessions);
  await change(db => { db.sessions.push({ userId: 1, companyId: companyA, tokenHash: crypto.createHash('sha256').update(alternateToken).digest('hex'), expiresAt: '2099-01-01T00:00:00Z' }); });
  assert.equal((await request(bases[1], 'POST', root + '/confirm', savedInput, 1, companyA, companyA, alternateToken)).status, 409);
  assert.equal((await request(bases[1], 'POST', root + '/confirm', savedInput, 1, companyB, companyB)).status, 409);
  await change(db => { db.sessions = db.sessions.filter(row => row.tokenHash !== originalSessions.find(session => session.userId === 1).tokenHash); });
  await call('POST', root + '/confirm', savedInput, 1, 401); await change(db => { db.sessions = originalSessions; }); await call('POST', root + '/confirm', savedInput);
  const next = await preview(rows => { rows.notes.field.create = true; }); await confirm(next);
  await call('POST', root + '/confirm', savedInput, 1, 409);
  const audit = (await call('GET', root + '/audit')).data; assert.equal(audit.total, 4); assert.ok(!JSON.stringify(audit).includes('sessionHash')); assert.ok(!JSON.stringify(audit).includes('sourceHash'));
  console.log('Policy PostgreSQL: owner-only closed defaults, actual notes scope impact, private preview, explicit commit, fresh enforcement, finite audit and exact receipt recovery passed.');

  // A request ID is durable through rejected and uncertain SQL outcomes and a new worker.
  await restore(); let values = await input(); before = await load(); controls.rejectCommit = true;
  await call('POST', root + '/preview', values, 1, 503); controls.rejectCommit = false; assert.deepEqual(await load(), before);
  controls.dropAck = true; const lostPreview = await call('POST', root + '/preview', values, 1, 503); controls.dropAck = false;
  assert.equal(lostPreview.data.code, 'COMMIT_OUTCOME_UNKNOWN'); before = await load();
  const recovered = await call('POST', root + '/preview', values, 1, 200, 1); assert.equal(recovered.data.previewId, values.requestId); assert.deepEqual(await load(), before);
  const restarted = await startWorker(), recoveryConfirm = confirmBody(recovered);
  controls.rejectCommit = true; await call('POST', root + '/confirm', recoveryConfirm, 1, 503); controls.rejectCommit = false; assert.deepEqual(await load(), before);
  controls.dropAck = true; const lostConfirm = await request(restarted, 'POST', root + '/confirm', recoveryConfirm); controls.dropAck = false;
  assert.equal(lostConfirm.status, 503); assert.equal(lostConfirm.data.code, 'COMMIT_OUTCOME_UNKNOWN'); before = await load();
  const replay = await request(restarted, 'POST', root + '/confirm', recoveryConfirm); assert.equal(replay.status, 200); assert.equal(replay.data.committed, true); assert.deepEqual(await load(), before);
  assert.equal(before.snapshot.rolePolicyReceipts.length, 1); assert.equal(before.snapshot.rolePolicyAudit.length, 2);

  await restore(); values = await input(); before = await load(); let barrier = gate();
  const contenders = [values, { ...values, requestId: id() }], pending = contenders.map((body, worker) => request(bases[worker], 'POST', root + '/preview', body));
  await waitFor(() => barrier.count === 2); release(); const results = await Promise.all(pending);
  assert.deepEqual(results.map(row => row.status).sort(), [200, 409]); assert.equal((await load()).revision, before.revision + 1);
  let winner = results.findIndex(row => row.status === 200); const first = results[winner];
  barrier = gate(); const confirmations = [confirmBody(first), confirmBody(first)], confirmPending = confirmations.map((body, worker) => request(bases[worker], 'POST', root + '/confirm', body));
  await waitFor(() => barrier.count === 2); release(); const confirms = await Promise.all(confirmPending);
  assert.deepEqual(confirms.map(row => row.status).sort(), [200, 409]); winner = confirms.findIndex(row => row.status === 200);
  before = await load(); await call('POST', root + '/confirm', confirmations[winner]); assert.deepEqual(await load(), before); assert.equal(before.snapshot.rolePolicyReceipts.length, 1);
  await restore(); const stale = await preview(), fresh = await preview(); await call('POST', root + '/confirm', confirmBody(stale), 1, 409); await confirm(fresh);

  // Persisted private history is closed; raw corrupt fields cannot become DTOs.
  before = await load(); await assert.rejects(change(db => { db.rolePolicyPreviews.push(copy(db.rolePolicyPreviews[0])); }), /duplicate key/); assert.deepEqual(await load(), before);
  for (const corrupt of [db => { db.rolePolicyPreviews = false; }, db => { db.rolePolicyReceipts = null; }, db => { db.rolePolicyAudit = 0; }, db => { db.rolePolicyPreviews[0].private = 'PRIVATE-POLICY-SENTINEL'; }, db => { db.rolePolicyPreviews[0].companyId = companyB; }, db => { db.rolePolicyPreviews[0].impact.accounts[0].after.notes.secret = 'PRIVATE-POLICY-SENTINEL'; }, db => { db.rolePolicyReceipts[0].inputHash = 'a'.repeat(64); }, db => { db.rolePolicyAudit[0].at = new Date(0).toISOString(); }]) {
    const intact = copy((await load()).snapshot); await change(corrupt); before = await load();
    const denied = await call('GET', root, undefined, 1, 409); assert.ok(!JSON.stringify(denied.data).includes('PRIVATE-POLICY-SENTINEL')); assert.deepEqual(await load(), before);
    await change(db => { for (const key of Object.keys(db)) delete db[key]; Object.assign(db, intact); });
  }
  await restore(); values = await input(); await change(db => { db.users.find(row => row.id === 4).notesCustomRoleId = 'custom-profile'; });
  values.expectedRevision = (await load()).revision; before = await load(); await call('POST', root + '/preview', values, 1, 409); assert.deepEqual(await load(), before);
  await restore(); values = await input(); await change(db => { db.users.find(row => row.id === 2).projectIds.push(999999); });
  values.expectedRevision = (await load()).revision; before = await load(); await call('POST', root + '/preview', values, 1, 409); assert.deepEqual(await load(), before);
  console.log('Policy PostgreSQL: rejected/lost acknowledgments, durable cross-worker recovery, competing previews/confirms, stale proofs and malformed history/profile/scope rejection passed.');

  // Previously buffered scheduling/leave/time-review responses use the fresh fence.
  const leaveInput = { startDate: '2098-11-12', endDate: '2098-11-12', allDay: false, startTime: '09:00', endTime: '10:00', type: 'sick', note: 'PRIVATE-POLICY-LEAVE', requestId: id() };
  for (const test of [
    { route: '/api/assignments', user: 2, mutate: rows => { rows.scheduling.project_manager = Object.fromEntries(Object.keys(rows.scheduling.project_manager).map(key => [key, false])); } },
    { route: '/api/time-off-requests', user: 4, mutate: rows => { rows.timeOff.field = { viewRequests: false, createRequest: false }; } },
    { route: '/api/time-cards', user: 2, mutate: rows => { rows.timeReview.project_manager = Object.fromEntries(Object.keys(rows.timeReview.project_manager).map(key => [key, false])); } },
    { route: '/api/time-off-requests', method: 'POST', input: leaveInput, user: 4, mutate: rows => { rows.timeOff.field.createRequest = false; }, prepare: () => call('POST', '/api/time-off-requests', leaveInput, 4, 201) },
    { route: '/api/time-cards/review-preview', method: 'POST', input: { ids: [9201], decision: 'approve' }, user: 2, mutate: rows => { rows.timeReview.project_manager.approveCards = false; } }
  ]) {
    await restore(); if (test.prepare) await test.prepare(); const proof = await preview(test.mutate);
    controls.readGate = checkpoint(); const response = request(bases[0], test.method || 'GET', test.route, test.input, test.user);
    await waitFor(() => controls.readGate.count === 3); await call('POST', root + '/confirm', confirmBody(proof), 1, 200, 1);
    before = await load(); controls.readGate.resolve(); const denied = await response; controls.readGate = null;
    assert.equal(denied.status, 409, test.route); assert.ok(!JSON.stringify(denied.data).includes('PRIVATE-POLICY-LEAVE')); assert.deepEqual(await load(), before);
  }
  for (const [route, user] of [['/api/assignments', 2], ['/api/time-off-requests', 4], ['/api/time-cards', 2]]) {
    await restore(); const ends = Date.now() + 2000; await change(db => { db.sessions.find(row => row.userId === user).expiresAt = new Date(ends).toISOString(); });
    before = await load(); controls.readGate = checkpoint(); const response = request(bases[0], 'GET', route, undefined, user);
    await waitFor(() => controls.readGate.count === 3); await waitFor(() => Date.now() >= ends); controls.readGate.resolve(); assert.equal((await response).status, 401); controls.readGate = null; assert.deepEqual(await load(), before);
  }
  await restore(); values = await input(); const slow = await slowRequest(bases[0], 1, values, root + '/preview');
  await change(db => { db.users.find(row => row.id === 1).role = 'admin'; }); slow.done(); assert.ok([403, 409].includes((await slow.result).status));
  await restore(); const revokeProof = await preview(); barrier = gate(); const revokePending = request(bases[0], 'POST', root + '/confirm', confirmBody(revokeProof));
  await waitFor(() => barrier.count === 1); await change(db => { db.users.find(row => row.id === 1).status = 'Deactivated'; }); before = await load(); release(); assert.equal((await revokePending).status, 409); assert.deepEqual(await load(), before);

  // Guarded SQL checks natural session/trial expiry at admission and after row replacement.
  for (const kind of ['session', 'trial']) {
    await restore(); const ends = Date.now() + 2500;
    await change(db => { if (kind === 'session') db.sessions.find(row => row.userId === 1).expiresAt = new Date(ends).toISOString(); else { db.company.demo = false; db.company.billingExempt = false; db.company.trialEndsAt = new Date(ends).toISOString(); delete db.company.subscriptionStatus; } });
    const proof = await preview(); before = await load(); barrier = gate(); const response = request(bases[0], 'POST', root + '/confirm', confirmBody(proof));
    await waitFor(() => barrier.count === 1); await waitFor(() => Date.now() >= ends); release(); assert.equal((await response).status, 409, kind); assert.deepEqual(await load(), before);
  }
  await pool.query("CREATE FUNCTION pdl_synthetic_policy_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2.5); RETURN NEW; END $$");
  await pool.query("CREATE TRIGGER pdl_synthetic_policy_delay AFTER INSERT ON tenant_records FOR EACH ROW WHEN (NEW.company_id='21c12cd3-4822-4b1e-94e8-beca44efc0b7'::uuid AND NEW.collection='rolePolicyReceipts') EXECUTE FUNCTION pdl_synthetic_policy_delay()");
  try {
    await restore(); const ends = Date.now() + 2000; await change(db => { db.sessions.find(row => row.userId === 1).expiresAt = new Date(ends).toISOString(); });
    const proof = await preview(); before = await load(); await call('POST', root + '/confirm', confirmBody(proof), 1, 409); assert.deepEqual(await load(), before, 'Expiry after full replacement rolls back policy, receipt, audit and revision');
  } finally { await pool.query('DROP TRIGGER pdl_synthetic_policy_delay ON tenant_records'); await pool.query('DROP FUNCTION pdl_synthetic_policy_delay()'); }

  // Direct service SQL discriminators isolate nullable fields and post-copy authority.
  await restore(); const sqlProof = await preview(), loaded = await load(), proofRow = loaded.snapshot.rolePolicyPreviews[0];
  const candidate = copy(loaded.snapshot); candidate.company = api.plan(loaded.snapshot, proofRow.policies).after.company;
  const receiptId = id(); candidate.rolePolicyReceipts = [{ id: receiptId, previewId: proofRow.id, companyId: companyA, actorId: 1, sessionHash: proofRow.sessionHash, version: proofRow.version }];
  const guard = { kind: 'confirm', actorId: 1, sessionHash: proofRow.sessionHash, previewId: proofRow.id, version: proofRow.version, requestId: receiptId, authorizedUntil: new Date(proofRow.expiresAt).toISOString() };
  const direct = async (snapshot = candidate) => {
    const packed = splitSnapshot(snapshot), records = packed.records.map(row => ({ collection: row.collection, record_key: row.recordKey, position: row.position, data: row.data }));
    return pool.query('SELECT * FROM replace_tenant_policy_records($1,$2,$3,$4,$5,$6)', [companyA, loaded.revision, packed.scalarData, canonicalHash(snapshot), JSON.stringify(records), guard]);
  };
  for (const [collection, key, malformed] of [['sessions', 'expiresAt', null], ['sessions', 'expiresAt', undefined], ['sessions', 'expiresAt', 'infinity'], ['rolePolicyPreviews', 'expiresAt', null], ['rolePolicyPreviews', 'expectedRevision', null], ['rolePolicyPreviews', 'expectedRevision', undefined]]) {
    const selector = collection === 'sessions' ? "data->>'tokenHash'=$2" : "data->>'id'=$2", identity = collection === 'sessions' ? proofRow.sessionHash : proofRow.id;
    const original = (await pool.query('SELECT data FROM tenant_records WHERE company_id=$1 AND collection=$3 AND ' + selector, [companyA, identity, collection])).rows[0].data;
    const corrupted = copy(original); if (malformed === undefined) delete corrupted[key]; else corrupted[key] = malformed;
    await pool.query('UPDATE tenant_records SET data=$4 WHERE company_id=$1 AND collection=$3 AND ' + selector, [companyA, identity, collection, corrupted]);
    try { await assert.rejects(direct(), /PDL_POLICY_(AUTHORIZATION|GUARD)/); assert.equal((await pool.query('SELECT revision FROM tenant_revisions WHERE company_id=$1', [companyA])).rows[0].revision, String(loaded.revision)); }
    finally { await pool.query('UPDATE tenant_records SET data=$4 WHERE company_id=$1 AND collection=$3 AND ' + selector, [companyA, identity, collection, original]); }
  }
  for (const mutate of [db => { db.sessions.find(row => row.userId === 1).expiresAt = null; }, db => { db.rolePolicyPreviews[0].expiresAt = null; }, db => { db.rolePolicyPreviews[0].expectedRevision = null; }, db => { db.users.find(row => row.id === 1).role = 'admin'; }]) {
    const corrupt = copy(candidate); mutate(corrupt); await assert.rejects(direct(corrupt), /PDL_POLICY_(AUTHORIZATION|GUARD)/); assert.deepEqual(await load(), loaded);
  }
  for (const role of ['anon', 'authenticated']) { const client = await pool.connect(); try { await client.query('SET ROLE ' + role); await assert.rejects(client.query('SELECT * FROM replace_tenant_policy_records($1,$2,$3,$4,$5,$6)', [companyA, loaded.revision, {}, 'a'.repeat(64), '[]', guard]), /permission denied/); } finally { await client.query('RESET ROLE'); client.release(); } }
  // Expired application proof uses a coherent finite synthetic history; no ten-minute sleep.
  await restore(); const expiring = await preview(); await change(db => {
    const proof = db.rolePolicyPreviews[0], ends = Date.now() - 1; proof.createdAt = new Date(ends - api.TTL).toISOString(); proof.expiresAt = ends; proof.expectedRevision++;
    proof.inputHash = canonicalHash({ requestId: proof.id, expectedRevision: proof.expectedRevision - 1, reason: proof.reason, policies: proof.policies });
    proof.version = canonicalHash(Object.fromEntries(Object.entries(proof).filter(([key]) => key !== 'version'))); db.rolePolicyAudit[0].at = proof.createdAt;
  }); before = await load(); expiring.data.version = before.snapshot.rolePolicyPreviews[0].version; await call('POST', root + '/confirm', confirmBody(expiring), 1, 409); assert.deepEqual(await load(), before);
  console.log('Policy PostgreSQL: stale buffered reads/replays, slow-body/live-owner revocation, natural session/trial/proof expiry, SQL NULL/finite fields and post-replacement rollback passed.');

  // API review/preview/confirmation must never wake the assignment transport.
  await restore(); await change(db => { outbox.enqueue(db, { user: db.users.find(row => row.id === 2), session: db.sessions.find(row => row.userId === 2) }, [db.assignments[0]]); });
  const queued = copy((await load()).snapshot.assignmentEmailOutbox), enabled = await startWorker({ dispatch: true });
  values = await input(rows => { rows.scheduling.project_manager.create = false; });
  let response = await request(enabled, 'POST', root + '/preview', values); assert.equal(response.status, 200); assert.deepEqual(response.data.impact.queuedAssignmentEmails.newlyIneligibleIds, queued.map(row => row.id));
  await request(enabled, 'GET', root); await request(enabled, 'GET', root + '/audit');
  const enabledBody = confirmBody(response); response = await request(enabled, 'POST', root + '/confirm', enabledBody); assert.equal(response.status, 200); assert.equal((await request(enabled, 'POST', root + '/confirm', enabledBody)).status, 200);
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(providerEvents.length, providers); assert.deepEqual((await load()).snapshot.assignmentEmailOutbox, queued);
  assert.deepEqual((await load()).snapshot.assignments, baseline.assignments);

  // Both orderings of manual writes and a policy CAS are tested at admission.
  for (const kind of ['notes', 'scheduling']) for (const policyWins of [true, false]) {
    await restore(); const proof = await preview(rows => { rows[kind].project_manager.create = false; });
    const route = kind === 'notes' ? '/api/projects/101/notes-todos' : '/api/assignments';
    const body = kind === 'notes' ? { kind: 'note', text: 'Synthetic racing PM note', requestId: id() } : { projectId: 101, memberIds: [11], date: '2098-12-12', start: '08:00', end: '16:00', activity: 'Synthetic racing schedule', requestId: id() };
    barrier = gate(policyWins ? url => !isPolicy(url) : isPolicy);
    const blocked = policyWins ? request(bases[0], 'POST', route, body, 2) : request(bases[0], 'POST', root + '/confirm', confirmBody(proof));
    await waitFor(() => barrier.count === 1);
    if (policyWins) await call('POST', root + '/confirm', confirmBody(proof), 1, 200, 1); else await call('POST', route, body, 2, 201, 1);
    before = await load(); release(); assert.equal((await blocked).status, 409); assert.deepEqual(await load(), before);
    if (policyWins) await call('POST', route, body, 2, 403); else assert.equal(Object.hasOwn(before.snapshot.company, kind + 'RolePolicy'), false);
  }
  // A dispatch claim is a separate admitted action; policy requests send nothing.
  for (const policyWins of [true, false]) {
    await restore(); await change(db => { outbox.enqueue(db, { user: db.users.find(row => row.id === 2), session: db.sessions.find(row => row.userId === 2) }, [db.assignments[0]]); });
    const proof = await preview(rows => { rows.scheduling.project_manager.create = false; }), jobId = (await load()).snapshot.assignmentEmailOutbox[0].id;
    let sent = 0; const claim = checkpoint();
    const dispatcher = outbox.createDispatcher({ load: company => repository.load(company), commit: async (db, revision) => { if (policyWins && db.assignmentEmailOutbox.find(row => row.id === jobId)?.status === 'dispatching') { claim.count++; await claim.promise; } return repository.save(db, revision); }, accountAllowed: () => true, send: async () => { sent++; return { id: 'synthetic-policy-claim' }; } });
    if (policyWins) {
      const delivery = dispatcher.dispatch(companyA, jobId); await waitFor(() => claim.count === 1); await confirm(proof); claim.resolve(); await assert.rejects(delivery, { code: 'PDL_REVISION_CONFLICT' }); assert.equal(sent, 0);
      const freshDispatcher = outbox.createDispatcher({ load: company => repository.load(company), commit: (db, revision) => repository.save(db, revision), accountAllowed: () => true, send: async () => { sent++; return { id: 'synthetic-never-sent' }; } });
      assert.equal((await freshDispatcher.dispatch(companyA, jobId)).cancelled, true); assert.equal(sent, 0);
    } else {
      barrier = gate(isPolicy); const saving = request(bases[0], 'POST', root + '/confirm', confirmBody(proof)); await waitFor(() => barrier.count === 1);
      assert.equal((await dispatcher.dispatch(companyA, jobId)).dispatched, true); assert.equal(sent, 1); before = await load(); release(); assert.equal((await saving).status, 409); assert.deepEqual(await load(), before); assert.equal(Object.hasOwn(before.snapshot.company, 'schedulingRolePolicy'), false);
    }
  }
  await restore(); assert.deepEqual(await repository.load(companyB), foreign); assert.equal(providerEvents.length, providers);
  console.log('Policy PostgreSQL: suppressed transport, finite queued-email impacts, both PM note/schedule commit orders and both dispatch-claim commit orders passed; foreign tenant unchanged.');
};
