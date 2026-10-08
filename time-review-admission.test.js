'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { fixture, companyA, token } = require('./fixtures/project-assistant');
const policy = require('./time-review-access');
const admission = require('./time-review-admission');
const source = fs.readFileSync('server.js', 'utf8');
const helpers = { payPeriods: require('./pay-periods'), Intl, Date, companyDateIso: () => '2098-10-01' };
vm.createContext(helpers);
for (const [start, end] of [['function timeCardIdKey(', 'function timeCardHours('], ['function timeCardStatusText(', 'function matchingTimeCards('], ['function filterTimeCards(', 'function csvDateToken('], ['function localClockLabel(', 'function freshTimeCardsFlag(']]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), helpers);
function card(id = 501, memberId = 11, projectId = 101) { return { id, memberId, projectId, date: '2026-01-05', inAt: '2026-01-05T08:00:00Z', outAt: '2026-01-05T16:00:00Z', hours: 7.25, status: 'submitted', submittedAt: '2026-01-06', submittedBy: 'Synthetic field', breaks: [{ type: 'unpaid_meal', startedAt: '2026-01-05T12:00:00Z', endedAt: '2026-01-05T12:45:00Z' }], history: [] }; }
const leave = () => ({ id: 'synthetic-leave', memberId: 11, startDate: '2098-12-01', endDate: '2098-12-01', allDay: false, startTime: '09:00', endTime: '10:00', type: 'sick', note: 'PRIVATE-LEAVE', status: 'pending', history: [] });
async function main() {
  let db = fixture(), revision = 1, writes = 0, clock = Date.parse('2098-10-07T16:00:00Z');
  db.company.features.timeCards = true; db.timeCards = [card()]; db.timeOffRequests = [leave()];
  db.users.find(row => row.id === 2).permissions = { manageTime: true };
  const dependencies = { readDb: () => db, writeDb: () => { writes++; revision++; }, revision: () => revision, body: async req => req.input, json: (res, status, data) => Object.assign(res, { status, data }), isApproved: helpers.timeCardIsApproved, statusText: helpers.timeCardStatusText, completeCard: helpers.payPeriods.completeCard, overlap: helpers.timeCardOverlap, upsert: helpers.upsertTimeCard, presentCard: helpers.presentTimeCard, filterCards: helpers.filterTimeCards, mergeCopies: helpers.mergeTimeCardCopies, fieldAccess: () => ({ canEdit: false }), now: () => new Date(clock) };
  const handler = admission.createHandler({ ...dependencies, signingKey: Buffer.alloc(32, 1) });
  async function call(path, input, userId = 2, method = 'POST', sessionHash) {
    const user = db.users.find(row => row.id === userId), req = { method, input, auth: { user, session: { tokenHash: sessionHash || crypto.createHash('sha256').update(token(companyA, userId)).digest('hex') } } }, res = {};
    await handler(req, res, new URL('http://localhost' + path)); return res;
  }
  const cardPreview = '/api/time-cards/review-preview', leavePreview = '/api/time-off-requests/synthetic-leave/review-preview';
  const confirm = preview => ({ token: preview.data.token, version: preview.data.version, confirmed: true, requestId: crypto.randomUUID() });
  const makePolicy = () => ({ version: 1, revision: 1, roles: Object.fromEntries(policy.roles.map(role => [role, policy.ceiling(role)])) });
  assert.equal(policy.actor(db, db.users[1], false), db.users[1]);
  for (const role of ['crew', 'platform_owner', 'unknown']) assert.deepEqual(policy.access(db, { role, permissions: { manageTime: true } }), Object.fromEntries(policy.actions.map(action => [action, false])));
  for (const role of ['admin', 'project_manager']) for (const manageTime of [false, true]) for (const viewTime of [false, true]) {
    const user = { role, permissions: { manageTime, viewTime } }, result = policy.access(db, user);
    assert.equal(result.reviewLeave, manageTime); assert.equal(result.approveCards, manageTime); assert.equal(result.unapproveCards, manageTime); assert.equal(result.viewCards, manageTime || role === 'project_manager' && viewTime);
  }
  for (const corrupt of [null, { ...makePolicy(), roles: { ...makePolicy().roles, owner: policy.ceiling('owner') } }, { ...makePolicy(), roles: { ...makePolicy().roles, field: { ...policy.ceiling('field'), approveCards: true } } }, { ...makePolicy(), roles: { ...makePolicy().roles, project_manager: { ...policy.ceiling('project_manager'), payroll: true } } }]) {
    db.company.timeReviewPolicyRequired = true; db.company.timeReviewRolePolicy = corrupt;
    assert.equal(policy.access(db, db.users[1]).reviewLeave, false); assert.equal(policy.access(db, db.users[0]).reviewLeave, true); assert.equal(policy.actor(db, db.users[1], false), null);
  }
  delete db.company.timeReviewPolicyRequired; delete db.company.timeReviewRolePolicy;
  for (const userId of [4, 5, 7]) assert.equal((await call(cardPreview, { ids: [501], decision: 'approve' }, userId)).status, 403);
  for (const input of [{ ids: [501], decision: 'approve', payroll: true }, { ids: [true], decision: 'approve' }, { ids: [501], decision: 'auto_approve' }, { ids: [501, 502], decision: 'unapprove' }]) assert.equal((await call(cardPreview, input)).status, 400);
  for (const input of [{ decision: 'approve', note: {} }, { decision: 'approve', permissions: { manageTime: true } }]) assert.equal((await call(leavePreview, input)).status, 400);
  const noWrite = writes, preview = await call(cardPreview, { ids: [501], decision: 'approve' }); assert.equal(preview.status, 200); assert.equal(writes, noWrite);
  const confirmation = confirm(preview);
  const otherWorker = admission.createHandler({ ...dependencies, signingKey: Buffer.alloc(32, 2) }), unavailable = {};
  await otherWorker({ method: 'POST', input: confirmation, auth: { user: db.users[1], session: { tokenHash: crypto.createHash('sha256').update(token(companyA, 2)).digest('hex') } } }, unavailable, new URL('http://localhost/api/time-cards/501/approve'));
  assert.equal(unavailable.status, 409); assert.equal(writes, noWrite, 'Another worker cannot execute an unsigned first confirmation');
  assert.equal((await call('/api/time-cards/501/approve', { ...confirmation, confirmed: false })).status, 400);
  clock += 11 * 60000; assert.equal((await call('/api/time-cards/501/approve', confirmation)).status, 409); assert.equal(writes, noWrite); clock -= 11 * 60000;
  const [payload, signature] = confirmation.token.split('.'), tampered = payload + '.' + (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
  assert.equal((await call('/api/time-cards/501/approve', { ...confirmation, token: tampered })).status, 409);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_', alias = confirmation.token.slice(0, -1) + alphabet[alphabet.indexOf(confirmation.token.at(-1)) + 1];
  assert.equal(Buffer.from(alias.split('.')[1], 'base64url').equals(Buffer.from(signature, 'base64url')), true, 'Noncanonical signature alias has identical decoded bytes');
  assert.equal((await call('/api/time-cards/501/approve', { ...confirmation, token: alias })).status, 409); assert.equal(writes, noWrite);
  assert.equal((await call('/api/time-cards/501/approve', confirmation)).status, 200); assert.equal(db.timeCards[0].status, 'approved'); assert.equal(db.timeCards[0].hours, 7.25); assert.equal(db.timeCards[0].history.length, 1);
  const after = structuredClone(db), afterWrites = writes;
  assert.equal((await call('/api/time-cards/501/approve', confirmation)).status, 200); assert.equal(writes, afterWrites); assert.equal(JSON.stringify(db), JSON.stringify(after));
  assert.equal((await call('/api/time-cards/501/approve', { ...confirmation, requestId: crypto.randomUUID() })).status, 409);
  assert.equal((await call('/api/time-cards/501/approve', confirmation, 2, 'POST', 'new-valid-session-hash')).status, 409);
  db.users[1].permissions.manageTime = false; assert.equal((await call('/api/time-cards/501/approve', confirmation)).status, 403); db.users[1].permissions.manageTime = true;
  const unapprove = await call(cardPreview, { ids: [501], decision: 'unapprove' }); assert.equal(unapprove.status, 200);
  assert.equal((await call('/api/time-cards/501/unapprove', confirm(unapprove))).status, 200); assert.equal(db.timeCards[0].status, 'draft');
  for (const field of ['approvedAt', 'approvedBy', 'submittedAt', 'submittedBy']) assert.equal(db.timeCards[0][field], null);
  assert.equal(db.timeCards[0].hours, 7.25); assert.equal((await call('/api/time-cards/501/approve', confirmation)).status, 409);
  db.timeCards = [card(), card(502, 12)]; db.timeCards[1].status = 'draft';
  assert.equal((await call(cardPreview, { ids: [501, 502], decision: 'approve' })).status, 409); assert.equal(db.timeCards[0].status, 'submitted');
  db.timeCards = [card(), { ...card(), projectId: 102, memberId: 13 }];
  const duplicates = structuredClone(db); assert.equal((await call(cardPreview, { ids: [501], decision: 'approve' })).status, 409); assert.equal(JSON.stringify(db), JSON.stringify(duplicates));
  db.timeCards = [card(), { ...card(502), inAt: '2026-01-05T10:00:00Z', outAt: '2026-01-05T11:00:00Z', projectId: 102 }];
  assert.equal((await call(cardPreview, { ids: [501], decision: 'approve' })).status, 409);
  db.timeCards = [card()]; db.company.features.timeCards = false;
  assert.equal((await call(cardPreview, { ids: [501], decision: 'approve' })).status, 404);
  db.assignments = [{ id: 91, projectId: 102, memberIds: [11, 13], date: '2098-12-01', start: '09:30', end: '11:00', activity: 'PRIVATE-FORIEGN-ACTIVITY', instructions: 'PRIVATE-FOREIGN-INSTRUCTIONS' }];
  const reviewedLeave = await call(leavePreview, { decision: 'approve', note: 'Exact review note' }); assert.equal(reviewedLeave.status, 200);
  assert.equal(reviewedLeave.data.scheduledConflicts.length, 1); assert.doesNotMatch(JSON.stringify(reviewedLeave.data.scheduledConflicts), /PRIVATE|projectId|memberId|instructions|activity/);
  const leaveConfirm = confirm(reviewedLeave), schedules = structuredClone(db.assignments);
  revision++; assert.equal((await call('/api/time-off-requests/synthetic-leave/approve', leaveConfirm)).status, 409);
  const freshLeave = await call(leavePreview, { decision: 'approve', note: 'Exact review note' }); assert.equal((await call('/api/time-off-requests/synthetic-leave/approve', confirm(freshLeave))).status, 200);
  assert.equal(db.timeOffRequests[0].reviewNote, 'Exact review note'); assert.deepEqual(db.assignments, schedules);
  assert.doesNotMatch(JSON.stringify(admission.cardProjection({ ...card(), unknown: 'PRIVATE-UNKNOWN', history: [null, { action: 'Approved', by: 'Office', at: '2026-01-05', unknown: 'PRIVATE-NESTED' }] })), /PRIVATE/);
  console.log('Typed time review passed: immutable roles/grants/features, closed policies/inputs, preview/explicit confirmation, stale versions, originating-session replay, duplicate/overlap/bulk rejection, private projections and unchanged hours/schedules.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
