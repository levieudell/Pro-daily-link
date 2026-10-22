'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture } = require('./fixtures/project-assistant');
const { RevisionConflictError, canonicalHash } = require('./database/transactional-repository');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-auth-session-concurrency-'));
const dbFile = path.join(temp, 'db.json');
const platformFile = path.join(temp, 'platform.json');
const companyId = '11111111-1111-4111-8111-111111111111';
const token = 'synthetic-auth-session-concurrency-token';
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

function tenantWithExpiry(expiresAt) {
  const tenant = fixture(companyId);
  tenant.company.persistence = { revision: 1, updatedAt: new Date().toISOString() };
  tenant.sessions = [{
    id: crypto.randomUUID(),
    userId: 1,
    companyId,
    tokenHash,
    createdAt: new Date().toISOString(),
    expiresAt
  }];
  return tenant;
}

let authoritative = tenantWithExpiry(new Date(Date.now() + 60 * 60 * 1000).toISOString());
let legacy = structuredClone(authoritative);
let revision = 10;
let loadCalls = 0;
let saveAttempts = 0;
let successfulSaves = 0;
const conflictPlan = [];
let saveOrder = [];
let gatedLoadsRemaining = 0;
let gatedArrivals = 0;
let releaseGate = null;
let gate = Promise.resolve();

function gateNextLoads(count) {
  gatedLoadsRemaining = count;
  gatedArrivals = 0;
  gate = new Promise(resolve => { releaseGate = resolve; });
}

fs.writeFileSync(dbFile, JSON.stringify(authoritative, null, 2));
fs.writeFileSync(platformFile, JSON.stringify({ users: [], sessions: [] }, null, 2));

Object.assign(process.env, {
  NODE_ENV: 'production',
  PDL_REQUIRE_AUTH: '1',
  PDL_DB_FILE: dbFile,
  PDL_PLATFORM_FILE: platformFile,
  PDL_SUPABASE_ENABLED: '1',
  SUPABASE_URL: 'https://auth-session-concurrency.invalid',
  SUPABASE_SECRET_KEY: 'synthetic-service-secret',
  PDL_TRANSACTIONAL_DB: 'primary',
  PDL_PLATFORM_TRANSACTIONAL_DB: 'off',
  PDL_EMAIL_DEV_MODE: '1'
});
for (const key of ['SENTRY_DSN', 'RESEND_API_KEY', 'DATABASE_URL']) delete process.env[key];

const supabase = require('./database/supabase');
supabase.loadLocalEnv = () => {};
supabase.configured = () => true;
supabase.loadTransactionalSnapshot = async id => {
  if (String(id) !== companyId) return null;
  loadCalls += 1;
  const captured = { snapshot: structuredClone(authoritative), revision, contentHash: canonicalHash(authoritative) };
  if (gatedLoadsRemaining > 0) {
    gatedLoadsRemaining -= 1;
    gatedArrivals += 1;
    if (gatedLoadsRemaining === 0) releaseGate();
    await gate;
  }
  return captured;
};
supabase.saveTransactionalSnapshot = async (snapshot, expectedRevision) => {
  saveAttempts += 1;
  saveOrder.push('transactional');
  if (conflictPlan.length) {
    conflictPlan.shift()();
    revision += 1;
    throw new RevisionConflictError(expectedRevision, revision);
  }
  if (Number(expectedRevision) !== revision) throw new RevisionConflictError(expectedRevision, revision);
  authoritative = structuredClone(snapshot);
  revision += 1;
  successfulSaves += 1;
  return { companyId, revision, contentHash: canonicalHash(authoritative), records: 1 };
};
supabase.loadCompanySnapshot = async id => String(id) === companyId ? structuredClone(legacy) : null;
supabase.saveCompanySnapshot = async snapshot => { saveOrder.push('legacy'); legacy = structuredClone(snapshot); return true; };
supabase.listCompanySnapshots = async () => [structuredClone(legacy)];
supabase.listTransactionalSnapshots = async () => [{ companyId, snapshot: structuredClone(authoritative), revision, contentHash: canonicalHash(authoritative) }];
supabase.createVerifiedBackup = async snapshot => ({
  bucket: 'tenant-backups', objectKey: `${snapshot.company.id}/synthetic.json`, hash: 'a'.repeat(64), bytes: 1, verifiedAt: new Date().toISOString()
});
supabase.upload = async () => ({});
require('./database/backup-verification').backupDue = () => false;

const { server } = require('./server');

async function authMe(base) {
  const response = await fetch(`${base}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}`, 'X-PDL-Company': companyId }
  });
  let data = null;
  try { data = await response.json(); } catch {}
  return { status: response.status, data, cookie: response.headers.get('set-cookie') || '' };
}
function cookieMaxAge(value) { return Number(String(value).match(/Max-Age=(\d+)/)?.[1] || 0); }

(async () => {
  const unhandled = [];
  const recordUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', recordUnhandled);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    gateNextLoads(2);
    const primaryResults = await Promise.all([authMe(base), authMe(base)]);
    assert.deepEqual(primaryResults.map(result => result.status), [200, 200], primaryResults.map(result => result.data));
    assert.equal(saveAttempts, 1, 'queue refresh lets only the first near-expiry auth probe renew the primary session');
    assert.equal(successfulSaves, 1);
    assert.ok(loadCalls >= 4, 'each queued request reloads the authoritative tenant after acquiring the queue');
    assert.ok(Date.parse(authoritative.sessions[0].expiresAt) > Date.now() + 29 * 86400 * 1000);

    authoritative.sessions[0].expiresAt = new Date(Date.now() + 10 * 86400 * 1000).toISOString();
    authoritative.company.persistence.revision += 1;
    revision += 1;
    const settledSaveAttempts = saveAttempts;
    const settled = await authMe(base);
    assert.equal(settled.status, 200);
    assert.ok(cookieMaxAge(settled.cookie) <= 10 * 86400 && cookieMaxAge(settled.cookie) >= 10 * 86400 - 5,
      'a read-only auth probe never extends the browser cookie beyond the persisted session');
    assert.equal(saveAttempts, settledSaveAttempts, 'a session with more than seven days remaining stays read-only');

    authoritative.sessions[0].expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    authoritative.company.persistence.revision += 1;
    revision += 1;
    conflictPlan.push(() => authoritative.projects.push({ id: 909, name: 'Concurrent external project', status: 'Active', estimateItems: [] }));
    const attemptsBeforeConflict = saveAttempts;
    const recovered = await authMe(base);
    assert.equal(recovered.status, 200, JSON.stringify(recovered.data));
    assert.ok(cookieMaxAge(recovered.cookie) >= 30 * 86400 - 5, 'a committed renewal gives the browser the full renewed lifetime');
    assert.equal(saveAttempts - attemptsBeforeConflict, 2, 'session renewal retries a revision conflict only once');
    assert.ok(authoritative.projects.some(project => project.id === 909), 'retry rebases the expiry field onto the concurrent external write');
    assert.ok(Date.parse(authoritative.sessions[0].expiresAt) > Date.now() + 29 * 86400 * 1000);

    authoritative.sessions[0].expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    authoritative.company.persistence.revision += 1;
    revision += 1;
    conflictPlan.push(
      () => authoritative.projects.push({ id: 910, name: 'First sustained-contention project', status: 'Active', estimateItems: [] }),
      () => authoritative.projects.push({ id: 911, name: 'Second sustained-contention project', status: 'Active', estimateItems: [] })
    );
    const attemptsBeforeSustainedConflict = saveAttempts, logged = [], originalConsoleError = console.error;
    console.error = (...args) => logged.push(args.map(String).join(' '));
    let deferred;
    try { deferred = await authMe(base); } finally { console.error = originalConsoleError; }
    assert.equal(deferred.status, 200, 'renewal contention must not impersonate logout');
    assert.ok(cookieMaxAge(deferred.cookie) <= 3600 && cookieMaxAge(deferred.cookie) >= 3590,
      'a deferred renewal keeps the browser cookie within the still-valid server session');
    assert.equal(saveAttempts - attemptsBeforeSustainedConflict, 2, 'renewal work remains bounded under sustained contention');
    assert.ok(authoritative.projects.some(project => project.id === 910));
    assert.ok(authoritative.projects.some(project => project.id === 911), 'both external writes survive a deferred renewal');
    assert.ok(Date.parse(authoritative.sessions[0].expiresAt) < Date.now() + 2 * 60 * 60 * 1000, 'an uncommitted renewal is never mirrored as durable state');
    assert.ok(logged.some(line => line.includes('Session renewal deferred')), 'deferred renewal leaves an operational warning');

    authoritative.company.persistence.revision += 1;
    revision += 1;
    conflictPlan.push(() => { authoritative.sessions = []; });
    const attemptsBeforeRevoke = saveAttempts;
    const revokedDuringRenewal = await authMe(base);
    assert.equal(revokedDuringRenewal.status, 401, 'a real concurrent session revocation is not converted into best-effort access');
    assert.equal(saveAttempts - attemptsBeforeRevoke, 1);

    authoritative = tenantWithExpiry(new Date(Date.now() - 1000).toISOString());
    revision += 1;
    const attemptsBeforeExpired = saveAttempts;
    const expired = await authMe(base);
    assert.equal(expired.status, 401);
    assert.equal(saveAttempts, attemptsBeforeExpired, 'an expired session is never renewed');

    process.env.PDL_TRANSACTIONAL_DB = 'shadow';
    authoritative = tenantWithExpiry(new Date(Date.now() + 60 * 60 * 1000).toISOString());
    legacy = structuredClone(authoritative);
    revision = 100;
    fs.writeFileSync(dbFile, JSON.stringify(legacy, null, 2));
    const shadowAttemptsBefore = saveAttempts;
    gateNextLoads(2);
    const shadowResults = await Promise.all([authMe(base), authMe(base)]);
    assert.deepEqual(shadowResults.map(result => result.status), [200, 200], shadowResults.map(result => result.data));
    assert.equal(saveAttempts - shadowAttemptsBefore, 1, 'queue refresh lets only the first near-expiry auth probe renew the shadow');
    assert.ok(Date.parse(legacy.sessions[0].expiresAt) > Date.now() + 29 * 86400 * 1000);
    assert.ok(Date.parse(authoritative.sessions[0].expiresAt) > Date.now() + 29 * 86400 * 1000);

    const staleLocal = structuredClone(legacy);
    staleLocal.sessions[0].expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    legacy.sessions[0].expiresAt = staleLocal.sessions[0].expiresAt;
    authoritative.sessions[0].expiresAt = staleLocal.sessions[0].expiresAt;
    fs.writeFileSync(dbFile, JSON.stringify(staleLocal, null, 2));
    saveOrder = [];
    conflictPlan.push(() => {
      const externalProject = { id: 919, name: 'Concurrent shadow project', status: 'Active', estimateItems: [] };
      authoritative.projects.push(structuredClone(externalProject));
      legacy.projects.push(structuredClone(externalProject));
      legacy.company.persistence.revision += 1;
    });
    const attemptsBeforeShadowConflict = saveAttempts;
    const shadowRecovered = await authMe(base);
    assert.equal(shadowRecovered.status, 200, JSON.stringify(shadowRecovered.data));
    assert.equal(saveAttempts - attemptsBeforeShadowConflict, 2, 'shadow renewal retries a conflict once');
    assert.deepEqual(saveOrder.slice(0, 3), ['transactional', 'transactional', 'legacy'], 'transactional reconciliation completes before legacy acknowledgement');
    assert.ok(authoritative.projects.some(project => project.id === 919));
    assert.ok(legacy.projects.some(project => project.id === 919));
    assert.ok(JSON.parse(fs.readFileSync(dbFile, 'utf8')).projects.some(project => project.id === 919), 'the reconciled external change reaches the local mirror');
    assert.ok(Date.parse(legacy.sessions[0].expiresAt) > Date.now() + 29 * 86400 * 1000);
    assert.ok(Date.parse(authoritative.sessions[0].expiresAt) > Date.now() + 29 * 86400 * 1000);

    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, [], 'session renewal never leaks an unhandled revision conflict');
    console.log('Auth session concurrency passed: queued refreshes serialize renewals, sustained contention stays authenticated, revocation fails closed, and primary/shadow retries preserve external writes.');
  } finally {
    process.removeListener('unhandledRejection', recordUnhandled);
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
