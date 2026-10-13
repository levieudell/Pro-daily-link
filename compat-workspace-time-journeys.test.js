'use strict';
// Existing-page journeys only: synthetic tenant custody, real login, server previews,
// DOM confirmation, repository readback, and actual downloaded bytes.
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

const argument = name => process.argv.find(value => value.startsWith('--' + name + '='))?.split('=')[1];
const group = argument('group') || 'all', viewportName = argument('viewport') || 'desktop';
const groups = ['cards', 'payroll', 'field'];
const viewports = { desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } };
const sourceHead = process.env.PDL_COMPAT_SOURCE_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, encoding: 'utf8' }).trim();
const runId = process.env.PDL_COMPAT_RUN_ID || process.env.GITHUB_RUN_ID || 'local-' + Date.now() + '-' + process.pid;
const evidence = process.env.PDL_COMPAT_BROWSER_EVIDENCE || path.join(os.tmpdir(), 'pdl-time-journeys-' + runId);
fs.mkdirSync(evidence, { recursive: true });

function sourceDigest() {
  const files = execFileSync('git', ['ls-files', '--', '*.js', '*.html', '*.css'], { cwd: __dirname, encoding: 'utf8' }).trim().split(/\r?\n/).filter(file => file && !file.endsWith('.test.js')).sort();
  const digest = crypto.createHash('sha256');
  for (const file of files) { digest.update(file); digest.update(fs.readFileSync(path.join(__dirname, file))); }
  // New implementation files may be untracked in the local engineering worktree.
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', '*.js'], { cwd: __dirname, encoding: 'utf8' }).trim().split(/\r?\n/).filter(file => file && !file.endsWith('.test.js')).sort();
  for (const file of untracked) { digest.update(file); digest.update(fs.readFileSync(path.join(__dirname, file))); }
  return digest.digest('hex');
}

async function main() {
  if (group === 'all') {
    // Separate processes preserve the normal server rate limiter and prevent
    // unrelated groups from sharing browser state, listeners, or native resets.
    for (const selected of groups) for (const viewport of Object.keys(viewports)) {
      execFileSync(process.execPath, [__filename, '--group=' + selected, '--viewport=' + viewport], {
        cwd: __dirname, stdio: 'inherit', windowsHide: true,
        env: { ...process.env, PDL_COMPAT_BROWSER_EVIDENCE: evidence, PDL_COMPAT_SOURCE_SHA: sourceHead, PDL_COMPAT_RUN_ID: runId }
      });
    }
    const results = groups.flatMap(selected => Object.keys(viewports).map(viewport => JSON.parse(fs.readFileSync(path.join(evidence, 'g2-time-' + selected + '-' + viewport + '-results.json')))));
    const coverage = results.flatMap(result => result.coverage);
    assert.equal(new Set(results.map(result => result.sourceDigest)).size, 1, 'All journey groups must use the same unchanged source');
    const expected = ['timeReview.viewCards', 'timeReview.reviewLeave', 'timeReview.approveCards', 'timeReview.unapproveCards', ...require('./time-write-access').actions.map(action => 'timeWrite.' + action), 'timeOff.viewRequests', 'timeOff.createRequest'];
    for (const viewport of Object.keys(viewports)) assert.deepEqual([...new Set(coverage.filter(row => row.viewport === viewport).map(row => row.family + '.' + row.action))].sort(), expected.slice().sort());
    fs.writeFileSync(path.join(evidence, 'g2-time-journeys-results.json'), JSON.stringify({ sourceHead, runId, sourceDigest: results[0].sourceDigest, backend: results[0].backend, passed: coverage.length, coverage, allowedExternalRequests: 0, productionReady: false }, null, 2));
    console.log(JSON.stringify({ timeJourneys: 'all', passed: coverage.length, viewports: Object.keys(viewports), allowedExternalRequests: 0 }));
    return;
  }
  assert.ok(groups.includes(group), 'Use --group=cards, payroll, or field');
  assert.ok(viewports[viewportName], 'Use --viewport=desktop or mobile');
  const prefix = 'g2-time-' + group + '-' + viewportName;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-time-journey-'));
  for (const name of ['OPENAI_API_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'SENTRY_DSN', 'SUPABASE_SECRET_KEY', 'PDL_PLATFORM_KEY']) {
    if (process.env[name]) throw Error('Provider-free browser required');
    process.env[name] = '';
  }
  const legacy = snapshot(); legacy.company.id = B; legacy.users[0].companyId = B;
  const legacyFile = path.join(directory, 'legacy.json'); fs.writeFileSync(legacyFile, JSON.stringify(legacy));
  const originalLegacy = fs.readFileSync(legacyFile);
  Object.assign(process.env, { NODE_ENV: 'test', PDL_COMPAT_ACCOUNT_SYNTHETIC: '1', PDL_REQUIRE_AUTH: '1', PDL_DB_FILE: legacyFile, PDL_PLATFORM_FILE: path.join(directory, 'platform.json'), PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off' });
  const openingSourceDigest = sourceDigest();
  const mod = require('./server');
  await new Promise(resolve => mod.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + mod.server.address().port;
  let browser, context, page, native, uninstall, failure;
  const coverage = [], requests = [], errors = [], external = new Set(), downloads = [];
  const check = (family, action, actor, assertions) => coverage.push({ family, action, viewport: viewportName, actor, entry: 'signed-out login.html', assertions });
  try {
    if (process.env.TEST_COMPAT_DATABASE_URL) native = await nativeFixture();
    const seed = workspaceSnapshot();
    const leaveId = crypto.randomUUID();
    if (group === 'cards') seed.timeOffRequests.push({ id: leaveId, memberId: 12, requestId: crypto.randomUUID(), startDate: '2026-10-20', endDate: '2026-10-20', allDay: true, type: 'vacation', note: 'Synthetic private leave review', status: 'pending', history: [] });
    if (group === 'payroll') seed.timeCards.push({ id: 90, projectId: 101, memberId: 12, date: '2026-10-08', inAt: '2026-10-08T08:00:00.000Z', outAt: '2026-10-08T10:00:00.000Z', hours: 2, status: 'approved', approvedBy: 'Synthetic Owner', approvedAt: '2026-10-08T11:00:00.000Z', breaks: [], history: [] });
    const store = native?.repository || memory(seed);
    if (native) await native.reset(seed);
    const key = crypto.randomBytes(32), fixture = services(store, origin, { key });
    uninstall = mod.installCompatibilityAccountTests({ synthetic: true, companyId: A, origin, globalOrigin: 'http://localhost:4999', repository: store, ...fixture, workspace: true, workspaceKey: key });
    browser = await chromium.launch({ headless: true, args: ['--disable-background-networking'] });
    context = await browser.newContext({ viewport: viewports[viewportName], timezoneId: 'UTC', acceptDownloads: true });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      external.add(url.origin + url.pathname); return route.abort();
    });
    page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      const url = new URL(response.url()); if (!url.pathname.startsWith('/api/')) return;
      const request = response.request(), data = request.postDataJSON();
      requests.push({ path: url.pathname, method: request.method(), status: response.status(), ...(data ? { bodyKeys: Object.keys(data), confirmed: data.confirmed === true } : {}) });
    });
    const read = async () => (await store.load(A)).snapshot;
    const waitStore = async (predicate, description) => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 40)); }
      assert.fail('Repository readback timed out: ' + description);
    };
    const business = db => JSON.stringify({ cards: db.timeCards, leave: db.timeOffRequests, periods: db.payPeriods, exports: db.payPeriodExports });
    async function confirm(trigger, previewPath, method, savePath, expectedStatus = 200) {
      const before = business(await read()), start = requests.length;
      await trigger();
      await page.locator('#workspace-action-review').waitFor({ state: 'visible' });
      assert.ok(requests.slice(start).some(row => row.path === previewPath && row.method === 'POST' && row.status === 200), 'Existing form reached the correct server preview: ' + previewPath);
      assert.equal(business(await read()), before, 'Preview does not commit the business action');
      assert.equal(await page.isChecked('#workspace-action-confirmed'), false);
      await page.click('#workspace-action-save');
      assert.match(await page.locator('#workspace-action-review [role=status]').innerText(), /Check the confirmation box/);
      assert.equal(business(await read()), before, 'Unchecked confirmation does not save');
      const response = page.waitForResponse(row => new URL(row.url()).pathname === savePath && row.request().method() === method);
      await page.check('#workspace-action-confirmed'); await page.click('#workspace-action-save');
      const saved = await response; assert.equal(saved.status(), expectedStatus, savePath + ': ' + await saved.text());
      assert.deepEqual(Object.keys(saved.request().postDataJSON()).sort(), ['confirmed', 'requestId', 'token', 'version']);
      assert.equal(saved.request().postDataJSON().confirmed, true);
      await page.locator('#workspace-action-review').waitFor({ state: 'detached' });
      return saved;
    }
    async function signedOutLogin(email) {
      assert.equal((await context.cookies()).length, 0, 'Context starts signed out');
      await page.goto(origin + '/login.html?tenant=' + A);
      await page.fill('#email', email); await page.fill('#password', initial); await page.click('#login button[type=submit]');
      await page.waitForURL(url => url.pathname === '/app');
      await page.waitForFunction(() => document.documentElement.classList.contains('workspace-ready'));
      await page.waitForFunction(() => document.querySelector('#dashboard-page.active') || document.querySelector('#myday-page.active'));
      await page.screenshot({ path: path.join(evidence, prefix + '-entry.png'), fullPage: true });
    }
    async function nav(selector, active) {
      if (viewportName === 'mobile' && await page.locator('#menu-button').getAttribute('aria-expanded') !== 'true') await page.click('#menu-button');
      await page.click(selector); await page.locator('#' + active + '-page.active').waitFor({ state: 'visible' });
    }
    async function person() {
      await page.locator('#timecard-entry-panel:visible,[data-time-person="12"]:visible').first().waitFor({ state: 'visible' });
      if (await page.locator('[data-time-person="12"]:visible').count()) await page.click('[data-time-person="12"]:visible');
      await page.locator('#timecard-entry-panel').waitFor({ state: 'visible' });
    }
    async function saveDownload(trigger, label) {
      const [download] = await Promise.all([page.waitForEvent('download'), trigger()]);
      const file = path.join(evidence, prefix + '-' + label + '.csv'); await download.saveAs(file);
      const bytes = fs.readFileSync(file); assert.ok(bytes.length > 80, 'Actual CSV bytes downloaded');
      downloads.push({ label, filename: download.suggestedFilename(), bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
      return bytes.toString('utf8');
    }

    await signedOutLogin(group === 'field' ? 'field@example.invalid' : 'owner@example.invalid');
    if (group === 'cards') {
      await nav('.nav-item[data-page="timeoverview"]', 'timeoverview');
      await page.locator('#timeoverview-page [data-time-workspace="approvals"]').first().click();
      await page.locator('#timecards-page.active').waitFor({ state: 'visible' });
      await page.click('#timecard-add'); await page.selectOption('#timecard-add-member', '12'); await page.selectOption('#timecard-add-project', '101');
      await page.fill('#timecard-add-in', '2026-10-09T08:00'); await page.fill('#timecard-add-out', '2026-10-09T10:00'); await page.fill('#timecard-add-reason', 'Synthetic page entry');
      await confirm(() => page.click('#timecard-add-save'), '/api/time-cards/action-preview', 'POST', '/api/time-cards', 201);
      await page.locator('#timecard-add-modal').waitFor({ state: 'hidden' });
      let db = await waitStore(row => row.timeCards.length === 1, 'create'); const id = db.timeCards[0].id;
      assert.equal(db.timeCards[0].status, 'draft'); assert.equal(db.timeCards[0].hours, 2); assert.equal(db.timeCards[0].memberId, 12); assert.equal(db.timeCards[0].projectId, 101);
      check('timeWrite', 'createCards', 'owner', ['Normal add-time form previews without business save', 'unchecked confirmation refuses save', 'saved draft has exact member, project, timestamps and 2 hours']);
      await page.locator('[data-time-person="12"]').waitFor(); await person();
      assert.match(await page.locator('#time-person-name').innerText(), /Synthetic Field/);
      assert.match(await page.locator('#timecard-rows').innerText(), /Synthetic Project/);
      assert.match(await page.locator('#timecard-filter-total strong').innerText(), /^2 hours$/);
      await page.goto(origin + '/app#timecards'); await page.locator('#timecards-page.active').waitFor({ state: 'visible' }); await person();
      await page.reload(); await page.locator('#timecards-page.active').waitFor({ state: 'visible' }); await person();
      assert.equal(await page.locator('.timecard-record').count(), 1);
      check('timeReview', 'viewCards', 'owner', ['Normal Time navigation opens grouped employee readback', 'person details show 2 hours and project', 'deep link and reload preserve the finite card']);
      await confirm(async () => { await page.click('[data-timecard-edit="' + id + '"]'); await page.fill('#timecard-edit-out', '2026-10-09T11:00'); await page.fill('#timecard-edit-reason', 'Synthetic corrected actual out time'); await page.click('#timecard-edit-save'); }, '/api/time-cards/action-preview', 'PATCH', '/api/time-cards/' + id);
      await page.locator('#timecard-edit-modal').waitFor({ state: 'hidden' });
      db = await waitStore(row => row.timeCards[0].hours === 3, 'correction');
      assert.equal(db.timeCards[0].outAt, '2026-10-09T11:00:00.000Z'); assert.equal(db.timeCards[0].status, 'draft');
      assert.deepEqual(db.timeCards[0].original, { inAt: '2026-10-09T08:00:00.000Z', outAt: '2026-10-09T10:00:00.000Z', hours: 2 });
      assert.ok(JSON.stringify(db.timeCards[0].history).includes('Synthetic corrected actual out time'));
      await person(); assert.match(await page.locator('#timecard-filter-total strong').innerText(), /^3 hours$/);
      await page.locator('.timecard-history summary').click(); assert.match(await page.locator('.timecard-history').innerText(), /Synthetic corrected actual out time/);
      check('timeWrite', 'correctCards', 'owner', ['Existing correction form changes out time from 10:00 to 11:00', 'repository and page show 3 hours', 'history retains the correction reason']);
      await confirm(() => page.click('[data-timecard-submit="' + id + '"]'), '/api/time-cards/action-preview', 'POST', '/api/time-cards/' + id + '/submit');
      await waitStore(row => row.timeCards[0].status === 'submitted', 'submission'); await page.locator('[data-timecard-approve="' + id + '"]').waitFor({ state: 'visible' });
      check('timeWrite', 'submitCards', 'owner', ['Existing Submit button previews and confirms', 'submitted status survives repository readback', 'approval control appears for completed time']);
      await confirm(() => page.click('[data-timecard-approve="' + id + '"]'), '/api/time-cards/review-preview', 'POST', '/api/time-cards/' + id + '/approve');
      db = await waitStore(row => row.timeCards[0].status === 'approved', 'approval'); assert.equal(db.timeCards[0].approvedBy, 'Synthetic Owner');
      await page.locator('[data-timecard-unapprove="' + id + '"]').waitFor({ state: 'visible' }); assert.match(await page.locator('#timecard-rows').innerText(), /Approved/);
      assert.equal(await page.locator('.timecard-record [data-label="Approved by"]').textContent(), 'Synthetic Owner');
      check('timeReview', 'approveCards', 'owner', ['Existing approval control uses review-preview', 'saved approved record names the reviewer', 'page shows Approved and finite detail contains reviewer']);
      const csv = await saveDownload(() => page.click('#timecard-export'), 'time-cards');
      assert.match(csv, /Synthetic Field/); assert.match(csv, /Synthetic Project/); assert.match(csv, /Synthetic Owner/); assert.match(csv, /2026-10-09/); assert.match(csv, /approved/i);
      check('timeWrite', 'downloadCards', 'owner', ['Existing CSV export downloads nonempty bytes', 'bytes contain exact employee, project, work date and approved status', 'SHA-256 and byte count saved in evidence']);
      await confirm(() => page.click('[data-timecard-unapprove="' + id + '"]'), '/api/time-cards/review-preview', 'POST', '/api/time-cards/' + id + '/unapprove');
      db = await waitStore(row => row.timeCards[0].status === 'draft', 'unapproval'); assert.equal(db.timeCards[0].approvedBy, null);
      await page.locator('[data-timecard-edit="' + id + '"]').waitFor({ state: 'visible' });
      check('timeReview', 'unapproveCards', 'owner', ['Return to Draft uses review-preview and confirmation', 'repository clears approval and returns draft', 'correction control is available again']);
      await confirm(async () => { await page.click('[data-timecard-delete="' + id + '"]'); await page.fill('#timecard-delete-reason', 'Synthetic duplicate removed'); await page.click('#timecard-delete-confirm'); }, '/api/time-cards/action-preview', 'DELETE', '/api/time-cards/' + id);
      await page.locator('#timecard-delete-modal').waitFor({ state: 'hidden' });
      db = await waitStore(row => row.timeCards.every(card => card.id !== id || card.deletedAt), 'remove');
      const removed = db.timeCards.find(card => card.id === id);
      assert.equal(removed.status, 'deleted'); assert.equal(removed.deleteReason, 'Synthetic duplicate removed'); assert.equal(removed.deletedBy, 'Synthetic Owner');
      assert.ok(removed.history.some(row => row.action === 'Deleted' && row.reason === 'Synthetic duplicate removed'));
      assert.ok(db.auditLog.some(row => row.type === 'time_action_confirmed' && row.action === 'remove'));
      await page.locator('[data-time-person="12"]').waitFor({ state: 'detached' });
      check('timeWrite', 'removeCards', 'owner', ['Delete dialog requires recorded reason and server preview', 'repository tombstone retains actor, reason and deletion history', 'confirmation audit persists and employee summary disappears']);
      await page.locator('#timecards-page [data-time-workspace="timeoff"]').click(); await page.locator('#timeoff-page.active').waitFor({ state: 'visible' });
      assert.match(await page.locator('#time-office-timeoff-list').innerText(), /Synthetic private leave review/);
      await confirm(() => page.click('[data-time-off-approve="' + leaveId + '"]'), '/api/time-off-requests/' + leaveId + '/review-preview', 'POST', '/api/time-off-requests/' + leaveId + '/approve');
      db = await waitStore(row => row.timeOffRequests[0].status === 'approved', 'leave review');
      assert.equal(db.timeOffRequests[0].reviewedBy, 'Synthetic Owner'); await page.waitForFunction(()=>/approved/i.test(document.querySelector('#time-office-timeoff-list')?.innerText||''));assert.match(await page.locator('#time-office-timeoff-list').innerText(), /approved/i);
      await page.reload(); await page.locator('#timeoff-page.active').waitFor({ state: 'visible' });await page.waitForFunction(()=>/approved/i.test(document.querySelector('#time-office-timeoff-list')?.innerText||''));assert.match(await page.locator('#time-office-timeoff-list').innerText(), /approved/i);
      check('timeReview', 'reviewLeave', 'owner', ['Office Time-off page discloses the admitted private request', 'review-preview plus explicit checkbox saves approval', 'repository reviewer and reload retain approved decision']);
    }

    if (group === 'payroll') {
      await page.click('[data-office-tool="payreports"]'); await page.locator('#timecards-page.active').waitFor({ state: 'visible' });
      await page.locator('[data-pay-settings]').waitFor({ state: 'visible' }); await page.click('[data-pay-settings]');
      await page.locator('#company-pay-periods').waitFor({ state: 'visible' }); await page.click('[data-pay-new]');
      await page.fill('#pay-period-label', 'Synthetic October payroll'); await page.fill('#pay-period-from', '2026-10-08'); await page.fill('#pay-period-to', '2026-10-08');
      await confirm(() => page.click('#pay-period-save'), '/api/pay-periods/action-preview', 'POST', '/api/pay-periods', 201);
      await page.locator('#pay-period-dialog').waitFor({ state: 'hidden' });
      let db = await waitStore(row => row.payPeriods.length === 1, 'period creation'); const periodId = db.payPeriods[0].id;
      assert.equal(db.payPeriods[0].from, '2026-10-08'); assert.equal(db.payPeriods[0].to, '2026-10-08'); assert.equal(db.payPeriods[0].timeZone, 'UTC');
      // Existing form remains on Settings after saving; Review time opens its summary.
      await page.locator('[data-pay-use="' + periodId + '"]').waitFor(); await page.click('[data-pay-use="' + periodId + '"]');
      await page.locator('[data-pay-edit]').waitFor({ state: 'visible' });
      await confirm(async () => { await page.click('[data-pay-edit]'); await page.fill('#pay-period-label', 'Synthetic October corrected payroll'); await page.fill('#pay-period-reason', 'Synthetic label correction'); await page.click('#pay-period-save'); }, '/api/pay-periods/action-preview', 'PATCH', '/api/pay-periods/' + periodId);
      await page.locator('#pay-period-dialog').waitFor({ state: 'hidden' });
      db = await waitStore(row => row.payPeriods[0].label === 'Synthetic October corrected payroll', 'period correction'); assert.ok(db.auditLog.some(row => row.type === 'pay_period_updated' && row.detail === 'Synthetic label correction'));
      check('timeWrite', 'configurePeriods', 'owner', ['Existing settings form creates explicit inclusive UTC dates', 'Edit dates form saves corrected label with reason', 'repository keeps period and audit before/after']);
      await page.locator('.pay-review-card').waitFor({ state: 'visible' });
      assert.match(await page.locator('.pay-review-heading').innerText(), /2 company total/); assert.match(await page.locator('.pay-review-status').innerText(), /Ready to export/);
      await page.locator('.pay-period-summary summary').click(); assert.match(await page.locator('.pay-period-summary').innerText(), /Synthetic Field.*2 approved hours/s);
      await page.reload(); await page.locator('#timecards-page.active').waitFor({ state: 'visible' }); await page.selectOption('#pay-period-select', periodId); await page.locator('.pay-review-card').waitFor({ state: 'visible' });
      assert.match(await page.locator('.pay-review-heading').innerText(), /2 company total/);
      check('timeWrite', 'viewPayroll', 'owner', ['Dashboard Pay-period reports opens existing Time page', 'summary and breakdown show exactly 2 approved hours', 'deep-link reload and period selection retain readback']);
      const firstCsv = await saveDownload(() => confirm(() => page.click('[data-pay-capture]'), '/api/pay-periods/action-preview', 'POST', '/api/pay-periods/' + periodId + '/exports', 201), 'fixed-capture');
      db = await waitStore(row => row.payPeriodExports.length === 1, 'export capture'); const record = db.payPeriodExports[0];
      assert.equal(db.payPeriods[0].status, 'closed'); assert.equal(record.companyId, A); assert.equal(record.periodId, periodId); assert.equal(record.version, 1); assert.equal(record.summary.approvedHours, 2); assert.equal(record.summary.records.length, 1); assert.equal(record.summary.records[0].id, 90);
      assert.match(firstCsv, /Synthetic October corrected payroll/); assert.match(firstCsv, /Synthetic Field/); assert.match(firstCsv, /Synthetic Project/);
      check('timeWrite', 'captureExports', 'owner', ['End period & export previews without closing period', 'confirmation creates one frozen company-bound v1 export', 'saved approved summary and automatic downloaded bytes contain exact record']);
      await page.locator('[data-pay-history]').waitFor({ state: 'visible' }); await page.click('[data-pay-history]'); await page.locator('#pay-period-history [data-pay-download]').waitFor({ state: 'visible' });
      const historyCsv = await saveDownload(() => page.click('#pay-period-history [data-pay-download]'), 'fixed-history'); assert.equal(historyCsv, firstCsv);
      const latestCsv = await saveDownload(() => page.click('.pay-export-actions [data-pay-download]'), 'fixed-latest'); assert.equal(latestCsv, firstCsv);
      await page.reload(); await page.locator('#timecards-page.active').waitFor({ state: 'visible' }); await page.selectOption('#pay-period-select', periodId); await page.locator('.pay-export-actions [data-pay-download]').waitFor({ state: 'visible' });
      const reloadCsv = await saveDownload(() => page.click('.pay-export-actions [data-pay-download]'), 'fixed-reload'); assert.equal(reloadCsv, firstCsv); assert.equal((await read()).payPeriodExports.length, 1);
      check('timeWrite', 'downloadExports', 'owner', ['Previous exports renders saved version control', 'history and latest downloads are byte-identical to capture', 'reload downloads same frozen bytes without extra exports']);
    }

    if (group === 'field') {
      await nav('.nav-item[data-page="timecards"]', 'timecards'); await page.click('#company-clock'); await page.locator('#company-clock-modal').waitFor({ state: 'visible' });
      assert.match(await page.locator('#company-clock-activity').innerText(), /Office/); assert.match(await page.locator('#company-clock-activity').innerText(), /Training/);
      assert.ok(requests.some(row => row.path === '/api/company-activities' && row.method === 'GET' && row.status === 200));
      await page.selectOption('#company-clock-activity', 'company-5');
      check('timeWrite', 'viewActivities', 'field', ['Existing company-clock picker requests finite activities', 'visible Office and Training choices', 'normal select chooses Training activity identifier']);
      const beforeClock = Date.now();
      await confirm(() => page.click('#start-company-clock'), '/api/time-cards/action-preview', 'POST', '/api/time-cards/company-clock', 201);
      await page.locator('#company-clock-modal').waitFor({ state: 'hidden' });
      let db = await waitStore(row => row.timeCards.length === 1, 'company clock start'); const id = db.timeCards[0].id;
      assert.equal(db.timeCards[0].memberId, 12); assert.equal(db.timeCards[0].activityName, 'Training'); assert.equal(db.timeCards[0].activityCodeId, 'company-5'); assert.equal(db.timeCards[0].outAt, null); assert.ok(Date.parse(db.timeCards[0].inAt) >= beforeClock);
      await page.locator('[data-end-company-clock="' + id + '"]').waitFor({ state: 'visible' }); assert.match(await page.locator('#company-clock-status').innerText(), /Training/);
      await confirm(() => page.click('[data-end-company-clock="' + id + '"]'), '/api/time-cards/action-preview', 'POST', '/api/time-cards/' + id + '/clock-out');
      db = await waitStore(row => Boolean(row.timeCards[0].outAt), 'company clock end'); assert.ok(Date.parse(db.timeCards[0].outAt) >= Date.parse(db.timeCards[0].inAt)); assert.equal(db.timeCards[0].status, 'draft');
      await page.locator('#company-clock').waitFor({ state: 'visible' });
      await page.reload(); await page.locator('#timecards-page.active').waitFor({ state: 'visible' }); assert.match(await page.locator('#timecard-rows').innerText(), /Training/);
      check('timeWrite', 'clockCards', 'field', ['Training start and end each require independent server preview and checkbox', 'actual confirmation-time punches are member-bound and ended as Draft', 'reload shows ended Training card']);
      await nav('.nav-item[data-page="timeoff"]', 'timeoff'); await page.click('#new-time-off');
      await page.selectOption('#time-off-duration', 'hours'); await page.fill('#time-off-start', '2026-10-21'); await page.fill('#time-off-start-time', '13:00'); await page.fill('#time-off-end-time', '15:00'); await page.selectOption('#time-off-type', 'other'); await page.fill('#time-off-note', 'Synthetic private two-hour request');
      await confirm(() => page.click('#submit-time-off'), '/api/workspace-direct-preview', 'POST', '/api/time-off-requests', 201);
      await page.locator('#time-off-modal').waitFor({ state: 'hidden' });
      db = await waitStore(row => row.timeOffRequests.length === 1, 'field request'); const leave = db.timeOffRequests[0];
      assert.equal(leave.memberId, 12); assert.equal(leave.status, 'pending'); assert.equal(leave.allDay, false); assert.equal(leave.startDate, '2026-10-21'); assert.equal(leave.endDate, '2026-10-21'); assert.equal(leave.startTime, '13:00'); assert.equal(leave.endTime, '15:00'); assert.equal(leave.note, 'Synthetic private two-hour request');
      assert.match(await page.locator('#time-off-list').innerText(), /Synthetic private two-hour request/);
      check('timeOff', 'createRequest', 'field', ['Existing partial-day request form reaches direct server preview', 'unchecked confirmation cannot create leave', 'saved pending request has exact linked member, private note, date and 13:00-15:00 bounds']);
      await page.goto(origin + '/app#timeoff'); await page.locator('#timeoff-page.active').waitFor({ state: 'visible' }); await page.reload(); await page.locator('#timeoff-page.active').waitFor({ state: 'visible' });
      const leaveText = await page.locator('#time-off-list').innerText(); assert.match(leaveText, /pending/i); assert.match(leaveText, /2026-10-21/); assert.match(leaveText, /1:00 PM.*3:00 PM/s); assert.match(leaveText, /Synthetic private two-hour request/); assert.equal(await page.locator('[data-time-off-approve]').count(), 0);
      assert.ok(requests.some(row => row.path === '/api/time-off-requests' && row.method === 'GET' && row.status === 200));
      check('timeOff', 'viewRequests', 'field', ['Normal Time-off navigation requests finite private leave view', 'deep-link reload retains exact pending request and hours', 'field view contains no office review controls']);
    }
    assert.deepEqual(errors, []);
    const loginAt = requests.findIndex(row => row.path === '/api/auth/login' && row.method === 'POST' && row.status === 200);
    assert.ok(loginAt >= 0, 'Actual credential login succeeded');
    assert.deepEqual(requests.filter((row, index) => row.status >= 400 && !(index < loginAt && row.path === '/api/auth/me' && row.status === 401)), []);
    assert.deepEqual(fs.readFileSync(legacyFile), originalLegacy, 'Foreign legacy file is untouched');
    assert.equal(sourceDigest(), openingSourceDigest, 'Source must remain unchanged during a journey');
    await page.screenshot({ path: path.join(evidence, prefix + '-complete.png'), fullPage: true });
    fs.writeFileSync(path.join(evidence, prefix + '-results.json'), JSON.stringify({ sourceHead, runId, sourceDigest: openingSourceDigest, backend: native ? 'native-postgresql' : 'synthetic-memory', group, viewport: viewportName, passed: coverage.length, coverage, requests, downloads, pageErrors: errors, externalAttemptsAborted: [...external], allowedExternalRequests: 0, productionReady: false }, null, 2));
    console.log(JSON.stringify({ timeJourneys: group, viewport: viewportName, passed: coverage.length, requests: requests.length, downloads: downloads.length, backend: native ? 'native-postgresql' : 'synthetic-memory', allowedExternalRequests: 0 }));
  } catch (error) { failure = error; throw error; }
  finally {
    fs.writeFileSync(path.join(evidence, prefix + '-diagnostics.json'), JSON.stringify({ sourceHead, runId, sourceDigest: openingSourceDigest, failure: failure?.stack || null, coverage, errors, requests, downloads, externalAttemptsAborted: [...external], allowedExternalRequests: 0 }, null, 2));
    if (page) {
      await page.screenshot({ path: path.join(evidence, prefix + '-last-page.png'), fullPage: true }).catch(() => {});
      if (failure) console.log(JSON.stringify({ group, viewport: viewportName, url: page.url(), active: await page.locator('.page.active').getAttribute('id').catch(() => null), messages: await page.locator('[role=alert],#toast').allTextContents(), failedRequests: requests.filter(row => row.status >= 400) }));
    }
    await browser?.close(); uninstall?.(); await new Promise(resolve => mod.server.close(resolve)); await native?.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
