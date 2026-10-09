'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { A, B, snapshot, memory, initial } = require('./compat-account-fixture');
const { services } = require('./compat-lifecycle-fixture');
const { validateAccounts } = require('./account-evidence');
const { canonicalHash } = require('./database/transactional-repository');
const { COLLECTION, HISTORY, stripPrivate } = require('./account-credential-delivery');
const boundary = require('./compat-account-boundary');
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-compat-lifecycle-')), file = path.join(directory, 'db.json'), legacy = snapshot(); legacy.company.id = B; legacy.users[0].companyId = B; fs.writeFileSync(file, JSON.stringify(legacy));
  const before = fs.readFileSync(file), names = ['NODE_ENV', 'PDL_COMPAT_ACCOUNT_SYNTHETIC', 'PDL_REQUIRE_AUTH', 'PDL_DB_FILE', 'PDL_PLATFORM_FILE', 'PDL_COMPAT_GLOBAL_FENCE_FILE', 'PDL_SUPABASE_ENABLED', 'PDL_TRANSACTIONAL_DB', 'OPENAI_API_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'SENTRY_DSN', 'SUPABASE_SECRET_KEY', 'PDL_PLATFORM_KEY'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { NODE_ENV: 'test', PDL_COMPAT_ACCOUNT_SYNTHETIC: '1', PDL_REQUIRE_AUTH: '1', PDL_DB_FILE: file, PDL_PLATFORM_FILE: path.join(directory, 'platform.json'), PDL_COMPAT_GLOBAL_FENCE_FILE: '', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', OPENAI_API_KEY: '', RESEND_API_KEY: '', STRIPE_SECRET_KEY: '', SENTRY_DSN: '', SUPABASE_SECRET_KEY: '', PDL_PLATFORM_KEY: '' });
  const module = require('./server'), store = memory(snapshot()); let uninstall;
  try {
    await new Promise(resolve => module.server.listen(0, '127.0.0.1', resolve)); const origin = 'http://127.0.0.1:' + module.server.address().port;
    const fixture = services(store, origin); uninstall = module.installCompatibilityAccountTests({ synthetic: true, companyId: A, origin, globalOrigin: 'http://localhost:4999', repository: store, ...fixture, dispatchAfterCommit: true });
    let token = '';
    async function request(route, method = 'GET', input, opts = {}) { const response = await fetch(origin + route, { method, headers: { Connection: 'close', 'X-PDL-Company': opts.companyId || A, ...(token && !opts.public ? { Authorization: 'Bearer ' + token } : {}), ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }); return { status: response.status, data: await response.json() }; }
    const login = await request('/api/auth/login', 'POST', { email: 'owner@example.invalid', password: initial }); assert.equal(login.status, 200); token = login.data.token;
    assert.equal((await request('/api/health')).status, 200); const me = await request('/api/auth/me'); assert.match(me.data.accountSessionBinding, /^[a-f0-9]{64}$/); assert.equal(me.data.schedulingAccess.edit, true);
    async function preview(route, method, input) { const operationId = crypto.randomUUID(), result = await request('/api/account-actions/preview', 'POST', { path: route, method, input, reason: 'Synthetic owner reviewed account change', operationId }); assert.equal(result.status, 200, JSON.stringify(result)); return { previewId: result.data.previewId, operationId, expectedRevision: result.data.expectedRevision, confirmed: true }; }
    assert.equal((await request('/api/users', 'POST', { name: 'Blocked', email: 'blocked@example.invalid', role: 'admin' })).status, 409);
    const create = await preview('/api/users', 'POST', { name: 'Synthetic PM', email: 'pm@example.invalid', role: 'project_manager', projectIds: [101], assignedCrews: ['Synthetic Crew'], permissions: { scheduleCrews: true, manageTime: true } });
    assert.equal((await request('/api/account-actions/confirm', 'POST', { ...create, confirmed: false })).status, 400);
    const account = await request('/api/account-actions/confirm', 'POST', create); assert.equal(account.status, 201, JSON.stringify(account)); assert.match(account.data.temporaryPassword, /^[A-Za-z0-9_-]{8}$/); assert.equal(account.data.permissions.viewDailies, true);
    const targetId = account.data.id, secret = account.data.temporaryPassword; assert.equal(JSON.stringify(store.current()).includes(secret), false);
    const issued = store.current(), issuedSession = issued.sessions.find(row => row.tokenHash === crypto.createHash('sha256').update(token).digest('hex')), issuedAuth = { companyId: A, user: issued.users[0], session: issuedSession };
    const { createSecretRecovery } = require('./account-secret-recovery'); assert.throws(() => createSecretRecovery({ key: crypto.randomBytes(32) }).recover(issued, issuedAuth, create.operationId), /recovery/); const wrongVersion = structuredClone(issued); wrongVersion.accountSecretEnvelopes[0].keyVersion = 'wrong-version'; assert.throws(() => fixture.secretRecovery.recover(wrongVersion, issuedAuth, create.operationId), /recovery/);
    const replay = await request('/api/account-actions/confirm', 'POST', create); assert.equal(replay.data.temporaryPassword, secret); assert.equal(store.current().users.length, 2); assert.equal(store.current().auditLog.filter(row => row.type === 'account_change_confirmed').length, 1);
    assert.equal((await request('/api/account-actions/confirm', 'POST', { ...create, previewId: crypto.randomUUID() })).status, 409);
    assert.equal((await request('/api/account-actions/recover', 'POST', { operationId: create.operationId })).data.temporaryPassword, secret);
    const ownerSession = store.current().sessions[0];
    const claim = await request('/api/auth/claim', 'POST', { email: 'pm@example.invalid', temporaryPassword: secret, password: 'Synthetic PM permanent password' }, { public: true }); assert.equal(claim.status, 200); assert.deepEqual(store.current().sessions, [ownerSession]);
    assert.equal((await request('/api/auth/claim', 'POST', { email: 'pm@example.invalid', temporaryPassword: secret, password: 'Synthetic PM next password' }, { public: true })).status, 401);
    assert.equal((await request('/api/account-actions/recover', 'POST', { operationId: create.operationId })).status, 409);
    // An unknown COMMIT result is recovered with the original operation only.
    const reset = await preview('/api/users/' + targetId + '/reset-code', 'POST', {}); store.loseCommitAck = true;
    assert.equal((await request('/api/account-actions/confirm', 'POST', reset)).status, 503);
    const recovered = await request('/api/account-actions/recover', 'POST', { operationId: reset.operationId }); assert.equal(recovered.status, 200); assert.match(recovered.data.temporaryPassword, /^[A-Za-z0-9_-]{8}$/);
    const revision = store.revision(); assert.equal((await request('/api/account-actions/confirm', 'POST', reset)).data.temporaryPassword, recovered.data.temporaryPassword); assert.equal(store.revision(), revision);
    // A different current session cannot recover the manual secret.
    const second = await request('/api/auth/login', 'POST', { email: 'owner@example.invalid', password: initial }), firstToken = token; token = second.data.token;
    assert.equal((await request('/api/account-actions/recover', 'POST', { operationId: reset.operationId })).status, 409); token = firstToken;
    const prefs = await request('/api/users/1/preferences', 'PATCH', { displayName: 'Synthetic Display', theme: 'dark', preferredLanguage: 'es', scheduleShowOffice: false }); assert.equal(prefs.status, 200); assert.equal((await request('/api/auth/me')).data.preferences.displayName, 'Synthetic Display');
    // Reviewed compound effects include finite credential/delivery revocation,
    // including a name-only legacy edit, without exposing bearer custody.
    for (const [route, value] of [['/api/users/' + targetId + '/time-access', { manageTime: false }], ['/api/users/' + targetId, { name: 'Renamed Synthetic PM' }]]) {
      let pending = await store.load(A); fixture.credentials.requestReset(pending.snapshot, pending.snapshot.users[1].email); fixture.credentials.requestVerification(pending.snapshot, targetId); await store.commit(pending.snapshot, pending.revision);
      const operationId = crypto.randomUUID(), proposed = await request('/api/account-actions/preview', 'POST', { path: route, method: 'PATCH', input: value, reason: 'Reviewed account and credential revocation impact', operationId }); assert.equal(proposed.status, 200);
      const revocations = proposed.data.impact.credentialRevocations; assert.equal(revocations.passwordResetLinks, 1); assert.equal(revocations.emailVerificationLinks, 1); assert.equal(revocations.queuedPasswordResetDeliveries, 1); assert.equal(revocations.queuedVerificationDeliveries, 1); assert.equal(JSON.stringify(proposed.data).includes('custody'), false);
      const confirmed = await request('/api/account-actions/confirm', 'POST', { previewId: proposed.data.previewId, operationId, expectedRevision: proposed.data.expectedRevision, confirmed: true }); assert.equal(confirmed.status, 200, JSON.stringify(confirmed));
      const saved = store.current(); assert.equal(saved.users[1].resetTokenHash, undefined); assert.equal(saved.users[1].emailVerificationTokenHash, undefined); assert.equal(saved[COLLECTION].some(row => row.userId === targetId), false); assert.equal(saved[HISTORY].filter(row => row.userId === targetId && row.status === 'cancelled').length >= 2, true); assert.deepEqual(saved.auditLog.find(row => row.operationId === operationId).credentialRevocations, revocations);
    }
    const time = await preview('/api/users/' + targetId + '/time-access', 'PATCH', { manageTime: false }); assert.equal((await request('/api/account-actions/confirm', 'POST', time)).status, 200); assert.equal(store.current().users[1].permissions.manageTime, false);
    assert.equal((await request('/api/account-actions/recover', 'POST', { operationId: reset.operationId })).status, 409);
    const edit = await preview('/api/users/' + targetId, 'PATCH', { email: 'updated-pm@example.invalid', role: 'field', memberId: 11 }); assert.equal((await request('/api/account-actions/confirm', 'POST', edit)).status, 200); assert.equal(store.current().users[1].role, 'field');
    const linked = await preview('/api/team-with-account', 'POST', { name: 'Synthetic Linked', email: 'linked@example.invalid', role: 'Laborer', crew: 'New Synthetic Crew', accountRole: 'field', initials: 'SL', hours: 0, site: 'Not assigned' });
    const member = await request('/api/account-actions/confirm', 'POST', linked); assert.equal(member.status, 201); assert.equal(member.data.user.memberId, member.data.id); assert.match(member.data.temporaryPassword, /^[A-Za-z0-9_-]{8}$/);
    assert.equal((await request('/api/users')).data.length, 3);
    // Verification rotates, commits before delivery, consumes once, keeps sessions.
    assert.equal((await request('/api/auth/email-verification/resend', 'POST', {})).status, 200); const message = fixture.messages.at(-1); assert.equal(message.purpose, 'email-verification'); const verifyToken = new URL(message.verifyUrl).searchParams.get('token'), sessions = store.current().sessions;
    assert.equal((await request('/api/auth/email-verification/confirm', 'POST', { token: verifyToken }, { companyId: B, public: true })).status, 404);
    assert.equal((await request('/api/auth/email-verification/confirm', 'POST', { token: verifyToken }, { public: true })).status, 200); assert.deepEqual(store.current().sessions, sessions);
    assert.equal((await request('/api/auth/email-verification/confirm', 'POST', { token: verifyToken }, { public: true })).status, 401);
    assert.equal((await request('/api/auth/email-verification/resend', 'POST', {})).data.alreadyVerified, true);
    // Recomputed content hashes cannot forge a preview or receipt HMAC.
    const stale = await preview('/api/users/' + targetId + '/time-access', 'PATCH', { manageTime: false }); let loaded = await store.load(A); loaded.snapshot.accountActionPreviews.at(-1).input.manageTime = true; await store.commit(loaded.snapshot, loaded.revision);
    assert.equal((await request('/api/account-actions/confirm', 'POST', stale)).status, 409);
    loaded = await store.load(A); loaded.snapshot.accountActionReceipts[0].result.secret = { passwordSalt: 'poison', hidden: 'Private arbitrary data' }; await store.commit(loaded.snapshot, loaded.revision);
    const poison = await request('/api/account-actions/recover', 'POST', { operationId: create.operationId }); assert.equal(poison.status, 409); assert.equal(JSON.stringify(poison).includes('Private arbitrary'), false);
    assert.deepEqual(fs.readFileSync(file), before);
    // Canonical malformed security evidence cannot act as verified owner.
    for (const mutation of [db => { db.users[0].emailVerifiedAt = {}; }, db => { db.users[0].accountVerificationGeneration = null; }, db => { db.users[0].setupExpiresAt = {}; }, db => { db.users[0].setupGeneration = false; }]) { const db = snapshot(); mutation(db); assert.throws(() => validateAccounts(db), /evidence/); }
    // Append-only terminal receipts do not exhaust the prior 500-job ceiling.
    const durable = memory(snapshot()), delivery = services(durable, origin).credentials;
    for (let index = 0; index < 550; index++) { const row = await durable.load(A), job = delivery.requestReset(row.snapshot, 'owner@example.invalid'); await durable.commit(row.snapshot, row.revision); assert.equal((await delivery.dispatch(A, job.jobId)).status, 'sent'); }
    assert.equal(durable.current()[COLLECTION].length, 0); assert.equal(durable.current()[HISTORY].length, 550); assert.equal(Object.hasOwn(durable.current()[HISTORY][0], 'custody'), false);
    assert.equal(stripPrivate(durable.current())[HISTORY], undefined);
    // Global source fence blocks alternate snapshot writes even if cloud is off.
    const fenceFile = path.join(directory, 'fence.json'); fs.writeFileSync(fenceFile, JSON.stringify({ version: 1, companyId: A, origin, globalOrigin: 'http://localhost:4999' })); process.env.PDL_COMPAT_GLOBAL_FENCE_FILE = fenceFile;
    const adapter = require('./database/supabase'); await assert.rejects(adapter.saveCompanySnapshot(snapshot()), /current service/); await assert.rejects(adapter.loadCompanySnapshot(A), /current service/); await assert.rejects(adapter.saveSnapshot(B, 'Synthetic alias', snapshot()), /current service/); await assert.rejects(adapter.saveTransactionalSnapshot(snapshot()), /current service/);
    assert.throws(() => boundary.adapterRequest('/rest/v1/companies', { method: 'PATCH', body: '{}' }), /current service/); assert.throws(() => boundary.adapterRequest('/rest/v1/rpc/replace_tenant_records', { method: 'POST', body: JSON.stringify({ p_company_id: A }) }), /current service/);
    assert.equal(await adapter.saveCompanySnapshot(legacy), false);
    await assert.rejects(adapter.createVerifiedBackup(snapshot()), /current service/);
    const { TransactionalTenantRepository } = require('./database/transactional-repository'), alternate = new TransactionalTenantRepository({ pool: { connect() { throw Error('Must not connect'); } } }); await assert.rejects(alternate.load(A), /current service/); await assert.rejects(alternate.save(snapshot(), 1), /current service/);
    assert.throws(() => require('./database/migrate-json').buildTenantSnapshot(snapshot()), /current service/);
    assert.throws(() => boundary.adapterRequest('/rest/v1/tenant_records', {}), /current service/);
    const emptyWrite = new Response(null, { status: 204 }); assert.equal(await boundary.adapterResponse('/rest/v1/companies', emptyWrite, { method: 'POST' }), emptyWrite);
    const readRows = await boundary.adapterResponse('/rest/v1/companies', new Response(JSON.stringify([{ id: A, data: snapshot() }, { id: B, data: legacy }]), { status: 200 })); assert.deepEqual(await readRows.json(), [{ id: B, data: legacy }]);
    // A bounded cloud search cannot prove the absence of another company with
    // this email. Require explicit selected intent while preserving old defaults.
    const vm = require('node:vm'), source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8'), start = source.indexOf('async function companyIdForEmail('), end = source.indexOf('\nfunction ', start + 1); assert.ok(start >= 0 && end > start);
    const discoveryContext = { tenantDatabases: () => [], supabase: { configured: () => true, findCompanyByUserEmail: async () => null }, compatibilityBoundary: { boundary: () => ({ companyId: A }), discoverEmail: async () => A } }; vm.createContext(discoveryContext); vm.runInContext(source.slice(start, end), discoveryContext);
    await assert.rejects(discoveryContext.companyIdForEmail('owner@example.invalid'), error => error.code === 'PDL_COMPAT_TENANT_AMBIGUOUS'); assert.equal(await discoveryContext.companyIdForEmail('owner@example.invalid', A), A); discoveryContext.compatibilityBoundary.boundary = () => null; discoveryContext.tenantDatabases = () => [snapshot()]; assert.equal(await discoveryContext.companyIdForEmail('owner@example.invalid'), A);
    // The legacy primary may itself be selected. No supplied tenant hint must
    // not allow a rejected fresh snapshot to fall back to that stale file.
    uninstall(); uninstall = null; const stalePrimary = snapshot(), staleToken = 'synthetic-selected-primary-session'; stalePrimary.sessions = [{ id: crypto.randomUUID(), companyId: A, userId: 1, tokenHash: crypto.createHash('sha256').update(staleToken).digest('hex'), expiresAt: '2099-01-01T00:00:00.000Z' }]; fs.writeFileSync(file, JSON.stringify(stalePrimary)); const staleBytes = fs.readFileSync(file);
    for (const route of ['/api/users', '/api/state', '/api/account-access']) { const response = await fetch(origin + route, { headers: { Authorization: 'Bearer ' + staleToken } }); assert.equal(response.status, 503); assert.equal((await response.text()).includes('owner@example.invalid'), false); }
    assert.deepEqual(fs.readFileSync(file), staleBytes); process.env.PDL_COMPAT_GLOBAL_FENCE_FILE = ''; const ordinary = await fetch(origin + '/api/users', { headers: { Authorization: 'Bearer ' + staleToken } }); assert.equal(ordinary.status, 200); assert.equal((await ordinary.json())[0].email, 'owner@example.invalid'); process.env.PDL_COMPAT_GLOBAL_FENCE_FILE = fenceFile;
    fs.writeFileSync(fenceFile, '{}'); assert.throws(() => boundary.assertLegacy(B), /current service/);
    console.log('Account lifecycle: reviewed actual account actions, claim/verification, originating-session recovery, unknown COMMIT, canonical poison, 550 durable receipts and alternate writer fences passed.');
  } finally { uninstall?.(); await new Promise(resolve => module.server.close(resolve)); for (const name of names) saved[name] === undefined ? delete process.env[name] : process.env[name] = saved[name]; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
