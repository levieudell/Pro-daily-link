'use strict';
// Phone daily: Daily photos and Flag extra work stay visible at 390px,
// a real file chooser attaches a jpg, and the sent report shows that photo.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const SHOTS = '/opt/cursor/artifacts/screenshots';
const FIELD_EMAIL = 'levi+field@prodailylink.com';
const FIELD_PASSWORD = 'staging-field-pass';
const CHROME = process.env.PDL_TEST_CHROME || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : '/usr/bin/google-chrome-stable');
const JPEG = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda000c03010002110311003f00fbd5ffd9',
  'hex'
);

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

async function shot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: false });
}

async function login(page, port) {
  await page.goto(`http://127.0.0.1:${port}/login.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#email');
  await page.$eval('#email', (el, value) => { el.value = value; }, FIELD_EMAIL);
  await page.$eval('#password', (el, value) => { el.value = value; }, FIELD_PASSWORD);
  await page.click('form#login button.primary');
  await page.waitForFunction(() => location.pathname.includes('/app'), { timeout: 20000 });
  await page.waitForSelector('#menu-button', { timeout: 20000 });
  const consent = await page.$('#pdl-consent-banner button, #pdl-consent-banner [data-decline], #pdl-consent-banner .secondary');
  if (consent) await consent.click().catch(() => {});
}

async function reveal(page, selector) {
  await page.evaluate(sel => {
    const el = document.querySelector(sel);
    const scroller = document.querySelector('#report-modal form');
    el?.scrollIntoView({ block: 'center' });
    const actions = document.querySelector('.report-step.active .modal-actions');
    if (!el || !scroller || !actions) return;
    const overlap = el.getBoundingClientRect().bottom - actions.getBoundingClientRect().top;
    if (overlap > -8) scroller.scrollTop += overlap + 16;
  }, selector);
}

async function controlBox(page, selector) {
  await reveal(page, selector);
  return page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (!el) return { missing: true };
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const actions = document.querySelector('.report-step.active .modal-actions')?.getBoundingClientRect();
    const covered = actions ? box.bottom > actions.top + 1 && box.top < actions.bottom && box.right > actions.left && box.left < actions.right : false;
    return {
      width: box.width,
      height: box.height,
      top: box.top,
      bottom: box.bottom,
      left: box.left,
      right: box.right,
      display: style.display,
      visibility: style.visibility,
      opacity: Number(style.opacity),
      covered,
      viewport: window.innerWidth
    };
  }, selector);
}

function assertReachable(box, label) {
  assert.equal(box.missing, undefined, `${label} is missing`);
  assert.notEqual(box.display, 'none', `${label} is display:none ${JSON.stringify(box)}`);
  assert.notEqual(box.visibility, 'hidden', label);
  assert.ok(box.opacity > 0, `${label} is transparent ${JSON.stringify(box)}`);
  assert.ok(box.width >= 48 && box.height >= 48, `${label} tap target ${JSON.stringify(box)}`);
  assert.ok(box.left >= -1 && box.right <= box.viewport + 1, `${label} is off-screen ${JSON.stringify(box)}`);
  assert.equal(box.covered, false, `${label} sits under the step actions ${JSON.stringify(box)}`);
}

(async () => {
  assert.ok(fs.existsSync(CHROME), `Chrome is required for the phone photo test (${CHROME})`);
  assert.equal(JPEG[0], 0xff);
  assert.equal(JPEG[1], 0xd8);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-phone-photo-'));
  const photo = path.join(root, 'daily.jpg');
  fs.writeFileSync(photo, JPEG);
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
      localStorage.setItem('pdl-analytics-consent', 'declined');
      localStorage.setItem('pdl-field-tip', 'dismissed');
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
    page.on('dialog', async dialog => { await dialog.dismiss(); });
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await login(page, port);
    await page.waitForSelector('#myday-page.active [data-assignment-daily]', { timeout: 20000 });
    await page.evaluate(() => document.querySelector('[data-assignment-daily]')?.click());
    await page.waitForSelector('#report-modal[open] #field-notes', { timeout: 20000 });
    await page.waitForSelector('#report-modal[open] #flag-extra-work');
    await page.waitForSelector('#report-modal[open] .daily-photos-hit');

    const inputMeta = await page.$eval('#report-photos', el => ({
      type: el.type,
      accept: el.getAttribute('accept'),
      capture: el.getAttribute('capture'),
      multiple: el.multiple
    }));
    assert.equal(inputMeta.type, 'file');
    assert.equal(inputMeta.accept, 'image/*');
    assert.equal(inputMeta.capture, 'environment');
    assert.equal(inputMeta.multiple, true);

    for (const width of [360, 390, 430]) {
      await page.setViewport({ width, height: 844, isMobile: true, hasTouch: true });
      const flag = await controlBox(page, '#flag-extra-work');
      const photos = await controlBox(page, '.daily-photos-hit');
      assertReachable(flag, `flag ${width}`);
      assertReachable(photos, `photos ${width}`);
      assert.equal(await page.$eval('#report-form', el => el.getAttribute('data-current-step')), '1', `notes step at ${width}`);
    }
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    await shot(page, 'c1-notes-390.png');

    const legacyBefore = await page.evaluate(() => ({
      painted: window.__endDayPainted === true,
      open: Boolean(document.querySelector('#end-day-modal')?.open),
      text: document.querySelector('#end-day-modal')?.open ? (document.body.innerText || '') : ''
    }));
    assert.equal(legacyBefore.painted, false);
    assert.equal(legacyBefore.open, false);
    assert.equal(/What was completed\?/.test(legacyBefore.text), false);

    await reveal(page, '#report-photos');
    const point = await page.$eval('#report-photos', el => {
      const box = el.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2, width: box.width, height: box.height, opacity: getComputedStyle(el).opacity };
    });
    assert.ok(point.width >= 48 && point.height >= 48, JSON.stringify(point));
    const [chooser] = await Promise.all([
      page.waitForFileChooser({ timeout: 5000 }),
      page.mouse.click(point.x, point.y)
    ]);
    assert.equal(chooser.isMultiple(), true);
    await chooser.accept([photo]);
    await page.waitForSelector('#report-photo-preview img', { timeout: 5000 });
    const preview = await page.$eval('#report-photo-preview img', el => ({ alt: el.alt, src: el.src.slice(0, 24), width: el.getBoundingClientRect().width }));
    assert.match(preview.src, /^blob:/);
    assert.ok(preview.width >= 48, JSON.stringify(preview));
    const chosenCount = await page.$eval('#report-photos', el => el.files.length);
    assert.equal(chosenCount, 1);
    await shot(page, 'c1-photo-chosen-390.png');

    await reveal(page, '#flag-extra-work');
    await page.click('#flag-extra-work');
    await page.waitForSelector('#field-scope-flags [data-flag-choice="yes"]', { timeout: 5000 });
    assert.equal(await page.$eval('#report-form', el => el.getAttribute('data-current-step')), '2');
    const ask = await page.$eval('#field-scope-flags', el => el.innerText || '');
    assert.match(ask, /Extra work\?/);
    const reviewFlag = await controlBox(page, '#flag-extra-work');
    const reviewPhotos = await controlBox(page, '.daily-photos-hit');
    assertReachable(reviewFlag, 'flag review');
    assertReachable(reviewPhotos, 'photos review');
    assert.equal(await page.$eval('#report-photo-preview img', el => el.getBoundingClientRect().width) > 0, true);
    await shot(page, 'c1-extra-flag-390.png');

    await page.click('[data-flag-choice="yes"]');
    await page.waitForFunction(() => document.querySelector('[data-flag-choice="yes"]')?.classList.contains('is-selected') === true);
    await page.click('#save-report');
    try {
      await page.waitForSelector('#report-sent-modal[open]', { timeout: 20000 });
    } catch (error) {
      const status = await page.$eval('#report-submit-status', el => el.textContent || '').catch(() => '');
      throw new Error(`${error.message}\n${status}\n${log.slice(-2000)}`);
    }
    await shot(page, 'c1-sent-390.png');
    await page.click('#report-sent-modal button.primary');
    await page.waitForSelector('#report-detail img.report-photo', { timeout: 20000 });
    const shown = await page.evaluate(async () => {
      const image = document.querySelector('#report-detail img.report-photo');
      const src = image?.getAttribute('src') || '';
      const response = src ? await fetch(src) : null;
      const bytes = response ? new Uint8Array(await response.arrayBuffer()) : [];
      return {
        src,
        ok: response?.ok || false,
        type: response?.headers.get('content-type') || '',
        size: bytes.length,
        jpeg: bytes[0] === 0xff && bytes[1] === 0xd8,
        endOpen: Boolean(document.querySelector('#end-day-modal')?.open),
        painted: window.__endDayPainted === true
      };
    });
    assert.match(shown.src, /\/uploads\//);
    assert.equal(shown.ok, true, JSON.stringify(shown));
    assert.match(shown.type, /image\/jpeg/);
    assert.equal(shown.jpeg, true, JSON.stringify(shown));
    assert.equal(shown.endOpen, false);
    assert.equal(shown.painted, false);
    await page.evaluate(() => document.querySelector('#report-detail img.report-photo')?.scrollIntoView({ block: 'center' }));
    await shot(page, 'c1-report-photo-390.png');
    console.log('Phone daily photo and extra-work flag passed at 390px.');
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
