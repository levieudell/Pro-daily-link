'use strict';
// A second clock-out on the same day reopens the saved daily once.
// The earlier note is not copied again, and a sentence the crew types is added once.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const NOTE = 'C2a v2 A: formed east footing.';
const ADDED = 'Stripped the forms.';
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

function count(text, needle) {
  return String(text || '').split(needle).length - 1;
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
  await page.waitForFunction(() => {
    const button = document.querySelector('#start-day-button');
    const modal = document.querySelector('#start-day-modal');
    return button && /Clock out/i.test(button.textContent || '') && modal && !modal.open;
  }, { timeout: 20000 });
}

(async () => {
  assert.ok(fs.existsSync(CHROME), `Chrome is required (${CHROME})`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-same-day-notes-'));
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
    await page.click('#report-next-step');
    await page.waitForFunction(() => document.querySelector('#report-form')?.getAttribute('data-current-step') === '2', { timeout: 20000 });
    await page.evaluate(() => document.querySelector('#report-modal').close());
    await page.waitForFunction(() => !document.querySelector('#report-modal').open);

    await page.evaluate(() => document.querySelector('.nav-item[data-page="fieldday"]').click());
    await page.waitForSelector('#fieldday-page.active #start-day-button');
    await tap(page, '#start-day-button');
    await clockIn(page);
    await tap(page, '#start-day-button');
    await page.waitForSelector('#report-modal[open] #field-notes');
    const reopened = await page.evaluate(needle => {
      const notes = document.querySelector('#field-notes')?.value || '';
      const saved = (typeof reports === 'undefined' ? [] : reports).find(row => (row.notes || '').includes(needle)) || {};
      return { notes, id: saved.id || null, stored: saved.notes || '' };
    }, NOTE);
    assert.equal(reopened.id, 1, 'the second clock-out reopens the same daily');
    assert.equal(count(reopened.notes, NOTE), 1, reopened.notes);
    assert.equal(count(reopened.stored, NOTE), 1, reopened.stored);
    await page.click('#report-next-step');
    await page.waitForFunction(() => document.querySelector('#report-form')?.getAttribute('data-current-step') === '2', { timeout: 20000 });
    const reviewed = await page.evaluate(needle => ({
      visible: document.querySelector('#report-modal')?.innerText || '',
      notes: document.querySelector('#field-notes')?.value || ''
    }), NOTE);
    assert.equal(count(reviewed.notes, NOTE), 1, reviewed.notes);
    assert.equal(count(reviewed.visible, NOTE), 1, reviewed.visible);
    await page.evaluate(() => document.querySelector('#report-back')?.click());
    await page.waitForFunction(() => document.querySelector('#report-form')?.getAttribute('data-current-step') === '1');

    await page.$eval('#field-notes', (el, added) => {
      el.value = `${el.value.trim()}\n${added}`;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, ADDED);
    await page.click('#report-next-step');
    await page.waitForFunction(added => {
      const step = document.querySelector('#report-form')?.getAttribute('data-current-step') === '2';
      const saved = typeof reports !== 'undefined' && reports.some(row => (row.notes || '').includes(added));
      return step && saved;
    }, { timeout: 20000 }, ADDED);
    const shown = await page.evaluate(needle => {
      const notes = document.querySelector('#field-notes')?.value || '';
      const visible = document.querySelector('#report-modal')?.innerText || '';
      const saved = (typeof reports === 'undefined' ? [] : reports).find(row => (row.notes || '').includes(needle)) || {};
      return { notes, visible, stored: saved.notes || '' };
    }, NOTE);
    assert.equal(count(shown.notes, NOTE), 1, shown.notes);
    assert.equal(count(shown.notes, ADDED), 1, shown.notes);
    assert.equal(count(shown.stored, NOTE), 1, shown.stored);
    assert.equal(count(shown.stored, ADDED), 1, shown.stored);
    assert.equal(count(shown.visible, NOTE), 1, shown.visible);
    assert.equal(count(shown.visible, ADDED), 1, shown.visible);
    console.log('Same-day clock-out reopened the saved note once.');
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
