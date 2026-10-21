'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Stripe = require('stripe');
const { fixture, companyA, companyB, token } = require('./fixtures/project-assistant');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-shadow-authority-'));
const dbFile = path.join(temp, 'db.json');
const platformFile = path.join(temp, 'platform.json');
const tenantFile = path.join(temp, 'tenants', `${companyA}.json`);
fs.writeFileSync(dbFile, JSON.stringify(fixture(companyB), null, 2));
fs.writeFileSync(platformFile, JSON.stringify({ users: [], sessions: [] }, null, 2));

const legacyName = 'Legacy Supabase Authority';
const transactionalName = 'Unqualified Transactional Candidate';
let legacy = fixture(companyA);
legacy.company = { ...legacy.company, name: legacyName, persistence: { revision: 10 } };
let transactional = fixture(companyA);
transactional.company = { ...transactional.company, name: transactionalName, persistence: { revision: 99 } };
let legacyAvailable = true;
let transactionalAvailable = true;
let transactionalRevision = 7;
let supabaseConfigured = true;
const transactionalExpectedRevisions = [];
const stripeSecret = 'whsec_shadow_authority_test';

Object.assign(process.env, {
  NODE_ENV: 'production',
  PDL_REQUIRE_AUTH: '1',
  PDL_DB_FILE: dbFile,
  PDL_PLATFORM_FILE: platformFile,
  PDL_SUPABASE_ENABLED: '1',
  SUPABASE_URL: 'https://shadow-authority.invalid',
  SUPABASE_SECRET_KEY: 'synthetic-service-secret',
  PDL_TRANSACTIONAL_DB: 'shadow',
  PDL_PLATFORM_TRANSACTIONAL_DB: 'off',
  PDL_EMAIL_DEV_MODE: '1',
  STRIPE_WEBHOOK_SECRET: stripeSecret,
  STRIPE_SECRET_KEY: 'sk_test_shadow_authority',
  STRIPE_PRICE_STARTER: 'price_shadow_starter'
});

for (const key of ['SENTRY_DSN', 'RESEND_API_KEY', 'DATABASE_URL']) delete process.env[key];

const supabase = require('./database/supabase');
supabase.loadLocalEnv = () => {};
supabase.configured = () => supabaseConfigured;
supabase.loadCompanySnapshot = async id => legacyAvailable && String(id) === companyA ? structuredClone(legacy) : null;
supabase.listCompanySnapshots = async () => legacyAvailable ? [structuredClone(legacy)] : [];
supabase.saveCompanySnapshot = async snapshot => {
  if (String(snapshot?.company?.id) === companyA) legacy = structuredClone(snapshot);
  return true;
};
supabase.loadTransactionalSnapshot = async id => transactionalAvailable && String(id) === companyA
  ? { snapshot: structuredClone(transactional), revision: transactionalRevision, contentHash: 'a'.repeat(64) }
  : null;
supabase.listTransactionalSnapshots = async () => transactionalAvailable
  ? [{ companyId: companyA, snapshot: structuredClone(transactional), revision: transactionalRevision, contentHash: 'a'.repeat(64) }]
  : [];
supabase.saveTransactionalSnapshot = async (snapshot, expectedRevision) => {
  transactionalExpectedRevisions.push(expectedRevision);
  assert.equal(expectedRevision, transactionalRevision, 'shadow write must use the loaded transactional CAS revision');
  transactional = structuredClone(snapshot);
  transactionalRevision += 1;
  return { revision: transactionalRevision, contentHash: 'b'.repeat(64), records: 1 };
};
supabase.createVerifiedBackup = async snapshot => ({
  bucket: 'tenant-backups', objectKey: `${snapshot.company.id}/synthetic.json`, hash: 'c'.repeat(64), bytes: 1, verifiedAt: new Date().toISOString()
});
supabase.upload = async () => ({});
require('./database/backup-verification').backupDue = () => false;

const realFetch = global.fetch;
const currentSubscription = {
  id: 'sub_shadow_authority',
  customer: 'cus_shadow_authority',
  metadata: { company_id: companyA },
  status: 'active',
  items: { data: [{ price: { id: 'price_shadow_starter' }, current_period_end: 1_900_000_000 }] }
};
global.fetch = async (url, options) => {
  if (String(url).startsWith('https://api.stripe.com/')) {
    assert.equal(options.method, 'GET');
    return new Response(JSON.stringify(currentSubscription));
  }
  return realFetch(url, options);
};

const { server } = require('./server');

async function request(base, route, { company = true, tokenValue = token(companyA, 1) } = {}) {
  const headers = { Authorization: `Bearer ${tokenValue}` };
  if (company) headers['X-PDL-Company'] = companyA;
  const response = await realFetch(base + route, {
    headers
  });
  let data = null;
  try { data = await response.json(); } catch {}
  return { status: response.status, data };
}

async function sendWebhook(base, id) {
  const event = {
    id,
    type: 'customer.subscription.updated',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: { object: structuredClone(currentSubscription) }
  };
  const payload = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: stripeSecret });
  return realFetch(`${base}/api/billing/webhook`, {
    method: 'POST', body: payload,
    headers: { 'content-type': 'application/json', 'stripe-signature': signature }
  });
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(fs.existsSync(tenantFile), false, 'test starts like a fresh Render instance with no tenant mirror');

    for (const route of ['/api/config', '/api/state', '/api/auth/me', '/api/company-activities', '/api/time-off-requests']) {
      const result = await request(base, route);
      assert.equal(result.status, 200, `${route} must not depend on an ephemeral tenant file: ${JSON.stringify(result.data)}`);
      if (route === '/api/state') assert.equal(result.data.company.name, legacyName, 'shadow reads keep legacy Supabase authoritative');
    }
    assert.ok(transactionalExpectedRevisions.length >= 1, 'a session-renewal write reaches the transactional shadow');
    assert.equal(transactionalExpectedRevisions[0], 7, 'the request carries the comparison revision into its shadow write');
    assert.equal(fs.existsSync(tenantFile), true, 'the first acknowledged write heals the disposable local mirror');
    assert.equal(JSON.parse(fs.readFileSync(tenantFile, 'utf8')).company.name, legacyName);
    assert.equal(legacy.company.name, legacyName);
    assert.equal(transactional.company.name, legacyName, 'shadow persistence follows legacy authority, not the divergent candidate');

    fs.rmSync(tenantFile, { force: true });
    const webhook = await sendWebhook(base, 'evt_shadow_cold_start');
    assert.equal(webhook.status, 200, await webhook.text());
    assert.equal(legacy.company.subscriptionStatus, 'Active', 'cold-start webhook persists to legacy cloud authority');
    assert.ok(legacy.company.stripeWebhookEvents.includes('evt_shadow_cold_start'));
    assert.equal(transactional.company.subscriptionStatus, 'Active', 'cold-start webhook also updates the transactional shadow');
    assert.ok(transactional.company.stripeWebhookEvents.includes('evt_shadow_cold_start'));
    assert.equal(fs.existsSync(tenantFile), true, 'cold-start webhook heals the disposable local mirror');

    const revisionAfterWebhook = transactionalRevision;
    const duplicateWebhook = await sendWebhook(base, 'evt_shadow_cold_start');
    assert.equal(duplicateWebhook.status, 200, await duplicateWebhook.text());
    assert.equal(legacy.company.stripeWebhookEvents.filter(id => id === 'evt_shadow_cold_start').length, 1, 'webhook retry remains idempotent');
    assert.ok(transactionalRevision > revisionAfterWebhook, 'webhook retry repeats persistence so a prior partial cloud failure can heal');

    fs.rmSync(tenantFile, { force: true });
    legacyAvailable = false;
    transactionalAvailable = true;
    process.env.PDL_TRANSACTIONAL_DB = 'shadow';
    let result = await request(base, '/api/state');
    assert.equal(result.status, 404, 'shadow-only data fails closed before primary cutover');

    fs.mkdirSync(path.dirname(tenantFile), { recursive: true });
    fs.writeFileSync(tenantFile, JSON.stringify(fixture(companyA), null, 2));
    legacyAvailable = true;
    transactionalAvailable = false;
    process.env.PDL_TRANSACTIONAL_DB = 'primary';
    result = await request(base, '/api/state');
    assert.equal(result.status, 404, 'primary mode never falls back to legacy or local mirrors');

    supabaseConfigured = false;
    result = await request(base, '/api/state');
    assert.equal(result.status, 404, 'primary mode fails closed when Supabase credentials are unavailable');

    supabaseConfigured = true;
    transactionalAvailable = true;
    transactional.company.name = transactionalName;
    result = await request(base, '/api/state');
    assert.equal(result.status, 200);
    assert.equal(result.data.company.name, transactionalName, 'primary mode reads only transactional authority');

    const staleLocalToken = 'stale-local-session-token';
    const staleLocal = fixture(companyA);
    staleLocal.sessions.push({
      id: crypto.randomUUID(), userId: 1,
      tokenHash: crypto.createHash('sha256').update(staleLocalToken).digest('hex'),
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    fs.writeFileSync(tenantFile, JSON.stringify(staleLocal, null, 2));
    result = await request(base, '/api/state', { company: false, tokenValue: staleLocalToken });
    assert.equal(result.status, 404, 'headerless primary requests discover sessions only through transactional authority');

    process.env.PDL_TRANSACTIONAL_DB = 'off';
    fs.rmSync(tenantFile, { force: true });
    result = await request(base, '/api/state');
    assert.equal(result.status, 200);
    assert.equal(result.data.company.name, legacyName, 'off mode retains the durable legacy-cloud fallback');

    console.log('Tenant authority routing passed: shadow survives fresh Render filesystems without promoting comparison data, primary fails closed, and legacy mode remains available.');
  } finally {
    global.fetch = realFetch;
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

