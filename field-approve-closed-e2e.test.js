'use strict';
// 390px: Approve stays blocked while an extra-work Office decision is still
// Choose, and a review sent during an open punch counts only closed minutes.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const NOTES = 'Poured 40 LF of curb. Extra work: owner asked us to patch the gate.';
const CLOSED_MINUTES = 2;
const OPEN_MINUTES = 5;
const MESSAGE = 'Mark each extra-work item Billable or Not billable to approve';
const CLOCK_COPY = "Clock out to include today's time";
const FIELD_EMAIL = 'levi+field@prodailylink.com';
const OWNER_EMAIL = 'levi+owner@prodailylink.com';
const FIELD_PASSWORD = 'staging-field-pass';
const OWNER_PASSWORD = 'staging-owner-pass';

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
}

async function login(page, email, password) {
  await page.goto(`http://127.0.0.1:${page.__port}/login.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#email');
  await page.$eval('#email', (el, value) => { el.value = value; }, email);
  await page.$eval('#password', (el, value) => { el.value = value; }, password);
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

async function waitUntil(page, predicate, label) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < 20000) {
    last = await page.evaluate(predicate);
    if (last === true) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

async function startJordan(page) {
  await openNav(page, 'fieldday');
  await page.waitForFunction(() => /Clock in/i.test(document.querySelector('#start-day-button')?.textContent || ''), { timeout: 20000 });
  await page.click('#start-day-button');
  await page.waitForSelector('#start-day-modal[open] #start-day-members input');
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
}

async function gateReport(page) {
  return page.evaluate(async () => {
    const state = await (await fetch('/api/state', { credentials: 'include' })).json();
    return (state.reports || []).find(row => /patch the gate/i.test(row.notes || row.originalNotes || '')) || null;
  });
}

(async () => {
  assert.ok(fs.existsSync('/usr/bin/google-chrome-stable'), 'Chrome is required for the approve and closed-punch test');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-approve-closed-'));
  const port = await freePort();
  const dbFile = path.join(root, 'db.json');
  const env = { ...process.env, PORT: String(port), PDL_STAGING: '1', PDL_STAGING_OWNER_PASSWORD: OWNER_PASSWORD, PDL_STAGING_FIELD_PASSWORD: FIELD_PASSWORD, PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: path.join(root, 'platform.json'), PDL_EMAIL_DEV_MODE: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', OPENAI_API_KEY: '' };
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
    await login(page, FIELD_EMAIL, FIELD_PASSWORD);
    await startJordan(page);
    pinOpenPunch(dbFile, CLOSED_MINUTES);
    await page.click('#start-day-button');
    await page.waitForSelector('#end-day-modal[open] #end-day-notes', { timeout: 20000 });
    await page.$eval('#end-day-notes', (el, value) => { el.value = value; }, NOTES);
    await page.click('#confirm-end-day');
    await page.waitForFunction(closed => {
      const modal = document.querySelector('#report-modal');
      if (!modal?.open || document.querySelector('#end-day-modal')?.open) return false;
      if (document.querySelector('#report-form')?.getAttribute('data-current-step') !== '2') return false;
      const curb = [...document.querySelectorAll('.production-entry')].some(row => row.dataset.estimateItemId === '1' && row.querySelector('.production-quantity')?.value === '40');
      const minutes = [...document.querySelectorAll('[data-review-labor]')].reduce((sum, input) => sum + (Number(input.value) || 0), 0);
      return curb && minutes === closed && !document.querySelector('.field-clock-warning');
    }, { timeout: 20000 }, CLOSED_MINUTES);
    await page.evaluate(() => document.querySelector('[data-flag-choice="yes"]')?.click());
    await page.waitForFunction(() => document.querySelector('[data-flag-choice="yes"]')?.getAttribute('aria-pressed') === 'true', { timeout: 20000 });
    const restarted = await page.evaluate(async () => {
      const response = await fetch('/api/workdays/start', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 3, memberIds: [1] })
      });
      const body = await response.json();
      return { status: response.status, error: body.error || '', id: body.id || null };
    });
    assert.equal(restarted.status, 201, JSON.stringify(restarted));
    pinOpenPunch(dbFile, OPEN_MINUTES);
    await page.evaluate(async () => { if (typeof refreshTimeCards === 'function') await refreshTimeCards(); });
    await waitUntil(page, () => {
      const open = (typeof timeCards === 'undefined' ? [] : timeCards).filter(card => card && card.inAt && !card.outAt && !card.deletedAt);
      return open.some(card => Math.floor((Date.now() - new Date(card.inAt).getTime()) / 60000) >= 5);
    }, 'open punch is at least 5 minutes');
    await page.evaluate(() => { if (typeof renderFieldReview === 'function') renderFieldReview(); });
    const review = await page.evaluate(() => ({
      warning: document.querySelector('.field-clock-warning')?.textContent || '',
      total: document.querySelector('.field-labor-total')?.textContent || '',
      minutes: [...document.querySelectorAll('[data-review-labor]')].reduce((sum, input) => sum + (Number(input.value) || 0), 0),
      sendDisabled: document.querySelector('#save-report')?.disabled === true
    }));
    assert.equal(review.warning, CLOCK_COPY, JSON.stringify(review));
    assert.match(review.total, /2 min · 0\.03 h/, JSON.stringify(review));
    assert.equal(review.minutes, CLOSED_MINUTES, JSON.stringify(review));
    assert.equal(review.sendDisabled, false, JSON.stringify(review));
    await page.evaluate(() => document.querySelector('#save-report')?.click());
    await page.waitForSelector('#report-sent-modal[open]', { timeout: 20000 });
    const sent = await gateReport(page);
    const laborMinutes = (sent?.laborEntries || []).reduce((sum, row) => sum + (Number(row.minutes) || 0), 0);
    const laborHours = (sent?.laborEntries || []).reduce((sum, row) => sum + (Number(row.hours) || 0), 0);
    const productionMinutes = (sent?.productionEntries || []).reduce((sum, row) => sum + (Number(row.laborMinutes) || 0), 0);
    assert.equal(sent?.status, 'Needs review', sent?.status);
    assert.equal(laborMinutes, CLOSED_MINUTES, JSON.stringify(sent?.laborEntries));
    assert.equal(Math.round(laborHours * 100) / 100, 0.03, JSON.stringify(sent?.laborEntries));
    assert.equal(productionMinutes, CLOSED_MINUTES, JSON.stringify(sent?.productionEntries));
    assert.equal(sent?.extraWork?.[0]?.extra_work, true, JSON.stringify(sent?.extraWork));
    assert.equal(typeof sent?.extraWork?.[0]?.billable, 'undefined', JSON.stringify(sent?.extraWork));
    const stillOpen = await page.evaluate(async () => {
      const state = await (await fetch('/api/state', { credentials: 'include' })).json();
      return (state.timeCards || []).filter(card => card && card.inAt && !card.outAt && !card.deletedAt).map(card => ({
        memberId: Number(card.memberId),
        minutes: Math.floor((Date.now() - new Date(card.inAt).getTime()) / 60000)
      }));
    });
    assert.equal(stillOpen.some(card => card.memberId === 1 && card.minutes >= OPEN_MINUTES), true, JSON.stringify(stillOpen));
    const ownerContext = await browser.createBrowserContext();
    const owner = await ownerContext.newPage();
    owner.__port = port;
    await owner.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    owner.on('dialog', async dialog => { await dialog.accept(); });
    await owner.evaluateOnNewDocument(() => {
      localStorage.setItem('pdl-analytics-consent', 'declined');
    });
    await login(owner, OWNER_EMAIL, OWNER_PASSWORD);
    await openNav(owner, 'reports');
    await owner.waitForSelector('#office-decision', { timeout: 20000 });
    const blockedUi = await owner.evaluate(() => ({
      decision: document.querySelector('#office-decision')?.value ?? null,
      disabled: document.querySelector('[data-approve-report]')?.disabled ?? null,
      help: document.querySelector('#report-detail .input-help')?.textContent || ''
    }));
    assert.equal(blockedUi.decision, '', JSON.stringify(blockedUi));
    assert.equal(blockedUi.disabled, true, JSON.stringify(blockedUi));
    assert.match(blockedUi.help, /Mark each extra-work item Billable or Not billable to approve/, JSON.stringify(blockedUi));
    const blockedApi = await owner.evaluate(async () => {
      const state = await (await fetch('/api/state', { credentials: 'include' })).json();
      const report = (state.reports || []).find(row => /patch the gate/i.test(row.notes || row.originalNotes || ''));
      const response = await fetch(`/api/reports/${report.id}/approve`, { method: 'PATCH', credentials: 'include' });
      const body = await response.json();
      return { status: response.status, error: body.error || '' };
    });
    assert.equal(blockedApi.status, 409, JSON.stringify(blockedApi));
    assert.equal(blockedApi.error, MESSAGE, JSON.stringify(blockedApi));
    await owner.select('#office-decision', 'non_billable');
    await waitUntil(owner, () => {
      const button = document.querySelector('[data-approve-report]');
      const help = document.querySelector('#report-detail .input-help')?.textContent || '';
      return Boolean(button && !button.disabled && !/Billable or Not billable to approve/.test(help));
    }, 'approve enabled after Not billable');
    await owner.click('[data-approve-report]');
    await waitUntil(owner, async () => {
      const state = await (await fetch('/api/state', { credentials: 'include' })).json();
      const report = (state.reports || []).find(row => /patch the gate/i.test(row.notes || row.originalNotes || ''));
      const minutes = (report?.laborEntries || []).reduce((sum, row) => sum + (Number(row.minutes) || 0), 0);
      return report?.status === 'Approved' && minutes === 2;
    }, 'approve saved the closed minutes');
    console.log('Approve gate and closed-punch browser flow passed.');
  } finally {
    if (browser) await browser.close();
    child.kill();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
