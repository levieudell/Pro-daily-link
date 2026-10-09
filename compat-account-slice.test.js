'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { canonicalHash } = require('./database/transactional-repository');
const { createCredentialDelivery, COLLECTION, stripPrivate } = require('./account-credential-delivery');
const { createRuntime } = require('./compat-account-runtime');
const { A, B, initial, snapshot, memory } = require('./compat-account-fixture');
const nextPassword = 'Synthetic new pass 2026';
const providerKeys = ['OPENAI_API_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'SENTRY_DSN', 'SUPABASE_SECRET_KEY', 'PDL_PLATFORM_KEY'];
async function deliveryChecks() {
  const store = memory(snapshot()), key = crypto.randomBytes(32), messages = [];
  const delivery = createCredentialDelivery({ key, origin: 'http://127.0.0.1:4011', load: store.load, commit: store.commit, send: async message => { messages.push(message); return { accepted: true }; } });
  let loaded = await store.load(A), result = delivery.requestReset(loaded.snapshot, 'OWNER@example.invalid');
  await store.commit(loaded.snapshot, loaded.revision);
  const job = store.current()[COLLECTION][0];
  assert.equal(JSON.stringify(job).includes('resetUrl'), false); assert.equal(job.custody.version, 1);
  assert.deepEqual(stripPrivate({ a: { [COLLECTION]: [job], resetTokenHash: job.tokenHash, name: 'Safe' } }), { a: { name: 'Safe' } });
  const dispatched = await Promise.allSettled([delivery.dispatch(A, result.jobId), delivery.dispatch(A, result.jobId)]);
  assert.equal(messages.length, 1); assert.ok(dispatched.some(item => item.status === 'fulfilled'));
  const token = new URL(messages[0].resetUrl).searchParams.get('token');
  assert.equal(JSON.stringify(store.current()).includes(token), false);
  assert.equal((await delivery.dispatch(A, result.jobId)).status, 'sent'); assert.equal(messages.length, 1);
  // Rotation wins before dispatch: old queued generation cannot be delivered.
  loaded = await store.load(A); const old = delivery.requestReset(loaded.snapshot, 'owner@example.invalid'); await store.commit(loaded.snapshot, loaded.revision);
  loaded = await store.load(A); delivery.requestReset(loaded.snapshot, 'owner@example.invalid'); await store.commit(loaded.snapshot, loaded.revision);
  assert.equal((await delivery.dispatch(A, old.jobId)).status, 'cancelled'); assert.equal(messages.length, 1);
  // Corrupted custody is uncertain, never echoed or sent.
  loaded = await store.load(A); const bad = delivery.requestReset(loaded.snapshot, 'owner@example.invalid'); loaded.snapshot[COLLECTION].at(-1).custody.tag = 'invalid'; await store.commit(loaded.snapshot, loaded.revision);
  assert.equal((await delivery.dispatch(A, bad.jobId)).status, 'uncertain'); assert.equal(messages.length, 1);
  // Unknown provider result remains uncertain without automatic resend.
  const unknown = createCredentialDelivery({ key, origin: 'http://127.0.0.1:4011', load: store.load, commit: store.commit, send: async () => { throw Error('Synthetic provider body contains private bearer data'); } });
  loaded = await store.load(A); const pending = unknown.requestReset(loaded.snapshot, 'owner@example.invalid'); await store.commit(loaded.snapshot, loaded.revision);
  assert.equal((await unknown.dispatch(A, pending.jobId)).status, 'uncertain'); assert.equal((await unknown.dispatch(A, pending.jobId)).status, 'uncertain');
  // Paused send admission is never reassigned after simulated expiry/restart.
  loaded = await store.load(A); const paused = delivery.requestReset(loaded.snapshot, 'owner@example.invalid'); await store.commit(loaded.snapshot, loaded.revision);
  let started, resume; const entered = new Promise(resolve => { started = resolve; }), wait = new Promise(resolve => { resume = resolve; });
  const slow = createCredentialDelivery({ key, origin: 'http://127.0.0.1:4011', load: store.load, commit: store.commit, send: async message => { started(); await wait; messages.push(message); return { accepted: true }; } });
  const running = slow.dispatch(A, paused.jobId); await entered;
  assert.equal((await delivery.dispatch(A, paused.jobId)).status, 'uncertain');
  loaded = await store.load(A); loaded.snapshot.users[0].status = 'Inactive'; await store.commit(loaded.snapshot, loaded.revision);
  resume(); await running; assert.equal(delivery.authorizeReset(store.current(), 'owner@example.invalid', new URL(messages.at(-1).resetUrl).searchParams.get('token')), null);
  // Invalid and missing expiry, duplicate identity and tampered origin deny.
  const db = snapshot(); db.users[0].resetTokenHash = job.tokenHash; db.users[0].resetExpiresAt = 'not-a-date';
  assert.equal(delivery.authorizeReset(db, db.users[0].email, token), null); delete db.users[0].resetExpiresAt; assert.equal(delivery.authorizeReset(db, db.users[0].email, token), null);
  db.users.push({ ...db.users[0], id: 2 }); assert.throws(() => delivery.requestReset(db, db.users[0].email), /recovery/);
  const ambiguous = snapshot(); ambiguous.users.push({ ...ambiguous.users[0], email: 'second@example.invalid' }); assert.throws(() => delivery.requestReset(ambiguous, ambiguous.users[0].email), /recovery/);
  const poisonedStore = memory(snapshot()), poisoned = createCredentialDelivery({ key, origin: 'http://127.0.0.1:4011', load: poisonedStore.load, commit: poisonedStore.commit, send: async () => { throw Error('Must not send'); } });
  loaded = await poisonedStore.load(A); const duplicate = poisoned.requestReset(loaded.snapshot, 'owner@example.invalid'); const copied = structuredClone(loaded.snapshot[COLLECTION][0]); copied.id = crypto.randomUUID(); loaded.snapshot[COLLECTION].push(copied); await poisonedStore.commit(loaded.snapshot, loaded.revision);
  await assert.rejects(poisoned.dispatch(A, duplicate.jobId), /recovery/);
  const contradictoryStore = memory(snapshot()), contradictory = createCredentialDelivery({ key, origin: 'http://127.0.0.1:4011', load: contradictoryStore.load, commit: contradictoryStore.commit, send: async () => ({ accepted: true, rejected: true }) });
  loaded = await contradictoryStore.load(A); const contradictoryJob = contradictory.requestReset(loaded.snapshot, 'owner@example.invalid'); await contradictoryStore.commit(loaded.snapshot, loaded.revision);
  assert.equal((await contradictory.dispatch(A, contradictoryJob.jobId)).status, 'uncertain');
  for (const malformed of [null, false, 0, '']) { const badState = snapshot(); badState[COLLECTION] = malformed; assert.throws(() => delivery.requestReset(badState, badState.users[0].email), /recovery/); }
  // A receipt cannot be attached to a different descriptor during a paused send.
  for (const mutate of [row => { row.generation = crypto.randomUUID(); }, row => { row.tokenHash = 'f'.repeat(64); }, row => { row.custody.tag = 'A'.repeat(22); }, row => { row.email = 'changed@example.invalid'; }, (row, db) => { db[COLLECTION] = null; }]) {
    const fencedStore = memory(snapshot()); let enteredSend, releaseSend, calls = 0;
    const entered = new Promise(resolve => { enteredSend = resolve; }), pause = new Promise(resolve => { releaseSend = resolve; });
    const fenced = createCredentialDelivery({ key, origin: 'http://127.0.0.1:4011', load: fencedStore.load, commit: fencedStore.commit, send: async () => { calls++; enteredSend(); await pause; return { accepted: true }; } });
    let current = await fencedStore.load(A); const queued = fenced.requestReset(current.snapshot, 'owner@example.invalid'); await fencedStore.commit(current.snapshot, current.revision);
    const sending = fenced.dispatch(A, queued.jobId); await entered;
    current = await fencedStore.load(A); mutate(current.snapshot[COLLECTION][0], current.snapshot); await fencedStore.commit(current.snapshot, current.revision); const poisonedRevision = fencedStore.revision();
    releaseSend(); assert.deepEqual(await sending, { status: 'uncertain' }); assert.equal(fencedStore.revision(), poisonedRevision); assert.equal(calls, 1);
    if (fencedStore.current()[COLLECTION]) { assert.equal((await fenced.dispatch(A, queued.jobId)).status, 'uncertain'); assert.equal(calls, 1); }
  }
}
async function httpChecks() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-compat-account-'));
  const legacy = snapshot(); legacy.company.id = B; legacy.users[0].companyId = B;
  const file = path.join(directory, 'db.json'); fs.writeFileSync(file, JSON.stringify(legacy));
  const originalLegacy = fs.readFileSync(file);
  const saved = Object.fromEntries(['NODE_ENV', 'PDL_COMPAT_ACCOUNT_SYNTHETIC', 'PDL_REQUIRE_AUTH', 'PDL_DB_FILE', 'PDL_PLATFORM_FILE', 'PDL_SUPABASE_ENABLED', 'PDL_TRANSACTIONAL_DB', ...providerKeys].map(name => [name, process.env[name]]));
  for (const name of providerKeys) process.env[name] = ''; // present empties also fence loadLocalEnv
  Object.assign(process.env, { NODE_ENV: 'test', PDL_COMPAT_ACCOUNT_SYNTHETIC: '1', PDL_REQUIRE_AUTH: '1', PDL_DB_FILE: file, PDL_PLATFORM_FILE: path.join(directory, 'platform.json'), PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off' });
  const serverModule = require('./server'), server = serverModule.server; await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port, store = memory(snapshot()), messages = [], key = crypto.randomBytes(32);
  const delivery = createCredentialDelivery({ key, origin, load: store.load, commit: store.commit, send: async message => { messages.push(message); return { accepted: true }; } });
  const uninstall = serverModule.installCompatibilityAccountTests({ synthetic: true, companyId: A, origin, globalOrigin: 'http://127.0.0.1:4999', repository: store, credentials: delivery, dispatchAfterCommit: false });
  const request = async (route, { method = 'GET', data, cookie = '', tenant = A, headers = {} } = {}) => {
    const response = await fetch(origin + route, { method, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(tenant ? { 'X-PDL-Company': tenant } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(data ? { body: JSON.stringify(data) } : {}), redirect: 'manual' });
    const raw = await response.text(); let value; try { value = JSON.parse(raw); } catch { value = raw; }
    return { status: response.status, value, response };
  };
  try {
    assert.equal((await request('/api/config')).value.compatibilityAccount.companyId, A);
    assert.equal((await request('/api/config', { cookie: `pdl_company=${B}` })).status, 200);
    assert.equal((await request('/api/auth/login', { method: 'POST', tenant: '', data: { email: 'owner@example.invalid', password: initial } })).status, 404);
    assert.deepEqual((await request('/api/auth/company', { method: 'POST', data: { email: 'unknown@example.invalid' } })).value, { companyId: A });
    const signup = await request('/signup.html'); assert.equal(signup.status, 302); assert.equal(signup.response.headers.get('location'), 'http://127.0.0.1:4999/signup.html');
    let result = await request('/api/auth/login', { method: 'POST', data: { email: 'owner@example.invalid', password: initial } }); assert.equal(result.status, 200);
    const oldToken = result.value.token, oldCookie = `pdl_session=${oldToken}; pdl_company=${A}`;
    assert.equal((await request('/api/auth/me', { cookie: oldCookie })).status, 200);
    const beforeForgot = store.revision();
    result = await request('/api/auth/forgot', { method: 'POST', data: { email: 'owner@example.invalid' }, cookie: `pdl_company=${B}` }); assert.deepEqual(result.value, { ok: true });
    assert.equal(store.revision(), beforeForgot + 1); assert.equal(messages.length, 0);
    const first = store.current()[COLLECTION].at(-1); assert.equal((await delivery.dispatch(A, first.id)).status, 'sent');
    const token = new URL(messages[0].resetUrl).searchParams.get('token');
    result = await request('/api/state', { cookie: oldCookie }); assert.equal(result.status, 200);
    assert.equal(JSON.stringify(result.value).includes(COLLECTION), false); assert.equal(JSON.stringify(result.value).includes('resetTokenHash'), false); assert.equal(JSON.stringify(result.value).includes(token), false);
    const unknownBefore = store.revision(); result = await request('/api/auth/forgot', { method: 'POST', data: { email: 'unknown@example.invalid' } }); assert.deepEqual(result.value, { ok: true }); assert.equal(store.revision(), unknownBefore);
    result = await request('/api/auth/reset', { method: 'POST', data: { email: 'owner@example.invalid', token, password: nextPassword }, tenant: B }); assert.equal(result.status, 404);
    result = await request('/api/auth/reset', { method: 'POST', data: { email: 'owner@example.invalid', token, password: nextPassword, permissions: { owner: true } } }); assert.equal(result.status, 400);
    result = await request('/api/auth/reset', { method: 'POST', data: { email: 'owner@example.invalid', token, password: nextPassword }, headers: { Origin: 'http://example.invalid' } }); assert.equal(result.status, 404);
    result = await request('/api/auth/reset', { method: 'POST', data: { email: 'owner@example.invalid', token, password: nextPassword }, cookie: `pdl_session=unrelated; pdl_company=${B}` }); assert.equal(result.status, 200);
    assert.equal(store.current().sessions.length, 0); assert.equal((await request('/api/auth/me', { cookie: oldCookie })).status, 401);
    assert.equal((await request('/api/auth/reset', { method: 'POST', data: { email: 'owner@example.invalid', token, password: nextPassword } })).status, 401);
    assert.equal((await request('/api/auth/login', { method: 'POST', data: { email: 'owner@example.invalid', password: initial } })).status, 401);
    result = await request('/api/auth/login', { method: 'POST', data: { email: 'owner@example.invalid', password: nextPassword } }); assert.equal(result.status, 200);
    const currentCookie = `pdl_session=${result.value.token}; pdl_company=${A}`;
    assert.equal((await request('/api/auth/me', { cookie: currentCookie })).status, 200);
    result = await request('/api/state', { cookie: currentCookie }); assert.equal(result.status, 200); assert.ok(result.value.projects); assert.ok(result.value.team);
    assert.ok((await request('/login.html')).value.includes('setup-modal')); assert.ok((await request('/reset-password.html')).value.includes('reset-form')); assert.ok((await request('/app')).value.includes('pdlWorkspaceGate'));
    assert.equal((await request('/api/users', { cookie: currentCookie })).status, 503); // no private legacy fallback
    // Natural expiry with unchanged revision is checked after held final load.
    let held = await store.load(A); held.snapshot.sessions[0].expiresAt = new Date(Date.now() + 160).toISOString(); await store.commit(held.snapshot, held.revision);
    let loads = 0; store.beforeLoad = async () => { if (++loads === 2) await new Promise(resolve => setTimeout(resolve, 260)); };
    result = await request('/api/account-access', { cookie: currentCookie }); assert.equal(result.status, 401); store.beforeLoad = null;
    held = await store.load(A); held.snapshot.sessions[0].expiresAt = new Date(Date.now() + 86400000).toISOString(); await store.commit(held.snapshot, held.revision);
    // An unchanged revision cannot freeze account-access across trial expiry.
    held = await store.load(A); held.snapshot.company.billingExempt = false; held.snapshot.company.subscriptionStatus = 'Trial'; held.snapshot.company.trialEndsAt = new Date(Date.now() + 160).toISOString(); await store.commit(held.snapshot, held.revision);
    loads = 0; store.beforeLoad = async () => { if (++loads === 2) await new Promise(resolve => setTimeout(resolve, 260)); };
    result = await request('/api/account-access', { cookie: currentCookie }); assert.equal(result.status, 200); assert.equal(result.value.locked, true); store.beforeLoad = null;
    held = await store.load(A); held.snapshot.company.billingExempt = true; await store.commit(held.snapshot, held.revision);
    // Fresh canonical evidence, rather than a recomputed storage hash, decides auth.
    const valid = store.current();
    for (const mutate of [db => { db.sessions.push({ ...db.sessions[0], id: crypto.randomUUID() }); }, db => { db.users.push({ ...db.users[0], id: '1', email: 'alias@example.invalid' }); }, db => { db.users[0].role = { role: 'owner' }; }, db => { db.users[0].name = { name: 'Synthetic Owner' }; }, db => { db.users[0].permissions = { manageTime: { allowed: true } }; }, db => { db.sessions[0].userId = '1'; }, db => { db.sessions[0].companyId = B; }]) {
      held = await store.load(A); const poisoned = structuredClone(valid); mutate(poisoned); await store.commit(poisoned, held.revision); const revision = store.revision();
      for (const route of ['/api/auth/me', '/api/state', '/api/account-access']) assert.equal((await request(route, { cookie: currentCookie })).status, 503);
      assert.equal((await request('/api/auth/login', { method: 'POST', data: { email: 'owner@example.invalid', password: nextPassword } })).status, 503);
      assert.equal((await request('/api/auth/forgot', { method: 'POST', data: { email: 'owner@example.invalid' } })).status, 503); assert.equal(store.revision(), revision);
      held = await store.load(A); await store.commit(structuredClone(valid), held.revision);
    }
    // A committed reset with a lost acknowledgement is truthfully unknown;
    // its consumed token cannot replay, and ordinary new-password login recovers.
    await request('/api/auth/forgot', { method: 'POST', data: { email: 'owner@example.invalid' } }); const recoveryJob = store.current()[COLLECTION].at(-1); await delivery.dispatch(A, recoveryJob.id);
    const recoveryToken = new URL(messages.at(-1).resetUrl).searchParams.get('token'), recoveryPassword = 'Synthetic recovered pass 2026';
    store.loseCommitAck = true; result = await request('/api/auth/reset', { method: 'POST', data: { email: 'owner@example.invalid', token: recoveryToken, password: recoveryPassword } }); assert.equal(result.status, 503); assert.equal(result.value.code, 'COMMIT_OUTCOME_UNKNOWN');
    assert.equal((await request('/api/auth/reset', { method: 'POST', data: { email: 'owner@example.invalid', token: recoveryToken, password: recoveryPassword } })).status, 401);
    result = await request('/api/auth/login', { method: 'POST', data: { email: 'owner@example.invalid', password: recoveryPassword } }); assert.equal(result.status, 200);
    const recoveredCookie = `pdl_session=${result.value.token}; pdl_company=${A}`;
    // Existing failed-auth buckets still count rejected reset attempts once.
    const priorLimit = process.env.PDL_AUTH_FAIL_LIMIT; process.env.PDL_AUTH_FAIL_LIMIT = '3';
    try { for (let index = 0; index < 3; index++) assert.equal((await request('/api/auth/reset', { method: 'POST', data: { email: 'owner@example.invalid', token: 'invalid', password: recoveryPassword }, headers: { 'X-Forwarded-For': '203.0.113.145' } })).status, 401);
      assert.equal((await request('/api/auth/login', { method: 'POST', data: { email: 'owner@example.invalid', password: recoveryPassword }, headers: { 'X-Forwarded-For': '203.0.113.145' } })).status, 429);
    } finally { if (priorLimit === undefined) delete process.env.PDL_AUTH_FAIL_LIMIT; else process.env.PDL_AUTH_FAIL_LIMIT = priorLimit; }
    // CAS rejection leaves both authority and legacy JSON untouched; no send.
    store.rejectCommit = true; const deniedRevision = store.revision(); result = await request('/api/auth/forgot', { method: 'POST', data: { email: 'owner@example.invalid' } }); assert.equal(result.status, 409); assert.equal(store.revision(), deniedRevision); store.rejectCommit = false;
    assert.deepEqual(fs.readFileSync(file), originalLegacy);
    // Ticket retention is an explicit STOP, not silently performed precommit.
    let loaded = await store.load(A); loaded.snapshot.projectTickets = [{ id: 99, deletedAt: '2020-01-01', retainedUntil: '2020-04-01', url: '/uploads/project-tickets/synthetic.pdf' }]; await store.commit(loaded.snapshot, loaded.revision);
    const stopRevision = store.revision(); result = await request('/api/state', { cookie: recoveredCookie }); assert.equal(result.status, 503); assert.equal(store.revision(), stopRevision); assert.equal(store.current().projectTickets[0].purgedAt, undefined);
    // Ordinary legacy remains the actual global signup service after uninstall.
    uninstall(); const baseline = await request('/api/config', { tenant: B }); assert.deepEqual(baseline.value, { authRequired: true });
    result = await request('/api/auth/company', { method: 'POST', data: { email: 'owner@example.invalid' }, tenant: B }); assert.equal(result.value.companyId, B);
    assert.equal((await request('/api/founder-offer', { tenant: B })).status, 200);
    assert.equal((await request('/signup.html', { tenant: B })).status, 200);
  } finally { uninstall(); await new Promise(resolve => server.close(resolve)); for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
}
async function main() {
  assert.throws(() => createRuntime({ synthetic: true, companyId: A, origin: 'http://127.0.0.1:1', globalOrigin: 'http://127.0.0.1:2' }), /unavailable/);
  await deliveryChecks(); await httpChecks();
  console.log('Compatibility account slice: encrypted reset custody, guarded dispatch, recovery, CAS rejection and normal-route checks passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
