'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-primary-public-links-'));
const dbFile = path.join(temp, 'db.json');
const platformFile = path.join(temp, 'platform.json');
const localCompanyId = '11111111-1111-4111-8111-111111111111';
const linkedCompanyId = '22222222-2222-4222-8222-222222222222';
const guestToken = 'a'.repeat(48);
const changeToken = 'primary-link-change-token-credential-123456789';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');

const local = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
local.company = { ...local.company, id: localCompanyId, name: 'Local decoy tenant' };
local.subcontractorLinks = [];
local.changes = [];
fs.writeFileSync(dbFile, JSON.stringify(local, null, 2));
fs.writeFileSync(platformFile, JSON.stringify({ users: [], sessions: [] }));

const linked = {
  company: { id: linkedCompanyId, name: 'Indexed Public Link Builders', timezone: 'UTC' },
  projects: [{ id: 91, name: 'Indexed Project', code: 'IDX', customer: 'Safe Customer', site: '91 Exact Lookup Way', estimateItems: [] }],
  subcontractors: [{ id: 8, name: 'Indexed Electrical', trade: 'Electrical', status: 'Active' }],
  subcontractorLinks: [{ id: 4, subcontractorId: 8, projectId: 91, mode: 'progress', status: 'Active', tokenHash: digest(guestToken), expiresAt: '2099-01-01T00:00:00.000Z' }],
  changes: [{ id: 5, projectId: 91, number: 'PC-005', title: 'Indexed change', status: 'Submitted', amount: 125, customerTokenHash: digest(changeToken), history: [] }],
  users: [], sessions: [], customers: [], team: [], assignments: [], reports: [], photos: [], workdays: [], timeCards: [], catalog: []
};

Object.assign(process.env, {
  NODE_ENV: 'production',
  PDL_REQUIRE_AUTH: '1',
  PDL_DB_FILE: dbFile,
  PDL_PLATFORM_FILE: platformFile,
  PDL_SUPABASE_ENABLED: '1',
  SUPABASE_URL: 'https://public-link-directory.invalid',
  SUPABASE_SECRET_KEY: 'synthetic-service-secret',
  PDL_TRANSACTIONAL_DB: 'primary',
  PDL_PLATFORM_TRANSACTIONAL_DB: 'off',
  PDL_EMAIL_DEV_MODE: '1'
});

const supabase = require('./database/supabase');
supabase.loadLocalEnv = () => {};
let lookupFailure = false;
const lookupCalls = [];
let forbiddenFullScans = 0;
supabase.findTransactionalCompanyIdByPublicToken = async (kind, tokenHash) => {
  lookupCalls.push({ kind, tokenHash });
  if (lookupFailure) throw new Error('synthetic token directory outage');
  if (kind === 'guest' && tokenHash === digest(guestToken)) return linkedCompanyId;
  if (kind === 'change_order' && tokenHash === digest(changeToken)) return linkedCompanyId;
  return null;
};
supabase.loadTransactionalSnapshot = async companyId => {
  if (String(companyId) === linkedCompanyId) return { snapshot: structuredClone(linked), revision: 9, contentHash: 'a'.repeat(64) };
  if (String(companyId) === localCompanyId) return { snapshot: structuredClone(local), revision: 2, contentHash: 'b'.repeat(64) };
  return null;
};
supabase.listTransactionalSnapshots = async () => { forbiddenFullScans += 1; throw new Error('public links must not enumerate tenants'); };
supabase.listCompanySnapshots = async () => { forbiddenFullScans += 1; throw new Error('public links must not enumerate legacy tenants'); };

const { server } = require('./server');

async function request(base, route) {
  const response = await fetch(base + route, { signal: AbortSignal.timeout(10000) });
  return { status: response.status, data: await response.json() };
}

(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const guest = await request(base, `/api/guest/${guestToken}`);
    assert.equal(guest.status, 200, JSON.stringify(guest.data));
    assert.equal(guest.data.company.name, linked.company.name);
    assert.equal(guest.data.project.id, 91);

    const change = await request(base, `/api/change-order/${changeToken}`);
    assert.equal(change.status, 200, JSON.stringify(change.data));
    assert.equal(change.data.number, 'PC-005');
    assert.equal(change.data.company.name, linked.company.name);

    const missing = await request(base, `/api/guest/${'b'.repeat(48)}`);
    assert.equal(missing.status, 404);

    const callsBeforeHint = lookupCalls.length;
    const hinted = await request(base, `/api/guest/${guestToken}?c=${linkedCompanyId}`);
    assert.equal(hinted.status, 200);
    assert.equal(lookupCalls.length, callsBeforeHint, 'an explicit correct scope avoids the directory lookup');

    const wrongHint = await request(base, `/api/guest/${guestToken}?c=${localCompanyId}`);
    assert.equal(wrongHint.status, 404);
    assert.equal(lookupCalls.length, callsBeforeHint, 'a tampered scope fails closed instead of falling back');

    lookupFailure = true;
    const unavailable = await request(base, `/api/change-order/${changeToken}`);
    assert.equal(unavailable.status, 404, 'directory failure does not scan or disclose a tenant');
    assert.equal(forbiddenFullScans, 0, 'no unauthenticated public-token path enumerates primary tenant snapshots');
    assert.deepEqual(lookupCalls.slice(0, 2), [
      { kind: 'guest', tokenHash: digest(guestToken) },
      { kind: 'change_order', tokenHash: digest(changeToken) }
    ]);
    assert.ok(lookupCalls.every(call => call.tokenHash !== guestToken && call.tokenHash !== changeToken), 'only token verifiers reach the directory');

    const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const resolver = source.slice(source.indexOf('async function publicTokenRequestDatabase'), source.indexOf('const DEFAULT_HELP_ITEMS'));
    assert.doesNotMatch(resolver, /operationalTenantSnapshots|listTransactionalSnapshots|listCompanySnapshots/);

    const migration = fs.readFileSync(path.join(__dirname, 'database', '014_public_link_token_directory.sql'), 'utf8');
    assert.match(migration, /CREATE TABLE IF NOT EXISTS private\.tenant_public_link_tokens/i);
    assert.match(migration, /PRIMARY KEY \(kind, token_hash\)/i);
    assert.match(migration, /LOCK TABLE public\.tenant_revisions, public\.tenant_records IN SHARE ROW EXCLUSIVE MODE/i);
    assert.match(migration, /CREATE TRIGGER sync_tenant_public_link_token/i);
    const revisionSyncStart = migration.indexOf('CREATE OR REPLACE FUNCTION private.sync_tenant_public_link_token_revision()');
    const revisionSyncEnd = migration.indexOf('DROP TRIGGER IF EXISTS sync_tenant_public_link_token_revision');
    assert.ok(revisionSyncStart >= 0 && revisionSyncEnd > revisionSyncStart, 'migration defines a bounded private revision-sync function');
    const revisionSync = migration.slice(revisionSyncStart, revisionSyncEnd);
    assert.match(revisionSync, /SECURITY DEFINER\s+SET search_path = ''/i);
    assert.match(revisionSync, /UPDATE private\.tenant_public_link_tokens[\s\S]*SET revision = NEW\.revision[\s\S]*WHERE company_id = NEW\.company_id[\s\S]*revision IS DISTINCT FROM NEW\.revision/i);
    assert.match(migration, /CREATE TRIGGER sync_tenant_public_link_token_revision\s+AFTER UPDATE OF revision ON public\.tenant_revisions[\s\S]*WHEN \(OLD\.revision IS DISTINCT FROM NEW\.revision\)/i);
    assert.match(migration, /REVOKE ALL ON FUNCTION private\.sync_tenant_public_link_token_revision\(\)\s+FROM PUBLIC, anon, authenticated, service_role/i);
    assert.match(migration, /CREATE OR REPLACE FUNCTION public\.find_tenant_company_by_public_token/i);
    assert.match(migration, /REVOKE ALL ON TABLE private\.tenant_public_link_tokens\s+FROM PUBLIC, anon, authenticated, service_role/i);
    assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.find_tenant_company_by_public_token\(text,text\)\s+TO service_role/i);

    console.log('Primary public-link resolution passed: exact token directory lookup, strict hints, raw-token privacy, fail-closed outages, and zero tenant scans.');
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
