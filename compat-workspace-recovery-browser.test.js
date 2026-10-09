'use strict';
// Ordinary product controls and real credential login. Each group/viewport runs
// in a fresh process, preserving the production request limiter. No providers.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const argument = name => process.argv.find(value => value.startsWith('--' + name + '='))?.slice(name.length + 3);
const group = argument('group') || 'all', viewportName = argument('viewport') || 'desktop';
const groups = ['schedule', 'notes', 'leave', 'retire-role', 'retire-policy', 'retire-session', 'daily-draft', 'marker-retirement', 'detail-supersession'];
const viewports = { desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } };
const runId = process.env.PDL_COMPAT_RUN_ID || process.env.GITHUB_RUN_ID || 'local-' + Date.now() + '-' + process.pid;
const evidence = process.env.PDL_COMPAT_BROWSER_EVIDENCE || path.join(os.tmpdir(), 'pdl-g2-recovery-' + runId);
fs.mkdirSync(evidence, { recursive: true });
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
async function bounded(promise, label) { let timer; try { return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(Error('Timed out waiting for ' + label)), 20000); })]); } finally { clearTimeout(timer); } }
const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, encoding: 'utf8' }).trim();
const sourceHead = process.env.PDL_COMPAT_SOURCE_SHA || head();
function sourceDigest() {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: __dirname, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim().split(/\r?\n/)
    .filter(file => file && !file.endsWith('.test.js') && (/\.(?:js|cjs|html|css|sql|yml)$/.test(file) || /^package(?:-lock)?\.json$/.test(file))).sort();
  const digest = crypto.createHash('sha256'); for (const file of files) { digest.update(file); digest.update(fs.readFileSync(path.join(__dirname, file))); } return digest.digest('hex');
}
function artifacts(prefix) {
  return fs.readdirSync(evidence).filter(name => name.startsWith(prefix) && /\.(?:png|csv)$/.test(name)).sort().map(name => {
    const bytes = fs.readFileSync(path.join(evidence, name)); return { name, bytes: bytes.length, sha256: sha256(bytes) };
  });
}
async function main() {
  if (group === 'all') {
    const results = [];
    for (const nextGroup of groups) for (const nextViewport of Object.keys(viewports)) {
      const child = spawnSync(process.execPath, [__filename, '--group=' + nextGroup, '--viewport=' + nextViewport], {
        cwd: __dirname, stdio: 'inherit', env: { ...process.env, PDL_COMPAT_RUN_ID: runId, PDL_COMPAT_BROWSER_EVIDENCE: evidence }
      });
      assert.equal(child.status, 0, nextGroup + '/' + nextViewport + ' recovery journey failed');
      results.push(JSON.parse(fs.readFileSync(path.join(evidence, 'g2-recovery-' + nextGroup + '-' + nextViewport + '-results.json'), 'utf8')));
    }
    if (process.env.CI || process.env.PDL_COMPAT_SOURCE_SHA) assert.ok(results.every(result => result.sourceStable && result.openingSourceDigest === results[0].openingSourceDigest), 'Exact CI journeys require one immutable source tree');
    assert.ok(results.every(result => result.testSourceHash === sha256(fs.readFileSync(__filename))), 'The same test source runs every finite cell');
    fs.writeFileSync(path.join(evidence, 'g2-recovery-browser-results.json'), JSON.stringify({ sourceHead, runId, testSourceHash: sha256(fs.readFileSync(__filename)), backend: results[0].backend, passed: results.reduce((sum, result) => sum + result.checks.length, 0), apiOutcomes: results.reduce((sum, result) => sum + result.requests.length, 0), journeys: results.map(result => ({ group: result.group, viewport: result.viewport, checks: result.checks, openingSourceDigest: result.openingSourceDigest, closingSourceDigest: result.closingSourceDigest, sourceStable: result.sourceStable, requests: result.requests.length, artifacts: result.artifacts })), pageErrors: [], allowedExternalRequests: 0, productionReady: false }, null, 2));
    console.log(JSON.stringify({ recoveryJourneys: results.length, passed: results.reduce((sum, result) => sum + result.checks.length, 0), allowedExternalRequests: 0 })); return;
  }
  assert.ok(groups.includes(group), 'Unknown finite recovery group'); assert.ok(viewports[viewportName], 'Unknown viewport');
  if (process.env.PDL_COMPAT_SOURCE_SHA) assert.equal(head(), sourceHead, 'Evidence source SHA is the actual checkout');
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const { A, B, initial, snapshot, memory } = require('./compat-account-fixture');
  const { services } = require('./compat-lifecycle-fixture');
  const { nativeFixture } = require('./compat-lifecycle-native-fixture');
  const { workspaceSnapshot } = require('./compat-workspace-fixture');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-g2-recovery-browser-'));
  const prefix = 'g2-recovery-' + group + '-' + viewportName, openingSourceDigest = sourceDigest();
  for (const name of ['OPENAI_API_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'SENTRY_DSN', 'SUPABASE_SECRET_KEY', 'PDL_PLATFORM_KEY']) { assert.ok(!process.env[name], 'Provider-free browser required: ' + name); process.env[name] = ''; }
  const legacy = snapshot(); legacy.company.id = B; legacy.users[0].companyId = B;
  const legacyFile = path.join(directory, 'legacy.json'); fs.writeFileSync(legacyFile, JSON.stringify(legacy)); const originalLegacy = fs.readFileSync(legacyFile);
  Object.assign(process.env, { NODE_ENV: 'test', PDL_COMPAT_ACCOUNT_SYNTHETIC: '1', PDL_REQUIRE_AUTH: '1', PDL_DB_FILE: legacyFile, PDL_PLATFORM_FILE: path.join(directory, 'platform.json'), PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off' });
  const mod = require('./server'); await new Promise(resolve => mod.server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + mod.server.address().port;
  let browser, context, page, native, uninstall, failure, store;
  const checks = [], requests = [], pageErrors = [], external = new Set(), downloads = [], pendingRoutes = [];
  const held = [];
  try {
    if (process.env.TEST_COMPAT_DATABASE_URL) native = await nativeFixture();
    const db = workspaceSnapshot();
    if (group.startsWith('retire-') || group === 'detail-supersession') {
      db.users[1].role = 'admin'; db.users[1].permissions = { scheduleCrews: true, viewTime: true, manageTime: true, viewDailies: true, approveDailies: true };
      db.timeCards.push({ id: 1, companyId: A, memberId: 12, projectId: 101, date: '2026-10-09', inAt: '2026-10-09T08:00:00Z', outAt: '2026-10-09T10:00:00Z', hours: 2, status: 'draft', reportId: null, workdayId: null, history: [] });
      db.projectNotesTodos.push(require('./project-notes').createProjectNoteRecord({ companyId: A, projectId: 101, user: db.users[0], requestId: 'synthetic-retirement-detail', kind: 'note', text: 'Synthetic buffered private detail must never render' }));
    }
    if (native) await native.reset(db); store = native?.repository || memory(db);
    const key = crypto.randomBytes(32), fixture = services(store, origin, { key });
    uninstall = mod.installCompatibilityAccountTests({ synthetic: true, companyId: A, origin, globalOrigin: 'http://localhost:4999', repository: store, ...fixture, workspace: true, workspaceKey: key });
    browser = await chromium.launch({ headless: true, args: ['--disable-background-networking'] });
    async function freshContext() {
      context = await browser.newContext({ viewport: viewports[viewportName], timezoneId: 'UTC', acceptDownloads: true });
      await context.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin) return route.continue(); external.add(url.origin + url.pathname); return route.abort(); });
      page = await context.newPage(); page.setDefaultTimeout(15000);
      page.on('pageerror', error => pageErrors.push(error.message)); page.on('download', download => downloads.push({ filename: download.suggestedFilename() }));
      page.on('response', response => { const url = new URL(response.url()); if (url.origin === origin && url.pathname.startsWith('/api/')) requests.push({ method: response.request().method(), path: url.pathname + url.search, status: response.status() }); });
    }
    await freshContext();
    const read = async () => (await store.load(A)).snapshot;
    const business = db => sha256(JSON.stringify({ assignments: db.assignments, projectNotesTodos: db.projectNotesTodos, timeOffRequests: db.timeOffRequests, reports: db.reports, timeCards: db.timeCards, workdays: db.workdays }));
    async function alter(change) { const loaded = await store.load(A); change(loaded.snapshot); await store.commit(loaded.snapshot, loaded.revision); }
    async function login(email = 'owner@example.invalid', first = true) {
      if (first) assert.equal((await context.cookies()).filter(cookie => /session/i.test(cookie.name)).length, 0, 'Journey begins signed out');
      await page.goto(origin + '/login.html?tenant=' + A); await page.fill('#email', email); await page.fill('#password', initial); await page.click('#login button[type=submit]');
      await page.waitForURL(url => url.pathname === '/app'); await page.waitForFunction(() => document.documentElement.classList.contains('workspace-ready')); await page.locator('.page.active').waitFor();
    }
    async function nav(name) { if (viewportName === 'mobile' && await page.locator('#menu-button').getAttribute('aria-expanded') !== 'true') await page.click('#menu-button'); await page.locator('.nav-item[data-page="' + name + '"]').click(); await page.locator('#' + name + '-page.active').waitFor(); }
    async function screenshot(label) { await page.screenshot({ path: path.join(evidence, prefix + '-' + label + '.png'), fullPage: true }); }
    async function confirm(trigger, savePath, previewPath = '/api/workspace-direct-preview', method = 'POST') {
      const before = business(await read()), start = requests.length; await trigger(); await page.locator('#workspace-action-review').waitFor();
      assert.ok(requests.slice(start).some(row => row.method === 'POST' && row.path === previewPath && row.status === 200), 'Actual server preview succeeds');
      assert.equal(await page.isChecked('#workspace-action-confirmed'), false); assert.equal(business(await read()), before, 'Preview cannot save business data');
      await page.click('#workspace-action-save'); assert.match(await page.locator('#workspace-action-review [role=status]').innerText(), /Check the confirmation box/);
      assert.equal(requests.slice(start).some(row => row.method === method && row.path === savePath), false, 'Unchecked confirmation sends no mutation');
      await page.check('#workspace-action-confirmed'); await page.click('#workspace-action-save'); await page.locator('#workspace-action-review').waitFor({ state: 'detached' });
    }
    async function openNotes() { await nav('projects'); await page.locator('[data-open-project="101"]').click(); await page.locator('#project-detail-modal').waitFor(); await page.locator('[data-project-detail-tab="notes"]').click(); await page.locator('[data-note-new="note"]:enabled').waitFor(); }
    async function assignmentForm() { await nav('schedule'); await page.click('#new-assignment'); await page.selectOption('#assignment-type', 'individual'); await page.selectOption('#assignment-target', '12'); await page.selectOption('#assignment-project', '101'); await page.fill('#assignment-start', '17:00'); await page.fill('#assignment-end', '19:00'); await page.fill('#assignment-activity', 'Synthetic recovered scheduling save'); }
    async function lostSave(savePath, trigger) {
      let firstBody, firstResult, mutations = 0;
      const interception = async route => {
        if (route.request().method() !== 'POST') return route.continue(); mutations++; firstBody = route.request().postDataJSON();
        const response = await route.fetch(); assert.equal(response.status(), 201); firstResult = await response.json(); await route.abort();
      };
      await context.route(origin + savePath, interception);
      await confirm(trigger, savePath); await page.locator('#workspace-original-save').waitFor();
      await page.waitForFunction(() => /save result is unknown.*original save result/i.test(document.body.textContent));
      assert.equal(mutations, 1); assert.ok(firstBody && firstResult, 'Authorized save committed before its response was lost');
      const originalBusiness = business(await read()), requestId = firstBody.requestId;
      assert.deepEqual(Object.keys(firstBody).sort(), ['confirmed', 'requestId', 'token', 'version']); assert.equal(firstBody.confirmed, true);
      await screenshot('unknown-result'); await context.unroute(origin + savePath, interception);
      const originalRequests = [];
      page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === savePath) originalRequests.push(request.postDataJSON()); });
      await page.reload(); await page.waitForFunction(() => document.documentElement.classList.contains('workspace-ready')); await page.locator('#workspace-original-save button').first().waitFor();
      await page.waitForTimeout(200); assert.equal(originalRequests.length, 0, 'Reload never automatically resends an unknown save'); assert.equal(business(await read()), originalBusiness);
      const replay = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === savePath);
      await page.locator('#workspace-original-save button').first().click(); const response = await replay;
      assert.equal(response.status(), 201); const result = await response.json(); assert.equal(result.originalSaveResult, true);
      assert.deepEqual(originalRequests, [firstBody], 'Explicit recovery uses exactly the originating proof and request ID');
      const ids = value => (value.assignments || [value]).map(row => row.id);
      assert.ok(ids(firstResult).length && ids(firstResult).every(id => typeof id === 'string' || Number.isSafeInteger(id)), 'Original result contains genuine saved record identities');
      assert.deepEqual(ids(result), ids(firstResult)); assert.equal(business(await read()), originalBusiness, 'Original-result recovery cannot duplicate or modify the saved business record');
      assert.equal(await page.evaluate(() => sessionStorage.getItem('pdl-workspace-original-save-v1')), null); await page.locator('#workspace-original-save').waitFor({ state: 'detached' });
      checks.push({ check: 'lost-response recovery', savePath, requestIdHash: sha256(requestId), originalResultHash: sha256(JSON.stringify(firstResult)), replayResultHash: sha256(JSON.stringify(result)), originalBusinessHash: originalBusiness, assertions: ['unchecked server preview cannot save', 'one initial save commits before lost acknowledgement', 'reload sends zero save requests', 'explicit recovery uses exact original envelope', 'original saved ID and business bytes retained', 'result marker clears only after acknowledged original result'] });
      await screenshot('original-recovered'); return { firstResult, resultId: ids(firstResult)[0], originalBusiness };
    }
    await login(group === 'leave' || group.startsWith('retire-') ? 'field@example.invalid' : 'owner@example.invalid');
    if (group === 'schedule') {
      await assignmentForm(); const recovered = await lostSave('/api/assignments', () => page.click('#save-assignment'));
      assert.equal((await read()).assignments.length, 2); assert.equal((await read()).assignments.find(row => row.id === recovered.resultId).activity, 'Synthetic recovered scheduling save');
      await page.goto(origin + '/app#schedule'); await page.locator('#schedule-page.active').waitFor(); assert.ok(await page.locator('[data-assignment="' + recovered.resultId + '"]').count());
    } else if (group === 'notes') {
      await openNotes(); await page.click('[data-note-new="note"]'); await page.fill('[data-notes-text]', 'Synthetic recovered private site note');
      const recovered = await lostSave('/api/projects/101/notes-todos', () => page.click('[data-notes-save]'));
      assert.equal((await read()).projectNotesTodos.length, 1); await openNotes(); assert.match(await page.locator('[data-notes-list]').innerText(), /Synthetic recovered private site note/); assert.ok(recovered.firstResult.id);
    } else if (group === 'leave') {
      await nav('timeoff'); await page.click('#new-time-off'); await page.selectOption('#time-off-duration', 'hours'); await page.fill('#time-off-start', '2026-10-21'); await page.fill('#time-off-start-time', '13:00'); await page.fill('#time-off-end-time', '15:00'); await page.selectOption('#time-off-type', 'other'); await page.fill('#time-off-note', 'Synthetic recovered private own leave');
      const recovered = await lostSave('/api/time-off-requests', () => page.click('#submit-time-off'));
      const rows = (await read()).timeOffRequests; assert.equal(rows.length, 1); assert.equal(rows[0].id, recovered.firstResult.id); assert.equal(rows[0].memberId, 12); assert.equal(rows[0].note, 'Synthetic recovered private own leave');
      await page.goto(origin + '/app#timeoff'); await page.locator('#timeoff-page.active').waitFor(); assert.match(await page.locator('#time-off-list').innerText(), /Synthetic recovered private own leave/);
    } else if (group.startsWith('retire-')) {
      // Separate fresh contexts keep the private detail open while held, and
      // trigger the CSV through its unobstructed ordinary product control.
      function holdResponse(routePath) {
        let signal, release; const ready = new Promise(resolve => signal = resolve), gate = new Promise(resolve => release = resolve); held.push(release);
        const handler = async route => { try { const response = await route.fetch(); const body = await response.body(); if (routePath.includes('.csv')) fs.writeFileSync(path.join(evidence, prefix + '-buffered-authorized.csv'), body); signal({ status: response.status(), bytes: body.length, sha256: sha256(body), text: body.toString('utf8') }); await gate; await route.fulfill({ response, body }).catch(() => {}); } catch (error) { signal({ error: error.message }); await route.abort().catch(() => {}); } };
        pendingRoutes.push(context.route(origin + routePath, handler)); return { ready, release };
      }
      const revoke = () => alter(current => {
        if (group === 'retire-role') current.users[1].role = 'field';
        if (group === 'retire-policy') {
          const notes = require('./notes-access'), time = require('./time-write-access');
          current.company.notesRolePolicy = { version: 1, revision: 1, roles: Object.fromEntries(notes.roles.map(role => [role, role === 'admin' ? Object.fromEntries(notes.actions.map(action => [action, false])) : notes.ceiling(role)])) };
          current.company.timeWriteRolePolicy = { version: 1, revision: 1, roles: Object.fromEntries(time.roles.map(role => [role, { ...time.ceiling(role), ...(role === 'admin' ? { downloadCards: false } : {}) }])) };
        }
        if (group === 'retire-session') { const sessions = current.sessions.filter(session => session.userId === 2); assert.equal(sessions.length, 1); sessions[0].expiresAt = new Date(Date.now() - 1000).toISOString(); }
      });
      async function assertRetired(originalBusiness) {
        await page.locator('#workspace-refresh-access').waitFor(); await page.waitForTimeout(250);
        assert.equal(downloads.length, 0, 'Revocation suppresses the actual buffered CSV download'); assert.equal(business(await read()), originalBusiness, 'Read retirement never changes business data');
        const retired = await page.evaluate(() => ({ projects: projects.length, team: team.length, reports: reports.length, assignments: assignments.length, timeCards: timeCards.length, timeOffRequests: timeOffRequests.length, currentUser, selectedScheduledWork, dialogs: document.querySelectorAll('dialog[open]').length, privateText: document.querySelector('main')?.textContent.includes('Synthetic buffered private detail'), projectText: document.querySelector('main')?.textContent.includes('Synthetic Project') }));
        assert.deepEqual(retired, { projects: 0, team: 0, reports: 0, assignments: 0, timeCards: 0, timeOffRequests: 0, currentUser: null, selectedScheduledWork: null, dialogs: 0, privateText: false, projectText: false });
      }
      const note = holdResponse('/api/projects/101/notes-todos'); await Promise.all(pendingRoutes.splice(0)); await nav('projects'); await page.locator('[data-open-project="101"]').click(); await page.locator('#project-detail-modal').waitFor(); await page.locator('[data-project-detail-tab="notes"]').click();
      const privateBytes = await bounded(note.ready, 'authorized private detail'); assert.equal(privateBytes.status, 200, privateBytes.error); assert.match(privateBytes.text, /Synthetic buffered private detail must never render/); assert.equal(await page.locator('[data-notes-list]').innerText().then(text => text.includes('Synthetic buffered private detail')), false);
      let originalBusiness = business(await read()); await revoke(); note.release(); await assertRetired(originalBusiness); await screenshot('detail-retired');
      await context.close(); if (native) await native.reset(structuredClone(db)); else { const loaded = await store.load(A); await store.commit(structuredClone(db), loaded.revision); } await freshContext(); await login('field@example.invalid');
      await nav('timeoverview'); await page.locator('#timeoverview-page [data-time-workspace="approvals"]').first().click(); await page.locator('#timecards-page.active').waitFor(); await page.locator('#timecard-export').waitFor({ state: 'visible' });
      const csv = holdResponse('/api/time-cards.csv**'); await Promise.all(pendingRoutes.splice(0)); await page.click('#timecard-export'); const csvBytes = await bounded(csv.ready, 'authorized buffered CSV'); assert.equal(csvBytes.status, 200, csvBytes.error); assert.match(csvBytes.text, /Synthetic Field/); assert.match(csvBytes.text, /Synthetic Project/);
      originalBusiness = business(await read()); await revoke(); csv.release(); await assertRetired(originalBusiness);
      checks.push({ check: group + ' private detail', bufferedDetail: { bytes: privateBytes.bytes, sha256: privateBytes.sha256 }, assertions: ['ordinary project detail requested authorized private bytes before revocation', 'detail stays open until revocation', 'response-time current authority checked', 'private detail never renders', 'cached arrays, dialogs, selection and DOM retire', 'business bytes unchanged'] });
      checks.push({ check: group + ' CSV', bufferedCsv: { bytes: csvBytes.bytes, sha256: csvBytes.sha256 }, assertions: ['ordinary export requested authentic CSV before revocation', 'response-time current authority checked', 'zero CSV downloads after revocation', 'cached arrays, dialogs, selection and DOM retire', 'business bytes unchanged'] }); await screenshot('csv-retired');
    } else if (group === 'daily-draft') {
      await nav('reports'); await page.locator('#reports-page [data-open-report]').click(); await page.locator('#report-modal').waitFor(); await page.selectOption('#report-type', 'production'); await page.selectOption('#report-crew', 'Synthetic Crew');
      await page.fill('#field-notes', 'Synthetic saved Draft: tile quantities still need site confirmation.');
      const firstSave = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/reports');
      await confirm(() => page.click('#save-report-draft'), '/api/reports', '/api/daily-actions/preview'); const response = await firstSave; assert.equal(response.status(), 201, await response.text()); await page.locator('#report-modal').waitFor({ state: 'hidden' });
      const draft = (await read()).reports.find(row => row.status === 'Draft'); assert.ok(draft); assert.equal(draft.notes, 'Synthetic saved Draft: tile quantities still need site confirmation.'); const id = draft.id;
      await page.reload(); await page.locator('#reports-page.active').waitFor(); await page.locator('[data-report="' + id + '"]').click(); await page.locator('[data-edit-report="' + id + '"]').click(); await page.locator('#report-modal').waitFor();
      assert.equal(await page.inputValue('#field-notes'), draft.notes); assert.equal(await page.inputValue('#report-date'), draft.dateIso); assert.equal(await page.inputValue('#report-project'), '0');
      await page.click('#report-back'); await page.locator('[data-report-step="1"].active').waitFor(); await page.fill('#field-notes', 'Synthetic reopened Draft: original site work retained and revised.');
      const edited = page.waitForResponse(result => result.request().method() === 'PATCH' && new URL(result.url()).pathname === '/api/reports/' + id);
      await confirm(() => page.click('#save-report-draft'), '/api/reports/' + id, '/api/daily-actions/preview', 'PATCH'); assert.equal((await edited).status(), 200); await page.locator('#report-modal').waitFor({ state: 'hidden' });
      const current = (await read()).reports.find(row => row.id === id); assert.equal(current.status, 'Draft'); assert.equal(current.notes, 'Synthetic reopened Draft: original site work retained and revised.'); assert.equal((await read()).reports.length, 2);
      checks.push({ check: 'ordinary saved Draft reopen', reportId: id, assertions: ['Draft save uses server preview and unchecked confirmation refuses', 'reload exposes the same Draft', 'existing edit control restores exact notes, project and work date', 'second explicit preview edits the same Draft without duplication'] }); await screenshot('draft-reopened');
    } else if (group === 'marker-retirement') {
      await assignmentForm(); let firstEnvelope, firstResult, initialSaves = 0;
      const interception = async route => { if (route.request().method() !== 'POST') return route.continue(); initialSaves++; firstEnvelope = route.request().postDataJSON(); const response = await route.fetch(); assert.equal(response.status(), 201); firstResult = await response.json(); await route.abort(); };
      await context.route(origin + '/api/assignments', interception); await confirm(() => page.click('#save-assignment'), '/api/assignments'); await page.locator('#workspace-original-save').waitFor(); await page.waitForFunction(() => /save result is unknown/i.test(document.body.textContent)); assert.equal(initialSaves, 1); await context.unroute(origin + '/api/assignments', interception);
      const originalBusiness = business(await read()); let laterSaves = 0; page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/assignments') laterSaves++; });
      // End only this synthetic session and sign in normally in the same tab.
      await alter(current => { const session = current.sessions.find(row => row.userId === 1); assert.ok(session); session.expiresAt = new Date(Date.now() - 1000).toISOString(); }); await login('owner@example.invalid', false);
      await nav('schedule'); assert.ok(await page.locator('[data-assignment="' + firstResult.assignments[0].id + '"]').count(), 'Current authorized records include the original committed assignment'); await page.locator('#workspace-original-save > button').click(); await page.locator('#workspace-original-save [data-reconcile]').waitFor();
      assert.equal(laterSaves, 0, 'Changed session cannot resend or inherit the old proof'); assert.match(await page.locator('#workspace-original-save [role=status]').innerText(), /original outcome remains unknown/i);
      await page.locator('#workspace-original-save [data-reconcile] button').click(); assert.match(await page.locator('#workspace-original-save [role=status]').innerText(), /acknowledge the unknown outcome first/i); assert.ok(await page.evaluate(() => sessionStorage.getItem('pdl-workspace-original-save-v1')));
      await page.locator('#workspace-original-save [data-reconcile] input').check(); await page.locator('#workspace-original-save [data-reconcile] button').click(); await page.locator('#workspace-original-save').waitFor({ state: 'detached' });
      const retired = await page.evaluate(() => JSON.parse(sessionStorage.getItem('pdl-workspace-original-save-v1-retired'))); assert.equal(retired.length, 1); assert.equal(retired[0].result, 'unknown'); assert.equal(retired[0].requestId, firstEnvelope.requestId); assert.equal(laterSaves, 0); assert.equal(business(await read()), originalBusiness); assert.equal((await read()).workspaceDirectReceipts.length, 1);
      checks.push({ check: 'explicit unknown browser marker retirement', assertions: ['normal new session loads current assignment', 'old proof cannot be transferred or automatically resent', 'unchecked unknown-outcome retirement refuses', 'explicit current-revision review retires only browser marker', 'unknown history retained', 'server receipt and saved business record retained', 'zero recovery/new save requests'] }); await screenshot('unknown-marker-retired');
    } else if (group === 'detail-supersession') {
      let signal, release; const ready = new Promise(resolve => signal = resolve), gate = new Promise(resolve => release = resolve); held.push(release);
      const routePath = origin + '/api/projects/101/notes-todos';
      const intercept = async route => { try { const response = await route.fetch(); const bytes = await response.body(); signal({ status: response.status(), bytes: bytes.length, sha256: sha256(bytes), text: bytes.toString('utf8') }); await gate; await route.fulfill({ response, body: bytes }).catch(() => {}); } catch (error) { signal({ error: error.message }); await route.abort().catch(() => {}); } };
      await context.route(routePath, intercept); await nav('projects'); await page.locator('[data-open-project="101"]').click(); await page.locator('#project-detail-modal').waitFor(); await page.locator('[data-project-detail-tab="notes"]').click(); const old = await bounded(ready, 'initial authorized detail'); assert.equal(old.status, 200, old.error); assert.match(old.text, /Synthetic buffered private detail/);
      await page.locator('#project-detail-modal .close-button').click(); await context.unroute(routePath, intercept);
      await alter(current => { const row = current.projectNotesTodos[0], before = { text: row.text, completed: row.completed, revision: row.revision }; row.text = 'Synthetic current note after a superseded detail load'; row.revision++; row.updatedAt = new Date().toISOString(); row.history.push({ action: 'Edited', by: row.updatedBy, userId: row.updatedByUserId, at: row.updatedAt, before, after: { text: row.text, completed: row.completed, revision: row.revision } }); });
      const currentBusiness = business(await read()); await openNotes(); await page.locator('[data-notes-list]').getByText('Synthetic current note after a superseded detail load', { exact: true }).waitFor();
      release(); await page.waitForTimeout(250); assert.match(await page.locator('[data-notes-list]').innerText(), /Synthetic current note after a superseded detail load/); assert.equal(await page.locator('[data-notes-list] .project-note-body').innerText().then(text => text.includes('Synthetic buffered private detail')), false); assert.equal(await page.locator('#workspace-refresh-access').count(), 0); assert.equal(business(await read()), currentBusiness);
      checks.push({ check: 'ordinary project detail supersession', originalBufferedDetail: { bytes: old.bytes, sha256: old.sha256 }, assertions: ['ordinary initial project detail is held', 'closing the old project retires its pending detail request', 'ordinary reopening reads the new current revision', 'late old response cannot replace current private detail', 'authorized current workspace remains usable', 'read supersession does not modify business data'] }); await screenshot('current-detail-retained');
    }
    assert.deepEqual(pageErrors, [], 'No uncaught product page errors'); assert.deepEqual(requests.filter(row => row.status >= 500), [], 'Every necessary product route avoids server failure'); assert.deepEqual(fs.readFileSync(legacyFile), originalLegacy, 'Foreign legacy workspace untouched'); assert.equal(downloads.length, 0, 'Recovery/retirement scenarios never deliver an unrequested or unauthorized download');
  } catch (error) { failure = error; }
  finally {
    for (const release of held) release(); await Promise.allSettled(pendingRoutes);
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, prefix + '-last-page.png'), fullPage: true }).catch(() => {});
    const closingSourceDigest = sourceDigest(), sourceStable = openingSourceDigest === closingSourceDigest;
    if (!failure && (process.env.CI || process.env.PDL_COMPAT_SOURCE_SHA) && !sourceStable) failure = Error('Exact CI recovery journey source changed while running');
    const result = { sourceHead, runId, testSourceHash: sha256(fs.readFileSync(__filename)), openingSourceDigest, closingSourceDigest, sourceStable, group, viewport: viewportName, backend: native ? 'native-postgresql' : 'synthetic-memory', status: failure ? 'failed' : 'passed', checks, requests, pageErrors, downloads, externalAttemptsAborted: [...external], allowedExternalRequests: 0, artifacts: artifacts(prefix), productionReady: false, failure: failure?.stack || null };
    fs.writeFileSync(path.join(evidence, prefix + '-results.json'), JSON.stringify(result, null, 2));
    if (failure && page) console.error(JSON.stringify({ group, viewport: viewportName, error: failure.message, active: await page.locator('.page.active').getAttribute('id').catch(() => null), messages: await page.locator('[role=alert],#toast,[role=status]').allTextContents().catch(() => []), failedRequests: requests.filter(row => row.status >= 400) }));
    await browser?.close(); uninstall?.(); await new Promise(resolve => mod.server.close(resolve)); await native?.close();
  }
  if (failure) throw failure;
  console.log(JSON.stringify({ group, viewport: viewportName, checks: checks.length, requests: requests.length, pageErrors: pageErrors.length, allowedExternalRequests: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
