'use strict';
// This module is called only after the guarded disposable PostgreSQL fixture.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { companyA, companyB, token } = require('./fixtures/project-assistant');
const access = require('./time-review-access');
const outbox = require('./assignment-email-outbox');
const { canonicalHash } = require('./database/transactional-repository');
module.exports = async function runTimeReviewCases({ repository, change, request, slowRequest, bases, checkpoint, waitFor, controls, providerEvents }) {
  const load = () => repository.load(companyA), cardPreview = '/api/time-cards/review-preview';
  const policy = () => ({ version: 1, revision: 1, roles: Object.fromEntries(access.roles.map(role => [role, access.ceiling(role)])) });
  const card = (id = 501, memberId = 11, projectId = 101, date = '2026-01-05') => ({ id, memberId, projectId, date, inAt: date + 'T08:00:00Z', outAt: date + 'T16:00:00Z', hours: 7.25, status: 'submitted', submittedAt: '2026-01-06', submittedBy: 'Synthetic field', breaks: [{ type: 'unpaid_meal', startedAt: date + 'T12:00:00Z', endedAt: date + 'T12:45:00Z' }], history: [] });
  const leave = (id = 'synthetic-review-leave', date = '2098-12-01') => ({ id, memberId: 11, startDate: date, endDate: date, allDay: false, startTime: '09:00', endTime: '10:00', type: 'sick', note: 'PRIVATE-LEAVE', status: 'pending', history: [] });
  const leavePath = id => '/api/time-off-requests/' + id;
  const confirmation = preview => ({ token: preview.data.token, version: preview.data.version, confirmed: true, requestId: crypto.randomUUID() });
  const previewLeave = async (worker = 0, id = 'synthetic-review-leave', decision = 'approve', user = 2, note = 'Exact synthetic review') => {
    const result = await request(bases[worker], 'POST', leavePath(id) + '/review-preview', { decision, note }, user); assert.equal(result.status, 200, JSON.stringify(result.data)); return result;
  };
  const previewCards = async (worker = 0, ids = [501], decision = 'approve', user = 2) => {
    const result = await request(bases[worker], 'POST', cardPreview, { ids, decision }, user); assert.equal(result.status, 200, JSON.stringify(result.data)); return result;
  };
  const preservedOther = await repository.load(companyB), providerBefore = providerEvents.length;
  await change(db => {
    db.company.features.timeCards = true;
    Object.assign(db.users.find(row => row.id === 2), { role: 'project_manager', projectIds: [101], assignedCrews: ['A'], permissions: { manageTime: true, scheduleCrews: true } });
    db.users.find(row => row.id === 7).permissions = { manageTime: true };
    db.users.find(row => row.id === 5).email = 'user5@example.invalid';
    db.timeCards = [card(), card(502, 12, 101, '2026-01-06'), card(503, 13, 102, '2026-01-07')];
    db.timeOffRequests.push(leave(), { ...leave('synthetic-foreign-leave'), memberId: 13 });
    db.payPeriodExports = [{ id: 'synthetic-fixed-export', summary: { privateSentinel: 'Immutable fixed export', records: [{ id: 501, hours: 7.25 }] } }];
  });
  const preservedBusiness = db => canonicalHash({ assignments: db.assignments, workdays: db.workdays, reports: db.reports, exports: db.payPeriodExports });
  const initial = await load(), initialBusiness = preservedBusiness(initial.snapshot);
  const scopedRead = await request(bases[0], 'GET', '/api/time-cards', undefined, 2); assert.equal(scopedRead.status, 200); assert.deepEqual(scopedRead.data.map(row => row.id), [501, 502]);
  assert.deepEqual((await request(bases[0], 'GET', '/api/time-cards', undefined, 4)).data.map(row => row.id), [501]);
  assert.deepEqual((await request(bases[0], 'GET', '/api/time-cards', undefined, 5)).data.map(row => row.id), [501, 502]);
  assert.equal((await request(bases[0], 'GET', '/api/time-cards?memberId=12', undefined, 5)).status, 403);
  for (const user of [4, 5, 6, 8, 9]) for (const route of [cardPreview, leavePath('synthetic-review-leave') + '/review-preview']) {
    const input = route === cardPreview ? { ids: [501], decision: 'approve' } : { decision: 'approve', note: '' };
    assert.equal((await request(bases[0], 'POST', route, input, user)).status, 403);
  }
  assert.equal((await request(bases[0], 'POST', cardPreview, { ids: [503], decision: 'approve' }, 2)).status, 404);
  assert.equal((await request(bases[0], 'POST', leavePath('synthetic-foreign-leave') + '/review-preview', { decision: 'approve', note: '' }, 2)).status, 404);
  assert.equal((await request(bases[0], 'GET', '/api/time-cards', undefined, 2, companyB)).status, 401);
  const unsupportedBefore = await load();
  for (const [method, route] of [['POST', '/api/time-cards'], ['PATCH', '/api/time-cards/501'], ['DELETE', '/api/time-cards/501'], ['POST', '/api/time-cards/501/submit'], ['POST', '/api/time-cards/501/clock-out'], ['POST', '/api/time-cards/company-clock'], ['GET', '/api/time-cards.csv'], ['GET', '/api/report-labor-suggestions'], ['GET', '/api/pay-periods'], ['POST', '/api/pay-periods'], ['POST', '/api/company-activities']]) assert.equal((await request(bases[0], method, route, method === 'GET' ? undefined : {})).status, 503);
  assert.deepEqual(await load(), unsupportedBefore);
  const noWrites = await load(), pre = await previewCards(); assert.deepEqual(await load(), noWrites, 'Preview does not change a tenant revision or business row');
  const conf = confirmation(pre);
  assert.equal((await request(bases[1], 'POST', '/api/time-cards/501/approve', conf, 2)).status, 409, 'First confirmation on another worker requires that worker to produce a fresh preview');
  assert.deepEqual(await load(), noWrites);
  const targetPreview = await previewCards(1); assert.equal(targetPreview.status, 200); assert.deepEqual(await load(), noWrites);
  for (const extra of [{ confirmed: false }, { hours: 100 }, { token: conf.token.slice(0, -1) + 'x' }, { requestId: '' }]) assert.ok([400, 409].includes((await request(bases[0], 'POST', '/api/time-cards/501/approve', { ...conf, ...extra }, 2)).status));
  assert.deepEqual(await load(), noWrites);

  // Both previews bind one tenant revision; opposite decisions have one winner.
  const opposite = [await previewLeave(0), await previewLeave(1, 'synthetic-review-leave', 'decline')], inputs = opposite.map(confirmation);
  controls.gate = checkpoint(); controls.gate.expected = 99;
  const pending = inputs.map((input, index) => request(bases[index], 'POST', leavePath('synthetic-review-leave') + '/' + (index ? 'decline' : 'approve'), input, 2));
  await waitFor(() => controls.gate.count === 2); assert.deepEqual(await load(), noWrites);
  controls.gate.resolve(); const decisions = await Promise.all(pending); controls.gate = null;
  assert.deepEqual(decisions.map(row => row.status).sort(), [200, 409]);
  const winner = decisions.findIndex(row => row.status === 200), decision = winner ? 'decline' : 'approve', afterDecision = await load();
  assert.equal(afterDecision.revision, noWrites.revision + 1); assert.equal(afterDecision.snapshot.timeReviewReceipts.length, 1); assert.equal(afterDecision.snapshot.auditLog.filter(row => row.type === 'time_off_reviewed').length, 1);
  assert.equal(preservedBusiness(afterDecision.snapshot), initialBusiness);
  const replayPath = leavePath('synthetic-review-leave') + '/' + decision;
  assert.equal((await request(bases[1 - winner], 'POST', replayPath, inputs[winner], 2)).status, 200, 'Durable replay works across worker preview keys'); assert.deepEqual(await load(), afterDecision);
  assert.equal((await request(bases[0], 'POST', replayPath, { ...inputs[winner], requestId: crypto.randomUUID() }, 2)).status, 409);
  const originating = structuredClone(afterDecision.snapshot.sessions.find(row => row.userId === 2)), freshToken = 'synthetic-review-new-' + crypto.randomUUID();
  await change(db => { db.sessions.push({ ...originating, tokenHash: crypto.createHash('sha256').update(freshToken).digest('hex') }); });
  assert.equal((await request(bases[0], 'POST', replayPath, inputs[winner], 2, companyA, companyA, freshToken)).status, 409);
  for (const invalidate of [db => { db.sessions.find(row => row.tokenHash === originating.tokenHash).expiresAt = '2000-01-01'; }, db => { db.sessions = db.sessions.filter(row => row.tokenHash !== originating.tokenHash); }]) {
    await change(invalidate); assert.equal((await request(bases[0], 'POST', replayPath, inputs[winner], 2)).status, 401);
    await change(db => { db.sessions = db.sessions.filter(row => row.userId !== 2); db.sessions.push(structuredClone(originating)); });
  }
  for (const [revoke, restore, expected] of [
    [db => { db.users.find(row => row.id === 2).permissions.manageTime = false; }, db => { db.users.find(row => row.id === 2).permissions.manageTime = true; }, 403],
    [db => { db.users.find(row => row.id === 2).assignedCrews = ['B']; }, db => { db.users.find(row => row.id === 2).assignedCrews = ['A']; }, 404],
    [db => { db.company.timeReviewRolePolicy = policy(); db.company.timeReviewRolePolicy.roles.project_manager.reviewLeave = false; }, db => { delete db.company.timeReviewRolePolicy; }, 403],
    [db => { const leaveAccess = require('./time-off-access'); db.company.timeOffRolePolicy = { version: 1, revision: 1, roles: Object.fromEntries(leaveAccess.roles.map(role => [role, leaveAccess.ceiling(role)])) }; db.company.timeOffRolePolicy.roles.project_manager.viewRequests = false; }, db => { delete db.company.timeOffRolePolicy; }, 403]
  ]) { await change(revoke); const before = await load(); assert.equal((await request(bases[0], 'POST', replayPath, inputs[winner], 2)).status, expected); assert.deepEqual(await load(), before); await change(restore); }
  await change(db => { db.users.find(row => row.id === 2).projectIds = []; });
  assert.equal((await previewLeave(0)).status, 200, 'Crew-only PM leave authority remains projectless');
  assert.equal((await request(bases[0], 'POST', cardPreview, { ids: [501], decision: 'approve' }, 2)).status, 404);
  await change(db => { db.users.find(row => row.id === 2).projectIds = [101]; });

  // First confirmation loses to actor/policy revocation, without partial writes.
  const inflightInput = confirmation(await previewCards()); controls.gate = checkpoint(); controls.gate.expected = 99;
  const inflight = request(bases[0], 'POST', '/api/time-cards/501/approve', inflightInput, 2);
  await waitFor(() => controls.gate.count === 1); await change(db => { db.users.find(row => row.id === 2).role = 'field'; });
  const revoked = await load(); controls.gate.resolve(); assert.equal((await inflight).status, 409); controls.gate = null; assert.deepEqual(await load(), revoked);
  assert.equal((await request(bases[1], 'POST', '/api/time-cards/501/approve', inflightInput, 2)).status, 403);
  await change(db => { db.users.find(row => row.id === 2).role = 'project_manager'; });
  const slowInput = confirmation(await previewCards()), slow = await slowRequest(bases[0], 2, slowInput, '/api/time-cards/501/approve');
  await change(db => { db.company.timeReviewRolePolicy = policy(); db.company.timeReviewRolePolicy.roles.project_manager.approveCards = false; }); slow.done();
  assert.equal((await slow.result).status, 403); await change(db => { delete db.company.timeReviewRolePolicy; });

  // Ambiguous global IDs and mixed bulk validation cannot erase hidden records.
  await change(db => { db.timeCards.push({ ...card(), id: ' 501 ', memberId: 13, projectId: 102 }); });
  const duplicate = await load(); assert.equal((await request(bases[0], 'POST', cardPreview, { ids: [501], decision: 'approve' }, 2)).status, 409); assert.deepEqual(await load(), duplicate);
  await change(db => { db.timeCards = db.timeCards.filter(row => !(String(row.id).trim() === '501' && row.memberId === 13)); db.timeCards.find(row => row.id === 502).status = 'draft'; });
  const mixedBefore = await load(); assert.equal((await request(bases[0], 'POST', cardPreview, { ids: [501, 502], decision: 'approve' }, 2)).status, 409); assert.deepEqual(await load(), mixedBefore);
  await change(db => { db.timeCards.find(row => row.id === 502).status = 'submitted'; db.timeCards.push({ ...card(504), projectId: 102, inAt: '2026-01-05T10:00:00Z', outAt: '2026-01-05T11:00:00Z' }); });
  assert.equal((await request(bases[0], 'POST', cardPreview, { ids: [501], decision: 'approve' }, 2)).status, 409, 'Whole-tenant overlap blocks approval without exposing its foreign job');
  await change(db => { db.timeCards = db.timeCards.filter(row => row.id !== 504); });
  const staleCard = confirmation(await previewCards()); await change(db => { db.timeCards.find(row => row.id === 501).hours = 7; });
  assert.equal((await request(bases[0], 'POST', '/api/time-cards/501/approve', staleCard, 2)).status, 409); await change(db => { db.timeCards.find(row => row.id === 501).hours = 7.25; });
  const bulkInput = confirmation(await previewCards(0, [501, 502])), singleInput = confirmation(await previewCards(1)); controls.gate = checkpoint(); controls.gate.expected = 99;
  const bulkRace = [request(bases[0], 'POST', '/api/time-cards/approve', bulkInput, 2), request(bases[1], 'POST', '/api/time-cards/501/approve', singleInput, 2)];
  await waitFor(() => controls.gate.count === 2); controls.gate.resolve(); const bulkResults = await Promise.all(bulkRace); controls.gate = null;
  assert.deepEqual(bulkResults.map(row => row.status).sort(), [200, 409]);
  let current = await load(); assert.equal(current.snapshot.timeCards.find(row => row.id === 501).hours, 7.25); assert.equal(preservedBusiness(current.snapshot), initialBusiness);
  if (bulkResults[0].status === 409) { const freshBulk = confirmation(await previewCards(0, [501, 502])); assert.equal((await request(bases[0], 'POST', '/api/time-cards/approve', freshBulk, 2)).status, 200); }
  const unapproveInput = confirmation(await previewCards(0, [501], 'unapprove'));
  assert.equal((await request(bases[0], 'POST', '/api/time-cards/501/unapprove', unapproveInput, 2)).status, 200);
  current = await load(); const unapproved = current.snapshot.timeCards.find(row => row.id === 501); assert.equal(unapproved.status, 'draft'); assert.equal(unapproved.hours, 7.25);
  for (const field of ['approvedAt', 'approvedBy', 'submittedAt', 'submittedBy']) assert.equal(unapproved[field], null);
  assert.equal((await request(bases[1], 'POST', '/api/time-cards/501/unapprove', unapproveInput, 2)).status, 200);
  const already = current.snapshot.timeCards.find(row => row.id === 502), historyCount = already.history.length;
  const alreadyInput = confirmation(await previewCards(0, [502])); assert.equal((await request(bases[0], 'POST', '/api/time-cards/502/approve', alreadyInput, 2)).status, 200);
  assert.equal((await load()).snapshot.timeCards.find(row => row.id === 502).history.length, historyCount);

  // Feature/typed policy/grant ceilings remain current and cannot broaden roles.
  await change(db => { db.company.features.timeCards = false; });
  assert.equal((await request(bases[0], 'GET', '/api/time-cards', undefined, 1)).status, 404); await previewLeave(0);
  await change(db => { db.company.features.timeCards = true; db.company.timeReviewPolicyRequired = true; });
  for (const corrupt of [null, { ...policy(), roles: { ...policy().roles, owner: access.ceiling('owner') } }, { ...policy(), roles: { ...policy().roles, field: { ...access.ceiling('field'), approveCards: true } } }, { ...policy(), roles: { ...policy().roles, admin: { ...access.ceiling('admin'), payroll: true } } }]) {
    await change(db => { db.company.timeReviewRolePolicy = corrupt; });
    assert.equal((await request(bases[0], 'GET', '/api/time-cards', undefined, 2)).status, 403); assert.equal((await request(bases[0], 'GET', '/api/time-cards', undefined, 1)).status, 200);
  }
  await change(db => { db.company.timeReviewRolePolicy = policy(); db.users.find(row => row.id === 7).permissions = { viewTime: true }; });
  assert.equal((await request(bases[0], 'GET', '/api/time-cards', undefined, 7)).status, 403);
  assert.equal((await request(bases[0], 'POST', leavePath('synthetic-review-leave') + '/review-preview', { decision: 'approve', note: '' }, 7)).status, 403);
  await change(db => { delete db.company.timeReviewPolicyRequired; delete db.company.timeReviewRolePolicy; db.users.find(row => row.id === 7).permissions = { manageTime: true }; db.timeCards[0].privateSentinel = 'PRIVATE-UNKNOWN'; db.timeCards[0].history.push(null, { action: 'Reviewed', by: 'Office', unknown: 'PRIVATE-HISTORY' }); });
  const projected = await request(bases[0], 'GET', '/api/time-cards', undefined, 2); assert.doesNotMatch(JSON.stringify(projected.data), /PRIVATE|sessionHash|tokenHash|timeReviewReceipts/);
  const rejectedInput = confirmation(await previewLeave(0, 'synthetic-review-leave', 'decline')), beforeRejected = await load();
  controls.rejectCommit = true; assert.equal((await request(bases[0], 'POST', leavePath('synthetic-review-leave') + '/decline', rejectedInput, 2)).status, 503); controls.rejectCommit = false;
  assert.deepEqual(await load(), beforeRejected, 'Rejected SQL candidate writes neither decision, receipt nor audit');
  controls.dropAck = true; const unknown = await request(bases[0], 'POST', leavePath('synthetic-review-leave') + '/decline', rejectedInput, 2); controls.dropAck = false;
  assert.equal(unknown.status, 503); assert.equal(unknown.data.code, 'COMMIT_OUTCOME_UNKNOWN');
  const afterUnknown = await load(); assert.equal(afterUnknown.revision, beforeRejected.revision + 1);
  assert.equal((await request(bases[1], 'POST', leavePath('synthetic-review-leave') + '/decline', rejectedInput, 2)).status, 200); assert.deepEqual(await load(), afterUnknown);

  // Schedule versus leave approval has one tenant-CAS winner. Retry requires
  // a fresh warning preview, preserves every assignment, and blocks new shifts.
  const raceDay = '2098-12-20', raceLeave = 'synthetic-schedule-race';
  await change(db => { db.timeOffRequests.push(leave(raceLeave, raceDay)); });
  const racePreview = confirmation(await previewLeave(0, raceLeave));
  const schedule = { projectId: 101, memberIds: [11], date: raceDay, start: '08:00', end: '16:00', activity: 'Synthetic scheduling race', requestId: crypto.randomUUID() };
  controls.gate = checkpoint(); controls.gate.expected = 99;
  const scheduleRace = [request(bases[0], 'POST', leavePath(raceLeave) + '/approve', racePreview, 2), request(bases[1], 'POST', '/api/assignments', schedule, 2)];
  await waitFor(() => controls.gate.count === 2); controls.gate.resolve(); const raceResults = await Promise.all(scheduleRace); controls.gate = null;
  assert.equal(raceResults.filter(row => row.status === 409).length, 1); assert.equal(raceResults.filter(row => [200, 201].includes(row.status)).length, 1);
  if (raceResults[0].status === 409) {
    const warning = await previewLeave(0, raceLeave); assert.equal(warning.data.scheduledConflicts.length, 1);
    const assignmentsBefore = canonicalHash((await load()).snapshot.assignments);
    assert.equal((await request(bases[0], 'POST', leavePath(raceLeave) + '/approve', confirmation(warning), 2)).status, 200);
    assert.equal(canonicalHash((await load()).snapshot.assignments), assignmentsBefore);
  }
  assert.equal((await request(bases[1], 'POST', '/api/assignments', { ...schedule, requestId: crypto.randomUUID() }, 2)).status, 409);

  // Fixed-email claim versus leave approval is also one SQL winner. A mixed
  // job is indivisible, and newly approved leave conservatively denies it.
  const mailDay = '2098-12-21', mailLeave = 'synthetic-mail-race';
  await change(db => { db.timeOffRequests.push(leave(mailLeave, mailDay)); });
  const queued = await request(bases[0], 'POST', '/api/assignments', { ...schedule, date: mailDay, requestId: crypto.randomUUID() }, 2); assert.equal(queued.status, 201);
  let sent = 0;
  const dispatcher = outbox.createDispatcher({ load: company => repository.load(company), accountAllowed: () => true, send: async () => { sent++; return { id: 'synthetic-no-provider-call' }; }, commit: async (db, rev) => { if (controls.gate) { const barrier = controls.gate; barrier.count++; await barrier.promise; } return repository.save(db, rev); } });
  const job = (await load()).snapshot.assignmentEmailOutbox.find(row => row.assignmentIds.includes(queued.data.id) && row.recipientId === 4);
  assert.ok(job); const mailPreview = confirmation(await previewLeave(0, mailLeave));
  controls.gate = checkpoint(); controls.gate.expected = 99;
  const claim = dispatcher.dispatch(companyA, job.id).then(value => ({ value }), error => ({ error }));
  const approveMail = request(bases[0], 'POST', leavePath(mailLeave) + '/approve', mailPreview, 2);
  await waitFor(() => controls.gate.count === 2); controls.gate.resolve(); const claimResult = await claim, approveResult = await approveMail; controls.gate = null;
  if (approveResult.status === 200) { assert.equal(claimResult.error?.code, 'PDL_REVISION_CONFLICT'); assert.equal(sent, 0); }
  else { assert.equal(approveResult.status, 409); assert.ok(claimResult.value.dispatched); assert.equal(sent, 1); assert.equal((await request(bases[0], 'POST', leavePath(mailLeave) + '/approve', confirmation(await previewLeave(0, mailLeave)), 2)).status, 200); }
  const queuedOther = (await load()).snapshot.assignmentEmailOutbox.find(row => row.assignmentIds.includes(queued.data.id) && row.recipientId === 5), beforeCancel = await load();
  assert.ok(queuedOther); assert.equal(outbox.authorised(beforeCancel.snapshot, queuedOther, Date.now()), false);
  const mixed = structuredClone(beforeCancel.snapshot), mixedJob = mixed.assignmentEmailOutbox.find(row => row.id === queuedOther.id), other = { ...structuredClone(mixed.assignments.find(row => row.id === queued.data.id)), id: 99901, date: '2098-12-22' };
  mixed.assignments.push(other); mixedJob.assignmentIds.push(other.id); mixedJob.payload.assignments.push(outbox.businessRecord(other)); mixedJob.assignmentHash = canonicalHash(mixedJob.payload.assignments); mixedJob.payloadHash = canonicalHash(mixedJob.payload);
  assert.equal(outbox.authorised(mixed, mixedJob, Date.now()), false, 'One overlapping date denies the whole fixed mixed-row email');
  const businessBeforeCancel = beforeCancel.snapshot.assignments.map(outbox.businessRecord);
  assert.equal((await dispatcher.dispatch(companyA, queuedOther.id)).cancelled, true);
  const afterCancel = await load(); assert.equal(afterCancel.snapshot.assignmentEmailOutbox.find(row => row.id === queuedOther.id).status, 'cancelled'); assert.deepEqual(afterCancel.snapshot.assignments.map(outbox.businessRecord), businessBeforeCancel);
  const sentBeforeRepeat = sent; await dispatcher.dispatch(companyA, queuedOther.id); assert.equal(sent, sentBeforeRepeat);
  assert.equal(providerEvents.length, providerBefore); assert.deepEqual(await repository.load(companyB), preservedOther);
  console.log('Time review PostgreSQL/HTTP passed: read/grant/feature/crew/project scopes, zero-write preview, opposite/bulk/schedule/email-claim CAS, origin-session replay, slow-body/inflight revocation, malicious policy/IDOR/hidden duplicates, current-row stale writes, redacted conflicts, unchanged hours/exports/business records, and queued email cancellation without provider calls.');
};
