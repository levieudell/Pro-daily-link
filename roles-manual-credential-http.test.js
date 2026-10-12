'use strict';
// Actual normal server and closed memory tenant/shared-platform CAS. All codes,
// accounts, bootstrap authorization and sessions belong to this fixture only.
const assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { canonicalHash } = require('./database/transactional-repository');
const nativeFetch = globalThis.fetch, nativeError = console.error;
let origin, requests = 0, platformReads = 0, tenantReads = 0, platformWrites = 0, tenantWrites = 0, expectedDenialLogs = 0, lostAck = null, beforeRead = null, beforeWrite = null;
console.error = (...values) => { const error = values[1]; if (typeof values[0] === 'string' && /^\[[a-f0-9-]{36}\]$/.test(values[0]) && error instanceof Error && [400, 403, 409].includes(error.statusCode)) { expectedDenialLogs++; return; } nativeError(...values); };
globalThis.fetch = (input, options) => { const target = String(input?.url || input); assert.ok(origin && target.startsWith(origin + '/'), 'Only this fixture-owned loopback server may use a network socket'); return nativeFetch(input, options); };
const supabase = require('./database/supabase'); supabase.loadLocalEnv = () => {};
supabase.upload = supabase.download = supabase.remove = async () => { throw Error('Manual credential tests authorize no storage provider operation'); };
const fixture = require('./roles-production-http.test'), { server } = fixture;
const ownedDirectory = path.resolve(path.dirname(process.env.PDL_DB_FILE));
assert.ok(ownedDirectory.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(ownedDirectory).startsWith('pdl-roles-production-http-'), 'Cleanup stays in the exact fixture-owned temporary directory');
const manual = require('./roles-manual-credential-custody'), collection = manual.COLLECTION;
const request = supabase.request;
supabase.request = async (route, options = {}) => {
  const platformRead = route.startsWith('/rest/v1/companies?') && route.includes('id=eq.' + fixture.platformFixture.id);
  if (platformRead) platformReads++; else if (route.startsWith('/rest/v1/companies?')) tenantReads++;
  if (beforeRead && route.startsWith('/rest/v1/companies?')) await beforeRead({ route, platformRead });
  const platformWrite = route === '/rest/v1/rpc/commit_platform_snapshot', tenantWrite = /^\/rest\/v1\/rpc\/commit_roles_snapshot(?:_with_platform)?$/.test(route);
  const input = platformWrite || tenantWrite ? JSON.parse(options.body) : null;
  if (beforeWrite && input) await beforeWrite({ route, input, platformWrite, tenantWrite });
  const response = await request(route, options);
  if (platformWrite) platformWrites++; if (tenantWrite) tenantWrites++;
  const ledger = platformWrite ? input.p_snapshot.platform[collection] : tenantWrite ? input.p_snapshot[collection] : null;
  if (lostAck && ledger?.some(row => row.operationId === lostAck)) { lostAck = null; throw Error('Synthetic accepted final COMMIT with lost acknowledgment'); }
  return response;
};
const bootstrapKey = crypto.randomBytes(32).toString('hex'); process.env.PDL_PLATFORM_KEY = bootstrapKey;
fixture.platformFixture.alter(platform => {
  platform.users = [{ id: 1, name: 'Synthetic Platform Owner', email: 'platform-owner@example.invalid', role: 'platform_owner', status: 'Active' }]; platform.sessions = [];
});
const platform = () => fixture.platformFixture.read().platform;
function restorePlatform(snapshot) { fixture.platformFixture.alter(value => { for (const name of Object.keys(value)) delete value[name]; Object.assign(value, structuredClone(snapshot)); }); }
async function call(method, route, { body, token, key, company = fixture.A, operationId = crypto.randomUUID() } = {}) {
  requests++;
  const response = await fetch(origin + route, { method, signal: AbortSignal.timeout(15000), headers: { 'X-PDL-Company': company, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(key ? { 'X-PDL-Platform-Key': key } : {}), ...(operationId === null ? {} : { 'X-PDL-Operation': operationId }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json(), operationId };
}
const okay = (response, status = 200) => { assert.equal(response.status, status, JSON.stringify(response.data)); return response.data; };
function denied(response, statuses = [401, 403, 404, 409, 503]) { assert.ok(statuses.includes(response.status), JSON.stringify(response.data)); assert.ok(!Object.hasOwn(response.data, 'setupCode'), 'Denied delivery cannot contain a manual code'); return response; }
function assertPrivate(db, code) {
  assert.ok(!JSON.stringify(db).includes(code), 'The generated plaintext code is absent from durable snapshots');
  const rows = db[collection]; assert.ok(rows?.length); assert.ok(rows.every(row => row.custody && !Object.hasOwn(row, 'setupCode')));
}
async function main() {
  let journeys = 0;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); origin = 'http://127.0.0.1:' + server.address().port;
    let before = canonicalHash(platform()), writes = platformWrites;
    assert.equal((await call('POST', '/api/platform/auth/bootstrap', { key: bootstrapKey, body: {}, operationId: null })).status, 400);
    assert.equal(canonicalHash(platform()), before); assert.equal(platformWrites, writes); journeys++;
    const bootstrapOp = crypto.randomUUID(); lostAck = bootstrapOp;
    const bootUnknown = await call('POST', '/api/platform/auth/bootstrap', { key: bootstrapKey, body: {}, operationId: bootstrapOp });
    assert.equal(bootUnknown.status, 503, JSON.stringify(bootUnknown.data)); assert.equal(bootUnknown.data.operationId, bootstrapOp); assert.equal(bootUnknown.data.code, 'PDL_COMMIT_OUTCOME_UNKNOWN');
    const bootstrap = okay(await call('GET', '/api/platform/manual-credentials/' + bootstrapOp, { key: bootstrapKey }));
    assert.equal(bootstrap.operationId, bootstrapOp); assert.match(bootstrap.setupCode, /^[A-Za-z0-9_-]{8,128}$/); assertPrivate(platform(), bootstrap.setupCode);
    before = canonicalHash(platform()); writes = platformWrites;
    assert.equal(okay(await call('POST', '/api/platform/auth/bootstrap', { key: bootstrapKey, body: {}, operationId: bootstrapOp })).setupCode, bootstrap.setupCode);
    assert.equal(canonicalHash(platform()), before); assert.equal(platformWrites, writes, 'Bootstrap replay never regenerates or commits'); journeys++;
    denied(await call('GET', '/api/platform/manual-credentials/' + bootstrapOp));
    process.env.PDL_PLATFORM_KEY = crypto.randomBytes(32).toString('hex');
    denied(await call('GET', '/api/platform/manual-credentials/' + bootstrapOp, { key: process.env.PDL_PLATFORM_KEY })); process.env.PDL_PLATFORM_KEY = bootstrapKey;
    okay(await call('POST', '/api/platform/auth/claim', { body: { email: bootstrap.email, setupCode: bootstrap.setupCode, password: 'Synthetic platform password 2026!' } }));
    denied(await call('GET', '/api/platform/manual-credentials/' + bootstrapOp, { key: bootstrapKey })); journeys++;
    const loginBody = { email: bootstrap.email, password: 'Synthetic platform password 2026!' };
    const loggedIn = okay(await call('POST', '/api/platform/auth/login', { body: loginBody })), ownerToken = loggedIn.token;
    fixture.platformFixture.alter(value => {
      value.users.push({ id: 3, name: 'Synthetic Other Platform Owner', email: 'other-owner@example.invalid', role: 'platform_owner', status: 'Active', mustSetPassword: false });
      value.users.push({ id: 4, name: 'Synthetic Platform Support', email: 'support@example.invalid', role: 'support', status: 'Active', mustSetPassword: false });
    });
    const otherToken = crypto.randomBytes(32).toString('base64url'), supportToken = crypto.randomBytes(32).toString('base64url');
    fixture.platformFixture.alter(value => { for (const [userId, token] of [[3, otherToken], [4, supportToken]]) value.sessions.push({ id: crypto.randomUUID(), userId, tokenHash: crypto.createHash('sha256').update(token).digest('hex'), createdAt: new Date().toISOString(), expiresAt: '2099-01-01T00:00:00.000Z' }); });
    const staffBody = { name: 'Synthetic Custody Staff', email: 'custody-staff@example.invalid', role: 'support' };
    before = canonicalHash(platform()); writes = platformWrites;
    denied(await call('POST', '/api/platform/users', { token: supportToken, body: staffBody }), [403]);
    assert.equal((await call('POST', '/api/platform/users', { token: ownerToken, body: staffBody, operationId: null })).status, 400);
    for (const extra of [{ id: 77 }, { companyId: fixture.B }, { permissions: { manageUsers: true } }]) assert.equal((await call('POST', '/api/platform/users', { token: ownerToken, body: { ...staffBody, ...extra } })).status, 400);
    assert.equal(canonicalHash(platform()), before); assert.equal(platformWrites, writes); journeys++;
    const staffOp = crypto.randomUUID(); lostAck = staffOp;
    const staffUnknown = await call('POST', '/api/platform/users', { token: ownerToken, body: staffBody, operationId: staffOp });
    assert.equal(staffUnknown.status, 503, JSON.stringify(staffUnknown.data)); assert.equal(staffUnknown.data.operationId, staffOp);
    const staff = okay(await call('GET', '/api/platform/manual-credentials/' + staffOp, { token: ownerToken }));
    assert.equal(staff.name, staffBody.name); assert.equal(staff.email, staffBody.email); assert.equal(staff.role, staffBody.role); assertPrivate(platform(), staff.setupCode);
    before = canonicalHash(platform()); writes = platformWrites;
    const staffReplay = okay(await call('POST', '/api/platform/users', { token: ownerToken, body: staffBody, operationId: staffOp }));
    assert.equal(staffReplay.setupCode, staff.setupCode); assert.equal(canonicalHash(platform()), before); assert.equal(platformWrites, writes);
    denied(await call('POST', '/api/platform/manual-credentials/' + staffOp, { token: ownerToken, body: {} }), [401, 404, 405]);
    denied(await call('POST', '/api/platform/users', { token: ownerToken, body: { ...staffBody, name: 'Changed synthetic input' }, operationId: staffOp }), [409]); journeys++;
    const secondSession = okay(await call('POST', '/api/platform/auth/login', { body: loginBody })).token;
    for (const token of [secondSession, otherToken, supportToken]) denied(await call('GET', '/api/platform/manual-credentials/' + staffOp, { token }), [403]);
    denied(await call('GET', '/api/platform/manual-credentials/' + staffOp, { token: ownerToken, company: fixture.B }), [404]); journeys++;
    const intact = platform(); fixture.platformFixture.alter(value => { value[collection].find(row => row.operationId === staffOp).custody.tag = 'A'.repeat(22); });
    denied(await call('GET', '/api/platform/manual-credentials/' + staffOp, { token: ownerToken }), [409]); restorePlatform(intact); journeys++;
    // This synthetic fixture is signed with an earlier creation time and an
    // already elapsed expiry. It tests real HTTP recovery's wall-clock gate;
    // it does not assert the native SQL commit deadline contract.
    const expired = structuredClone(intact), originalRow = expired[collection].find(row => row.operationId === staffOp), target = expired.users.find(row => row.id === staff.id);
    target.setupExpiresAt = new Date(Date.now() - 1000).toISOString(); expired[collection] = expired[collection].filter(row => row.operationId !== staffOp);
    const seeded = manual.createCustody({ key: Buffer.from(process.env.PDL_ROLE_POLICY_KEY, 'hex'), clock: () => Date.now() - 2000 }).enclose({ ...expired, company: { id: fixture.platformFixture.id, name: 'Pro Daily Link Platform Operations' } }, { operationId: staffOp, purpose: 'platform-staff-create', requestHash: originalRow.requestHash, scope: originalRow.scope, targetId: staff.id, setupCode: staff.setupCode }).snapshot;
    delete seeded.company; restorePlatform(seeded);
    denied(await call('GET', '/api/platform/manual-credentials/' + staffOp, { token: ownerToken }), [409]); restorePlatform(intact); journeys++;
    const startReads = platformReads;
    okay(await call('GET', '/api/platform/manual-credentials/' + staffOp, { token: ownerToken })); const readsPerRecovery = platformReads - startReads;
    assert.ok(readsPerRecovery >= 2, 'A private response is fenced by an independent current-platform load');
    const natural = structuredClone(intact), naturalTarget = natural.users.find(row => row.id === staff.id), expiresAt = Date.now() + 2000;
    naturalTarget.setupExpiresAt = new Date(expiresAt).toISOString(); natural[collection] = natural[collection].filter(row => row.operationId !== staffOp);
    const shortLived = manual.createCustody({ key: Buffer.from(process.env.PDL_ROLE_POLICY_KEY, 'hex') }).enclose({ ...natural, company: { id: fixture.platformFixture.id, name: 'Pro Daily Link Platform Operations' } }, { operationId: staffOp, purpose: 'platform-staff-create', requestHash: originalRow.requestHash, scope: originalRow.scope, targetId: staff.id, setupCode: staff.setupCode }).snapshot;
    delete shortLived.company; restorePlatform(shortLived);
    let heldForExpiry = false; const expiryFinalRead = platformReads + readsPerRecovery;
    beforeRead = async ({ platformRead }) => { if (platformRead && platformReads === expiryFinalRead) { beforeRead = null; heldForExpiry = true; await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt - Date.now() + 20))); } };
    denied(await call('GET', '/api/platform/manual-credentials/' + staffOp, { token: ownerToken }), [409]); assert.equal(heldForExpiry, true, 'The assembled private response actually waited across natural expiry with unchanged revision'); restorePlatform(intact); journeys++;
    const finalRead = platformReads + readsPerRecovery;
    beforeRead = async ({ platformRead }) => { if (platformRead && platformReads === finalRead) { beforeRead = null; fixture.platformFixture.alter(value => { value.users.find(row => row.id === 1).status = 'Inactive'; }); } };
    denied(await call('GET', '/api/platform/manual-credentials/' + staffOp, { token: ownerToken }), [403, 409]); restorePlatform(intact); journeys++;
    okay(await call('POST', '/api/platform/auth/claim', { body: { email: staff.email, setupCode: staff.setupCode, password: 'Synthetic claimed staff password 2026!' } }));
    denied(await call('GET', '/api/platform/manual-credentials/' + staffOp, { token: ownerToken }), [409]);
    before = canonicalHash(platform()); writes = platformWrites;
    denied(await call('POST', '/api/platform/users', { token: ownerToken, body: staffBody, operationId: staffOp }), [409]); assert.equal(canonicalHash(platform()), before); assert.equal(platformWrites, writes); journeys++;
    const resetRoute = '/api/platform/companies/' + fixture.A + '/owner-reset', resetAuthority = okay(await call('GET', '/api/platform/companies/' + fixture.A + '/roles-authority', { token: ownerToken }));
    before = canonicalHash(fixture.read()); let tenantCommits = tenantWrites;
    denied(await call('POST', resetRoute, { token: supportToken, body: { expectedRevision: resetAuthority.expectedRevision } }), [403]);
    assert.equal((await call('POST', resetRoute, { token: ownerToken, body: { expectedRevision: resetAuthority.expectedRevision }, operationId: null })).status, 400);
    assert.equal((await call('POST', resetRoute, { token: ownerToken, body: { expectedRevision: resetAuthority.expectedRevision, ownerId: 2 } })).status, 400);
    assert.equal(canonicalHash(fixture.read()), before); assert.equal(tenantWrites, tenantCommits); journeys++;
    const resetOp = crypto.randomUUID(); lostAck = resetOp;
    const ownerUnknown = await call('POST', resetRoute, { token: ownerToken, body: { expectedRevision: resetAuthority.expectedRevision }, operationId: resetOp });
    assert.equal(ownerUnknown.status, 503, JSON.stringify(ownerUnknown.data)); assert.equal(ownerUnknown.data.operationId, resetOp, JSON.stringify(ownerUnknown.data));
    const reset = okay(await call('GET', resetRoute + '/' + resetOp, { token: ownerToken }));
    assert.equal(reset.companyId, fixture.A); assert.equal(reset.operationId, resetOp); assertPrivate(fixture.read(), reset.setupCode);
    assert.equal(fixture.read().users.find(row => row.role === 'owner').mustSetPassword, true); assert.ok(!fixture.read().sessions.some(row => row.userId === 1));
    before = canonicalHash(fixture.read()); tenantCommits = tenantWrites; writes = platformWrites;
    assert.equal(okay(await call('POST', resetRoute, { token: ownerToken, body: { expectedRevision: resetAuthority.expectedRevision }, operationId: resetOp })).setupCode, reset.setupCode);
    assert.equal(canonicalHash(fixture.read()), before); assert.equal(tenantWrites, tenantCommits); assert.equal(platformWrites, writes); journeys++;
    denied(await call('POST', resetRoute + '/' + resetOp, { token: ownerToken, body: {} }), [405]);
    for (const token of [secondSession, otherToken, supportToken]) denied(await call('GET', resetRoute + '/' + resetOp, { token }), [403]);
    denied(await call('GET', '/api/platform/companies/' + fixture.B + '/owner-reset/' + resetOp, { token: ownerToken }));
    const originalTenant = fixture.read(); fixture.alter(db => { db[collection].find(row => row.operationId === resetOp).signature = '0'.repeat(64); });
    denied(await call('GET', resetRoute + '/' + resetOp, { token: ownerToken }), [409]); fixture.alter(db => { db[collection] = structuredClone(originalTenant[collection]); }); journeys++;
    const nextAuthority = okay(await call('GET', '/api/platform/companies/' + fixture.A + '/roles-authority', { token: ownerToken })), racedOp = crypto.randomUUID(); before = canonicalHash(fixture.read()); tenantCommits = tenantWrites;
    beforeWrite = async ({ tenantWrite, input }) => { if (tenantWrite && input.p_snapshot[collection]?.some(row => row.operationId === racedOp)) { beforeWrite = null; fixture.platformFixture.alter(value => { value.users.find(row => row.id === 1).status = 'Inactive'; }); } };
    denied(await call('POST', resetRoute, { token: ownerToken, body: { expectedRevision: nextAuthority.expectedRevision }, operationId: racedOp }), [403, 409]);
    assert.equal(canonicalHash(fixture.read()), before, 'Shared-platform revocation at the tenant CAS prevents a new target generation'); assert.equal(tenantWrites, tenantCommits); restorePlatform(platform().users.some(row => row.id === 1 && row.status === 'Inactive') ? { ...platform(), users: platform().users.map(row => row.id === 1 ? { ...row, status: 'Active' } : row) } : platform()); journeys++;
    const ownerRow = fixture.read().users.find(row => row.role === 'owner');
    fixture.alter(db => { db.users.find(row => row.id === ownerRow.id).setupHash = 'f'.repeat(128); });
    denied(await call('GET', resetRoute + '/' + resetOp, { token: ownerToken }), [409]); journeys++;
    const publicPlatform = okay(await call('GET', '/api/platform/overview', { token: ownerToken }));
    assert.ok(!JSON.stringify(publicPlatform).includes(collection) && !JSON.stringify(publicPlatform).includes('ciphertext') && !JSON.stringify(publicPlatform).includes(staff.setupCode), 'Ordinary platform projections conceal manual custody'); journeys++;
    console.log(JSON.stringify({ passed: true, journeys, requests, platformWrites, tenantWrites, platformReads, tenantReads, expectedDenialLogs, externalCalls: 0, normalServer: true, syntheticTransport: true, testInstallerUsed: false, nativeDeadlineClaim: false }));
  } finally {
    lostAck = null; beforeRead = null; beforeWrite = null; process.env.PDL_PLATFORM_KEY = ''; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); globalThis.fetch = nativeFetch; console.error = nativeError; fs.rmSync(ownedDirectory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
