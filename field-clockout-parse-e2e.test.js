'use strict';
// 390px: notes typed at clock-out must be parsed like a review Done tap,
// with no extra tap. A 2-minute punch must not land on an empty production
// line. After send, the clock list must show submitted without a reload.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const NOTES = 'Poured 40 LF of curb and 20 LF of gutter. Used 6 yards of concrete. Owner asked us to add an extra equipment pad.';
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
}

async function login(page) {
  await page.goto(`http://127.0.0.1:${page.__port}/login.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#email');
  await page.$eval('#email', (el, value) => { el.value = value; }, FIELD_EMAIL);
  await page.$eval('#password', (el, value) => { el.value = value; }, FIELD_PASSWORD);
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

(async () => {
  const chrome = process.env.PDL_TEST_CHROME || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome-stable');
  assert.ok(fs.existsSync(chrome), 'Chrome is required for the clock-out parse test');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-clockout-parse-'));
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
    browser = await puppeteer().launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
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
    pinOpenPunch(dbFile, 2);
    const aiRequests=[];page.on('request',request=>{if(request.url().includes('/api/ai/extract'))aiRequests.push(request.url())});
    await page.click('#start-day-button');
    await page.waitForFunction(()=>document.querySelector('#report-modal')?.open&&endingWorkdays.size===0,{timeout:20000});
    assert.equal(await page.$eval('#field-notes',el=>el.value),'','clock-out opens the blank daily directly');
    assert.equal(await page.$eval('#end-day-modal',el=>el.open),false);
    assert.equal(aiRequests.length,0,'blank clock-out does not analyze notes');
    await require('./scripts/field-report-test-helpers.cjs').completeClockOutDaily(page,NOTES,'');
    try {
      await page.waitForFunction(() => {
        const modal = document.querySelector('#report-modal');
        if (!modal?.open || document.querySelector('#end-day-modal')?.open) return false;
        if (document.querySelector('#report-form')?.getAttribute('data-current-step') !== '2') return false;
        const lines = [...document.querySelectorAll('.production-entry')];
        const curb = lines.some(row => row.dataset.estimateItemId === '1' && row.querySelector('.production-quantity')?.value === '40');
        const gutter = lines.some(row => row.dataset.estimateItemId === '5' && row.querySelector('.production-quantity')?.value === '20');
        const materials = /6 yards of concrete/i.test(document.querySelector('#report-materials')?.value || '');
        const extra = [...document.querySelectorAll('[data-flag-choice="yes"]')].some(button => /Yes, extra/i.test(button.textContent || ''));
        const minutes = [...document.querySelectorAll('[data-review-labor]')].reduce((sum, input) => sum + (Number(input.value) || 0), 0);
        return curb && gutter && materials && extra && minutes === 2;
      }, { timeout: 20000 });
    } catch (error) {
      const snapshot = await page.evaluate(() => ({
        step: document.querySelector('#report-form')?.getAttribute('data-current-step') || '',
        lines: [...document.querySelectorAll('.production-entry')].map(row => ({
          id: row.dataset.estimateItemId || '',
          qty: row.querySelector('.production-quantity')?.value || '',
          hours: row.querySelector('.production-hours')?.value || ''
        })),
        materials: document.querySelector('#report-materials')?.value || '',
        flags: document.querySelector('#field-scope-flags')?.innerText || '',
        status: document.querySelector('#report-submit-status')?.textContent || '',
        review: (document.querySelector('#field-review-cards')?.innerText || '').slice(0, 800)
      }));
      throw new Error(`${error.message}\n${JSON.stringify(snapshot, null, 2)}`);
    }
    const blocked = await page.$eval('#report-modal', el => el.innerText);
    assert.equal(/Crew hours \(0\.03\) must equal allocated work-line hours \(0\)/.test(blocked), false, blocked);
    assert.match(blocked, /6 yards of concrete/);
    assert.match(blocked, /Yes, extra/);
    await page.evaluate(() => document.querySelector('[data-flag-choice="yes"]')?.click());
    await page.evaluate(() => document.querySelector('#save-report')?.click());
    await page.waitForSelector('#report-sent-modal[open]', { timeout: 20000 });
    await page.click('#report-sent-modal button.primary');
    await openNav(page, 'fieldday');
    const clockText = await page.$eval('#field-clock-hours', el => el.innerText);
    assert.equal(/· draft\b/i.test(clockText), false, clockText);
    assert.match(clockText, /· submitted/);
    console.log('Clock-out notes parse browser flow passed.');
  } finally {
    if (browser) await browser.close();
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
