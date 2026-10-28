'use strict';
// Two lines for the same estimate item add on save. Curb 1 LF plus Curb 10 LF stays 11 LF.
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

async function pickLine(page, name) {
  await page.waitForSelector('[data-pick-line]');
  const value = await page.$eval('[data-pick-line]', (select, name) => [...select.options].find(item => new RegExp(name, 'i').test(item.textContent || ''))?.value || '', name);
  assert.ok(value, name);
  await page.select('[data-pick-line]', value);
}

function setNamedQty(page, name, value, which) {
  return page.evaluate((name, value, which) => {
    const rows = [...document.querySelectorAll('.production-entry')].filter(row => new RegExp(name, 'i').test(row.querySelector('.production-item')?.selectedOptions?.[0]?.textContent || ''));
    const row = rows[which] || rows[0];
    if (!row) return { ok: false, count: 0 };
    const qty = row.querySelector('.production-quantity');
    qty.value = value;
    qty.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, count: rows.length };
  }, name, value, which);
}

async function send(page) {
  await page.click('#save-report');
  await page.waitForSelector('#report-sent-modal[open]', { timeout: 20000 });
  await page.click('#report-sent-modal button.primary');
  await page.waitForFunction(() => !document.querySelector('#report-modal')?.open && !document.querySelector('#report-sent-modal')?.open);
}

(async () => {
  assert.ok(fs.existsSync(CHROME), `Chrome is required (${CHROME})`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-same-item-'));
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
    await clockIn(page);
    await tap(page, '[data-start-day]');
    await page.waitForSelector('#report-modal[open] #field-notes');
    await page.$eval('#field-notes', (el, note) => {
      el.value = note;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, NOTE);
    await openReview(page);
    await pickLine(page, 'Curb');
    assert.equal((await setNamedQty(page, 'Curb', '1', 0)).ok, true);
    await send(page);

    await page.evaluate(() => document.querySelector('.nav-item[data-page="fieldday"]').click());
    await page.waitForSelector('#fieldday-page.active #start-day-button');
    await tap(page, '#start-day-button');
    await clockIn(page);
    await tap(page, '#start-day-button');
    await page.waitForSelector('#report-modal[open] #field-notes');
    await openReview(page);
    const restored = await setNamedQty(page, 'Curb', '1', 0);
    assert.equal(restored.ok, true, 'restored Curb line');
    await page.evaluate(() => document.querySelector('#field-add-line').click());
    const manual = await page.evaluate(() => {
      const row = document.querySelector('.production-entry.is-editing') || [...document.querySelectorAll('.production-entry')].find(entry => !/Curb/i.test(entry.querySelector('.production-item')?.selectedOptions?.[0]?.textContent || ''));
      const select = row?.querySelector('.production-item');
      const option = [...(select?.options || [])].find(item => /Curb/i.test(item.textContent || ''));
      if (!row || !option) return { ok: false };
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const qty = row.querySelector('.production-quantity');
      qty.value = '10';
      qty.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true };
    });
    assert.equal(manual.ok, true, 'manual Curb line');
    const before = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.production-entry')].filter(row => /Curb/i.test(row.querySelector('.production-item')?.selectedOptions?.[0]?.textContent || ''));
      return {
        count: rows.length,
        quantities: rows.map(row => Number(row.querySelector('.production-quantity')?.value) || 0),
        minutes: rows.map(row => Number(row.dataset.laborMinutes) || 0)
      };
    });
    assert.equal(before.count, 2, JSON.stringify(before));
    assert.equal(before.quantities.reduce((sum, value) => sum + value, 0), 11, JSON.stringify(before));
    await send(page);
    const saved = await page.evaluate(() => {
      const report = (typeof reports === 'undefined' ? [] : reports).find(row => /curb/i.test(row.notes || '')) || (typeof reports === 'undefined' ? [] : reports)[0];
      const lines = (report?.productionEntries || []).filter(row => /curb/i.test(row.description || '') && row.extra_work !== true);
      return {
        id: report?.id || null,
        lines: lines.map(row => ({ quantity: Number(row.quantity) || 0, minutes: Number(row.laborMinutes) || 0, hours: Number(row.laborHours) || 0 })),
        laborMinutes: (report?.laborEntries || []).reduce((sum, row) => sum + (Number(row.minutes) || 0), 0)
      };
    });
    assert.equal(saved.lines.length, 1, JSON.stringify(saved));
    assert.equal(saved.lines[0].quantity, 11, JSON.stringify(saved));
    const laborSum = before.minutes.reduce((sum, value) => sum + value, 0);
    if (laborSum > 0 || saved.laborMinutes > 0) {
      assert.equal(saved.lines[0].minutes, laborSum || saved.laborMinutes, JSON.stringify({ before, saved }));
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-button', { timeout: 20000 });
    await page.evaluate(() => document.querySelector('.nav-item[data-page="myday"]')?.click());
    await page.waitForSelector('#myday-page.active', { timeout: 20000 });
    await page.evaluate(() => document.querySelector('[data-assignment-daily]')?.click());
    await page.waitForSelector('#report-modal[open] #field-notes', { timeout: 20000 });
    await openReview(page);
    const reloaded = await page.evaluate(() => [...document.querySelectorAll('.production-entry')].filter(row => /Curb/i.test(row.querySelector('.production-item')?.selectedOptions?.[0]?.textContent || '')).map(row => Number(row.querySelector('.production-quantity')?.value) || 0));
    assert.deepEqual(reloaded, [11], JSON.stringify(reloaded));
    console.log('Same-item Curb quantities added to 11 LF.');
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
