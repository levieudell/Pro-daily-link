'use strict';

/**
 * Production-like integration coverage for the platform/back-office boundary.
 *
 * The test deliberately uses the real HTTP server and real persisted platform
 * sessions.  Its tenant and platform stores live in a private temporary
 * directory so no developer, staging, or production data can be touched.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-platform-security-'));
const dbFile = path.join(tempDir, 'db.json');
const platformFile = path.join(tempDir, 'platform.json');
const now = new Date();
const expiresAt = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString();
const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');

const tenant = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
const tenantToken = 'valid-tenant-session-not-platform-access';
tenant.sessions = [{
  id: crypto.randomUUID(),
  userId: tenant.users[0].id,
  companyId: tenant.company.id,
  tokenHash: tokenHash(tenantToken),
  createdAt: now.toISOString(),
  expiresAt
}];
fs.writeFileSync(dbFile, JSON.stringify(tenant, null, 2));

const identities = [
  ['owner-a', 'Platform Owner A', 'platform_owner'],
  ['owner-b', 'Platform Owner B', 'platform_owner'],
  ['support-a', 'Support A', 'support'],
  ['support-b', 'Support B', 'support'],
  ['sales-a', 'Sales A', 'sales'],
  ['billing-a', 'Billing A', 'billing'],
  ['content-a', 'Content A', 'content'],
  ['engineering-a', 'Engineering A', 'engineering']
];
const tokens = Object.fromEntries(identities.map(([id]) => [id, `platform-session-${id}`]));
const platform = {
  users: identities.map(([id, name, role]) => ({
    id,
    name,
    email: `${id}@example.invalid`,
    role,
    status: 'Active',
    mustSetPassword: false,
    createdAt: now.toISOString(),
    // Canary credentials prove that allowlisted response DTOs never expose
    // persisted authentication material.
    passwordHash: `SECRET_PASSWORD_HASH_${id}`,
    passwordSalt: `SECRET_PASSWORD_SALT_${id}`,
    setupHash: `SECRET_SETUP_HASH_${id}`,
    setupSalt: `SECRET_SETUP_SALT_${id}`,
    resetTokenHash: `SECRET_RESET_TOKEN_${id}`
  })),
  sessions: identities.map(([id]) => ({
    id: crypto.randomUUID(),
    userId: id,
    tokenHash: tokenHash(tokens[id]),
    createdAt: now.toISOString(),
    expiresAt
  })),
  notes: [],
  helpItems: [],
  blogPosts: [],
  supportTickets: [],
  followUps: [],
  onboardingOrders: [],
  supportGrants: [],
  auditEvents: [],
  growthOpportunities: []
};
fs.writeFileSync(platformFile, JSON.stringify(platform, null, 2));

Object.assign(process.env, {
  NODE_ENV: 'production',
  PDL_REQUIRE_AUTH: '1',
  PDL_ALLOW_PLATFORM_KEY_AUTH: '1',
  PDL_AUTH_FAIL_LIMIT: '3',
  PDL_TRUST_PROXY_HOPS: '1',
  PDL_PLATFORM_KEY: 'production-key-that-must-never-authenticate',
  PDL_PLATFORM_TRANSACTIONAL_DB: 'off',
  PDL_DB_FILE: dbFile,
  PDL_PLATFORM_FILE: platformFile,
  PDL_SUPABASE_ENABLED: '0',
  PDL_EMAIL_DEV_MODE: '1',
  PDL_PUBLIC_URL: 'https://app.example.invalid'
});

const { server } = require('./server');

function forbiddenCredentialMaterial(value, label) {
  const serialized = JSON.stringify(value);
  for (const [id] of identities) {
    for (const secret of [
      `SECRET_PASSWORD_HASH_${id}`,
      `SECRET_PASSWORD_SALT_${id}`,
      `SECRET_SETUP_HASH_${id}`,
      `SECRET_SETUP_SALT_${id}`,
      `SECRET_RESET_TOKEN_${id}`,
      tokenHash(tokens[id]),
      tokens[id]
    ]) assert.equal(serialized.includes(secret), false, `${label} leaked ${secret}`);
  }
  const forbiddenKeys = new Set([
    'passwordHash', 'passwordSalt', 'setupHash', 'setupSalt',
    'setupCode', 'resetTokenHash', 'tokenHash'
  ]);
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      assert.equal(forbiddenKeys.has(key), false, `${label} leaked the ${key} field`);
      visit(child);
    }
  };
  visit(value);
}

server.listen(0, async () => {
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (route, { method = 'GET', actor, token, cookie, key, body, headers: suppliedHeaders = {} } = {}) => {
      const headers = { Accept: 'application/json', ...suppliedHeaders };
      const credential = token || (actor && tokens[actor]);
      if (credential) headers.Authorization = `Bearer ${credential}`;
      if (cookie) headers.Cookie = cookie;
      if (key) headers['x-pdl-platform-key'] = key;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(base + route, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      return { response, data };
    };
    const expectStatus = async (expected, route, options, label) => {
      const result = await call(route, options);
      assert.equal(result.response.status, expected, `${label}: ${JSON.stringify(result.data)}`);
      return result.data;
    };

    const landing = await call('/');
    assert.equal(landing.response.status, 200, 'public landing page remains reachable');
    const servedPolicy = landing.response.headers.get('content-security-policy');
    assert.equal(
      servedPolicy,
      require('./content-security-policy').contentSecurityPolicy(__dirname),
      'the tested CSP is the policy actually served by HTTP'
    );
    for (const asset of ['/workspace-gate.js', '/register-service-worker.js', '/staging-banner.js']) {
      assert.equal((await call(asset)).response.status, 200, `${asset} is available through the public-file allowlist`);
    }

    // Authentication is an independent platform boundary. A tenant cookie is
    // neither required for a valid platform session nor accepted in its place.
    await expectStatus(401, '/api/platform/overview', {}, 'anonymous back-office request');
    await expectStatus(401, '/api/platform/overview', {
      cookie: `pdl_session=${tenantToken}; pdl_company=${tenant.company.id}`
    }, 'tenant session cannot become a platform session');
    await expectStatus(200, '/api/platform/overview', {
      actor: 'owner-a',
      cookie: 'pdl_session=bogus-tenant; pdl_company=wrong-tenant'
    }, 'platform bearer is independent of tenant cookies');
    await expectStatus(200, '/api/platform/auth/me', {
      cookie: `pdl_platform=${tokens['owner-a']}`
    }, 'platform cookie works without a tenant cookie');

    // The old global header is never an authentication bypass in production,
    // even if a key exists and the legacy opt-in variable is accidentally set.
    await expectStatus(401, '/api/platform/overview', {
      key: process.env.PDL_PLATFORM_KEY
    }, 'global platform key is denied in production');

    // Failed platform authentication participates in the same abuse throttle as
    // tenant authentication. Spoofing the left side of X-Forwarded-For cannot
    // evade a Render-style one-hop trusted-proxy configuration.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expectStatus(401, '/api/platform/auth/login', {
        method: 'POST',
        headers: { 'x-forwarded-for': `192.0.2.${attempt + 1}, 198.51.100.77` },
        body: { email: 'missing@example.invalid', password: 'wrong-password' }
      }, `failed platform login ${attempt + 1}`);
    }
    await expectStatus(429, '/api/platform/auth/login', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.99, 198.51.100.77' },
      body: { email: 'missing@example.invalid', password: 'wrong-password' }
    }, 'failed platform logins are throttled by the trusted client address');

    // Every unknown platform route is denied before a handler can accidentally
    // make it reachable.
    const unknown = await expectStatus(403, '/api/platform/not-a-real-route', {
      actor: 'owner-a'
    }, 'unknown platform route');
    assert.equal(unknown.code, 'platform_policy_missing');

    // Exercise the real HTTP capability boundary for each specialist role:
    // one legitimate action succeeds and one privileged action is refused.
    await expectStatus(201, '/api/platform/tickets', {
      method: 'POST', actor: 'support-a',
      body: { companyId: tenant.company.id, subject: 'Support can create tickets' }
    }, 'support write capability');
    await expectStatus(403, '/api/platform/audit', { actor: 'support-a' }, 'support cannot read audit');

    await expectStatus(200, '/api/platform/growth', { actor: 'sales-a' }, 'sales growth read capability');
    await expectStatus(403, '/api/platform/tickets', {
      method: 'POST', actor: 'sales-a',
      body: { companyId: tenant.company.id, subject: 'Sales must not create tickets' }
    }, 'sales cannot write support tickets');

    await expectStatus(200, '/api/platform/audit', { actor: 'billing-a' }, 'billing audit read capability');
    await expectStatus(403, '/api/platform/growth', { actor: 'billing-a' }, 'billing cannot read growth pipeline');

    await expectStatus(201, '/api/platform/help', {
      method: 'POST', actor: 'content-a',
      body: { title: 'Security test article', type: 'article', audience: 'office' }
    }, 'content publishing capability');
    await expectStatus(403, '/api/platform/ai-usage', { actor: 'content-a' }, 'content cannot read AI usage');

    await expectStatus(200, '/api/platform/ai-usage', { actor: 'engineering-a' }, 'engineering AI usage capability');
    await expectStatus(403, '/api/platform/tickets', {
      method: 'POST', actor: 'engineering-a',
      body: { companyId: tenant.company.id, subject: 'Engineering must not write tickets' }
    }, 'engineering cannot write support tickets');

    // Overview and current-user DTOs are strict allowlists. Persisted hashes,
    // salts, session tokens, reset tokens, and setup credentials stay server-side.
    const ownerOverview = await expectStatus(200, '/api/platform/overview', {
      actor: 'owner-a'
    }, 'owner overview');
    assert.equal(ownerOverview.staff.length, identities.length);
    forbiddenCredentialMaterial(ownerOverview.staff, 'overview staff DTO');
    const ownerMe = await expectStatus(200, '/api/platform/auth/me', {
      actor: 'owner-a'
    }, 'owner session DTO');
    forbiddenCredentialMaterial(ownerMe, 'current platform user DTO');
    const scopedOverview = await expectStatus(200, '/api/platform/overview', {
      actor: 'support-a'
    }, 'support overview');
    assert.deepEqual(scopedOverview.staff, [], 'non-managers do not receive the staff directory');
    assert.equal(scopedOverview.metrics.configuredPlanTotal, null, 'support does not receive revenue totals');
    for (const company of scopedOverview.companies) {
      for (const field of ['plan', 'subscriptionStatus', 'accountType', 'trialEndsAt', 'nextBillingAt', 'planPrice', 'billingExempt', 'cohort', 'discountPercent', 'commercialNote']) {
        assert.equal(Object.hasOwn(company, field), false, `support company DTO excludes ${field}`);
      }
      assert.equal(company.health.alerts.some(alert => /^Trial\b|^Subscription\b/i.test(alert)), false, 'support health alerts exclude commercial state');
    }
    const salesOverview = await expectStatus(200, '/api/platform/overview', { actor: 'sales-a' }, 'sales overview');
    assert.ok(salesOverview.companies.every(company => Object.hasOwn(company, 'plan')), 'subscription readers receive subscription fields');
    assert.ok(salesOverview.companies.every(company => !Object.hasOwn(company, 'planPrice')), 'subscription-only readers do not receive revenue fields');
    const billingOverview = await expectStatus(200, '/api/platform/overview', { actor: 'billing-a' }, 'billing overview');
    assert.ok(billingOverview.companies.every(company => Object.hasOwn(company, 'planPrice')), 'revenue readers receive commercial fields');

    // A browser-supplied actor id is ignored. The authenticated staff member is
    // recorded, and a non-owner cannot inspect or revoke another actor's grant.
    const supportGrant = await expectStatus(201, '/api/platform/support-access', {
      method: 'POST', actor: 'support-a',
      body: {
        companyId: tenant.company.id,
        reason: 'Investigate a reported workspace issue',
        minutes: 30,
        actorUserId: 'owner-a'
      }
    }, 'support grant creation');
    const supportGrantToken = new URL(supportGrant.url, 'https://app.example.invalid').searchParams.get('token');
    assert.equal(supportGrant.actorUserId, 'support-a', 'request body cannot spoof the support actor');
    assert.equal(supportGrant.actorName, 'Support A');
    const supportAList = await expectStatus(200, '/api/platform/support-access', {
      actor: 'support-a'
    }, 'support actor reads own grants');
    assert.deepEqual(supportAList.map(row => row.id), [supportGrant.id]);
    forbiddenCredentialMaterial(supportAList, 'support grant DTO');
    const supportBList = await expectStatus(200, '/api/platform/support-access', {
      actor: 'support-b'
    }, 'other support actor grant list');
    assert.deepEqual(supportBList, [], 'non-owner cannot inspect another actor grant');
    await expectStatus(403, `/api/platform/support-access/${supportGrant.id}`, {
      method: 'DELETE', actor: 'support-b'
    }, 'non-owner cannot revoke another actor grant');
    await expectStatus(200, `/api/platform/support-access/${supportGrant.id}`, {
      method: 'DELETE', actor: 'owner-a'
    }, 'owner can revoke an audited support grant');
    await expectStatus(404, `/api/support-session/${supportGrantToken}`, {}, 'revoked support grant token is unusable');

    const supportBGrant = await expectStatus(201, '/api/platform/support-access', {
      method: 'POST', actor: 'support-b',
      body: { companyId: tenant.company.id, reason: 'Verify access is revoked with the staff role', minutes: 30 }
    }, 'second support grant creation');
    const supportBToken = new URL(supportBGrant.url, 'https://app.example.invalid').searchParams.get('token');
    const activeSupportSession = await expectStatus(200, `/api/support-session/${supportBToken}`, {}, 'active support session');
    assert.equal(Object.hasOwn(activeSupportSession.summary, 'plan'), false, 'support session respects the actor subscription capability');

    // Staff administration preserves an active owner. Owners may manage a
    // second owner, but cannot demote or deactivate their own signed-in account.
    await expectStatus(409, '/api/platform/users/owner-a', {
      method: 'PATCH', actor: 'owner-a', body: { status: 'Inactive' }
    }, 'self-deactivation guard');
    await expectStatus(409, '/api/platform/users/owner-a', {
      method: 'PATCH', actor: 'owner-a', body: { role: 'content' }
    }, 'self-demotion guard');
    await expectStatus(200, '/api/platform/users/owner-b', {
      method: 'PATCH', actor: 'owner-a', body: { status: 'Inactive' }
    }, 'owner may deactivate a redundant owner');
    await expectStatus(200, '/api/platform/users/support-b', {
      method: 'PATCH', actor: 'owner-a', body: { status: 'Inactive' }
    }, 'owner may deactivate support staff');
    await expectStatus(404, `/api/support-session/${supportBToken}`, {}, 'deactivated staff cannot reuse an outstanding support session');
    await expectStatus(409, '/api/platform/users/owner-a', {
      method: 'PATCH', actor: 'owner-a', body: { role: 'sales' }
    }, 'remaining owner cannot remove the last active owner');
    await expectStatus(401, '/api/platform/overview', {
      actor: 'owner-b'
    }, 'deactivated staff sessions cannot authenticate');
    await expectStatus(403, '/api/platform/users/support-b', {
      method: 'PATCH', actor: 'support-a', body: { status: 'Inactive' }
    }, 'non-owner cannot administer platform staff');

    const persisted = JSON.parse(fs.readFileSync(platformFile, 'utf8'));
    assert.equal(
      persisted.users.filter(user => user.role === 'platform_owner' && user.status === 'Active').length,
      1,
      'the staff workflow retains one active Platform Owner'
    );
    assert.equal(
      persisted.supportGrants.find(grant => grant.id === supportBGrant.id)?.status,
      'Revoked',
      'deactivating support staff revokes outstanding support grants'
    );
    assert.ok(
      persisted.auditEvents.some(event => event.action === 'support_access_granted' && event.actorUserId === 'support-a'),
      'the authenticated support actor is preserved in the audit trail'
    );

    console.log('Platform API security integration passed: independent production auth, deny-by-default routing, five-role capability boundaries, safe staff DTOs, unspoofable support grants, and owner guardrails.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
