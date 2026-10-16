'use strict';
// 390px: an approved extra-work decision stays on the report, and one punch
// shows the same whole-minute floor on the time card, clock-out modal, and draft.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const scope = require('./field-daily-scope');

const NOTES = 'Poured 40 LF of curb. Extra work: owner asked us to patch the gate.';
const SPAN_SECONDS = 168;
const FIELD_EMAIL = 'levi+field@prodailylink.com';
const OWNER_EMAIL = 'levi+owner@prodailylink.com';
const FIELD_PASSWORD = 'staging-field-pass';
const OWNER_PASSWORD = 'staging-owner-pass';
const DECISION = 'Billable · T&M';
const LOG_LINE = 'Extra work marked Billable · T&M by DEMO Avery Lang';

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

function pinOpenPunch(file, seconds) {
  const db = JSON.parse(fs.readFileSync(file, 'utf8'));
  const start = new Date(Date.now() - seconds * 1000).toISOString();
  let touched = false;
  for (const card of db.timeCards || []) if (card && card.inAt && !card.outAt) { card.inAt = start; touched = true; }
  for (const day of db.workdays || []) if (day && day.status === 'active') { day.startedAt = start; touched = true; }
  if (!touched) throw new Error('no open punch to pin');
  fs.writeFileSync(file, JSON.stringify(db));
  return start;
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

async function openClockIn(page) {
  await page.waitForFunction(() => /Clock in/i.test(document.querySelector('#start-day-button')?.textContent || ''), { timeout: 20000 });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.evaluate(() => document.querySelector('#start-day-button')?.click());
    const opened = await page.waitForSelector('#start-day-modal[open] #start-day-members input', { timeout: 8000 }).then(() => true).catch(() => false);
    if (opened) return;
  }
  await page.waitForSelector('#start-day-modal[open] #start-day-members input', { timeout: 20000 });
}

async function startJordan(page) {
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
}

async function gateReport(page) {
  return page.evaluate(async () => {
    const state = await (await fetch('/api/state', { credentials: 'include' })).json();
    return (state.reports || []).find(row => /patch the gate/i.test(row.notes || row.originalNotes || '')) || null;
  });
}

(async () => {
  assert.ok(fs.existsSync('/usr/bin/google-chrome-stable'), 'Chrome is required for the billing and rounding test');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-billing-round-'));
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
    const modalStart = pinOpenPunch(dbFile, SPAN_SECONDS);
    const modalCopy = await page.evaluate(start => {
      for (const day of workdays) if (day.status === 'active') day.startedAt = start;
      for (const card of timeCards) if (card && card.inAt && !card.outAt) card.inAt = start;
      const end = new Date(new Date(start).getTime() + 168000).toISOString();
      window.fieldLaborNow = () => new Date(end).getTime();
      const day = workdays.find(row => row.status === 'active');
      openEndDay(day.id);
      const summary = document.querySelector('#end-day-summary')?.innerText || '';
      const minutes = FieldDailyScope.elapsedMinutes(start, end);
      return { summary, minutes, label: FieldDailyScope.formatWorkTime(minutes), hours: FieldDailyScope.hoursFromMinutes(minutes) };
    }, modalStart);
    assert.equal(modalCopy.minutes, 2, JSON.stringify(modalCopy));
    assert.equal(modalCopy.hours, 0.03, JSON.stringify(modalCopy));
    assert.match(modalCopy.summary, /2 min · 0\.03 h/, JSON.stringify(modalCopy));
    await page.$eval('#end-day-notes', (el, value) => { el.value = value; }, NOTES);
    const savedStart = pinOpenPunch(dbFile, SPAN_SECONDS);
    await page.evaluate(start => {
      window.fieldLaborNow = () => Date.now();
      for (const day of workdays) if (day.status === 'active') day.startedAt = start;
      for (const card of timeCards) if (card && card.inAt && !card.outAt) card.inAt = start;
    }, savedStart);
    await page.click('#confirm-end-day');
    await page.waitForFunction(() => {
      const modal = document.querySelector('#report-modal');
      return Boolean(modal?.open && document.querySelector('#report-form')?.getAttribute('data-current-step') === '2' && document.querySelector('.field-labor-total'));
    }, { timeout: 20000 });
    const closed = await gateReport(page);
    const card = await page.evaluate(async () => {
      const state = await (await fetch('/api/state', { credentials: 'include' })).json();
      return (state.timeCards || []).find(row => row && row.outAt && /patch the gate/i.test((state.reports || []).find(report => Number(report.id) === Number(row.reportId))?.notes || '')) || (state.timeCards || []).find(row => row && row.outAt) || null;
    });
    const minutes = scope.elapsedMinutes(card.inAt, card.outAt);
    const label = scope.formatWorkTime(minutes);
    const hours = scope.hoursFromMinutes(minutes);
    assert.equal(minutes, 2, JSON.stringify({ inAt: card.inAt, outAt: card.outAt, minutes }));
    assert.equal(hours, 0.03);
    assert.equal(closed?.laborEntries?.[0]?.minutes, minutes, JSON.stringify(closed?.laborEntries));
    assert.equal(closed?.laborEntries?.[0]?.hours, hours, JSON.stringify(closed?.laborEntries));
    assert.equal(card.hours, hours, JSON.stringify(card));
    const surfaces = await page.evaluate(() => {
      if (typeof renderFieldClock === 'function') renderFieldClock();
      return {
        review: document.querySelector('.field-labor-total')?.textContent || '',
        timeCard: document.querySelector('#field-clock-hours')?.innerText || ''
      };
    });
    assert.match(surfaces.review, /2 min · 0\.03 h/, JSON.stringify(surfaces));
    assert.match(surfaces.timeCard, /2 min/, JSON.stringify(surfaces));
    assert.doesNotMatch(surfaces.review, /3 min|0\.05 h/, JSON.stringify(surfaces));
    const samePunch = await page.evaluate((inAt, outAt) => {
      const day = workdays.find(row => row && row.reportId) || workdays[0];
      window.fieldLaborNow = () => new Date(outAt).getTime();
      day.startedAt = inAt;
      openEndDay(day.id);
      const summary = document.querySelector('#end-day-summary')?.innerText || '';
      document.querySelector('#end-day-modal')?.close();
      window.fieldLaborNow = () => Date.now();
      return summary;
    }, card.inAt, card.outAt);
    assert.match(samePunch, /2 min · 0\.03 h/, samePunch);
    assert.equal(scope.formatMinutes(minutes), '2 min');
    assert.equal(label, '2 min · 0.03 h');
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
    await owner.waitForFunction(() => /2 min · 0\.03 h/.test(document.querySelector('#report-detail')?.innerText || ''), { timeout: 20000 });
    const draftCard = await owner.evaluate(() => {
      const labor = [...document.querySelectorAll('#report-detail .data-box')].find(box => /LABOR/i.test(box.querySelector('small')?.textContent || ''));
      return labor?.innerText || '';
    });
    assert.match(draftCard, /2 min · 0\.03 h/, draftCard);
    assert.doesNotMatch(draftCard, /3 min|0\.05 h/, draftCard);
    await page.evaluate(() => document.querySelector('[data-flag-choice="yes"]')?.click());
    await page.waitForFunction(() => document.querySelector('[data-flag-choice="yes"]')?.getAttribute('aria-pressed') === 'true', { timeout: 20000 });
    await page.evaluate(() => document.querySelector('#save-report')?.click());
    await page.waitForSelector('#report-sent-modal[open]', { timeout: 20000 });
    await owner.reload({ waitUntil: 'domcontentloaded' });
    await owner.waitForSelector('#menu-button', { timeout: 20000 });
    await openNav(owner, 'reports');
    await owner.waitForSelector('#office-decision', { timeout: 20000 });
    await owner.select('#office-decision', 'tm');
    await waitUntil(owner, () => {
      const button = document.querySelector('[data-approve-report]');
      const help = document.querySelector('#report-detail .input-help')?.textContent || '';
      return Boolean(button && !button.disabled && !/Billable or Not billable to approve/.test(help));
    }, 'approve enabled after Billable · T&M');
    await owner.click('[data-approve-report]');
    await waitUntil(owner, async () => {
      const state = await (await fetch('/api/state', { credentials: 'include' })).json();
      const report = (state.reports || []).find(row => /patch the gate/i.test(row.notes || row.originalNotes || ''));
      return report?.status === 'Approved' && report?.extraWork?.[0]?.officeDecision === 'tm';
    }, 'approved report kept the T&M decision');
    await owner.reload({ waitUntil: 'domcontentloaded' });
    await owner.waitForSelector('#menu-button', { timeout: 20000 });
    await openNav(owner, 'reports');
    await owner.waitForSelector('.extra-work-office', { timeout: 20000 });
    const approvedUi = await owner.evaluate(() => ({
      status: document.querySelector('#report-detail .status')?.textContent || '',
      card: document.querySelector('#report-detail .extra-work-item')?.innerText || '',
      decision: [...document.querySelectorAll('#report-detail .office-decision-saved')].map(node => node.textContent || '').join(' '),
      select: Boolean(document.querySelector('#office-decision')),
      history: document.querySelector('#report-detail .approval-history')?.innerText || ''
    }));
    assert.equal(approvedUi.status, 'Approved', JSON.stringify(approvedUi));
    assert.match(approvedUi.card, /patch the gate/i, JSON.stringify(approvedUi));
    assert.match(approvedUi.decision, /Billable · T&M/, JSON.stringify(approvedUi));
    assert.equal(approvedUi.select, false, JSON.stringify(approvedUi));
    assert.match(approvedUi.history, /Extra work marked Billable · T&M by DEMO Avery Lang/, JSON.stringify(approvedUi));
    const approved = await gateReport(owner);
    assert.equal(approved?.status, 'Approved');
    assert.equal(approved?.extraWork?.[0]?.officeDecision, 'tm', JSON.stringify(approved?.extraWork));
    assert.equal(approved?.extraWork?.[0]?.billable, true, JSON.stringify(approved?.extraWork));
    assert.equal((approved?.history || []).some(row => `${row.action} by ${row.by}` === LOG_LINE), true, JSON.stringify(approved?.history));
    assert.equal(DECISION, 'Billable · T&M');
    console.log('Extra-work decision and shared punch rounding passed.');
  } finally {
    if (browser) await browser.close();
    child.kill();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
