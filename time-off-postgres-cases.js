'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { companyA, companyB } = require('./fixtures/project-assistant');
const access = require('./time-off-access');
module.exports = async function runTimeOffCases({ repository, request, change, bases, checkpoint, waitFor, slowRequest, controls, providerEvents }) {
  const load = () => repository.load(companyA), route = '/api/time-off-requests';
  const policy = () => ({ version: 1, revision: 1, roles: Object.fromEntries(access.roles.map(role => [role, access.ceiling(role)])) });
  const input = () => ({ startDate: '2098-11-12', endDate: '2098-11-12', allDay: false, startTime: '09:00', endTime: '10:00', type: 'sick', note: 'Synthetic private own leave', requestId: crypto.randomUUID() });
  const before = await load(), otherBefore = await repository.load(companyB), effectsBefore = providerEvents.length, jobsBefore = before.snapshot.assignmentEmailOutbox?.length || 0;
  assert.equal((await request(bases[0], 'GET', route, undefined, 2)).status, 403);
  assert.equal((await request(bases[0], 'GET', route, undefined, 7)).status, 403);
  for (const user of [1, 2, 7, 8, 9]) assert.equal((await request(bases[0], 'POST', route, input(), user)).status, 403);
  for (const extra of [{ id: 'forged' }, { memberId: 13 }, { status: 'approved' }, { reviewedBy: 'Owner' }, { permissions: { approve: true } }, { requestId: '' }, { note: {} }, { allDay: 'false' }]) assert.equal((await request(bases[0], 'POST', route, { ...input(), ...extra }, 4)).status, 400);
  const values = [input(), input()]; controls.gate = checkpoint(); controls.gate.expected = 99;
  const concurrent = values.map((value, index) => request(bases[index], 'POST', route, value, 4));
  await waitFor(() => controls.gate.count === 2); assert.equal((await load()).revision, before.revision);
  controls.gate.resolve(); const results = await Promise.all(concurrent); controls.gate = null;
  assert.deepEqual(results.map(row => row.status).sort(), [201, 409]);
  const winner = results.findIndex(row => row.status === 201), row = results[winner].data, after = await load();
  assert.equal(after.revision, before.revision + 1); assert.equal(after.snapshot.timeOffRequests.length, before.snapshot.timeOffRequests.length + 1);
  assert.equal(after.snapshot.timeOffActionReceipts.length, 1); assert.equal(row.memberId, 11); assert.equal(row.status, 'pending'); assert.equal(row.requestId, undefined);
  assert.equal(after.snapshot.auditLog.filter(item => item.type === 'time_off_requested').length, 1);
  assert.deepEqual(after.snapshot.assignments, before.snapshot.assignments, 'Own leave never mutates schedules, including the losing candidate');
  assert.equal(after.snapshot.assignmentEmailOutbox?.length || 0, jobsBefore); assert.equal(providerEvents.length, effectsBefore);
  assert.equal((await request(bases[1 - winner], 'POST', route, values[winner], 4)).status, 200); assert.equal((await load()).revision, after.revision);
  assert.equal((await request(bases[0], 'POST', route, { ...values[winner], note: 'Changed details' }, 4)).status, 409);
  const originatingSession = structuredClone(after.snapshot.sessions.find(item => item.userId === 4)), freshToken = 'synthetic-new-leave-session-' + crypto.randomUUID();
  await change(db => { db.sessions.push({ ...originatingSession, tokenHash: crypto.createHash('sha256').update(freshToken).digest('hex') }); });
  const newSessionBefore = await load();
  assert.equal((await request(bases[0], 'POST', route, values[winner], 4, companyA, companyA, freshToken)).status, 409, 'A valid new session cannot replay the old-session receipt');
  assert.deepEqual(await load(), newSessionBefore);
  for (const invalidate of [db => { db.sessions.find(item => item.tokenHash === originatingSession.tokenHash).expiresAt = '2000-01-01'; }, db => { db.sessions = db.sessions.filter(item => item.tokenHash !== originatingSession.tokenHash); }]) {
    await change(invalidate); assert.equal((await request(bases[0], 'POST', route, values[winner], 4)).status, 401);
    await change(db => { db.sessions = db.sessions.filter(item => item.userId !== 4); db.sessions.push(structuredClone(originatingSession)); });
  }
  await change(db => { db.timeOffRequests.push({ ...db.timeOffRequests.find(item => item.id === row.id), id: 'synthetic-legacy-own', requestId: 'synthetic-legacy-request' }); });
  const legacyBefore = await load();
  assert.equal((await request(bases[0], 'POST', route, { ...values[winner], requestId: 'synthetic-legacy-request' }, 4)).status, 409);
  assert.deepEqual(await load(), legacyBefore, 'Legacy request key does not acquire an invented receipt or duplicate row');
  assert.equal((await request(bases[0], 'POST', route, input(), 5)).status, 201, 'Foreman requests remain own-only');
  await change(db => {
    db.timeOffRequests.push({ id: 'synthetic-other-crew', memberId: 13, startDate: '2098-11-12', endDate: '2098-11-12', allDay: true, type: 'other', note: 'PRIVATE-OTHER-CREW', status: 'approved', history: [] });
    db.timeOffRequests.find(item => item.id === row.id).unknownPrivate = 'PRIVATE-SERVER-ONLY';
    db.timeOffRequests.find(item => item.id === row.id).history.push(null, 'corrupt history', { action: 'Reviewed', by: 'Office', at: '2098-10-01', unknownPrivate: 'PRIVATE-NESTED-HISTORY' });
    Object.assign(db.users.find(user => user.id === 2), { permissions: { viewTime: true, scheduleCrews: true }, projectIds: [] });
  });
  for (const user of [2, 4, 5]) {
    const privateRead = await request(bases[0], 'GET', route, undefined, user); assert.equal(privateRead.status, 200);
    assert.ok(privateRead.data.every(item => item.memberId === 11)); assert.doesNotMatch(JSON.stringify(privateRead.data), /PRIVATE-OTHER-CREW|PRIVATE-SERVER-ONLY|PRIVATE-NESTED-HISTORY|corrupt history|sessionHash|requestId/);
  }
  await change(db => { db.users.find(user => user.id === 7).permissions = { viewTime: true }; });
  assert.equal((await request(bases[0], 'GET', route, undefined, 7)).status, 403, 'Admin viewTime alone is not a baseline grant');
  await change(db => { db.users.find(user => user.id === 7).permissions.manageTime = true; });
  assert.ok((await request(bases[0], 'GET', route, undefined, 7)).data.some(item => item.memberId === 13));
  await change(db => { db.company.timeOffRolePolicy = policy(); db.users.find(user => user.id === 7).permissions = {}; db.users.find(user => user.id === 2).permissions = { scheduleCrews: true }; });
  for (const user of [2, 7]) assert.equal((await request(bases[0], 'GET', route, undefined, user)).status, 403, 'Policy true never supplies a missing existing office grant');
  await change(db => { delete db.company.timeOffRolePolicy; db.users.find(user => user.id === 2).permissions = { viewTime: true, scheduleCrews: true }; db.users.find(user => user.id === 7).permissions = { manageTime: true }; });
  for (const user of [8, 9]) assert.equal((await request(bases[0], 'GET', '/api/schedule-availability', undefined, user)).status, 403);
  for (const user of [2, 4, 5]) {
    const availability = await request(bases[0], 'GET', '/api/schedule-availability', undefined, user); assert.equal(availability.status, 200);
    assert.ok(availability.data.every(item => item.memberId !== 13)); assert.doesNotMatch(JSON.stringify(availability.data), /PRIVATE|note|type|history|sessionHash/);
  }
  assert.equal((await request(bases[0], 'GET', route, undefined, 1, companyB)).status, 401);
  assert.equal((await request(bases[0], 'GET', '/api/schedule-availability', undefined, 1, companyB)).status, 401);
  const decisionBefore = await load();
  for (const action of ['approve', 'decline', 'review-preview']) for (const user of [1, 2, 4, 7]) assert.ok([400, 403].includes((await request(bases[0], 'POST', route + '/' + row.id + '/' + action, { confirmed: true }, user)).status));
  assert.deepEqual(await load(), decisionBefore, 'Unsupported decisions run no handler or effects');

  // An inflight request cannot retain an earlier actor, linked member or policy.
  controls.gate = checkpoint(); controls.gate.expected = 99; const inflight = request(bases[0], 'POST', route, input(), 4);
  await waitFor(() => controls.gate.count === 1); await change(db => { db.users.find(user => user.id === 4).role = 'admin'; });
  controls.gate.resolve(); assert.equal((await inflight).status, 409); controls.gate = null;
  assert.equal((await request(bases[1], 'POST', route, input(), 4)).status, 403);
  await change(db => { db.users.find(user => user.id === 4).role = 'field'; });
  const slow = await slowRequest(bases[0], 4, input(), route, 'POST');
  await change(db => { db.company.timeOffPolicyRequired = true; db.company.timeOffRolePolicy = policy(); db.company.timeOffRolePolicy.roles.field.createRequest = false; });
  slow.done(); assert.equal((await slow.result).status, 403);
  assert.equal((await request(bases[0], 'POST', route, values[winner], 4)).status, 403, 'Revocation applies before durable replay');
  await change(db => { db.company.timeOffRolePolicy.roles.field = { viewRequests: false, createRequest: false }; });
  assert.equal((await request(bases[0], 'GET', route, undefined, 4)).status, 403);
  const redacted = await request(bases[0], 'GET', '/api/schedule-availability', undefined, 4); assert.equal(redacted.status, 200); assert.doesNotMatch(JSON.stringify(redacted.data), /note|history|type/);
  for (const corrupt of [db => { delete db.company.timeOffRolePolicy; }, db => { db.company.timeOffRolePolicy = policy(); db.company.timeOffRolePolicy.roles.owner = access.ceiling('owner'); }, db => { db.company.timeOffRolePolicy = policy(); db.company.timeOffRolePolicy.roles.field.approve = true; }]) {
    await change(corrupt); assert.equal((await request(bases[0], 'GET', route, undefined, 4)).status, 403); assert.equal((await request(bases[0], 'GET', route)).status, 200);
  }
  await change(db => { delete db.company.timeOffPolicyRequired; delete db.company.timeOffRolePolicy; db.users.find(user => user.id === 4).memberId = 13; });
  assert.equal((await request(bases[0], 'POST', route, values[winner], 4)).status, 409);
  await change(db => { db.users.find(user => user.id === 4).memberId = 11; db.timeOffRequests.find(item => item.id === row.id).status = 'approved'; });
  assert.equal((await request(bases[0], 'POST', route, values[winner], 4)).data.status, 'approved', 'Replay projects current reviewed state without a new decision');
  await change(db => { db.timeOffRequests.find(item => item.id === row.id).note = 'Changed stored details'; });
  assert.equal((await request(bases[0], 'POST', route, values[winner], 4)).status, 409);
  await change(db => { db.users.find(user => user.id === 2).permissions = { scheduleCrews: true }; db.users.find(user => user.id === 2).projectIds = [101]; });
  assert.deepEqual(await repository.load(companyB), otherBefore); assert.equal(providerEvents.length, effectsBefore);
  console.log('Private time-off PostgreSQL/HTTP passed: two-worker own-create CAS/receipt/audit, current reviewed replay, field/foreman identity, office grant and PM crew scopes, private projections/redacted scheduling availability, malicious policy/IDOR/slow-body/inflight revocation and pre-effect unconfirmed decision rejection.');
};
