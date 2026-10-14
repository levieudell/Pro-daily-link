'use strict';
// Founder console account cleanup: platform owners can archive internal/test
// accounts. Archiving hides the account from every console list, blocks its
// users from signing in (local email lookup; the cloud lookup already filters
// archivedDuplicate), keeps data on disk, and writes an audit event. The
// primary account and non-owner callers are refused.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-archive-'));
const dbFile = path.join(tempDir, 'db.json');
fs.writeFileSync(dbFile, fs.readFileSync(path.join(__dirname, 'data', 'db.json')));
const platformFile = path.join(tempDir, 'platform.json');
fs.copyFileSync(path.join(__dirname, 'data', 'platform.json'), platformFile);
process.env.PDL_DB_FILE = dbFile;
process.env.PDL_PLATFORM_FILE = platformFile;
process.env.PDL_SUPABASE_ENABLED = '0';
process.env.PDL_EMAIL_DEV_MODE = '1';
process.env.PDL_REQUIRE_AUTH = '0';
process.env.PDL_PLATFORM_KEY = 'test-platform-key-32-characters-minimum';

// A synthetic test tenant, the kind of account Levi wants to clean up.
const tenantDir = path.join(tempDir, 'tenants');
fs.mkdirSync(tenantDir, { recursive: true });
const tenantId = '11111111-2222-3333-4444-555555555555';
fs.writeFileSync(path.join(tenantDir, `${tenantId}.json`), JSON.stringify({
  company: { id: tenantId, name: 'Test QA Company', trade: 'General contractor' },
  users: [{ id: 1, name: 'Tester', email: 'tester@example.com', role: 'owner', status: 'Active' }],
  projects: [], reports: []
}));

const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
db.company.id = 'acme-builders';
db.company.name = 'Acme Builders';
fs.writeFileSync(dbFile, JSON.stringify(db));

const platform = JSON.parse(fs.readFileSync(platformFile, 'utf8'));
const ownerToken = 'archive-owner-token';
platform.sessions = [{ userId: platform.users[0].id, tokenHash: crypto.createHash('sha256').update(ownerToken).digest('hex'), expiresAt: new Date(Date.now() + 86400000).toISOString() }];
fs.writeFileSync(platformFile, JSON.stringify(platform));

const { server } = require('./server');

// Static contracts first — no server boot needed if these fail.
{
  const platformJs = fs.readFileSync(path.join(__dirname, 'platform.js'), 'utf8');
  assert.match(platformJs, /data-archive-account=/, 'account menu exposes the archive action');
  assert.match(platformJs, /Archive test account/);
  assert.match(platformJs, /\/api\/platform\/companies\/\$\{encodeURIComponent\(e\.target\.dataset\.archiveAccount\)\}\/archive/);
  const serverSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.ok(serverSrc.includes("url.pathname.match(/^\\/api\\/platform\\/companies\\/([^/]+)\\/archive$/)"), 'archive route exists');
  assert.match(serverSrc, /!tenant\.company\?\.archivedDuplicate&&\(tenant\.users\|\|\[\]\)\.some/, 'login email lookup skips archived tenants');
}

server.listen(0, async () => {
  try {
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const call = async (route, { method = 'GET', token = ownerToken, body } = {}) => {
      const headers = { 'Content-Type': 'application/json', 'x-pdl-platform-key': process.env.PDL_PLATFORM_KEY };
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(base + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
      return { response, data: await response.json() };
    };

    // Before: the test tenant is visible and its user can find their company at login.
    let overview = await call('/api/platform/overview');
    assert.equal(overview.response.status, 200);
    assert.ok(overview.data.companies.some(c => c.name === 'Test QA Company'), 'test tenant listed before archiving');
    let lookup = await fetch(base + '/api/auth/company', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'tester@example.com' }) }).then(r => r.json());
    assert.equal(lookup.companyId, tenantId, 'test tenant user resolves at login before archiving');

    // Non-owner cannot archive.
    let result = await call(`/api/platform/companies/${tenantId}/archive`, { method: 'POST', body: {}, token: null });
    assert.equal(result.response.status, 403, JSON.stringify(result.data));

    // The primary account cannot be archived.
    result = await call('/api/platform/companies/acme-builders/archive', { method: 'POST', body: {} });
    assert.equal(result.response.status, 400, `primary refused: ${JSON.stringify(result.data)}`);

    // Unknown id → 404.
    result = await call('/api/platform/companies/nope/archive', { method: 'POST', body: {} });
    assert.equal(result.response.status, 404);

    // Owner archives the test tenant.
    result = await call(`/api/platform/companies/${tenantId}/archive`, { method: 'POST', body: {} });
    assert.equal(result.response.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.archived, true);

    // Tenant file on disk is marked, data preserved.
    const archived = JSON.parse(fs.readFileSync(path.join(tenantDir, `${tenantId}.json`), 'utf8'));
    assert.equal(archived.company.archivedDuplicate, true, 'archived flag persisted to the tenant file');
    assert.equal(archived.users[0].status, 'Active', 'user records are kept');

    // Audit event recorded.
    const platformNow = JSON.parse(fs.readFileSync(platformFile, 'utf8'));
    assert.ok((platformNow.auditEvents || []).some(e => e.action === 'company_archived' && e.reason === 'Test QA Company'), 'archive is audited');

    // After: gone from the console, and login lookup no longer finds the company.
    overview = await call('/api/platform/overview');
    assert.ok(!overview.data.companies.some(c => c.name === 'Test QA Company'), 'archived tenant hidden from the console');
    lookup = await fetch(base + '/api/auth/company', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'tester@example.com' }) }).then(r => r.json());
    assert.equal(lookup.companyId, null, 'archived tenant users cannot sign in');

    // Idempotent: archiving again reports alreadyArchived, no duplicate audit.
    result = await call(`/api/platform/companies/${tenantId}/archive`, { method: 'POST', body: {} });
    assert.equal(result.response.status, 200);
    assert.equal(result.data.alreadyArchived, true);
    const auditCount = (JSON.parse(fs.readFileSync(platformFile, 'utf8')).auditEvents || []).filter(e => e.action === 'company_archived').length;
    assert.equal(auditCount, 1, 'repeat archive does not write a second audit event');

    console.log('platform-account-archive tests passed');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
