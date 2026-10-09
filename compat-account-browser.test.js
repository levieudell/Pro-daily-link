'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { A, B, initial, snapshot, memory } = require('./compat-account-fixture');
const { createCredentialDelivery, COLLECTION } = require('./account-credential-delivery');
const { CompatTenantRepository, split } = require('./database/compat-tenant-repository');
const { canonicalHash } = require('./database/transactional-repository');
const { Pool } = require('pg');
const { once } = require('node:events');
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-compat-browser-')), evidence = process.env.PDL_COMPAT_BROWSER_EVIDENCE || path.join(directory, 'evidence'); fs.mkdirSync(evidence, { recursive: true });
  process.env.NODE_ENV = 'test'; process.env.PDL_COMPAT_ACCOUNT_SYNTHETIC = '1'; process.env.PDL_REQUIRE_AUTH = '1'; process.env.PDL_SUPABASE_ENABLED = '0'; process.env.PDL_TRANSACTIONAL_DB = 'off';
  const providerKeys = ['OPENAI_API_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'SENTRY_DSN', 'SUPABASE_SECRET_KEY', 'PDL_PLATFORM_KEY'];
  for (const name of providerKeys) { if (process.env[name]) throw Error('Use a provider-free synthetic browser environment'); process.env[name] = ''; }
  const legacy = snapshot(); legacy.company.id = B; legacy.users[0].companyId = B; legacy.users[0].email = 'global-owner@example.invalid';
  const globalDirectory = path.join(directory, 'global'); fs.mkdirSync(globalDirectory); const globalFile = path.join(globalDirectory, 'db.json'); fs.writeFileSync(globalFile, JSON.stringify(legacy));
  const env = {};
  for (const name of providerKeys) env[name] = ''; // prevent a local .env supplying providers
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HOMEDRIVE', 'HOMEPATH']) if (process.env[name]) env[name] = process.env[name];
  Object.assign(env, { NODE_ENV: 'test', PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_DB_FILE: globalFile, PDL_PLATFORM_FILE: path.join(globalDirectory, 'platform.json') });
  const globalWorker = fork(path.join(__dirname, 'compat-account-browser-worker.cjs'), [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let browser, serverModule, uninstall, repo, admin; const checks = [], externalAttempts = [], blockedPrivate = new Set(), errors = [];
  try {
    const ready = await Promise.race([once(globalWorker, 'message').then(([message]) => message), once(globalWorker, 'error').then(([error]) => { throw error; })]);
    assert.equal(ready.event, 'ready'); const globalOrigin = 'http://localhost:' + ready.port;
    const file = path.join(directory, 'db.json'); fs.writeFileSync(file, JSON.stringify(legacy)); process.env.PDL_DB_FILE = file; process.env.PDL_PLATFORM_FILE = path.join(directory, 'platform.json');
    serverModule = require('./server'); await new Promise(resolve => serverModule.server.listen(0, '127.0.0.1', resolve)); const origin = 'http://127.0.0.1:' + serverModule.server.address().port;
    let store;
    if (process.env.TEST_COMPAT_DATABASE_URL) {
      const url = new URL(process.env.TEST_COMPAT_DATABASE_URL); assert.match(url.pathname, /^\/(?:pdl_compat_|compat_test)/);
      repo = new CompatTenantRepository({ synthetic: true, connectionString: url.href, companyId: A }); store = repo; admin = new Pool({ connectionString: url.href, ssl: false });
    } else store = memory(snapshot());
    const key = crypto.randomBytes(32), messages = [], delivery = createCredentialDelivery({ key, origin, load: id => store.load(id), commit: (...args) => store.commit(...args), send: async message => { messages.push(message); return { accepted: true }; } });
    const resetFixture = async () => {
      if (repo) {
        const db = snapshot(), parts = split(db), records = parts.records.map(row => ({ collection: row.collection, record_key: row.recordKey, position: row.position, data: row.data }));
        await admin.query('INSERT INTO public.companies(id,slug,name) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING', [A, 'synthetic-compat-browser', 'Synthetic Construction']);
        await admin.query('DELETE FROM public.tenant_records WHERE company_id=$1', [A]); await admin.query('DELETE FROM public.tenant_revisions WHERE company_id=$1', [A]);
        await admin.query('SELECT * FROM public.replace_tenant_records($1,0,$2::jsonb,$3,$4::jsonb)', [A, JSON.stringify(parts.scalarData), canonicalHash(db), JSON.stringify(records)]);
      } else { const current = await store.load(A); await store.commit(snapshot(), current.revision); }
      messages.length = 0;
    };
    uninstall = serverModule.installCompatibilityAccountTests({ synthetic: true, companyId: A, origin, globalOrigin, repository: store, credentials: delivery });
    browser = await chromium.launch({ ...(process.env.PDL_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PDL_CHROMIUM_EXECUTABLE } : {}), headless: true, args: ['--disable-background-networking'] });
    for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
      await resetFixture(); const context = await browser.newContext({ viewport });
      await context.route('**/*', route => { const url = new URL(route.request().url()); if ([origin, globalOrigin].includes(url.origin)) return route.continue(); externalAttempts.push(url.origin + url.pathname); return route.abort(); });
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
      page.on('response', response => { if (response.status() === 503 && response.url().startsWith(origin)) blockedPrivate.add(new URL(response.url()).pathname); });
      await page.goto(origin + '/forgot-password.html?tenant=' + A); await page.fill('#email', 'owner@example.invalid'); await page.click('#forgot-form button'); await page.getByText('Check your email.', { exact: true }).waitFor();
      let loaded = await store.load(A); assert.equal(loaded.snapshot[COLLECTION].at(-1).status, 'queued'); assert.equal(messages.length, 0); await delivery.dispatch(A, loaded.snapshot[COLLECTION].at(-1).id); assert.equal(messages.length, 1);
      await page.goto(messages[0].resetUrl); await page.fill('#email', 'owner@example.invalid'); const password = 'Synthetic browser reset ' + name; await page.fill('#password', password); await page.fill('#confirm', password); await page.click('#reset-form button'); await page.getByText('Your password has been changed.', { exact: true }).waitFor();
      await page.screenshot({ path: path.join(evidence, name + '-reset.png'), fullPage: true });
      await page.getByRole('link', { name: 'Continue to sign in' }).click(); await page.fill('#email', 'owner@example.invalid'); await page.fill('#password', password); await page.click('#login button[type=submit]');
      await page.waitForURL(url => url.pathname === '/app'); await page.waitForFunction(() => document.documentElement.classList.contains('workspace-ready'));
      assert.equal(await page.locator('#profile-name').textContent(), 'Synthetic Owner');
      await page.screenshot({ path: path.join(evidence, name + '-ordinary-workspace.png'), fullPage: true }); checks.push({ case: name + ': existing forgot/reset/login/ordinary workspace', passed: true });
      await context.close();
    }
    // Exercise the actual app script with failed/non-true gates in an isolated
    // HTML fixture; boot must not issue any private workspace request.
    for (const outcome of ['false', 'null', 'zero', 'reject']) {
      const context = await browser.newContext(); let stateCalls = 0;
      await context.route('**/*', async route => {
        const url = new URL(route.request().url()); if (![origin, globalOrigin].includes(url.origin)) return route.abort();
        if (url.pathname === '/api/config') return route.fulfill({ json: { authRequired: false } });
        if (url.pathname === '/app') { const response = await route.fetch(), html = await response.text(); return route.fulfill({ response, body: html.replace('</head>', '<script>window.pdlWorkspaceGate=new Promise((resolve,reject)=>{window.compatGateResolve=resolve;window.compatGateReject=reject})</script></head>') }); }
        if (url.pathname === '/api/state') stateCalls++; return route.continue();
      });
      const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(origin + '/app');
      await page.evaluate(value => value === 'reject' ? window.compatGateReject(Error('Synthetic denied gate')) : window.compatGateResolve(value === 'false' ? false : value === 'zero' ? 0 : null), outcome);
      await page.waitForTimeout(120); assert.equal(stateCalls, 0); assert.equal(await page.evaluate(() => document.documentElement.classList.contains('workspace-ready')), false);
      checks.push({ case: 'actual app denies gate ' + outcome, passed: true }); await context.close();
    }
    // A saved-session body held after successful headers cannot navigate over
    // later credential intent. The actual login script waits for its completion.
    await resetFixture();
    {
      const context = await browser.newContext(); await context.route('**/*', route => [origin, globalOrigin].some(base => route.request().url().startsWith(base + '/')) ? route.continue() : route.abort());
      assert.equal((await context.request.post(origin + '/api/auth/login', { headers: { 'X-PDL-Company': A }, data: { email: 'owner@example.invalid', password: initial } })).status(), 200);
      await context.addInitScript(() => { const original = window.fetch; window.fetch = async (...args) => { const response = await original(...args); if (args[0] === '/api/auth/me' && location.pathname === '/login.html') { const read = response.json.bind(response); response.json = async () => { window.compatResumeWaiting = true; await new Promise(resolve => { window.compatResumeRelease = resolve; }); return { ...await read(), companyId: 'ba19a156-1cac-4c8a-b921-6bc356df97ef' }; }; } return response; }; });
      const page = await context.newPage(); let credentialCalls = 0, workspaceNavigations = 0;
      page.on('request', request => { if (new URL(request.url()).pathname === '/api/auth/login') credentialCalls++; if (request.isNavigationRequest() && new URL(request.url()).pathname === '/app') workspaceNavigations++; });
      await page.goto(origin + '/login.html?tenant=' + A); await page.waitForFunction(() => window.compatResumeWaiting === true);
      await page.fill('#email', 'owner@example.invalid'); await page.fill('#password', initial); await page.click('#login button[type=submit]'); await page.waitForTimeout(100);
      assert.equal(credentialCalls, 0); assert.equal(new URL(page.url()).pathname, '/login.html'); await page.evaluate(() => window.compatResumeRelease());
      await page.waitForURL(url => url.pathname === '/app'); await page.waitForFunction(() => document.documentElement.classList.contains('workspace-ready'));
      assert.equal(credentialCalls, 1); assert.equal(workspaceNavigations, 1); assert.equal(new URL(page.url()).searchParams.get('tenant'), A);
      checks.push({ case: 'actual login ignores held stale resume JSON after credential intent', passed: true }); await context.close();
    }
    // The ordinary global legacy signup API and selected-host page link remain.
    const context = await browser.newContext(); await context.route('**/*', route => [origin, globalOrigin].some(base => route.request().url().startsWith(base + '/')) ? route.continue() : route.abort());
    const page = await context.newPage(); await page.goto(origin + '/login.html'); await page.locator('a[href="' + globalOrigin + '/signup.html"]').waitFor(); await page.locator('a[href="' + globalOrigin + '/signup.html"]').click(); assert.equal(new URL(page.url()).origin, globalOrigin);
    // Selected-host cookie must not contaminate the separate global host.
    const selectedLogin = await context.request.post(origin + '/api/auth/login', { headers: { 'X-PDL-Company': A }, data: { email: 'owner@example.invalid', password: initial } }); assert.equal(selectedLogin.status(), 200);
    await page.goto(origin + '/signup.html'); assert.equal(new URL(page.url()).origin, globalOrigin);
    assert.equal((await context.request.get(globalOrigin + '/api/founder-offer')).status(), 200);
    const signup = await context.request.post(globalOrigin + '/api/signup', { data: { companyName: 'Synthetic New Company', ownerName: 'Synthetic New Owner', email: 'new-owner@example.invalid', password: initial, employeeCount: 3, projectCount: 2, plan: 'starter', onboardingPreference: 'self', legalAccepted: true, legalVersion: '2026-09-17' } });
    assert.equal(signup.status(), 201); const enrolled = await signup.json(); assert.notEqual(enrolled.companyId, A); assert.equal(enrolled.company.name, 'Synthetic New Company');
    assert.equal((await context.request.get(globalOrigin + '/api/auth/me')).status(), 200); checks.push({ case: 'existing global founder/signup/new tenant login remains legacy', passed: true }); await context.close();
    assert.deepEqual(errors, []);
    // These are honest inventory stops, not credited workflow preservation.
    const report = { checks, backend: repo ? 'native-postgresql' : 'synthetic-memory', allowedExternalRequests: 0, externalAttempts: [...new Set(externalAttempts)], unintegratedPrivatePaths: [...blockedPrivate].sort(), pageErrors: errors, productionReady: false };
    fs.writeFileSync(path.join(evidence, 'compat-account-browser-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: checks.length, backend: report.backend, unintegratedPrivatePaths: report.unintegratedPrivatePaths, allowedExternalRequests: 0, pageErrors: errors.length }));
  } finally {
    uninstall?.(); if (browser) await browser.close(); if (serverModule) await new Promise(resolve => serverModule.server.close(resolve)); if (repo) await repo.close(); if (admin) await admin.end();
    if (globalWorker.connected) globalWorker.send({ event: 'close' });
    await new Promise(resolve => { if (!globalWorker.pid || globalWorker.exitCode !== null) return resolve(); globalWorker.once('exit', resolve); setTimeout(() => { if (globalWorker.exitCode === null) globalWorker.kill(); }, 3000); });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
