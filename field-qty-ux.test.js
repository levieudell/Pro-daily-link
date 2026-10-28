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
      const scroller = node.closest('.report-step-scroll');
      const view = scroller ? scroller.getBoundingClientRect() : box;
      const top = Math.max(box.top, view.top);
      const bottom = Math.min(box.bottom, view.bottom);
      const left = Math.max(box.left, view.left);
      const right = Math.min(box.right, view.right);
      const visible = right - left > 0 && bottom - top > 0;
      return visible && !(right <= c.left + 1 || left >= c.right - 1 || bottom <= c.top + 1 || top >= c.bottom - 1);
    }).map(node => (node.textContent || '').trim().slice(0, 70));
    return { overlap: overlaps.length > 0, overlaps, closeHit: hit === close || Boolean(close.contains(hit)) };
  }, selector);
}

async function scrollStep(page, where) {
  await page.$eval('.report-step.active .report-step-scroll', (el, place) => {
    el.scrollTop = place === 'end' ? el.scrollHeight : place === 'mid' ? el.scrollHeight / 2 : 0;
  }, where);
}

async function pinnedBar(page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
  return page.evaluate(() => {
    const header = document.querySelector('#report-modal .modal-header').getBoundingClientRect();
    const close = document.querySelector('#report-modal .close-button').getBoundingClientRect();
    const bar = document.querySelector('.report-step.active .modal-actions').getBoundingClientRect();
    const form = document.querySelector('#report-form');
    const scroller = document.querySelector('.report-step.active .report-step-scroll');
    const scrollerBox = scroller.getBoundingClientRect();
    const formPad = parseFloat(getComputedStyle(form).paddingBottom);
    const scrollPad = parseFloat(getComputedStyle(scroller).paddingBottom);
    return {
      closeInside: close.top >= header.top - 0.5 && close.bottom <= header.bottom + 0.5 && close.left >= header.left && close.right <= header.right + 0.5,
      closeH: Math.round(close.height),
      headerH: Math.round(header.height),
      headerBottom: Math.round(header.bottom),
      barTop: Math.round(bar.top),
      barBottom: Math.round(bar.bottom),
      scrollerTop: Math.round(scrollerBox.top),
      scrollerBottom: Math.round(scrollerBox.bottom),
      viewH: window.innerHeight,
      formPad,
      scrollPad
    };
  });
}

async function scrollRegions(page) {
  return page.evaluate(() => {
    const scroller = document.querySelector('.report-step.active .report-step-scroll');
    const pieces = ['#report-open-safety', '#flag-extra-work', '#report-photos-field .input-help'].map(sel => {
      const el = document.querySelector(sel);
      if (!el) return { sel, missing: true };
      const box = el.getBoundingClientRect();
      return { sel, inside: Boolean(scroller?.contains(el)), left: Math.round(box.left), height: Math.round(box.height) };
    });
    return { scrollH: Math.round(scroller.getBoundingClientRect().height), viewH: window.innerHeight, pieces };
  });
}

async function assertScrollRegions(page, label) {
  for (const height of [844, 500]) {
    await page.setViewport({ width: 390, height, isMobile: true, hasTouch: true });
    await scrollStep(page, 'top');
    const top = await pinnedBar(page);
    const regions = await scrollRegions(page);
    assert.ok(top.barBottom <= height + 1 && top.barTop < height, `${label} ${height} bar ${JSON.stringify(top)}`);
    assert.ok(top.scrollerTop <= top.headerBottom + 2 && top.scrollerBottom <= top.barTop + 1, `${label} ${height} regions ${JSON.stringify(top)}`);
    assert.ok(regions.scrollH > (height === 844 ? 600 : 250), `${label} ${height} short scroller ${JSON.stringify(regions)}`);
    for (const piece of regions.pieces) {
      assert.equal(piece.missing, undefined, `${label} ${JSON.stringify(piece)}`);
      assert.equal(piece.inside, true, `${label} ${JSON.stringify(piece)}`);
      if (piece.height > 0) assert.ok(piece.left >= 20, `${label} ${JSON.stringify(piece)}`);
    }
    await scrollStep(page, 'end');
    const bottom = await pinnedBar(page);
    assert.equal(bottom.barTop, top.barTop, `${label} ${height} bar moved ${JSON.stringify({ top, bottom })}`);
  }
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await scrollStep(page, 'top');
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
    await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
    const notesHeader = await headerCascade(page);
    assert.equal(notesHeader.position, 'sticky', JSON.stringify(notesHeader));
    assert.equal(notesHeader.height, '48px', JSON.stringify(notesHeader));
    assert.equal(notesHeader.besideHeader, true, JSON.stringify(notesHeader));
    const notesBar = await pinnedBar(page);
    assert.equal(notesBar.closeInside, true, JSON.stringify(notesBar));
    assert.ok(notesBar.closeH >= 44, JSON.stringify(notesBar));
    assert.equal(notesBar.headerH, 48, JSON.stringify(notesBar));
    assert.ok(notesBar.barBottom <= notesBar.viewH + 1 && notesBar.barTop >= notesBar.viewH - 180, JSON.stringify(notesBar));
    assert.ok(notesBar.scrollerTop >= notesBar.headerH - 1 && notesBar.scrollerBottom <= notesBar.barTop + 1, JSON.stringify(notesBar));
    assert.ok(notesBar.formPad < 24 && notesBar.scrollPad < 24, JSON.stringify(notesBar));
    await assertScrollRegions(page, 'notes');
    await scrollStep(page, 'end');
    const notesBottom = await headerCascade(page);
    assert.equal(notesBottom.besideHeader, true, JSON.stringify(notesBottom));
    const notesBottomBar = await pinnedBar(page);
    assert.equal(notesBottomBar.barTop, notesBar.barTop, JSON.stringify({ notesBar, notesBottomBar }));
    const notesBottomClear = await clearOfClose(page, '#field-notes, #flag-extra-work');
    assert.equal(notesBottomClear.overlap, false, JSON.stringify(notesBottomClear));
    await scrollStep(page, 'top');
    const notesClear = await clearOfClose(page, '#field-notes');
    assert.equal(notesClear.overlap, false, JSON.stringify(notesClear));
    assert.equal(notesClear.closeHit, true, JSON.stringify(notesClear));
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
    assert.equal(hintClear.closeHit, true, JSON.stringify(hintClear));
    const reviewHeader = await headerCascade(page);
    assert.equal(reviewHeader.position, 'sticky', JSON.stringify(reviewHeader));
    assert.equal(reviewHeader.height, '48px', JSON.stringify(reviewHeader));
    assert.equal(reviewHeader.besideHeader, true, JSON.stringify(reviewHeader));
    await assertScrollRegions(page, 'review');
    const reviewBar = await pinnedBar(page);
    assert.ok(reviewBar.barBottom <= reviewBar.viewH + 1 && reviewBar.barTop >= reviewBar.viewH - 180, JSON.stringify(reviewBar));
    assert.ok(reviewBar.scrollerBottom <= reviewBar.barTop + 1 && reviewBar.scrollerTop >= 48, JSON.stringify(reviewBar));
    assert.equal(reviewBar.closeInside, true, JSON.stringify(reviewBar));
    await scrollStep(page, 'mid');
    const reviewMiddle = await headerCascade(page);
    assert.equal(reviewMiddle.besideHeader, true, JSON.stringify(reviewMiddle));
    const reviewMiddleClear = await clearOfClose(page, '.field-review-card, #field-edit-hours, #field-review-cards p');
    assert.equal(reviewMiddleClear.overlap, false, JSON.stringify(reviewMiddleClear));
    await scrollStep(page, 'end');
    const reviewBottom = await headerCascade(page);
    assert.equal(reviewBottom.besideHeader, true, JSON.stringify(reviewBottom));
    const reviewBottomBar = await pinnedBar(page);
    assert.equal(reviewBottomBar.barTop, reviewBar.barTop, JSON.stringify({ reviewBar, reviewBottomBar }));
    const reviewBottomClear = await clearOfClose(page, '.field-review-card, #field-edit-hours, #field-review-cards p, .production-quantity');
    assert.equal(reviewBottomClear.overlap, false, JSON.stringify(reviewBottomClear));
    await scrollStep(page, 'top');
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
    await assertScrollRegions(page, 'qty');
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
    const qtyTop = await pinnedBar(page);
    assert.equal(qtyTop.closeInside, true, JSON.stringify(qtyTop));
    assert.ok(qtyTop.barBottom <= qtyTop.viewH + 1 && qtyTop.barTop >= qtyTop.viewH - 180, JSON.stringify(qtyTop));
    assert.ok(qtyTop.scrollerBottom <= qtyTop.barTop + 1, JSON.stringify(qtyTop));
    await scrollStep(page, 'end');
    const qtyBottom = await pinnedBar(page);
    assert.equal(qtyBottom.barTop, qtyTop.barTop, JSON.stringify({ qtyTop, qtyBottom }));
    assert.equal(qtyBottom.closeInside, true, JSON.stringify(qtyBottom));
    const qtyClear = await clearOfClose(page, '.production-quantity, .field-review-card, #field-edit-hours');
    assert.equal(qtyClear.overlap, false, JSON.stringify(qtyClear));
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
