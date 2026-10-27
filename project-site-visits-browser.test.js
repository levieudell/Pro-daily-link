'use strict';

// Real-browser acceptance for the project-manager site-note journey. The
// server, account, project, and evidence are synthetic; cloud providers are
// disabled and the temporary workspace is removed when the test finishes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

let puppeteer;
for (const dependency of ['puppeteer-core', process.env.PDL_PUPPETEER_MODULE].filter(Boolean)) {
  try { puppeteer = require(dependency); break; } catch { /* Try the configured runtime next. */ }
}
if (!puppeteer) throw new Error('Install or configure puppeteer-core before running the PM site-visit browser acceptance.');

const executablePath = process.env.PDL_TEST_CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium'
].find(file => fs.existsSync(file));
if (!executablePath) throw new Error('A Chromium browser is required for PM site-visit browser acceptance.');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-pm-site-visit-browser-'));
const dbFile = path.join(temp, 'db.json'), platformFile = path.join(temp, 'platform.json');
const screenshotDir = String(process.env.PDL_SITE_VISIT_SCREENSHOT_DIR || '').trim();
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let child, browser, log = '';

async function screenshot(page, name) {
  if (!screenshotDir) return;
  fs.mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, `${name}.png`), fullPage: true });
}

async function assertMobileAction(page, selector, label) {
  await page.$eval(selector, node => node.scrollIntoView({ block: 'center' }));
  const state = await page.$eval(selector, node => {
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { width: rect.width, height: rect.height, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, visible: style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0, hittable: hit === node || node.contains(hit) };
  });
  assert.ok(state.visible && state.width >= 44 && state.height >= 44, `${label} is a readable, touch-sized mobile action`);
  assert.ok(state.left >= 0 && state.right <= 390 && state.top >= 0 && state.bottom <= 844, `${label} is reachable inside the 390px viewport`);
  assert.equal(state.hittable, true, `${label} is not covered by a sticky surface`);
}

async function assertMobileActionInPlace(page, selector, label) {
  const state = await page.$eval(selector, node => {
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { width: rect.width, height: rect.height, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, visible: style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0, hittable: hit === node || node.contains(hit) };
  });
  assert.ok(state.visible && state.width >= 44 && state.height >= 44, `${label} is touch-sized before scrolling`);
  assert.ok(state.left >= 0 && state.right <= state.viewportWidth && state.top >= 0 && state.bottom <= state.viewportHeight, `${label} is visible before scrolling`);
  assert.equal(state.hittable, true, `${label} is immediately tappable instead of covered by the sticky Finish action`);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
  });
}

async function waitForBoot(page) {
  await page.waitForFunction(() => typeof currentUser !== 'undefined' && currentUser?.id && typeof projects !== 'undefined' && document.documentElement.classList.contains('workspace-ready'), { timeout: 30000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function openFirstProject(page) {
  await page.evaluate(() => showPage('projects'));
  await page.waitForSelector('#projects-page.active #project-cards [data-project-card] .project-open');
  const projectId = await page.$eval('#project-cards [data-project-card]', card => Number(card.dataset.projectCard));
  await page.evaluate(async id => { await openProject(id); }, projectId);
  await page.waitForSelector('#project-detail-modal[open]');
  try { await page.waitForSelector('#project-detail-modal[open] [data-project-detail-pane="overview"].active', { timeout: 5000 }); }
  catch (error) {
    const state = await page.evaluate(() => ({ role: currentUser?.role, siteVisitsModule: typeof window.PDLSiteVisits, tabs: [...document.querySelectorAll('#project-detail-modal [data-project-detail-tab]')].map(node => ({ key: node.dataset.projectDetailTab, active: node.classList.contains('active') })), panes: [...document.querySelectorAll('#project-detail-modal [data-project-detail-pane]')].map(node => ({ key: node.dataset.projectDetailPane, active: node.classList.contains('active') })) }));
    throw new Error(`Project Overview did not mount: ${JSON.stringify(state)} (${error.message})`);
  }
  return projectId;
}

(async () => {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), PDL_STAGING: '1', PDL_STAGING_OWNER_PASSWORD: 'synthetic-owner-pass', PDL_STAGING_FIELD_PASSWORD: 'synthetic-field-pass', PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: platformFile, PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_PLATFORM_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1', OPENAI_API_KEY: '', NODE_ENV: 'test' };
  for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY', 'INDEXNOW_KEY', 'SENTRY_DSN', 'DATABASE_URL']) delete env[key];
  try {
    child = spawn(process.execPath, ['--require', require.resolve('./scripts/test-analytics-isolation.cjs'), 'server.js'], { cwd: __dirname, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { log += String(chunk); }); child.stderr.on('data', chunk => { log += String(chunk); });
    for (let attempt = 0; attempt < 200 && !log.includes('running at'); attempt++) await sleep(100);
    assert.ok(log.includes('running at'), 'synthetic PM site-visit server started: ' + log);
    const seed = JSON.parse(fs.readFileSync(dbFile));
    const owner = seed.users.find(user => user.role === 'owner');
    assert.ok(owner?.email, 'staging seed includes an owner account');
    const assignedProject = seed.projects[0], assignedCrew = seed.team.find(member => Number(member.id) === 4)?.crew || 'Dirt';
    const manager = {
      ...owner,
      id: Math.max(...seed.users.map(user => Number(user.id) || 0)) + 1,
      name: 'Synthetic Project Manager',
      email: 'pm-site-visit@example.invalid',
      role: 'project_manager',
      memberId: null,
      projectIds: [assignedProject.id],
      assignedCrews: [assignedCrew],
      permissions: { scheduleCrews: true, viewTime: true, manageTime: false, viewDailies: true, approveDailies: false }
    };
    seed.users.push(manager);
    fs.writeFileSync(dbFile, JSON.stringify(seed, null, 2));

    browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
    const page = await browser.newPage(), pageErrors = [], scheduleWrites = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', request => { if (/\/api\/project-tasks(?:\/|$)/.test(request.url()) && request.method() !== 'GET') scheduleWrites.push(`${request.method()} ${request.url()}`); });
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(() => localStorage.setItem('pdl-analytics-consent', 'declined'));
    await page.goto(`http://127.0.0.1:${port}/login.html`, { waitUntil: 'domcontentloaded' });
    await page.type('#email', manager.email);
    await page.type('#password', 'synthetic-owner-pass');
    await page.click('form#login button.primary');
    await waitForBoot(page);
    assert.equal(await page.evaluate(() => currentUser?.role), 'project_manager', 'real app journey is signed in as a project manager');
    assert.deepEqual(await page.evaluate(() => projects.map(project => project.id)), [assignedProject.id], 'project manager receives only the assigned project');

    const projectId = await openFirstProject(page);
    const overview = '#project-detail-content [data-project-detail-pane="overview"]';
    const quickNotes = '#project-detail-content [data-site-visit-quick="notes"]', quickPhoto = '#project-detail-content [data-site-visit-quick="photo"]';
    assert.match(await page.$eval(overview, node => node.innerText), /CREW TODAY|EQUIPO DE HOY/);
    assert.match(await page.$eval(overview, node => node.innerText), /NEXT MILESTONE|PRÓXIMO HITO/);
    assert.equal(await page.$eval('[data-site-visit-quickbar]', node => node.previousElementSibling?.classList.contains('project-health-banner')), true, 'mobile site actions sit immediately below project health');
    await assertMobileActionInPlace(page, quickNotes, 'Top-level Site notes');
    await assertMobileActionInPlace(page, quickPhoto, 'Top-level Add photo');
    await screenshot(page, '01-project-overview-390');
    await assertMobileAction(page, `${overview} [data-start-site-visit]`, 'Open site notes');
    const photoChooser = page.waitForFileChooser({ timeout: 10000 });
    await page.click(quickPhoto);
    await photoChooser;
    await page.waitForSelector('#site-visit-dialog[open] [data-site-note]');
    assert.equal(await page.$eval('[data-site-photo-input]', input => input.hasAttribute('capture')), false, 'photo picker offers both the camera and photo library');
    assert.equal(await page.$eval('[data-site-photo-input]', input => input.multiple), true, 'photo picker supports a small batch from the library');
    assert.equal(await page.$eval('[data-site-photo-input]', input => input.accept), 'image/jpeg,image/png,image/webp', 'photo picker limits selection to supported image formats');
    assert.equal(await page.$eval('#site-visit-dialog', node => node.scrollWidth > node.clientWidth), false, '390px capture sheet has no horizontal overflow');
    await assertMobileActionInPlace(page, '[data-site-save-note]', 'Add note');
    await assertMobileActionInPlace(page, '[data-site-voice]', 'Speak note');
    await assertMobileActionInPlace(page, '[data-site-photo]', 'Add photos');
    await screenshot(page, '02-site-note-capture-390');
    await assertMobileAction(page, '[data-site-voice]', 'Speak note');
    await assertMobileAction(page, '[data-site-photo]', 'Add photos');

    // Exercise the live batch guard without writing a synthetic asset into the
    // repository. The change handler must reject 9 photos and reset the picker
    // so the PM can immediately choose a smaller batch.
    const tinyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const tooManyPhotos = Array.from({ length: 9 }, (_, index) => {
      const file = path.join(temp, `site-photo-${index + 1}.png`); fs.writeFileSync(file, tinyPng); return file;
    });
    const photoInput = await page.$('[data-site-photo-input]');
    await photoInput.uploadFile(...tooManyPhotos);
    await page.waitForFunction(() => /up to 8 photos|hasta 8 fotos/i.test(document.querySelector('[data-site-message]')?.textContent || ''));
    assert.equal(await page.$eval('[data-site-photo-input]', input => input.files.length), 0, 'rejected photo selection resets for immediate retry');

    const originalNote = 'Concrete pour was pushed two days after inspection. Strip forms were moved three days to protect the pour.';
    await page.type('[data-site-note]', originalNote);
    await assertMobileAction(page, '[data-site-save-note]', 'Add note');
    await assertMobileAction(page, '[data-site-finish]', 'Finish site notes');
    assert.ok(await page.$eval('[data-site-finish]', node => node.getBoundingClientRect().width >= 300), 'mobile Finish action spans the sheet instead of shrinking to half width');
    await page.click('[data-site-save-note]');
    await page.waitForFunction(text => document.querySelector('.site-entry')?.innerText.includes(text), {}, 'Concrete pour');
    await page.waitForFunction(() => !document.querySelector('[data-site-entry-edit]')?.disabled);
    await page.click('[data-site-entry-edit]');
    await page.waitForFunction(() => document.querySelector('[data-site-save-note]')?.textContent.includes('Save change'));
    const correctedNote = 'Concrete pour was pushed two days after inspection. Strip forms were moved three days to protect the new pour.';
    await page.$eval('[data-site-note]', (textarea, value) => { textarea.value = value; textarea.dispatchEvent(new Event('input', { bubbles: true })); }, correctedNote);

    // A phone refresh must not throw away an in-progress correction.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForBoot(page);
    await openFirstProject(page);
    // Tap immediately after the awaited Overview mount. The hydrated one-render
    // contract must keep this real pointer target attached and responsive.
    await page.click(`${overview} [data-start-site-visit]`);
    await page.waitForFunction(() => document.querySelector('[data-site-save-note]')?.textContent.includes('Save change'));
    assert.equal(await page.$eval('[data-site-note]', node => node.value), correctedNote, 'unfinished correction survives refresh and reopens in edit mode');
    await page.click('[data-site-save-note]');
    await page.waitForFunction(text => document.querySelector('.site-entry')?.innerText.includes(text), {}, 'new pour');

    await page.click('[data-site-finish]');
    await page.waitForSelector('[data-site-review="workCompleted"]');
    await page.waitForSelector('[data-site-impact="1"]');
    assert.equal(await page.$eval('#site-visit-dialog', node => node.scrollWidth > node.clientWidth), false, '390px AI review has no horizontal overflow');
    await page.$eval('#site-visit-dialog', node => { node.scrollTop = 0; });
    await screenshot(page, '03-site-note-review-390');
    await assertMobileAction(page, '[data-site-complete]', 'Save project update');
    assert.ok(await page.$eval('[data-site-complete]', node => node.getBoundingClientRect().width >= 300), 'mobile Save project update action spans the review sheet');
    await screenshot(page, '04-site-note-review-actions-390');
    const proposalCount = await page.$$eval('[data-site-impact]', nodes => nodes.length);
    assert.equal(proposalCount, 2, 'each explicit schedule movement becomes a separate proposal for human review');

    await page.$eval('[data-site-impact="0"] [data-site-impact-name]', input => { input.value = 'Concrete pour milestone'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.$eval('[data-site-impact="0"] [data-site-impact-days]', input => { input.value = '4'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.$eval('[data-site-impact="0"] [data-site-impact-note]', input => { input.value = 'Move the concrete pour milestone four days after PM review.'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('[data-site-impact="1"] [data-site-impact-include]');
    assert.match(await page.$eval('[data-site-impact="1"]', node => node.innerText), /Dismissed|Descartada/);
    await page.click('[data-site-complete]');
    await page.waitForSelector('.site-visit-complete');
    assert.match(await page.$eval('.site-visit-complete', node => node.innerText), /office has a clear project update|oficina tiene una actualización clara/i);
    assert.equal(scheduleWrites.length, 0, 'site-note AI review never changes live schedule dates');

    const persisted = JSON.parse(fs.readFileSync(dbFile));
    const visit = (persisted.projectSiteVisits || []).find(row => Number(row.projectId) === projectId);
    assert.equal(visit?.status, 'completed');
    assert.equal(visit.final.scheduleImpacts.length, 1, 'dismissed AI proposal is not saved');
    assert.equal(visit.final.scheduleImpacts[0].taskName, 'Concrete pour milestone');
    assert.equal(visit.final.scheduleImpacts[0].shiftDays, 4);
    assert.equal(visit.final.scheduleImpacts[0].note, 'Move the concrete pour milestone four days after PM review.');

    await page.click('[data-site-done]');
    await page.waitForFunction(() => !document.querySelector('#site-visit-dialog').open);
    await page.waitForFunction(() => /Concrete pour|Strip forms|Vaciado de concreto/i.test(document.querySelector('[data-project-detail-pane="overview"]')?.innerText || ''));
    assert.match(await page.$eval(overview, node => node.innerText), /Concrete pour|Strip forms|Vaciado de concreto/i, 'Overview shows a meaningful organized update instead of a generic site-visit label');
    assert.equal(await page.$eval('#project-detail-modal', node => node.scrollWidth > node.clientWidth), false, 'project overview fits a 390px viewport');
    assert.deepEqual(pageErrors, [], 'real browser raised no runtime errors');
    console.log('PM site-visit browser acceptance passed: 390px overview, capture, refresh recovery, AI review/edit/dismiss, completion, persistence, and no automatic schedule writes.');
  } finally {
    await browser?.close();
    if (child && child.exitCode == null) { child.kill('SIGTERM'); for (let attempt = 0; attempt < 50 && child.exitCode == null; attempt++) await sleep(50); }
    const tempRoot = path.resolve(os.tmpdir()) + path.sep, resolved = path.resolve(temp);
    if (!resolved.startsWith(tempRoot)) throw new Error('Synthetic cleanup target escaped the temporary directory.');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); if (log) console.error(log.slice(-4000)); process.exitCode = 1; });
