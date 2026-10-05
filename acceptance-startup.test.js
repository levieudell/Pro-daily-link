'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { CANDIDATE, EXPECTED_STRIPE_ACCOUNT, ROOT_TENANT, PRICES, FORCED, validateConfig, prepareStorage } = require('./scripts/start-acceptance');
const ROOT = __dirname;
const hosted = { RENDER_EXTERNAL_URL: 'https://synthetic-acceptance-test.onrender.com' }; // Fixture only, not a deployed URL.
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
