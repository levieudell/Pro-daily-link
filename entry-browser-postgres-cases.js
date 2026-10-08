'use strict';
const assert = require('node:assert/strict'), crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path');
const { chromium } = require('playwright'), { companyA, companyB } = require('./fixtures/project-assistant');
const { clean, password } = require('./entry-postgres-cases');
const copy = value => structuredClone(value), barrier = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
module.exports = async ({ repository, change, startWorker, temp, providerEvents }) => {
  const original = copy((await repository.load(companyA)).snapshot), foreign = await repository.load(companyB), providers = providerEvents.length;
  const base = await startWorker({ companyId: companyA }), artifacts = path.resolve(process.env.PDL_ROLES_BROWSER_ARTIFACTS || 'roles-browser-evidence', 'entry'); fs.mkdirSync(artifacts, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.PDL_ROLES_BROWSER_EXECUTABLE ? { executablePath: process.env.PDL_ROLES_BROWSER_EXECUTABLE } : {}), args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  let context, page, requests, errors; const cases = [], external = [], holds = [];
  const reset = () => change(db => { for (const key of Object.keys(db)) delete db[key]; Object.assign(db, clean()); });
  const snapshot = async name => { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: path.join(artifacts, name + '.png') }); };
  async function credentials(user = 2) { await page.locator('#email').fill('user' + user + '@example.invalid'); await page.locator('#password').fill(password); await page.locator('#login button[type=submit]').click(); }
  async function login(user = 2, hash = 'projects') { await page.goto(base + '/login.html#' + hash); await credentials(user); await page.waitForURL('**/workspace.html?tenant=*#' + hash); await page.waitForFunction(() => document.querySelector('#workspace-message')?.textContent === ''); }
  const posts = name => requests.filter(row => row.method === 'POST' && row.path === '/api/auth/' + name);
  async function test(name, run, viewport = { width: 1440, height: 1000 }, origin = base) {
    await reset(); const clientAddress = '198.51.100.' + (80 + cases.length); context = await browser.newContext({ viewport, extraHTTPHeaders: { 'X-Forwarded-For': clientAddress } }); requests = []; errors = [];
    await context.route('**/*', route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
    page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message)); page.on('request', req => requests.push({ path: new URL(req.url()).pathname, method: req.method(), body: req.method() === 'POST' ? req.postData() : null }));
    try { await run(); assert.deepEqual(errors, []); cases.push({ name, viewport, clientAddress, passed: true }); console.log('Entry browser passed: ' + name); }
    catch (error) { cases.push({ name, clientAddress, passed: false, error: error.message }); await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {}); throw error; }
    finally { for (const hold of holds.splice(0)) hold.resolve(); await context.close(); }
  }
  try {
    await test('cookie-free owner login uses actual discovery, one app bootstrap and finite default navigation', async () => {
      const before = await repository.load(companyA); await login(1, 'roles'); await page.locator('#policy-reason').waitFor();
      assert.equal(posts('company').length, 1); assert.equal(posts('login').length, 1); assert.equal(requests.filter(row => row.path === '/api/auth/me').length, 2); assert.equal(requests.filter(row => row.path === '/api/state').length, 0);
      const after = await repository.load(companyA); assert.deepEqual(after.snapshot.users, before.snapshot.users); assert.equal(after.snapshot.sessions.length, 1); assert.ok(!await page.evaluate(() => document.cookie.includes('pdl_session='))); await snapshot('desktop-owner-entry');
    });
    await test('mobile PM login and reload preserve scheduling destination, fresh restrictions and scoped choices', async () => {
      await login(2, 'schedule'); await page.locator('#workflow-refresh').waitFor(); assert.equal(await page.locator('[data-action=scheduleCreate]').count(), 0);
      const me = await context.request.get(base + '/api/auth/me'); const user = await me.json(); assert.equal(user.permissions.scheduleCrews, true); assert.equal(user.schedulingAccess.create, false); assert.deepEqual(user.projectIds, [101]);
      assert.ok(!(await page.locator('#workspace-content').innerText()).includes('Private synthetic site')); await page.reload(); await page.locator('#workflow-refresh').waitFor(); assert.equal(posts('login').length, 1); await snapshot('mobile-schedule-entry');
    }, { width: 360, height: 800 });
    await test('saved-session resume reaches requested finite destination without competing app bootstrap', async () => {
      await login(2); requests = []; await page.goto(base + '/login.html#schedule'); await page.waitForURL('**/workspace.html?tenant=*#schedule'); await page.locator('#workflow-refresh').waitFor(); assert.equal(posts('login').length, 0); assert.equal(requests.filter(row => row.path === '/api/auth/me').length, 1); assert.equal(requests.filter(row => row.path === '/api/state').length, 0);
    });
    await test('held old-session renewal settles before new credentials and cannot restore the old identity', async () => {
      await login(1); const received = barrier(), release = barrier(); holds.push(release); let first = true;
      await page.route('**/api/auth/me', async route => { if (!first) return route.continue(); first = false; const response = await route.fetch(); assert.equal(response.status(), 200); received.resolve(); await release.promise; await route.fulfill({ response }); });
      requests = []; await page.goto(base + '/login.html#schedule'); await received.promise; await credentials(2); assert.equal(await page.locator('#login button[type=submit]').isDisabled(), true); await page.waitForTimeout(150); assert.equal(posts('company').length + posts('login').length, 0); release.resolve();
      await page.waitForURL('**/workspace.html?tenant=*#schedule'); await page.locator('#workflow-refresh').waitFor(); const me = await (await context.request.get(base + '/api/auth/me')).json(); assert.equal(me.id, 2); assert.equal(await page.locator('#actor-label').innerText(), 'Synthetic user 2'); assert.equal(posts('login').length, 1);
      const session = (await context.cookies()).find(row => row.name === 'pdl_session'); const hash = crypto.createHash('sha256').update(session.value).digest('hex'); assert.equal((await repository.load(companyA)).snapshot.sessions.find(row => row.tokenHash === hash).userId, 2);
    });
    await test('foreign app hint cannot substitute the existing cookie tenant or start private bootstrap', async () => {
      await login(2); requests = []; await page.goto(base + '/app?tenant=' + companyB + '#schedule'); await page.waitForURL('**/login.html?tenant=*#schedule'); await credentials(); await page.locator('#message').filter({ hasText: /matching|outside/ }).waitFor(); assert.equal(posts('login').length, 0); assert.equal(requests.filter(row => ['/api/state', '/api/navigation'].includes(row.path)).length, 0); assert.equal(await page.locator('#actor-label').count(), 0);
    });
    await test('direct workspace foreign URL clears identity and never substitutes cookie company', async () => {
      await login(2); await page.goto(base + '/workspace.html?tenant=' + companyB + '#projects'); await page.locator('#workspace-message').filter({ hasText: /matching/ }).waitFor(); assert.equal(await page.locator('#actor-label').innerText(), ''); assert.equal(await page.locator('#workspace-content').innerText(), ''); assert.equal(await page.locator('nav a:visible').count(), 0);
    });
    await test('explicit logout revokes actual session, clears cookies and cannot reopen private app', async () => {
      await login(2); const cookie = (await context.cookies()).find(row => row.name === 'pdl_session'); await page.locator('#workspace-sign-out').click(); await page.waitForURL('**/login.html?tenant=*'); assert.equal((await context.cookies()).some(row => row.name === 'pdl_session'), false); const hash = crypto.createHash('sha256').update(cookie.value).digest('hex'); assert.equal((await repository.load(companyA)).snapshot.sessions.some(row => row.tokenHash === hash), false); await page.goto(base + '/app?tenant=' + companyA + '#schedule'); await page.waitForURL('**/login.html?tenant=*#schedule'); assert.equal(posts('logout').length, 1);
    });
    await test('revoked session reload erases cached identity and idempotent sign-out performs no tenant mutation', async () => {
      await login(2); await change(db => { db.sessions = []; }); await page.reload(); await page.locator('#workspace-content a').filter({ hasText: 'Sign in' }).waitFor(); assert.equal(await page.locator('#actor-label').innerText(), ''); const before = await repository.load(companyA); await page.locator('#workspace-sign-out').click(); await page.waitForURL('**/login.html?tenant=*'); assert.deepEqual(await repository.load(companyA), before);
    });
    await test('locked account signs in to finite recovery and sign-out without redirect loops or private labels', async () => {
      await change(db => { db.company.demo = false; db.company.subscriptionStatus = 'Paused'; }); await page.goto(base + '/login.html'); await credentials(2); await page.waitForURL('**/workspace.html?tenant=*'); await page.locator('#workspace-message').filter({ hasText: /paused/ }).waitFor(); assert.equal(await page.locator('#actor-label').innerText(), ''); assert.equal(await page.locator('nav a:visible').count(), 0); assert.match(await page.locator('#workspace-content').innerText(), /Billing changes are unavailable/); await snapshot('desktop-locked-entry'); await page.locator('#workspace-sign-out').click(); await page.waitForURL('**/login.html?tenant=*');
    });
    await test('unsupported crew eligibility stays denied with a usable sign-out path', async () => {
      await change(db => { db.users[1].role = 'crew'; db.users[1].permissions.aiAssistant = true; }); await page.goto(base + '/login.html'); await credentials(2); await page.waitForURL('**/workspace.html?tenant=*'); await page.locator('#workspace-message').filter({ hasText: /role is unavailable/ }).waitFor(); assert.equal(await page.locator('#actor-label').innerText(), ''); await page.locator('#workspace-sign-out').click(); await page.waitForURL('**/login.html?tenant=*');
    });
    await test('temporary-password account receives truthful unsupported setup without a claim request', async () => {
      await change(db => { const user = db.users[1]; user.mustSetPassword = true; user.setupSalt = user.passwordSalt; user.setupHash = user.passwordHash; user.setupExpiresAt = '2099-01-01T00:00:00Z'; }); await page.goto(base + '/login.html'); await credentials(2); await page.locator('#message').filter({ hasText: /Password setup is unavailable/ }).waitFor(); assert.equal(await page.locator('#setup-modal').evaluate(node => node.open), false); assert.equal(posts('claim').length, 0);
    });
    const legacy = clean(); delete legacy.company.schedulingRolePolicy; legacy.reports = []; legacy.timeCards = []; legacy.assignments = []; const file = path.join(temp, 'entry-legacy', 'db.json'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(legacy)); const old = await startWorker({ legacyFile: file });
    await test('flag-off legacy mode retains actual login, raw bootstrap and ordinary schedule navigation', async () => {
      await page.goto(old + '/login.html'); await credentials(2); await page.waitForURL('**/app?tenant=*#dashboard'); await page.waitForFunction(() => document.documentElement.classList.contains('workspace-ready')); await page.locator('.nav-item[data-page=schedule]').click(); await page.waitForURL('**#schedule'); assert.ok(requests.some(row => row.path === '/api/state')); assert.equal(await page.locator('#forgot-link').count(), 0); await snapshot('desktop-legacy-navigation');
    }, { width: 1440, height: 1000 }, old);
    // The unchanged ordinary /app stylesheet requests this public font. Every
    // external request was aborted; only that exact static URL may be attempted.
    const font = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Oswald:wght@500;600;700&display=swap';
    assert.ok(external.every(url => url === font)); assert.deepEqual(await repository.load(companyB), foreign); assert.equal(providerEvents.length, providers);
  } finally {
    await browser.close(); await change(db => { for (const key of Object.keys(db)) delete db[key]; Object.assign(db, original); }); fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify({ cases, externalRequestsBlocked: external, externalRequestsAllowed: 0, providerEffects: providerEvents.length - providers, syntheticOnly: true }, null, 2));
  }
};
