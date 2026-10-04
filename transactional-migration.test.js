'use strict';

const assert = require('node:assert/strict');
const { parseArgs, selectSnapshots } = require('./database/migrate-transactional');

assert.deepEqual(parseArgs([]), { apply: false, all: false, companyId: '' });
assert.deepEqual(parseArgs(['--apply', '--company-id', 'qa-id']), { apply: true, all: false, companyId: 'qa-id' });
assert.throws(() => parseArgs(['--apply']), /Refusing an unscoped migration/);
assert.throws(() => parseArgs(['--apply', '--all', '--company-id', 'qa-id']), /either --company-id or --all/);
assert.throws(() => parseArgs(['--company-id']), /requires a company UUID/);

const snapshots = [
  { company: { id: 'qa-id', name: 'QA' } },
  { company: { id: 'archived', archivedDuplicate: true } },
  { platform: true, company: { id: 'platform' } }
];
assert.deepEqual(selectSnapshots(snapshots, '').map(row => row.company.id), ['qa-id']);
assert.deepEqual(selectSnapshots(snapshots, 'qa-id').map(row => row.company.id), ['qa-id']);
assert.throws(() => selectSnapshots(snapshots, 'missing'), /Company snapshot not found/);

console.log('Transactional migration safety tests passed.');
