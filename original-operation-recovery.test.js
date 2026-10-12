'use strict';
// Real WebCrypto hashing, memory storage only. No account, DB, browser, or provider.
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const Recovery = require('./original-operation-recovery');
const checks = [], test = (name, run) => checks.push({ name, run });
const companyId = '10000000-0000-4000-8000-000000000001';
const operationId = number => '00000000-0000-4000-8000-' + String(number).padStart(12, '0');
function memory() {
  const values = new Map(), controls = {};
  return { values, controls, get length() { return values.size; }, key: index => [...values.keys()][index] ?? null,
    getItem(key) { if (controls.readError) throw Error('synthetic read unavailable'); return values.get(key) ?? null; },
    setItem(key, value) { if (controls.quota) throw Error('synthetic quota'); values.set(key, controls.replace ? value + ' ' : value); },
    removeItem(key) { if (controls.removeError) throw Error('synthetic cleanup unavailable'); values.delete(key); } };
}
const create = storage => Recovery.create(storage, { crypto: crypto.webcrypto });
const row = (number = 1, extra = {}) => ({ version: 1, operationId: operationId(number), purpose: 'report-create', route: '/api/reports', target: { companyId, projectId: 101, resourceId: null }, identityDigest: 'a'.repeat(64), intentDigest: 'b'.repeat(64), createdAt: '2098-11-17T12:00:00.000Z', ...extra });
test('real SHA256 records no input text or raw session', async () => {
  const store = memory(), journal = create(store), privateText = 'SYNTHETIC-PASSWORD-EMAIL-PHOTO-FORM-NOT-PERSISTED';
  const identity = { companyId, actorId: 7, role: 'field', sessionBinding: 'c'.repeat(64) };
  const handle = row(1, { identityDigest: await journal.identityDigest(identity), intentDigest: await journal.intentDigest(privateText) });
  journal.remember(handle); assert.equal(journal.intentDigest instanceof Function, true);
  assert.equal(handle.intentDigest, crypto.createHash('sha256').update(privateText).digest('hex'));
  const raw = [...store.values.values()].join(''); assert.ok(!raw.includes(privateText)); assert.ok(!raw.includes(identity.sessionBinding)); assert.ok(!raw.includes('actorId'));
  assert.deepEqual(create(store).entries(), [handle]);
});
test('independent tab append cannot overwrite original handles', () => {
  const store = memory(), first = create(store), second = create(store);
  first.remember(row(1)); second.remember(row(2)); assert.deepEqual(first.entries().map(value => value.operationId).sort(), [operationId(1), operationId(2)]);
  assert.equal(store.values.size, 2); assert.throws(() => first.remember(row(1, { intentDigest: 'c'.repeat(64) }))); assert.equal(store.values.size, 2);
});
test('exact readback precedes dispatch and replacement bytes are retained', () => {
  const store = memory(), journal = create(store); store.controls.replace = true;
  assert.throws(() => journal.remember(row())); assert.equal(store.values.size, 1); const before = [...store.values]; assert.throws(() => journal.entries()); assert.deepEqual([...store.values], before);
});
test('quota denies new record and preserves original entries', () => {
  const store = memory(), journal = create(store); journal.remember(row()); const before = [...store.values]; store.controls.quota = true;
  assert.throws(() => journal.remember(row(2))); assert.deepEqual([...store.values], before);
});
test('cleanup failure keeps the exact original handle', () => {
  const store = memory(), journal = create(store); journal.remember(row()); store.controls.removeError = true;
  assert.throws(() => journal.reviewed(row())); assert.deepEqual(journal.entries(), [row()]);
});
test('explicit review removes only the selected exact original, never another tab', () => {
  const store = memory(), journal = create(store); journal.remember(row(1)); journal.remember(row(2)); journal.reviewed(row(1)); assert.deepEqual(journal.entries(), [row(2)]);
});
for (const change of [value => value.version = 2, value => value.purpose = 'constructor', value => value.route = '/api/platform/auth/forgot', value => value.target.projectId = '101', value => value.target.companyId = companyId.toUpperCase() + 'x', value => value.operationId = operationId(2), value => value.createdAt = 'yesterday', value => value.identityDigest = {}, value => value.intentDigest = 'A'.repeat(64), value => value.password = 'SYNTHETIC-PRIVATE']) {
  test('malformed/tampered closed handle is retained and denies writes: ' + String(change), () => {
    const store = memory(), journal = create(store), invalid = row(); change(invalid); store.values.set(Recovery.PREFIX + operationId(1), JSON.stringify(invalid)); const before = [...store.values];
    assert.throws(() => journal.entries()); assert.throws(() => journal.remember(row(3))); assert.deepEqual([...store.values], before);
  });
}
for (const raw of ['', 'null', 'false', '[]', '{', '{}']) test('invalid JSON row ' + JSON.stringify(raw) + ' remains untouched', () => {
  const store = memory(), journal = create(store); store.values.set(Recovery.PREFIX + operationId(1), raw); assert.throws(() => journal.entries()); assert.equal(store.values.get(Recovery.PREFIX + operationId(1)), raw);
});
test('unknown key version is a stopping condition, with no automatic migration', () => {
  const store = memory(), journal = create(store), key = 'pdl-original-operation-v2:' + operationId(1); store.values.set(key, JSON.stringify(row())); assert.throws(() => journal.entries()); assert.equal(store.values.size, 1); assert.ok(store.values.has(key));
});
test('old createdAt never prunes an uncertain operation', () => {
  const store = memory(), journal = create(store), old = row(1, { createdAt: '2000-01-01T00:00:00.000Z' }); journal.remember(old); assert.deepEqual(journal.entries(), [old]);
});
test('live journal pins erased originals, permits only original readonly lookup, never recreates storage', () => {
  const store = memory(), journal = create(store); journal.remember(row()); store.values.clear();
  assert.deepEqual(journal.entries(), [row()]); assert.throws(() => journal.assertOriginal(row())); assert.throws(() => journal.remember(row()));
  assert.deepEqual(journal.assertOriginal(row(), { readOnly: true }), row()); assert.equal(store.values.size, 0);
  journal.reviewed(row()); assert.deepEqual(journal.entries(), []); assert.equal(store.values.size, 0);
});
test('live pinned originals detect a changed valid record, not just invalid shape', () => {
  const store = memory(), journal = create(store); journal.remember(row()); const changed = row(1, { intentDigest: 'c'.repeat(64) }); store.values.set(Recovery.PREFIX + row().operationId, JSON.stringify(changed)); const before = [...store.values];
  assert.throws(() => journal.entries()); assert.throws(() => journal.assertOriginal(changed, { readOnly: true })); assert.deepEqual([...store.values], before);
});
test('capacity rejects without deleting or pruning old handles', () => {
  const store = memory(), journal = create(store); for (let index = 1; index <= Recovery.LIMIT; index++) journal.remember(row(index)); const before = [...store.values]; assert.throws(() => journal.remember(row(99))); assert.deepEqual([...store.values], before);
});
for (const value of [{ companyId, actorId: 0, role: 'owner', sessionBinding: 'a'.repeat(64) }, { companyId, actorId: 1, role: 'crew', sessionBinding: 'a'.repeat(64) }, { companyId, actorId: 1, role: 'owner', sessionBinding: 'RAW-SESSION-TOKEN' }, { companyId, actorId: 1, role: 'platform_owner', sessionBinding: 'a'.repeat(64) }, { companyId, actorId: 1, role: 'owner', sessionBinding: 'a'.repeat(64), grants: true }]) test('malformed authority is never converted into an identity binding', async () => { await assert.rejects(create(memory()).identityDigest(value)); });
(async () => { for (const { name, run } of checks) { try { await run(); } catch (error) { console.error(name); throw error; } } console.log(JSON.stringify({ passed: true, checks: checks.length, syntheticOnly: true, realWebCrypto: true, externalCalls: 0 })); })().catch(error => { console.error(error); process.exitCode = 1; });
