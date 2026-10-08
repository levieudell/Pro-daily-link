'use strict';
// Disposable localhost suite instrumentation; never loaded by the application.
const { splitSnapshot, assembleSnapshot, canonicalHash } = require('../database/transactional-repository');
function differences(expected, actual) {
  const result = [];
  const describe = value => ({ type: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value, class: Object.prototype.toString.call(value), ...(Array.isArray(value) ? { length: value.length, entries: Object.keys(value).length } : {}), hash: canonicalHash({ value }) });
  function compare(left, right, key = '$') {
    if (result.length >= 24 || canonicalHash({ value: left }) === canonicalHash({ value: right })) return;
    if (left && right && typeof left === 'object' && typeof right === 'object' && Array.isArray(left) === Array.isArray(right)) {
      let found = result.length;
      for (const child of new Set([...Object.keys(left), ...Object.keys(right)])) compare(left[child], right[child], key + '.' + child);
      if (found === result.length) result.push({ path: key, expected: describe(left), actual: describe(right) });
    } else result.push({ path: key, expected: describe(left), actual: describe(right) });
  }
  compare(expected, actual); return result;
}
function observeWrites() {
  const url = new URL(process.env.SUPABASE_URL);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || process.env.SUPABASE_SECRET_KEY !== 'synthetic-only-atomic-stub') throw Error('Synthetic snapshot diagnostics require the disposable localhost bridge');
  const adapter = require('../database/supabase'), save = adapter.saveTransactionalSnapshot;
  adapter.saveTransactionalSnapshot = function (snapshot, revision, guard) {
    const packed = splitSnapshot(snapshot);
    const reconstructed = assembleSnapshot(JSON.parse(JSON.stringify(packed.scalarData)), JSON.parse(JSON.stringify(packed.records)));
    const expectedHash = canonicalHash(snapshot), actualHash = canonicalHash(reconstructed);
    if (expectedHash !== actualHash) console.error('SYNTHETIC_WRITE_DIAGNOSTIC=' + JSON.stringify({ revision, expectedHash, actualHash, differences: differences(snapshot, reconstructed) }));
    return save.call(this, snapshot, revision, guard);
  };
}
module.exports = { observeWrites, differences };
