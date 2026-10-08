'use strict';
// Real private browsers against the disposable PostgreSQL HTTP workers only.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { chromium } = require('playwright');
const { workspace } = require('./fixtures/roles-workspace'), { companyA, companyB, token } = require('./fixtures/project-assistant');
const ROOT = '/api/company/role-policy';
const barrier = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
module.exports = async function ({ repository, change, request, bases, providerEvents }) {
  const base = bases[0], load = () => repository.load(companyA), original = structuredClone((await load()).snapshot), foreign = await repository.load(companyB), providerCount = providerEvents.length;
  const artifacts = path.resolve(process.env.PDL_ROLES_BROWSER_ARTIFACTS || 'roles-browser-evidence'); fs.mkdirSync(artifacts, { recursive: true });
  const clean = workspace(); clean.users.push({ id: 10, companyId: companyA, name: 'Synthetic second owner', email: 'owner10@example.invalid', role: 'owner', status: 'Active' }); clean.sessions.push({ userId: 10, companyId: companyA, tokenHash: crypto.createHash('sha256').update(token(companyA, 10)).digest('hex'), expiresAt: '2099-01-01T00:00:00Z' });
  const reset = async () => change(db => { for (const key of Object.keys(db)) delete db[key]; Object.assign(db, structuredClone(clean)); });
  const browser = await chromium.launch({ headless: true, ...(process.env.PDL_ROLES_BROWSER_EXECUTABLE ? { executablePath: process.env.PDL_ROLES_BROWSER_EXECUTABLE } : {}), args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  const cases = [], holds = []; let page, context, posts, pageErrors, external = [];
  async function cookies(company = companyA, user = 1, session = token(company, user)) {
    await context.addCookies([{ name: 'pdl_session', value: session, url: base, httpOnly: true, sameSite: 'Strict' }, { name: 'pdl_company', value: company, url: base, sameSite: 'Strict' }]);
  }
  async function open(company = companyA) { await page.goto(base + '/workspace.html?tenant=' + company + '#roles'); await page.locator('#policy-reason').waitFor(); }
  async function preview() {
    await page.locator('[data-family="notes"][data-role="field"][data-action="create"]').uncheck();
    await page.locator('#policy-reason').fill('Synthetic browser role review'); await page.locator('#preview-policy').click(); await page.locator('#explicit-confirm').waitFor();
  }
  async function confirmTwice() { await page.locator('#explicit-confirm').check(); await page.evaluate(() => { const button = document.querySelector('#confirm-policy'); button.click(); button.click(); }); }
  async function recoveryReady() { await page.locator('#recover-request').waitFor(); await page.waitForFunction(() => !document.querySelector('#recover-request')?.disabled); }
  async function reopen() { await page.locator('#close-editor').click(); await page.getByRole('heading', { name: 'Projects', exact: true }).waitFor(); await page.locator('[data-route="roles"]').click(); }
  async function test(name, run, viewport = { width: 1440, height: 1000 }) {
    await reset(); context = await browser.newContext({ viewport }); posts = []; pageErrors = [];
    await context.route('**/*', async route => { if (new URL(route.request().url()).origin !== base) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
    page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => pageErrors.push(error.message)); page.on('request', row => { if (row.method() === 'POST' && new URL(row.url()).pathname.startsWith(ROOT)) posts.push({ path: new URL(row.url()).pathname, body: row.postDataJSON() }); });
    try { await cookies(); await run(); assert.deepEqual(pageErrors, []); cases.push({ name, viewport, passed: true }); console.log('Roles browser passed: ' + name); }
    catch (error) { await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {}); cases.push({ name, passed: false, error: error.message }); throw error; }
    finally { for (const hold of holds.splice(0)) hold.resolve(); await context.close(); }
  }
  try {
    await test('desktop: entry point, exact unchanged defaults, protected limits and real impact/save/audit', async () => {
      const before = await load(); await page.goto(base + '/app'); await page.waitForURL('**/workspace.html?tenant=*#roles'); await page.locator('#policy-reason').waitFor();
      // Original auth bootstrap renews only its synthetic session; the editor itself is read-only.
      const opened = await load(), business = value => { value = structuredClone(value); delete value.sessions; return value; }; assert.deepEqual(business(opened.snapshot), business(before.snapshot));
      assert.equal(await page.locator('.matrix input').count(), 128); assert.equal(await page.locator('[data-role="owner"]').count(), 0); assert.equal(await page.locator('[data-family="scheduling"][data-role="field"][data-action="create"]').isDisabled(), true);
      await page.screenshot({ path: path.join(artifacts, 'desktop-matrix.png') }); await preview();
      assert.equal(await page.locator('#confirm-policy').isDisabled(), true); await page.getByRole('heading', { name: 'Review actual access changes' }).scrollIntoViewIfNeeded();
      assert.match(await page.locator('#workspace-content').innerText(), /Notes projects before: Synthetic site A, Private synthetic site/); assert.match(await page.locator('#workspace-content').innerText(), /Notes projects after: Synthetic site A/);
      await page.screenshot({ path: path.join(artifacts, 'desktop-preview.png') }); await confirmTwice(); await page.locator('#save-result').filter({ hasText: 'Permission changes saved' }).waitFor();
      const after = await load(); assert.equal(after.snapshot.rolePolicyReceipts.length, 1); assert.equal(after.snapshot.rolePolicyAudit.length, 2); assert.deepEqual(after.snapshot.users, opened.snapshot.users); assert.deepEqual(after.snapshot.sessions, opened.snapshot.sessions); assert.equal(after.snapshot.company.notesRolePolicy.roles.field.create, false);
      assert.equal(posts.filter(row => row.path.endsWith('/confirm')).length, 1); assert.match(await page.locator('.audit').innerText(), /saved Project notes/); await page.screenshot({ path: path.join(artifacts, 'desktop-saved.png') });
    });
    await test('narrow mobile: readable limits, focus, no horizontal overflow, edit-again refresh and explicit confirmation', async () => {
      await open(); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: path.join(artifacts, 'mobile-matrix.png') });
      await page.locator('.matrix').first().screenshot({ path: path.join(artifacts, 'mobile-matrix-cells.png') });
      const reason = page.locator('#policy-reason'); await reason.focus(); assert.equal(await reason.evaluate(node => node === document.activeElement), true); await preview();
      await page.getByRole('heading', { name: 'Review actual access changes' }).scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(artifacts, 'mobile-preview.png') });
      await page.locator('#edit-proposal').click(); await reason.waitFor(); assert.equal(await reason.inputValue(), 'Synthetic browser role review'); assert.equal(await page.locator('[data-family="notes"][data-role="field"][data-action="create"]').isChecked(), false);
      await page.locator('#preview-policy').click(); await page.locator('#explicit-confirm').waitFor(); assert.equal(posts.filter(row => row.path.endsWith('/preview')).length, 2); assert.equal(posts.filter(row => row.path.endsWith('/confirm')).length, 0);
      await page.locator('#close-editor').click(); await page.getByRole('heading', { name: 'Projects', exact: true }).waitFor(); await page.locator('[data-route="roles"]').click(); await reason.waitFor(); assert.equal(await page.locator('#explicit-confirm').count(), 0); assert.equal(await reason.inputValue(), '');
    }, { width: 360, height: 800 });
    await test('invalid dependencies and client expiry never send a permission save', async () => {
      await page.clock.install({ time: new Date() }); await open(); await page.locator('[data-family="notes"][data-role="field"][data-action="view"]').uncheck(); await page.locator('#policy-reason').fill('Synthetic invalid dependency'); await page.locator('#preview-policy').click(); assert.match(await page.locator('#workspace-message').innerText(), /requires View/); assert.equal(posts.length, 0);
      await page.locator('#reset-defaults').click(); await preview(); await page.locator('#explicit-confirm').check(); await page.clock.fastForward(11 * 60 * 1000); assert.equal(await page.locator('#confirm-policy').isDisabled(), true); assert.match(await page.locator('#expiry-status').innerText(), /expired/); assert.equal(posts.filter(row => row.path.endsWith('/confirm')).length, 0);
    });
    await test('focus clears confirmation and revoked owner authority clears the editor before any save', async () => {
      await open(); await preview(); await page.locator('#explicit-confirm').check(); await page.evaluate(() => dispatchEvent(new Event('blur'))); assert.equal(await page.locator('#explicit-confirm').isChecked(), false);
      await page.locator('#explicit-confirm').check(); await change(db => { db.users[0].role = 'admin'; }); await page.locator('#confirm-policy').click(); await page.waitForFunction(() => !document.querySelector('#explicit-confirm')); assert.equal(posts.filter(row => row.path.endsWith('/confirm')).length, 0); assert.equal(await page.locator('[data-route="roles"]').isHidden(), true); assert.equal(await page.locator('.audit').count(), 0);
    });
    await test('definite save failure shows stale refresh and preserves production-style authority', async () => {
      await open(); await preview(); await page.route('**/api/company/role-policy/confirm', async route => { await change(db => { db.company.syntheticConcurrentChange = true; }); await route.continue(); }); await confirmTwice(); await page.locator('#save-result').filter({ hasText: 'Refresh current permissions' }).waitFor(); assert.equal(await page.locator('#recover-request').count(), 0); assert.equal(await page.locator('#refresh-policy').isDisabled(), false); assert.equal((await load()).snapshot.rolePolicyReceipts, undefined);
      await page.locator('#refresh-policy').click(); await page.locator('#policy-reason').waitFor();
    });
    await test('lost save acknowledgement recovers exact original input once and survives close/reopen', async () => {
      await open(); await preview(); let first = true;
      await page.route('**/api/company/role-policy/confirm', async route => { if (!first) return route.continue(); first = false; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('connectionfailed'); });
      await confirmTwice(); await recoveryReady(); assert.equal((await load()).snapshot.rolePolicyReceipts.length, 1);
      await reopen(); await recoveryReady(); await page.locator('#recover-request').click(); await page.locator('#save-result').filter({ hasText: 'Permission changes saved' }).waitFor();
      const requests = posts.filter(row => row.path.endsWith('/confirm')); assert.equal(requests.length, 2); assert.deepEqual(requests[1].body, requests[0].body); assert.equal((await load()).snapshot.rolePolicyReceipts.length, 1); assert.equal((await load()).snapshot.rolePolicyAudit.length, 2);
    });
    await test('late successful preview is inert after navigation; stale recovery retires the old proof', async () => {
      await open(); const received = barrier(), release = barrier(); holds.push(release); let first = true;
      await page.route('**/api/company/role-policy/preview', async route => { if (!first) return route.continue(); first = false; const response = await route.fetch(); received.resolve(); await release.promise; await route.fulfill({ response }); });
      await page.locator('[data-family="notes"][data-role="field"][data-action="create"]').uncheck(); await page.locator('#policy-reason').fill('Synthetic delayed preview'); await page.locator('#preview-policy').click(); await received.promise; await reopen(); await page.locator('#recover-request').waitFor(); release.resolve(); await page.waitForFunction(() => !document.querySelector('#recover-request').disabled);
      assert.equal(await page.locator('#explicit-confirm').count(), 0); await change(db => { db.company.navigationSyntheticRevision = true; }); await page.locator('#recover-request').click(); await page.locator('#save-result').filter({ hasText: 'Refresh current permissions' }).waitFor(); assert.equal(await page.locator('#recover-request').count(), 0); assert.deepEqual(posts[1].body, posts[0].body); await page.locator('#refresh-policy').click(); await page.locator('#policy-reason').waitFor();
    });
    await test('successful preview followed by session revocation clears all old review and audit details', async () => {
      await open(); await page.route('**/api/company/role-policy/preview', async route => { const response = await route.fetch(); assert.equal(response.status(), 200); await change(db => { db.users[0].status = 'Deactivated'; }); await route.fulfill({ response }); });
      await page.locator('[data-family="notes"][data-role="field"][data-action="create"]').uncheck(); await page.locator('#policy-reason').fill('PRIVATE-OLD-REVIEW-REASON'); await page.locator('#preview-policy').click(); await page.locator('#workspace-message').filter({ hasText: 'Your access changed' }).waitFor();
      assert.equal(await page.locator('#workspace-content').innerText(), ''); assert.equal(await page.locator('#recover-request').count(), 0); assert.equal(posts.filter(row => row.path.endsWith('/confirm')).length, 0);
      await cookies(companyA, 10); await page.evaluate(() => dispatchEvent(new Event('focus'))); await page.locator('#policy-reason').waitFor(); assert.equal(await page.locator('#actor-label').innerText(), 'Synthetic second owner'); assert.equal(await page.locator('#recover-request').count(), 0);
    });
    await test('buffered post-save refresh cannot overwrite a newly selected tenant', async () => {
      await open(); await preview(); const received = barrier(), release = barrier(); holds.push(release); let saved = false, blocked = false;
      await page.route('**/api/company/role-policy/confirm', async route => { const response = await route.fetch(); saved = true; await route.fulfill({ response }); });
      await page.route('**/api/company/role-policy', async route => { if (!saved || blocked) return route.continue(); blocked = true; const response = await route.fetch(); received.resolve(); await release.promise; await route.fulfill({ response }); });
      await confirmTwice(); await received.promise; await cookies(companyB); await reopen(); await page.locator('#policy-reason').waitFor(); assert.match(await page.locator('.saved-version').innerText(), /revision 0/); release.resolve(); await page.waitForTimeout(100); assert.match(await page.locator('.saved-version').innerText(), /revision 0/); assert.ok(!(await page.locator('#workspace-content').innerText()).includes('Synthetic browser role review')); assert.equal(await page.locator('#recover-request').count(), 0);
    });
    await test('unknown result stays bound to the original session and cannot be recovered by a second owner', async () => {
      await open(); await preview(); let first = true; await page.route('**/api/company/role-policy/confirm', async route => { if (!first) return route.continue(); first = false; const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort(); }); await confirmTwice(); await recoveryReady(); const requestId = posts.at(-1).body.requestId;
      await cookies(companyA, 10); await page.evaluate(() => dispatchEvent(new Event('focus'))); await page.locator('#policy-reason').waitFor(); assert.equal(await page.locator('#actor-label').innerText(), 'Synthetic second owner'); assert.equal(await page.locator('#recover-request').count(), 0); assert.equal(posts.filter(row => row.path.endsWith('/confirm')).length, 1);
      await cookies(); await page.evaluate(() => dispatchEvent(new Event('focus'))); await page.locator('#recover-request').waitFor(); await page.locator('#recover-request').click(); await page.locator('#save-result').filter({ hasText: 'Permission changes saved' }).waitFor(); assert.equal(posts.at(-1).body.requestId, requestId); assert.equal((await load()).snapshot.rolePolicyReceipts.length, 1);
    });
    await test('failed read has a working same-route reopen without hidden auto-save', async () => {
      let first = true; await page.route('**/api/company/role-policy', route => { if (!first) return route.continue(); first = false; return route.abort(); }); await page.goto(base + '/workspace.html?tenant=' + companyA + '#roles'); await page.locator('#workspace-message').filter({ hasText: 'Reopen Company settings' }).waitFor(); await page.locator('[data-route="roles"]').click(); await page.locator('#policy-reason').waitFor(); assert.equal(posts.length, 0);
    });
    await test('repeated preview clicks and older reload generations never create or replace a newer review', async () => {
      await open(); await page.locator('[data-family="notes"][data-role="field"][data-action="create"]').uncheck(); await page.locator('#policy-reason').fill('Synthetic repeated preview'); await page.evaluate(() => { const button = document.querySelector('#preview-policy'); button.click(); button.click(); }); await page.locator('#explicit-confirm').waitFor(); assert.equal(posts.length, 1);
      await page.locator('#edit-proposal').click(); await page.locator('#policy-reason').waitFor(); const received = barrier(), release = barrier(); holds.push(release); let first = true;
      await page.route('**/api/company/role-policy', async route => { if (!first) return route.continue(); first = false; const response = await route.fetch(); received.resolve(); await release.promise; await route.fulfill({ response }); });
      await page.locator('#refresh-policy').click(); await received.promise; await page.locator('[data-route="roles"]').click(); await page.locator('#policy-reason').waitFor(); await page.locator('#policy-reason').fill('Newer review draft'); release.resolve(); await page.waitForTimeout(100); assert.equal(await page.locator('#policy-reason').inputValue(), 'Newer review draft'); assert.equal(posts.length, 1);
    });
    await test('known successful cached save becomes historical after a later policy change; recovery can refresh', async () => {
      await open(); await preview(); const received = barrier(), release = barrier(); holds.push(release); let first = true;
      await page.route('**/api/company/role-policy/confirm', async route => { if (!first) return route.continue(); first = false; const response = await route.fetch(); assert.equal(response.status(), 200); received.resolve(); await release.promise; await route.fulfill({ response }); });
      await confirmTwice(); await received.promise; await reopen(); await page.locator('#recover-request').waitFor(); release.resolve(); await recoveryReady();
      const read = await request(base, 'GET', ROOT, undefined, 10), policies = structuredClone(read.data.defaults); for (const [family, policy] of Object.entries(read.data.policies)) if (policy) policies[family] = structuredClone(policy.roles); policies.notes.field.edit = false;
      const next = await request(base, 'POST', ROOT + '/preview', { requestId: crypto.randomUUID(), expectedRevision: read.data.tenantRevision, reason: 'Synthetic later owner policy', policies }, 10); assert.equal(next.status, 200);
      assert.equal((await request(base, 'POST', ROOT + '/confirm', { requestId: crypto.randomUUID(), previewId: next.data.previewId, version: next.data.version, confirmed: true }, 10)).status, 200);
      await page.locator('#recover-request').click(); await page.locator('#save-result').filter({ hasText: 'The original save succeeded at policy revision 1' }).waitFor(); assert.equal(await page.locator('#recover-request').count(), 0); await page.locator('#refresh-policy').click(); await page.locator('#policy-reason').waitFor(); assert.match(await page.locator('.saved-version').innerText(), /revision 2/); assert.equal((await load()).snapshot.rolePolicyReceipts.length, 2);
    });
    await test('known saved result survives a failed read-only refresh without repeating the save', async () => {
      await open(); await preview(); let saved = false, rejected = false;
      await page.route('**/api/company/role-policy/confirm', async route => { const response = await route.fetch(); assert.equal(response.status(), 200); saved = true; await route.fulfill({ response }); });
      await page.route('**/api/company/role-policy', route => { if (!saved || rejected) return route.continue(); rejected = true; return route.abort(); }); await confirmTwice(); await page.locator('#save-result').filter({ hasText: 'Current permissions could not be refreshed' }).waitFor(); assert.equal(await page.locator('#recover-request').count(), 0); await page.locator('#refresh-policy').click(); await page.locator('#policy-reason').waitFor(); assert.equal(posts.filter(row => row.path.endsWith('/confirm')).length, 1); assert.match(await page.locator('.saved-version').innerText(), /revision 1/);
    });
    // The legacy entry page can attempt its existing CDN script; every such request is aborted.
    assert.equal(providerEvents.length, providerCount); assert.deepEqual(await repository.load(companyB), foreign);
  } finally {
    for (const hold of holds) hold.resolve(); await browser.close();
    fs.writeFileSync(path.join(artifacts, 'results.json'), JSON.stringify({ cases, externalRequestsBlocked: external.length, externalRequestsAllowed: 0, pageErrors: pageErrors || [], syntheticOnly: true }, null, 2));
    await change(db => { for (const key of Object.keys(db)) delete db[key]; Object.assign(db, original); });
  }
};
