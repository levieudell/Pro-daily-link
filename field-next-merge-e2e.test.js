'use strict';
// 390px repro: send daily A after a 2-minute punch, clock in again, clock out
// at 5 minutes, and send B. The punches merge. The longer next step stays,
// and the sent punches are not left as draft on the time card.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const NEXT_A = `${'Form the east curb and stage the pump before the inspector walks it. '.repeat(8)}`.slice(0, 332);
const NEXT_B = `${'Finish the east curb, confirm the pump, and leave the forms up for the inspector. '.repeat(8)}`.slice(0, 400);
const FIELD_EMAIL = 'levi+field@prodailylink.com';
const OWNER_EMAIL = 'levi+owner@prodailylink.com';
const FIELD_PASSWORD = 'staging-field-pass';
const OWNER_PASSWORD = 'staging-owner-pass';

function puppeteer() {
  try { return require('puppeteer-core'); }
  catch { return require('/tmp/puppeteer/node_modules/puppeteer-core'); }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function pinOpenPunch(file, minutes) {
  const db = JSON.parse(fs.readFileSync(file, 'utf8'));
  const start = new Date(Date.now() - (minutes * 60 + 20) * 1000).toISOString();
  for (const card of db.timeCards || []) if (card.inAt && !card.outAt) card.inAt = start;
  for (const day of db.workdays || []) if (day.status === 'active') day.startedAt = start;
  fs.writeFileSync(file, JSON.stringify(db));
}

async function login(page, email, password) {
  await page.goto(`http://127.0.0.1:${page.__port}/login.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#email');
  await page.$eval('#email', (el, value) => { el.value = value; }, email);
  await page.$eval('#password', (el, value) => { el.value = value; }, password);
  await page.click('form#login button.primary');
  await page.waitForFunction(() => location.pathname.includes('/app'), { timeout: 20000 });
  await page.waitForSelector('#menu-button', { timeout: 20000 });
}

async function openNav(page, name) {
  await page.evaluate(target => {
    const sidebar = document.querySelector('#sidebar');
    if (sidebar && !sidebar.classList.contains('open')) document.querySelector('#menu-button')?.click();
    document.querySelector(`.nav-item[data-page="${target}"]`)?.click();
    sidebar?.classList.remove('open');
  }, name);
  await page.waitForFunction(target => document.getElementById(target + '-page')?.classList.contains('active'), { timeout: 10000 }, name);
}

async function startJordan(page) {
  await openNav(page, 'fieldday');
  await page.waitForFunction(() => /Clock in/i.test(document.querySelector('#start-day-button')?.textContent || ''), { timeout: 20000 });
  await page.click('#start-day-button');
  await page.waitForSelector('#start-day-modal[open] #start-day-members input');
  await page.evaluate(() => {
    const project = document.querySelector('#start-day-project');
    if (project) project.value = '3';
    for (const box of document.querySelectorAll('#start-day-members input')) {
      const label = box.closest('label')?.textContent || '';
      const keep = /Jordan Reed/i.test(label);
      if (box.checked !== keep) box.click();
    }
  });
  await page.click('#confirm-start-day');
  await page.waitForFunction(() => /Clock out/i.test(document.querySelector('#start-day-button')?.textContent || ''), { timeout: 20000 });
}

async function clockOut(page, file, minutes, notes, next) {
  await openNav(page, 'fieldday');
  pinOpenPunch(file, minutes);
  await page.click('#start-day-button');
  await page.waitForSelector('#end-day-modal[open] #end-day-next', { timeout: 20000 });
  await page.$eval('#end-day-notes', (el, value) => { el.value = value; }, notes);
  await page.$eval('#end-day-next', (el, value) => { el.value = value; }, next);
  await page.click('#confirm-end-day');
}

async function dailyState(page) {
  return page.evaluate(async () => {
    const state = await (await fetch('/api/state', { credentials: 'include' })).json();
    const reports = (state.reports || []).filter(row => /curb/i.test(`${row.notes || ''} ${row.originalNotes || ''}`));
    const report = reports[0] || null;
    const cards = (state.timeCards || []).filter(card => report && Number(card.reportId) === Number(report.id) && card.outAt);
    return {
      count: reports.length,
      next: report?.next || '',
      status: report?.status || '',
      minutes: (report?.laborEntries || []).reduce((sum, row) => sum + (Number(row.minutes) || 0), 0),
      cards: cards.map(card => ({ status: card.status, minutes: Math.floor((new Date(card.outAt) - new Date(card.inAt)) / 60000) }))
    };
  });
}

(async () => {
  assert.equal(NEXT_A.length, 332);
  assert.equal(NEXT_B.length, 400);
  assert.ok(fs.existsSync('/usr/bin/google-chrome-stable'), 'Chrome is required for the next-step browser test');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-next-e2e-'));
  const port = await freePort();
  const dbFile = path.join(root, 'db.json');
  const env = { ...process.env, PORT: String(port), PDL_STAGING: '1', PDL_STAGING_OWNER_PASSWORD: OWNER_PASSWORD, PDL_STAGING_FIELD_PASSWORD: FIELD_PASSWORD, PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: path.join(root, 'platform.json'), PDL_EMAIL_DEV_MODE: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', OPENAI_API_KEY: '' };
  for (const name of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY', 'INDEXNOW_KEY', 'SENTRY_DSN']) delete env[name];
  const child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  let browser;
  try {
    browser = await puppeteer().launch({ executablePath: '/usr/bin/google-chrome-stable', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('staging server did not start\n' + log)), 20000);
      const poll = () => {
        if (log.includes('running at')) { clearTimeout(timer); resolve(); return; }
        if (child.exitCode != null) { clearTimeout(timer); reject(new Error('server exited\n' + log)); return; }
        setTimeout(poll, 100);
      };
      poll();
    });
    const page = await browser.newPage();
    page.__port = port;
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    page.on('dialog', async dialog => { await dialog.accept(); });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('pdl-analytics-consent', 'declined');
      localStorage.setItem('pdl-field-tip', 'dismissed');
    });
    await login(page, FIELD_EMAIL, FIELD_PASSWORD);
    await startJordan(page);
    await clockOut(page, dbFile, 2, 'Poured 40 LF of curb on the north side.', NEXT_A);
    await page.waitForFunction(() => document.querySelector('#report-modal')?.open && !document.querySelector('#end-day-modal')?.open && document.querySelector('#report-next'), { timeout: 20000 });
    const clocked = await dailyState(page);
    assert.equal(clocked.next, NEXT_A, 'a first clock-out keeps the 332-character next step');
    await page.evaluate(() => document.querySelector('#report-next-step')?.click());
    await page.waitForFunction(() => {
      const button = document.querySelector('#report-next-step');
      return button && !button.disabled && document.querySelector('#report-form')?.getAttribute('data-current-step') === '2' && document.querySelector('#field-review-next');
    }, { timeout: 20000 });
    await page.$eval('#field-review-next', (el, value) => {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, NEXT_A);
    await page.evaluate(() => document.querySelector('#save-report')?.click());
    await page.waitForSelector('#report-sent-modal[open]', { timeout: 20000 });
    const sentA = await dailyState(page);
    assert.equal(sentA.count, 1);
    assert.equal(sentA.next, NEXT_A, 'a first send keeps the next step');
    assert.equal(sentA.status, 'Needs review');
    await page.click('#report-sent-modal button.primary');
    await page.evaluate(() => document.querySelector('#report-modal .close-button')?.click());
    await page.waitForFunction(() => !document.querySelector('#report-modal')?.open);
    await startJordan(page);
    await clockOut(page, dbFile, 5, 'Set the remaining curb along the drive.', NEXT_B);
    await page.waitForFunction(() => !document.querySelector('#end-day-modal')?.open, { timeout: 20000 });
    const merged = await dailyState(page);
    assert.equal(merged.count, 1, 'the second punch merges into the same daily');
    assert.equal(merged.next, NEXT_B, 'the longer newer next step survives the merge');
    assert.equal(merged.minutes, 7, JSON.stringify(merged));
    await page.evaluate(() => document.querySelector('[data-open-report]')?.click());
    await page.waitForSelector('#report-modal[open] #field-notes', { timeout: 20000 });
    await page.evaluate(() => document.querySelector('#report-next-step')?.click());
    await page.waitForFunction(() => {
      const button = document.querySelector('#report-next-step');
      return button && !button.disabled && document.querySelector('#field-review-next');
    }, { timeout: 20000 });
    const reviewNext = await page.$eval('#field-review-next', el => el.value);
    assert.equal(reviewNext, NEXT_B, 'review keeps the merged next step');
    await page.$eval('#field-review-next', (el, value) => {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, NEXT_B);
    await page.evaluate(() => document.querySelector('#save-report')?.click());
    await page.waitForSelector('#report-sent-modal[open]', { timeout: 20000 });
    const sentB = await dailyState(page);
    assert.equal(sentB.count, 1);
    assert.equal(sentB.next, NEXT_B);
    assert.equal(sentB.minutes, 7, JSON.stringify(sentB));
    assert.equal(sentB.cards.length, 2, JSON.stringify(sentB.cards));
    assert.ok(sentB.cards.every(card => card.status === 'submitted'), JSON.stringify(sentB.cards));
    await openNav(page, 'fieldday');
    const clockText = await page.$eval('#field-clock-hours', el => el.innerText);
    assert.equal(/· draft\b/i.test(clockText), false, clockText);
    assert.match(clockText, /· submitted/);
    const ownerContext = await browser.createBrowserContext();
    const owner = await ownerContext.newPage();
    owner.__port = port;
    await owner.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await owner.evaluateOnNewDocument(() => localStorage.setItem('pdl-analytics-consent', 'declined'));
    await login(owner, OWNER_EMAIL, OWNER_PASSWORD);
    await openNav(owner, 'reports');
    await owner.waitForFunction(expected => {
      const box = [...document.querySelectorAll('#report-detail .data-box')].find(node => /NEXT STEP/i.test(node.innerText || ''));
      return (box?.innerText || '').includes(expected);
    }, { timeout: 20000 }, NEXT_B.slice(0, 40));
    const officeNext = await owner.evaluate(() => {
      const box = [...document.querySelectorAll('#report-detail .data-box')].find(node => /NEXT STEP/i.test(node.innerText || ''));
      return box?.querySelector('strong')?.textContent || '';
    });
    assert.equal(officeNext, NEXT_B);
    console.log('Next-step merge browser flow passed.');
  } finally {
    if (browser) await browser.close();
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
