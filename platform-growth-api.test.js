'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validGrowthReport } = require('./platform-growth-ui');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-growth-api-'));
const dbFile = path.join(tempDir, 'db.json');
const platformFile = path.join(tempDir, 'platform.json');
const tenant = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
fs.writeFileSync(dbFile, JSON.stringify(tenant, null, 2));

const token = 'growth-api-owner-session';
const billingToken = 'growth-api-billing-session';
const tokenHash = value => crypto.createHash('sha256').update(value).digest('hex');
const now = new Date();
const expiresAt = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString();
fs.writeFileSync(platformFile, JSON.stringify({
  users: [
    { id: 42, name: 'Growth Owner', email: 'growth@example.invalid', role: 'platform_owner', status: 'Active', mustSetPassword: false },
    { id: 'billing-1', name: 'Billing User', email: 'billing@example.invalid', role: 'billing', status: 'Active', mustSetPassword: false }
  ],
  sessions: [
    { id: crypto.randomUUID(), userId: 42, tokenHash: tokenHash(token), createdAt: now.toISOString(), expiresAt },
    { id: crypto.randomUUID(), userId: 'billing-1', tokenHash: tokenHash(billingToken), createdAt: now.toISOString(), expiresAt }
  ],
  growthOpportunities: [], supportTickets: [], followUps: [], onboardingOrders: [], supportGrants: [], auditEvents: []
}, null, 2));

Object.assign(process.env, {
  NODE_ENV: 'production',
  PDL_REQUIRE_AUTH: '1',
  PDL_PLATFORM_TRANSACTIONAL_DB: 'off',
  PDL_DB_FILE: dbFile,
  PDL_PLATFORM_FILE: platformFile,
  PDL_SUPABASE_ENABLED: '0',
  PDL_EMAIL_DEV_MODE: '1'
});

const { server } = require('./server');

server.listen(0, async () => {
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (route, { method = 'GET', bearer = token, body, idempotencyKey } = {}) => {
      const headers = { Accept: 'application/json' };
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
      const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await response.json();
      return { status: response.status, data };
    };
    const expect = async (status, route, options) => {
      const result = await call(route, options);
      assert.equal(result.status, status, `${route}: ${JSON.stringify(result.data)}`);
      return result.data;
    };
    const today = new Date().toISOString().slice(0, 10);
    const start = `${today.slice(0, 8)}01`;

    const empty = await expect(200, `/api/platform/growth?start=${start}&end=${today}`);
    assert.equal(validGrowthReport(empty, start, today), true, 'the real API response satisfies the browser contract');
    assert.equal(empty.opportunityTotal, 0);
    assert.deepEqual(empty.owners.map(owner => owner.id), ['42'], 'numeric persisted ids become stable string ids');
    assert.equal((await expect(403, '/api/platform/growth', { bearer: billingToken })).code, 'platform_forbidden');

    const created = await expect(201, '/api/platform/growth/opportunities', {
      method: 'POST', idempotencyKey: 'growth:api-contract-create-1',
      body: { companyName: 'Contract Builders', email: 'owner@contract.example', ownerUserId: '42', linkedCompanyId: String(tenant.company.id), source: 'Website', expectedMrrMinor: 19900, currency: 'usd' }
    });
    assert.equal(created.status, 'created');
    let opportunity = created.opportunity;
    assert.equal(opportunity.version, 1);
    assert.equal(Object.hasOwn(opportunity, 'history'), false);
    assert.equal(Object.hasOwn(opportunity, 'idempotency'), false);

    const duplicate = await expect(409, '/api/platform/growth/opportunities', {
      method: 'POST', idempotencyKey: 'growth:api-contract-create-2',
      body: { companyName: 'Contract Builders duplicate', email: 'owner@contract.example' }
    });
    assert.equal(duplicate.code, 'duplicate_opportunity');
    assert.equal(duplicate.duplicates[0].id, opportunity.id);

    const badOwner = await expect(400, '/api/platform/growth/opportunities', {
      method: 'POST', idempotencyKey: 'growth:api-contract-invalid-owner',
      body: { companyName: 'Bad owner', ownerUserId: 'missing-user' }
    });
    assert.equal(badOwner.code, 'invalid_owner');
    const badCompany = await expect(400, '/api/platform/growth/opportunities', {
      method: 'POST', idempotencyKey: 'growth:api-contract-invalid-company',
      body: { companyName: 'Bad company', linkedCompanyId: 'missing-company' }
    });
    assert.equal(badCompany.code, 'invalid_company');

    const id = encodeURIComponent(opportunity.id);
    opportunity = (await expect(200, `/api/platform/growth/opportunities/${id}`, {
      method: 'PATCH', body: { companyName: 'Contract Builders LLC', expectedVersion: opportunity.version }
    })).opportunity;
    opportunity = (await expect(200, `/api/platform/growth/opportunities/${id}/stage`, {
      method: 'POST', body: { stage: 'contacted', reason: 'Reached the owner', expectedVersion: opportunity.version }
    })).opportunity;
    opportunity = (await expect(200, `/api/platform/growth/opportunities/${id}/next-action`, {
      method: 'POST', body: { description: 'Book the demo', dueAt: new Date(Date.now() + 86400000).toISOString(), expectedVersion: opportunity.version }
    })).opportunity;
    opportunity = (await expect(200, `/api/platform/growth/opportunities/${id}/notes`, {
      method: 'POST', body: { text: 'Needs excavation production tracking', expectedVersion: opportunity.version }
    })).opportunity;
    opportunity = (await expect(200, `/api/platform/growth/opportunities/${id}/next-action/complete`, {
      method: 'POST', body: { expectedVersion: opportunity.version }
    })).opportunity;
    opportunity = (await expect(200, `/api/platform/growth/opportunities/${id}/next-action`, {
      method: 'POST', body: { description: 'Follow up Friday', dueAt: new Date(Date.now() + 172800000).toISOString(), expectedVersion: opportunity.version }
    })).opportunity;
    opportunity = (await expect(200, `/api/platform/growth/opportunities/${id}/next-action/cancel`, {
      method: 'POST', body: { reason: 'Customer asked us to stop', expectedVersion: opportunity.version }
    })).opportunity;

    let report = await expect(200, `/api/platform/growth?start=${start}&end=${today}`);
    assert.equal(validGrowthReport(report, start, today), true);
    assert.equal(report.opportunityTotal, 1);
    assert.equal(report.metrics.pipeline.count, 1);
    assert.equal(report.opportunities[0].companyName, 'Contract Builders LLC');

    opportunity = (await expect(200, `/api/platform/growth/opportunities/${id}/stage`, {
      method: 'POST', body: { stage: 'lost', lossReason: 'Chose another product', expectedVersion: opportunity.version }
    })).opportunity;
    report = await expect(200, `/api/platform/growth?start=${start}&end=${today}`);
    assert.equal(validGrowthReport(report, start, today), true, 'closed outcomes remain in metrics without inflating the active pipeline');
    assert.equal(report.opportunityTotal, 0);
    assert.equal(report.metrics.pipeline.count, 0);
    assert.equal(report.metrics.funnel.lost, 1);

    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    assert.equal((await expect(400, `/api/platform/growth?start=${start}&end=${tomorrow}`)).code, 'invalid_period');

    console.log('Platform Growth HTTP contract passed: exact browser report shape, every mutation route, active-pipeline semantics, duplicate copy, reference validation, permissions, and current-day periods.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
