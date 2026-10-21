'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-revenue-concurrency-'));
const dbFile = path.join(temp, 'db.json');
const platformFile = path.join(temp, 'platform.json');
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), dbFile);

const token = 'synthetic-revenue-owner-session';
const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
fs.writeFileSync(platformFile, JSON.stringify({
  users: [{ id: 'owner', name: 'Owner', email: 'owner@example.invalid', role: 'platform_owner', status: 'Active', mustSetPassword: false }],
  sessions: [{ id: 'session', userId: 'owner', tokenHash: crypto.createHash('sha256').update(token).digest('hex'), expiresAt: '2099-01-01T00:00:00.000Z' }],
  demoRequests: [{ id: requestId, name: 'Lead', company: 'Lead Co', email: 'lead@example.invalid', status: 'New' }],
  supportTickets: [], onboardingOrders: [], followUps: [], supportGrants: [], auditEvents: [], growthOpportunities: []
}));

Object.assign(process.env, {
  NODE_ENV: 'production',
  PDL_DB_FILE: dbFile,
  PDL_PLATFORM_FILE: platformFile,
  PDL_SUPABASE_ENABLED: '0',
  PDL_TRANSACTIONAL_DB: 'off',
  PDL_PLATFORM_TRANSACTIONAL_DB: 'off',
  PDL_REQUIRE_AUTH: '1',
  PDL_EMAIL_DEV_MODE: '1'
});

const revenueModule = require('./revenue-reporting');
const createReporter = revenueModule.createRevenueReporter;
revenueModule.createRevenueReporter = () => {
  const delayedList = async () => {
    await new Promise(resolve => setTimeout(resolve, 1500));
    return { data: [], has_more: false };
  };
  const client = Object.fromEntries(['balanceTransactions', 'charges', 'refunds', 'subscriptions', 'subscriptionItems'].map(key => [key, { list: delayedList }]));
  return createReporter({
    getSecret: () => 'sk_test_synthetic',
    createClient: () => client,
    maxDurationMs: 5000,
    cacheMs: 0
  });
};

const { server } = require('./server');
const headers = { Cookie: `pdl_platform=${token}`, 'Content-Type': 'application/json' };

(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const revenue = fetch(base + '/api/platform/revenue', { headers });
    await new Promise(resolve => setTimeout(resolve, 120));

    const mutation = fetch(base + `/api/platform/demo-requests/${requestId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status: 'Contacted' })
    });
    const winner = await Promise.race([
      mutation.then(response => ({ kind: 'mutation', response })),
      revenue.then(response => ({ kind: 'revenue', response })),
      new Promise(resolve => setTimeout(() => resolve({ kind: 'timeout' }), 900))
    ]);
    assert.equal(winner.kind, 'mutation', 'a slow Stripe read must not retain the platform mutation queue');
    assert.equal(winner.response.status, 200);
    assert.equal((await winner.response.json()).status, 'Contacted');

    const revenueResponse = await revenue;
    assert.equal(revenueResponse.status, 200);
    assert.equal((await revenueResponse.json()).status, 'ready');
    assert.equal(JSON.parse(fs.readFileSync(platformFile, 'utf8')).demoRequests[0].status, 'Contacted');
    console.log('Revenue concurrency passed: a slow Stripe read does not block a serialized back-office mutation.');
  } finally {
    revenueModule.createRevenueReporter = createReporter;
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
