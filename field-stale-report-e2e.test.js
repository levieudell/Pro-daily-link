'use strict';
// 390px: a later clock-out refreshes the Reports daily without a reload,
// and sending from an editor that missed that clock-out keeps the merged daily.
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
const STALE_NOTES = 'Stale note from the phone.';
const STALE_NEXT = 'Stale next';
const FIELD_EMAIL = 'levi+field@prodailylink.com';
const FIELD_PASSWORD = 'staging-field-pass';
const OWNER_EMAIL = 'levi+owner@prodailylink.com';
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
  return start;
}

async function login(page, email = FIELD_EMAIL, password = FIELD_PASSWORD) {
  await page.goto(`http://127.0.0.1:${page.__port}/login.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#email');
  await page.$eval('#email', (el, value) => { el.value = value; }, email);
  await page.$eval('#password', (el, value) => { el.value = value; }, password);
  await page.click('form#login button.primary');
  await page.waitForFunction(() => location.pathname.includes('/app'), { timeout: 20000 });
  await page.waitForSelector('#menu-button', { timeout: 20000 });
  await page.waitForFunction(()=>typeof currentUser!=='undefined'&&currentUser?.memberId&&typeof team!=='undefined'&&team.some(row=>Number(row.id)===Number(currentUser.memberId)),{timeout:20000});
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
  await require('./scripts/field-report-test-helpers.cjs').completeClockOutDaily(page,notes,next);
  await page.waitForFunction(() => !document.querySelector('#end-day-modal')?.open, { timeout: 20000 });
}

async function detailFacts(page) {
  return page.evaluate(() => {
    const detail = document.querySelector('#report-detail');
    const box = label => {
      const node = [...(detail?.querySelectorAll('.data-box') || [])].find(row => new RegExp(label, 'i').test(row.querySelector('small')?.textContent || ''));
      return node?.querySelector('strong')?.textContent || '';
    };
    return {
      text: detail?.innerText || '',
      next: box('NEXT STEP'),
      labor: box('LABOR'),
      summary: detail?.querySelector('.ai-banner p')?.textContent || '',
      list: document.querySelector('#report-list')?.innerText || '',
      edit: document.querySelector('[data-edit-report]')?.dataset.editReport || '',
      stayed: window.__reportsStay || ''
    };
  });
}

async function serverDaily(page) {
  return page.evaluate(async () => {
    const data = await (await fetch('/api/state', { credentials: 'include' })).json();
    const report = (data.reports || [])[0] || null;
    return {
      count: (data.reports || []).length,
      id: report?.id || null,
      status: report?.status || '',
      notes: report?.notes || '',
      summary: report?.summary || '',
      next: report?.next || '',
      minutes: (report?.laborEntries || []).reduce((sum, row) => sum + (Number(row.minutes) || 0), 0)
    };
  });
}

(async () => {
  assert.ok(fs.existsSync('/usr/bin/google-chrome-stable'), 'Chrome is required for the stale report test');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-stale-report-'));
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
    await page.waitForSelector('#report-modal[open]', { timeout: 20000 });
    await page.click('#report-modal .close-button');
    await page.waitForFunction(() => !document.querySelector('#report-modal')?.open, { timeout: 5000 });
    await openNav(page, 'reports');
    await page.waitForFunction(() => /backfill curb/i.test(document.querySelector('#report-detail')?.innerText || ''), { timeout: 10000 });
    const firstPaint = await detailFacts(page);
    assert.match(firstPaint.next, /backfill curb/);
    assert.match(firstPaint.labor, /2 min/);
    assert.doesNotMatch(firstPaint.text, /Pour pad Monday|Set forms/);
    await page.evaluate(() => { window.__reportsStay = 'open'; });
    await openNav(page, 'fieldday');
    await openClockIn(page);
    await chooseJob(page);
    await page.click('#confirm-start-day');
    await page.waitForFunction(() => /Clock out/i.test(document.querySelector('#start-day-button')?.textContent || ''), { timeout: 20000 });
    await clockOut(page, dbFile, NOTES_2, NEXT_2, 2);
    const editorClosed = await page.evaluate(() => !document.querySelector('#report-modal')?.open);
    assert.equal(editorClosed, false,'attached daily opens directly');
    await page.evaluate(()=>document.querySelector('#report-modal').close());
    const merged = await serverDaily(page);
    assert.equal(merged.count, 1, JSON.stringify(merged));
    assert.equal(merged.next, NEXT_2, JSON.stringify(merged));
    assert.match(merged.notes, /Set forms/);
    assert.match(merged.summary, /Set forms/);
    assert.ok(merged.minutes > 2, JSON.stringify(merged));
    await openNav(page, 'reports');
    let painted;
    try {
      await page.waitForFunction(minutes => {
        const text = document.querySelector('#report-detail')?.innerText || '';
        const next = [...document.querySelectorAll('#report-detail .data-box')].find(row => /NEXT STEP/i.test(row.querySelector('small')?.textContent || ''))?.querySelector('strong')?.textContent || '';
        return window.__reportsStay === 'open' && next === 'Pour pad Monday' && /Set forms/.test(text) && new RegExp(`${minutes} min`).test(text);
      }, { timeout: 10000 }, merged.minutes);
      painted = await detailFacts(page);
    } catch (error) {
      painted = await detailFacts(page);
      throw new Error(`${error.message}\n${JSON.stringify(painted, null, 2)}`);
    }
    assert.equal(painted.stayed, 'open');
    assert.equal(painted.next, NEXT_2, JSON.stringify(painted));
    assert.match(painted.summary, /Set forms/);
    assert.match(painted.labor, new RegExp(`${merged.minutes} min`));
    assert.match(painted.list, /Cedar Grove|Draft/);
    assert.equal(painted.edit, String(merged.id));
    await page.click('[data-edit-report]');
    await page.waitForSelector('#report-modal[open] #field-notes', { timeout: 20000 });
    const opened = await page.evaluate(() => ({
      notes: document.querySelector('#field-notes')?.value || '',
      next: document.querySelector('#report-next')?.value || ''
    }));
    assert.match(opened.notes, /Set forms/);
    assert.doesNotMatch(opened.notes, /Cleaned up site/);
    assert.match(opened.next, /Pour pad Monday/);
    const background = await page.evaluate(async () => {
      const response = await fetch('/api/workdays/start', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 3, memberIds: [1] }) });
      const data = await response.json();
      return { status: response.status, id: data.id || null, error: data.error || '' };
    });
    assert.equal(background.status, 201, JSON.stringify(background));
    pinOpenPunch(dbFile, 1);
    const ended = await page.evaluate(async id => {
      const response = await fetch('/api/workdays/' + id + '/end', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: 'Cleaned up site.', next: '' }) });
      const data = await response.json();
      return { status: response.status, attached: data.attached === true, next: data.report?.next || '', notes: data.report?.notes || '', error: data.error || '', minutes: (data.report?.laborEntries || []).reduce((sum, row) => sum + (Number(row.minutes) || 0), 0) };
    }, background.id);
    assert.equal(ended.status, 200, JSON.stringify(ended));
    assert.equal(ended.attached, true, JSON.stringify(ended));
    assert.equal(ended.next, NEXT_2, JSON.stringify(ended));
    assert.match(ended.notes, /Cleaned up site/);
    assert.ok(ended.minutes > merged.minutes, JSON.stringify(ended));
    const stillStale = await page.evaluate(() => ({
      notes: document.querySelector('#field-notes')?.value || '',
      open: Boolean(document.querySelector('#report-modal')?.open)
    }));
    assert.equal(stillStale.open, true);
    assert.doesNotMatch(stillStale.notes, /Cleaned up site/);
    await page.evaluate((notes, next) => {
      const field = document.querySelector('#field-notes');
      const step = document.querySelector('#report-next');
      if (field) field.value = notes;
      if (step) step.value = next;
    }, STALE_NOTES, STALE_NEXT);
    await page.click('#report-next-step');
    await page.waitForFunction(() => document.querySelector('#report-form')?.getAttribute('data-current-step') === '2' && !document.querySelector('#save-report')?.disabled, { timeout: 20000 });
    await page.evaluate(next => {
      const step = document.querySelector('#report-next');
      const review = document.querySelector('#field-review-next');
      if (step) step.value = next;
      if (review) review.value = next;
      if (!document.querySelector('.production-entry') && typeof addProductionRow === 'function') addProductionRow();
      const row = document.querySelector('.production-entry');
      const select = row?.querySelector('.production-item');
      const curb = select && [...select.options].find(option => /curb/i.test(option.textContent || ''));
      if (curb) {
        select.value = curb.value;
        row.dataset.estimateItemId = curb.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const quantity = row?.querySelector('.production-quantity');
      if (quantity) quantity.value = '40';
      const unit = row?.querySelector('.production-unit');
      if (unit && !unit.value) unit.value = 'LF';
    }, STALE_NEXT);
    await page.click('#save-report');
    try {
      await page.waitForFunction(() => {
        const status = document.querySelector('#report-submit-status')?.textContent || '';
        const toast = document.querySelector('#toast')?.textContent || '';
        const notes = document.querySelector('#field-notes')?.value || '';
        return /This daily was updated, reloading/.test(`${status}\n${toast}`) && /Cleaned up site/.test(notes) && /Set forms/.test(notes);
      }, { timeout: 20000 });
    } catch (error) {
      const snapshot = await page.evaluate(async () => {
        const data = await (await fetch('/api/state', { credentials: 'include' })).json();
        const report = (data.reports || [])[0] || null;
        const memory = (typeof reports === 'undefined' ? [] : reports)[0] || null;
        return {
          status: document.querySelector('#report-submit-status')?.textContent || '',
          toast: document.querySelector('#toast')?.textContent || '',
          notes: document.querySelector('#field-notes')?.value || '',
          next: document.querySelector('#report-next')?.value || '',
          reviewNext: document.querySelector('#field-review-next')?.value || '',
          step: document.querySelector('#report-form')?.getAttribute('data-current-step') || '',
          hours: [...document.querySelectorAll('[data-labor-member]')].map(el => el.value),
          serverNotes: report?.notes || '',
          serverNext: report?.next || '',
          memoryNotes: memory?.notes || '',
          memoryOriginal: memory?.originalNotes || ''
        };
      });
      throw new Error(`${error.message}\n${JSON.stringify(snapshot, null, 2)}`);
    }
    const survived = await serverDaily(page);
    assert.equal(survived.count, 1, JSON.stringify(survived));
    assert.equal(survived.id, merged.id);
    assert.equal(survived.status, 'Draft', JSON.stringify(survived));
    assert.equal(survived.next, NEXT_2, JSON.stringify(survived));
    assert.match(survived.notes, /Set forms/);
    assert.match(survived.notes, /Cleaned up site/);
    assert.match(survived.summary, /Cleaned up site/);
    assert.equal(new RegExp(STALE_NOTES).test(survived.notes + survived.next + survived.summary), false, JSON.stringify(survived));
    assert.equal(new RegExp(STALE_NEXT).test(survived.notes + survived.next), false, JSON.stringify(survived));
    assert.equal(survived.minutes, ended.minutes, JSON.stringify(survived));
    const reloaded = await page.evaluate(() => ({
      notes: document.querySelector('#field-notes')?.value || '',
      next: document.querySelector('#report-next')?.value || '',
      reviewNext: document.querySelector('#field-review-next')?.value || '',
      status: document.querySelector('#report-submit-status')?.textContent || ''
    }));
    assert.match(reloaded.notes, /Set forms/);
    assert.match(reloaded.notes, /Cleaned up site/);
    assert.match(reloaded.next, /Pour pad Monday/);
    assert.doesNotMatch(`${reloaded.notes}\n${reloaded.next}\n${reloaded.reviewNext}`, /Stale note|Stale next/);
    assert.match(reloaded.status, /This daily was updated, reloading/);
    const punchLabel = minutes => `${minutes} min · ${(Math.round(minutes / 60 * 100) / 100).toFixed(2)} h`;
    const freshLabel = punchLabel(ended.minutes);
    const staleLabel = punchLabel(merged.minutes);
    let refreshed;
    try {
      await page.waitForFunction(label => {
        const total = document.querySelector('.field-labor-total')?.textContent || '';
        const fromClock = [...document.querySelectorAll('#field-review-cards .field-review-card')].some(card => /From clock/i.test(card.querySelector('small')?.textContent || '') && (card.innerText || '').includes(label));
        const curb = [...document.querySelectorAll('.production-entry')].some(row => /curb/i.test(row.querySelector('.production-item')?.selectedOptions?.[0]?.textContent || '') && row.querySelector('.production-quantity')?.value === '40');
        const add = /Add line/.test(document.querySelector('#field-add-line')?.textContent || '');
        return fromClock && total.includes(label) && curb && add;
      }, { timeout: 20000 }, freshLabel);
      refreshed = await page.evaluate(() => ({
        total: document.querySelector('.field-labor-total')?.textContent || '',
        fromClock: [...document.querySelectorAll('#field-review-cards .field-review-card')].filter(card => /From clock/i.test(card.querySelector('small')?.textContent || '')).map(card => card.innerText || ''),
        curb: [...document.querySelectorAll('.production-entry')].map(row => ({ name: row.querySelector('.production-item')?.selectedOptions?.[0]?.textContent || '', qty: row.querySelector('.production-quantity')?.value || '', unit: row.querySelector('.production-unit')?.value || '' })),
        add: document.querySelector('#field-add-line')?.textContent || ''
      }));
    } catch (error) {
      refreshed = await page.evaluate(() => ({
        step: document.querySelector('#report-form')?.getAttribute('data-current-step') || '',
        total: document.querySelector('.field-labor-total')?.textContent || '',
        cards: document.querySelector('#field-review-cards')?.innerText || '',
        curb: [...document.querySelectorAll('.production-entry')].map(row => ({ name: row.querySelector('.production-item')?.selectedOptions?.[0]?.textContent || row.querySelector('.custom-description')?.value || '', qty: row.querySelector('.production-quantity')?.value || '', unit: row.querySelector('.production-unit')?.value || '' })),
        add: document.querySelector('#field-add-line')?.textContent || '',
        hours: [...document.querySelectorAll('[data-labor-member]')].map(el => ({ value: el.value, derived: el.dataset.timecardDerived || '' }))
      }));
      throw new Error(`${error.message}\n${JSON.stringify(refreshed, null, 2)}`);
    }
    assert.match(refreshed.total, new RegExp(freshLabel.replace(/[.]/g, '\\.')));
    assert.ok(refreshed.fromClock.some(text => text.includes(freshLabel)), JSON.stringify(refreshed));
    if (freshLabel !== staleLabel) assert.equal(refreshed.total.includes(staleLabel), false, JSON.stringify(refreshed));
    assert.ok(refreshed.curb.some(row => /curb/i.test(row.name) && row.qty === '40' && /LF/i.test(row.unit)), JSON.stringify(refreshed));
    assert.match(refreshed.add, /Add line/);
    if (await page.$eval('#report-form', form => form.getAttribute('data-current-step')) === '2') {
      await page.click('#report-back');
      await page.waitForFunction(() => document.querySelector('#report-form')?.getAttribute('data-current-step') === '1');
    }
    await page.click('#report-next-step');
    try {
      await page.waitForFunction(() => {
        const flags = document.querySelector('#field-scope-flags')?.innerText || '';
        const curb = [...document.querySelectorAll('.production-entry')].some(row => /curb/i.test(row.querySelector('.production-item')?.selectedOptions?.[0]?.textContent || '') && row.querySelector('.production-quantity')?.value === '40');
        return /Needs your pick/i.test(flags) && /Set forms/i.test(flags) && curb;
      }, { timeout: 20000 });
    } catch (error) {
      const parsed = await page.evaluate(() => ({
        flags: document.querySelector('#field-scope-flags')?.innerText || '',
        status: document.querySelector('#report-submit-status')?.textContent || '',
        notes: document.querySelector('#field-notes')?.value || '',
        curb: [...document.querySelectorAll('.production-entry')].map(row => ({ name: row.querySelector('.production-item')?.selectedOptions?.[0]?.textContent || row.querySelector('.custom-description')?.value || '', qty: row.querySelector('.production-quantity')?.value || '', extra: row.dataset.extraWork || '' }))
      }));
      throw new Error(`${error.message}\n${JSON.stringify(parsed, null, 2)}`);
    }
    await page.evaluate(()=>document.querySelector('[data-flag-choice="extra"]')?.click());
    await page.waitForFunction(() => {
      const row = [...document.querySelectorAll('.production-entry')].find(entry => entry.dataset.extraWork === 'true');
      const card = [...document.querySelectorAll('#field-review-cards .field-review-card')].find(node => /Set forms/i.test(node.innerText || ''));
      return row && !(Number(row.querySelector('.production-quantity')?.value) > 0) && card && !/Quantity needed/i.test(card.innerText || '');
    }, { timeout: 10000 });
    await page.click('#save-report');
    try {
      await page.waitForSelector('#report-sent-modal[open]', { timeout: 20000 });
    } catch (error) {
      const blocked = await page.evaluate(async () => {
        const data = await (await fetch('/api/state', { credentials: 'include' })).json();
        const report = (data.reports || [])[0] || null;
        return {
          status: document.querySelector('#report-submit-status')?.textContent || '',
          toast: document.querySelector('#toast')?.textContent || '',
          lines: [...document.querySelectorAll('.production-entry')].map(row => ({ extra: row.dataset.extraWork || '', qty: row.querySelector('.production-quantity')?.value || '', hours: row.querySelector('.production-hours')?.value || '', minutes: row.dataset.laborMinutes || '' })),
          serverStatus: report?.status || '',
          extra: report?.extraWork || []
        };
      });
      throw new Error(`${error.message}\n${JSON.stringify(blocked, null, 2)}`);
    }
    const sent = await page.evaluate(async () => {
      const data = await (await fetch('/api/state', { credentials: 'include' })).json();
      const report = (data.reports || [])[0] || null;
      return {
        status: report?.status || '',
        extra: (report?.extraWork || []).map(item => item.description || ''),
        curb: (report?.productionEntries || []).filter(row => /curb/i.test(row.description || '')).map(row => ({ qty: Number(row.quantity), unit: row.unit || '' }))
      };
    });
    assert.equal(sent.status, 'Needs review', JSON.stringify(sent));
    assert.ok(sent.extra.some(text => /Set forms/i.test(text)), JSON.stringify(sent));
    assert.ok(sent.curb.some(row => row.qty === 40), JSON.stringify(sent));
    const ownerContext = await browser.createBrowserContext();
    const owner = await ownerContext.newPage();
    owner.__port = port;
    await owner.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    owner.on('dialog', async dialog => { await dialog.accept(); });
    await owner.evaluateOnNewDocument(() => localStorage.setItem('pdl-analytics-consent', 'declined'));
    await login(owner, OWNER_EMAIL, OWNER_PASSWORD);
    await openNav(owner, 'reports');
    await owner.waitForFunction(() => {
      const text = document.querySelector('#report-detail')?.innerText || '';
      return /Set forms/i.test(text) && /Curb/i.test(text) && /40/.test(text);
    }, { timeout: 20000 });
    const office = await owner.evaluate(() => ({
      extra: document.querySelector('#report-detail .extra-work-item')?.innerText || '',
      production: [...document.querySelectorAll('#report-detail .data-box')].find(row => /PRODUCTION/i.test(row.querySelector('small')?.textContent || ''))?.innerText || ''
    }));
    assert.match(office.extra, /Set forms/);
    assert.match(office.production, /Curb/);
    assert.match(office.production, /40/);
    await ownerContext.close();
    const afterSend = await detailFacts(page);
    assert.equal(afterSend.stayed, 'open');
    assert.equal(afterSend.next, NEXT_2, JSON.stringify(afterSend));
    assert.match(afterSend.summary, /Cleaned up site/);
    assert.match(afterSend.labor, new RegExp(`${ended.minutes} min`));
    assert.doesNotMatch(afterSend.text, /Stale note|Stale next/);
    console.log('Stale report refresh and conflict browser flow passed.');
  } finally {
    if (browser) await browser.close();
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
