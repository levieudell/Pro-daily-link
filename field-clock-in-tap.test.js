'use strict';
// Clock in opens #start-day-modal on the first tap from My Day and from Time.
// Clock out from My Day and Time ends the day on the first tap and opens the daily.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

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
  const started = await page.evaluate(() => {
    const project = document.querySelector('#start-day-project');
    for (const box of document.querySelectorAll('#start-day-members input')) {
      const label = box.closest('label')?.textContent || '';
      const keep = /Jordan Reed/i.test(label);
      if (box.checked !== keep) box.click();
    }
    return {
      project: project?.value || '',
      people: [...document.querySelectorAll('#start-day-members input:checked')].map(box => box.closest('label')?.innerText || '')
    };
  });
  assert.equal(started.project, '3', 'clock-in stays on Cedar Grove');
  assert.equal(started.people.length, 1, JSON.stringify(started.people));
  await page.click('#confirm-start-day');
  await page.waitForFunction(() => {
    const button = document.querySelector('#start-day-button');
    const modal = document.querySelector('#start-day-modal');
    return button && /Clock out/i.test(button.textContent || '') && modal && !modal.open;
  }, { timeout: 20000 });
}

async function assertDailyOpened(page, from) {
  await page.waitForSelector('#report-modal[open] #field-notes', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#report-form')?.getAttribute('data-current-step') === '1', { timeout: 10000 });
  const landed = await page.evaluate(() => ({
    step: document.querySelector('#report-form')?.getAttribute('data-current-step'),
    photos: Boolean(document.querySelector('#report-modal[open] .daily-photos-hit')),
    endOpen: Boolean(document.querySelector('#end-day-modal')?.open),
    painted: window.__endDayPainted === true,
    title: document.querySelector('#report-modal-title')?.textContent?.trim() || '',
    page: document.querySelector('.page.active')?.id || '',
    clock: document.querySelector('#start-day-button')?.textContent?.trim() || ''
  }));
  assert.equal(landed.step, '1', from);
  assert.equal(landed.photos, true, from);
  assert.equal(landed.endOpen, false, from);
  assert.equal(landed.painted, false, from);
  assert.equal(landed.title, 'Verify daily report', from);
  assert.equal(landed.page, 'reports-page', from);
  assert.equal(landed.clock, 'Clock in', `${from} ended the workday`);
}

(async () => {
  assert.ok(fs.existsSync(CHROME), `Chrome is required (${CHROME})`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-clock-tap-'));
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
    await page.evaluateOnNewDocument(() => {
      try {
        localStorage.setItem('pdl-analytics-consent', 'declined');

      } catch {}
      window.__endDayPainted = false;
      const watch = () => {
        const modal = document.querySelector('#end-day-modal');
        if (!modal || modal.dataset.watched === '1') return;
        modal.dataset.watched = '1';
        const mark = () => { if (modal.open) window.__endDayPainted = true; };
        mark();
        new MutationObserver(mark).observe(modal, { attributes: true, attributeFilter: ['open'] });
      };
      document.addEventListener('DOMContentLoaded', watch);
      setInterval(watch, 50);
    });
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    page.on('dialog', async dialog => { await dialog.dismiss(); });
    await login(page, port);
    await page.waitForSelector('#myday-page.active [data-start-day]', { timeout: 20000 });
    assert.equal(await page.$eval('[data-start-day]', el => el.textContent.trim()), 'Clock in');
    assert.equal(await page.$eval('#start-day-modal', el => el.open), false);

    await tap(page, '[data-start-day]');
    await page.waitForSelector('#start-day-modal[open]', { timeout: 5000 });
    assert.equal(await page.$eval('.page.active', el => el.id), 'myday-page');

    await page.evaluate(() => document.querySelector('#start-day-modal').close());
    await page.waitForFunction(() => !document.querySelector('#start-day-modal').open);
    await page.evaluate(() => document.querySelector('.nav-item[data-page="fieldday"]').click());
    await page.waitForSelector('#fieldday-page.active #start-day-button', { timeout: 10000 });
    assert.equal(await page.$eval('#start-day-button', el => el.textContent.trim()), 'Clock in');
    assert.equal(await page.$eval('#start-day-modal', el => el.open), false);

    await tap(page, '#start-day-button');
    await page.waitForSelector('#start-day-modal[open]', { timeout: 5000 });
    assert.equal(await page.$eval('.page.active', el => el.id), 'fieldday-page');

    await clockIn(page);
    await page.evaluate(() => document.querySelector('.nav-item[data-page="myday"]').click());
    await page.waitForSelector('#myday-page.active [data-start-day]', { timeout: 10000 });
    assert.equal(await page.$eval('[data-start-day]', el => el.textContent.trim()), 'Clock out');
    assert.equal(await page.$eval('#report-modal', el => el.open), false);
    await page.evaluate(() => {
      window.__clockOutTiming = {};
      const button = document.querySelector('#myday-page [data-start-day]'), modal = document.querySelector('#report-modal');
      button.addEventListener('click', () => { window.__clockOutTiming.start = performance.now(); }, { capture: true, once: true });
      const observer = new MutationObserver(() => {
        if (!modal.open) return;
        observer.disconnect();
        requestAnimationFrame(() => {
          const notes = document.querySelector('#field-notes');
          window.__clockOutTiming.visible = notes.checkVisibility() && notes.getBoundingClientRect().height > 0;
          window.__clockOutTiming.elapsed = performance.now() - window.__clockOutTiming.start;
        });
      });
      observer.observe(modal, { attributes: true, attributeFilter: ['open'] });
    });
    await tap(page, '[data-start-day]');
    await assertDailyOpened(page, 'My Day Clock out');
    await page.waitForFunction(() => Number.isFinite(window.__clockOutTiming?.elapsed));
    const clockOutTiming = await page.evaluate(() => window.__clockOutTiming);
    assert(clockOutTiming.visible && clockOutTiming.elapsed <= 1000, 'warm My Day opens the daily within 1 second: ' + JSON.stringify(clockOutTiming));
    console.log(`Warm 390x844 My Day: one Clock out tap to visible daily in ${Math.round(clockOutTiming.elapsed)}ms.`);

    await page.evaluate(() => document.querySelector('#report-modal').close());
    await page.waitForFunction(() => !document.querySelector('#report-modal').open);
    await page.evaluate(() => document.querySelector('.nav-item[data-page="fieldday"]').click());
    await page.waitForSelector('#fieldday-page.active #start-day-button', { timeout: 10000 });
    assert.equal(await page.$eval('#start-day-button', el => el.textContent.trim()), 'Clock in');
    await tap(page, '#start-day-button');
    await page.waitForSelector('#start-day-modal[open]', { timeout: 5000 });
    assert.equal(await page.$eval('.page.active', el => el.id), 'fieldday-page');
    await clockIn(page);
    assert.equal(await page.$eval('#fieldday-page.active #start-day-button', el => el.textContent.trim()), 'Clock out');
    await tap(page, '#start-day-button');
    await assertDailyOpened(page, 'Time Clock out');
    console.log('Clock in and Clock out opened on the first tap from My Day and Time.');
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
