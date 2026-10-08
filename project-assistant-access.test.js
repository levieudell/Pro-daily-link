'use strict';
const assert = require('node:assert/strict');
const { permittedCompany, assistantPath } = require('./project-assistant-access');
const { createProjectAssistantHandler } = require('./project-assistant');
const { createAIHandler } = require('./project-assistant-ai');
const { companyA, companyB, fixture } = require('./fixtures/project-assistant');
const { memoryStore } = require('./fixtures/assistant-ai');
assert.equal(companyA, '21c12cd3-4822-4b1e-94e8-beca44efc0b7');
assert.equal(permittedCompany(companyA), true);
for (const id of [companyB, undefined, null, {}, companyA.toUpperCase(), companyA + ' ', 'Forged Built']) assert.equal(permittedCompany(id), false);
for (const path of ['/api/assistant', '/api/assistant/context', '/api/assistant/future', '/api/projects/101/assistant/context', '/api/projects/invalid/assistant/future']) assert.equal(assistantPath(path), true);
for (const path of ['/api/assignments', '/api/projects/101/notes-todos', '/api/assistant-other', '/api/projects/101/assistant-other']) assert.equal(assistantPath(path), false);
async function main() {
  let db = fixture(companyB), writes = 0, providers = 0, bodies = 0, loads = 0;
  db.company.name = 'Forged Built';
  const store = memoryStore(), options = { readDb: () => db, readFreshDb: async () => db, authenticatedUser: () => db.users[0], accountAccess: () => ({ locked: false }), body: async req => { bodies++; return req.input; }, json: (res, status, data) => Object.assign(res, { status, data }) };
  const originalLoad = store.load; store.load = async () => { loads++; return originalLoad(); };
  const manual = createProjectAssistantHandler({ ...options, writeDb: () => writes++, propose: async () => providers++, proposeBatch: async () => providers++ });
  const ai = createAIHandler({ ...options, store, enabled: () => true, adapter: async () => { providers++; throw Error('Provider must not run'); } });
  for (const action of ['context', 'chat', 'preview', 'confirm']) {
    const res = {}; assert.equal(await manual({ method: action === 'context' ? 'GET' : 'POST', input: { companyId: companyA } }, res, new URL(`http://synthetic.invalid/api/projects/101/assistant/${action}`)), true); assert.equal(res.status, 403);
  }
  for (const path of ['/api/assistant/context', '/api/assistant/interpret']) { const res = {}; await ai({ method: 'POST', input: { companyId: companyA } }, res, new URL('http://synthetic.invalid' + path)); assert.equal(res.status, 403); }
  assert.deepEqual({ writes, providers, bodies, loads }, { writes: 0, providers: 0, bodies: 0, loads: 0 }, 'foreign tenant denial precedes any context, input, budget, provider or mutation');
  db = fixture(); const res = {}; await manual({ method: 'GET' }, res, new URL('http://synthetic.invalid/api/projects/101/assistant/context')); assert.equal(res.status, 200);
  const proposal = { action: 'note', text: 'Synthetic gate note', deadline: 'none', dueDate: '', timezone: 'America/Los_Angeles' }, preview = {};
  await manual({ method: 'POST', input: proposal }, preview, new URL('http://synthetic.invalid/api/projects/101/assistant/preview')); assert.ok(preview.data.token);
  db = fixture(companyB); const denied = {};
  await manual({ method: 'POST', input: { token: preview.data.token, version: preview.data.version, confirmed: true } }, denied, new URL('http://synthetic.invalid/api/projects/101/assistant/confirm')); assert.equal(denied.status, 403); assert.equal(writes, 0);
  console.log('Assistant pilot policy tests passed: exact tenant, fail closed, server handlers and stale confirmation.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
