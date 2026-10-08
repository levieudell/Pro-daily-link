'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { CANDIDATE, EXPECTED_STRIPE_ACCOUNT, ROOT_TENANT, PRICES, FORCED, ENTERPRISE_OPT_IN, OWNER_OPT_IN, APPROVED_SERVICE, APPROVED_ORIGIN, OWNER, OWNER_IDENTITY_FILE, validateConfig, prepareStorage } = require('./scripts/start-acceptance');
const ROOT = __dirname;
const hosted = { RENDER_EXTERNAL_URL: 'https://synthetic-acceptance-test.onrender.com' }; // Fixture only, not a deployed URL.
// Synthetic, temporary test input only. This is never a hosted/default password.
const fixturePassword = () => ' synthetic-test-' + crypto.randomUUID() + ' ';
const enterpriseEnv = () => ({ RENDER: 'true', RENDER_SERVICE_ID: APPROVED_SERVICE, RENDER_EXTERNAL_URL: APPROVED_ORIGIN, PDL_ACCEPTANCE_ENTERPRISE: ENTERPRISE_OPT_IN, PDL_ACCEPTANCE_PLATFORM_OWNER: OWNER_OPT_IN });
const temporary = prefix => fs.mkdtempSync(`/tmp/pdl-acceptance-${prefix}-`);
function fixture(t) { const root = temporary('source-test'); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function storage(t, env = hosted, root = ROOT) {
  const directory = temporary('storage-test');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return validateConfig({ ...env, PDL_ACCEPTANCE_DATA_DIR: directory }, root);
}
for (const prefix of ['sk', 'rk']) {
  test(`rejects ${prefix} live mode without echoing the value`, () => {
    const secret = `${prefix}_live_ThisIsAnInvalidSyntheticFixture`;
    assert.throws(() => validateConfig({ ...hosted, STRIPE_SECRET_KEY: secret }), error => !error.message.includes(secret) && /test-mode/.test(error.message));
  });
  test(`allows ${prefix} test format while preserving unverified-account semantics`, () => {
    const config = validateConfig({ ...hosted, STRIPE_SECRET_KEY: `${prefix}_test_NotAnActualCredential` });
    assert.equal(config.keyPresent, true);
    assert.equal(config.expectedAccount, EXPECTED_STRIPE_ACCOUNT);
    assert.equal(Object.hasOwn(config, 'accountVerified'), false);
  });
}
test('rejects unknown keys and malformed signing secrets', () => {
  for (const key of ['garbage', 'pk_test_notASecret', ' sk_test_fixture', 'sk_test_fixture\n', 'sk_test_']) assert.throws(() => validateConfig({ ...hosted, STRIPE_SECRET_KEY: key }));
  assert.throws(() => validateConfig({ ...hosted, STRIPE_WEBHOOK_SECRET: 'not-a-signing-secret' }));
});
test('rejects inherited integration credentials, production backends, and path overrides', () => {
  for (const name of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'DATABASE_URL', 'PGPASSWORD', 'RESEND_API_KEY', 'RESEND_FROM', 'OPENAI_API_KEY', 'SENTRY_DSN', 'PDL_PLATFORM_KEY', 'PDL_DB_FILE', 'PDL_PLATFORM_FILE', 'PDL_UNKNOWN_SETTING', 'STRIPE_ACCOUNT', 'STRIPE_PRICE_FOUNDER_STARTER', 'NODE_OPTIONS', 'NODE_PATH']) {
    assert.throws(() => validateConfig({ ...hosted, [name]: 'synthetic-forbidden-value' }), /Inherited integration/);
  }
  for (const name of Object.keys(FORCED)) {
    assert.throws(() => validateConfig({ ...hosted, [name]: FORCED[name] === '1' ? '0' : '1' }), /cannot be overridden/);
  }
  assert.doesNotThrow(() => validateConfig({ ...hosted, ...FORCED }));
});
test('rejects both root dotenv files, including dangling symlinks', t => {
  const root = fixture(t);
  for (const name of ['.env', '.env.local']) {
    fs.writeFileSync(path.join(root, name), 'synthetic-placeholder');
    assert.throws(() => validateConfig(hosted, root), /Remove root/);
    fs.unlinkSync(path.join(root, name));
  }
  fs.symlinkSync(path.join(root, 'missing-file'), path.join(root, '.env.local'));
  assert.throws(() => validateConfig(hosted, root), /Remove root/);
});
test('rejects production hosts, URLs with extra components, and inherited return URLs', () => {
  for (const url of ['https://app.prodailylink.com', 'https://pro-daily-link-demo.onrender.com', 'http://synthetic-acceptance-test.onrender.com', 'https://synthetic-acceptance-test.onrender.com/path', 'https://synthetic-acceptance-test.onrender.com/?a=b', 'https://user:pass@synthetic-acceptance-test.onrender.com', 'https://other.invalid']) assert.throws(() => validateConfig({ RENDER_EXTERNAL_URL: url }));
  assert.throws(() => validateConfig({ ...hosted, PDL_PUBLIC_URL: 'https://app.prodailylink.com' }));
  assert.throws(() => validateConfig({}));
  assert.throws(() => validateConfig({ ...hosted, PDL_ACCEPTANCE_PUBLIC_URL: 'http://127.0.0.1:4173' }));
});
test('local mode requires explicit loopback IP, switch, matching port, and no Render context', () => {
  const local = { PDL_ACCEPTANCE_ALLOW_LOOPBACK: '1', PDL_ACCEPTANCE_PUBLIC_URL: 'http://127.0.0.1:4173' };
  assert.equal(validateConfig(local).publicUrl, local.PDL_ACCEPTANCE_PUBLIC_URL);
  assert.throws(() => validateConfig({ ...local, PORT: '4174' }));
  assert.throws(() => validateConfig({ ...local, RENDER: 'true' }));
  assert.throws(() => validateConfig({ ...local, ...hosted }));
  for (const url of ['http://localhost:4173', 'http://0.0.0.0:4173', 'http://192.0.2.1:4173', 'https://127.0.0.1:4173']) assert.throws(() => validateConfig({ ...local, PDL_ACCEPTANCE_PUBLIC_URL: url }));
});
test('pins account metadata and all six verified prices', () => {
  assert.equal(Object.keys(PRICES).length, 6);
  assert.doesNotThrow(() => validateConfig({ ...hosted, ...PRICES, PDL_ACCEPTANCE_STRIPE_ACCOUNT_ID: EXPECTED_STRIPE_ACCOUNT }));
  assert.throws(() => validateConfig({ ...hosted, PDL_ACCEPTANCE_STRIPE_ACCOUNT_ID: 'acct_otherSyntheticFixture' }));
  for (const name of Object.keys(PRICES)) assert.throws(() => validateConfig({ ...hosted, [name]: 'price_unverifiedFixture' }), /verified sandbox/);
});
test('creates private empty synthetic state without reading committed demo data', t => {
  const root = fixture(t), config = storage(t, hosted, root);
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data/db.json'), 'not JSON: this must never be loaded');
  fs.writeFileSync(path.join(root, 'data/platform.json'), 'not JSON: this must never be loaded');
  const files = prepareStorage(config);
  const db = JSON.parse(fs.readFileSync(files.dbFile));
  const platform = JSON.parse(fs.readFileSync(files.platformFile));
  assert.equal(db.company.id, ROOT_TENANT);
  assert.equal(db.company.demo, undefined);
  assert.equal(db.acceptanceOnly, true);
  for (const value of Object.values(db)) if (Array.isArray(value)) assert.deepEqual(value, []);
  for (const value of Object.values(platform)) if (Array.isArray(value)) assert.deepEqual(value, []);
  assert.equal(fs.statSync(config.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(files.dbFile).mode & 0o777, 0o600);
});
test('ordinary startup preserves seed modifications and fake signup tenants', t => {
  const config = storage(t), files = prepareStorage(config);
  const db = JSON.parse(fs.readFileSync(files.dbFile)); db.company.acceptanceRestartNote = 'synthetic-stays';
  fs.writeFileSync(files.dbFile, JSON.stringify(db));
  const tenants = path.join(config.directory, 'tenants'); fs.mkdirSync(tenants, { mode: 0o700 });
  const tenant = path.join(tenants, '11111111-1111-4111-8111-111111111111.json');
  fs.writeFileSync(tenant, '{"synthetic":"preserved"}', { mode: 0o600 });
  const before = fs.readFileSync(tenant, 'utf8');
  prepareStorage(config);
  assert.equal(fs.readFileSync(tenant, 'utf8'), before);
  assert.equal(JSON.parse(fs.readFileSync(files.dbFile)).company.acceptanceRestartNote, 'synthetic-stays');
});
test('refuses unsafe storage paths, unmarked data, symlinks, hard links, and public permissions', t => {
  for (const directory of ['/tmp', '/data/customer-data', '/tmp/ordinary-data', '/tmp/pdl-acceptance-x/..', '/tmp/pdl-acceptance-x/child']) assert.throws(() => validateConfig({ ...hosted, PDL_ACCEPTANCE_DATA_DIR: directory }));
  const unmarked = storage(t); fs.writeFileSync(path.join(unmarked.directory, 'existing.json'), '{}', { mode: 0o600 });
  assert.throws(() => prepareStorage(unmarked), /unmarked/);
  const linked = storage(t); fs.symlinkSync('/tmp', path.join(linked.directory, 'link'));
  assert.throws(() => prepareStorage(linked), /symlinks/);
  const hard = storage(t); const target = path.join(hard.directory, 'target'); fs.writeFileSync(target, '{}', { mode: 0o600 }); fs.linkSync(target, path.join(hard.directory, 'link'));
  assert.throws(() => prepareStorage(hard), /hard links/);
  const publicDir = storage(t); fs.chmodSync(publicDir.directory, 0o755);
  assert.throws(() => prepareStorage(publicDir), /private/);
});
test('refuses changed origin, corrupt state, and production/demo uploads rather than resetting them', t => {
  const config = storage(t), files = prepareStorage(config);
  assert.throws(() => prepareStorage({ ...config, publicUrl: 'https://different-acceptance-test.onrender.com' }), /different service/);
  fs.writeFileSync(files.dbFile, 'not valid JSON');
  assert.throws(() => prepareStorage(config), /will not be overwritten/);
  assert.equal(fs.readFileSync(files.dbFile, 'utf8'), 'not valid JSON');
  const root = fixture(t); fs.mkdirSync(path.join(root, 'uploads')); fs.writeFileSync(path.join(root, 'uploads', 'existing.txt'), 'existing');
  assert.throws(() => validateConfig(hosted, root), /empty/);
});
test('CLI refusal never logs the rejected key or inherited secret', () => {
  const fake = 'sk_' + 'live_' + 'DefinitelyNotARealCredential';
  const result = spawnSync(process.execPath, ['scripts/start-acceptance.js'], { cwd: ROOT, env: { ...hosted, STRIPE_SECRET_KEY: fake }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Only owner-entered Stripe test-mode/);
  assert.equal((result.stdout + result.stderr).includes(fake), false);
});
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function boot(env) {
  // No external requests can succeed in these tests; this hook is not deployed.
  const child = spawn(process.execPath, ['-e', "global.fetch=async()=>{throw new Error('External network disabled in acceptance tests')};require('./scripts/start-acceptance').start()"], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  const stopped = new Promise(resolve => child.once('exit', resolve));
  const stop = async () => { if (child.exitCode === null) child.kill('SIGTERM'); await stopped; };
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error('Acceptance test child exited: ' + logs);
    try { const response = await fetch(env.PDL_ACCEPTANCE_PUBLIC_URL + '/api/health'); if (response.ok) return { stop, logs: () => logs }; } catch {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  await stop(); throw new Error('Acceptance test child did not become healthy');
}
test('real no-key boot: health/auth safe, fake signup retained across restart, paid/email flows unavailable', async t => {
  const directory = temporary('http-test'); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const env = { PDL_ACCEPTANCE_ALLOW_LOOPBACK: '1', PDL_ACCEPTANCE_PUBLIC_URL: base, PDL_ACCEPTANCE_DATA_DIR: directory, PORT: String(port) };
  let running = await boot(env); t.after(async () => running.stop());
  let response = await fetch(base + '/api/health'), health = await response.json();
  assert.equal(response.headers.get('x-pdl-acceptance'), 'isolated-synthetic');
  assert.equal(response.headers.get('x-pdl-candidate'), CANDIDATE);
  assert.equal(health.ok, true); assert.equal(health.cloud.configured, false);
  for (const name of ['ai', 'email', 'billing', 'monitoring']) assert.equal(health.services[name], false);
  assert.equal(health.services.transactionalDatabase, 'off');
  assert.equal((await fetch(base + '/api/config').then(r => r.json())).authRequired, true);
  assert.equal((await fetch(base + '/api/projects')).status, 401);
  assert.equal((await fetch(base + '/api/founder-offer').then(r => r.json())).enabled, false);
  response = await fetch(base + '/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ companyName: 'Synthetic acceptance company', ownerName: 'Synthetic tester', email: 'acceptance@example.invalid', password: 'SyntheticAcceptanceOnly!42', legalAccepted: true, plan: 'starter' }) });
  assert.equal(response.status, 201);
  const signup = await response.json();
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const headers = { cookie, 'content-type': 'application/json', 'x-pdl-company': signup.company.id };
  for (const route of ['/api/billing/checkout', '/api/auth/email-verification/resend']) {
    response = await fetch(base + route, { method: 'POST', headers, body: JSON.stringify({ plan: 'starter', billingCycle: 'monthly' }) });
    assert.equal(response.status, route.includes('checkout') ? 503 : 503);
    const body = await response.json(); assert.equal(body.previewToken, undefined); assert.equal(body.url, undefined);
  }
  assert.equal((await fetch(base + '/api/billing/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 503);
  assert.equal((await fetch(base + '/api/platform/overview')).status, 401);
  for (const file of ['/data/db.json', '/data/platform.json', '/scripts/start-acceptance.js']) assert.equal((await fetch(base + file)).status, 404);
  const tenantFile = path.join(directory, 'tenants', signup.company.id + '.json');
  const before = fs.readFileSync(tenantFile, 'utf8');
  await running.stop();
  const fakeTestKey = 'rk_test_NotAnActualCredential';
  running = await boot({ ...env, STRIPE_SECRET_KEY: fakeTestKey });
  assert.equal(fs.readFileSync(tenantFile, 'utf8'), before);
  response = await fetch(base + '/api/auth/me', { headers }); assert.equal(response.status, 200); assert.equal((await response.json()).companyId, signup.company.id);
  response = await fetch(base + '/api/billing/checkout', { method: 'POST', headers, body: JSON.stringify({ plan: 'starter', billingCycle: 'monthly' }) });
  assert.equal(response.status, 503); // Missing signing secret still prevents checkout with a key.
  health = await fetch(base + '/api/health').then(r => r.json()); assert.equal(health.services.billing, false);
  assert.match(running.logs(), /stripe=test-prefix-only/); assert.equal(running.logs().includes(fakeTestKey), false);
});

test('sales-demo initialization and platform setup stay unavailable to anonymous acceptance callers', async t => {
  const directory = temporary('sales-demo-guard'); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const running = await boot({ PDL_ACCEPTANCE_ALLOW_LOOPBACK: '1', PDL_ACCEPTANCE_PUBLIC_URL: base, PDL_ACCEPTANCE_DATA_DIR: directory, PORT: String(port) });
  t.after(async () => running.stop());
  const stateFiles = ['db.json', 'platform.json'].map(name => path.join(directory, name));
  const before = stateFiles.map(file => fs.readFileSync(file, 'utf8'));
  for (const contents of before) {
    const state = JSON.parse(contents);
    assert.deepEqual(state.users, []);
    assert.deepEqual(state.sessions, []);
  }
  for (const method of ['GET', 'POST']) {
    const response = await fetch(`${base}/api/platform/companies/${ROOT_TENANT}/sales-demo`, { method });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'A signed-in platform owner is required' });
  }
  const response = await fetch(base + '/api/platform/auth/bootstrap', { method: 'POST' });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'Platform Owner setup has already been initialized' });
  assert.equal(fs.readFileSync(stateFiles[0], 'utf8'), before[0]);
  // The unchanged app lazily persists its built-in help articles on platform reads.
  // Every other platform field, including users and sessions, must remain untouched.
  const { helpItems: beforeHelp, ...platformBefore } = JSON.parse(before[1]);
  const { helpItems: afterHelp, ...platformAfter } = JSON.parse(fs.readFileSync(stateFiles[1], 'utf8'));
  assert.deepEqual(platformAfter, platformBefore);
});

test('Enterprise fixture defaults off and requires both exact opt-ins', () => {
  assert.equal(validateConfig(hosted).enterprise, false);
  for (const env of [
    { ...hosted, PDL_ACCEPTANCE_ENTERPRISE: ENTERPRISE_OPT_IN },
    { ...hosted, PDL_ACCEPTANCE_PLATFORM_OWNER: OWNER_OPT_IN },
    { ...hosted, PDL_ACCEPTANCE_PLATFORM_PASSWORD: fixturePassword() },
    { ...hosted, PDL_ACCEPTANCE_PLATFORM_PASSWORD: '' },
    { ...enterpriseEnv(), PDL_ACCEPTANCE_ENTERPRISE: '1' },
    { ...enterpriseEnv(), PDL_ACCEPTANCE_PLATFORM_OWNER: '1' },
    { ...enterpriseEnv(), PDL_ACCEPTANCE_ENTERPRISE: '' },
    { ...enterpriseEnv(), PDL_ACCEPTANCE_PLATFORM_OWNER: '' },
    { ...enterpriseEnv(), PDL_ACCEPTANCE_PLATFORM_PASSWORD: 'short' },
    { ...enterpriseEnv(), PDL_ENTERPRISE_CHECKOUT_ENABLED: '1' },
    { ...enterpriseEnv(), PDL_PLATFORM_KEY: 'synthetic-forbidden-master-key' },
  ]) assert.throws(() => validateConfig(env));
  const password = fixturePassword();
  const config = validateConfig({ ...enterpriseEnv(), PDL_ACCEPTANCE_PLATFORM_PASSWORD: password });
  assert.equal(config.enterprise, true); assert.equal(config.passwordProvided, true);
  assert.equal(JSON.stringify(config).includes(password), false);
  assert.equal(Object.hasOwn(config, 'accountVerified'), false);
});

test('Enterprise fixture is bound to the exact Render identity and origin', () => {
  for (const change of [
    { RENDER: '' }, { RENDER: 'false' }, { RENDER_SERVICE_ID: '' },
    { RENDER_SERVICE_ID: 'srv-another-synthetic-service' },
    { RENDER_EXTERNAL_URL: 'https://another-synthetic-service.onrender.com' },
    { RENDER_EXTERNAL_URL: APPROVED_ORIGIN + '/' },
    { RENDER_EXTERNAL_HOSTNAME: 'different.onrender.com' }, { RENDER_SERVICE_TYPE: 'worker' },
    { PDL_ACCEPTANCE_ALLOW_LOOPBACK: '1', PDL_ACCEPTANCE_PUBLIC_URL: 'http://127.0.0.1:4173' },
  ]) assert.throws(() => validateConfig({ ...enterpriseEnv(), ...change }));
  assert.throws(() => validateConfig({ PDL_ACCEPTANCE_ALLOW_LOOPBACK: '1', PDL_ACCEPTANCE_PUBLIC_URL: 'http://127.0.0.1:4173', PDL_ACCEPTANCE_ENTERPRISE: ENTERPRISE_OPT_IN, PDL_ACCEPTANCE_PLATFORM_OWNER: OWNER_OPT_IN }));
  assert.doesNotThrow(() => validateConfig({ ...enterpriseEnv(), RENDER_EXTERNAL_HOSTNAME: new URL(APPROVED_ORIGIN).hostname, RENDER_SERVICE_TYPE: 'web' }));
});

test('provider-looking or reused secrets cannot become the fixture password', () => {
  for (const password of ['sk_test_SyntheticOnly', 'rk_test_SyntheticOnly', 'pk_live_SyntheticOnly', 'whsec_SyntheticOnly', '  rk_test_SyntheticOnly  ']) {
    assert.throws(() => validateConfig({ ...enterpriseEnv(), PDL_ACCEPTANCE_PLATFORM_PASSWORD: password }), error => /must not reuse a provider credential/.test(error.message) && !error.message.includes(password));
  }
  const password = fixturePassword();
  for (const name of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) assert.throws(() => validateConfig({ ...enterpriseEnv(), [name]: password, PDL_ACCEPTANCE_PLATFORM_PASSWORD: password }), /must not reuse a provider credential/);
});

test('initial owner requires a private password and seeds one normal hashed account without a session', t => {
  const empty = storage(t, enterpriseEnv());
  assert.throws(() => prepareStorage(empty), /privately entered password/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(empty.directory, 'platform.json'))).users, []);
  const password = fixturePassword();
  const config = storage(t, { ...enterpriseEnv(), PDL_ACCEPTANCE_PLATFORM_PASSWORD: password });
  const files = prepareStorage(config, password);
  const platform = JSON.parse(fs.readFileSync(files.platformFile));
  assert.equal(platform.users.length, 1); assert.deepEqual(platform.sessions, []);
  const { passwordSalt, passwordHash, ...identity } = platform.users[0];
  assert.deepEqual(identity, OWNER); assert.match(passwordSalt, /^[0-9a-f]{32}$/); assert.match(passwordHash, /^[0-9a-f]{128}$/);
  assert.equal(crypto.scryptSync(password, passwordSalt, 64).toString('hex'), passwordHash);
  assert.notEqual(crypto.scryptSync(password.trim(), passwordSalt, 64).toString('hex'), passwordHash);
  assert.equal(fs.readFileSync(files.platformFile, 'utf8').includes(password), false);
  assert.equal(fs.statSync(files.platformFile).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(files.dbFile)).users, []);
  const second = storage(t, { ...enterpriseEnv(), PDL_ACCEPTANCE_PLATFORM_PASSWORD: password });
  const secondUser = JSON.parse(fs.readFileSync(prepareStorage(second, password).platformFile)).users[0];
  assert.notEqual(secondUser.passwordSalt, passwordSalt);
});

test('matching repeat setup preserves all bytes and unrelated platform data; changed password refuses', t => {
  const password = fixturePassword();
  const config = storage(t, { ...enterpriseEnv(), PDL_ACCEPTANCE_PLATFORM_PASSWORD: password });
  // Initialize adminless state at the same approved origin, then add non-auth data.
  const plainConfig = validateConfig({ RENDER_EXTERNAL_URL: APPROVED_ORIGIN, PDL_ACCEPTANCE_DATA_DIR: config.directory });
  const files = prepareStorage(plainConfig);
  const platform = JSON.parse(fs.readFileSync(files.platformFile));
  platform.notes.push({ id: 'synthetic-note', text: 'Keep this synthetic note' });
  platform.helpItems.push({ id: 'synthetic-help', title: 'Keep this synthetic help' });
  fs.writeFileSync(files.platformFile, JSON.stringify(platform));
  prepareStorage(config, password);
  let saved = JSON.parse(fs.readFileSync(files.platformFile));
  assert.deepEqual(saved.notes, platform.notes); assert.deepEqual(saved.helpItems, platform.helpItems);
  const before = fs.readFileSync(files.platformFile, 'utf8');
  const identityBefore = fs.readFileSync(path.join(config.directory, OWNER_IDENTITY_FILE), 'utf8');
  prepareStorage(config, password);
  assert.equal(fs.readFileSync(files.platformFile, 'utf8'), before);
  const noPassword = validateConfig({ ...enterpriseEnv(), PDL_ACCEPTANCE_DATA_DIR: config.directory });
  prepareStorage(noPassword);
  assert.equal(fs.readFileSync(files.platformFile, 'utf8'), before);
  assert.throws(() => prepareStorage(config, fixturePassword()), /does not match/);
  assert.throws(() => prepareStorage(config, password.trim()), /does not match/);
  assert.throws(() => prepareStorage(plainConfig), /Privileged platform state/);
  assert.equal(fs.readFileSync(files.platformFile, 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(config.directory, OWNER_IDENTITY_FILE), 'utf8'), identityBefore);
});

test('missing, corrupted or incomplete private owner identity evidence refuses without reseeding', t => {
  for (const mode of ['missing', 'corrupt', 'changed', 'orphan']) {
    const password = fixturePassword(), config = storage(t, { ...enterpriseEnv(), PDL_ACCEPTANCE_PLATFORM_PASSWORD: password });
    const files = prepareStorage(config, password), identityFile = path.join(config.directory, OWNER_IDENTITY_FILE);
    if (mode === 'missing') fs.unlinkSync(identityFile);
    if (mode === 'corrupt') fs.writeFileSync(identityFile, 'not JSON');
    if (mode === 'changed') { const identity = JSON.parse(fs.readFileSync(identityFile)); identity.credentialDigest = 'a'.repeat(64); fs.writeFileSync(identityFile, JSON.stringify(identity)); }
    if (mode === 'orphan') { const platform = JSON.parse(fs.readFileSync(files.platformFile)); delete platform.acceptancePlatformOwner; platform.users = []; fs.writeFileSync(files.platformFile, JSON.stringify(platform)); }
    const before = fs.readFileSync(files.platformFile, 'utf8');
    assert.throws(() => prepareStorage(config, password));
    assert.throws(() => prepareStorage(validateConfig({ ...enterpriseEnv(), PDL_ACCEPTANCE_DATA_DIR: config.directory })));
    assert.equal(fs.readFileSync(files.platformFile, 'utf8'), before);
  }
});

test('conflicting identities, users, sessions and password state are never adopted or re-enabled', t => {
  const changes = [
    p => { delete p.acceptancePlatformOwner; },
    p => { p.acceptancePlatformOwner.candidate = 'synthetic-other'; },
    p => { p.users[0].role = 'support'; },
    p => { p.users[0].status = 'Deactivated'; },
    p => { p.users[0].email = 'other@example.invalid'; },
    p => { p.users[0].name = 'Other synthetic name'; },
    p => { p.users[0].id = 2; },
    p => { p.users[0].mustSetPassword = true; },
    p => { p.users[0].setupHash = 'synthetic-forbidden'; },
    p => { p.users[0].resetTokenHash = 'synthetic-forbidden'; },
    p => { p.users[0].passwordHash = 'a'.repeat(128); },
    p => { p.users[0].passwordSalt = 'b'.repeat(32); },
    p => { p.users.push({ ...p.users[0], id: 2 }); },
    p => { p.users = []; },
    p => { p.users = null; },
    p => { p.sessions = null; },
    p => { p.sessions.push({ userId: 2, tokenHash: 'a'.repeat(64) }); },
    p => { p.sessions.push({ userId: 1, token: 'synthetic-plaintext-forbidden' }); },
  ];
  for (const change of changes) {
    const password = fixturePassword();
    const config = storage(t, { ...enterpriseEnv(), PDL_ACCEPTANCE_PLATFORM_PASSWORD: password });
    const files = prepareStorage(config, password), platform = JSON.parse(fs.readFileSync(files.platformFile));
    change(platform); fs.writeFileSync(files.platformFile, JSON.stringify(platform));
    const before = fs.readFileSync(files.platformFile, 'utf8');
    assert.throws(() => prepareStorage(config, password));
    assert.throws(() => prepareStorage(validateConfig({ ...enterpriseEnv(), PDL_ACCEPTANCE_DATA_DIR: config.directory })));
    assert.equal(fs.readFileSync(files.platformFile, 'utf8'), before);
  }
});

test('unmarked users/sessions and a privileged root cannot be silently reused', t => {
  for (const field of ['users', 'sessions']) {
    const config = storage(t, { RENDER_EXTERNAL_URL: APPROVED_ORIGIN });
    const files = prepareStorage(config), platform = JSON.parse(fs.readFileSync(files.platformFile));
    platform[field].push({ id: 77, role: 'platform_owner' });
    fs.writeFileSync(files.platformFile, JSON.stringify(platform));
    const before = fs.readFileSync(files.platformFile, 'utf8');
    assert.throws(() => prepareStorage(config), /Privileged platform state/);
    const password = fixturePassword();
    const enabled = validateConfig({ ...enterpriseEnv(), PDL_ACCEPTANCE_DATA_DIR: config.directory, PDL_ACCEPTANCE_PLATFORM_PASSWORD: password });
    assert.throws(() => prepareStorage(enabled, password), /Refusing to adopt/);
    assert.equal(fs.readFileSync(files.platformFile, 'utf8'), before);
  }
  const config = storage(t), files = prepareStorage(config), db = JSON.parse(fs.readFileSync(files.dbFile));
  db.users.push({ id: 1, role: 'owner' }); fs.writeFileSync(files.dbFile, JSON.stringify(db));
  assert.throws(() => prepareStorage(config), /root must remain/);
});

// Reviewed PR114 has no Enterprise billing module. Replace the obsolete quote
// journey with an actual annual-mode boot; retain all credential/storage guards.
async function bootAnnual(env, base) {
  const source = `
    const assert=require('node:assert/strict'),net=require('node:net');
    const blocked=()=>{throw Error('Outbound network disabled in acceptance tests')};
    global.fetch=blocked;net.Socket.prototype.connect=blocked;
    for(const name of ['node:http','node:https']){const api=require(name);api.request=blocked;api.get=blocked;}
    require('node:tls').connect=blocked;
    const listen=net.Server.prototype.listen;
    net.Server.prototype.listen=function(port,host,callback){assert.equal(host,'0.0.0.0');return listen.call(this,port,'127.0.0.1',callback)};
    const Module=require('node:module'),load=Module._load,serverPath=require('node:path').join(process.cwd(),'server');
    Module._load=function(request,parent,isMain){if(request===serverPath){
      for(const key of ['PDL_ACCEPTANCE_PLATFORM_PASSWORD','PDL_ACCEPTANCE_PLATFORM_OWNER','PDL_ACCEPTANCE_ENTERPRISE'])assert.equal(Object.hasOwn(process.env,key),false);
      assert.equal(process.env.PDL_ENTERPRISE_CHECKOUT_ENABLED,'0');assert.equal(process.env.PDL_REQUIRE_AUTH,'1');
    }return load.call(this,request,parent,isMain)};
    require('./scripts/start-acceptance').start();`;
  const child=spawn(process.execPath,['-e',source],{cwd:ROOT,env,stdio:['ignore','pipe','pipe']});let logs='';
  child.stdout.on('data',chunk=>logs+=chunk);child.stderr.on('data',chunk=>logs+=chunk);
  const stopped=new Promise(resolve=>child.once('exit',resolve));
  const stop=async()=>{if(child.exitCode===null)child.kill('SIGTERM');await stopped;};
  for(let attempt=0;attempt<150;attempt++){
    if(child.exitCode!==null)throw Error('Annual test child exited: '+logs);
    try{if((await fetch(base+'/api/health')).ok)return {stop,logs:()=>logs};}catch{}
    await new Promise(resolve=>setTimeout(resolve,30));
  }await stop();throw Error('Annual child did not become healthy');
}
test('annual isolated boot narrows inherited owner mode, creates no credentials, and preserves paid fixture on restart',async t=>{
  const directory=temporary('annual-http');t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const port=await freePort(),base=`http://127.0.0.1:${port}`,password=fixturePassword();
  const env={...enterpriseEnv(),PDL_ACCEPTANCE_ANNUAL_STARTER:'test-only',PDL_ACCEPTANCE_PLATFORM_PASSWORD:password,PORT:String(port),PDL_ACCEPTANCE_DATA_DIR:directory};
  let running=await bootAnnual(env,base);t.after(async()=>running.stop());
  const platformFile=path.join(directory,'platform.json'),file=path.join(directory,'tenants','synthetic-pr114-starter.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(platformFile)).users,[]);assert.deepEqual(JSON.parse(fs.readFileSync(platformFile)).sessions,[]);
  assert.equal(fs.existsSync(path.join(directory,OWNER_IDENTITY_FILE)),false);
  const db=JSON.parse(fs.readFileSync(file));assert.deepEqual(db.users,[]);assert.deepEqual(db.sessions,[]);assert.equal(db.company.subscriptionStatus,'Incomplete');
  assert.equal(running.logs().includes(password),false);
  const health=await fetch(base+'/api/health');assert.equal(health.headers.get('x-pdl-candidate'),require('./scripts/start-acceptance').CANDIDATE);
  assert.equal((await fetch(base+'/api/platform/overview',{headers:{'x-pdl-company':ROOT_TENANT}})).status,401);
  for(const url of ['/data/platform.json','/scripts/start-acceptance.js','/'+OWNER_IDENTITY_FILE])assert.equal((await fetch(base+url)).status,404);
  db.company.subscriptionStatus='Active';fs.writeFileSync(file,JSON.stringify(db));const before=fs.readFileSync(file,'utf8');
  await running.stop();running=await bootAnnual(env,base);assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(running.logs().includes(password),false);
});

test('fixture refusal never prints the password or stored credential material', t => {
  const password = fixturePassword();
  const config = storage(t, { ...enterpriseEnv(), PDL_ACCEPTANCE_PLATFORM_PASSWORD: password });
  const files = prepareStorage(config, password), user = JSON.parse(fs.readFileSync(files.platformFile)).users[0];
  const different = fixturePassword();
  const env = { ...enterpriseEnv(), PDL_ACCEPTANCE_DATA_DIR: config.directory, PDL_ACCEPTANCE_PLATFORM_PASSWORD: different };
  const result = spawnSync(process.execPath, ['scripts/start-acceptance.js'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /does not match/);
  for (const value of [password, different, user.passwordSalt, user.passwordHash]) assert.equal((result.stdout + result.stderr).includes(value), false);
});
