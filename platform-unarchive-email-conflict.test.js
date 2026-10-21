'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-unarchive-email-conflict-'));
const dbFile = path.join(temp, 'db.json');
const platformFile = path.join(temp, 'platform.json');
const archivedCompanyId = '22222222-2222-4222-8222-222222222222';
const activeCompanyId = '33333333-3333-4333-8333-333333333333';
const token = 'platform-unarchive-conflict-token';
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
const baseTenant = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
fs.writeFileSync(dbFile, JSON.stringify(baseTenant, null, 2));
fs.writeFileSync(platformFile, JSON.stringify({
  users: [{ id: 'platform-owner', name: 'Platform Owner', email: 'platform@example.invalid', role: 'platform_owner', status: 'Active', mustSetPassword: false }],
  sessions: [{ id: crypto.randomUUID(), userId: 'platform-owner', tokenHash, expiresAt: new Date(Date.now() + 3600000).toISOString() }],
  supportGrants: [], auditEvents: [], growthOpportunities: [], onboardingOrders: [], supportTickets: [], followUps: []
}, null, 2));

const archived = structuredClone(baseTenant);
archived.company = { ...archived.company, id: archivedCompanyId, name: 'Archived Builder', archivedDuplicate: true, archivedAt: new Date().toISOString() };
archived.users = [{ id: 1, name: 'Archived Owner', email: 'shared-owner@example.invalid', role: 'owner', status: 'Active' }];

Object.assign(process.env, {
  NODE_ENV: 'production', PDL_REQUIRE_AUTH: '1', PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: platformFile,
  PDL_SUPABASE_ENABLED: '1', SUPABASE_URL: 'https://unarchive-email-conflict.invalid', SUPABASE_SECRET_KEY: 'synthetic-service-role-secret',
  PDL_TRANSACTIONAL_DB: 'primary', PDL_PLATFORM_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1'
});

const supabase = require('./database/supabase');
supabase.loadLocalEnv = () => {};
supabase.configured = () => true;
supabase.loadTransactionalSnapshot = async id => String(id) === archivedCompanyId ? { snapshot: structuredClone(archived), revision: 4 } : null;
supabase.findTransactionalCompanyIdByUserEmail = async email => String(email).toLowerCase() === 'shared-owner@example.invalid' ? activeCompanyId : null;
supabase.listTransactionalSnapshots = async () => [{ companyId: archivedCompanyId, snapshot: structuredClone(archived), revision: 4 }];
supabase.listTransactionalTenantSummaries = async () => [];
supabase.listCompanySnapshots = async () => [];
let writeAttempts = 0;
supabase.saveTransactionalSnapshot = async () => { writeAttempts += 1; throw new Error('unarchive must not write after ownership conflict'); };

const { server } = require('./server');

(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/platform/companies/${archivedCompanyId}/unarchive`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}'
    });
    const payload = await response.json();
    assert.equal(response.status, 409, JSON.stringify(payload));
    assert.equal(payload.code, 'email_in_use');
    assert.match(payload.error, /active account now uses/i);
    assert.equal(writeAttempts, 0, 'the conflicting archive remains untouched');

    const migration = fs.readFileSync(path.join(__dirname, 'database', '011_archived_email_ownership.sql'), 'utf8');
    assert.match(migration, /DELETE FROM private\.tenant_active_user_emails[\s\S]*archivedDuplicate/i);
    assert.match(migration, /BEFORE INSERT OR UPDATE[\s\S]*keep_archived_tenant_email_unowned/i);
    assert.match(migration, /REVOKE ALL[\s\S]*service_role/i);
    console.log('Archived email ownership passed: archived tenants release login addresses and conflicting restores fail before mutation.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
