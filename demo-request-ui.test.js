'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('landing-demo.js', 'utf8');
let handler, resetCount = 0, nextId = 0, responseMode = 'failure', release;
const requests = [], button = { disabled: false, textContent: 'Request my demo' }, status = {};
let fields = { name: 'Synthetic Buyer', email: 'buyer@example.test', company: 'Synthetic Contractor', website: '' };
const form = {
  querySelector: () => button,
  addEventListener: (event, callback) => { assert.equal(event, 'submit'); handler = callback; },
  reset: () => { resetCount++; }
};
const context = {
  document: {
    querySelector: selector => ({ '#demo-request-form': form, '#demo-form-status': status })[selector] || null,
    querySelectorAll: () => []
  },
  localStorage: { getItem: () => '' },
  crypto: { randomUUID: () => `synthetic-request-${++nextId}` },
  FormData: class { entries() { return Object.entries(fields); } },
  fetch: async (url, options) => {
    if (url === '/api/auth/me') return { ok: false };
    assert.equal(url, '/api/demo-requests');
    requests.push(JSON.parse(options.body));
    if (responseMode === 'held') await new Promise(resolve => { release = resolve; });
    if (responseMode === 'network-error') throw Error('Synthetic lost response');
    return { ok: responseMode !== 'failure', json: async () => responseMode === 'failure'
      ? { error: 'We could not confirm your demo request was saved. Please try again.' } : { ok: true } };
  }
};
vm.createContext(context);
vm.runInContext(source, context);
const submit = () => handler({ preventDefault() {} });

(async () => {
  await submit();
  assert.equal(resetCount, 0, 'failed requests retain the entered fields');
  assert.equal(button.disabled, false, 'failed requests re-enable retry');
  assert.match(status.textContent, /could not confirm/);
  const initialId = requests[0].requestId;

  responseMode = 'network-error';
  await submit();
  assert.equal(requests[1].requestId, initialId, 'ambiguous network failure retains the same intent');
  assert.equal(resetCount, 0);
  responseMode = 'success';
  await submit();
  assert.equal(requests[2].requestId, initialId, 'successful retry uses the same server deduplication key');
  assert.equal(resetCount, 1);
  assert.match(status.textContent, /request is in.*confirm the time/);

  responseMode = 'failure';
  await submit();
  assert.notEqual(requests[3].requestId, initialId, 'new submission after success has a new intent');
  fields = { ...fields, notes: 'Show scheduling' };
  await submit();
  assert.notEqual(requests[4].requestId, requests[3].requestId, 'edited request gets a new intent');

  responseMode = 'held';
  const held = submit();
  assert.equal(button.disabled, true);
  const beforeDuplicate = requests.length;
  await submit();
  assert.equal(requests.length, beforeDuplicate, 'repeated submit cannot overlap');
  release();
  await held;
  assert.equal(button.disabled, false);
  responseMode = 'success';
  delete context.crypto.randomUUID;
  await submit();
  assert.match(requests.at(-1).requestId, /^demo-[a-zA-Z0-9_-]+$/, 'older browser fallback still submits');
  assert.ok(requests.at(-1).requestId.length >= 16);
  fields = { ...fields, preferredTime: '2026-10-12T09:30' };
  await submit();
  const timed = requests.at(-1);
  assert.equal(timed.preferredTimeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(timed.preferredTimeUtc, new Date(fields.preferredTime).toISOString());
  assert.match(status.textContent, /no calendar slot is reserved/);
  fields = { ...fields, preferredTime: '2026-02-30T09:30' };
  const beforeInvalid = requests.length;
  await submit();
  assert.equal(requests.length, beforeInvalid, 'normalized invalid date must not submit');
  assert.match(status.textContent, /valid preferred meeting time/);
  console.log('Demo request UI passed: retained fields, stable retry IDs, new/edited intent, lost response, and duplicate-submit guard.');
})().catch(error => { console.error(error); process.exitCode = 1; });
