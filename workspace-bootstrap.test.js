'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('./app.js'), 'utf8');
const declaration = source.match(/async function startWorkspaceAfterGate\(gate, start\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(declaration, 'Test the actual application entry gate');
assert.ok(source.includes('startWorkspaceAfterGate(window.pdlWorkspaceGate, boot);'));
const startAfterGate = vm.runInNewContext(declaration + '; startWorkspaceAfterGate');
(async () => {
  let calls = 0, resolve; const pending = new Promise(done => { resolve = done; });
  const start = () => { calls++; return 'started'; };
  const opening = startAfterGate(pending, start); await Promise.resolve(); assert.equal(calls, 0, 'No second bootstrap while the original auth gate is pending');
  resolve(true); assert.equal(await opening, 'started'); assert.equal(calls, 1);
  for (const value of [false, null, 'true', 1]) for (const gate of [value, Promise.resolve(value)]) { calls = 0; await startAfterGate(gate, start); assert.equal(calls, 0, 'Redirect/denial/unknown gate values never start the legacy workspace'); }
  calls = 0; const failure = Promise.reject(Error('Synthetic gate failed')); await assert.rejects(startAfterGate(failure, start), /Synthetic gate failed/); assert.equal(calls, 0);
  calls = 0; const legacy = startAfterGate(undefined, start); assert.equal(calls, 1, 'Absent legacy gate keeps immediate startup'); assert.equal(await legacy, 'started');
  // Positive discriminator: the former unconditional call starts while the same
  // original gate is unresolved, creating the observed competing renewal.
  calls = 0; const held = new Promise(() => {}); const corrected = startAfterGate(held, start); await Promise.resolve(); assert.equal(calls, 0); start(); assert.equal(calls, 1); void corrected;
  console.log('Workspace bootstrap passed: actual shared gate delays startup, scoped/denied/rejected gates never start it, exactly-once allowed startup, immediate legacy compatibility and former-call discriminator.');
})().catch(error => { console.error(error); process.exitCode = 1; });
