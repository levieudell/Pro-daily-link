'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-primary-directory-'));
const dbFile = path.join(temp, 'db.json');
const platformFile = path.join(temp, 'platform.json');
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), dbFile);
fs.mkdirSync(path.join(temp, 'tenants'), { recursive: true });
fs.writeFileSync(path.join(temp, 'tenants', 'corrupt-local-mirror.json'), '{not valid json');

const platformToken = 'primary-directory-platform-session';
const tokenHash = value => crypto.createHash('sha256').update(value).digest('hex');
const now = new Date();
fs.writeFileSync(platformFile, JSON.stringify({
  users: [{
    id: 'platform-owner',
    name: 'Platform Owner',
    email: 'owner@platform.example',
    role: 'platform_owner',
    status: 'Active',
    mustSetPassword: false
  }],
  sessions: [{
    id: crypto.randomUUID(),
    userId: 'platform-owner',
    tokenHash: tokenHash(platformToken),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString()
  }],
  supportTickets: [],
  onboardingOrders: [],
  followUps: [],
  supportGrants: [],
  auditEvents: [],
  growthOpportunities: []
}, null, 2));

Object.assign(process.env, {
  NODE_ENV: 'production',
  PDL_REQUIRE_AUTH: '1',
  PDL_DB_FILE: dbFile,
  PDL_PLATFORM_FILE: platformFile,
  PDL_SUPABASE_ENABLED: '1',
  SUPABASE_URL: 'https://primary-directory.invalid',
  SUPABASE_SECRET_KEY: 'synthetic-service-role-secret',
  PDL_TRANSACTIONAL_DB: 'primary',
  PDL_PLATFORM_TRANSACTIONAL_DB: 'off'
});

const supabase = require('./database/supabase');
supabase.loadLocalEnv = () => {};

const activeCompanyId = '11111111-1111-4111-8111-111111111111';
const archivedCompanyId = '22222222-2222-4222-8222-222222222222';
const lookupCalls = [];
let directoryCalls = 0;
let forbiddenFullScanCalls = 0;

supabase.findTransactionalCompanyIdByUserEmail = async email => {
  lookupCalls.push(email);
  if (email === 'active.owner@example.test') return activeCompanyId;
  // The indexed database function excludes archived tenants and inactive
  // users. Both archived and unknown identities therefore have the same safe
  // public result: no workspace disclosure.
  return null;
};
supabase.listTransactionalTenantSummaries = async () => {
  directoryCalls += 1;
  return [
    {
      companyId: activeCompanyId,
      databaseCompanyId: activeCompanyId,
      revision: 12,
      company: {
        id: activeCompanyId,
        name: 'Indexed Concrete',
        plan: 'Growth',
        subscriptionStatus: 'Active',
        createdAt: now.toISOString()
      },
      users: 14,
      projects: 7,
      reports: 93,
      lastReport: '2026-10-19T23:15:00.000Z',
      updatedAt: '2026-10-20T12:00:00.000Z'
    },
    {
      companyId: archivedCompanyId,
      databaseCompanyId: archivedCompanyId,
      revision: 4,
      company: {
        id: archivedCompanyId,
        name: 'Archived Masonry',
        archivedDuplicate: true,
        plan: 'Starter',
        subscriptionStatus: 'Cancelled',
        createdAt: now.toISOString()
      },
      users: 2,
      projects: 1,
      reports: 5,
      lastReport: null,
      updatedAt: '2026-10-18T12:00:00.000Z'
    }
  ];
};
const forbidFullScan = async name => {
  forbiddenFullScanCalls += 1;
  throw new Error(`${name} must not be called by primary directory routes`);
};
supabase.listTransactionalSnapshots = () => forbidFullScan('listTransactionalSnapshots');
supabase.listCompanySnapshots = () => forbidFullScan('listCompanySnapshots');

const { server } = require('./server');

async function jsonRequest(base, route, options = {}) {
  const response = await fetch(base + route, options);
  const data = await response.json();
  return { status: response.status, data };
}

(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const findCompany = email => jsonRequest(base, '/api/auth/company', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });

    const active = await findCompany('  ACTIVE.Owner@Example.Test  ');
    assert.equal(active.status, 200);
    assert.equal(active.data.companyId, activeCompanyId);

    const archived = await findCompany('archived.owner@example.test');
    assert.equal(archived.status, 200);
    assert.equal(archived.data.companyId, null, 'archived tenant identities do not disclose a workspace');

    const missing = await findCompany('missing@example.test');
    assert.equal(missing.status, 200);
    assert.equal(missing.data.companyId, null, 'unknown identities do not disclose a workspace');
    assert.deepEqual(lookupCalls, [
      'active.owner@example.test',
      'archived.owner@example.test',
      'missing@example.test'
    ], 'the auth route delegates normalized addresses to the indexed lookup');

    const overview = await jsonRequest(base, '/api/platform/overview', {
      headers: { Authorization: `Bearer ${platformToken}` }
    });
    assert.equal(overview.status, 200, `authoritative directory must not depend on corrupt local mirrors: ${JSON.stringify(overview.data)}`);
    assert.equal(directoryCalls, 1, 'one compact directory query powers the platform overview');
    assert.equal(forbiddenFullScanCalls, 0, 'primary lookup and overview never enumerate full tenant snapshots');

    const indexed = overview.data.companies.find(company => company.id === activeCompanyId);
    assert.ok(indexed);
    assert.equal(indexed.users, 14);
    assert.equal(indexed.projects, 7);
    assert.equal(indexed.reports, 93);
    assert.equal(indexed.lastReport, '2026-10-19T23:15:00.000Z');
    assert.equal(overview.data.metrics.companies, 2);
    assert.equal(overview.data.metrics.users, 16);

    const archivedSummary = overview.data.companies.find(company => company.id === archivedCompanyId);
    assert.equal(archivedSummary.archived, true);
    assert.equal(archivedSummary.lastReport, null);

    console.log('Primary directory integration passed: auth uses indexed email lookup and platform overview uses compact tenant summaries without full snapshot scans.');
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
