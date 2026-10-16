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
  const start = new Date(Date.now() - minutes * 60000 - 1500).toISOString();
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
        minutes: Math.floor((Date.now() - new Date(card.inAt).getTime()) / 60000)
      }));
    });
    if (detail.some(card => card.minutes >= minutes)) return detail;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error('open punch stayed under a minute ' + JSON.stringify(detail));
}

async function shot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: false });
}

async function assertClockOutClear(page, label) {
  const overlap = await page.evaluate(() => {
    const pill = document.querySelector('#field-clock-out');
    if (!pill || pill.hidden) return { skipped: true };
    const pillBox = pill.getBoundingClientRect();
    const targets = [];
    const job = document.querySelector('#report-job-context .report-job-heading');
    if (job) targets.push(["TODAY'S JOB", job]);
    document.querySelectorAll('.field-flag small, .field-extra-ask span').forEach(el => {
      if (/extra work/i.test(el.textContent || '')) targets.push([(el.textContent || '').trim(), el]);
    });
    const visible = targets.filter(([, el]) => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    });
    const hits = visible.filter(([, el]) => {
      const box = el.getBoundingClientRect();
      return pillBox.left < box.right && pillBox.right > box.left && pillBox.top < box.bottom && pillBox.bottom > box.top;
    }).map(([name]) => name);
    return { hits, checked: visible.map(([name]) => name), pill: { top: pillBox.top, bottom: pillBox.bottom, left: pillBox.left, right: pillBox.right } };
  });
  if (overlap.skipped) return;
  assert.ok(overlap.checked.length, `${label} found no clock-out targets ${JSON.stringify(overlap)}`);
  assert.deepEqual(overlap.hits, [], `${label} ${JSON.stringify(overlap)}`);
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
  let browser;
  const dialogs = [];
  let page;
  try {
    browser = await puppeteer().launch({
      executablePath: '/usr/bin/google-chrome-stable',
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
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
      window.__autosaveLog = [];
      const watch = () => {
        const status = document.querySelector('#autosave-status');
        if (!status || status.dataset.watched === '1') return;
        status.dataset.watched = '1';
        const log = () => window.__autosaveLog.push(status.textContent || '');
        log();
        new MutationObserver(log).observe(status, { childList: true, characterData: true, subtree: true });
      };
      document.addEventListener('DOMContentLoaded', watch);
      setInterval(watch, 100);
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
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.evaluate(() => {
        document.querySelector('#sidebar')?.classList.remove('open');
        document.querySelector('[data-assignment-daily]')?.click();
      });
      const opened = await page.waitForSelector('#report-modal[open] #field-notes', { timeout: 8000 }).then(() => true).catch(() => false);
      if (opened) break;
    }
    await page.waitForSelector('#report-modal[open] #field-notes', { timeout: 20000 });
    await page.$eval('#field-notes', (el, note) => {
      el.value = note;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, NOTE);
    const drafted = await page.evaluate(() => Object.values(localStorage).some(value => String(value).includes('set 20 LF of gutter')));
    assert.equal(drafted, true, 'the note is saved on the device while the daily is open');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => /gutter/i.test(document.querySelector('#field-notes')?.value || ''), { timeout: 20000 });
    const restoreLog = await page.evaluate(() => window.__autosaveLog || []);
    assert.ok(restoreLog.some(text => /recovered after refresh|restored after refresh/i.test(text)), JSON.stringify(restoreLog));
    await shot(page, 'field-restored-banner.png');
    await page.waitForFunction(() => !/recovered after refresh|restored after refresh|unsaved notes restored/i.test(document.querySelector('#autosave-status')?.textContent || ''), { timeout: 8000 });
    await page.waitForFunction(() => {
      const button = document.querySelector('#field-clock-out');
      const job = document.querySelector('#report-job-context .report-job-heading');
      return button && !button.hidden && job && job.getBoundingClientRect().height > 0;
    }, { timeout: 20000 });
    await assertClockOutClear(page, 'clock out vs today job');
    await settleOpenPunch(page, path.join(root, 'db.json'), 8);
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
    await assertClockOutClear(page, 'clock out vs extra work');
    await shot(page, 'field-clock-out-clear.png');
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
    const live = await page.evaluate(() => {
      window.beginFieldLaborTick();
      window.applyLiveLabor();
      const total = window.fieldLaborContext().total.totalMinutes;
      const inputs = [...document.querySelectorAll('[data-review-labor]')];
      const sum = inputs.reduce((totalMinutes, input) => totalMinutes + (Number(input.value) || 0), 0);
      return {
        total,
        sum,
        clock: document.querySelector('#field-clock-detail')?.textContent || document.querySelector('#field-start-detail')?.textContent || '',
        pair: document.querySelector('.field-time-pair')?.textContent || '',
        totalText: document.querySelector('.field-labor-total')?.textContent || '',
        send: document.querySelector('#save-report')?.textContent?.trim() || ''
      };
    });
    assert.equal(live.sum, live.total, JSON.stringify(live));
    assert.match(live.clock, new RegExp(`${live.total} min`));
    assert.match(live.pair, /\d+ min · \d+\.\d{2} h/);
    assert.match(live.totalText, new RegExp(`${live.total} min · \\d+\\.\\d{2} h`));
    if (live.total === 8) assert.match(live.totalText, /8 min · 0\.13 h/);
    assert.equal(live.send, 'Send to office');
    await shot(page, 'field-time-pair.png');
    const clockAtRest = await page.evaluate(() => {
      const card = [...document.querySelectorAll('[data-edit-labor]')].find(el => /from clock/i.test(el.querySelector('small')?.textContent || ''));
      return { text: card?.querySelector('em')?.textContent || '', total: window.fieldLaborContext().total.totalMinutes };
    });
    assert.match(clockAtRest.text, new RegExp(`^${clockAtRest.total} min ·`), JSON.stringify(clockAtRest));
    const curbInput = await page.$('[data-review-labor][data-line-id="1"]');
    await curbInput.click();
    await page.evaluate(el => {
      el.focus();
      el.setSelectionRange(0, el.value.length);
    }, curbInput);
    const keptEdit = await page.$eval('[data-review-labor][data-line-id="1"]', el => el.value);
    const advanced = await settleOpenPunch(page, path.join(root, 'db.json'), clockAtRest.total + 2);
    assert.ok(advanced.some(card => card.minutes >= clockAtRest.total + 2), JSON.stringify(advanced));
    const clockWhileEditing = await page.evaluate(() => {
      window.applyLiveLabor();
      const card = [...document.querySelectorAll('[data-edit-labor]')].find(el => /from clock/i.test(el.querySelector('small')?.textContent || ''));
      const input = document.querySelector('[data-review-labor][data-line-id="1"]');
      return {
        text: card?.querySelector('em')?.textContent || '',
        total: window.fieldLaborContext().total.totalMinutes,
        focused: document.activeElement === input,
        value: input?.value || ''
      };
    });
    assert.equal(clockWhileEditing.focused, true, JSON.stringify(clockWhileEditing));
    assert.equal(clockWhileEditing.value, keptEdit, JSON.stringify(clockWhileEditing));
    assert.ok(clockWhileEditing.total >= clockAtRest.total + 2, JSON.stringify({ clockAtRest, clockWhileEditing }));
    assert.match(clockWhileEditing.text, new RegExp(`^${clockWhileEditing.total} min ·`), JSON.stringify(clockWhileEditing));
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
    const clockedInBadge = await page.$eval('[data-review-labor][data-line-id="1"]', el => el.closest('.field-review-card')?.querySelector('small')?.textContent || '');
    assert.match(clockedInBadge, /manual/i, clockedInBadge);
    assert.equal(lockedGutter?.manual, false);
    assert.equal(lockedCurb.minutes + lockedGutter.minutes, locked.totalMinutes);
    assert.equal(locked.shown.find(row => row.id === '1')?.value, 3);
    await shot(page, 'field-line-minutes.png');
    const gutterInput = await page.$('[data-review-labor][data-line-id="5"]');
    await gutterInput.click();
    await page.evaluate(el => { el.focus(); el.setSelectionRange(0, el.value.length); }, gutterInput);
    await page.keyboard.type('99');
    await page.evaluate(() => document.activeElement?.blur?.());
    const clamped = await page.evaluate(() => {
      const gutter = document.querySelector('[data-review-labor][data-line-id="5"]');
      const curb = document.querySelector('[data-review-labor][data-line-id="1"]');
      return {
        gutter: Number(gutter?.value) || 0,
        curb: Number(curb?.value) || 0,
        total: window.fieldLaborContext().total.totalMinutes,
        note: gutter?.parentElement?.querySelector('.field-clamp-note')?.textContent || ''
      };
    });
    assert.equal(clamped.curb, 3, JSON.stringify(clamped));
    assert.equal(clamped.gutter, clamped.total - 3, JSON.stringify(clamped));
    assert.match(clamped.note, /Kept at/);
    await shot(page, 'field-clamp-note.png');
    await page.evaluate(() => {
      const gutter = [...document.querySelectorAll('.production-entry')].find(row => row.dataset.estimateItemId === '5');
      if (gutter) delete gutter.dataset.laborManual;
      window.applyLiveLabor?.();
    });
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
    await page.evaluate(() => {
      const punched = new Set((window.fieldLaborContext()?.punches || []).map(row => Number(row.memberId)));
      for (const input of document.querySelectorAll('[data-labor-member]')) {
        if (punched.has(Number(input.dataset.laborMember))) continue;
        input.value = '';
        delete input.dataset.manualHours;
        delete input.dataset.noteDerived;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.activeElement?.blur?.();
      window.applyLiveLabor?.();
    });
    const cleared = await page.evaluate(() => ({
      gaps: [...document.querySelectorAll('[data-gap-member]')].map(input => input.value),
      curb: Number([...document.querySelectorAll('.production-entry')].find(row => row.dataset.estimateItemId === '1')?.dataset.laborMinutes) || 0,
      minutes: [...document.querySelectorAll('.production-entry')].reduce((sum, row) => sum + (Number(row.dataset.laborMinutes) || 0), 0),
      total: window.fieldLaborContext().total.totalMinutes
    }));
    assert.ok(cleared.gaps.length >= 2 && cleared.gaps.every(value => value === ''), JSON.stringify(cleared));
    assert.equal(cleared.curb, 3);
    assert.equal(cleared.minutes, cleared.total);
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
    assert.equal(await page.$eval('#save-report', el => el.textContent.trim()), 'Send to office');
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
    await page.evaluate(() => {
      const status = document.querySelector('#autosave-status');
      if (status) status.textContent = 'Recovered after refresh · saved on this device';
    });
    await page.click('[data-edit-report]');
    await page.waitForFunction(() => document.querySelector('#report-modal')?.open);
    const reopenedBanner = await page.$eval('#autosave-status', el => el.textContent || '');
    assert.equal(/restored after refresh|recovered after refresh/i.test(reopenedBanner), false, reopenedBanner);
    let stableLines = null;
    for (let pass = 0; pass < 3; pass += 1) {
      if (pass) {
        await page.click('#report-back');
        await page.waitForFunction(() => document.querySelector('#report-form')?.getAttribute('data-current-step') === '1');
      }
      await page.click('#report-next-step');
      await page.waitForFunction(() => {
        const button = document.querySelector('#report-next-step');
        const rows = [...document.querySelectorAll('.production-entry')];
        return button && !button.disabled && document.querySelector('#report-form')?.getAttribute('data-current-step') === '2' && rows.filter(row => row.dataset.estimateItemId === '1' || row.dataset.estimateItemId === '5').length >= 2;
      }, { timeout: 20000 });
      const snap = await page.evaluate(() => {
        const lines = [...document.querySelectorAll('.production-entry')].map(row => ({
          id: row.dataset.estimateItemId || '',
          qty: Number(row.querySelector('.production-quantity')?.value) || 0,
          minutes: Number(row.dataset.laborMinutes) || 0
        }));
        return {
          count: lines.length,
          qty: lines.reduce((sum, row) => sum + row.qty, 0),
          minutes: lines.reduce((sum, row) => sum + row.minutes, 0),
          ids: lines.map(row => row.id)
        };
      });
      if (!stableLines) stableLines = snap;
      assert.equal(snap.count, 2, JSON.stringify(snap));
      assert.equal(snap.qty, 60, JSON.stringify(snap));
      assert.equal(snap.minutes, stableLines.minutes, JSON.stringify({ snap, stableLines }));
      assert.equal(snap.ids.filter(id => id === '1').length, 1, JSON.stringify(snap));
      assert.equal(snap.ids.filter(id => id === '5').length, 1, JSON.stringify(snap));
    }
    assert.equal(await page.$eval('#save-report', el => el.textContent.trim()), 'Send to office');
    await shot(page, 'field-reopen-stable.png');
    await page.evaluate(() => document.querySelector('#report-modal .close-button')?.click());
    await page.waitForFunction(() => !document.querySelector('#report-modal')?.open);
    await page.click('[data-open-report]');
    await page.waitForFunction(() => {
      const notes = document.querySelector('#field-notes')?.value || '';
      const ids = [...document.querySelectorAll('.production-entry')].map(row => row.dataset.estimateItemId);
      return document.querySelector('#report-modal')?.open && document.querySelector('#report-modal-title')?.textContent === 'Verify daily report' && /gutter/i.test(notes) && ids.length === 2 && ids.includes('1') && ids.includes('5');
    }, { timeout: 20000 });
    await page.evaluate(() => document.querySelector('#report-modal .close-button')?.click());
    await page.waitForFunction(() => !document.querySelector('#report-modal')?.open);
    await openNav(page, 'myday');
    await page.evaluate(() => {
      document.querySelector('#sidebar')?.classList.remove('open');
      document.querySelector('[data-assignment-daily]')?.click();
    });
    await page.waitForFunction(() => {
      const notes = document.querySelector('#field-notes')?.value || '';
      const ids = [...document.querySelectorAll('.production-entry')].map(row => row.dataset.estimateItemId);
      const banner = document.querySelector('#autosave-status')?.textContent || '';
      return document.querySelector('#report-modal')?.open && document.querySelector('#report-modal-title')?.textContent === 'Verify daily report' && /gutter/i.test(notes) && ids.length === 2 && !/restored after refresh|recovered after refresh/i.test(banner);
    }, { timeout: 20000 });
    const oneDaily = await page.evaluate(async () => {
      const state = await (await fetch('/api/state', { credentials: 'include' })).json();
      return (state.reports || []).filter(row => /gutter/i.test(row.notes || row.originalNotes || '')).length;
    });
    assert.equal(oneDaily, 1);
    await shot(page, 'field-plus-daily.png');
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
    await page.waitForFunction(() => {
      const needle = "Clocked out. The punch is on today's daily.";
      return [...document.querySelectorAll('#toast, #report-submit-status, #end-day-message, #autosave-status')].some(el => (el.textContent || '').includes(needle));
    }, { timeout: 20000 });
    const clockOutBanners = await page.evaluate(() => {
      const needle = "Clocked out. The punch is on today's daily.";
      return [...document.querySelectorAll('#toast, #report-submit-status, #end-day-message, #autosave-status')].filter(el => {
        if (!(el.textContent || '').includes(needle)) return false;
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
      }).map(el => el.id || el.className);
    });
    assert.equal(clockOutBanners.length, 1, JSON.stringify(clockOutBanners));
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
        gaps: report?.laborGaps || [],
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
    assert.ok(saved.gaps.length >= 2, JSON.stringify(saved.gaps));
    assert.ok(saved.gaps.every(row => row.hours == null && row.hoursStatus === 'hours not entered' && row.hours !== 0), JSON.stringify(saved.gaps));
    assert.equal(saved.labor.some(row => row.hours === 0), false, JSON.stringify(saved.labor));
    const ownerContext = await browser.createBrowserContext();
    const owner = await ownerContext.newPage();
    owner.__port = port;
    await owner.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await owner.evaluateOnNewDocument(() => localStorage.setItem('pdl-analytics-consent', 'declined'));
    await login(owner, OWNER_EMAIL, OWNER_PASSWORD);
    await openNav(owner, 'reports');
    await owner.waitForFunction(() => {
      const text = document.querySelector('#report-detail')?.innerText || '';
      return /Curb/.test(text) && /Gutter/.test(text) && /40/.test(text) && /20/.test(text) && /site owner/.test(text) && /hours not entered/i.test(text) && /\d+ min · \d+\.\d{2} h/.test(text);
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
    const glance = await owner.evaluate(() => [...document.querySelectorAll('#report-list .report-list-item')].map(el => el.innerText));
    const officeCard = glance.find(text => /Left the site/.test(text));
    assert.ok(officeCard, glance.join('\n---\n'));
    assert.match(officeCard, /Extra work/);
    assert.match(officeCard, /Left the site\. Gate is locked\./);
    await owner.evaluate(() => document.querySelector('#report-list')?.scrollIntoView());
    await shot(owner, 'office-list-glance.png');
    const curbAfterOut = await page.$('[data-review-labor][data-line-id="1"]');
    await curbAfterOut.click();
    await page.evaluate(el => { el.focus(); el.setSelectionRange(0, el.value.length); }, curbAfterOut);
    await page.keyboard.type('2');
    await page.evaluate(() => document.activeElement?.blur?.());
    let savedLock = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      savedLock = await page.evaluate(async () => {
        const state = await (await fetch('/api/state', { credentials: 'include' })).json();
        const report = (state.reports || []).find(row => /gutter/i.test(row.notes || row.originalNotes || ''));
        const curb = (report?.productionEntries || []).find(row => Number(row.estimateItemId) === 1);
        return { manual: curb?.laborManual === true, minutes: Number(curb?.laborMinutes) || 0, status: document.querySelector('#report-submit-status')?.textContent || '' };
      });
      if (savedLock.manual && savedLock.minutes === 2) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(savedLock.manual, true, JSON.stringify(savedLock));
    assert.equal(savedLock.minutes, 2, JSON.stringify(savedLock));
    await page.evaluate(() => document.querySelector('#report-modal .close-button')?.click());
    await page.waitForFunction(() => !document.querySelector('#report-modal')?.open);
    await page.evaluate(() => {
      document.querySelector('#sidebar')?.classList.remove('open');
      (document.querySelector('[data-open-report]') || document.querySelector('[data-assignment-daily]'))?.click();
    });
    await page.waitForFunction(() => document.querySelector('#report-modal')?.open && document.querySelector('#report-modal-title')?.textContent === 'Verify daily report', { timeout: 20000 });
    for (let pass = 0; pass < 3; pass += 1) {
      if (pass) {
        await page.click('#report-back');
        await page.waitForFunction(() => document.querySelector('#report-form')?.getAttribute('data-current-step') === '1');
      }
      await page.click('#report-next-step');
      await page.waitForFunction(() => {
        const button = document.querySelector('#report-next-step');
        const row = [...document.querySelectorAll('.production-entry')].find(line => line.dataset.estimateItemId === '1');
        const badge = document.querySelector('[data-review-labor][data-line-id="1"]')?.closest('.field-review-card')?.querySelector('small')?.textContent || '';
        return button && !button.disabled && document.querySelector('#report-form')?.getAttribute('data-current-step') === '2' && row?.dataset.laborManual === 'true' && Number(row.dataset.laborMinutes) === 2 && /manual/i.test(badge);
      }, { timeout: 20000 });
      const held = await page.evaluate(() => {
        const row = [...document.querySelectorAll('.production-entry')].find(line => line.dataset.estimateItemId === '1');
        const badge = document.querySelector('[data-review-labor][data-line-id="1"]')?.closest('.field-review-card')?.querySelector('small')?.textContent || '';
        return { manual: row?.dataset.laborManual === 'true', minutes: Number(row?.dataset.laborMinutes) || 0, badge };
      });
      assert.equal(held.manual, true, JSON.stringify(held));
      assert.equal(held.minutes, 2, JSON.stringify(held));
      assert.match(held.badge, /manual/i, held.badge);
    }
    await shot(page, 'field-lock-held.png');
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
    if (browser) await browser.close().catch(() => {});
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exit(1); });
