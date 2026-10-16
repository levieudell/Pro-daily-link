'use strict';
// 390px: after clock-out, the clock header and the field lists update
// without a reload, and a Next: clause in the notes becomes the next step.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const NOTES = 'Short check-in. Next: backfill curb.';
const FIELD_EMAIL = 'levi+field@prodailylink.com';
const FIELD_PASSWORD = 'staging-field-pass';

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
  return start;
}

async function login(page) {
  await page.goto(`http://127.0.0.1:${page.__port}/login.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#email');
  await page.$eval('#email', (el, value) => { el.value = value; }, FIELD_EMAIL);
  await page.$eval('#password', (el, value) => { el.value = value; }, FIELD_PASSWORD);
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

async function openClockIn(page) {
  await page.waitForFunction(() => /Clock in/i.test(document.querySelector('#start-day-button')?.textContent || ''), { timeout: 20000 });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.evaluate(() => document.querySelector('#start-day-button')?.click());
    const opened = await page.waitForSelector('#start-day-modal[open] #start-day-members input', { timeout: 8000 }).then(() => true).catch(() => false);
    if (opened) return;
  }
  await page.waitForSelector('#start-day-modal[open] #start-day-members input', { timeout: 20000 });
}

async function clockSurfaces(page) {
  return page.evaluate(() => ({
    label: document.querySelector('#field-clock-status-label')?.textContent || '',
    title: document.querySelector('#field-clock-title')?.textContent || '',
    detail: document.querySelector('#field-clock-detail')?.textContent || '',
    button: document.querySelector('#start-day-button')?.textContent || '',
    hours: document.querySelector('#field-clock-hours')?.innerText || '',
    hero: document.querySelector('#field-start-card h2')?.textContent || '',
    heroDetail: document.querySelector('#field-start-detail')?.textContent || '',
    reports: document.querySelector('#field-reports')?.innerText || '',
    next: document.querySelector('#report-next')?.value || '',
    reviewNext: document.querySelector('#field-review-next')?.value || '',
    active: (typeof workdays === 'undefined' ? [] : workdays).filter(row => row && row.status === 'active').map(row => row.id)
  }));
}

(async () => {
  assert.ok(fs.existsSync('/usr/bin/google-chrome-stable'), 'Chrome is required for the clock refresh test');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-clock-refresh-'));
  const port = await freePort();
  const dbFile = path.join(root, 'db.json');
  const env = { ...process.env, PORT: String(port), PDL_STAGING: '1', PDL_STAGING_OWNER_PASSWORD: 'staging-owner-pass', PDL_STAGING_FIELD_PASSWORD: FIELD_PASSWORD, PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: path.join(root, 'platform.json'), PDL_EMAIL_DEV_MODE: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', OPENAI_API_KEY: '' };
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
    await login(page);
    await openNav(page, 'fieldday');
    await openClockIn(page);
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
    pinOpenPunch(dbFile, 2);
    await page.evaluate(() => document.querySelector('#start-day-button')?.click());
    await page.waitForSelector('#end-day-modal[open] #end-day-notes', { timeout: 20000 });
    await page.$eval('#end-day-notes', (el, value) => { el.value = value; }, NOTES);
    await page.$eval('#end-day-next', el => { el.value = ''; });
    pinOpenPunch(dbFile, 2);
    await page.click('#confirm-end-day');
    try {
      await page.waitForFunction(() => {
        if (document.querySelector('#end-day-modal')?.open) return false;
        const label = document.querySelector('#field-clock-status-label')?.textContent || '';
        const hours = document.querySelector('#field-clock-hours')?.innerText || '';
        const reports = document.querySelector('#field-reports')?.innerText || '';
        const button = document.querySelector('#start-day-button')?.textContent || '';
        const next = `${document.querySelector('#report-next')?.value || ''}\n${document.querySelector('#field-review-next')?.value || ''}`;
        return /NOT CLOCKED IN/i.test(label) && /Clock in/i.test(button) && /2 min/.test(hours) && /Short check-in/i.test(reports) && /backfill curb/i.test(next);
      }, { timeout: 20000 });
    } catch (error) {
      const snapshot = await clockSurfaces(page);
      throw new Error(`${error.message}\n${JSON.stringify(snapshot, null, 2)}`);
    }
    const settled = await clockSurfaces(page);
    assert.equal(settled.active.length, 0, JSON.stringify(settled));
    assert.match(settled.label, /NOT CLOCKED IN/);
    assert.doesNotMatch(settled.detail, /Started/);
    assert.match(settled.button, /Clock in/);
    assert.match(settled.hours, /2 min/);
    assert.doesNotMatch(settled.hours, /Clock running/);
    assert.match(settled.hero, /Clock in/);
    assert.doesNotMatch(settled.heroDetail, /Started|since /);
    assert.match(settled.reports, /Short check-in/);
    const stored = await page.evaluate(async () => {
      const state = await (await fetch('/api/state', { credentials: 'include' })).json();
      return (state.reports || []).find(row => /Short check-in/i.test(row.notes || row.originalNotes || '')) || null;
    });
    assert.equal(stored?.next, 'backfill curb.', JSON.stringify(stored && { next: stored.next, notes: stored.notes }));
    assert.match(`${settled.next}\n${settled.reviewNext}`, /backfill curb/);
    await page.evaluate(() => {
      const modal = document.querySelector('#report-modal');
      if (modal?.open) modal.close();
    });
    await openNav(page, 'myday');
    const myDay = await clockSurfaces(page);
    assert.match(myDay.hero, /Clock in/, JSON.stringify(myDay));
    assert.doesNotMatch(myDay.heroDetail, /Started|since /, JSON.stringify(myDay));
    assert.match(myDay.reports, /Short check-in/, JSON.stringify(myDay));
    await openNav(page, 'fieldday');
    const clock = await clockSurfaces(page);
    assert.match(clock.label, /NOT CLOCKED IN/, JSON.stringify(clock));
    assert.doesNotMatch(clock.detail, /Started/, JSON.stringify(clock));
    assert.match(clock.hours, /2 min/, JSON.stringify(clock));
    assert.doesNotMatch(clock.hours, /Clock running/, JSON.stringify(clock));
    console.log('Clock refresh and next-step browser flow passed.');
  } finally {
    if (browser) await browser.close();
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
