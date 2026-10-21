'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-platform-tenant-admin-'));
const dbFile = path.join(tempDir, 'db.json');
const platformFile = path.join(tempDir, 'platform.json');
const tenantDir = path.join(tempDir, 'tenants');
const primary = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
const companyId = crypto.randomUUID();
const child = structuredClone(primary);
child.company = { ...child.company, id: companyId, name: 'Remote Ready Builders', demo: false, persistence: { revision: 3 } };
child.users = [{ ...child.users[0], id: 1, companyId, name: 'Company Owner', email: 'owner@remote-ready.example', role: 'owner', status: 'Active' }];
child.sessions = [];
fs.mkdirSync(tenantDir, { recursive: true });
fs.writeFileSync(dbFile, JSON.stringify(primary, null, 2));
fs.writeFileSync(path.join(tenantDir, `${companyId}.json`), JSON.stringify(child, null, 2));

const token = 'platform-tenant-admin-owner-token';
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
const now = new Date().toISOString();
fs.writeFileSync(platformFile, JSON.stringify({
  users: [{ id: 'owner-1', name: 'Platform Owner', email: 'platform@example.invalid', role: 'platform_owner', status: 'Active', mustSetPassword: false }],
  sessions: [{ id: crypto.randomUUID(), userId: 'owner-1', tokenHash, createdAt: now, expiresAt: new Date(Date.now() + 3600000).toISOString() }],
  supportGrants: [], auditEvents: [], growthOpportunities: [], supportTickets: [], followUps: [], onboardingOrders: []
}, null, 2));

Object.assign(process.env, {
  NODE_ENV: 'production',
  PDL_REQUIRE_AUTH: '1',
  PDL_PLATFORM_TRANSACTIONAL_DB: 'off',
  PDL_DB_FILE: dbFile,
  PDL_PLATFORM_FILE: platformFile,
  PDL_SUPABASE_ENABLED: '0',
  PDL_EMAIL_DEV_MODE: '1',
  PDL_PUBLIC_URL: 'https://app.example.invalid'
});

const { server } = require('./server');

server.listen(0, async () => {
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (route, { method = 'GET', body, bearer = token } = {}) => {
      const headers = { Accept: 'application/json' };
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await response.json();
      return { status: response.status, data };
    };
    const expect = async (status, route, options) => {
      const result = await call(route, options);
      assert.equal(result.status, status, `${route}: ${JSON.stringify(result.data)}`);
      return result.data;
    };
    const companyRoute = `/api/platform/companies/${encodeURIComponent(companyId)}`;

    const [timeCards, templates] = await Promise.all([
      expect(200, `${companyRoute}/features`, { method: 'PATCH', body: { timeCards: true } }),
      expect(200, `${companyRoute}/features`, { method: 'PATCH', body: { templates: true } })
    ]);
    assert.equal(timeCards.timeCards || templates.timeCards, true);
    assert.equal(timeCards.templates || templates.templates, true);
    let stored = JSON.parse(fs.readFileSync(path.join(tenantDir, `${companyId}.json`), 'utf8'));
    assert.deepEqual(stored.company.features, { timeCards: true, templates: true }, 'serialized feature writes preserve both updates');
    assert.ok(stored.company.persistence.revision >= 5, 'back-office tenant writes advance the same tenant revision');

    const subscription = await expect(200, `${companyRoute}/subscription`, {
      method: 'PATCH',
      body: { plan: 'growth', planPrice: 199, status: 'Active', accountType: 'standard', cohort: 'October 2026' }
    });
    assert.equal(subscription.plan, 'growth');
    assert.equal(subscription.status, 'Active');

    const reset = await expect(200, `${companyRoute}/owner-reset`, { method: 'POST', body: {} });
    assert.equal(reset.email, 'owner@remote-ready.example');
    assert.equal(reset.sent, false);
    assert.ok(reset.previewToken);
    stored = JSON.parse(fs.readFileSync(path.join(tenantDir, `${companyId}.json`), 'utf8'));
    assert.ok(stored.users[0].resetTokenHash, 'owner reset token is stored in the target tenant');

    const grant = await expect(201, '/api/platform/support-access', {
      method: 'POST', body: { companyId, reason: 'Verify customer configuration', minutes: 15 }
    });
    const supportToken = new URL(grant.url, 'https://app.example.invalid').searchParams.get('token');
    const support = await expect(200, `/api/support-session/${supportToken}`, { bearer: null });
    assert.equal(support.banner.companyName, child.company.name);
    assert.equal(support.summary.plan, 'growth');

    await expect(200, `${companyRoute}/archive`, { method: 'POST', body: {} });
    stored = JSON.parse(fs.readFileSync(path.join(tenantDir, `${companyId}.json`), 'utf8'));
    assert.equal(stored.company.archivedDuplicate, true);
    await expect(200, `${companyRoute}/unarchive`, { method: 'POST', body: {} });
    stored = JSON.parse(fs.readFileSync(path.join(tenantDir, `${companyId}.json`), 'utf8'));
    assert.equal(stored.company.archivedDuplicate, false);

    const audit = await expect(200, '/api/platform/audit');
    for (const action of ['time_cards_enabled', 'templates_enabled', 'subscription_updated', 'company_owner_reset_requested', 'support_access_granted', 'support_session_viewed', 'company_archived', 'company_unarchived']) {
      assert.ok(audit.some(row => row.action === action), `audit includes ${action}`);
    }

    console.log('Platform tenant administration passed: serialized feature, subscription, owner-reset, support-access, archive, audit, and revision behavior.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
