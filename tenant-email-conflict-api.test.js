'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-email-conflict-api-'));
const dbFile = path.join(temp, 'db.json');
const platformFile = path.join(temp, 'platform.json');
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), dbFile);
fs.writeFileSync(platformFile, JSON.stringify({ users: [], sessions: [], auditEvents: [], growthOpportunities: [], onboardingOrders: [] }));

Object.assign(process.env, {
  NODE_ENV: 'test', PDL_REQUIRE_AUTH: '0', PDL_PLATFORM_DEV_BYPASS: '1', PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: platformFile,
  PDL_SUPABASE_ENABLED: '1', SUPABASE_URL: 'https://tenant-conflict-api.invalid', SUPABASE_SECRET_KEY: 'synthetic-service-role-secret',
  PDL_TRANSACTIONAL_DB: 'primary', PDL_PLATFORM_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1'
});

const supabase = require('./database/supabase');
supabase.configured = () => true;
supabase.saveCompanySnapshot = async () => true;
let listLimit = null;
supabase.listTenantEmailConflicts = async limit => {
  listLimit = limit;
  return [{
    normalizedEmail: 'shared@example.invalid',
    retainedCompanyId: '11111111-1111-4111-8111-111111111111',
    conflictedCompanyId: '22222222-2222-4222-8222-222222222222',
    authorizedCompanyId: '11111111-1111-4111-8111-111111111111',
    detectedAt: '2026-10-20T00:00:00.000Z'
  }];
};
let resolutionInput = null;
supabase.resolveTenantEmailConflict = async input => {
  resolutionInput = structuredClone(input);
  return {
    resolved: true, normalizedEmail: input.email, authorizedCompanyId: input.authorizedCompanyId,
    affectedConflicts: 1, resolvedAt: '2026-10-20T00:01:00.000Z'
  };
};

const { server } = require('./server');

(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    let response = await fetch(`${base}/api/platform/tenant-email-conflicts?limit=999`);
    let payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(listLimit, 500);
    assert.equal(payload.conflicts[0].normalizedEmail, 'shared@example.invalid');

    response = await fetch(`${base}/api/platform/tenant-email-conflicts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'shared@example.invalid', authorizedCompanyId: '22222222-2222-4222-8222-222222222222', note: 'Confirmed with both company owners.' })
    });
    payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.resolved, true);
    assert.match(resolutionInput.resolvedBy, /Development owner/);
    assert.equal(resolutionInput.resolutionNote, 'Confirmed with both company owners.');
    assert.ok(['complete', 'completion_event_pending'].includes(payload.auditStatus));

    response = await fetch(`${base}/api/platform/tenant-email-conflicts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'shared@example.invalid', authorizedCompanyId: '22222222-2222-4222-8222-222222222222', note: 'short' })
    });
    assert.equal(response.status, 400, await response.text());

    const platform = JSON.parse(fs.readFileSync(platformFile, 'utf8'));
    assert.ok(platform.auditEvents.some(event => event.action === 'tenant_email_conflict_resolved'), 'operator resolution is audited');
    console.log('Tenant email conflict API passed: platform-owner review is bounded, validated, resolved through the protected adapter, and audited.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
