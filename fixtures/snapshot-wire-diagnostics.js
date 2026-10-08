'use strict';
// Disposable localhost suite instrumentation; never loaded by the application.
const { canonicalHash } = require('../database/transactional-repository');
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
module.exports = { differences };
