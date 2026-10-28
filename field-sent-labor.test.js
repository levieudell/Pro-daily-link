'use strict';
// A counted punch of 2 minutes is labor. The sent dialog must not call it missing.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const NOTE = 'C2a v2 A: formed east footing.';
const FIELD_EMAIL = 'levi+field@prodailylink.com';
const FIELD_PASSWORD = 'staging-field-pass';
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

async function login(page, port) {
  await page.goto(`http://127.0.0.1:${port}/login.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#email');
  await page.$eval('#email', (el, value) => { el.value = value; }, FIELD_EMAIL);
  await page.$eval('#password', (el, value) => { el.value = value; }, FIELD_PASSWORD);
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-sent-labor-'));
  const dbFile = path.join(root, 'db.json');
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    PDL_STAGING: '1',
    PDL_STAGING_OWNER_PASSWORD: 'staging-owner-pass',
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
    await login(page, port);
    await page.waitForSelector('#myday-page.active [data-start-day]');
    await tap(page, '[data-start-day]');
    await clockIn(page);
    const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    const past = new Date(Date.now() - 2 * 60 * 1000).toISOString();
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
    await page.evaluate(() => {
      document.querySelectorAll('[data-labor-member]').forEach(input => { input.value = ''; });
    });
    await page.click('#save-report');
    await page.waitForSelector('#report-sent-modal[open]', { timeout: 20000 });
    const sent = await page.evaluate(() => ({
      title: document.querySelector('#report-sent-modal h2')?.textContent || '',
      summary: document.querySelector('#report-sent-summary')?.textContent || '',
      labor: document.querySelector('#report-detail .data-box strong')?.textContent || ''
    }));
    assert.equal(/Missing: labor hours/i.test(sent.summary), false, JSON.stringify(sent));
    assert.match(sent.summary, /2 min logged/i, JSON.stringify(sent));
    await page.click('#report-sent-modal button.primary');
    await page.waitForFunction(() => !document.querySelector('#report-sent-modal')?.open);
    await page.evaluate(() => document.querySelector('.nav-item[data-page="myday"]').click());
    await page.waitForSelector('#myday-page.active [data-start-day]', { timeout: 20000 });
    await tap(page, '[data-start-day]');
    await clockIn(page);
    await tap(page, '[data-start-day]');
    await page.waitForSelector('#report-modal[open] #field-notes');
    await page.click('#report-next-step');
    await page.waitForFunction(() => /measured/i.test(document.querySelector('#field-review-cards')?.innerText || ''), { timeout: 20000 });
    const review = await page.evaluate(() => ({
      text: document.querySelector('#field-review-cards')?.innerText || '',
      blankManual: [...document.querySelectorAll('[data-labor-member]')].filter(input => input.dataset.manualHours === 'true' && input.value === '').map(input => input.dataset.laborMember)
    }));
    assert.deepEqual(review.blankManual, [], review.text);
    assert.equal(/unknown h reported/i.test(review.text), false, review.text);
    assert.equal(/h reported/i.test(review.text), false, review.text);
    const measured = review.text.match(/(\d+) min · \d+\.\d{2} h measured/i);
    assert.ok(measured && Number(measured[1]) >= 2, review.text);
    await page.evaluate(() => {
      document.querySelectorAll('[data-labor-member]').forEach(input => { input.value = ''; });
    });
    await page.click('#save-report');
    await page.waitForSelector('#report-sent-modal[open]', { timeout: 20000 });
    const restored = await page.evaluate(() => ({
      title: document.querySelector('#report-sent-modal h2')?.textContent || '',
      summary: document.querySelector('#report-sent-summary')?.textContent || ''
    }));
    assert.equal(/Missing: labor hours/i.test(restored.summary), false, JSON.stringify({ review: review.text, restored }));
    assert.match(restored.summary, /\d+ min logged/i, JSON.stringify({ review: review.text, restored }));
    console.log('A restored punch is measured on review and logged on send.');
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
