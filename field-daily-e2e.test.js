'use strict';
// Headless 390px pass against the staging seed: clock in, a multi-item note,
// hours that re-spread from one total, Back/Done, Send, clock out with the
// daily still open, and the owner view of the same numbers.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const NOTE = 'Poured 40 LF of curb on north side, set 20 LF of gutter, 3 guys, extra work: owner asked us to patch 2 potholes by the gate, used 6 yards of concrete. Tomorrow we form the east side, need pump truck Monday.';
const SHOTS = '/opt/cursor/artifacts/screenshots';
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

function round2(value) { return Math.round((Number(value) || 0) * 100) / 100; }

async function shot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: false });
}

async function dump(page, label) {
  const info = await page.evaluate(() => ({
    url: location.href,
    status: document.querySelector('#report-submit-status')?.textContent || '',
    notes: document.querySelector('#field-notes')?.value || '',
    step: document.querySelector('#report-form')?.getAttribute('data-current-step') || '',
    lines: [...document.querySelectorAll('.production-entry')].map(row => ({
      id: row.dataset.estimateItemId || '',
      value: row.querySelector('.production-item')?.value || '',
      text: row.querySelector('.production-item')?.selectedOptions?.[0]?.textContent || '',
      qty: row.querySelector('.production-quantity')?.value || '',
      hours: row.querySelector('.production-hours')?.value || '',
      manual: row.dataset.laborManual || ''
    })),
    flags: document.querySelector('#field-scope-flags')?.innerText || '',
    cards: document.querySelector('#field-review-cards')?.innerText || '',
    sent: document.querySelector('#report-sent-summary')?.textContent || '',
    end: document.querySelector('#end-day-message')?.textContent || '',
    reportOpen: Boolean(document.querySelector('#report-modal')?.open),
    endOpen: Boolean(document.querySelector('#end-day-modal')?.open)
  })).catch(error => ({ error: error.message }));
  console.error(label, JSON.stringify(info, null, 2));
  await shot(page, 'field-daily-e2e-failure.png').catch(() => {});
}

async function login(page, email, password) {
  await page.goto(`http://127.0.0.1:${page.__port}/login.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#email');
  await page.$eval('#email', (el, value) => { el.value = value; }, email);
  await page.$eval('#password', (el, value) => { el.value = value; }, password);
  await page.click('form#login button.primary');
  await page.waitForFunction(() => location.pathname.includes('/app'), { timeout: 20000 });
  await page.waitForSelector('#menu-button', { timeout: 20000 });
  const tip = await page.$('#dismiss-field-tip');
  if (tip && await tip.isIntersectingViewport()) await tip.click().catch(() => {});
  const consent = await page.$('#pdl-consent-banner button, #pdl-consent-banner [data-decline], #pdl-consent-banner .secondary');
  if (consent) await consent.click().catch(() => {});
}

async function openNav(page, name) {
  await page.evaluate(target => {
    const sidebar = document.querySelector('#sidebar');
    if (sidebar && !sidebar.classList.contains('open')) document.querySelector('#menu-button')?.click();
    document.querySelector(`.nav-item[data-page="${target}"]`)?.click();
  }, name);
  await page.waitForFunction(target => document.getElementById(target + '-page')?.classList.contains('active'), { timeout: 10000 }, name);
}

(async () => {
  assert.ok(fs.existsSync('/usr/bin/google-chrome-stable'), 'Chrome is required for the field daily browser test');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-field-e2e-'));
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), PDL_STAGING: '1', PDL_STAGING_OWNER_PASSWORD: OWNER_PASSWORD, PDL_STAGING_FIELD_PASSWORD: FIELD_PASSWORD, PDL_DB_FILE: path.join(root, 'db.json'), PDL_PLATFORM_FILE: path.join(root, 'platform.json'), PDL_EMAIL_DEV_MODE: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', OPENAI_API_KEY: '' };
  for (const name of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY', 'INDEXNOW_KEY', 'SENTRY_DSN']) delete env[name];
  const child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const browser = await puppeteer().launch({
    executablePath: '/usr/bin/google-chrome-stable',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  const dialogs = [];
  let page;
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
    page = await browser.newPage();
    page.__port = port;
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('pdl-analytics-consent', 'declined');
      localStorage.setItem('pdl-field-tip', 'dismissed');
    });
    await login(page, FIELD_EMAIL, FIELD_PASSWORD);
    await page.waitForSelector('#myday-page.active [data-start-day]', { timeout: 20000 });
    await page.click('[data-start-day]');
    await page.waitForSelector('#start-day-button', { visible: true });
    await page.click('#start-day-button');
    await page.waitForSelector('#start-day-modal[open] #start-day-members input');
    const started = await page.evaluate(() => {
      const project = document.querySelector('#start-day-project');
      const selected = project?.selectedOptions?.[0]?.textContent || '';
      for (const box of document.querySelectorAll('#start-day-members input')) {
        const label = box.closest('label')?.textContent || '';
        const keep = /Jordan Reed/i.test(label);
        if (box.checked !== keep) box.click();
      }
      const people = [...document.querySelectorAll('#start-day-members input:checked')].map(box => box.closest('label')?.innerText || '');
      return { project: project?.value || '', selected, people };
    });
    assert.equal(started.project, '3', 'clock-in stays on Cedar Grove');
    assert.equal(started.people.length, 1);
    await page.click('#confirm-start-day');
    await page.waitForFunction(() => /CLOCKED IN/i.test(document.querySelector('#field-clock-status-label')?.textContent || ''), { timeout: 20000 });
    await openNav(page, 'myday');
    await page.waitForSelector('#myday-page.active [data-assignment-daily]');
    await page.click('[data-assignment-daily]');
    await page.waitForSelector('#report-modal[open] #field-notes');
    await page.$eval('#field-notes', (el, note) => {
      el.value = note;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, NOTE);
    const drafted = await page.evaluate(() => Object.values(localStorage).some(value => String(value).includes('set 20 LF of gutter')));
    assert.equal(drafted, true, 'the note is saved on the device while the daily is open');
    await page.click('#report-next-step');
    await page.waitForFunction(() => {
      const button = document.querySelector('#report-next-step');
      const lines = [...document.querySelectorAll('.production-entry')];
      return button && !button.disabled && lines.filter(row => row.dataset.estimateItemId === '1' || row.dataset.estimateItemId === '5').length >= 2;
    }, { timeout: 20000 });
    const parsed = await page.evaluate(() => [...document.querySelectorAll('.production-entry')].map(row => ({
      id: row.dataset.estimateItemId || '',
      value: row.querySelector('.production-item')?.value || '',
      qty: row.querySelector('.production-quantity')?.value || '',
      unit: row.querySelector('.production-unit')?.value || ''
    })));
    const curb = parsed.find(row => row.id === '1');
    const gutter = parsed.find(row => row.id === '5');
    assert.ok(curb && curb.value === '1' && curb.qty === '40' && curb.unit === 'LF', JSON.stringify(parsed));
    assert.ok(gutter && gutter.value === '5' && gutter.qty === '20' && gutter.unit === 'LF', JSON.stringify(parsed));
    assert.equal(parsed.some(row => (Number(row.qty) > 0 || Number(row.hours) > 0) && !row.id), false);
    await shot(page, 'field-review-bound.png');
    await page.waitForSelector('[data-gap-member]');
    await page.evaluate(() => {
      for (const input of document.querySelectorAll('[data-gap-member]')) {
        input.value = '8';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    const spread = await page.evaluate(() => {
      document.activeElement?.blur?.();
      const before = window.applyLiveLabor?.();
      const lines = [...document.querySelectorAll('.production-entry')].map(row => ({
        id: row.dataset.estimateItemId,
        hours: Number(row.querySelector('.production-hours')?.value) || 0,
        manual: row.dataset.laborManual === 'true'
      }));
      const total = window.fieldLaborContext().total.total;
      const curbRow = [...document.querySelectorAll('.production-entry')].find(row => row.dataset.estimateItemId === '1');
      const input = curbRow?.querySelector('.production-hours');
      if (curbRow) curbRow.dataset.laborManual = 'true';
      if (input) { input.value = '4'; input.dispatchEvent(new Event('input', { bubbles: true })); }
      document.activeElement?.blur?.();
      window.applyLiveLabor?.();
      const after = [...document.querySelectorAll('.production-entry')].map(row => ({
        id: row.dataset.estimateItemId,
        hours: Number(row.querySelector('.production-hours')?.value) || 0,
        manual: row.dataset.laborManual === 'true'
      }));
      return { before: lines, allocatedBefore: before?.allocated ?? null, total, after, liveTotal: window.fieldLaborContext().total.total };
    });
    const sum = round2(spread.after.reduce((total, row) => total + row.hours, 0));
    const curbHours = spread.after.find(row => row.id === '1');
    const gutterHours = spread.after.find(row => row.id === '5');
    assert.equal(curbHours?.manual, true);
    assert.equal(curbHours?.hours, 4);
    assert.equal(gutterHours?.manual, false);
    assert.equal(sum, round2(spread.liveTotal));
    assert.ok(spread.liveTotal > 4, JSON.stringify(spread));
    assert.equal(gutterHours.hours, round2(spread.liveTotal - 4));
    await shot(page, 'field-hours-respread.png');
    await page.waitForSelector('[data-flag-choice="yes"]');
    await page.click('[data-flag-choice="yes"]');
    await page.$eval('[data-flag-asker]', el => {
      el.value = 'site owner';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    for (let pass = 0; pass < 2; pass += 1) {
      await page.click('#report-back');
      await page.waitForFunction(() => document.querySelector('#report-form')?.getAttribute('data-current-step') === '1');
      await page.click('#report-next-step');
      await page.waitForFunction(() => {
        const yes = document.querySelector('[data-flag-choice="yes"]');
        const who = document.querySelector('[data-flag-asker]');
        const button = document.querySelector('#report-next-step');
        const bound = [...document.querySelectorAll('.production-entry')].filter(row => row.dataset.estimateItemId === '1' || row.dataset.estimateItemId === '5');
        return button && !button.disabled && yes?.classList.contains('is-selected') && who?.value === 'site owner' && bound.length >= 2;
      }, { timeout: 20000 });
    }
    await shot(page, 'field-extra-persisted.png');
    const kept = await page.evaluate(() => ({
      who: document.querySelector('[data-flag-asker]')?.value || '',
      yes: document.querySelector('[data-flag-choice="yes"]')?.classList.contains('is-selected') || false,
      ids: [...document.querySelectorAll('.production-entry')].map(row => row.dataset.estimateItemId)
    }));
    assert.equal(kept.who, 'site owner');
    assert.equal(kept.yes, true);
    assert.ok(kept.ids.includes('1') && kept.ids.includes('5'));
    await page.click('#save-report');
    try {
      await page.waitForSelector('#report-sent-modal[open]', { timeout: 20000 });
    } catch (error) {
      await dump(page, 'send blocked');
      throw error;
    }
    const sent = await page.$eval('#report-sent-summary', el => el.textContent || '');
    const blocked = await page.$eval('#report-submit-status', el => el.textContent || '').catch(() => '');
    assert.equal(/Choose an estimate item/.test(sent + blocked), false, sent + blocked);
    assert.match(sent, /logged|office/i);
    await shot(page, 'field-send-success.png');
    await page.click('#report-sent-modal button.primary');
    await page.waitForSelector('[data-edit-report]');
    await page.click('[data-edit-report]');
    await page.waitForFunction(() => {
      const button = document.querySelector('#field-clock-out');
      return document.querySelector('#report-modal')?.open && button && !button.hidden;
    }, { timeout: 20000 });
    await page.evaluate(() => document.querySelector('#field-clock-out').click());
    await page.waitForSelector('#end-day-modal[open]');
    const clockOut = await page.evaluate(() => ({
      reportOpen: Boolean(document.querySelector('#report-modal')?.open),
      endNotes: document.querySelector('#end-day-notes')?.value || '',
      dailyNotes: document.querySelector('#field-notes')?.value || ''
    }));
    assert.equal(clockOut.reportOpen, true);
    assert.match(clockOut.endNotes, /gutter/i);
    assert.match(clockOut.dailyNotes, /gutter/i);
    await shot(page, 'field-clock-out-open.png');
    await page.click('#confirm-end-day');
    await page.waitForFunction(() => !document.querySelector('#end-day-modal')?.open && document.querySelector('#report-modal')?.open, { timeout: 20000 });
    const afterOut = await page.$eval('#field-notes', el => el.value);
    assert.match(afterOut, /set 20 LF of gutter/);
    assert.match(afterOut, /potholes/);
    assert.equal(dialogs.some(message => /Discard this daily report/i.test(message)), false, dialogs.join(' | '));
    const saved = await page.evaluate(async () => {
      const state = await (await fetch('/api/state', { credentials: 'include' })).json();
      const report = (state.reports || []).find(row => /gutter/i.test(row.notes || row.originalNotes || ''));
      const form = [...document.querySelectorAll('.production-entry')].map(row => ({
        id: Number(row.dataset.estimateItemId),
        hours: Number(row.querySelector('.production-hours')?.value) || 0,
        qty: Number(row.querySelector('.production-quantity')?.value) || 0
      })).sort((a, b) => a.id - b.id);
      return {
        quantities: (report?.productionEntries || []).map(row => ({ id: Number(row.estimateItemId), qty: Number(row.quantity), hours: Number(row.laborHours) })).sort((a, b) => a.id - b.id),
        labor: roundHours(report?.laborEntries || []),
        who: report?.extraWork?.[0]?.who_asked || '',
        form
      };
      function roundHours(rows) { return rows.map(row => ({ id: Number(row.memberId), hours: Math.round((Number(row.hours) || 0) * 100) / 100 })).sort((a, b) => a.id - b.id); }
    });
    assert.deepEqual(saved.quantities.map(row => [row.id, row.qty]), [[1, 40], [5, 20]]);
    assert.equal(saved.who, 'site owner');
    assert.equal(round2(saved.form.reduce((total, row) => total + row.hours, 0)), round2(saved.labor.reduce((total, row) => total + row.hours, 0)));
    const ownerContext = await browser.createBrowserContext();
    const owner = await ownerContext.newPage();
    owner.__port = port;
    await owner.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await owner.evaluateOnNewDocument(() => localStorage.setItem('pdl-analytics-consent', 'declined'));
    await login(owner, OWNER_EMAIL, OWNER_PASSWORD);
    await openNav(owner, 'reports');
    await owner.waitForFunction(() => {
      const text = document.querySelector('#report-detail')?.innerText || '';
      return /Curb/.test(text) && /Gutter/.test(text) && /40/.test(text) && /20/.test(text) && /site owner/.test(text);
    }, { timeout: 20000 });
    await owner.evaluate(() => document.querySelector('#report-detail')?.scrollIntoView());
    await shot(owner, 'owner-same-numbers.png');
    const office = await owner.evaluate(async () => {
      const state = await (await fetch('/api/state', { credentials: 'include' })).json();
      const report = (state.reports || []).find(row => /gutter/i.test(row.notes || row.originalNotes || ''));
      return {
        quantities: (report?.productionEntries || []).map(row => ({ id: Number(row.estimateItemId), qty: Number(row.quantity), hours: Number(row.laborHours) })).sort((a, b) => a.id - b.id),
        labor: (report?.laborEntries || []).map(row => ({ id: Number(row.memberId), hours: Math.round((Number(row.hours) || 0) * 100) / 100 })).sort((a, b) => a.id - b.id),
        who: report?.extraWork?.[0]?.who_asked || ''
      };
    });
    assert.deepEqual(office.quantities, saved.quantities);
    assert.deepEqual(office.labor, saved.labor);
    assert.equal(office.who, saved.who);
    console.log('Field daily browser flow passed.');
  } catch (error) {
    if (page) await dump(page, 'field daily e2e failed');
    console.error(log.slice(-4000));
    throw error;
  } finally {
    await browser.close().catch(() => {});
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
