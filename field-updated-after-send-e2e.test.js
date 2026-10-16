'use strict';
// 390px: a punch that lands on an already-sent daily flags the office list
// and the report, and the log names what changed. Sending a daily must not
// record an automatic punch recalculation as a person's labor correction.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const NOTES = 'Poured 40 LF of curb and 20 LF of gutter. Used 6 yards of concrete. Owner asked us to add an extra equipment pad.';
const SECOND_NOTES = 'Poured 10 more LF of curb on the north side.';
const SECOND_NEXT = 'Set the driveway apron forms.';
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

async function gutterReport(page) {
  return page.evaluate(async () => {
    const state = await (await fetch('/api/state', { credentials: 'include' })).json();
    return (state.reports || []).find(row => /gutter/i.test(row.notes || row.originalNotes || '')) || null;
  });
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

(async () => {
  assert.ok(fs.existsSync('/usr/bin/google-chrome-stable'), 'Chrome is required for the updated-after-send test');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-updated-after-send-'));
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
    pinOpenPunch(dbFile, 2);
    await page.click('#start-day-button');
    await page.waitForSelector('#end-day-modal[open] #end-day-notes', { timeout: 20000 });
    await page.$eval('#end-day-notes', (el, value) => { el.value = value; }, NOTES);
    await page.click('#confirm-end-day');
    await page.waitForFunction(() => {
      const modal = document.querySelector('#report-modal');
      if (!modal?.open || document.querySelector('#end-day-modal')?.open) return false;
      if (document.querySelector('#report-form')?.getAttribute('data-current-step') !== '2') return false;
      const lines = [...document.querySelectorAll('.production-entry')];
      const curb = lines.some(row => row.dataset.estimateItemId === '1' && row.querySelector('.production-quantity')?.value === '40');
      const gutter = lines.some(row => row.dataset.estimateItemId === '5' && row.querySelector('.production-quantity')?.value === '20');
      const minutes = [...document.querySelectorAll('[data-review-labor]')].reduce((sum, input) => sum + (Number(input.value) || 0), 0);
      return curb && gutter && minutes === 2;
    }, { timeout: 20000 });
    await page.evaluate(() => document.querySelector('[data-flag-choice="yes"]')?.click());
    await page.evaluate(() => document.querySelector('#save-report')?.click());
    await page.waitForSelector('#report-sent-modal[open]', { timeout: 20000 });
    await page.click('#report-sent-modal button.primary');
    await openNav(page, 'reports');
    await page.waitForFunction(() => /Labor recalculated from punches by Time cards/.test(document.querySelector('.approval-history')?.innerText || ''), { timeout: 20000 });
    const sentLog = await page.evaluate(() => document.querySelector('.approval-history')?.innerText || '');
    const sentLines = sentLog.split('\n').map(line => line.trim()).filter(Boolean);
    assert.deepEqual(sentLines.map(line => line.replace(/ · .*$/, '')), [
      'Draft created from workday by Field team',
      'Labor recalculated from punches by Time cards'
    ], sentLog);
    assert.equal(/Corrected/i.test(sentLog), false, sentLog);
    const sent = await gutterReport(page);
    assert.equal(sent?.updatedAfterSend || null, null, JSON.stringify(sent?.updatedAfterSend));
    assert.equal(sent?.status, 'Needs review', sent?.status);
    assert.deepEqual((sent?.history || []).map(row => `${row.action} by ${row.by}`), [
      'Draft created from workday by Field team',
      'Labor recalculated from punches by Time cards'
    ], JSON.stringify(sent?.history));
    assert.equal((sent?.laborEntries || []).some(row => row.source === 'punch' && Math.abs(Number(row.hours) - 0.03) < 0.001), true, JSON.stringify(sent?.laborEntries));
    await startJordan(page);
    pinOpenPunch(dbFile, 3);
    await page.click('#start-day-button');
    await page.waitForSelector('#end-day-modal[open] #end-day-notes', { timeout: 20000 });
    await page.$eval('#end-day-notes', (el, value) => { el.value = value; }, SECOND_NOTES);
    await page.$eval('#end-day-next', (el, value) => { el.value = value; }, SECOND_NEXT);
    await page.click('#confirm-end-day');
    await page.waitForFunction(() => /Clock in/i.test(document.querySelector('#start-day-button')?.textContent || '') && !document.querySelector('#end-day-modal')?.open && !document.querySelector('#report-modal')?.open, { timeout: 20000 });
    const flagged = await page.evaluate(async () => {
      const state = await (await fetch('/api/state', { credentials: 'include' })).json();
      const report = (state.reports || []).find(row => /gutter/i.test(row.notes || row.originalNotes || ''));
      const line = (report?.history || []).find(row => /Updated after send/i.test(String(row.action || '')));
      return {
        summary: report?.updatedAfterSend?.summary || '',
        by: report?.updatedAfterSend?.by || '',
        action: line?.action || '',
        lineBy: line?.by || '',
        labor: (report?.laborEntries || []).map(row => Number(row.hours) || 0),
        next: report?.next || ''
      };
    });
    assert.match(flagged.summary, /Labor 0\.03h → 0\.08h/);
    assert.match(flagged.summary, /next step changed/);
    assert.equal(flagged.by, "DEMO Jordan Reed's clock-out", JSON.stringify(flagged));
    assert.match(`${flagged.action} by ${flagged.lineBy}`, /Labor 0\.03h → 0\.08h, next step changed, by DEMO Jordan Reed's clock-out/);
    assert.equal(flagged.labor.some(hours => Math.abs(hours - 0.08) < 0.001), true, JSON.stringify(flagged.labor));
    assert.equal(flagged.next, SECOND_NEXT, flagged.next);
    const fieldClear = await page.evaluate(async () => {
      const state = await (await fetch('/api/state', { credentials: 'include' })).json();
      const report = (state.reports || []).find(row => /gutter/i.test(row.notes || row.originalNotes || ''));
      const response = await fetch(`/api/reports/${report.id}/reviewed`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } });
      const after = await (await fetch('/api/state', { credentials: 'include' })).json();
      const saved = (after.reports || []).find(row => row.id === report.id);
      return { status: response.status, summary: saved?.updatedAfterSend?.summary || '', reviewed: saved?.updatedAfterSendReviewed || null };
    });
    assert.equal(fieldClear.status, 403, JSON.stringify(fieldClear));
    assert.match(fieldClear.summary, /Labor 0\.03h → 0\.08h/);
    assert.equal(fieldClear.reviewed, null, JSON.stringify(fieldClear));
    await openNav(page, 'reports');
    await page.waitForSelector('#report-list', { timeout: 20000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-button', { timeout: 20000 });
    await openNav(page, 'reports');
    const fieldStill = await gutterReport(page);
    assert.match(fieldStill?.updatedAfterSend?.summary || '', /Labor 0\.03h → 0\.08h/);
    assert.equal(fieldStill?.updatedAfterSendReviewed || null, null, JSON.stringify(fieldStill?.updatedAfterSendReviewed));
    const ownerContext = await browser.createBrowserContext();
    const owner = await ownerContext.newPage();
    owner.__port = port;
    await owner.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    owner.on('dialog', async dialog => { await dialog.accept(); });
    await owner.evaluateOnNewDocument(() => {
      localStorage.setItem('pdl-analytics-consent', 'declined');
      window.__updatedBadges = [];
      const watch = () => {
        const note = () => {
          for (const badge of document.querySelectorAll('[data-updated-after-send]')) {
            const text = badge.textContent || '';
            if (text && !window.__updatedBadges.includes(text)) window.__updatedBadges.push(text);
          }
        };
        new MutationObserver(note).observe(document.documentElement, { childList: true, subtree: true });
      };
      if (document.documentElement) watch();
      else addEventListener('DOMContentLoaded', watch);
    });
    await login(owner, OWNER_EMAIL, OWNER_PASSWORD);
    await openNav(owner, 'reports');
    await owner.waitForSelector('[data-report]', { timeout: 20000 });
    await owner.click('[data-report]');
    await waitUntil(owner, () => (window.__updatedBadges || []).includes('Updated after send'), 'owner list badge appeared');
    await waitUntil(owner, async () => {
      const state = await (await fetch('/api/state', { credentials: 'include' })).json();
      const report = (state.reports || []).find(row => /gutter/i.test(row.notes || row.originalNotes || ''));
      const reviewed = report?.updatedAfterSendReviewed;
      return Boolean(report && !report.updatedAfterSend && reviewed?.by === 'DEMO Avery Lang' && reviewed?.role === 'owner');
    }, 'owner open persisted the clear');
    const reviewedLog = await owner.evaluate(() => document.querySelector('.approval-history')?.innerText || '');
    assert.match(reviewedLog, /Labor 0\.03h → 0\.08h, next step changed, by DEMO Jordan Reed's clock-out/);
    assert.equal(/Corrected/i.test(reviewedLog), false, reviewedLog);
    await openNav(owner, 'dashboard');
    await openNav(owner, 'reports');
    const returned = await owner.evaluate(() => ({
      badge: document.querySelector('[data-updated-after-send]')?.textContent || '',
      banner: document.querySelector('[data-updated-after-send-banner]')?.innerText || ''
    }));
    assert.equal(returned.badge, '', JSON.stringify(returned));
    assert.equal(returned.banner, '', JSON.stringify(returned));
    await owner.reload({ waitUntil: 'domcontentloaded' });
    await owner.waitForSelector('#menu-button', { timeout: 20000 });
    await openNav(owner, 'reports');
    await owner.waitForFunction(() => /Labor 0\.03h → 0\.08h, next step changed, by DEMO Jordan Reed's clock-out/.test(document.querySelector('.approval-history')?.innerText || ''), { timeout: 20000 });
    const cleared = await owner.evaluate(() => ({
      badge: document.querySelector('[data-updated-after-send]')?.textContent || '',
      banner: document.querySelector('[data-updated-after-send-banner]')?.innerText || ''
    }));
    assert.equal(cleared.badge, '', JSON.stringify(cleared));
    assert.equal(cleared.banner, '', JSON.stringify(cleared));
    const clearedReport = await gutterReport(owner);
    assert.equal(clearedReport?.updatedAfterSend || null, null, JSON.stringify(clearedReport?.updatedAfterSend));
    assert.equal(clearedReport?.updatedAfterSendReviewed?.by, 'DEMO Avery Lang', JSON.stringify(clearedReport?.updatedAfterSendReviewed));
    assert.equal(clearedReport?.updatedAfterSendReviewed?.role, 'owner');
    const corrected = await owner.evaluate(async () => {
      const state = await (await fetch('/api/state', { credentials: 'include' })).json();
      const report = (state.reports || []).find(row => /gutter/i.test(row.notes || row.originalNotes || ''));
      const current = (report.laborEntries || []).reduce((sum, row) => sum + (Number(row.hours) || 0), 0);
      const hours = Math.round((current + 0.5) * 100) / 100;
      const productionEntries = (report.productionEntries || []).map((line, index) => ({ ...line, laborHours: index === 0 ? hours : 0, laborMinutes: null, laborManual: index === 0 }));
      const response = await fetch(`/api/reports/${report.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: report.status,
          laborEntries: [{ memberId: report.laborEntries[0].memberId, hours }],
          productionEntries
        })
      });
      const body = await response.json();
      return { status: response.status, history: body.history || [], error: body.error || '' };
    });
    assert.equal(corrected.status, 200, JSON.stringify(corrected));
    const manual = (corrected.history || []).filter(row => /Labor corrected/i.test(String(row.action || '')));
    assert.equal(manual.length, 1, JSON.stringify(corrected.history));
    assert.match(manual[0].action, /DEMO Jordan Reed: 0\.08h → 0\.58h/);
    assert.equal(manual[0].by, 'DEMO Avery Lang', JSON.stringify(manual));
    assert.equal((corrected.history || []).some(row => row.action === 'Labor recalculated from punches' && /Jordan Reed/.test(String(row.by || ''))), false, JSON.stringify(corrected.history));
    await owner.reload({ waitUntil: 'domcontentloaded' });
    await owner.waitForSelector('#menu-button', { timeout: 20000 });
    await openNav(owner, 'reports');
    await owner.waitForFunction(() => /Labor 0\.03h → 0\.08h, next step changed, by DEMO Jordan Reed's clock-out/.test(document.querySelector('.approval-history')?.innerText || ''), { timeout: 20000 });
    const stillClear = await owner.evaluate(() => ({
      badge: document.querySelector('[data-updated-after-send]')?.textContent || '',
      banner: document.querySelector('[data-updated-after-send-banner]')?.innerText || ''
    }));
    assert.equal(stillClear.badge, '', JSON.stringify(stillClear));
    assert.equal(stillClear.banner, '', JSON.stringify(stillClear));
    console.log('Updated-after-send browser flow passed.');
  } finally {
    if (browser) await browser.close();
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
