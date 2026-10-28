'use strict';
// Blank reported hours are not zero. A 5 minute punch is the measured crew hours.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const NOTE = 'C3c hours: formed the east footing.';
const FIELD_EMAIL = 'levi+field@prodailylink.com';
const FIELD_PASSWORD = 'staging-field-pass';
const OWNER_EMAIL = 'levi+owner@prodailylink.com';
const OWNER_PASSWORD = 'staging-owner-pass';
const CHROME = process.env.PDL_TEST_CHROME || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : '/usr/bin/google-chrome-stable');

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

async function login(page, port, email, password) {
  await page.goto(`http://127.0.0.1:${port}/login.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#email');
  await page.$eval('#email', (el, value) => { el.value = value; }, email);
  await page.$eval('#password', (el, value) => { el.value = value; }, password);
  await page.click('form#login button.primary');
  await page.waitForFunction(() => location.pathname.includes('/app'), { timeout: 20000 });
  await page.waitForSelector('#menu-button', { timeout: 20000 });
}

async function tap(page, selector) {
  const point = await page.$eval(selector, el => {
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const box = el.getBoundingClientRect();
    const x = Math.round(box.left + box.width / 2);
    const y = Math.round(box.top + box.height / 2);
    const hit = document.elementFromPoint(x, y);
    return { x, y, hit: hit === el || Boolean(el.contains(hit)) };
  });
  assert.equal(point.hit, true, `tap missed ${selector}`);
  await page.touchscreen.tap(point.x, point.y);
}

async function clockIn(page) {
  await page.waitForSelector('#start-day-modal[open] #start-day-members input');
  await page.evaluate(() => {
    for (const box of document.querySelectorAll('#start-day-members input')) {
      const keep = /Jordan Reed/i.test(box.closest('label')?.textContent || '');
      if (box.checked !== keep) box.click();
    }
  });
  await page.click('#confirm-start-day');
  await page.waitForFunction(() => /Clock out/i.test(document.querySelector('#start-day-button')?.textContent || '') && !document.querySelector('#start-day-modal')?.open);
}

(async () => {
  assert.ok(fs.existsSync(CHROME), `Chrome is required (${CHROME})`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-crew-hours-'));
  const dbFile = path.join(root, 'db.json');
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    PDL_STAGING: '1',
    PDL_STAGING_OWNER_PASSWORD: OWNER_PASSWORD,
    PDL_STAGING_FIELD_PASSWORD: FIELD_PASSWORD,
    PDL_DB_FILE: dbFile,
    PDL_PLATFORM_FILE: path.join(root, 'platform.json'),
    PDL_EMAIL_DEV_MODE: '1',
    PDL_SUPABASE_ENABLED: '0',
    PDL_TRANSACTIONAL_DB: 'off',
    OPENAI_API_KEY: ''
  };
  for (const name of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY', 'INDEXNOW_KEY', 'SENTRY_DSN']) delete env[name];
  const child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start\n' + log)), 20000);
      const poll = () => {
        if (log.includes('running at')) { clearTimeout(timer); resolve(); return; }
        if (child.exitCode != null) { clearTimeout(timer); reject(new Error(log)); return; }
        setTimeout(poll, 100);
      };
      poll();
    });
    browser = await puppeteer().launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    page.on('dialog', async dialog => { await dialog.dismiss(); });
    await login(page, port, FIELD_EMAIL, FIELD_PASSWORD);
    await page.waitForSelector('#myday-page.active [data-start-day]');
    await tap(page, '[data-start-day]');
    await clockIn(page);
    const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    const past = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    for (const day of db.workdays || []) if (day.status === 'active') day.startedAt = past;
    for (const card of db.timeCards || []) if (!card.outAt) card.inAt = past;
    fs.writeFileSync(dbFile, JSON.stringify(db));
    await tap(page, '[data-start-day]');
    await page.waitForSelector('#report-modal[open] #field-notes');
    await page.$eval('#field-notes', (el, note) => {
      el.value = note;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, NOTE);
    await page.click('#report-next-step');
    await page.waitForSelector('[data-pick-line]', { timeout: 20000 });
    const footing = await page.$eval('[data-pick-line]', select => [...select.options].find(item => /Footings/i.test(item.textContent || ''))?.value || '');
    await page.select('[data-pick-line]', footing);
    await page.waitForSelector('.production-entry.is-editing .production-quantity');
    await page.$eval('.production-entry.is-editing .production-quantity', el => {
      el.value = '2';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForSelector('#report-review-summary', { timeout: 10000 });
    const tile = await page.$eval('#report-review-summary', el => el.innerText);
    assert.match(tile, /CREW HOURS\s*0\.08/, tile);
    assert.equal(/CREW HOURS\s*0(?!\.)/.test(tile), false, tile);
    const measured = await page.$eval('#field-review-cards', el => el.innerText);
    assert.match(measured, /0\.08 h measured/, measured);
    assert.equal(/h reported/i.test(measured), false, measured);
    await page.click('#save-report');
    await page.waitForSelector('#report-sent-modal[open]', { timeout: 20000 });
    await page.click('#report-sent-modal button.primary');
    await page.waitForFunction(() => !document.querySelector('#report-sent-modal')?.open);
    await page.waitForSelector('#report-detail .data-box', { timeout: 20000 });
    const fieldReport = await page.$eval('#report-detail', el => el.innerText);
    assert.match(fieldReport, /LABOR[\s\S]{0,120}5 min · 0\.08 h/, fieldReport);
    const saved = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    const daily = (saved.reports || []).find(row => /formed the east footing/i.test(`${row.notes || ''} ${row.originalNotes || ''}`));
    assert.ok(daily, 'daily was saved');
    assert.ok((daily.officeReview?.reportedLabor || []).every(row => row.hours == null), JSON.stringify(daily.officeReview?.reportedLabor));
    const entryHours = (daily.laborEntries || []).reduce((sum, row) => sum + Number(row.hours || 0), 0);
    const lineHours = (daily.productionEntries || []).reduce((sum, row) => sum + Number(row.laborHours || 0), 0);
    assert.ok(Math.abs(entryHours - 0.08) < 0.011, JSON.stringify(daily.laborEntries));
    assert.ok(Math.abs(lineHours - 0.08) < 0.011, JSON.stringify(daily.productionEntries));
    await page.evaluate(async () => { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' }); });
    await login(page, port, OWNER_EMAIL, OWNER_PASSWORD);
    await page.evaluate(() => document.querySelector('.nav-item[data-page="reports"]').click());
    await page.waitForSelector('#report-list [data-report]', { timeout: 20000 });
    await page.evaluate(note => {
      const report = reports.find(row => new RegExp(note, 'i').test(`${row.notes || ''} ${row.originalNotes || ''}`));
      document.querySelector(`[data-report="${report.id}"]`).click();
    }, 'formed the east footing');
    await page.waitForFunction(() => /LABOR/.test(document.querySelector('#report-detail')?.innerText || ''), { timeout: 10000 });
    const officeReport = await page.$eval('#report-detail', el => el.innerText);
    assert.match(officeReport, /LABOR[\s\S]{0,120}5 min · 0\.08 h/, officeReport);
    console.log('Blank reported hours display the 5 minute punch.');
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
