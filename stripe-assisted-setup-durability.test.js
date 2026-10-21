'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-assisted-setup-'));
const dbFile = path.join(tempDir, 'db.json');
const platformFile = path.join(tempDir, 'platform.json');
const companyId = '11111111-1111-4111-8111-111111111111';
const ownerToken = 'assisted-setup-company-owner-token';
const platformToken = 'assisted-setup-platform-owner-token';
const tokenHash = value => crypto.createHash('sha256').update(value).digest('hex');
const now = new Date().toISOString();
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));

seed.company = {
  ...seed.company,
  id: companyId,
  name: 'Safe Setup Concrete',
  plan: 'starter',
  billingCycle: 'monthly',
  subscriptionStatus: 'Cancelled',
  stripeSubscriptionId: 'sub_founder_setup',
  stripeCustomerId: 'cus_founder_setup',
  founder: { requested: true, plan: 'starter', billingCycle: 'monthly', assistedSetup: true }
};
seed.users = [{ ...seed.users[0], id: 1, companyId, name: 'Company Owner', email: 'owner@example.invalid', role: 'owner', status: 'Active' }];
seed.sessions = [{ id: crypto.randomUUID(), userId: 1, companyId, tokenHash: tokenHash(ownerToken), createdAt: now, expiresAt: new Date(Date.now() + 3600000).toISOString() }];
fs.writeFileSync(dbFile, JSON.stringify(seed, null, 2));
fs.writeFileSync(platformFile, JSON.stringify({
  users: [{ id: 'platform-owner', name: 'Platform Owner', email: 'platform@example.invalid', role: 'platform_owner', status: 'Active', mustSetPassword: false }],
  sessions: [{ id: crypto.randomUUID(), userId: 'platform-owner', tokenHash: tokenHash(platformToken), createdAt: now, expiresAt: new Date(Date.now() + 3600000).toISOString() }],
  supportGrants: [], auditEvents: [], growthOpportunities: [], supportTickets: [], followUps: [], onboardingOrders: []
}, null, 2));

Object.assign(process.env, {
  NODE_ENV: 'production',
  PDL_REQUIRE_AUTH: '1',
  PDL_DB_FILE: dbFile,
  PDL_PLATFORM_FILE: platformFile,
  PDL_SUPABASE_ENABLED: '0',
  PDL_PLATFORM_TRANSACTIONAL_DB: 'off',
  PDL_FOUNDER_ENABLED: '1',
  STRIPE_SECRET_KEY: 'sk_test_assisted_setup',
  STRIPE_WEBHOOK_SECRET: 'whsec_assisted_setup',
  STRIPE_PRICE_STARTER: 'price_starter',
  STRIPE_PRICE_FOUNDER_STARTER: 'price_founder_starter'
});

let releaseSubscription;
const subscriptionReleased = new Promise(resolve => { releaseSubscription = resolve; });
let subscriptionRequested;
const subscriptionReached = new Promise(resolve => { subscriptionRequested = resolve; });
const realFetch = global.fetch;
const subscription = {
  id: 'sub_founder_setup', customer: 'cus_founder_setup', status: 'active', latest_invoice: 'in_paid', schedule: 'sched_founder',
  metadata: { company_id: companyId, offer: 'founder' },
  current_period_end: Math.floor(Date.now() / 1000) + 2592000,
  items: { data: [{ price: { id: 'price_founder_starter' }, quantity: 1 }] }
};
global.fetch = async (url, options) => {
  const value = String(url);
  if (!value.startsWith('https://api.stripe.com/')) return realFetch(url, options);
  if (value.endsWith('/subscriptions/sub_founder_setup')) {
    subscriptionRequested();
    await subscriptionReleased;
    return new Response(JSON.stringify(subscription));
  }
  if (value.endsWith('/invoices/in_paid')) return new Response(JSON.stringify({ id: 'in_paid', status: 'paid' }));
  if (value.endsWith('/subscription_schedules/sched_founder')) return new Response(JSON.stringify({
    id: 'sched_founder', metadata: { pdl_founder_configured: '1' }, phases: [{ start_date: Math.floor(Date.now() / 1000) }]
  }));
  throw new Error(`Unexpected Stripe request: ${value}`);
};

const { server, retryPendingAssistedSetup } = require('./server');
const timeout = (promise, message) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), 2000))]);
const readTenant = () => JSON.parse(fs.readFileSync(dbFile, 'utf8'));
const readPlatform = () => JSON.parse(fs.readFileSync(platformFile, 'utf8'));

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, token, options = {}) => {
    const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
    if (token === ownerToken) headers['x-pdl-company'] = companyId;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await realFetch(base + route, { method: options.method || 'GET', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    const data = await response.json();
    return { status: response.status, data };
  };
  try {
    // Billing owns the tenant lock while Stripe responds. The platform update
    // then owns the platform lock while waiting for that same tenant. Releasing
    // Stripe reproduces the historic inversion: tenant -> platform would hang.
    const billing = request('/api/billing', ownerToken);
    await timeout(subscriptionReached, 'billing did not reach Stripe');
    const feature = request(`/api/platform/companies/${companyId}/features`, platformToken, { method: 'PATCH', body: { timeCards: true } });
    await new Promise(resolve => setTimeout(resolve, 75));
    releaseSubscription();
    const [billingResult, featureResult] = await timeout(Promise.all([billing, feature]), 'billing and platform tenant mutation deadlocked');
    assert.equal(billingResult.status, 200, JSON.stringify(billingResult.data));
    assert.equal(featureResult.status, 200, JSON.stringify(featureResult.data));
    assert.equal(readTenant().company.platformAssistedSetupSync.status, 'pending', 'billing durably records the deferred platform work');

    await new Promise(resolve => setImmediate(resolve));
    await retryPendingAssistedSetup();
    for (let attempt = 0; attempt < 20 && readTenant().company.platformAssistedSetupSync.status !== 'synced'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(readTenant().company.platformAssistedSetupSync.status, 'synced');
    assert.equal(readTenant().company.features.timeCards, true, 'concurrent platform tenant mutation is preserved');
    assert.equal(readPlatform().onboardingOrders.filter(row => row.id === 'assisted-setup-sub_founder_setup').length, 1);
    assert.equal(readPlatform().auditEvents.filter(row => row.action === 'assisted_setup_paid').length, 1);
    await retryPendingAssistedSetup();
    assert.equal(readPlatform().onboardingOrders.filter(row => row.id === 'assisted-setup-sub_founder_setup').length, 1, 'retry is idempotent');
    await new Promise(resolve => setImmediate(resolve));
    console.log('Assisted setup durability passed: billing never waits on the platform lock, pending work recovers, and setup orders stay idempotent.');
  } finally {
    global.fetch = realFetch;
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
