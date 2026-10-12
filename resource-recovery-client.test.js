'use strict';
// Actual browser module in a private VM, exercising only local marker retirement.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const target = path.join(__dirname, 'resource-review-ui.js');
const source = fs.readFileSync(target, 'utf8');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const A = 'b0576860-a3d9-4bb6-aae2-b5e7186cbb71', B = 'ba19a156-1cac-4c8a-b921-6bc356df97ef', key = 'pdl-resource-original-save-v1';
const row = { companyId: A, actorId: 1, role: 'owner', sessionBinding: 'a'.repeat(64), authority: 'b'.repeat(64), method: 'POST', path: '/api/customers', token: '12345678-1234-4234-8234-123456789001', version: 'c'.repeat(64), requestId: 'synthetic-original-request' };
const identity = { companyId: A, actorId: 1, role: 'owner', sessionBinding: 'a'.repeat(64), authority: 'b'.repeat(64), revision: 7 };
async function scenario(label, initial, changed, expectedRetired) {
  let next = { ...initial }, displayed = 7;
  const map = new Map([[key, JSON.stringify(row)]]), checkbox = { checked: true }, button = {}, status = { textContent: '' };
  const section = { dataset: {}, innerHTML: '', querySelector: selector => selector === 'input' ? checkbox : button };
  const document = { createElement: () => section, getElementById: () => null, addEventListener() {} };
  const box = { querySelector: selector => selector === '[role=status]' ? status : null, append(value) { this.section = value; } };
  const context = { window: { addEventListener() {}, pdlWorkspaceActions: { enabled: () => true, displayedRevision: () => displayed, identity: async () => ({ ...next }) } }, document, sessionStorage: { getItem: name => map.has(name) ? map.get(name) : null, setItem: (name, value) => map.set(name, value), removeItem: name => map.delete(name) }, Date, Error, JSON, crypto: crypto.webcrypto, TextEncoder, Uint8Array };
  vm.createContext(context);
  vm.runInContext(source.replace('window.pdlResourceActions={', 'window.__independentReconcile=reconcile; window.pdlResourceActions={'), context);
  context.window.__independentReconcile(box, row);
  await checkbox.onchange();
  if (changed) next = { ...next, ...changed };
  await button.onclick();
  const retired = !map.has(key);
  assert.equal(retired, expectedRetired, label);
  if (expectedRetired) {
    const entry = JSON.parse(map.get(key + '-retired'))[0];
    assert.equal(entry.companyId, A); assert.equal(entry.actorId, 1); assert.equal(entry.result, 'unknown');
  } else assert.equal(map.has(key + '-retired'), false, label);
  return { case: label, markerRetired: retired, message: status.textContent, serverEffect: false };
}
(async () => {
  const checks = [];
  checks.push(await scenario('foreign company with coincident revision', { ...identity, companyId: B }, null, false));
  checks.push(await scenario('foreign actor with coincident revision', { ...identity, actorId: 2 }, null, false));
  for (const [field, value] of [['companyId', B], ['actorId', 2], ['role', 'admin'], ['sessionBinding', 'd'.repeat(64)], ['authority', 'e'.repeat(64)], ['revision', 8]]) checks.push(await scenario('changed reviewed ' + field, identity, { [field]: value }, false));
  checks.push(await scenario('same originating company/account and unchanged reviewed identity', identity, null, true));
  assert.equal(hash(fs.readFileSync(target, 'utf8')), hash(source), 'Moving UI source changed during these probes');
  console.log(JSON.stringify({ sourceSha256: hash(source), sourceStableForProbe: true, syntheticOnly: true, servicesStarted: false, databaseUsed: false, browserUsed: false, checks }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
