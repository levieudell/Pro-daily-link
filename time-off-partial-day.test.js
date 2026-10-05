'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const availability = require('./schedule-availability');
const { splitSnapshot, assembleSnapshot } = require('./database/transactional-repository');

const date = '2026-10-11';
const privateDetail = 'PRIVATE-LEAVE-DETAIL';
const timed = (memberId = 1, day = date, startTime = '09:00', endTime = '10:00') => ({ memberId, startDate: day, endDate: day, allDay: false, startTime, endTime });
const emptyConflicts = { conflictMemberIds: [], conflictDates: [] };
const timedRow = { ...timed(), status: 'approved', type: 'sick', note: privateDetail, reviewNote: privateDetail, history: [{ note: privateDetail }] };
assert.deepEqual(availability.approved([timedRow], [1]), [timed()], 'availability exposes only selected hours, not private request details');
assert.deepEqual(availability.approved([{ ...timedRow, allDay: true }], [1]), [{ memberId: 1, startDate: date, endDate: date }], 'explicit all-day redaction retains its legacy shape');
for (const value of ['00:00', '01:30', '02:30', '09:00', '23:59']) assert.equal(availability.validTime(value), true, value);
for (const value of ['', '9:00', '24:00', '12:60', '-1:00', '09:00:00', ' 09:00', null, 900, {}, []]) assert.equal(availability.validTime(value), false, JSON.stringify(value));
for (const [start, end, conflict] of [['07:00', '09:00', false], ['10:00', '15:00', false], ['09:00', '10:00', true], ['08:59', '09:01', true], ['09:59', '10:01', true], ['00:00', '23:59', true]]) {
  assert.equal(availability.onDate([timed()], 1, date, start, end), conflict, `${start}-${end} uses half-open overlap`);
  assert.deepEqual(availability.conflicts([timed()], [1], [date], start, end), conflict ? { conflictMemberIds: [1], conflictDates: [date] } : emptyConflicts);
}
assert.equal(availability.onDate([timed()], '1', date), true, 'a day badge can show any partial absence');
assert.equal(availability.onDate([timed()], 1, date, '24:00', '25:00'), false);
assert.equal(availability.onDate([timed()], 1, date, '10:00'), false, 'incomplete shift bounds do not imply an all-day query');
for (const overrides of [{ startDate: '2026-02-30' }, { endDate: '2026-10-12' }, { startTime: '24:00' }, { endTime: '09:00' }, { allDay: 'false' }, { startTime: null }]) assert.deepEqual(availability.approved([{ ...timedRow, ...overrides }], [1]), [], 'malformed saved rows do not silently become all-day leave');
const summaryInput = [timed(), timed(1, date, '09:30', '10:30'), timed(1, date, '10:30', '11:00'), timed(1, date, '13:00', '14:00'), timed(1, '2026-10-12'), { memberId: 1, startDate: '2026-10-12', endDate: '2026-10-14' }, timed(2)];
const summaryBefore = JSON.stringify(summaryInput);
assert.deepEqual(availability.summarize(summaryInput, [{ id: 1, name: 'Worker' }], [date, '2026-10-12', '2026-10-13', '2026-10-14']), [{ memberId: 1, name: 'Worker', ranges: [{ startDate: date, endDate: date, allDay: false, startTime: '09:00', endTime: '11:00' }, { startDate: date, endDate: date, allDay: false, startTime: '13:00', endTime: '14:00' }, { startDate: '2026-10-12', endDate: '2026-10-14' }] }]);
assert.equal(JSON.stringify(summaryInput), summaryBefore, 'summary merges cloned ranges without mutating input');
assert.deepEqual(availability.summarize([timed(), timed(1, '2026-10-12')], [{ id: 1 }], [date, '2026-10-12'])[0].ranges.map(row => [row.startDate, row.endDate]), [[date, date], ['2026-10-12', '2026-10-12']], 'timed absences never merge into an all-day or multi-day absence');
for (const day of ['2026-03-08', '2026-11-01']) {
  assert.equal(availability.onDate([timed(1, day, '01:30', '03:30')], 1, day, '02:00', '03:00'), true, 'DST dates use company-local wall times without instant conversion');
  assert.equal(availability.onDate([timed(1, day, '01:30', '03:30')], 1, day, '03:30', '04:00'), false);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-partial-leave-'));
const dbFile = path.join(root, 'db.json');
const companyA = '11111111-1111-4111-8111-111111111111';
const companyB = '22222222-2222-4222-8222-222222222222';
const token = (company, user) => `synthetic-partial-leave-${company}-${user}`;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(companyId) {
  const users = [
    { id: 1, role: 'owner' },
    { id: 2, role: 'admin', permissions: { manageTime: true } },
    { id: 3, role: 'project_manager', permissions: { scheduleCrews: true } },
    { id: 4, role: 'project_manager', permissions: { viewTime: true, scheduleCrews: true } },
    { id: 5, role: 'project_manager', permissions: { manageTime: true, scheduleCrews: true } },
    { id: 6, role: 'field', memberId: 1 },
    { id: 7, role: 'foreman', memberId: 2 },
    { id: 8, role: 'field' }
  ].map(user => ({ companyId, name: `Synthetic user ${user.id}`, email: `qa-${user.id}@example.invalid`, status: 'Active', emailVerifiedAt: '2026-01-01T00:00:00Z', projectIds: [1], assignedCrews: ['QA crew'], ...user }));
  return {
    company: { id: companyId, name: 'Synthetic partial leave workspace', demo: true, timezone: 'America/Los_Angeles', features: { timeCards: true } },
    users,
    sessions: users.map(user => ({ id: crypto.randomUUID(), companyId, userId: user.id, tokenHash: hash(token(companyId, user.id)), expiresAt: '2099-01-01T00:00:00Z' })),
    team: [{ id: 1, name: 'Synthetic Worker', initials: 'SW', role: 'Laborer', crew: 'QA crew' }, { id: 2, name: 'Other Worker', initials: 'OW', role: 'Laborer', crew: 'Other crew' }],
    projects: [{ id: 1, name: 'Synthetic project', code: 'QA', estimateItems: [] }],
    reports: [], assignments: [], customers: [], subcontractors: [], photos: [], workdays: [], changes: [], auditLog: [],
    projectNotesTodos: [{ id: 'preserved-note', projectId: 1, text: 'PRIVATE-PROJECT-NOTE', history: [] }],
    timeOffRequests: companyId === companyA ? [
      { id: 'legacy', memberId: 1, startDate: '2026-10-10', endDate: '2026-10-10', status: 'approved', type: 'sick', note: privateDetail, history: [] },
      { id: 'timed', ...timedRow },
      { id: 'outside', ...timed(2, '2026-10-13', '13:00', '14:00'), status: 'approved', type: 'other', note: privateDetail, history: [] }
    ] : []
  };
}
const initial = fixture(companyA);
fs.mkdirSync(path.join(root, 'tenants'));
fs.writeFileSync(dbFile, JSON.stringify(initial));
fs.writeFileSync(path.join(root, 'tenants', `${companyB}.json`), JSON.stringify(fixture(companyB)));
fs.writeFileSync(path.join(root, 'platform.json'), JSON.stringify({ users: [], sessions: [], notes: [] }));
let child, base, serverLog;
async function startServer() {
  const env = { ...process.env, PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: path.join(root, 'platform.json'), PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_REQUIRE_AUTH: '1', PDL_EMAIL_DEV_MODE: '1', TZ: 'America/Los_Angeles' };
  for (const key of ['SENTRY_DSN', 'RESEND_API_KEY', 'OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) delete env[key];
  serverLog = '';
  child = spawn(process.execPath, ['-e', "const {server}=require('./server');server.listen(0,'127.0.0.1',()=>console.log('LEAVE_TEST_PORT='+server.address().port));"], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Synthetic leave server did not start: ' + serverLog)), 15000);
    child.stdout.on('data', bytes => { serverLog += String(bytes); const match = serverLog.match(/LEAVE_TEST_PORT=(\d+)/); if (match) { base = `http://127.0.0.1:${match[1]}`; clearTimeout(timeout); resolve(); } });
    child.stderr.on('data', bytes => { serverLog += String(bytes); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Synthetic leave server exited ${code}: ${serverLog}`)); });
  });
}
async function stopServer() { if (!child || child.exitCode != null) return; const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; child = null; }
async function request(method, route, user = 1, input, company = companyA, extras = {}) {
  const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', 'X-PDL-Company': company, ...(user == null ? {} : { Authorization: `Bearer ${token(company, user)}` }), ...extras }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  return { status: response.status, data: await response.json() };
}
async function expectStatus(expected, ...args) { const result = await request(...args); assert.equal(result.status, expected, `${args[0]} ${args[1]} user ${args[2]}: ${JSON.stringify(result.data)}`); return result.data; }
const read = () => JSON.parse(fs.readFileSync(dbFile, 'utf8'));
const leaveInput = (overrides = {}) => ({ startDate: '2026-10-20', endDate: '2026-10-20', allDay: false, startTime: '09:00', endTime: '10:00', type: 'other', note: privateDetail, ...overrides });
const assignment = (day = date, start = '09:00', end = '10:00', memberIds = [1], overrides = {}) => ({ projectId: 1, memberIds, date: day, start, end, activity: 'Synthetic work', ...overrides });
const deleteAssignment = id => expectStatus(200, 'DELETE', `/api/assignments/${id}`, 1, {});

(async () => {
  try {
    await startServer();
    assert.equal((await fetch(base + '/time-off-partial-day.test.js')).status, 404, 'synthetic API tests are not served publicly');
    await expectStatus(401, 'GET', '/api/time-off-requests', null);
    for (const user of [1, 2, 3, 4, 5, 8]) await expectStatus(403, 'POST', '/api/time-off-requests', user, leaveInput());
    await expectStatus(403, 'GET', '/api/time-off-requests', 3);
    assert.deepEqual((await expectStatus(200, 'GET', '/api/time-off-requests', 6)).map(row => row.id).sort(), ['legacy', 'timed']);
    assert.deepEqual((await expectStatus(200, 'GET', '/api/time-off-requests', 7)).map(row => row.id), ['outside']);
    assert.deepEqual((await expectStatus(200, 'GET', '/api/time-off-requests', 4)).map(row => row.id).sort(), ['legacy', 'timed'], 'time-view PM sees only assigned crew requests');
    for (const [user, memberIds] of [[1, [1, 2]], [2, [1, 2]], [3, [1]], [6, [1]], [7, [2]]]) {
      const rows = await expectStatus(200, 'GET', '/api/schedule-availability', user);
      assert.ok(rows.every(row => memberIds.includes(row.memberId)));
      assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|type|note|history|status|requestId/);
      if (memberIds.includes(1)) assert.deepEqual(rows.find(row => row.startDate === date), timed());
    }
    const state = await expectStatus(200, 'GET', '/api/state', 3);
    assert.ok(state.scheduleAvailability.some(row => row.allDay === false));
    assert.equal(state.timeOffRequests, undefined);
    assert.equal(state.projectNotesTodos, undefined);
    assert.doesNotMatch(JSON.stringify(state), /PRIVATE-LEAVE-DETAIL|PRIVATE-PROJECT-NOTE/);
    assert.deepEqual(await expectStatus(200, 'GET', '/api/schedule-availability', 1, undefined, companyB), []);
    await expectStatus(401, 'GET', '/api/schedule-availability', 1, undefined, companyA, { 'X-PDL-Company': companyB });
    for (const user of [3, 4, 6, 7]) for (const action of ['approve', 'decline']) await expectStatus(403, 'POST', `/api/time-off-requests/timed/${action}`, user, {});
    for (const action of ['approve', 'decline']) await expectStatus(404, 'POST', `/api/time-off-requests/outside/${action}`, 5, {});
    await expectStatus(404, 'POST', '/api/time-off-requests/timed/approve', 1, {}, companyB);
    const beforeInvalid = read().timeOffRequests;
    for (const overrides of [
      { startDate: '2026-02-30', endDate: '2026-02-30' }, { startDate: '2026-02-29', endDate: '2026-02-29' }, { startDate: '2026-04-31', endDate: '2026-04-31' },
      { startDate: '2026-2-01' }, { endDate: '2026-10-19' }, { startDate: null }, { endDate: 20261020 }, { startDate: ['2026-10-20'] },
      { allDay: 'false' }, { allDay: 'true' }, { allDay: 0 }, { allDay: 1 }, { allDay: null }, { allDay: {} },
      { endDate: '2026-10-21' }, { endTime: '09:00' }, { endTime: '08:00' }, { startTime: '23:00', endTime: '01:00' },
      { startTime: '9:00' }, { startTime: '24:00' }, { endTime: '12:60' }, { startTime: '09:00:00' }, { endTime: ' 10:00' }, { startTime: null },
      { startTime: undefined }, { endTime: undefined }, { requestId: '' }, { requestId: null }, { requestId: 'bad id 123' }, { requestId: 'a'.repeat(129) }
    ]) await expectStatus(400, 'POST', '/api/time-off-requests', 6, leaveInput(overrides));
    for (const input of [null, [], 'text']) await expectStatus(400, 'POST', '/api/time-off-requests', 6, input);
    assert.deepEqual(read().timeOffRequests, beforeInvalid, 'invalid leave never persists');
    const idempotentInput = leaveInput({ requestId: crypto.randomUUID(), memberId: 2, status: 'approved', reviewedBy: 'spoof' });
    const created = await expectStatus(201, 'POST', '/api/time-off-requests', 6, idempotentInput);
    assert.equal(created.memberId, 1, 'request member is bound to authenticated field account');
    assert.equal(created.status, 'pending');
    assert.equal(created.reviewedBy, undefined);
    assert.equal(created.allDay, false);
    assert.equal(created.startTime, '09:00');
    assert.equal(created.endTime, '10:00');
    assert.equal((await expectStatus(200, 'POST', '/api/time-off-requests', 6, idempotentInput)).id, created.id);
    for (const changed of [{ endTime: '10:30' }, { allDay: true }, { note: 'Different note' }]) await expectStatus(409, 'POST', '/api/time-off-requests', 6, { ...idempotentInput, ...changed });
    const concurrentInput = leaveInput({ startDate: '2026-10-27', endDate: '2026-10-27', requestId: crypto.randomUUID() });
    const retries = await Promise.all([request('POST', '/api/time-off-requests', 6, concurrentInput), request('POST', '/api/time-off-requests', 6, concurrentInput)]);
    assert.deepEqual(retries.map(row => row.status).sort(), [200, 201]);
    assert.equal(retries[0].data.id, retries[1].data.id, 'simultaneous retries create one record');
    const sameIdOtherMember = await expectStatus(201, 'POST', '/api/time-off-requests', 7, idempotentInput);
    assert.equal(sameIdOtherMember.memberId, 2);
    assert.notEqual(sameIdOtherMember.id, created.id);
    assert.equal((await expectStatus(201, 'POST', '/api/time-off-requests', 6, idempotentInput, companyB)).memberId, 1, 'request IDs stay within tenant');
    const allDay = await expectStatus(201, 'POST', '/api/time-off-requests', 6, leaveInput({ startDate: '2026-10-21', endDate: '2026-10-23', allDay: true }));
    assert.equal(allDay.allDay, true);
    assert.equal(allDay.startTime, undefined);
    assert.equal(allDay.endTime, undefined);
    const legacyInput = { startDate: '2026-10-24', endDate: '2026-10-25', type: 'vacation', note: 'All day default' };
    const legacyCreated = await expectStatus(201, 'POST', '/api/time-off-requests', 6, legacyInput);
    assert.equal(legacyCreated.allDay, true, 'old clients without allDay still create all-day requests');
    const pendingShift = await expectStatus(201, 'POST', '/api/assignments', 1, assignment('2026-10-20'));
    assert.equal(availability.onDate(await expectStatus(200, 'GET', '/api/schedule-availability'), 1, '2026-10-20'), false, 'pending hours do not block scheduling');
    await expectStatus(200, 'POST', `/api/time-off-requests/${created.id}/approve`, 5, { note: privateDetail });
    assert.ok(read().assignments.some(row => row.id === pendingShift.id), 'approval preserves existing assignments for explicit reassignment');
    assert.equal((await expectStatus(200, 'POST', '/api/time-off-requests', 6, idempotentInput)).status, 'approved', 'retry after review returns the existing reviewed request');
    await deleteAssignment(pendingShift.id);
    for (const [start, end] of [['07:00', '09:00'], ['10:00', '15:00'], ['00:00', '00:30'], ['23:30', '23:59']]) {
      const permitted = await expectStatus(201, 'POST', '/api/assignments', 1, assignment(date, start, end, [1], { endDate: '' }));
      await deleteAssignment(permitted.id);
    }
    for (const [start, end] of [['09:00', '10:00'], ['08:59', '09:01'], ['09:59', '10:01'], ['07:00', '15:00']]) {
      const conflict = await expectStatus(409, 'POST', '/api/assignments', 1, assignment(date, start, end));
      assert.equal(conflict.code, 'approved_time_off_conflict');
      assert.deepEqual(conflict.conflictDates, [date]);
      assert.doesNotMatch(JSON.stringify(conflict), /PRIVATE|sick|history|requestId/);
    }
    for (const shift of [assignment('2026-02-30'), assignment(date, '24:00', '25:00'), assignment(date, '09:60', '10:00'), assignment(date, '9:00', '10:00'), assignment(date, '07:00', '09:00', [999]), assignment(date, '07:00', '09:00', [1], { endDate: '2026-02-30' })]) await expectStatus(400, 'POST', '/api/assignments', 1, shift);
    assert.equal(read().assignments.length, 0, 'denied assignments never partially save');
    await expectStatus(409, 'POST', '/api/assignments', 1, assignment('2026-10-10', '15:00', '16:00'));
    await expectStatus(409, 'POST', '/api/assignments', 3, assignment());
    await expectStatus(403, 'POST', '/api/assignments', 3, assignment('2026-10-13', '13:00', '14:00', [2]));
    for (const user of [6, 7]) {
      const denial = await expectStatus(403, 'POST', '/api/assignments', user, assignment());
      assert.doesNotMatch(JSON.stringify(denial), /approved_time_off|conflictDates/);
    }
    const source = await expectStatus(201, 'POST', '/api/assignments', 1, assignment('2026-10-12'));
    const originalSource = read().assignments.find(row => row.id === source.id);
    await expectStatus(409, 'PATCH', `/api/assignments/${source.id}`, 1, { ...assignment(), edit: true });
    await expectStatus(409, 'PATCH', `/api/assignments/${source.id}`, 1, { memberId: 1, targetMemberId: 1, date });
    assert.deepEqual(read().assignments.find(row => row.id === source.id), originalSource, 'conflicting edit and drag remain atomic');
    await expectStatus(400, 'PATCH', `/api/assignments/${source.id}`, 1, { ...assignment(date, '24:00', '25:00'), edit: true });
    await expectStatus(400, 'PATCH', `/api/assignments/${source.id}`, 1, { memberId: 1, targetMemberId: 1, date: '2026-02-30' });
    const edited = await expectStatus(200, 'PATCH', `/api/assignments/${source.id}`, 1, { ...assignment(date, '07:00', '09:00'), edit: true });
    assert.equal(edited.assignment.end, '09:00', 'editing to an adjacent shift is allowed');
    await expectStatus(200, 'PATCH', `/api/assignments/${source.id}`, 1, { memberId: 1, targetMemberId: 1, date: '2026-10-12' });
    await expectStatus(200, 'PATCH', `/api/assignments/${source.id}`, 1, { memberId: 1, targetMemberId: 1, date });
    await deleteAssignment(source.id);
    const group = await expectStatus(201, 'POST', '/api/assignments', 1, assignment('2026-10-12', '13:00', '14:00', [1, 2]));
    const groupBefore = read().assignments.find(row => row.id === group.id);
    await expectStatus(409, 'PATCH', `/api/assignments/${group.id}`, 1, { memberId: 1, targetMemberId: 2, date: '2026-10-13' });
    assert.deepEqual(read().assignments.find(row => row.id === group.id), groupBefore, 'conflicting multi-person drag does not split or alter source');
    await expectStatus(200, 'PATCH', `/api/assignments/${group.id}`, 1, { ...assignment('2026-10-12', '12:00', '13:00', [1, 2]), edit: true });
    const split = await expectStatus(200, 'PATCH', `/api/assignments/${group.id}`, 1, { memberId: 1, targetMemberId: 2, date: '2026-10-13' });
    assert.deepEqual(split.assignment.memberIds, [2]);
    assert.deepEqual(split.sourceAssignment.memberIds, [2]);
    assert.equal(split.assignment.date, '2026-10-13', 'an adjacent shift can split safely onto another person');
    await deleteAssignment(split.assignment.id); await deleteAssignment(group.id);
    const copySource = await expectStatus(201, 'POST', '/api/assignments', 1, assignment('2026-10-12'));
    await expectStatus(409, 'POST', '/api/assignments', 1, { ...copySource, date });
    const copy = await expectStatus(201, 'POST', '/api/assignments', 1, { ...copySource, date, start: '10:00', end: '11:00' });
    assert.notEqual(copy.id, copySource.id);
    await deleteAssignment(copy.id); await deleteAssignment(copySource.id);
    await expectStatus(409, 'POST', '/api/assignments', 1, assignment(date, '09:00', '10:00', [1], { endDate: '2026-10-12', includeWeekends: true }));
    assert.equal(read().assignments.length, 0, 'multi-day conflict rejects all dates atomically');
    const range = await expectStatus(201, 'POST', '/api/assignments', 1, assignment(date, '07:00', '09:00', [1], { endDate: '2026-10-12', includeWeekends: true }));
    assert.deepEqual(range.assignments.map(row => row.date), [date, '2026-10-12']);
    for (const row of range.assignments) await deleteAssignment(row.id);
    const weekdays = await expectStatus(201, 'POST', '/api/assignments', 1, assignment(date, '09:00', '10:00', [1], { endDate: '2026-10-12', includeWeekends: false }));
    assert.equal(weekdays.date, '2026-10-12', 'excluded weekend leave does not block weekday copies');
    await deleteAssignment(weekdays.id);
    for (const day of ['2026-03-08', '2026-11-01']) {
      const dstRequest = await expectStatus(201, 'POST', '/api/time-off-requests', 6, leaveInput({ startDate: day, endDate: day, startTime: '01:30', endTime: '03:30' }));
      await expectStatus(200, 'POST', `/api/time-off-requests/${dstRequest.id}/approve`, 2, {});
      const redacted = (await expectStatus(200, 'GET', '/api/schedule-availability')).find(row => row.startDate === day);
      assert.deepEqual(redacted, timed(1, day, '01:30', '03:30'));
      await expectStatus(409, 'POST', '/api/assignments', 1, assignment(day, '02:00', '03:00'));
      const adjacent = await expectStatus(201, 'POST', '/api/assignments', 1, assignment(day, '03:30', '04:00'));
      await deleteAssignment(adjacent.id);
    }
    const dstRange = await expectStatus(201, 'POST', '/api/assignments', 1, assignment('2026-03-07', '00:00', '01:00', [1], { endDate: '2026-03-09', includeWeekends: true }));
    assert.deepEqual(dstRange.assignments.map(row => row.date), ['2026-03-07', '2026-03-08', '2026-03-09'], 'range iteration stays on calendar dates across server-local DST');
    for (const row of dstRange.assignments) await deleteAssignment(row.id);
    const leap = await expectStatus(201, 'POST', '/api/time-off-requests', 6, leaveInput({ startDate: '2028-02-29', endDate: '2028-02-29' }));
    assert.equal(leap.startDate, '2028-02-29');
    await expectStatus(200, 'POST', '/api/time-off-requests/timed/decline', 1, {});
    const reopened = await expectStatus(201, 'POST', '/api/assignments', 1, assignment());
    await deleteAssignment(reopened.id);
    await expectStatus(200, 'POST', '/api/time-off-requests/timed/approve', 1, {});
    await expectStatus(200, 'POST', `/api/time-off-requests/${allDay.id}/approve`, 1, {});
    for (const day of ['2026-10-21', '2026-10-22', '2026-10-23']) await expectStatus(409, 'POST', '/api/assignments', 1, assignment(day, '15:00', '16:00'));
    const persisted = read();
    assert.deepEqual(persisted.timeOffRequests.find(row => row.id === 'legacy'), initial.timeOffRequests[0], 'legacy stored record remains untouched');
    assert.deepEqual(persisted.projectNotesTodos, initial.projectNotesTodos, 'project Notes data remains untouched');
    const parts = splitSnapshot(persisted);
    assert.deepEqual(assembleSnapshot(parts.scalarData, parts.records).timeOffRequests, persisted.timeOffRequests, 'timed leave survives transactional snapshot split/assembly');
    await stopServer(); await startServer();
    const afterRestart = await expectStatus(200, 'GET', '/api/time-off-requests', 6);
    assert.deepEqual(afterRestart.find(row => row.id === created.id), persisted.timeOffRequests.find(row => row.id === created.id), 'timed request, history and review survive restart');
    assert.equal((await expectStatus(200, 'POST', '/api/time-off-requests', 6, idempotentInput)).id, created.id, 'idempotent retry survives restart');
    assert.deepEqual((await expectStatus(200, 'GET', '/api/schedule-availability')).find(row => row.startDate === date), timed());
    await expectStatus(409, 'POST', '/api/assignments', 1, assignment());
    const allowedAfterRestart = await expectStatus(201, 'POST', '/api/assignments', 1, assignment(date, '10:00', '11:00'));
    await deleteAssignment(allowedAfterRestart.id);
    console.log('Partial-day leave passed: strict dates/times, legacy all-day compatibility, idempotent requests, scoped roles/privacy, half-open create/edit/drag/copy/range conflicts, DST wall times, transactional serialization and restart persistence.');
  } finally { await stopServer(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
