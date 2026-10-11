'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fixture } = require('./fixtures/project-assistant');
const { memoryStore, changes } = require('./fixtures/assistant-ai');
const { createAIHandler } = require('./project-assistant-ai');
const { createProjectAssistantHandler } = require('./project-assistant');
const { modelPayload, PRICE } = require('./project-assistant-intent');

let assertions = 0, providerCalls = 0, previews = 0, confirmations = 0;
function check(value, message) { assertions++; assert.ok(value, message); }
const parse = payload => JSON.parse(payload.input);
const rosterMarkers = ['Generated Roster Alpha', 'Generated Roster Beta', 'Private member', 'Private synthetic site'];
function noGeneratedPeople(payload) {
  const input = parse(payload), serialized = JSON.stringify(input);
  check(!Object.hasOwn(input, 'memberNames'), 'provider input has no generated roster');
  for (const key of ['people', 'memberId', 'memberIds']) check(!Object.hasOwn(input.draft, key), 'provider draft excludes ' + key);
  for (const marker of rosterMarkers) check(!serialized.includes(marker), 'generated context excludes ' + marker);
  return input;
}
function projectionProofs() {
  const context = { project: { id: 101, name: 'Synthetic site A' }, projects: [{ id: 101, name: 'Synthetic site A' }], today: '2026-10-07', timezone: 'America/Los_Angeles' };
  Object.defineProperty(context, 'members', { get() { throw Error('Provider projection must not read the roster'); } });
  for (const action of ['note', 'todo', 'schedule', 'schedule_batch', undefined]) {
    const state = { projectId: 101, draft: { action, text: 'Exact user text', deadline: 'none', people: 'Generated Roster Alpha', memberId: 11, memberIds: [11, 12], activity: 'Generated Roster Beta', instructions: 'Generated Roster Alpha' }, mentions: {}, question: 'Did you mean Generated Roster Alpha (ID 11)?', pending: { kind: 'people', choices: [[11], [12]] } };
    // Scheduling activity/instructions are user draft content, so use ordinary
    // task text there; note/to-do projection must ignore irrelevant fields.
    if (!['note', 'todo'].includes(action)) { state.draft.activity = 'Frame wall'; state.draft.instructions = 'Check layout'; }
    const before = JSON.stringify(state), input = noGeneratedPeople(modelPayload(context, state, 'Gate closes at 5.', PRICE));
    check(JSON.stringify(state) === before, 'projection does not mutate draft/state');
    check(input.projectName === context.project.name && input.timezone === context.timezone, 'selected project and company timezone preserved');
    check(!input.lastQuestion.includes('ID 11'), 'generated people question contains no candidate IDs');
    if (['note', 'todo'].includes(action)) check(Object.keys(input.draft).sort().join(',') === 'action,deadline,text', 'note/to-do contains only relevant draft fields');
  }
  const explicit = modelPayload(context, { projectId: 101, draft: { action: 'note', text: 'Jordan Sample supplied this note.' }, mentions: {}, pending: null }, 'Jordan Sample supplied this note.', PRICE);
  check(parse(explicit).request === 'Jordan Sample supplied this note.' && parse(explicit).draft.text === 'Jordan Sample supplied this note.', 'literal names supplied by the user remain intact');
}
function harness() {
  let db = fixture(), businessWrites = 0;
  db.team[0].name = 'Generated Roster Alpha'; db.team[1].name = 'Generated Roster Beta';
  const calls = [], sessionId = crypto.randomUUID(), store = memoryStore();
  const common = { readDb: () => db, readFreshDb: () => db, authenticatedUser: () => db.users[1], accountAccess: () => ({ locked: false }), body: async req => req.input, json: (res, status, data) => Object.assign(res, { status, data }), now: () => new Date('2026-10-07T16:00:00Z') };
  const ai = createAIHandler({ ...common, store, enabled: () => true, signingKey: () => 'synthetic-provider-projection-only', adapter: async payload => {
    calls.push(payload); providerCalls++; const input = noGeneratedPeople(payload), text = input.request;
    let result;
    if (text === 'Schedule Candidate Roster tomorrow') result = { action: 'schedule', people: 'Candidate Roster', date: 'tomorrow' };
    else if (text === 'Add a to-do: Check gate; no deadline') result = { action: 'todo', text: 'Check gate', deadline: 'no deadline' };
    else if (text === 'Change text: Gate opens at 9.') result = { text: 'Gate opens at 9.' };
    else result = { action: 'note', text: 'Gate closed.' };
    return { changes: changes(result), usage: { input_tokens: 100, output_tokens: 100 } };
  } });
  const manual = createProjectAssistantHandler({ ...common, writeDb: async next => { db = next; businessWrites++; } });
  async function request(path, input) { const req = { method: input ? 'POST' : 'GET', input }, res = {}; if (!await ai(req, res, new URL('http://synthetic.invalid' + path))) await manual(req, res, new URL('http://synthetic.invalid' + path)); return res; }
  async function turn(text, state, extra = {}) { return request('/api/assistant/interpret', { text, state, projectId: 101, sessionId, turnId: crypto.randomUUID(), ...extra }); }
  async function save(result) {
    const preview = await request('/api/projects/101/assistant/preview', result.data.draft); previews++;
    check(preview.status === 200 && preview.data.token, 'redacted interpretation still reaches exact manual preview');
    check(businessWrites === 0, 'interpretation and preview make no business write');
    const input = { token: preview.data.token, version: preview.data.version, confirmed: true };
    const saved = await request('/api/projects/101/assistant/confirm', input); confirmations++;
    check(saved.status === 201 && businessWrites === 1, 'explicit confirmation saves exactly once');
    const replay = await request('/api/projects/101/assistant/confirm', input); confirmations++;
    check(replay.status === 200 && businessWrites === 1, 'confirmation replay does not repeat the effect');
    check(db.assignments.length === 0 && db.projectNotesTodos.length === 1, 'note/to-do creates no schedule');
  }
  return { turn, request, save, calls, get db() { return db; }, get writes() { return businessWrites; } };
}
async function handlerProofs() {
  for (const action of ['note', 'todo']) {
    const h = harness(), before = JSON.stringify(h.db), text = action === 'todo' ? 'Add a to-do: Check gate; no deadline' : 'Add a note: Gate closed.';
    let result = await h.turn(text);
    check(result.status === 200 && result.data.ready && result.data.draft.action === action, 'fresh selected-project ' + action + ' interpretation is ready');
    check(JSON.stringify(h.db) === before && h.writes === 0, 'fresh interpretation leaves business state unchanged');
    const draft = { action, text: 'Existing user text', deadline: 'none', memberId: 11, memberIds: [11, 12], activity: 'Generated Roster Alpha', instructions: 'Generated Roster Beta', date: '2026-10-08' };
    result = await h.turn('Change text: Gate opens at 9.', result.data.state, { draft });
    check(result.data.ready && result.data.draft.text === 'Gate opens at 9.', 'manual note/to-do correction keeps exact literal text');
    check(Object.keys(parse(h.calls.at(-1)).draft).sort().join(',') === 'action,deadline,text', 'irrelevant manual scheduling details are absent from provider input');
    const invalidPreview = await h.request('/api/projects/101/assistant/preview', result.data.draft);
    check(invalidPreview.status === 400 && h.writes === 0, 'existing exact preview rejects a note/to-do carrying scheduling fields');
    result = await h.turn('Change text: Gate opens at 9.', result.data.state, { draft: { action, text: 'Existing user text', deadline: 'none' } });
    await h.save(result);
    check(h.db.projectNotesTodos[0].text === 'Gate opens at 9.', 'confirmed record preserves reviewed text');
  }
  const transition = harness(); transition.db.team[0].name = transition.db.team[1].name = 'Candidate Roster';
  const scheduled = await transition.turn('Schedule Candidate Roster tomorrow');
  check(scheduled.data.pending && scheduled.data.message.includes('Candidate Roster'), 'server retains authorized person clarification');
  const note = await transition.turn('Add a note: Gate closed.', scheduled.data.state);
  check(note.data.ready && note.data.draft.action === 'note', 'scheduling clarification can switch to a note');
  check(!JSON.stringify(parse(transition.calls.at(-1))).includes('Candidate Roster'), 'schedule-to-note dispatch excludes prior generated candidate labels');
  check(parse(transition.calls.at(-1)).lastQuestion.startsWith('Which authorized people'), 'provider receives a generic people question');
  await transition.save(note);
  const replay = harness(), input = { text: 'Add a note: Gate closed.', projectId: 101, sessionId: crypto.randomUUID(), turnId: crypto.randomUUID() };
  const first = await replay.request('/api/assistant/interpret', input), second = await replay.request('/api/assistant/interpret', input);
  check(first.data.ready && second.data.ready && replay.calls.length === 1 && replay.writes === 0, 'turn replay reuses bounded result without provider or business effect');
  const disclosure = await replay.request('/api/assistant/context');
  check(disclosure.data.disclosure.includes('Team choices are resolved on the server'), 'disclosure describes the actual provider projection');
}
async function main() {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw Error('External provider calls forbidden in redaction regressions'); };
  try { projectionProofs(); await handlerProofs(); console.log(JSON.stringify({ result: 'passed', assertions, syntheticProviderCalls: providerCalls, previews, confirmations, externalCalls: 0, coverage: ['no provider roster reads', 'known/unknown action projection', 'note/to-do irrelevant-field removal', 'literal user text retained', 'schedule-to-note pending-name redaction', 'actual handler preview/explicit-confirm/idempotency', 'no business write from interpretation', 'turn replay and disclosure'] })); }
  finally { global.fetch = originalFetch; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
