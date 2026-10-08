'use strict';
// Invoked only by the disposable-localhost PostgreSQL suite, never production.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { companyA, companyB } = require('./fixtures/project-assistant');
const scheduling = require('./scheduling-access');
const outbox = require('./assignment-email-outbox');
const { canonicalHash } = require('./database/transactional-repository');

module.exports = async function runSchedulingCases({ repository, change, request, slowRequest, bases, startWorker, checkpoint, waitFor, controls, providerEvents }) {
  const load = () => repository.load(companyA);
  const commit = (db, revision) => repository.save(db, revision);
  const policy = () => ({ version: 1, revision: 1, roles: Object.fromEntries(scheduling.roles.map(role => [role, scheduling.ceiling(role)])) });
  let day = 0;
  const session = structuredClone((await load()).snapshot.sessions.find(row => row.userId === 2));
  const input = (extra = {}) => ({ projectId: 101, memberIds: [11], date: new Date(Date.UTC(2098, 0, ++day)).toISOString().slice(0, 10), start: '08:00', end: '16:00', activity: 'Synthetic manual schedule', requestId: crypto.randomUUID(), ...extra });
  const restore = async () => change(db => {
    Object.assign(db.users.find(row => row.id === 2), { role: 'project_manager', companyId: companyA, status: 'Active', projectIds: [101], assignedCrews: ['A'], permissions: { scheduleCrews: true } });
    Object.assign(db.users.find(row => row.id === 4), { role: 'field', companyId: companyA, status: 'Active', memberId: 11, email: 'user4@example.invalid' });
    db.sessions = db.sessions.filter(row => row.userId !== 2); db.sessions.push(structuredClone(session));
    delete db.company.schedulingRolePolicy; delete db.company.schedulingPolicyRequired;
  });
  await restore();
  assert.equal((await request(bases[0], 'GET', '/api/assignments', undefined, 2)).status, 200);
  assert.equal((await request(bases[0], 'GET', '/api/assignments', undefined, 1, companyB)).status, 401);
  for (const user of [4, 5, 6, 8, 9]) assert.equal((await request(bases[0], 'POST', '/api/assignments', input(), user)).status, 403);
  for (const forged of [{ id: 999 }, { permissions: { scheduleCrews: true } }, { requestId: '' }, { memberIds: [11, 11] }]) assert.equal((await request(bases[0], 'POST', '/api/assignments', input(forged), 2)).status, 400);
  for (const outside of [{ projectId: 102 }, { memberIds: [13] }, { memberIds: [11, 13] }]) assert.equal((await request(bases[0], 'POST', '/api/assignments', input(outside), 2)).status, 403);

  // Two HTTP workers: only the winning SQL CAS owns assignments, receipt and jobs.
  const before = await load(), candidates = [input(), input()];
  controls.gate = checkpoint(); controls.gate.expected = 99;
  const pending = candidates.map((value, index) => request(bases[index], 'POST', '/api/assignments', value, 2));
  await waitFor(() => controls.gate.count === 2);
  assert.equal((await load()).revision, before.revision); assert.equal(providerEvents.length, 0);
  controls.gate.resolve(); const outputs = await Promise.all(pending); controls.gate = null;
  assert.deepEqual(outputs.map(row => row.status).sort(), [201, 409]);
  const winner = outputs.findIndex(row => row.status === 201), created = outputs[winner].data, after = await load();
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.snapshot.assignments.length, before.snapshot.assignments.length + 1);
  assert.equal(after.snapshot.scheduleActionReceipts.length, 1); assert.equal(after.snapshot.assignmentEmailOutbox.length, 2);
  assert.ok(after.snapshot.assignmentEmailOutbox.every(job => job.assignmentIds.length === 1 && job.assignmentIds[0] === created.id && job.status === 'queued'));
  assert.equal((await request(bases[1 - winner], 'POST', '/api/assignments', candidates[winner], 2)).status, 200);
  assert.equal((await load()).revision, after.revision); assert.equal(providerEvents.length, 0);
  assert.equal((await request(bases[0], 'POST', '/api/assignments', { ...candidates[winner], activity: 'Changed request' }, 2)).status, 409);
  const visible = await request(bases[0], 'GET', '/api/assignments', undefined, 2);
  assert.ok(!JSON.stringify(visible.data).includes('sessionHash')); assert.ok(!Object.hasOwn(visible.data, 'assignmentEmailOutbox'));
  const patch = { edit: true, projectId: 101, memberIds: [11], date: created.date, start: '08:00', end: '16:00', activity: 'Synthetic changed task' };
  assert.equal((await request(bases[0], 'PATCH', '/api/assignments/' + created.id, { ...patch, memberIds: [13] }, 2)).status, 403);
  assert.equal((await request(bases[0], 'PATCH', '/api/assignments/' + created.id, { ...patch, projectId: 102 }, 2)).status, 403);
  assert.equal((await request(bases[0], 'PATCH', '/api/assignments/' + created.id, patch, 2)).status, 200);
  assert.equal((await request(bases[0], 'POST', '/api/assignments', candidates[winner], 2)).status, 409, 'An edited assignment cannot replay a stale result');

  // A mixed-crew source requires all source and destination members for writes.
  const mixed = await request(bases[0], 'POST', '/api/assignments', input({ memberIds: [11, 13] })); assert.equal(mixed.status, 201);
  const mixedId = mixed.data.id;
  const fieldRead = await request(bases[0], 'GET', '/api/assignments', undefined, 4);
  assert.deepEqual(fieldRead.data.assignments.find(row => row.id === mixedId).memberIds, [11]);
  assert.equal((await request(bases[0], 'DELETE', '/api/assignments/' + mixedId + '?memberId=11', {}, 2)).status, 403);
  assert.equal((await request(bases[0], 'PATCH', '/api/assignments/' + mixedId, { memberId: 11, targetMemberId: 12, date: mixed.data.date }, 2)).status, 403);
  assert.equal((await request(bases[0], 'POST', '/api/assignments/' + mixedId + '/acknowledge', { memberId: 13 }, 4)).status, 400);
  const acknowledged = await request(bases[0], 'POST', '/api/assignments/' + mixedId + '/acknowledge', {}, 4); assert.equal(acknowledged.status, 200);
  assert.deepEqual(acknowledged.data.memberIds, [11]); assert.ok(!Object.hasOwn(acknowledged.data.notifications, '13'));

  // Revoking scope during an inflight SQL save rejects the whole candidate/jobs.
  const inflightBefore = await load(); controls.gate = checkpoint(); controls.gate.expected = 99;
  const inflight = request(bases[0], 'POST', '/api/assignments', input(), 2);
  await waitFor(() => controls.gate.count === 1); await change(db => { db.users.find(row => row.id === 2).assignedCrews = []; });
  controls.gate.resolve(); assert.equal((await inflight).status, 409); controls.gate = null;
  const revoked = await load(); assert.equal(revoked.snapshot.assignments.length, inflightBefore.snapshot.assignments.length);
  assert.equal(revoked.snapshot.assignmentEmailOutbox.length, inflightBefore.snapshot.assignmentEmailOutbox.length); await restore();
  const slow = await slowRequest(bases[0], 2, {}, '/api/assignments/' + created.id, 'DELETE');
  await change(db => { db.users.find(row => row.id === 2).status = 'Deactivated'; }); slow.done();
  assert.equal((await slow.result).status, 401, 'DELETE authorization loads after the complete body'); await restore();

  // Typed reductions apply to manual writes and assistant preview/confirm/replay.
  const proposal = { memberId: 12, date: '2098-10-18', start: '08:00', end: '16:00', activity: 'Synthetic assistant', instructions: 'Synthetic instructions', timezone: 'America/Los_Angeles' };
  const preview = await request(bases[0], 'POST', '/api/projects/101/assistant/preview', proposal, 2); assert.equal(preview.status, 200);
  const confirmation = { token: preview.data.token, version: preview.data.version, confirmed: true };
  await change(db => { db.company.schedulingPolicyRequired = true; db.company.schedulingRolePolicy = policy(); db.company.schedulingRolePolicy.roles.project_manager.create = false; });
  assert.equal((await request(bases[1], 'POST', '/api/assignments', input(), 2)).status, 403);
  assert.equal((await request(bases[0], 'POST', '/api/projects/101/assistant/confirm', confirmation, 2)).status, 403);
  assert.equal((await request(bases[0], 'POST', '/api/projects/101/assistant/preview', proposal, 4)).status, 403);
  assert.equal((await request(bases[0], 'PATCH', '/api/assignments/' + created.id, patch, 2)).status, 200, 'Create and edit are independent finite actions');
  await restore();
  const fresh = await request(bases[0], 'POST', '/api/projects/101/assistant/preview', proposal, 2); assert.equal(fresh.status, 200);
  const beforeAssistant = (await load()).snapshot.assignmentEmailOutbox.length;
  const confirmed = { token: fresh.data.token, version: fresh.data.version, confirmed: true };
  assert.equal((await request(bases[0], 'POST', '/api/projects/101/assistant/confirm', confirmed, 2)).status, 201);
  assert.equal((await load()).snapshot.assignmentEmailOutbox.length, beforeAssistant, 'Assistant never queues assignment email');
  await change(db => { db.company.schedulingPolicyRequired = true; db.company.schedulingRolePolicy = policy(); db.company.schedulingRolePolicy.roles.project_manager.create = false; });
  assert.equal((await request(bases[0], 'POST', '/api/projects/101/assistant/confirm', confirmed, 2)).status, 403);
  for (const mutate of [db => { delete db.company.schedulingRolePolicy; }, db => { db.company.schedulingRolePolicy = policy(); db.company.schedulingRolePolicy.roles.field.create = true; }, db => { db.company.schedulingRolePolicy = policy(); db.company.schedulingRolePolicy.roles.owner = scheduling.ceiling('owner'); }]) {
    await change(mutate);
    assert.equal((await request(bases[0], 'GET', '/api/assignments', undefined, 2)).status, 403);
    assert.equal((await request(bases[0], 'GET', '/api/assignments')).status, 200, 'Owner protection is immutable');
  }
  await restore();

  // Exercise the dispatcher against real PG CAS, with a local synthetic sender.
  await change(db => { db.users.find(row => row.id === 5).email = ''; db.assignmentEmailOutbox = []; });
  async function queued() {
    await restore(); await change(db => { db.assignmentEmailOutbox = []; });
    const response = await request(bases[0], 'POST', '/api/assignments', input(), 2); assert.equal(response.status, 201, JSON.stringify(response.data));
    const current = await load(); assert.equal(current.snapshot.assignmentEmailOutbox.length, 1); return current.snapshot.assignmentEmailOutbox[0];
  }
  let sends = 0;
  const send = async (payload, key) => {
    const current = await load(), job = current.snapshot.assignmentEmailOutbox.find(row => key === 'pdl-assignment/' + row.id);
    assert.equal(job.status, 'dispatching'); assert.equal(canonicalHash(payload), job.payloadHash); sends++;
    return { id: 'synthetic-provider-id' };
  };
  // Discriminating recipient regressions: policy revision is identical, so the
  // recipient view check itself must exclude/cancel rather than a version check.
  await change(db => {
    db.company.schedulingPolicyRequired = true; db.company.schedulingRolePolicy = policy();
    for (const role of ['field', 'foreman']) db.company.schedulingRolePolicy.roles[role] = Object.fromEntries(scheduling.actions.map(action => [action, false]));
    db.assignmentEmailOutbox = [];
  });
  assert.equal((await request(bases[0], 'POST', '/api/assignments', input(), 2)).status, 201);
  assert.equal((await load()).snapshot.assignmentEmailOutbox.length, 0, 'Do not enqueue denied recipients');
  await restore(); await change(db => { db.company.schedulingPolicyRequired = true; db.company.schedulingRolePolicy = policy(); });
  assert.equal((await request(bases[0], 'POST', '/api/assignments', input(), 2)).status, 201);
  const recipientJob = (await load()).snapshot.assignmentEmailOutbox[0]; assert.equal(recipientJob.policyRevision, 1);
  await change(db => { db.company.schedulingRolePolicy.roles.field = Object.fromEntries(scheduling.actions.map(action => [action, false])); });
  assert.equal((await outbox.createDispatcher({ accountAllowed: db => db.company.demo === true, load, commit, send }).dispatch(companyA, recipientJob.id)).cancelled, true); assert.equal(sends, 0);
  let job = await queued(), claim = checkpoint(); claim.expected = 2;
  const concurrentCommit = async (db, revision) => { if (db.assignmentEmailOutbox[0].status === 'dispatching' && claim.count < claim.expected) { claim.count++; if (claim.count === claim.expected) claim.resolve(); await claim.promise; } return commit(db, revision); };
  const dispatchers = [0, 1].map(() => outbox.createDispatcher({ accountAllowed: db => db.company.demo === true, load, commit: concurrentCommit, send }));
  const dispatchRace = await Promise.allSettled(dispatchers.map(dispatcher => dispatcher.dispatch(companyA, job.id)));
  assert.equal(dispatchRace.filter(row => row.status === 'fulfilled').length, 1); assert.equal(sends, 1);
  assert.equal((await load()).snapshot.assignmentEmailOutbox[0].status, 'sent');
  await dispatchers[0].dispatch(companyA, job.id); assert.equal(sends, 1);

  // Every current identity and business boundary is rechecked before dispatch.
  for (const revoke of [
    db => { db.users.find(row => row.id === 2).status = 'Deactivated'; },
    db => { db.users.find(row => row.id === 2).role = 'field'; },
    db => { db.users.find(row => row.id === 2).companyId = companyB; },
    db => { db.users.find(row => row.id === 2).permissions.scheduleCrews = false; },
    db => { db.users.find(row => row.id === 2).projectIds = []; },
    db => { db.users.find(row => row.id === 2).assignedCrews = []; },
    db => { db.sessions.find(row => row.userId === 2).expiresAt = '2000-01-01'; },
    db => { db.sessions = db.sessions.filter(row => row.userId !== 2); },
    db => { db.sessions.find(row => row.userId === 2).companyId = companyB; },
    db => { db.company.schedulingPolicyRequired = true; db.company.schedulingRolePolicy = policy(); db.company.schedulingRolePolicy.roles.project_manager.create = false; },
    db => { db.company.schedulingPolicyRequired = true; db.company.schedulingRolePolicy = policy(); db.company.schedulingRolePolicy.roles.field = Object.fromEntries(scheduling.actions.map(action => [action, false])); },
    db => { db.users.find(row => row.id === 4).email = 'changed@example.invalid'; },
    db => { db.users.find(row => row.id === 4).status = 'Deactivated'; },
    db => { db.users.find(row => row.id === 4).memberId = 13; },
    db => { db.users.find(row => row.id === 4).companyId = companyB; },
    db => { db.assignmentEmailOutbox[0].companyId = companyB; },
    db => { db.assignmentEmailOutbox[0].payload = null; },
    db => { db.assignmentEmailOutbox[0].payload.assignments = {}; },
    db => { db.assignmentEmailOutbox[0].payload.assignments = [null]; },
    db => { db.assignmentEmailOutbox[0].payload.url = 'https://malicious.invalid'; },
    db => { db.assignmentEmailOutbox[0].payload.to = 'malicious@example.invalid'; db.assignmentEmailOutbox[0].payloadHash = canonicalHash(db.assignmentEmailOutbox[0].payload); },
    db => { db.assignmentEmailOutbox[0].createdAt = '2000-01-01T00:00:00Z'; },
    db => { db.assignments = db.assignments.filter(row => row.id !== db.assignmentEmailOutbox[0].assignmentIds[0]); },
    db => { db.assignments.find(row => row.id === db.assignmentEmailOutbox[0].assignmentIds[0]).activity = 'Changed business record'; }
  ]) {
    job = await queued(); await change(revoke);
    const oldSends = sends; const dispatcher = outbox.createDispatcher({ accountAllowed: db => db.company.demo === true, load, commit, send });
    assert.equal((await dispatcher.dispatch(companyA, job.id)).cancelled, true); assert.equal(sends, oldSends);
    await restore();
  }
  job = await queued();
  const recheck = outbox.createDispatcher({ accountAllowed: db => db.company.demo === true, load, commit: async (db, revision) => { const saved = await commit(db, revision); if (db.assignmentEmailOutbox[0].status === 'dispatching') await change(current => { current.users.find(row => row.id === 2).assignedCrews = []; }); return saved; }, send });
  const beforeRecheck = sends; assert.equal((await recheck.dispatch(companyA, job.id)).cancelled, true); assert.equal(sends, beforeRecheck);

  // Lost claim acknowledgement admits no provider call; ambiguous transport and
  // receipt persistence are never treated as permission to resend automatically.
  job = await queued(); const oldSends = sends;
  const lostClaim = outbox.createDispatcher({ accountAllowed: db => db.company.demo === true, load, commit: async (db, revision) => { await commit(db, revision); throw Error('Synthetic lost SQL claim acknowledgement'); }, send });
  await assert.rejects(lostClaim.dispatch(companyA, job.id), /lost SQL claim/); assert.equal(sends, oldSends);
  const normal = outbox.createDispatcher({ accountAllowed: db => db.company.demo === true, load, commit, send }); await normal.dispatch(companyA, job.id); assert.equal(sends, oldSends);
  assert.equal((await load()).snapshot.assignmentEmailOutbox[0].status, 'dispatching');
  job = await queued();
  const uncertain = outbox.createDispatcher({ accountAllowed: db => db.company.demo === true, load, commit, send: async (...args) => { await send(...args); throw Error('Synthetic provider acknowledgement lost'); } });
  assert.equal((await uncertain.dispatch(companyA, job.id)).uncertain, true); assert.equal((await load()).snapshot.assignmentEmailOutbox[0].status, 'uncertain');
  const once = sends; await uncertain.dispatch(companyA, job.id); assert.equal(sends, once);
  for (const response of [null, {}, { id: '' }, { id: 'bad/provider-id' }]) {
    job = await queued(); const invalid = outbox.createDispatcher({ accountAllowed: db => db.company.demo === true, load, commit, send: async (...args) => { await send(...args); return response; } });
    assert.equal((await invalid.dispatch(companyA, job.id)).uncertain, true); const count = sends;
    await invalid.dispatch(companyA, job.id); assert.equal(sends, count);
  }
  job = await queued();
  const rejected = outbox.createDispatcher({ accountAllowed: db => db.company.demo === true, load, commit, send: async (...args) => { await send(...args); throw Object.assign(Error('Synthetic provider 400'), { deliveryRejected: true }); } });
  assert.equal((await rejected.dispatch(companyA, job.id)).uncertain, false); assert.equal((await load()).snapshot.assignmentEmailOutbox[0].status, 'failed');
  const failedCount = sends; await rejected.dispatch(companyA, job.id); assert.equal(sends, failedCount);
  job = await queued(); let finalizations = 0;
  const conflictReceipt = outbox.createDispatcher({ accountAllowed: db => db.company.demo === true, load, commit: async (db, revision) => { if (db.assignmentEmailOutbox[0].status === 'sent' && ++finalizations <= 2) { await change(current => { current.syntheticConcurrentEffectWrite = finalizations; }); } return commit(db, revision); }, send });
  assert.equal((await conflictReceipt.dispatch(companyA, job.id)).recorded, true); assert.equal(finalizations, 3);
  assert.equal((await load()).snapshot.syntheticConcurrentEffectWrite, 2);
  job = await queued();
  const brokenReceipt = outbox.createDispatcher({ accountAllowed: db => db.company.demo === true, load, commit: async (db, revision) => { if (db.assignmentEmailOutbox[0].status === 'sent') throw Error('Synthetic finalization unavailable'); return commit(db, revision); }, send });
  await assert.rejects(brokenReceipt.dispatch(companyA, job.id), /finalization unavailable/);
  const afterSend = sends; await normal.dispatch(companyA, job.id); assert.equal(sends, afterSend);

  // Actual server email adapter reaches only the localhost bridge. The adapter
  // must send a stable provider key after the assignment and claim are durable.
  await restore(); await change(db => { db.assignmentEmailOutbox = []; });
  const dispatchBase = await startWorker({ dispatch: true });
  controls.providerMode = 'success'; const httpCreated = await request(dispatchBase, 'POST', '/api/assignments', input(), 2); assert.equal(httpCreated.status, 201);
  await waitFor(() => providerEvents.length === 1 && controls.providerCompleted);
  const deadline = Date.now() + 10000;
  while ((await load()).snapshot.assignmentEmailOutbox[0].status !== 'sent') { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 20)); }
  const delivered = await load(); assert.equal(delivered.snapshot.assignmentEmailOutbox[0].providerId, 'synthetic-resend-id');
  assert.equal(providerEvents[0].key, 'pdl-assignment/' + delivered.snapshot.assignmentEmailOutbox[0].id);
  assert.equal(providerEvents[0].assignmentId, httpCreated.data.id);
  await request(dispatchBase, 'POST', '/api/assignments', { ...input(), id: 12 }, 4); assert.equal(providerEvents.length, 1);
  controls.providerMode = 'drop'; controls.providerCompleted = false;
  assert.equal((await request(dispatchBase, 'POST', '/api/assignments', input(), 2)).status, 201);
  const unknownDeadline = Date.now() + 10000;
  while (!(await load()).snapshot.assignmentEmailOutbox.some(row => row.status === 'uncertain')) { assert.ok(Date.now() < unknownDeadline); await new Promise(resolve => setTimeout(resolve, 20)); }
  const lost = (await load()).snapshot.assignmentEmailOutbox.find(row => row.status === 'uncertain'); await normal.dispatch(companyA, lost.id);
  assert.equal(providerEvents.length, 2);
  job = await queued(); await change(db => { db.company.demo = false; db.company.subscriptionStatus = 'Paused'; });
  assert.equal((await request(dispatchBase, 'GET', '/api/auth/me')).status, 200);
  const lockedDeadline = Date.now() + 10000;
  while ((await load()).snapshot.assignmentEmailOutbox[0].status !== 'cancelled') { assert.ok(Date.now() < lockedDeadline); await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(providerEvents.length, 2, 'Current subscription lock is also checked before transport');
  await change(db => { db.company.demo = true; delete db.company.subscriptionStatus; });
  await restore();
  console.log('Scheduling PostgreSQL/HTTP passed: two-worker CAS/job races, typed input/source/destination/own acknowledgement, stale replay, slow DELETE and inflight revocation, typed-policy and assistant revocation, finite effect identity checks, dispatch races, lost claim/provider/receipt outcomes, and actual adapter idempotency with localhost-only transport.');
};
