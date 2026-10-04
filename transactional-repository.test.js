'use strict';

const assert = require('node:assert/strict');
const { splitSnapshot, assembleSnapshot, canonicalHash, databaseCompanyId, RevisionConflictError } = require('./database/transactional-repository');

const source = {
  company: { id: 'northstar', name: 'Northstar', persistence: { revision: 7 } },
  users: [{ id: 2, email: 'owner@example.com' }, { id: 4, email: 'field@example.com' }],
  reports: [{ id: 10, notes: 'Placed concrete' }],
  settings: { locale: 'en' },
  sessions: [{ tokenHash: 'abc', expiresAt: '2030-01-01T00:00:00.000Z' }]
};

const { scalarData, records } = splitSnapshot(source);
assert.deepEqual(Object.keys(scalarData).sort(), ['company', 'settings']);
assert.equal(records.length, 4);
assert.equal(records.find(row => row.collection === 'reports').recordKey, 'id:10');
assert.equal(records.find(row => row.collection === 'sessions').recordKey, 'token:abc');
const restored = assembleSnapshot(scalarData, records.map(({ collection, data }) => ({ collection, data })));
assert.deepEqual(restored, source);
assert.equal(canonicalHash(restored), canonicalHash(source));
assert.match(databaseCompanyId('northstar'), /^[0-9a-f-]{36}$/);
assert.equal(databaseCompanyId('11111111-1111-1111-1111-111111111111'), '11111111-1111-1111-1111-111111111111');
const conflict = new RevisionConflictError(2, 3);
assert.equal(conflict.code, 'PDL_REVISION_CONFLICT');
console.log('Transactional repository unit tests passed.');


