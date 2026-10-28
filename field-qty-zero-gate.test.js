'use strict';
// Qty 0 blocks Send on every chosen estimate line: AI-filled, restored, and manual.
// Extra work can still send with no quantity.
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
  assert.equal(point.hit, true, `tap missed ${selector} ${JSON.stringify(point)}`);
  await page.touchscreen.tap(point.x, point.y);
}

async function clockIn(page) {
  await page.waitForSelector('#start-day-modal[open] #start-day-members input', { timeout: 10000 });
  await page.evaluate(() => {
    for (const box of document.querySelectorAll('#start-day-members input')) {
      const keep = /Jordan Reed/i.test(box.closest('label')?.textContent || '');
      if (box.checked !== keep) box.click();
    }
  });
  await page.click('#confirm-start-day');
  await page.waitForFunction(() => /Clock out/i.test(document.querySelector('#start-day-button')?.textContent || '') && !document.querySelector('#start-day-modal')?.open, { timeout: 20000 });
}

async function openReview(page) {
  await page.click('#report-next-step');
  await page.waitForFunction(() => document.querySelector('#report-form')?.getAttribute('data-current-step') === '2', { timeout: 20000 });
}

function setQty(page, name, value) {
  return page.evaluate((name, value) => {
    const row = [...document.querySelectorAll('.production-entry')].find(entry => {
      const label = entry.querySelector('.production-item')?.selectedOptions?.[0]?.textContent
        || entry.querySelector('.custom-description')?.value
        || '';
      return new RegExp(name, 'i').test(label);
    });
    if (!row) return { ok: false };
    const qty = row.querySelector('.production-quantity');
    qty.value = value;
    qty.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, ai: row.dataset.aiFilled === 'true', id: row.dataset.estimateItemId || row.querySelector('.production-item')?.value || '' };
  }, name, value);
}

async function expectBlocked(page, label) {
  await page.click('#save-report');
  await page.waitForFunction(() => /quantity/i.test(document.querySelector('#report-submit-status')?.textContent || ''), { timeout: 8000 });
  const status = await page.$eval('#report-submit-status', el => el.textContent || '');
  assert.match(status, /Enter a quantity for each work line/i, label + ' ' + status);
  assert.equal(await page.$('#report-sent-modal[open]'), null, label + ' must not send');
}

(async () => {
  assert.ok(fs.existsSync(CHROME), `Chrome is required (${CHROME})`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-qty-zero-'));
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    PDL_STAGING: '1',
    PDL_STAGING_OWNER_PASSWORD: 'staging-owner-pass',
    PDL_STAGING_FIELD_PASSWORD: FIELD_PASSWORD,
    PDL_DB_FILE: path.join(root, 'db.json'),
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
      const timer = setTimeout(() => reject(new Error('staging server did not start\n' + log)), 20000);
      const poll = () => {
        if (log.includes('running at')) { clearTimeout(timer); resolve(); return; }
        if (child.exitCode != null) { clearTimeout(timer); reject(new Error('server exited\n' + log)); return; }
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
    await page.waitForSelector('#start-day-modal[open]', { timeout: 5000 });
    await clockIn(page);
    await tap(page, '[data-start-day]');
    await page.waitForSelector('#report-modal[open] #field-notes');
    await page.$eval('#field-notes', (el, note) => {
      el.value = note;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, NOTE);
    await openReview(page);
    await page.waitForSelector('[data-pick-line]');
    const footing = await page.$eval('[data-pick-line]', select => [...select.options].find(item => /Footings/i.test(item.textContent || ''))?.value || '');
    assert.ok(footing);
    await page.select('[data-pick-line]', footing);
    await page.waitForSelector('.production-entry.is-editing .production-quantity');
    const aiZero = await setQty(page, 'Footings', '0');
    assert.equal(aiZero.ok, true, 'AI-filled Footings line');
    assert.equal(aiZero.ai, true, 'the picked line is still marked AI-filled');
    await expectBlocked(page, 'AI-filled 0');

    assert.equal((await setQty(page, 'Footings', '2')).ok, true);
    await page.click('#save-report');
    await page.waitForSelector('#report-sent-modal[open]', { timeout: 20000 });
    await page.click('#report-sent-modal button.primary');
    await page.waitForFunction(() => !document.querySelector('#report-modal')?.open && !document.querySelector('#report-sent-modal')?.open);

    await page.evaluate(() => document.querySelector('.nav-item[data-page="fieldday"]').click());
    await page.waitForSelector('#fieldday-page.active #start-day-button');
    await tap(page, '#start-day-button');
    await page.waitForSelector('#start-day-modal[open]', { timeout: 5000 });
    await clockIn(page);
    await tap(page, '#start-day-button');
    await page.waitForSelector('#report-modal[open] #field-notes');
    await openReview(page);
    const restored = await setQty(page, 'Footings', '0');
    assert.equal(restored.ok, true, 'restored Footings line');
    assert.equal(restored.ai, false, 'restore does not keep data-ai-filled');
    await expectBlocked(page, 'restored 0');

    assert.equal((await setQty(page, 'Footings', '2')).ok, true);
    const addedLine = await page.evaluate(() => {
      const button = document.querySelector('#field-add-line');
      if (!button) return { ok: false, reason: 'no add button' };
      button.click();
      return {
        ok: true,
        rows: [...document.querySelectorAll('.production-entry')].map(row => ({
          editing: row.classList.contains('is-editing'),
          item: Boolean(row.querySelector('.production-item')),
          custom: Boolean(row.querySelector('.custom-description')),
          display: getComputedStyle(row).display,
          label: row.querySelector('.production-item')?.selectedOptions?.[0]?.textContent || row.querySelector('.custom-description')?.value || ''
        }))
      };
    });
    assert.equal(addedLine.ok, true, JSON.stringify(addedLine));
    assert.ok(addedLine.rows.some(row => row.editing && row.item), JSON.stringify(addedLine.rows));
    const manual = await page.evaluate(() => {
      const row = document.querySelector('.production-entry.is-editing');
      const select = row.querySelector('.production-item');
      const option = [...select.options].find(item => /Curb/i.test(item.textContent || ''));
      if (!option) return { ok: false };
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const qty = row.querySelector('.production-quantity');
      qty.value = '0';
      qty.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, ai: row.dataset.aiFilled === 'true' };
    });
    assert.equal(manual.ok, true, 'manual Curb line');
    assert.equal(manual.ai, false);
    await expectBlocked(page, 'manual 0');

    assert.equal((await setQty(page, 'Curb', '1')).ok, true);
    await page.click('#flag-extra-work');
    await page.waitForSelector('[data-flag-choice="yes"]');
    await page.click('[data-flag-choice="yes"]');
    await page.click('#save-report');
    await page.waitForSelector('#report-sent-modal[open]', { timeout: 20000 });
    const sent = await page.evaluate(() => ({
      title: document.querySelector('#report-sent-modal h2')?.textContent || '',
      summary: document.querySelector('#report-sent-summary')?.textContent || '',
      blocked: document.querySelector('#report-submit-status')?.textContent || ''
    }));
    assert.match(`${sent.title} ${sent.summary}`, /extra work/i, JSON.stringify(sent));
    assert.equal(/quantity/i.test(sent.blocked), false, JSON.stringify(sent));
    console.log('Qty 0 blocked on AI, restored, and manual lines. Extra work sent without a quantity.');
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
