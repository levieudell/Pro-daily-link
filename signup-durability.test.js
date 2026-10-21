'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-signup-durability-'));
const dbFile = path.join(temp, 'db.json');
const platformFile = path.join(temp, 'platform.json');
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), dbFile);
const platformOwnerToken = 'signup-durability-platform-owner';
const platformNow = new Date().toISOString();
fs.writeFileSync(platformFile, JSON.stringify({
  users: [{ id: 'platform-owner', name: 'Platform Owner', email: 'platform@example.invalid', role: 'platform_owner', status: 'Active', mustSetPassword: false, createdAt: platformNow }],
  sessions: [{ id: crypto.randomUUID(), userId: 'platform-owner', tokenHash: crypto.createHash('sha256').update(platformOwnerToken).digest('hex'), createdAt: platformNow, expiresAt: new Date(Date.now() + 3600000).toISOString() }],
  growthOpportunities: [], onboardingOrders: [], auditEvents: []
}));
const existingTenantId = '00000000-0000-4000-8000-000000000001';
const tenantDirectory = path.join(temp, 'tenants');
const existingTenantFile = path.join(tenantDirectory, `${existingTenantId}.json`);
const existingTenant = {
  company: { id: existingTenantId, name: 'Existing Customer', createdAt: '2026-01-01T00:00:00.000Z' },
  users: [{ id: 1, email: 'existing@example.invalid', role: 'owner', status: 'Active' }]
};
fs.mkdirSync(tenantDirectory, { recursive: true });
fs.writeFileSync(existingTenantFile, JSON.stringify(existingTenant, null, 2));

Object.assign(process.env, {
  NODE_ENV: 'production',
  PDL_DB_FILE: dbFile,
  PDL_PLATFORM_FILE: platformFile,
  PDL_REQUIRE_AUTH: '1',
  PDL_SUPABASE_ENABLED: '1',
  SUPABASE_URL: 'https://signup-durability.invalid',
  SUPABASE_SECRET_KEY: 'synthetic-signup-secret',
  PDL_TRANSACTIONAL_DB: 'primary',
  PDL_PLATFORM_TRANSACTIONAL_DB: 'off',
  PDL_EMAIL_DEV_MODE: '1'
});
delete process.env.RESEND_API_KEY;

const supabase = require('./database/supabase');
const remoteTenants = new Map();
const transactionalTenants = new Map();
let tenantFailures = 0;
let transactionalFailures = 0;
let platformFailures = 0;
supabase.configured = () => true;
supabase.findCompanyByUserEmail = async email => {
  const normalized = String(email || '').toLowerCase();
  return [...remoteTenants.values()].find(tenant => (tenant.users || []).some(user => String(user.email || '').toLowerCase() === normalized))?.company?.id || null;
};
supabase.saveCompanySnapshot = async snapshot => {
  if (snapshot?.platform) {
    if (platformFailures > 0) { platformFailures--; throw new Error('synthetic platform save failure'); }
    return true;
  }
  if (tenantFailures > 0) { tenantFailures--; throw new Error('synthetic tenant save failure'); }
  remoteTenants.set(String(snapshot.company.id), structuredClone(snapshot));
  return true;
};
supabase.loadCompanySnapshot = async companyId => structuredClone(remoteTenants.get(String(companyId)) || null);
supabase.listCompanySnapshots = async () => [...remoteTenants.values()].map(snapshot => structuredClone(snapshot));
supabase.loadTransactionalSnapshot = async companyId => {
  const stored = transactionalTenants.get(String(companyId));
  return stored ? structuredClone(stored) : null;
};
supabase.findTransactionalCompanyIdByUserEmail = async email => {
  const normalized = String(email || '').trim().toLowerCase();
  return [...transactionalTenants.values()].find(row => (row.snapshot.users || []).some(user => user.status === 'Active' && String(user.email || '').trim().toLowerCase() === normalized))?.snapshot?.company?.id || null;
};
supabase.listTransactionalSnapshots = async () => [...transactionalTenants.values()].map(row => structuredClone(row));
supabase.saveTransactionalSnapshot = async (snapshot, expectedRevision = 0) => {
  if (transactionalFailures > 0) { transactionalFailures--; throw new Error('synthetic transactional persistence failure'); }
  const companyId = String(snapshot.company.id), current = transactionalTenants.get(companyId), actualRevision = Number(current?.revision || 0);
  if (Number(expectedRevision) !== actualRevision) throw Object.assign(new Error('synthetic transactional revision conflict'), { code: 'PDL_REVISION_CONFLICT' });
  const saved = { snapshot: structuredClone(snapshot), revision: actualRevision + 1 };
  transactionalTenants.set(companyId, saved);
  return { companyId, revision: saved.revision, records: 0, contentHash: 'synthetic' };
};

const { server, retryPendingSignupGrowth } = require('./server');

async function request(base, payload) {
  const response = await fetch(`${base}/api/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return { status: response.status, data: await response.json() };
}

async function platformRequest(base, route, payload) {
  const response = await fetch(`${base}${route}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${platformOwnerToken}` },
    body: JSON.stringify(payload)
  });
  return { status: response.status, data: await response.json() };
}

function tenantFiles() {
  const directory = path.join(temp, 'tenants');
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter(file => file.endsWith('.json')) : [];
}

function readTenant(companyId) {
  return JSON.parse(fs.readFileSync(path.join(temp, 'tenants', `${companyId}.json`), 'utf8'));
}

function readPlatform() {
  return JSON.parse(fs.readFileSync(platformFile, 'utf8'));
}

(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const baseSignup = {
      ownerName: 'Durable Owner',
      password: 'SyntheticPassword!42',
      plan: 'growth',
      billingCycle: 'monthly',
      legalAccepted: true,
      legalVersion: '2026-09-17'
    };

    transactionalFailures = 1;
    const failed = await request(base, { ...baseSignup, companyName: 'Retry Builders', email: 'retry@example.invalid' });
    assert.equal(failed.status, 503);
    assert.equal(failed.data.code, 'signup_persistence_failed');
    assert.deepEqual(tenantFiles(), [`${existingTenantId}.json`], 'a failed tenant cloud commit removes only its brand-new local file');
    assert.deepEqual(JSON.parse(fs.readFileSync(existingTenantFile, 'utf8')), existingTenant, 'unrelated tenants must remain byte-for-byte equivalent data');
    assert.equal(remoteTenants.size, 0);

    const retried = await request(base, { ...baseSignup, companyName: 'Retry Builders', email: 'retry@example.invalid' });
    assert.equal(retried.status, 201, JSON.stringify(retried.data));
    assert.equal(readTenant(retried.data.company.id).company.platformGrowthSync.status, 'synced');
    assert.equal(transactionalTenants.get(retried.data.company.id).snapshot.company.platformGrowthSync.status, 'synced', 'the transactional tenant source is marked synced too');

    tenantFailures = 1;
    const mirrorDeferred = await request(base, { ...baseSignup, companyName: 'Mirror Safe Builders', email: 'mirror-safe@example.invalid' });
    assert.equal(mirrorDeferred.status, 201, 'a failed legacy mirror cannot reject an authoritative transactional signup');
    assert.ok(transactionalTenants.has(mirrorDeferred.data.company.id), 'the new workspace is immediately present in the primary repository');
    assert.equal(readTenant(mirrorDeferred.data.company.id).company.platformGrowthSync.status, 'synced');

    platformFailures = 1;
    const deferred = await request(base, {
      ...baseSignup,
      companyName: 'Deferred Growth Builders',
      email: 'deferred@example.invalid',
      onboardingPreference: 'virtual',
      utmSource: 'partner',
      utmCampaign: 'fall-launch'
    });
    assert.equal(deferred.status, 201, 'a CRM/platform failure must not reject a durable customer signup');
    const deferredId = deferred.data.company.id;
    assert.equal(readTenant(deferredId).company.platformGrowthSync.status, 'pending');
    assert.equal(remoteTenants.get(deferredId).company.platformGrowthSync.status, 'pending');

    const firstRecovery = await retryPendingSignupGrowth();
    assert.deepEqual(firstRecovery, { retried: 1, synced: 1 });
    assert.equal(readTenant(deferredId).company.platformGrowthSync.status, 'synced');
    assert.equal(remoteTenants.get(deferredId).company.platformGrowthSync.status, 'synced');

    const secondRecovery = await retryPendingSignupGrowth();
    assert.deepEqual(secondRecovery, { retried: 0, synced: 0 }, 'a completed recovery is not replayed');
    const platform = readPlatform();
    const deferredOpportunities = platform.growthOpportunities.filter(row => String(row.linkedCompanyId) === deferredId);
    assert.equal(deferredOpportunities.length, 1, 'retry does not duplicate the opportunity');
    assert.equal(deferredOpportunities[0].notes.filter(row => /Created a growth monthly workspace/.test(row.text)).length, 1, 'retry does not duplicate the signup note');
    assert.equal(platform.onboardingOrders.filter(row => String(row.companyId) === deferredId).length, 1, 'retry does not duplicate onboarding work');
    assert.equal(platform.auditEvents.filter(row => row.action === 'growth_signup_linked' && String(row.companyId) === deferredId).length, 1, 'retry does not duplicate the signup audit event');

    platformFailures = 1;
    const concurrent = await request(base, { ...baseSignup, companyName: 'Lock Order Builders', email: 'locks@example.invalid' });
    assert.equal(concurrent.status, 201);
    const concurrentId = concurrent.data.company.id;
    let releaseLoad;
    const loadReleased = new Promise(resolve => { releaseLoad = resolve; });
    let announceLoad;
    const loadStarted = new Promise(resolve => { announceLoad = resolve; });
    const baseLoadTransactional = supabase.loadTransactionalSnapshot;
    let gateLoad = true;
    supabase.loadTransactionalSnapshot = async companyId => {
      if (gateLoad && String(companyId) === concurrentId) {
        gateLoad = false;
        announceLoad();
        await loadReleased;
      }
      return baseLoadTransactional(companyId);
    };
    const concurrentRetry = retryPendingSignupGrowth();
    await loadStarted;
    const adminMutation = platformRequest(base, `/api/platform/companies/${encodeURIComponent(concurrentId)}/features`, { timeCards: true });
    await new Promise(resolve => setTimeout(resolve, 25));
    releaseLoad();
    const [concurrentRecovery, featureResult] = await Promise.race([
      Promise.all([concurrentRetry, adminMutation]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('signup retry and platform tenant mutation deadlocked')), 2000))
    ]);
    assert.deepEqual(concurrentRecovery, { retried: 1, synced: 1 });
    assert.equal(featureResult.status, 200, JSON.stringify(featureResult.data));
    assert.equal(readTenant(concurrentId).company.features.timeCards, true);

    console.log('Signup durability passed: tenant-save rollback permits retry, durable signups survive CRM failure, transactional markers recover idempotently, and lock ordering does not deadlock.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})();
