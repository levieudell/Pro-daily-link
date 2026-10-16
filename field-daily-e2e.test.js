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

async function assertFits(page, label) {
  const box = await page.evaluate(() => {
    const offenders = [...document.querySelectorAll('body *')].filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 8 && rect.right > window.innerWidth + 1;
    }).slice(0, 6).map(el => ({
      tag: el.tagName,
      id: el.id || '',
      className: String(el.className || '').slice(0, 80),
      right: Math.round(el.getBoundingClientRect().right)
    }));
    return { scroll: document.documentElement.scrollWidth, width: window.innerWidth, offenders };
  });
  assert.ok(box.scroll <= box.width + 1, `${label} overflows ${box.scroll} > ${box.width} ${JSON.stringify(box.offenders)}`);
}

function backdateOpenPunch(file, minutes) {
  const db = JSON.parse(fs.readFileSync(file, 'utf8'));
  const start = new Date(Date.now() - minutes * 60000).toISOString();
  for (const card of db.timeCards || []) if (card.inAt && !card.outAt) card.inAt = start;
  for (const day of db.workdays || []) if (day.status === 'active') day.startedAt = start;
  fs.writeFileSync(file, JSON.stringify(db));
}

async function settleOpenPunch(page, file, minutes) {
  let detail = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await page.evaluate(async () => {
      await fetch('/api/time-cards', { credentials: 'same-origin' });
    });
    backdateOpenPunch(file, minutes);
    detail = await page.evaluate(async () => {
      if (typeof refreshTimeCards === 'function') await refreshTimeCards();
      const open = (typeof timeCards === 'undefined' ? [] : timeCards).filter(card => card && card.inAt && !card.outAt && !card.deletedAt);
      return open.map(card => ({
        projectId: Number(card.projectId),
        date: card.date || '',
        memberId: Number(card.memberId),
        minutes: Math.round((Date.now() - new Date(card.inAt).getTime()) / 60000)
      }));
    });
    if (detail.some(card => card.minutes >= minutes)) return detail;
  }
  throw new Error('open punch stayed under a minute ' + JSON.stringify(detail));
}

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
    await page.goto(`http://127.0.0.1:${port}/login.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#email');
    await assertFits(page, 'login 390');
    await shot(page, 'field-login-390.png');
    await login(page, FIELD_EMAIL, FIELD_PASSWORD);
    await page.waitForSelector('#myday-page.active [data-start-day]', { timeout: 20000 });
    await assertFits(page, 'dashboard 390');
    await page.click('[data-start-day]');
    await page.waitForSelector('#start-day-button', { visible: true });
    await assertFits(page, 'clock-in 390');
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
    const punch = await settleOpenPunch(page, path.join(root, 'db.json'), 8);
    assert.ok(punch.some(card => card.minutes >= 8 && card.projectId === 3), JSON.stringify(punch));
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
    await assertFits(page, 'daily sheet 390');
    await page.waitForSelector('[data-review-labor][data-line-id="1"]');
    const punchSplit = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('[data-review-labor]')].map(input => ({
        id: input.dataset.lineId,
        unit: input.dataset.unit,
        value: Number(input.value) || 0
      }));
      const totalMinutes = window.fieldLaborContext().total.totalMinutes;
      return { inputs, totalMinutes };
    });
    assert.equal(punchSplit.inputs.every(row => row.unit === 'min'), true, JSON.stringify(punchSplit));
    assert.ok(punchSplit.totalMinutes >= 8 && punchSplit.totalMinutes < 60, JSON.stringify(punchSplit));
    assert.equal(punchSplit.inputs.reduce((sum, row) => sum + row.value, 0), punchSplit.totalMinutes, JSON.stringify(punchSplit));
    const curbInput = await page.$('[data-review-labor][data-line-id="1"]');
    await curbInput.click();
    await page.evaluate(el => {
      el.focus();
      el.setSelectionRange(0, el.value.length);
    }, curbInput);
    await page.keyboard.type('3');
    await page.evaluate(() => document.activeElement?.blur?.());
    const locked = await page.evaluate(() => {
      window.applyLiveLabor?.();
      const lines = [...document.querySelectorAll('.production-entry')].map(row => ({
        id: row.dataset.estimateItemId,
        minutes: Number(row.dataset.laborMinutes) || 0,
        manual: row.dataset.laborManual === 'true'
      }));
      const shown = [...document.querySelectorAll('[data-review-labor]')].map(input => ({ id: input.dataset.lineId, value: Number(input.value) || 0 }));
      return { lines, shown, totalMinutes: window.fieldLaborContext().total.totalMinutes };
    });
    const lockedCurb = locked.lines.find(row => row.id === '1');
    const lockedGutter = locked.lines.find(row => row.id === '5');
    assert.equal(lockedCurb?.manual, true);
    assert.equal(lockedCurb?.minutes, 3);
    assert.equal(lockedGutter?.manual, false);
    assert.equal(lockedCurb.minutes + lockedGutter.minutes, locked.totalMinutes);
    assert.equal(locked.shown.find(row => row.id === '1')?.value, 3);
    await shot(page, 'field-line-minutes.png');
    await page.waitForSelector('[data-gap-member]');
    await page.evaluate(() => {
      for (const input of document.querySelectorAll('[data-gap-member]')) {
        input.value = '8';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.activeElement?.blur?.();
      window.applyLiveLabor?.();
    });
    const spread = await page.evaluate(() => {
      const lines = [...document.querySelectorAll('.production-entry')].map(row => ({
        id: row.dataset.estimateItemId,
        minutes: Number(row.dataset.laborMinutes) || 0,
        hours: Number(row.querySelector('.production-hours')?.value) || 0,
        manual: row.dataset.laborManual === 'true'
      }));
      return { lines, totalMinutes: window.fieldLaborContext().total.totalMinutes, total: window.fieldLaborContext().total.total };
    });
    const curbHours = spread.lines.find(row => row.id === '1');
    const gutterHours = spread.lines.find(row => row.id === '5');
    assert.equal(curbHours?.manual, true);
    assert.equal(curbHours?.minutes, 3);
    assert.equal(spread.lines.reduce((sum, row) => sum + row.minutes, 0), spread.totalMinutes);
    assert.equal(gutterHours.minutes, spread.totalMinutes - 3);
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
    const nextBeforeOut = await page.$eval('#report-next', el => el.value);
    await page.evaluate(() => document.querySelector('#field-clock-out').click());
    await page.waitForSelector('#end-day-modal[open]', { timeout: 20000 });
    const clockOut = await page.evaluate(() => ({
      reportOpen: Boolean(document.querySelector('#report-modal')?.open),
      endNotes: document.querySelector('#end-day-notes')?.value || '',
      dailyNotes: document.querySelector('#field-notes')?.value || ''
    }));
    assert.equal(clockOut.reportOpen, true);
    assert.equal(clockOut.endNotes, '');
    assert.match(clockOut.dailyNotes, /gutter/i);
    await page.type('#end-day-notes', 'Left the site. Gate is locked.');
    await shot(page, 'field-clock-out-open.png');
    await page.click('#confirm-end-day');
    await page.waitForFunction(() => !document.querySelector('#end-day-modal')?.open && document.querySelector('#report-modal')?.open, { timeout: 20000 });
    const afterOut = await page.evaluate(() => ({
      notes: document.querySelector('#field-notes')?.value || '',
      next: document.querySelector('#report-next')?.value || '',
      cards: document.querySelector('#field-review-cards')?.innerText || '',
      flags: document.querySelector('#field-scope-flags')?.innerText || '',
      who: document.querySelector('[data-flag-asker]')?.value || '',
      extra: document.querySelector('[data-flag-choice="yes"]')?.classList.contains('is-selected') || false
    }));
    assert.match(afterOut.notes, /set 20 LF of gutter/);
    assert.match(afterOut.notes, /potholes/);
    assert.equal(/Left the site/.test(afterOut.notes + afterOut.next), false);
    assert.equal(afterOut.next, nextBeforeOut);
    assert.match(afterOut.cards, /Curb/);
    assert.match(afterOut.cards, /Gutter/);
    assert.match(afterOut.cards, /Materials|concrete|yards/i);
    assert.match(afterOut.flags, /Extra work|pothole/i);
    assert.equal(afterOut.extra, true, afterOut.flags);
    assert.equal(afterOut.who, 'site owner', afterOut.flags);
    assert.equal(dialogs.some(message => /Discard this daily report/i.test(message)), false, dialogs.join(' | '));
    await page.click('#report-next-step');
    await page.waitForFunction(() => {
      const who = document.querySelector('[data-flag-asker]');
      const yes = document.querySelector('[data-flag-choice="yes"]');
      return who?.value === 'site owner' && yes?.classList.contains('is-selected') && /Curb/.test(document.querySelector('#field-review-cards')?.innerText || '');
    }, { timeout: 20000 });
    const saved = await page.evaluate(async () => {
      const state = await (await fetch('/api/state', { credentials: 'include' })).json();
      const report = (state.reports || []).find(row => /gutter/i.test(row.notes || row.originalNotes || ''));
      const form = [...document.querySelectorAll('.production-entry')].map(row => ({
        id: Number(row.dataset.estimateItemId),
        hours: Number(row.querySelector('.production-hours')?.value) || 0,
        minutes: Number(row.dataset.laborMinutes) || 0,
        qty: Number(row.querySelector('.production-quantity')?.value) || 0
      })).sort((a, b) => a.id - b.id);
      return {
        quantities: (report?.productionEntries || []).map(row => ({ id: Number(row.estimateItemId), qty: Number(row.quantity), hours: Number(row.laborHours), minutes: Number(row.laborMinutes) || 0 })).sort((a, b) => a.id - b.id),
        labor: roundHours(report?.laborEntries || []),
        who: report?.extraWork?.[0]?.who_asked || report?.scopeFlags?.find(flag => flag.decision === 'extra')?.who_asked || '',
        decision: report?.scopeFlags?.find(flag => flag.decision)?.decision || '',
        notes: report?.notes || '',
        next: report?.next || '',
        history: (report?.history || []).map(row => row.action || ''),
        form
      };
      function roundHours(rows) { return rows.map(row => ({ id: Number(row.memberId), hours: Math.round((Number(row.hours) || 0) * 100) / 100 })).sort((a, b) => a.id - b.id); }
    });
    assert.deepEqual(saved.quantities.map(row => [row.id, row.qty]), [[1, 40], [5, 20]]);
    assert.equal(saved.who, 'site owner');
    assert.equal(saved.decision, 'extra');
    assert.equal(/Left the site/.test(saved.notes + saved.next), false);
    assert.equal(saved.history.some(action => /Labor corrected/i.test(action)), false, saved.history.join(' | '));
    assert.equal(saved.quantities.reduce((sum, row) => sum + row.minutes, 0), saved.form.reduce((sum, row) => sum + row.minutes, 0));
    assert.equal(saved.quantities.find(row => row.id === 1)?.minutes, 3);
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
        quantities: (report?.productionEntries || []).map(row => ({ id: Number(row.estimateItemId), qty: Number(row.quantity), hours: Number(row.laborHours), minutes: Number(row.laborMinutes) || 0 })).sort((a, b) => a.id - b.id),
        labor: (report?.laborEntries || []).map(row => ({ id: Number(row.memberId), hours: Math.round((Number(row.hours) || 0) * 100) / 100 })).sort((a, b) => a.id - b.id),
        who: report?.extraWork?.[0]?.who_asked || ''
      };
    });
    assert.deepEqual(office.quantities, saved.quantities);
    assert.deepEqual(office.labor, saved.labor);
    assert.equal(office.who, saved.who);
    await page.setViewport({ width: 320, height: 568, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await assertFits(page, 'daily sheet 320');
    await shot(page, 'field-daily-320.png');
    await page.evaluate(() => document.querySelector('#report-modal .close-button')?.click());
    await page.waitForFunction(() => !document.querySelector('#report-modal')?.open);
    await openNav(page, 'myday');
    await assertFits(page, 'dashboard 320');
    const narrowContext = await browser.createBrowserContext();
    const narrow = await narrowContext.newPage();
    narrow.__port = port;
    await narrow.setViewport({ width: 320, height: 568, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await narrow.evaluateOnNewDocument(() => {
      localStorage.setItem('pdl-analytics-consent', 'declined');
      localStorage.setItem('pdl-field-tip', 'dismissed');
    });
    await narrow.goto(`http://127.0.0.1:${port}/login.html`, { waitUntil: 'domcontentloaded' });
    await narrow.waitForSelector('#email');
    await assertFits(narrow, 'login 320');
    await shot(narrow, 'field-login-320.png');
    await login(narrow, FIELD_EMAIL, FIELD_PASSWORD);
    await narrow.waitForSelector('#myday-page.active', { timeout: 20000 });
    await assertFits(narrow, 'dashboard 320 signed in');
    const start = await narrow.$('[data-start-day]');
    if (start) {
      await start.click();
      await narrow.waitForSelector('#start-day-modal[open]', { timeout: 10000 }).catch(() => {});
    }
    await assertFits(narrow, 'clock-in 320');
    await shot(narrow, 'field-clock-in-320.png');
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
