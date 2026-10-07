'use strict';
const assert = require('node:assert/strict');
const { createProjectNoteRecord, createProjectNotesHandler, contentSnapshot, presentItem, dueDateValue } = require('./project-notes');
const { projectNoteCard } = require('./project-notes-ui');

const user = { id: 7, name: 'Synthetic manager', role: 'project_manager' };
const at = '2026-10-07T12:00:00.000Z';
const input = () => ({ companyId: 'synthetic-company', projectId: 3, user, requestId: 'synthetic-request', kind: 'todo', text: '  Inspect west wall\r\nRecord the measurements.  ', at });

async function main() {
  const original = input(), before = structuredClone(original), legacy = createProjectNoteRecord(original);
  assert.deepEqual(original, before, 'record builder does not mutate its inputs');
  assert.match(legacy.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...legacy, id: 'generated' }, {
    id: 'generated', companyId: 'synthetic-company', projectId: 3, requestId: 'synthetic-request', kind: 'todo',
    text: 'Inspect west wall\nRecord the measurements.', completed: false, revision: 1,
    createdBy: user.name, createdByUserId: user.id, createdAt: at,
    updatedBy: user.name, updatedByUserId: user.id, updatedAt: at,
    history: [{ action: 'Created', by: user.name, userId: user.id, at, before: null,
      after: { text: 'Inspect west wall\nRecord the measurements.', completed: false, revision: 1 } }]
  }, 'deadline-free records and history retain their original shapes');
  assert.equal(Object.hasOwn(presentItem(legacy), 'dueDate'), false);
  assert.deepEqual(dueDateValue('todo', {}), {});

  const dated = createProjectNoteRecord({ ...input(), dueDate: '2028-02-29' });
  assert.equal(dated.dueDate, '2028-02-29');
  assert.equal(contentSnapshot(dated).dueDate, '2028-02-29');
  assert.equal(presentItem(dated).history[0].after.dueDate, '2028-02-29');
  const cleared = createProjectNoteRecord({ ...input(), dueDate: null });
  assert.equal(Object.hasOwn(cleared, 'dueDate'), true); assert.equal(cleared.dueDate, null);
  assert.equal(presentItem(cleared).history[0].after.dueDate, null);
  for (const dueDate of ['', undefined, 'today', '2026-02-29', '2028-02-30', '2028-2-29', '2028-02-29T12:00:00Z', 20280229, {}, false]) {
    assert.throws(() => createProjectNoteRecord({ ...input(), dueDate }), error => error.statusCode === 400, String(dueDate));
  }
  for (const dueDate of [null, '2028-02-29']) assert.throws(() => createProjectNoteRecord({ ...input(), kind: 'note', dueDate }), /Only to-dos/);
  assert.throws(() => createProjectNoteRecord({ ...input(), requestId: 'short' }), error => error.statusCode === 400);

  const db = { company: { id: 'synthetic-company', timezone: 'America/Los_Angeles' }, projects: [{ id: 3 }], projectNotesTodos: [] };
  let writes = 0;
  const handler = createProjectNotesHandler({ readDb: () => db, writeDb: () => writes++, body: async req => req.input,
    authenticatedUser: () => user, canAccessProject: () => true, json: (res, status, data) => Object.assign(res, { status, data }) });
  async function call(method, data, id = '') {
    const res = {}; await handler({ method, input: data }, res, new URL('http://synthetic/api/projects/3/notes-todos' + (id ? '/' + id : ''))); return res;
  }
  const create = { kind: 'todo', text: 'Inspect west wall', requestId: 'synthetic-create-1', dueDate: '2028-02-29' };
  const saved = await call('POST', create); assert.equal(saved.status, 201); assert.equal(writes, 1);
  const id = saved.data.id; assert.equal(saved.data.dueDate, create.dueDate);
  assert.equal(saved.data.history[0].after.dueDate, create.dueDate);
  assert.equal((await call('POST', create)).status, 200); assert.equal(writes, 1);
  for (const changed of [{ ...create, dueDate: '2028-03-01' }, { ...create, dueDate: null }, { kind: create.kind, text: create.text, requestId: create.requestId }]) {
    const result = await call('POST', changed); assert.equal(result.status, 409); assert.equal(result.data.code, 'PROJECT_NOTE_REQUEST_CONFLICT');
  }
  assert.equal(writes, 1, 'different deadlines cannot reuse a create request ID');

  const edited = await call('PATCH', { revision: 1, dueDate: '2028-03-01' }, id);
  assert.equal(edited.status, 200); assert.equal(edited.data.revision, 2); assert.equal(writes, 2);
  assert.equal(edited.data.history[1].before.dueDate, '2028-02-29');
  assert.equal(edited.data.history[1].after.dueDate, '2028-03-01');
  const replay = await call('POST', create); assert.equal(replay.status, 200); assert.equal(replay.data.revision, 2); assert.equal(replay.data.dueDate, '2028-03-01');
  assert.equal((await call('POST', { ...create, dueDate: '2028-03-01' })).status, 409, 'create replay compares the original deadline after later edits');
  assert.equal((await call('PATCH', { revision: 1, dueDate: null }, id)).status, 409); assert.equal(writes, 2);
  const textEdit = await call('PATCH', { revision: 2, text: 'Inspect east wall' }, id);
  assert.equal(textEdit.data.dueDate, '2028-03-01'); assert.equal(textEdit.data.revision, 3); assert.equal(writes, 3);
  assert.equal((await call('PATCH', { revision: 3, dueDate: '2028-03-01' }, id)).data.revision, 3); assert.equal(writes, 3, 'unchanged deadline is a no-op');
  const removed = await call('PATCH', { revision: 3, dueDate: null }, id);
  assert.equal(removed.data.dueDate, null); assert.equal(removed.data.revision, 4);
  assert.equal(removed.data.history.at(-1).before.dueDate, '2028-03-01'); assert.equal(removed.data.history.at(-1).after.dueDate, null);
  const completed = await call('PATCH', { revision: 4, completed: true }, id);
  assert.equal(completed.data.dueDate, null); assert.equal(completed.data.completed, true); assert.equal(completed.data.revision, 5);

  const deadlineFree = await call('POST', { kind: 'note', text: 'Project context', requestId: 'synthetic-note-1' });
  assert.equal(deadlineFree.status, 201); assert.equal(Object.hasOwn(deadlineFree.data, 'dueDate'), false);
  assert.equal(Object.hasOwn(deadlineFree.data.history[0].after, 'dueDate'), false);
  const writesBeforeInvalid = writes;
  assert.equal((await call('POST', { kind: 'note', text: 'Project context', requestId: 'synthetic-note-2', dueDate: null })).status, 400);
  assert.equal((await call('PATCH', { revision: 1, dueDate: '2028-02-29' }, deadlineFree.data.id)).status, 400);
  assert.equal((await call('PATCH', { revision: 5, dueDate: '2026-02-29' }, id)).status, 400);
  assert.equal(writes, writesBeforeInvalid, 'invalid deadline changes do not write');
  const list = await call('GET'); assert.equal(list.status, 200); assert.equal(Object.hasOwn(list.data.items.find(row => row.id === deadlineFree.data.id), 'dueDate'), false);

  assert.match(projectNoteCard(dated), /Due 2028-02-29/);
  assert.doesNotMatch(projectNoteCard(legacy), /project-note-deadline/);
  assert.doesNotMatch(projectNoteCard(cleared), /project-note-deadline/);
  assert.doesNotMatch(projectNoteCard({ ...dated, kind: 'note' }), /project-note-deadline/);
  const injected = projectNoteCard({ ...dated, dueDate: '<img src=x onerror=attack()>' });
  assert.ok(!injected.includes('<img')); assert.match(injected, /Due &lt;img/);
  console.log('Project note deadline tests passed: shared unsaved builder, legacy shapes, ISO/null validation, original-request replay, revisioned edits/history, preservation, and escaped calendar-date display.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
