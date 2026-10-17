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
const NOTES_2 = 'Set forms. Next: strip forms.';
const NEXT_2 = 'Pour pad Monday';
const NOTES_3 = 'Cleaned up site.';
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

async function chooseJob(page) {
  await page.evaluate(() => {
    const project = document.querySelector('#start-day-project');
    if (project) project.value = '3';
    for (const box of document.querySelectorAll('#start-day-members input')) {
      const label = box.closest('label')?.textContent || '';
      const keep = /Jordan Reed/i.test(label);
      if (box.checked !== keep) box.click();
    }
  });
}

async function clockOut(page, dbFile, notes, next, minutes) {
  pinOpenPunch(dbFile, minutes);
  await page.evaluate(() => document.querySelector('#start-day-button')?.click());
  await page.waitForSelector('#end-day-modal[open] #end-day-notes', { timeout: 20000 });
  await page.$eval('#end-day-notes', (el, value) => { el.value = value; }, notes);
  await page.$eval('#end-day-next', (el, value) => { el.value = value; }, next);
  pinOpenPunch(dbFile, minutes);
  await page.click('#confirm-end-day');
  await page.waitForFunction(() => !document.querySelector('#end-day-modal')?.open, { timeout: 20000 });
}

async function draftState(page) {
  return page.evaluate(async () => {
    const data = await (await fetch('/api/state', { credentials: 'include' })).json();
    const reports = data.reports || [];
    const report = reports[0] || null;
    return {
      count: reports.length,
      notes: report?.notes || '',
      summary: report?.summary || '',
      next: report?.next || '',
      minutes: (report?.laborEntries || []).reduce((sum, row) => sum + (Number(row.minutes) || 0), 0),
      cards: (data.timeCards || []).map(card => ({ inAt: card.inAt, outAt: card.outAt, reportId: card.reportId, hours: card.hours })),
      reportId: report?.id || null
    };
  });
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
    await chooseJob(page);
    await page.click('#confirm-start-day');
    await page.waitForFunction(() => /Clock out/i.test(document.querySelector('#start-day-button')?.textContent || ''), { timeout: 20000 });
    await clockOut(page, dbFile, NOTES, '', 2);
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
    await page.click('#report-modal .close-button');
    await page.waitForFunction(() => !document.querySelector('#report-modal')?.open, { timeout: 5000 });
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
    const scope = require('./field-daily-scope');
    await openClockIn(page);
    await chooseJob(page);
    await page.click('#confirm-start-day');
    await page.waitForFunction(() => /Clock out/i.test(document.querySelector('#start-day-button')?.textContent || ''), { timeout: 20000 });
    await clockOut(page, dbFile, NOTES_2, NEXT_2, 2);
    const afterSecond = await draftState(page);
    assert.equal(afterSecond.count, 1, JSON.stringify(afterSecond));
    assert.equal(afterSecond.next, NEXT_2, JSON.stringify(afterSecond));
    assert.match(afterSecond.notes, /Short check-in/);
    assert.match(afterSecond.notes, /Set forms/);
    assert.doesNotMatch(afterSecond.notes, /Cleaned up site/);
    const secondMinutes = afterSecond.cards.reduce((sum, card) => sum + scope.elapsedMinutes(card.inAt, card.outAt), 0);
    assert.equal(afterSecond.minutes, secondMinutes, JSON.stringify(afterSecond));
    assert.ok(secondMinutes >= 3, JSON.stringify(afterSecond));
    await page.waitForFunction(() => /Set forms/i.test(document.querySelector('#field-reports')?.innerText || ''), { timeout: 10000 });
    await openClockIn(page);
    await chooseJob(page);
    await page.click('#confirm-start-day');
    await page.waitForFunction(() => /Clock out/i.test(document.querySelector('#start-day-button')?.textContent || ''), { timeout: 20000 });
    await clockOut(page, dbFile, NOTES_3, '', 1);
    const afterThird = await draftState(page);
    assert.equal(afterThird.count, 1, JSON.stringify(afterThird));
    assert.equal(afterThird.reportId, afterSecond.reportId);
    assert.equal(afterThird.next, NEXT_2, JSON.stringify(afterThird));
    assert.match(afterThird.notes, /Short check-in/);
    assert.match(afterThird.notes, /Set forms/);
    assert.match(afterThird.notes, /Cleaned up site/);
    assert.match(afterThird.summary, /Set forms/);
    assert.match(afterThird.summary, /Cleaned up site/);
    const thirdMinutes = afterThird.cards.reduce((sum, card) => sum + scope.elapsedMinutes(card.inAt, card.outAt), 0);
    assert.equal(afterThird.minutes, thirdMinutes, JSON.stringify(afterThird));
    assert.ok(thirdMinutes > secondMinutes, JSON.stringify(afterThird));
    assert.ok(afterThird.cards.every(card => card.reportId === afterThird.reportId), JSON.stringify(afterThird.cards));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-button', { timeout: 20000 });
    await openNav(page, 'myday');
    await page.click('[data-field-report]');
    await page.waitForFunction(() => /NEXT STEP/.test(document.querySelector('#report-detail')?.innerText || ''), { timeout: 10000 });
    const detail = await page.$eval('#report-detail', el => el.innerText);
    assert.match(detail, /Set forms/);
    assert.match(detail, /Cleaned up site/);
    assert.match(detail, /Pour pad Monday/);
    assert.match(detail, new RegExp(`${thirdMinutes} min`));
    await page.click('[data-edit-report]');
    await page.waitForFunction(() => document.querySelector('#report-modal')?.open && document.querySelector('#field-notes'), { timeout: 10000 });
    const curbNotes = 'Poured 40 LF of curb on the north side.';
    await page.$eval('#field-notes', (el, value) => {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, curbNotes);
    await page.click('#report-next-step');
    await page.waitForFunction(() => {
      const button = document.querySelector('#report-next-step');
      const cards = document.querySelector('#field-review-cards')?.innerText || '';
      return button && !button.disabled && document.querySelector('#report-form')?.getAttribute('data-current-step') === '2' && /Curb/.test(cards) && /40/.test(cards);
    }, { timeout: 20000 });
    const summaryAfterReview = await page.$eval('#report-summary', el => el.value);
    await page.click('#report-back');
    await page.waitForFunction(() => document.querySelector('#report-form')?.getAttribute('data-current-step') === '1');
    await page.click('#report-next-step');
    await page.waitForFunction(() => {
      const button = document.querySelector('#report-next-step');
      return button && !button.disabled && document.querySelector('#report-form')?.getAttribute('data-current-step') === '2';
    }, { timeout: 20000 });
    const summaryRetap = await page.$eval('#report-summary', el => el.value);
    assert.equal(summaryRetap, summaryAfterReview);
    await page.click('#report-modal .close-button');
    await page.waitForFunction(() => !document.querySelector('#report-modal')?.open, { timeout: 5000 });
    const productionCard = await page.evaluate(() => {
      const box = [...document.querySelectorAll('#report-detail .data-box')].find(row => /PRODUCTION/i.test(row.querySelector('small')?.textContent || ''));
      return box?.innerText || '';
    });
    assert.match(productionCard, /Curb/);
    assert.match(productionCard, /40/);
    assert.doesNotMatch(productionCard, /Not entered/);
    const keptProduction = await page.evaluate(async () => {
      const state = await (await fetch('/api/state', { credentials: 'include' })).json();
      const report = (state.reports || [])[0] || null;
      return (report?.productionEntries || []).map(row => ({ description: row.description, quantity: Number(row.quantity) || 0 }));
    });
    assert.ok(keptProduction.some(row => /Curb/i.test(row.description) && row.quantity === 40), JSON.stringify(keptProduction));
    console.log('Clock refresh and next-step browser flow passed.');
  } finally {
    if (browser) await browser.close();
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
