'use strict';
// Real HTTP workers and the selected-tenant native fixture; no provider or legacy writes.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { fork } = require('node:child_process');
const { A, B, initial, credential, snapshot } = require('./compat-account-fixture');
const { workspaceSnapshot } = require('./compat-workspace-fixture');
const { nativeFixture } = require('./compat-lifecycle-native-fixture');
const { canonicalHash } = require('./database/transactional-repository');
Object.assign(process.env, { NODE_ENV: 'test', PDL_COMPAT_ACCOUNT_SYNTHETIC: '1', PDL_REQUIRE_AUTH: '1' });

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function bounded(promise, label, ms = 15000) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Synthetic compliance timeout: ' + label)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function event(child, type) {
  let on, failed;
  const pending = new Promise((resolve, reject) => {
    on = message => { if (message.event === type) resolve(message); };
    failed = error => reject(error);
    child.on('message', on); child.once('error', failed);
  });
  return bounded(pending, type).finally(() => { child.off('message', on); child.off('error', failed); });
}
function legacyHelpers() {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const extract = (name, next) => {
    const start = source.indexOf(name), end = source.indexOf(next, start);
    assert.ok(start >= 0 && end > start, 'Existing compliance helper must be present');
    return source.slice(start, end).trim();
  };
  const requirements = vm.runInNewContext('(' + extract('function subcontractorRequirements(', 'async function sendComplianceEmail(') + ')', { Date });
  const reminder = vm.runInNewContext('(' + extract('async function sendComplianceReminder(', 'async function runAutomaticComplianceReminders(') + ')', {
    Date, subcontractorRequirements: requirements, sendComplianceEmail: async () => {}
  });
  return { requirements, reminder };
}

async function main() {
  const fixture = await nativeFixture(), helpers = legacyHelpers(), checks = [], poisonBoundaries = [];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-compat-compliance-native-'));
  const keyFile = path.join(directory, 'synthetic-key');
  fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
  const foreign = snapshot(); foreign.company.id = B; foreign.users[0].companyId = B;
  const legacyFile = path.join(directory, 'legacy.json'); fs.writeFileSync(legacyFile, JSON.stringify(foreign));
  const legacyBytes = fs.readFileSync(legacyFile), platformFile = path.join(directory, 'platform.json');
  const workers = new Set(), pending = new Set();
  let sharedOrigin, token, requests = 0, first, second;

  async function start() {
    const env = {
      ...process.env, PDL_DB_FILE: legacyFile, PDL_PLATFORM_FILE: platformFile,
      PDL_COMPAT_GLOBAL_FENCE_FILE: '', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off',
      TEST_COMPAT_LIFECYCLE_KEY_FILE: keyFile, TEST_COMPAT_LIFECYCLE_ORIGIN: sharedOrigin || ''
    };
    for (const name of ['OPENAI_API_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'SENTRY_DSN', 'SUPABASE_SECRET_KEY', 'PDL_PLATFORM_KEY']) env[name] = '';
    const child = fork(path.join(__dirname, 'compat-workspace-http-worker.cjs'), [], {
      env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true
    });
    workers.add(child);
    // Drain diagnostics without exposing synthetic passwords, session tokens, or proofs.
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    child.origin = (await event(child, 'ready')).origin; sharedOrigin ||= child.origin;
    return child;
  }
  async function close(child) {
    if (!workers.has(child)) return;
    if (child.connected) {
      child.send({ event: 'release-effect' }); child.send({ event: 'release-commit' }); child.send({ event: 'release-final' });
      const exited = new Promise(resolve => child.once('exit', resolve)); child.send({ event: 'close' });
      await bounded(exited, 'worker close');
    }
    workers.delete(child);
  }
  function request(child, route, method = 'GET', input, bearer = token, tenant = A) {
    requests++;
    const running = (async () => {
      const response = await fetch(child.origin + route, {
        method, signal: AbortSignal.timeout(20000), headers: {
          'X-PDL-Company': tenant, ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}),
          ...(input === undefined ? {} : { 'Content-Type': 'application/json' })
        }, ...(input === undefined ? {} : { body: JSON.stringify(input) })
      });
      return {
        status: response.status, data: await response.json(),
        revision: response.headers.get('X-PDL-Workspace-Revision'),
        authority: response.headers.get('X-PDL-Workspace-Authority')
      };
    })();
    pending.add(running); running.finally(() => pending.delete(running)).catch(() => {});
    return running;
  }
  async function arm(child, name, extra = {}) {
    const ready = event(child, 'armed'); child.send({ event: name, ...extra }); await ready;
  }
  async function count(child) {
    const ready = event(child, 'effect-count'); child.send({ event: 'effect-count' }); return (await ready).count;
  }
  const total = async () => await count(first) + await count(second);
  async function login(child, email = 'owner@example.invalid') {
    const result = await request(child, '/api/auth/login', 'POST', { email, password: initial }, '');
    assert.equal(result.status, 200, 'Synthetic actor login must succeed'); return result.data.token;
  }
  async function alter(change) {
    const loaded = await fixture.repository.load(A); change(loaded.snapshot);
    return fixture.repository.commit(loaded.snapshot, loaded.revision);
  }
  const sub = () => ({
    id: 51, companyId: A, name: 'Synthetic Subcontractor', contact: 'Synthetic Contact',
    email: 'synthetic@example.invalid', autoComplianceReminders: true
  });
  async function reset({ admin = false } = {}) {
    const seed = workspaceSnapshot(); seed.subcontractors = [sub()];
    if (admin) seed.users.push({
      id: 3, companyId: A, name: 'Synthetic Office', email: 'admin@example.invalid',
      emailVerifiedAt: new Date().toISOString(), role: 'admin', status: 'Active',
      ...credential(initial), projectIds: [], assignedCrews: [], permissions: {}
    });
    await fixture.reset(seed); token = await login(first);
    await arm(first, 'effect-outcome', { status: 'accepted' }); await arm(second, 'effect-outcome', { status: 'accepted' });
  }
  async function queued(child = first) {
    const before = await total(); await arm(child, 'lose-ack');
    const response = await request(child, '/api/workspace-prepare');
    assert.equal(response.status, 503, 'The staging COMMIT acknowledgement must be lost');
    const loaded = await fixture.repository.load(A), values = loaded.snapshot.workspaceComplianceJobs;
    assert.equal(values.length, 1); assert.equal(values[0].status, 'queued');
    assert.equal(await total(), before, 'Staging cannot send before a durable claim');
    const job = values[0], expected = structuredClone(helpers.requirements(loaded.snapshot.subcontractors[0], new Date(job.createdAt)));
    assert.deepEqual(job.source, {
      companyId: A, companyName: loaded.snapshot.company.name, subcontractorId: 51,
      email: 'synthetic@example.invalid', contact: 'Synthetic Contact', name: 'Synthetic Subcontractor', items: expected
    }, 'The staged descriptor must match the existing legacy requirements helper exactly');
    assert.equal(job.sourceHash, canonicalHash(job.source));
    return loaded;
  }
  async function noBusinessReceipt() {
    const db = (await fixture.repository.load(A)).snapshot;
    assert.equal(db.subcontractors[0].complianceReminderStages, undefined);
    assert.equal(db.subcontractors[0].complianceHistory, undefined);
    assert.equal(db.subcontractors[0].lastComplianceReminderAt, undefined);
    return db;
  }
  async function poisonAtBoundary(label, poison, boundary, blockBootstrap = true) {
    const beforeSends = await total(), before = await fixture.repository.load(A), candidate = structuredClone(before.snapshot);
    poison(candidate);
    let failure;
    try { await fixture.repository.commit(candidate, before.revision); }
    catch (error) { failure = { code: error.code, statusCode: error.statusCode }; }
    const persisted = await fixture.repository.load(A);
    if (boundary === 'storage') {
      assert.equal(failure?.code, 'PDL_COMPAT_STORAGE', label + ': duplicate native record identity must be rejected by storage');
      assert.equal(failure?.statusCode, 503, label + ': storage must return its finite unavailable result');
      assert.equal(persisted.revision, before.revision, label + ': rejected storage cannot advance the revision');
      assert.equal(persisted.contentHash, before.contentHash, label + ': rejected storage cannot change data');
      assert.equal(canonicalHash(persisted.snapshot), canonicalHash(before.snapshot), label + ': rollback must retain the exact valid source');
      // The unpoisoned queued job remains valid. Read it without dispatching it.
      assert.equal((await request(first, '/api/state')).status, 200, label + ': prior valid data must remain readable');
    } else {
      assert.equal(failure, undefined, label + ': this poison must persist and reach typed HTTP validation');
      assert.equal(persisted.revision, before.revision + 1, label + ': poison fixture commit must be exact');
      assert.equal(persisted.contentHash, canonicalHash(candidate), label + ': typed validation must examine the committed poison');
      assert.equal(canonicalHash(persisted.snapshot), canonicalHash(candidate), label + ': committed source must match the requested poison');
      assert.equal((await request(second, '/api/workspace-prepare')).status, 409, label + ': preparation must reject persisted poison');
      if (blockBootstrap) assert.equal((await request(first, '/api/state')).status, 409, label + ': bootstrap must reject persisted poison');
      const after = await fixture.repository.load(A);
      assert.equal(after.revision, persisted.revision, label + ': rejected HTTP must not advance the revision');
      assert.equal(after.contentHash, persisted.contentHash, label + ': rejected HTTP must not repair or overwrite poison');
    }
    assert.equal(await total(), beforeSends, label + ': rejection must prevent every provider attempt');
    await noBusinessReceipt(); poisonBoundaries.push({ label, boundary });
  }
  async function finitePending(child, bearer = token) {
    const result = await request(child, '/api/state', 'GET', undefined, bearer);
    assert.equal(result.status, 200, 'An authorized office actor must see the finite pending status');
    assert.deepEqual(result.data.workspaceDependencies, { compliance: { status: 'uncertain', count: 1 } });
    const encoded = JSON.stringify(result.data), job = (await fixture.repository.load(A)).snapshot.workspaceComplianceJobs[0];
    for (const field of ['workspaceComplianceJobs', 'sessionHash', 'actorBinding', 'sourceHash', 'attemptId', 'generation', 'proof']) {
      assert.equal(encoded.includes('"' + field + '"'), false, 'Private dependency field must not appear: ' + field);
    }
    for (const value of [job.id, job.sessionHash, job.actorBinding, job.sourceHash, job.proof, job.attemptId].filter(Boolean)) {
      assert.equal(encoded.includes(value), false, 'Private dependency custody must not appear in bootstrap');
    }
    assert.equal((await request(child, '/api/state', 'GET', undefined, bearer, B)).status, 404);
    return result;
  }

  try {
    first = await start(); second = await start();

    const custodyPoisons = [
      ['null ledger', db => { db.workspaceComplianceJobs = null; }, 'http'],
      ['non-array ledger', db => { db.workspaceComplianceJobs = {}; }, 'http'],
      ['duplicate job identity', db => { db.workspaceComplianceJobs.push(structuredClone(db.workspaceComplianceJobs[0])); }, 'storage'],
      ['altered descriptor without proof', db => { db.workspaceComplianceJobs[0].source.email = 'foreign@example.invalid'; }, 'http'],
      ['altered proof', db => { const job = db.workspaceComplianceJobs[0]; job.proof = (job.proof[0] === '0' ? '1' : '0') + job.proof.slice(1); }, 'http'],
      ['unknown private field', db => { db.workspaceComplianceJobs[0].permissionOverride = true; }, 'http'],
      ['foreign company custody', db => { db.workspaceComplianceJobs[0].companyId = B; }, 'http'],
      ['forged attempt state', db => { db.workspaceComplianceJobs[0].status = 'sending'; }, 'http']
    ];
    for (const [label, poison, boundary] of custodyPoisons) {
      await reset(); await queued(); await poisonAtBoundary(label, poison, boundary);
    }
    checks.push('eight malformed or forged custody variants fail at their exact native-storage or typed-HTTP boundary without sends or overwritten data');

    for (const [label, poison, boundary] of [
      ['foreign subcontractor', db => { db.subcontractors[0].companyId = B; }, 'http'],
      ['ambiguous subcontractor identity', db => { db.subcontractors.push({ ...db.subcontractors[0], name: 'Ambiguous Synthetic Subcontractor' }); }, 'storage']
    ]) {
      await reset(); await queued(); await poisonAtBoundary(label, poison, boundary);
    }
    checks.push('foreign or ambiguous current subcontractor bindings prevent native claims and delivery');

    for (const [label, change] of [
      ['recipient change', db => { db.subcontractors[0].email = 'changed@example.invalid'; }],
      ['requirement change', db => { db.subcontractors[0].w9Received = true; }]
    ]) {
      await reset(); const original = (await queued()).snapshot.workspaceComplianceJobs[0], before = await total();
      await arm(first, 'hold-commit'); const changedHeld = event(first, 'commit-held');
      const changedOpening = request(first, '/api/workspace-prepare'); await changedHeld; await alter(change);
      first.send({ event: 'release-commit' }); assert.equal((await changedOpening).status, 409, label);
      assert.equal(await total(), before);
      const db = await noBusinessReceipt(); assert.deepEqual(db.workspaceComplianceJobs.find(row => row.id === original.id), original);
    }
    checks.push('recipient or requirement changes during a held native claim reject the stale source before any send');

    await reset({ admin: true }); await queued(); const beforeRevoke = await total();
    await arm(first, 'hold-commit'); let held = event(first, 'commit-held'), opening = request(first, '/api/workspace-prepare');
    await held; await alter(db => { db.users[0].status = 'Inactive'; }); first.send({ event: 'release-commit' });
    assert.equal((await opening).status, 409); assert.equal(await total(), beforeRevoke);
    assert.equal((await noBusinessReceipt()).workspaceComplianceJobs[0].status, 'queued');
    const adminToken = await login(second, 'admin@example.invalid');
    assert.equal((await request(second, '/api/workspace-prepare', 'GET', undefined, adminToken)).status, 200);
    assert.equal((await noBusinessReceipt()).workspaceComplianceJobs[0].status, 'cancelled'); assert.equal(await total(), beforeRevoke);
    checks.push('revocation before the claim COMMIT produces zero sends and a fresh office opening cancels the original queued job');

    await reset(); await alter(db => {
      const hash = crypto.createHash('sha256').update(token).digest('hex');
      db.sessions.find(row => row.tokenHash === hash).expiresAt = new Date(Date.now() + 2500).toISOString();
    });
    await queued(); const beforeExpiry = await total(); await arm(first, 'hold-commit');
    held = event(first, 'commit-held'); opening = request(first, '/api/workspace-prepare'); await held;
    const expiryRevision = (await fixture.repository.load(A)).revision; await delay(2700); first.send({ event: 'release-commit' });
    assert.equal((await opening).status, 409); assert.equal((await fixture.repository.load(A)).revision, expiryRevision);
    assert.equal(await total(), beforeExpiry); assert.equal((await noBusinessReceipt()).workspaceComplianceJobs[0].status, 'queued');
    checks.push('natural session expiry at unchanged native revision rejects a held claim COMMIT before any send');

    await reset({ admin: true }); const expiryAdmin = await login(second, 'admin@example.invalid');
    await alter(db => {
      const hash = crypto.createHash('sha256').update(token).digest('hex');
      db.sessions.find(row => row.tokenHash === hash).expiresAt = new Date(Date.now() + 2500).toISOString();
    });
    const beforeHeldExpiry = await total(); await arm(first, 'hold-effect'); held = event(first, 'effect-held');
    opening = request(first, '/api/workspace-prepare'); await held; const providerRevision = (await fixture.repository.load(A)).revision;
    await delay(2700); assert.equal((await fixture.repository.load(A)).revision, providerRevision);
    first.send({ event: 'release-effect' }); assert.equal((await opening).status, 401);
    assert.equal(await total(), beforeHeldExpiry + 1); assert.equal((await noBusinessReceipt()).workspaceComplianceJobs[0].status, 'uncertain');
    await finitePending(second, expiryAdmin); const expirySends = await total();
    assert.equal((await request(second, '/api/workspace-prepare', 'GET', undefined, expiryAdmin)).status, 200);
    assert.equal(await total(), expirySends);
    checks.push('natural expiry while an accepted provider result is held records uncertainty without business receipt or automatic resend');

    await reset({ admin: true }); const revokedAdmin = await login(second, 'admin@example.invalid');
    const beforeAcceptedRevoke = await total(); await arm(first, 'hold-effect'); held = event(first, 'effect-held');
    opening = request(first, '/api/workspace-prepare'); await held; await alter(db => { db.users[0].status = 'Inactive'; });
    first.send({ event: 'release-effect' }); assert.equal((await opening).status, 409);
    assert.equal(await total(), beforeAcceptedRevoke + 1); assert.equal((await noBusinessReceipt()).workspaceComplianceJobs[0].status, 'sending');
    await finitePending(second, revokedAdmin); const revokedSends = await total();
    assert.equal((await request(second, '/api/workspace-prepare', 'GET', undefined, revokedAdmin)).status, 200);
    assert.equal(await total(), revokedSends);
    checks.push('revocation after provider acceptance retains the unresolved claim; office bootstrap shows only finite uncertainty and never resends');

    await reset(); await queued(); const beforeClaimAck = await total(); await arm(first, 'lose-ack');
    assert.equal((await request(first, '/api/workspace-prepare')).status, 503);
    const lostClaim = await noBusinessReceipt(); assert.equal(lostClaim.workspaceComplianceJobs[0].status, 'sending');
    assert.equal(await total(), beforeClaimAck); await finitePending(second);
    await close(first); first = await start(); const afterRestartCount = await total();
    assert.equal((await request(first, '/api/workspace-prepare')).status, 200); await finitePending(first);
    assert.equal(await total(), afterRestartCount); assert.deepEqual((await noBusinessReceipt()).workspaceComplianceJobs[0], lostClaim.workspaceComplianceJobs[0]);
    checks.push('lost claim COMMIT acknowledgement sends nothing and retains the exact unresolved claim across worker restart without retry');

    await reset(); const beforeFinalAck = await total(); await arm(first, 'hold-effect'); held = event(first, 'effect-held');
    opening = request(first, '/api/workspace-prepare'); await held; await arm(first, 'lose-ack'); first.send({ event: 'release-effect' });
    assert.equal((await opening).status, 503); assert.equal(await total(), beforeFinalAck + 1);
    const saved = (await fixture.repository.load(A)).snapshot, savedJob = structuredClone(saved.workspaceComplianceJobs[0]);
    assert.equal(savedJob.status, 'sent'); assert.ok(savedJob.attemptId); assert.ok(savedJob.finishedAt);
    const baseline = workspaceSnapshot(); baseline.subcontractors = [sub()];
    assert.equal(await helpers.reminder(baseline, baseline.subcontractors[0], { automatic: true, now: new Date(savedJob.finishedAt) }), true);
    assert.deepEqual(saved.subcontractors[0], structuredClone(baseline.subcontractors[0]), 'Delivered business fields must exactly match the existing legacy reminder helper');
    await close(first); first = await start(); const beforeFinalReplay = await total();
    assert.equal((await request(first, '/api/workspace-prepare')).status, 200);
    const finalState = await request(first, '/api/state'); assert.equal(finalState.status, 200); assert.equal(finalState.data.workspaceDependencies, undefined);
    assert.equal(await total(), beforeFinalReplay); assert.deepEqual((await fixture.repository.load(A)).snapshot.workspaceComplianceJobs[0], savedJob);
    checks.push('lost final COMMIT acknowledgement retains one delivered legacy-equivalent receipt; restart and fresh opening never resend');

    for (const heldWorker of ['first', 'second']) {
      await reset(); await queued(); const beforeRace = await total(), loser = heldWorker === 'first' ? first : second, winner = heldWorker === 'first' ? second : first;
      await arm(loser, 'hold-commit'); held = event(loser, 'commit-held'); opening = request(loser, '/api/workspace-prepare'); await held;
      const winning = await request(winner, '/api/workspace-prepare'); assert.equal(winning.status, 200);
      loser.send({ event: 'release-commit' }); assert.equal((await opening).status, 409); assert.equal(await total(), beforeRace + 1);
      const db = (await fixture.repository.load(A)).snapshot; assert.equal(db.workspaceComplianceJobs.length, 1); assert.equal(db.workspaceComplianceJobs[0].status, 'sent');
      assert.equal(db.subcontractors[0].complianceHistory.length, 1);
    }
    checks.push('both opposite-order two-worker claim races save one sending claim, deliver once and retain one business receipt');

    await reset(); await queued(); const beforeConcurrent = await total();
    const race = await Promise.all([request(first, '/api/workspace-prepare'), request(second, '/api/workspace-prepare')]);
    assert.ok(race.some(row => row.status === 200)); assert.ok(race.every(row => [200, 409].includes(row.status)));
    assert.equal(await total(), beforeConcurrent + 1); assert.equal((await fixture.repository.load(A)).snapshot.subcontractors[0].complianceHistory.length, 1);
    checks.push('simultaneous actual HTTP workers claim the same queued generation at most once');

    await reset(); await arm(first, 'effect-outcome', { status: 'unknown' }); const beforeUnknown = await total();
    assert.equal((await request(first, '/api/workspace-prepare')).status, 200); assert.equal(await total(), beforeUnknown + 1);
    assert.equal((await noBusinessReceipt()).workspaceComplianceJobs[0].status, 'uncertain'); await finitePending(second);
    const fieldToken = await login(second, 'field@example.invalid'), fieldState = await request(second, '/api/state', 'GET', undefined, fieldToken);
    assert.equal(fieldState.status, 200); assert.equal(fieldState.data.workspaceDependencies, undefined);
    await close(first); first = await start(); const beforeUnknownRestart = await total();
    assert.equal((await request(first, '/api/workspace-prepare')).status, 200); assert.equal(await total(), beforeUnknownRestart); await finitePending(first);
    checks.push('unknown delivery remains visible only to current office scope; field access and restart cannot expose custody or retry it');

    assert.deepEqual(fs.readFileSync(legacyFile), legacyBytes, 'The foreign legacy source must remain byte-identical');
    assert.equal(fs.existsSync(platformFile), false, 'Compliance must never initialize or write a platform file');
    console.log(JSON.stringify({ nativeCompliance: checks, passed: checks.length, poisonBoundaries, actualHttpRequests: requests, workers: 2, allowedExternalCalls: 0, productionReady: false }));
  } finally {
    for (const child of workers) if (child.connected) {
      child.send({ event: 'release-effect' }); child.send({ event: 'release-commit' }); child.send({ event: 'release-final' });
    }
    await bounded(Promise.allSettled([...pending]), 'pending requests cleanup', 22000).catch(() => {});
    for (const child of [...workers]) await close(child);
    await fixture.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
