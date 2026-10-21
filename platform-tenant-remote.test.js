'use strict';

/**
 * Back-office tenant administration must not depend on Render's ephemeral
 * filesystem already containing a tenant mirror. This test supplies a tenant
 * only through the server-side Supabase adapter and exercises the real HTTP
 * routes against it. All provider calls are deterministic in-memory fakes.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-platform-remote-tenant-'));
const dbFile = path.join(tempDir, 'db.json');
const platformFile = path.join(tempDir, 'platform.json');
const tenantDir = path.join(tempDir, 'tenants');
const primary = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
const companyId = crypto.randomUUID();
const remoteTenant = structuredClone(primary);
remoteTenant.company = {
  ...remoteTenant.company,
  id: companyId,
  name: 'Supabase Only Builders',
  demo: false,
  persistence: { revision: 12 }
};
remoteTenant.users = [{
  ...remoteTenant.users[0],
  id: 1,
  companyId,
  name: 'Remote Company Owner',
  email: 'owner@supabase-only.example',
  role: 'owner',
  status: 'Active'
}];
remoteTenant.sessions = [];
fs.writeFileSync(dbFile, JSON.stringify(primary, null, 2));

const platformToken = 'remote-tenant-platform-owner-token';
const tokenHash = crypto.createHash('sha256').update(platformToken).digest('hex');
const now = new Date().toISOString();
fs.writeFileSync(platformFile, JSON.stringify({
  users: [{
    id: 'platform-owner', name: 'Platform Owner', email: 'platform@example.invalid',
    role: 'platform_owner', status: 'Active', mustSetPassword: false
  }],
  sessions: [{
    id: crypto.randomUUID(), userId: 'platform-owner', tokenHash,
    createdAt: now, expiresAt: new Date(Date.now() + 3_600_000).toISOString()
  }],
  supportGrants: [], auditEvents: [], growthOpportunities: [], supportTickets: [],
  followUps: [], onboardingOrders: []
}, null, 2));

Object.assign(process.env, {
  NODE_ENV: 'production',
  PDL_REQUIRE_AUTH: '1',
  PDL_PLATFORM_TRANSACTIONAL_DB: 'off',
  PDL_TRANSACTIONAL_DB: 'off',
  PDL_DB_FILE: dbFile,
  PDL_PLATFORM_FILE: platformFile,
  PDL_SUPABASE_ENABLED: '1',
  SUPABASE_URL: 'https://supabase-only.invalid',
  SUPABASE_SECRET_KEY: 'server-test-key-never-sent',
  PDL_EMAIL_DEV_MODE: '1',
  PDL_PUBLIC_URL: 'https://app.example.invalid'
});

const remoteSnapshots = new Map([[companyId, structuredClone(remoteTenant)]]);
const targetWrites = [];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const supabasePath = require.resolve('./database/supabase');
require.cache[supabasePath] = {
  id: supabasePath,
  filename: supabasePath,
  loaded: true,
  exports: {
    loadLocalEnv() {},
    configured: () => true,
    loadCompanySnapshot: async id => {
      const value = remoteSnapshots.get(String(id));
      return value ? structuredClone(value) : null;
    },
    saveCompanySnapshot: async snapshot => {
      // A short delay makes an accidental missing queue visible to concurrent
      // feature updates instead of letting both writes finish synchronously.
      await new Promise(resolve => setTimeout(resolve, 4));
      remoteSnapshots.set(String(snapshot.company.id), structuredClone(snapshot));
      if (String(snapshot.company.id) === companyId) targetWrites.push(structuredClone(snapshot));
      return true;
    },
    loadSnapshot: async id => {
      const value = remoteSnapshots.get(String(id));
      return value ? structuredClone(value) : null;
    },
    saveSnapshot: async (id, name, snapshot) => {
      remoteSnapshots.set(String(id), structuredClone(snapshot));
      return true;
    },
    listCompanySnapshots: async () => [...remoteSnapshots.values()].map(structuredClone),
    findCompanyByUserEmail: async () => null,
    createVerifiedBackup: async snapshot => {
      const bytes = Buffer.from(JSON.stringify(snapshot));
      return {
        bucket: 'tenant-backups',
        objectKey: `${snapshot.company.id}/deterministic-${digest(bytes).slice(0, 12)}.json`,
        hash: digest(bytes),
        bytes: bytes.length,
        verifiedAt: new Date().toISOString()
      };
    },
    upload: async (bucket, objectKey) => ({ bucket, objectKey }),
    download: async () => new Response('', { status: 404 }),
    health: async () => ({ configured: true, reachable: true }),
    request: async () => { throw new Error('Unexpected raw Supabase request in remote tenant test'); },
    loadTransactionalSnapshot: async () => null,
    saveTransactionalSnapshot: async () => { throw new Error('Transactional tenant mode is disabled in this test'); }
  }
};

const { server } = require('./server');

server.listen(0, async () => {
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const localTenantFile = path.join(tenantDir, `${companyId}.json`);
    assert.equal(fs.existsSync(localTenantFile), false, 'the tenant begins with no Render filesystem mirror');

    const call = async (route, { method = 'GET', body, bearer = platformToken } = {}) => {
      const headers = { Accept: 'application/json' };
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(base + route, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const data = await response.json();
      return { status: response.status, data };
    };
    const expect = async (status, route, options) => {
      const result = await call(route, options);
      assert.equal(result.status, status, `${route}: ${JSON.stringify(result.data)}`);
      return result.data;
    };
    const companyRoute = `/api/platform/companies/${encodeURIComponent(companyId)}`;

    await Promise.all([
      expect(200, `${companyRoute}/features`, { method: 'PATCH', body: { timeCards: true } }),
      expect(200, `${companyRoute}/features`, { method: 'PATCH', body: { templates: true } })
    ]);
    assert.equal(fs.existsSync(localTenantFile), true, 'the first cloud-backed mutation creates a disposable local mirror');
    let remote = remoteSnapshots.get(companyId);
    assert.deepEqual(remote.company.features, { timeCards: true, templates: true }, 'concurrent updates are serialized into Supabase');
    assert.ok(remote.company.persistence.revision >= 14, 'each acknowledged update advances the remote revision');

    await expect(200, `${companyRoute}/subscription`, {
      method: 'PATCH',
      body: { plan: 'growth', planPrice: 199, status: 'Active', accountType: 'standard', cohort: 'Remote tenant test' }
    });
    const reset = await expect(200, `${companyRoute}/owner-reset`, { method: 'POST', body: {} });
    assert.equal(reset.email, remoteTenant.users[0].email);
    assert.equal(reset.sent, false);
    assert.ok(reset.previewToken, 'development email mode returns a reset preview without an external send');
    assert.ok(remoteSnapshots.get(companyId).users[0].resetTokenHash, 'the reset credential is durable in the remote tenant before it is used or revoked');

    const grant = await expect(201, '/api/platform/support-access', {
      method: 'POST', body: { companyId, reason: 'Remote-only tenant administration test', minutes: 15 }
    });
    const supportToken = new URL(grant.url, 'https://app.example.invalid').searchParams.get('token');
    const support = await expect(200, `/api/support-session/${supportToken}`, { bearer: null });
    assert.equal(support.banner.companyName, remoteTenant.company.name);
    assert.equal(support.summary.plan, 'growth');

    await expect(200, `${companyRoute}/archive`, { method: 'POST', body: {} });
    assert.equal(remoteSnapshots.get(companyId).company.archivedDuplicate, true);
    await expect(200, `${companyRoute}/unarchive`, { method: 'POST', body: {} });

    remote = remoteSnapshots.get(companyId);
    const local = JSON.parse(fs.readFileSync(localTenantFile, 'utf8'));
    assert.equal(remote.company.archivedDuplicate, false);
    assert.equal(remote.company.plan, 'growth');
    assert.equal(remote.users[0].resetTokenHash, undefined, 'archiving revokes outstanding password-reset credentials before the account is restored');
    assert.equal(local.company.persistence.revision, remote.company.persistence.revision, 'local mirror and Supabase finish at the same revision');
    assert.deepEqual(local.company.features, remote.company.features, 'local mirror and Supabase finish with the same feature controls');
    assert.ok(targetWrites.length >= 6, 'every target-tenant administration write reached Supabase');

    console.log('Remote-only platform tenant administration passed: cloud load, serialized writes, reset, support, archive, and mirror reconciliation.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
