'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-revenue-primary-'));
const dbFile = path.join(temp, 'db.json');
const platformFile = path.join(temp, 'platform.json');
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), dbFile);
fs.copyFileSync(path.join(__dirname, 'data', 'platform.json'), platformFile);
fs.mkdirSync(path.join(temp, 'tenants'), { recursive: true });
fs.writeFileSync(path.join(temp, 'tenants', 'corrupt-legacy-mirror.json'), '{corrupt');

Object.assign(process.env, {
  NODE_ENV: 'test',
  PDL_DB_FILE: dbFile,
  PDL_PLATFORM_FILE: platformFile,
  PDL_SUPABASE_ENABLED: '1',
  SUPABASE_URL: 'https://revenue-primary.invalid',
  SUPABASE_SECRET_KEY: 'synthetic-service-role-secret',
  PDL_TRANSACTIONAL_DB: 'primary',
  PDL_PLATFORM_TRANSACTIONAL_DB: 'off'
});

const supabase = require('./database/supabase');
supabase.loadLocalEnv = () => {};
let directoryReads = 0;
supabase.listTransactionalTenantSummaries = async () => {
  directoryReads += 1;
  return [{
    companyId: 'authoritative-tenant',
    databaseCompanyId: '11111111-1111-4111-8111-111111111111',
    revision: 19,
    updatedAt: '2026-10-20T20:00:00.000Z',
    users: 4,
    projects: 2,
    reports: 10,
    lastReport: '2026-10-20T19:00:00.000Z',
    company: {
      id: 'authoritative-tenant',
      name: 'Authoritative Concrete',
      stripeCustomerId: 'cus_authoritative',
      stripeSubscriptionId: 'sub_authoritative',
      persistence: { revision: 2, updatedAt: '2026-01-01T00:00:00.000Z' },
      privateNotes: 'must not leave server'
    }
  }];
};
let forbiddenReads = 0;
supabase.request = async () => { forbiddenReads += 1; throw new Error('legacy companies must not be read'); };
supabase.listCompanySnapshots = async () => { forbiddenReads += 1; throw new Error('legacy snapshots must not be read'); };
supabase.listTransactionalSnapshots = async () => { forbiddenReads += 1; throw new Error('full tenant snapshots must not be read'); };

const { platformRevenueCompanies } = require('./server');

(async () => {
  try {
    const companies = await platformRevenueCompanies();
    assert.deepEqual(companies, [{
      id: 'authoritative-tenant',
      name: 'Authoritative Concrete',
      stripeCustomerId: 'cus_authoritative',
      stripeSubscriptionId: 'sub_authoritative',
      persistence: { revision: 19, updatedAt: '2026-10-20T20:00:00.000Z' }
    }]);
    assert.equal(directoryReads, 1);
    assert.equal(forbiddenReads, 0, 'primary revenue must not read legacy, local, or full-snapshot sources');
    assert.equal(JSON.stringify(companies).includes('privateNotes'), false);
    console.log('Primary revenue mapping passed: Stripe links come only from the compact authoritative transactional directory.');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
