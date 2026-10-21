'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { main } = require('./database/migrate-transactional');
const { CONFIRMATION, parseArgs } = require('./database/transactional-backfill');

const sha256 = 'a'.repeat(64);
const common = [
  '--all',
  '--evidence', path.resolve('backfill-evidence.json'),
  '--production-target', 'abcdefghijklmnopqrst',
  '--expected-service-id', 'srv-abcdefghijklmnopqrst',
  '--expected-instance-id', 'instance-transactional-backfill',
  '--expected-population-manifest', path.resolve('population.json'),
  '--expected-population-sha256', sha256
];

assert.equal(typeof main, 'function');
assert.equal(parseArgs(common).apply, false);
assert.throws(() => parseArgs([]), /requires --all/);
assert.throws(() => parseArgs([...common, '--company-id', 'qa-id']), /Unsupported transactional backfill argument/);
assert.throws(() => parseArgs([...common, '--apply']), /confirm-population-sha256/);
assert.equal(parseArgs([
  ...common,
  '--apply',
  '--confirm-population-sha256', sha256,
  '--confirm-action', CONFIRMATION
]).apply, true);

console.log('Transactional migration safety tests passed.');
