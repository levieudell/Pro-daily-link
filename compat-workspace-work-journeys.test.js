'use strict';
// Existing product controls, real signed-out login, synthetic local services only.
// Run each group in its own Node process to retain the original request limiter.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { A, B, initial, snapshot, memory } = require('./compat-account-fixture');
const { services } = require('./compat-lifecycle-fixture');
const { nativeFixture } = require('./compat-lifecycle-native-fixture');
const { workspaceSnapshot } = require('./compat-workspace-fixture');

const group = process.argv.find(arg => arg.startsWith('--group='))?.slice(8);
assert.ok(['scheduling', 'notes', 'daily'].includes(group), 'Choose --group=scheduling, --group=notes, or --group=daily');
const viewportFilter = process.argv.find(arg => arg.startsWith('--viewport='))?.slice(11);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-g2-work-journeys-'));
const evidence = process.env.PDL_COMPAT_BROWSER_EVIDENCE || path.join(directory, 'evidence');
fs.mkdirSync(evidence, { recursive: true });
for (const name of ['OPENAI_API_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'SENTRY_DSN', 'SUPABASE_SECRET_KEY', 'PDL_PLATFORM_KEY']) {
  assert.ok(!process.env[name], 'Provider-free browser required: ' + name);
  process.env[name] = '';
}
const legacy = snapshot(); legacy.company.id = B; legacy.users[0].companyId = B;
const legacyFile = path.join(directory, 'legacy.json'); fs.writeFileSync(legacyFile, JSON.stringify(legacy));
Object.assign(process.env, { NODE_ENV: 'test', PDL_COMPAT_ACCOUNT_SYNTHETIC: '1', PDL_REQUIRE_AUTH: '1', PDL_DB_FILE: legacyFile, PDL_PLATFORM_FILE: path.join(directory, 'platform.json'), PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off' });
const mod = require('./server');
const sourceHead = process.env.PDL_COMPAT_SOURCE_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, encoding: 'utf8' }).trim();
const gitDiff = () => execFileSync('git', ['diff', '--', '.'], { cwd: __dirname, maxBuffer: 64 * 1024 * 1024 });
const workingDiffHash = crypto.createHash('sha256').update(gitDiff()).digest('hex');
const testSourceHash = crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex');
const runId = process.env.GITHUB_RUN_ID || 'local-' + new Date().toISOString().replace(/[^0-9]/g, '') + '-' + process.pid;
const actionsByGroup = { scheduling: ['view', 'create', 'edit', 'remove', 'acknowledge'], notes: ['view', 'create', 'edit', 'complete'], daily: ['viewReports', 'createReports', 'editReports', 'approveReports', 'viewWorkdays', 'runWorkdays'] };
const results = [];

async function journey(name, viewport) {
  const requests = [], responseBodies = [], errors = [], external = new Set(), coverage = [], checks = [];
  let browser, context, native, uninstall, page, activeAction = null, failure = null;
  await new Promise(resolve => mod.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + mod.server.address().port;
  try {
    if (process.env.TEST_COMPAT_DATABASE_URL) native = await nativeFixture();
    const db = workspaceSnapshot();
    if (native) await native.reset(db);
    const store = native?.repository || memory(db), key = crypto.randomBytes(32), fixture = services(store, origin, { key });
    uninstall = mod.installCompatibilityAccountTests({ synthetic: true, companyId: A, origin, globalOrigin: 'http://localhost:4999', repository: store, ...fixture, workspace: true, workspaceKey: key });
    browser = await chromium.launch({ headless: true, args: ['--disable-background-networking'] });
    context = await browser.newContext({ viewport });
    context.on('page', current => {
      current.on('pageerror', error => errors.push(error.message));
      current.on('response', response => {
        const url = new URL(response.url());
        if (url.origin === origin && url.pathname.startsWith('/api/')) {
          const row = { action: activeAction, method: response.request().method(), path: url.pathname + url.search, status: response.status() };
          requests.push(row);
          if (response.status() >= 400) {
            if (row.method === 'POST' && /preview$/.test(url.pathname)) row.submittedPreview = response.request().postDataJSON();
            responseBodies.push(response.text().then(body => { row.responseBody = body; }).catch(() => {}));
          }
        }
      });
    });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      external.add(url.origin + url.pathname); return route.abort();
    });
    page = await context.newPage(); page.setDefaultTimeout(12000);
    async function login(email = 'owner@example.invalid') {
      assert.equal((await context.cookies()).filter(cookie => /session/i.test(cookie.name)).length, 0, 'Journey starts signed out');
      await page.goto(origin + '/login.html?tenant=' + A);
      await page.fill('#email', email); await page.fill('#password', initial);
      await page.click('#login button[type=submit]'); await page.waitForURL(url => url.pathname === '/app');
      await page.waitForFunction(() => document.documentElement.classList.contains('workspace-ready'));
      await page.locator('.page.active').waitFor();
      checks.push('Real signed-out login for ' + email);
    }
    async function nav(route) {
      if (name === 'mobile') await page.click('#menu-button');
      await page.locator('.nav-item[data-page="' + route + '"]').click();
      await page.locator('#' + route + '-page.active').waitFor();
    }
    async function action(actionName, actor, work) {
      activeAction = actionName; const start = requests.length;
      const row = { family: group, action: actionName, viewport: name, actor, status: 'running', routes: [] }; coverage.push(row);
      try { await work(); row.uiAndReadbackPassed = true; row.status = 'passed'; }
      catch (error) { row.status = 'failed'; row.error = error.message; throw error; }
      finally {
        row.routes = requests.slice(start); activeAction = null;
        const failedRoutes = row.routes.filter(route => route.status >= 400);
        if (row.status === 'passed' && failedRoutes.length) { row.status = 'failed'; row.error = 'Actual route failed: ' + failedRoutes.map(route => route.method + ' ' + route.path + ' ' + route.status).join(', '); }
      }
    }
    async function reviewedSave(selector, method, routePath, previewPath = '/api/workspace-direct-preview') {
      const start = requests.length;
      await page.click(selector);
      await page.locator('#workspace-action-review').waitFor();
      assert.equal(await page.isChecked('#workspace-action-confirmed'), false);
      assert.ok(requests.slice(start).some(row => row.method === 'POST' && row.path === previewPath && row.status === 200), 'Actual server preview succeeds');
      assert.equal(requests.slice(start).some(row => row.method === method && row.path === routePath), false, 'No save before product confirmation');
      await page.click('#workspace-action-save');
      assert.match(await page.locator('#workspace-action-review [role=status]').innerText(), /Check the confirmation box/);
      const saved = page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname + new URL(response.url()).search === routePath);
      await page.check('#workspace-action-confirmed'); await page.click('#workspace-action-save');
      const response = await saved;
      assert.ok(response.status() >= 200 && response.status() < 300, method + ' ' + routePath + ': ' + response.status() + ' ' + await response.text());
      await page.locator('#workspace-action-review').waitFor({ state: 'detached' });
      checks.push('Unchecked product confirmation blocks ' + method + ' ' + routePath);
    }
    async function screenshot(label) { await page.screenshot({ path: path.join(evidence, 'g2-work-' + group + '-' + name + '-' + label + '.png'), fullPage: true }); }
    async function logoutAndLoginField() {
      if (name === 'mobile') await page.click('#menu-button');
      await page.locator('#profile-button').click();
      await page.locator('#profile-logout-button').click();
      await page.waitForURL(url => url.pathname === '/login.html');
      await login('field@example.invalid');
    }
    async function selectAssignment(id) {
      const selector = name === 'mobile' ? '.schedule-agenda-assignment[data-assignment="' + id + '"]' : '.schedule-grid [data-assignment="' + id + '"]';
      await page.locator(selector).first().click(); await page.locator('#assignment-detail-modal').waitFor();
    }
    async function openNotes() {
      await page.locator('[data-open-project="101"]').click();
      await page.locator('#project-detail-modal').waitFor();
      await page.locator('[data-project-detail-tab="notes"]').click();
      await page.locator('[data-note-new="todo"]:enabled').waitFor();
    }
    async function closeReportSent() {
      await page.locator('#report-modal').waitFor({ state: 'hidden' });
      await page.locator('#report-sent-modal').waitFor(); await page.locator('#report-sent-modal button').click();
    }
    await login();
    if (group === 'scheduling') {
      await action('view', 'owner', async () => {
        await nav('schedule'); await selectAssignment(1);
        assert.match(await page.locator('#scheduled-work-detail').innerText(), /Synthetic tile/);
        await screenshot('detail'); await page.locator('#assignment-detail-modal .close-button').click();
        await page.reload(); await page.locator('#schedule-page.active').waitFor(); await selectAssignment(1);
        await page.locator('#assignment-detail-modal .close-button').click();
        checks.push('Existing assignment detail and schedule deep-link reload');
      });
      let createdId;
      await action('create', 'owner', async () => {
        await page.click('#new-assignment'); await page.selectOption('#assignment-type', 'individual');
        await page.selectOption('#assignment-target', '12'); await page.selectOption('#assignment-project', '101');
        await page.fill('#assignment-start', '17:00'); await page.fill('#assignment-end', '19:00');
        await page.fill('#assignment-activity', 'Synthetic evening tile');
        await reviewedSave('#save-assignment', 'POST', '/api/assignments');
        await page.locator('#assignment-modal').waitFor({ state: 'hidden' });
        const loaded = await store.load(A), created = loaded.snapshot.assignments.find(row => row.activity === 'Synthetic evening tile');
        assert.ok(created); assert.deepEqual(created.memberIds, [12]); assert.equal(loaded.snapshot.assignments.length, 2); createdId = created.id;
        await selectAssignment(createdId); assert.match(await page.locator('#scheduled-work-detail').innerText(), /Synthetic evening tile/);
        await page.locator('#assignment-detail-modal .close-button').click();
      });
      try { await action('edit', 'owner', async () => {
        await selectAssignment(createdId); await page.click('#edit-assignment');
        await page.fill('#assignment-activity', 'Synthetic corrected evening tile'); await page.fill('#assignment-end', '19:30');
        await reviewedSave('#save-assignment', 'PATCH', '/api/assignments/' + createdId);
        await page.locator('#assignment-modal').waitFor({ state: 'hidden' });
        const edited = (await store.load(A)).snapshot.assignments.find(row => row.id === createdId);
        assert.equal(edited.activity, 'Synthetic corrected evening tile'); assert.equal(edited.end, '19:30');
        await page.reload(); await page.locator('#schedule-page.active').waitFor(); await selectAssignment(createdId);
        assert.match(await page.locator('#scheduled-work-detail').innerText(), /Synthetic corrected evening tile/); await screenshot('edited');
        await page.locator('#assignment-detail-modal .close-button').click();
      }); } catch (error) {
        // A rejected edit leaves the created record available for independent
        // remove/acknowledge coverage. Preserve the failed edit in the matrix.
        failure = { message: error.message, stack: error.stack };
        if (await page.locator('#assignment-modal .close-button').isVisible()) await page.locator('#assignment-modal .close-button').click();
      }
      await action('remove', 'owner', async () => {
        await selectAssignment(createdId); await reviewedSave('#remove-assignment', 'DELETE', '/api/assignments/' + createdId);
        await page.locator('#assignment-detail-modal').waitFor({ state: 'hidden' });
        assert.equal((await store.load(A)).snapshot.assignments.some(row => row.id === createdId), false);
        await page.reload(); await page.locator('#schedule-page.active').waitFor();
        assert.equal(await page.locator('[data-assignment="' + createdId + '"]').count(), 0);
      });
      await logoutAndLoginField();
      await action('acknowledge', 'field', async () => {
        await page.locator('#myday-page.active').waitFor();
        await reviewedSave('[data-ack-assignment="1"]', 'POST', '/api/assignments/1/acknowledge');
        await page.locator('#field-today .assignment-confirmed').waitFor();
        assert.ok((await store.load(A)).snapshot.assignments.find(row => row.id === 1).acknowledgements[12]);
        await page.reload(); await page.locator('#myday-page.active').waitFor();
        assert.equal(await page.locator('[data-ack-assignment="1"]').count(), 0); await screenshot('acknowledged');
      });
    } else if (group === 'notes') {
      await action('view', 'owner', async () => {
        await nav('projects'); await openNotes();
        assert.match(await page.locator('[data-notes-list]').innerText(), /No open to-dos/);
        assert.ok(requests.some(row => row.method === 'GET' && row.path === '/api/projects/101/plans' && row.status === 200));
        assert.ok(requests.some(row => row.method === 'GET' && row.path === '/api/projects/101/notes-todos' && row.status === 200)); await screenshot('empty');
      });
      let todoId;
      await action('create', 'owner', async () => {
        await page.click('[data-note-new="todo"]'); await page.fill('[data-notes-text]', 'Synthetic follow-up tile');
        await reviewedSave('[data-notes-save]', 'POST', '/api/projects/101/notes-todos');
        await page.locator('[data-notes-editor]').waitFor({ state: 'hidden' });
        const created = (await store.load(A)).snapshot.projectNotesTodos.find(row => row.kind === 'todo');
        assert.equal(created.text, 'Synthetic follow-up tile'); assert.equal(created.revision, 1); todoId = created.id;
        await page.locator('[data-note-card="' + todoId + '"]').waitFor();
        await page.click('[data-note-new="note"]'); await page.fill('[data-notes-text]', 'Synthetic site note');
        await reviewedSave('[data-notes-save]', 'POST', '/api/projects/101/notes-todos');
        await page.locator('[data-notes-editor]').waitFor({ state: 'hidden' });
        assert.equal((await store.load(A)).snapshot.projectNotesTodos.length, 2);
      });
      await action('edit', 'owner', async () => {
        await page.click('[data-note-edit="' + todoId + '"]'); await page.fill('[data-notes-text]', 'Synthetic corrected follow-up tile');
        await reviewedSave('[data-notes-save]', 'PATCH', '/api/projects/101/notes-todos/' + todoId);
        await page.locator('[data-notes-editor]').waitFor({ state: 'hidden' });
        const edited = (await store.load(A)).snapshot.projectNotesTodos.find(row => row.id === todoId);
        assert.equal(edited.text, 'Synthetic corrected follow-up tile'); assert.equal(edited.revision, 2); assert.equal(edited.history.length, 2);
        await page.locator('[data-note-card="' + todoId + '"] summary').click();
        assert.match(await page.locator('[data-note-card="' + todoId + '"] .project-note-history').innerText(), /Synthetic follow-up tile/); await screenshot('history');
      });
      await action('complete', 'owner', async () => {
        await reviewedSave('[data-note-toggle="' + todoId + '"]', 'PATCH', '/api/projects/101/notes-todos/' + todoId);
        await page.locator('.project-completed-todos [data-note-card="' + todoId + '"]').waitFor();
        const completed = (await store.load(A)).snapshot.projectNotesTodos.find(row => row.id === todoId);
        assert.equal(completed.completed, true); assert.equal(completed.revision, 3); assert.equal(completed.history.length, 3);
        await page.locator('#project-detail-modal .close-button').click();
        await page.reload(); await page.locator('#projects-page.active').waitFor(); await openNotes();
        await page.locator('.project-completed-todos > summary').click();
        assert.match(await page.locator('.project-completed-todos').innerText(), /Synthetic corrected follow-up tile/); await screenshot('completed');
      });
    } else {
      await action('viewReports', 'owner', async () => {
        await nav('reports'); await page.locator('[data-report="1"]').click();
        assert.match(await page.locator('#report-detail').innerText(), /Synthetic completed tile/); await screenshot('report-detail');
        await page.reload(); await page.locator('#reports-page.active').waitFor();
      });
      await action('editReports', 'owner', async () => {
        await page.click('[data-edit-report="1"]'); await page.locator('#report-modal').waitFor();
        await page.fill('#report-summary', 'Synthetic corrected completed tile');
        await reviewedSave('#save-report', 'PATCH', '/api/reports/1', '/api/daily-actions/preview'); await closeReportSent();
        const edited = (await store.load(A)).snapshot.reports.find(row => row.id === 1);
        assert.equal(edited.status, 'Needs review'); assert.equal(edited.summary, 'Synthetic corrected completed tile');
      });
      await action('approveReports', 'owner', async () => {
        await reviewedSave('[data-approve-report="1"]', 'PATCH', '/api/reports/1/approve', '/api/daily-actions/preview');
        await page.waitForFunction(() => document.querySelector('#report-detail .status')?.textContent === 'Approved');
        assert.equal((await store.load(A)).snapshot.reports.find(row => row.id === 1).status, 'Approved'); await screenshot('approved');
      });
      await action('createReports', 'owner', async () => {
        await page.locator('#reports-page [data-open-report]').click(); await page.locator('#report-modal').waitFor();
        await page.selectOption('#report-type', 'production'); await page.selectOption('#report-crew', 'Synthetic Crew');
        await page.click('#enter-weather-manually'); await page.fill('#manual-weather-condition', 'Synthetic manual clear');
        await page.fill('#manual-weather-temperature', '70'); await page.click('#save-manual-weather');
        await page.fill('#field-notes', 'Installed 5 SF Synthetic wall tile.');
        const analyzed = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/ai/extract');
        await page.click('#ai-convert'); const response = await analyzed;
        assert.equal(response.status(), 200, await response.text());
        await page.locator('[data-report-step="2"].active').waitFor();
        while (await page.locator('.production-entry').count()) await page.locator('.production-remove').last().click();
        await page.click('#add-production-row'); await page.selectOption('.production-item', '1');
        await page.fill('.production-quantity', '5'); await page.fill('.production-hours', '1');
        await page.fill('[data-labor-member="12"]', '1');
        await page.fill('#report-summary', 'Synthetic new completed tile report'); await page.fill('#report-signature', 'Synthetic Owner');
        await reviewedSave('#save-report', 'POST', '/api/reports', '/api/daily-actions/preview'); await closeReportSent();
        const created = (await store.load(A)).snapshot.reports.find(row => row.summary === 'Synthetic new completed tile report');
        assert.ok(created); assert.equal(created.status, 'Needs review'); assert.equal(created.signature, 'Synthetic Owner');
        assert.equal(created.weather, 'Synthetic manual clear'); assert.equal(created.temperature, '70');
        assert.equal(created.productionEntries[0].quantity, 5); assert.equal(created.productionEntries[0].laborHours, 1); assert.equal(created.laborEntries[0].hours, 1);
        await page.reload(); await page.locator('#reports-page.active').waitFor(); await page.click('[data-report="' + created.id + '"]');
        assert.match(await page.locator('#report-detail').innerText(), /Synthetic new completed tile report/);
      });
      await logoutAndLoginField();
      await action('viewWorkdays', 'field', async () => {
        await nav('fieldday'); assert.match(await page.locator('#active-day-list').innerText(), /NO ACTIVE WORKDAY/);
        await page.reload(); await page.locator('#fieldday-page.active').waitFor(); await screenshot('workdays');
      });
      await action('runWorkdays', 'field', async () => {
        await page.click('#start-day-button'); await page.selectOption('#start-day-project', '101');
        for (const input of await page.locator('#start-day-members input').all()) await input.setChecked((await input.getAttribute('value')) === '12');
        await page.fill('#start-day-note', 'Synthetic starting tile work');
        await reviewedSave('#confirm-start-day', 'POST', '/api/workdays/start', '/api/daily-actions/preview');
        await page.locator('#start-day-modal').waitFor({ state: 'hidden' });
        const started = (await store.load(A)).snapshot.workdays.find(row => row.status === 'active'); assert.ok(started); assert.deepEqual(started.memberIds, [12]);
        await page.locator('[data-end-workday="' + started.id + '"]').waitFor(); await screenshot('workday-active');
        await page.reload(); await page.locator('#fieldday-page.active').waitFor(); await page.click('[data-end-workday="' + started.id + '"]');
        await page.fill('#end-day-notes', 'Synthetic crew checked tile and prepared tomorrow\'s work.'); await page.fill('#end-day-next', 'Synthetic continue tile');
        await reviewedSave('#confirm-end-day', 'POST', '/api/workdays/' + started.id + '/end', '/api/daily-actions/preview');
        await page.locator('#end-day-modal').waitFor({ state: 'hidden' }); await page.locator('#report-modal').waitFor();
        await page.locator('[data-report-step="2"].active').waitFor();
        const ended = (await store.load(A)).snapshot.workdays.find(row => row.id === started.id);
        assert.equal(ended.status, 'complete'); assert.ok(ended.endedAt);
        assert.ok((await store.load(A)).snapshot.reports.some(row => row.workdayId === started.id));
        assert.ok(requests.some(row => row.action === 'runWorkdays' && row.path === '/api/ai/extract' && row.status === 200));
        await screenshot('workday-ended-report');
      });
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(requests.filter(row => row.status >= 400 && !(row.path === '/api/auth/me' && row.status === 401 && row.action === null)), [], 'Every necessary actual route succeeds');
  } catch (error) { failure ||= { message: error.message, stack: error.stack }; }
  finally {
    // Diagnostic body retrieval must not keep a completed browser journey alive.
    await Promise.race([Promise.allSettled(responseBodies), new Promise(resolve => setTimeout(resolve, 1000))]);
    for (const actionName of actionsByGroup[group]) if (!coverage.some(row => row.action === actionName)) coverage.push({ family: group, action: actionName, viewport: name, status: 'not-run', routes: [], reason: failure?.message || 'Journey ended before action' });
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(evidence, 'g2-work-' + group + '-' + name + '-last.png'), fullPage: true }).catch(() => {});
      checks.push({ finalUrl: page.url(), activePage: await page.locator('.page.active').getAttribute('id').catch(() => null), toast: await page.locator('#toast').innerText().catch(() => ''), formMessages: await page.locator('[role=alert]').allTextContents().catch(() => []) });
    }
    const result = { group, viewport: name, backend: native ? 'native-postgresql' : 'synthetic-memory', status: failure ? 'failed' : 'passed', coverage, checks, failure, requests, pageErrors: errors, externalAttemptsAborted: [...external], allowedExternalRequests: 0, productionReady: false, sourceHead, workingDiffHash, testSourceHash, runId };
    results.push(result); fs.writeFileSync(path.join(evidence, 'g2-work-' + group + '-' + name + '-results.json'), JSON.stringify(result, null, 2));
    uninstall?.(); await context?.close(); await browser?.close(); await new Promise(resolve => mod.server.close(resolve)); await native?.close();
  }
  if (failure) console.error(JSON.stringify({ group, viewport: name, failure: failure.message, failedRoutes: requests.filter(row => row.status >= 400) }));
  else console.log(JSON.stringify({ group, viewport: name, passedActions: coverage.length, requests: requests.length }));
}

async function main() {
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) if (!viewportFilter || viewportFilter === name) await journey(name, viewport);
  const endingWorkingDiffHash = crypto.createHash('sha256').update(gitDiff()).digest('hex');
  fs.writeFileSync(path.join(evidence, 'g2-work-' + group + '-coverage.json'), JSON.stringify({ group, sourceHead, workingDiffHash, endingWorkingDiffHash, testSourceHash, runId, productionReady: false, allowedExternalRequests: 0, results }, null, 2));
  assert.ok(results.length && results.every(result => result.status === 'passed'), group + ' existing-page journeys failed; inspect evidence');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
