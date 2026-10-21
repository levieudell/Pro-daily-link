'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-signup-email-uniqueness-'));
const dbFile = path.join(temp, 'db.json');
const platformFile = path.join(temp, 'platform.json');
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), dbFile);
fs.writeFileSync(platformFile, JSON.stringify({ users: [], sessions: [], growthOpportunities: [], onboardingOrders: [], auditEvents: [] }));

Object.assign(process.env, {
  NODE_ENV: 'production',
  PDL_DB_FILE: dbFile,
  PDL_PLATFORM_FILE: platformFile,
  PDL_REQUIRE_AUTH: '1',
  PDL_SUPABASE_ENABLED: '1',
  SUPABASE_URL: 'https://signup-email-uniqueness.invalid',
  SUPABASE_SECRET_KEY: 'synthetic-service-role-secret',
  PDL_TRANSACTIONAL_DB: 'primary',
  PDL_PLATFORM_TRANSACTIONAL_DB: 'off',
  PDL_EMAIL_DEV_MODE: '1'
});

for (const key of ['RESEND_API_KEY', 'SENTRY_DSN', 'STRIPE_SECRET_KEY', 'OPENAI_API_KEY']) delete process.env[key];

const supabase = require('./database/supabase');
const tenants = new Map();
const emailOwners = new Map();
supabase.configured = () => true;
// Simulate two app instances both observing the advisory lookup before either
// commits. The database uniqueness constraint remains the deciding guard.
supabase.findTransactionalCompanyIdByUserEmail = async () => null;
supabase.saveTransactionalSnapshot = async (snapshot, expectedRevision = 0) => {
  const companyId = String(snapshot.company.id);
  const current = tenants.get(companyId);
  const actualRevision = Number(current?.revision || 0);
  if (Number(expectedRevision) !== actualRevision) throw Object.assign(new Error('PDL_REVISION_CONFLICT'), { code: 'PDL_REVISION_CONFLICT' });
  const activeEmails = (snapshot.users || []).filter(user => user.status === 'Active').map(user => String(user.email || '').trim().toLowerCase()).filter(Boolean);
  for (const email of activeEmails) {
    const owner = emailOwners.get(email);
    if (owner && owner !== companyId) {
      throw new Error('Supabase request failed (409): duplicate key value violates unique constraint "tenant_active_user_email_owner_unique"');
    }
  }
  activeEmails.forEach(email => emailOwners.set(email, companyId));
  const saved = { snapshot: structuredClone(snapshot), revision: actualRevision + 1 };
  tenants.set(companyId, saved);
  return { companyId, revision: saved.revision, records: 0, contentHash: crypto.createHash('sha256').update(companyId).digest('hex') };
};
supabase.loadTransactionalSnapshot = async companyId => structuredClone(tenants.get(String(companyId)) || null);
supabase.listTransactionalSnapshots = async () => [...tenants.values()].map(value => structuredClone(value));
supabase.listCompanySnapshots = async () => [];
supabase.saveCompanySnapshot = async () => true;

const { server } = require('./server');

async function signup(base, companyName) {
  const response = await fetch(`${base}/api/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      companyName,
      ownerName: 'Shared Owner',
      email: ' Same.Owner@Example.Invalid ',
      password: 'SyntheticPassword!42',
      plan: 'starter',
      billingCycle: 'monthly',
      legalAccepted: true
    })
  });
  return { status: response.status, data: await response.json() };
}

(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const first = await signup(base, 'First Atomic Builder');
    const second = await signup(base, 'Racing Atomic Builder');

    assert.equal(first.status, 201, JSON.stringify(first.data));
    assert.equal(second.status, 409, JSON.stringify(second.data));
    assert.equal(second.data.code, 'account_exists');
    assert.match(second.data.error, /account already exists/i);
    assert.equal(tenants.size, 1, 'only one authoritative tenant commits');
    assert.equal(emailOwners.get('same.owner@example.invalid'), first.data.company.id);
    const tenantFiles = fs.readdirSync(path.join(temp, 'tenants')).filter(file => file.endsWith('.json'));
    assert.deepEqual(tenantFiles, [`${first.data.company.id}.json`], 'the losing signup removes only its uncommitted local file');

    const migration = fs.readFileSync(path.join(__dirname, 'database', '010_signup_email_uniqueness.sql'), 'utf8');
    assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS tenant_active_user_email_owner_unique[\s\S]*normalized_email/i);
    assert.match(migration, /tenant_email_conflicts/i, 'pre-existing conflicts remain operator-visible');
    assert.match(migration, /archivedDuplicate/i, 'archived tenants are excluded before global ownership is enforced');
    assert.match(migration, /REVOKE ALL[^;]*tenant_email_conflicts[^;]*service_role/is, 'conflict evidence is not directly exposed');
    console.log('Signup email uniqueness passed: the database guard wins stale cross-instance checks and the API returns account_exists safely.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
