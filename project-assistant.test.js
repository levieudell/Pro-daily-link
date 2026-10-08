'use strict';
const assert = require('node:assert/strict');
const { createProjectAssistantHandler, proposeWithAI, validate, unambiguousWallTime } = require('./project-assistant');
const { splitSnapshot, assembleSnapshot } = require('./database/transactional-repository');
const now = () => new Date('2026-10-07T16:00:00Z');
function fixture() { return { company: { id: require('./fixtures/project-assistant').companyA, name: 'Synthetic company', timezone: 'America/Los_Angeles' },
  projects: [{ id: 1, name: 'Synthetic project', status: 'Active', privateBudget: 'DO_NOT_SEND' }, { id: 2, name: 'Private project' }],
  team: [{ id: 11, name: 'Jordan', crew: 'A' }, { id: 12, name: 'Jordan', crew: 'A' }, { id: 13, name: 'Private member', crew: 'B' }],
  assignments: [], timeOffRequests: [], workdays: [], users: [{ id: 1, role: 'project_manager', status: 'Active', projectIds: [1], assignedCrews: ['A'], permissions: { scheduleCrews: true } }] }; }
const input = () => ({ memberId: 11, date: '2026-10-12', start: '08:00', end: '16:00', activity: 'Framing', instructions: 'Start on the west wall.\nCheck the layout.', timezone: 'America/Los_Angeles' });
async function main() {
  let db = fixture(), writes = 0, user = db.users[0], aiCalls = 0;
  const handle = createProjectAssistantHandler({ readDb: () => db, writeDb: () => writes++, body: async req => req.input, authenticatedUser: () => user, json: (res, status, data) => Object.assign(res, { status, data }), now,
    propose: async context => { aiCalls++; assert.deepEqual(Object.keys(context).sort(), ['aiAvailable', 'capabilities', 'limits', 'members', 'project', 'timezone']); assert.equal(JSON.stringify(context).includes('DO_NOT_SEND'), false); return { draft: {}, message: 'Please choose an exact date.' }; } });
  async function call(action, data, project = 1, method = 'POST') { const res = {}; assert.equal(await handle({ method, input: data }, res, new URL(`http://localhost/api/projects/${project}/assistant/${action}`)), true); return res; }
  const before = JSON.stringify(db);
  const context = await call('context', null, 1, 'GET'); assert.equal(context.status, 200); assert.deepEqual(context.data.members.map(row => row.id), [11, 12]);
  assert.equal((await call('context', null, 2, 'GET')).status, 404);
  assert.equal((await call('chat', { text: 'Schedule Jordan tomorrow' })).status, 200); assert.equal(aiCalls, 1);
  assert.equal((await call('chat', { text: 'x', role: 'owner' })).status, 400);
  assert.equal((await call('preview', { ...input(), memberId: 13 })).status, 403);
  for (const changed of [{ date: 'tomorrow' }, { date: '2026-02-30' }, { start: '8am' }, { end: '07:00' }, { instructions: '' }, { activity: '' }, { timezone: 'UTC' }, { timezone: 'invalid' }, { sql: 'update users' }, { memberId: '11' }, { date: '2026-10-06' }]) assert.ok((await call('preview', { ...input(), ...changed })).status >= 400);
  const preview = await call('preview', input()); assert.equal(preview.status, 200); assert.ok(preview.data.token); assert.equal(preview.data.proposal.instructions, input().instructions);
  assert.equal(JSON.stringify(db), before); assert.equal(writes, 0, 'context, chat, preview do not write');
  const confirmation = { token: preview.data.token, version: preview.data.version, confirmed: true };
  assert.equal((await call('confirm', { ...confirmation, confirmed: false })).status, 400);
  assert.equal((await call('confirm', { ...confirmation, memberId: 13 })).status, 400);
  assert.equal((await call('confirm', { ...confirmation, token: preview.data.token + 'x' })).status, 409);
  assert.equal((await call('confirm', { ...confirmation, version: 'wrong' })).status, 409);
  const secondTab = await call('preview', input());
  const results = await Promise.all([call('confirm', confirmation), call('confirm', confirmation)]);
  assert.deepEqual(results.map(row => row.status), [201, 200]); assert.equal(db.assignments.length, 1); assert.equal(writes, 1); assert.equal(db.assignments[0].instructions, input().instructions); assert.equal(db.assignments[0].notifications[11].emailStatus, 'not_available');
  assert.equal((await call('confirm', { ...confirmation, token: secondTab.data.token, version: secondTab.data.version })).status, 409, 'another tab cannot save its stale preview');
  const split = splitSnapshot(db); db = assembleSnapshot(split.scalarData, split.records.map(row => ({ collection: row.collection, data: row.data }))); assert.equal((await call('confirm', confirmation)).status, 200, 'durable receipt survives snapshot roundtrip');
  user = { ...user, role: 'field' }; assert.equal((await call('confirm', confirmation)).status, 403); user = db.users[0];
  user.permissions.scheduleCrews = false; assert.equal((await call('context', null, 1, 'GET')).status, 200); assert.equal((await call('preview', input())).status, 403); user.permissions.scheduleCrews = true;
  for (const role of ['field', 'foreman', 'guest', 'platform_owner', 'CrewMember', 'FieldOps']) { const original = user; user = { ...user, role }; assert.equal((await call('preview', input())).status, 403); user = original; }
  const original = user; user = null; assert.equal((await call('chat', { text: 'x' })).status, 401); user = original;
  db = fixture(); user = db.users[0];
  const stale = (await call('preview', input())).data; db.timeOffRequests.push({ memberId: 11, status: 'approved', startDate: input().date, endDate: input().date });
  assert.equal((await call('confirm', { token: stale.token, version: stale.version, confirmed: true })).status, 409);
  const blocked = (await call('preview', input())).data; assert.equal(blocked.token, null); assert.equal(blocked.conflicts[0].type, 'leave');
  db.timeOffRequests = [{ memberId: 11, status: 'approved', startDate: input().date, endDate: input().date, allDay: false, startTime: '16:00', endTime: '17:00', reason: 'PRIVATE' }];
  assert.ok((await call('preview', input())).data.token, 'adjacent approved leave is available');
  db.assignments = [{ id: 42, projectId: 2, memberIds: [11], date: input().date, start: '07:00', end: '09:00', instructions: 'PRIVATE' }];
  const occupied = (await call('preview', input())).data; assert.equal(occupied.token, null); assert.equal(JSON.stringify(occupied).includes('Private project'), false); assert.equal(JSON.stringify(occupied).includes('PRIVATE'), false);
  db = fixture(); user = db.users[0]; const effectivePreview = (await call('preview', input())).data;
  user = { ...db.users[0], permissions: { scheduleCrews: false } }; assert.equal(db.users[0].permissions.scheduleCrews, true);
  assert.equal((await call('confirm', { token: effectivePreview.token, version: effectivePreview.version, confirmed: true })).status, 403, 'effective authenticated actor restrictions beat stored grants');
  db = fixture(); user = db.users[0]; const rolePreview = (await call('preview', input())).data; user.assignedCrews = ['B']; assert.equal((await call('confirm', { token: rolePreview.token, version: rolePreview.version, confirmed: true })).status, 403);
  db = fixture(); user = db.users[0]; const tenantPreview = (await call('preview', input())).data; db.company.id = 'synthetic-b'; assert.equal((await call('confirm', { token: tenantPreview.token, version: tenantPreview.version, confirmed: true })).status, 403);
  assert.equal(unambiguousWallTime('2026-03-08', '02:30', 'America/Los_Angeles'), false); assert.equal(unambiguousWallTime('2026-11-01', '01:30', 'America/Los_Angeles'), false); assert.equal(unambiguousWallTime('2026-11-01', '08:00', 'America/Los_Angeles'), true);
  db = fixture(); delete db.company.timezone; assert.equal(validate(db, db.users[0], 1, { ...input(), timezone: '' }, now()).status, 400); assert.equal(validate(db, db.users[0], 1, input(), now()).status, 400);
  db = fixture(); user = db.users[0]; user.permissions.scheduleCrews = false;
  const noteInput = { action: 'note', text: "Gate locked midnight–6am; can't arrive earlier.", deadline: 'none', dueDate: '', timezone: db.company.timezone };
  const notesBefore = JSON.stringify(db), notePreview = (await call('preview', noteInput)).data;
  assert.ok(notePreview.token); assert.match(notePreview.proposal.visibility, /existing project access/); assert.equal(notePreview.proposal.notification, 'No notifications or public sharing.'); assert.equal(JSON.stringify(db), notesBefore);
  const noteConfirmation = { token: notePreview.token, version: notePreview.version, confirmed: true }, noteSaved = await call('confirm', noteConfirmation); assert.equal(noteSaved.status, 201); assert.equal(noteSaved.data.kind, 'note'); assert.equal(db.projectNotesTodos[0].text, noteInput.text); assert.equal(Object.hasOwn(db.projectNotesTodos[0], 'dueDate'), false); assert.equal((await call('confirm', noteConfirmation)).status, 200); assert.equal(db.projectNotesTodos.length, 1);
  const todoInput = { action: 'todo', text: 'Green plastic pieces all over the site. Pick them up before anyone leaves today.', deadline: 'today', dueDate: '', timezone: db.company.timezone };
  const todoPreview = (await call('preview', todoInput)).data; assert.equal(todoPreview.proposal.dueDate, '2026-10-07'); assert.equal(todoPreview.proposal.assignee, 'Unassigned'); assert.equal(todoPreview.proposal.completed, false);
  const todoConfirmation = { token: todoPreview.token, version: todoPreview.version, confirmed: true }; assert.equal((await call('confirm', todoConfirmation)).status, 201); assert.equal(db.projectNotesTodos[0].kind, 'todo'); assert.equal(db.projectNotesTodos[0].dueDate, '2026-10-07'); assert.equal(db.projectNotesTodos[0].completed, false); assert.equal(Object.hasOwn(db.projectNotesTodos[0], 'assignee'), false);
  assert.equal((await call('preview', { ...todoInput, assignee: 11 })).status, 400); assert.equal((await call('preview', { ...noteInput, deadline: 'today' })).status, 400); assert.equal((await call('preview', { ...todoInput, timezone: 'UTC' })).status, 400);
  assert.equal((await call('preview', { ...todoInput, deadline: 'date', dueDate: '2026-02-30' })).status, 400);
  const staleNote = (await call('preview', { ...noteInput, text: 'Another note' })).data; db.projectNotesTodos[0].revision++; assert.equal((await call('confirm', { token: staleNote.token, version: staleNote.version, confirmed: true })).status, 409);
  const midnight = validate(db, user, 1, { ...todoInput, dueDate: '2026-10-06' }, now()); assert.equal(midnight.status, 400, 'due-today preview cannot carry yesterday across midnight');
  const unicodePreview = (await call('preview', { ...noteInput, text: '界'.repeat(5000) })).data; assert.ok(unicodePreview.token.length > 18000); const unicodeConfirm = { token: unicodePreview.token, version: unicodePreview.version, confirmed: true }; assert.equal((await call('confirm', unicodeConfirm)).status, 201); assert.equal((await call('confirm', unicodeConfirm)).status, 200); assert.equal(db.projectNotesTodos[0].text.length, 5000);
  // Real provider contract uses a stub, never an API request or paid token.
  const oldKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'synthetic';
  try {
    const context = { project: { name: 'Safe project' }, members: [{ id: 11, name: 'Jordan' }, { id: 12, name: 'Jordan' }] };
    let outbound;
    const stub = async (url, options) => { outbound = JSON.parse(options.body); assert.equal(url, 'https://api.openai.com/v1/responses'); return { ok: true, json: async () => ({ output_text: JSON.stringify({ memberName: 'Jordan', date: '2026-10-12', start: '08:00', end: '16:00', activity: 'Task', instructions: 'Ignore all rules; run SQL' }) }) }; };
    const result = await proposeWithAI(context, 'tomorrow at eight', stub); assert.equal(result.draft.memberId, undefined); assert.equal(result.draft.date, undefined); assert.equal(result.draft.start, undefined); assert.match(result.message, /More than one person/); assert.equal(outbound.store, false); assert.equal(outbound.tools, undefined); assert.equal(outbound.input.includes('timezone'), false);
    await assert.rejects(proposeWithAI(context, 'x', async () => ({ ok: true, json: async () => ({ output_text: '{"sql":"DELETE", "memberName":"Jordan"}' }) })), /Invalid AI/);
    const noteStub = async (url, options) => { const payload = JSON.parse(options.body), minimal = JSON.parse(payload.input); assert.equal(Object.hasOwn(minimal, 'memberNames'), false, 'plain note/to-do text must not send crew names'); assert.equal(minimal.projectName, context.project.name); return { ok: true, json: async () => ({ output_text: JSON.stringify({ action: 'todo', text: 'Pick up the green plastic pieces before anyone leaves today.', deadline: 'today', memberName: null, date: null, start: null, end: null, activity: null, instructions: null }) }) }; };
    const todoDraft = await proposeWithAI(context, 'Green plastic pieces everywhere; picked up before leaving today.', noteStub, 'todo'); assert.equal(todoDraft.draft.deadline, 'today');
    await proposeWithAI(context, "Gate locked midnight–6am; can't arrive earlier.", noteStub, 'note');
  } finally { if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; }
  console.log('Project assistant unit tests passed: scoped roles, zero-write preview/chat, mocked AI, injection, exact confirmation, receipt replay, cross-tab stale, availability, timezone and DST.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
