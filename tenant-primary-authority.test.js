'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-primary-authority-'));
const dbFile = path.join(temp, 'db.json');
const platformFile = path.join(temp, 'platform.json');
const companyId = '11111111-1111-4111-8111-111111111111';
const platformToken = 'tenant-primary-authority-platform-token';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const now = new Date().toISOString();
const local = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
local.company = { ...local.company, id: companyId, name: 'Authoritative Concrete', features: { timeCards: false, templates: false }, persistence: { revision: 4 } };
fs.writeFileSync(dbFile, JSON.stringify(local, null, 2));
fs.writeFileSync(platformFile, JSON.stringify({
  users: [{ id: 'platform-owner', name: 'Platform Owner', email: 'platform@example.invalid', role: 'platform_owner', status: 'Active', mustSetPassword: false }],
  sessions: [{ id: crypto.randomUUID(), userId: 'platform-owner', tokenHash: hash(platformToken), createdAt: now, expiresAt: new Date(Date.now() + 3600000).toISOString() }],
  supportGrants: [], auditEvents: [], growthOpportunities: [], supportTickets: [], followUps: [], onboardingOrders: []
}, null, 2));

Object.assign(process.env, {
  NODE_ENV: 'production', PDL_REQUIRE_AUTH: '1', PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: platformFile,
  PDL_SUPABASE_ENABLED: '1', SUPABASE_URL: 'https://tenant-authority.invalid', SUPABASE_SECRET_KEY: 'synthetic-service-secret',
  PDL_TRANSACTIONAL_DB: 'primary', PDL_PLATFORM_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1'
});

const supabase = require('./database/supabase');
supabase.loadLocalEnv = () => {};
let authoritative = structuredClone(local), revision = 7, conflict = true, legacyWrites = 0;
supabase.loadTransactionalSnapshot = async id => String(id) === companyId ? { snapshot: structuredClone(authoritative), revision } : null;
supabase.saveTransactionalSnapshot = async (snapshot, expected) => {
  if (conflict) throw Object.assign(new Error(`PDL_REVISION_CONFLICT expected=${expected} actual=${revision + 1}`), { code: 'PDL_REVISION_CONFLICT' });
  assert.equal(expected, revision);
  authoritative = structuredClone(snapshot); revision += 1;
  return { revision, contentHash: 'a'.repeat(64), records: 1 };
};
supabase.listCompanySnapshots = async () => [{ ...structuredClone(authoritative), company: { ...authoritative.company, features: { timeCards: true, templates: true }, persistence: { revision: 999 } } }];
supabase.listTransactionalSnapshots = async () => [{ companyId, snapshot: structuredClone(authoritative), revision, contentHash: 'a'.repeat(64) }];
supabase.saveCompanySnapshot = async snapshot => { if (String(snapshot?.company?.id) === companyId) legacyWrites += 1; return true; };
supabase.createVerifiedBackup = async snapshot => ({ bucket: 'tenant-backups', objectKey: `${snapshot.company.id}/synthetic.json`, hash: 'b'.repeat(64), bytes: 1, verifiedAt: new Date().toISOString() });
supabase.upload = async () => ({});

const { server, operationalTenantSnapshots } = require('./server');

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const patchFeature = async value => {
    const response = await fetch(`${base}/api/platform/companies/${companyId}/features`, {
      method: 'PATCH', headers: { Authorization: `Bearer ${platformToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ timeCards: value })
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    const rejected = await patchFeature(true);
    assert.equal(rejected.status, 409, JSON.stringify(rejected.data));
    assert.equal(JSON.parse(fs.readFileSync(dbFile, 'utf8')).company.features.timeCards, false, 'CAS conflict never mutates the local mirror');
    assert.equal(legacyWrites, 0, 'CAS conflict never mutates the legacy cloud mirror');
    assert.equal((await operationalTenantSnapshots()).find(row => row.company.id === companyId).company.features.timeCards, false, 'back office uses the authoritative transactional tenant even when legacy claims a higher revision');

    conflict = false;
    const committed = await patchFeature(true);
    assert.equal(committed.status, 200, JSON.stringify(committed.data));
    assert.equal(authoritative.company.features.timeCards, true);
    assert.equal(JSON.parse(fs.readFileSync(dbFile, 'utf8')).company.features.timeCards, true, 'local mirror follows the authoritative commit');
    assert.equal(legacyWrites, 2, 'legacy cloud mirror follows both the customer mutation and durable audit-outbox acknowledgement');
    console.log('Tenant primary authority passed: CAS commits first, conflicts leave mirrors untouched, and the back office reads transactional truth.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
