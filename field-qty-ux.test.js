'use strict';
// A new quantity box is empty, focused, and the review hint fits at 390px.
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
  await page.waitForSelector(selector, { visible: true, timeout: 20000 });
  await page.waitForFunction(target => {
    const el = document.querySelector(target);
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit === el || Boolean(el.contains(hit));
  }, { timeout: 20000 }, selector);
  const point = await page.$eval(selector, el => {
    const box = el.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  });
  await page.touchscreen.tap(point.x, point.y);
}

async function headerCascade(page) {
  return page.evaluate(() => {
    const close = document.querySelector('#report-modal .close-button');
    const header = document.querySelector('#report-modal .modal-header');
    const cs = getComputedStyle(header);
    const c = close.getBoundingClientRect();
    const x = Math.max(0, c.left - 6);
    const y = c.top + c.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      position: cs.position,
      height: cs.height,
      background: cs.backgroundColor,
      beside: hit ? `${hit.tagName}#${hit.id}.${String(hit.className || '')}` : 'none',
      besideHeader: hit === header || Boolean(header.contains(hit))
    };
  });
}

async function clearOfClose(page, selector) {
  return page.evaluate(target => {
    const close = document.querySelector('#report-modal .close-button');
    const c = close.getBoundingClientRect();
    const hit = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
    const overlaps = [...document.querySelectorAll(target)].filter(node => {
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && !(box.right <= c.left + 1 || box.left >= c.right - 1 || box.bottom <= c.top + 1 || box.top >= c.bottom - 1);
    }).map(node => (node.textContent || '').trim().slice(0, 70));
    return {
      overlap: overlaps.length > 0,
      overlaps,
      closeHit: hit === close || Boolean(close?.contains(hit)),
      hit: hit ? `${hit.tagName}#${hit.id}.${String(hit.className || '')}`.slice(0, 80) : 'none',
      close: { top: Math.round(c.top), left: Math.round(c.left), width: Math.round(c.width), height: Math.round(c.height) }
    };
  }, selector);
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-qty-ux-'));
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
    await page.waitForSelector('#myday-page.active [data-start-day]', { timeout: 20000 });
    await tap(page, '#myday-page.active [data-start-day]');
    await clockIn(page);
    await tap(page, '#myday-page.active [data-start-day]');
    await page.waitForSelector('#report-modal[open] #field-notes');
    const notesHeader = await headerCascade(page);
    assert.equal(notesHeader.position, 'absolute', JSON.stringify(notesHeader));
    assert.equal(notesHeader.height, '0px', JSON.stringify(notesHeader));
    const notesPad = await page.$eval('#report-form', form => parseFloat(getComputedStyle(form).paddingRight));
    assert.ok(notesPad >= 46, String(notesPad));
    await page.$eval('#report-form', form => { form.scrollTop = form.scrollHeight; });
    const notesBottom = await clearOfClose(page, '#field-notes, #flag-extra-work');
    assert.equal(notesBottom.overlap, false, JSON.stringify(notesBottom));
    await page.$eval('#report-form', form => { form.scrollTop = 0; });
    const notesClear = await clearOfClose(page, '#field-notes');
    assert.equal(notesClear.overlap, false, JSON.stringify(notesClear));
    await page.$eval('#field-notes', (el, note) => {
      el.value = note;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, NOTE);
    await page.click('#report-next-step');
    await page.waitForSelector('[data-pick-line]', { timeout: 20000 });
    const hint = await page.evaluate(() => {
      const node = [...document.querySelectorAll('#field-review-cards p, .verify-banner, .verify-banner span')].find(el => /can be sent/i.test(el.textContent || ''));
      const box = node?.getBoundingClientRect();
      return node ? {
        text: node.textContent.trim(),
        overflow: node.scrollWidth - node.clientWidth,
        right: Math.round(box.right),
        width: 390
      } : { text: '', overflow: 0, right: 0, width: 390 };
    });
    assert.match(hint.text, /can be sent for office review/i, JSON.stringify(hint));
    assert.ok(hint.overflow <= 1, JSON.stringify(hint));
    assert.ok(hint.right <= 390, JSON.stringify(hint));
    const hintClear = await clearOfClose(page, '#field-review-cards p, .verify-banner');
    assert.equal(hintClear.overlap, false, JSON.stringify(hintClear));
    const reviewHeader = await headerCascade(page);
    assert.equal(reviewHeader.position, 'absolute', JSON.stringify(reviewHeader));
    assert.equal(reviewHeader.height, '0px', JSON.stringify(reviewHeader));
    await page.$eval('#report-form', form => { form.scrollTop = form.scrollHeight / 2; });
    const reviewMiddle = await clearOfClose(page, '.field-review-card, #field-edit-hours, #field-review-cards p');
    assert.equal(reviewMiddle.overlap, false, JSON.stringify(reviewMiddle));
    await page.$eval('#report-form', form => { form.scrollTop = form.scrollHeight; });
    const reviewBottom = await clearOfClose(page, '.field-review-card, #field-edit-hours, #field-review-cards p');
    assert.equal(reviewBottom.overlap, false, JSON.stringify(reviewBottom));
    await page.$eval('#report-form', form => { form.scrollTop = 0; });
    const footing = await page.$eval('[data-pick-line]', select => [...select.options].find(item => /Footings/i.test(item.textContent || ''))?.value || '');
    await page.select('[data-pick-line]', footing);
    await page.waitForSelector('.production-entry.is-editing .production-quantity');
    const picked = await page.evaluate(() => {
      const qty = document.querySelector('.production-entry.is-editing .production-quantity');
      return { value: qty.value, placeholder: qty.placeholder, type: qty.type, inputMode: qty.inputMode, focused: document.activeElement === qty };
    });
    assert.equal(picked.value, '');
    assert.equal(picked.placeholder, '0');
    assert.equal(picked.type, 'number');
    assert.equal(picked.inputMode, 'decimal');
    assert.equal(picked.focused, true, JSON.stringify(picked));
    await page.$eval('.production-entry.is-editing .production-quantity', el => {
      el.value = '0';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#save-report');
    await page.waitForFunction(() => /quantity/i.test(document.querySelector('#report-submit-status')?.textContent || ''));
    assert.equal(await page.$('#report-sent-modal[open]'), null);
    await page.evaluate(() => document.querySelector('#field-add-line').click());
    const manual = await page.evaluate(() => {
      const row = document.querySelector('.production-entry.is-editing');
      const select = row?.querySelector('.production-item');
      const option = [...(select?.options || [])].find(item => /Curb/i.test(item.textContent || ''));
      if (!select || !option) return { ok: false };
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const qty = row.querySelector('.production-quantity');
      return { ok: true, value: qty.value, placeholder: qty.placeholder, type: qty.type, inputMode: qty.inputMode, focused: document.activeElement === qty };
    });
    assert.equal(manual.ok, true, JSON.stringify(manual));
    assert.equal(manual.value, '');
    assert.equal(manual.placeholder, '0');
    assert.equal(manual.type, 'number');
    assert.equal(manual.inputMode, 'decimal');
    assert.equal(manual.focused, true, JSON.stringify(manual));
    console.log('Quantity starts empty, focused, and the review hint fits.');
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
