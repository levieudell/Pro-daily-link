'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { create, KEY, LIMIT } = require('./role-save-recovery');
const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
const identity = JSON.stringify(['synthetic-company', 1, 'owner', 'a'.repeat(64)]);
const record = { identity, kind: 'confirm', body: { previewId: crypto.randomUUID(), version: 'b'.repeat(64), requestId: crypto.randomUUID(), confirmed: true } };
const journal = create(storage); journal.remember('role-profiles', record);
const restarted = create(storage), restored = restarted.get('role-profiles', identity);
assert.deepEqual(restored.body, record.body); assert.equal(restored.hadUncertain, true);
assert.equal(restored.path, '/api/company/role-policy/confirm');
assert.equal(restarted.get('roles', identity), null);
for (const other of [JSON.stringify(['other-company', 1, 'owner', 'a'.repeat(64)]), JSON.stringify(['synthetic-company', 2, 'owner', 'a'.repeat(64)]), JSON.stringify(['synthetic-company', 1, 'owner', 'c'.repeat(64)]), JSON.stringify(['synthetic-company', 1, 'admin', 'a'.repeat(64)])]) assert.equal(restarted.get('role-profiles', other), null);
assert.equal(/reason|policies|capabilities|token|name|confirmed/.test(values.get(KEY)), false);
restarted.remember('role-profiles', restored); // Exact replay only.
assert.throws(() => restarted.remember('role-profiles', { ...record, body: { ...record.body, requestId: crypto.randomUUID() } }));
restarted.unresolved('role-profiles', restored); assert.equal(create(storage).get('role-profiles', identity).unresolved, true);
assert.throws(() => restarted.remember('role-profiles', restored));
restarted.forget('role-profiles', { ...restored, body: { ...restored.body, requestId: crypto.randomUUID() } }); assert.ok(restarted.get('role-profiles', identity));
restarted.forget('role-profiles', restored); assert.equal(create(storage).get('role-profiles', identity), null);
for (const bad of ['{', '{}', 'x'.repeat(32769), '[null]', JSON.stringify([{ ...JSON.parse(JSON.stringify({ identity, route: 'roles', previewId: record.body.previewId, version: record.body.version, requestId: record.body.requestId, state: 'pending' })), path: '/api/users/1' }])]) { values.set(KEY, bad); assert.throws(() => journal.get('roles', identity)); }
values.delete(KEY);
journal.remember('roles',record);journal.retire(journal.entries()[0]);assert.equal(journal.get('roles',identity),null);const next={...record,body:{...record.body,requestId:crypto.randomUUID()}};journal.remember('roles',next);assert.equal(journal.entries().length,2);assert.equal(journal.entries()[0].state,'retired-unknown');assert.deepEqual(journal.get('roles',identity).body,next.body);assert.throws(()=>journal.retire(journal.entries()[0]));journal.forget('roles',next);assert.equal(journal.entries().length,1);assert.equal(journal.entries()[0].state,'retired-unknown');
values.delete(KEY);
for (let index = 0; index < LIMIT; index++) journal.remember('roles', { ...record, identity: JSON.stringify(['company-' + index, 1, 'owner', 'a'.repeat(64)]), body: { ...record.body, requestId: crypto.randomUUID() } });
const full = values.get(KEY); assert.throws(() => journal.remember('roles', record)); assert.equal(values.get(KEY), full); // Never prune unresolved records.
for (const target of [{ getItem: () => { throw Error('denied'); } }, { getItem: () => null, setItem: () => { throw Error('quota'); } }, { getItem: () => null, setItem: () => {} }]) assert.throws(() => create(target).remember('roles', record));
console.log('Role save recovery passed: restart-safe exact identity, closed metadata, isolated tenant/owner/session/route, unresolved provenance, no pruning and fail-before-send capacity/storage checks.');
