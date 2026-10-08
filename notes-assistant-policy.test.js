'use strict';
// Pure provider mock and memory ledger; no credentials, network or account writes.
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { companyA } = require('./fixtures/project-assistant');
const { memoryStore, changes } = require('./fixtures/assistant-ai');
const { createBudget } = require('./project-assistant-budget');
const { createIntentService, modelPayload, PRICE } = require('./project-assistant-intent');
async function main() {
  let note = false, calls = 0;
  const store = memoryStore(), actor = { companyId: companyA, userId: 2, notesPolicyRevision: 1 }, now = () => new Date('2026-10-07T16:00:00Z');
  const context = () => ({ project: { id: 101, name: 'Synthetic selected site' }, projects: [{ id: 101, name: 'Synthetic selected site' }], members: [{ id: 11, name: 'Synthetic private crew name', crew: 'A' }], capabilities: { schedule: true, note, todo: note }, timezone: 'America/Los_Angeles', today: '2026-10-07' });
  const service = createIntentService({ budget: createBudget(store, now), now, enabled: () => true, signingKey: () => 'synthetic-only', contextFor: async () => context(), refresh: async () => actor, adapter: async () => { calls++; return { changes: changes({ action: 'note', text: 'Literal synthetic note' }), usage: { input_tokens: 100, output_tokens: 10 } }; } });
  const input = () => ({ projectId: 101, sessionId: crypto.randomUUID(), turnId: crypto.randomUUID(), text: 'Literal synthetic note' });
  const blocked = { ...input(), draft: { action: 'note', text: 'Literal synthetic note', deadline: 'none' } }, pristine = store.read();
  assert.equal((await service.turn(blocked, actor)).source, 'form'); assert.equal(calls, 0); assert.deepEqual(store.read(), pristine, 'Known denied notes never reserve budget or dispatch');
  const inferred = await service.turn(input(), actor); assert.equal(inferred.ready, false); assert.match(inferred.message, /unavailable/); assert.equal(calls, 1);
  note = true; const original = input(), response = await service.turn(original, actor); assert.equal(response.ready, true); const before = calls; note = false;
  const replay = await service.turn(original, actor); assert.equal(replay.ready, false); assert.match(replay.message, /unavailable/); assert.equal(calls, before, 'Replay uses fresh action capabilities without dispatch');
  const payload = JSON.parse(modelPayload(context(), { projectId: 101, draft: { action: 'note', memberId: 11, text: 'Literal note' }, question: '' }, 'Literal note', PRICE).input);
  assert.equal(payload.memberNames, undefined); assert.equal(payload.draft.people, undefined); assert.ok(!JSON.stringify(payload).includes('Synthetic private crew name'));
  console.log('Notes assistant pure mocks passed: denied known notes dispatch/reserve zero, inferred/replayed notes never ready after restriction, authorized project context suppresses generated crew names.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
