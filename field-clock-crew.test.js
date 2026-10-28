'use strict';
// Clock-in at 390 lists the assigned crew already ticked. Unticking someone
// keeps them off that workday, so the daily has no hours for them.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const FIELD_EMAIL = 'levi+field@prodailylink.com';
const FIELD_PASSWORD = 'staging-field-pass';
const CHROME = process.env.PDL_TEST_CHROME || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : '/usr/bin/google-chrome-stable');

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

async function login(page, port) {
  await page.goto(`http://127.0.0.1:${port}/login.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#email');
  await page.$eval('#email', (el, value) => { el.value = value; }, FIELD_EMAIL);
  await page.$eval('#password', (el, value) => { el.value = value; }, FIELD_PASSWORD);
  await page.click('form#login button.primary');
  await page.waitForFunction(() => location.pathname.includes('/app'), { timeout: 20000 });
  await page.waitForSelector('#myday-page.active [data-start-day]', { timeout: 20000 });
}

(async () => {
  assert.ok(fs.existsSync(CHROME), `Chrome is required (${CHROME})`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-clock-crew-'));
  const dbFile = path.join(root, 'db.json');
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    PDL_STAGING: '1',
    PDL_STAGING_OWNER_PASSWORD: 'staging-owner-pass',
    PDL_STAGING_FIELD_PASSWORD: FIELD_PASSWORD,
    PDL_DB_FILE: dbFile,
    PDL_PLATFORM_FILE: path.join(root, 'platform.json'),
    PDL_EMAIL_DEV_MODE: '1',
    PDL_SUPABASE_ENABLED: '0',
    PDL_TRANSACTIONAL_DB: 'off',
    OPENAI_API_KEY: ''
  };
  for (const name of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'RESEND_API_KEY', 'INDEXNOW_KEY', 'SENTRY_DSN']) delete env[name];
  const child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start\n' + log)), 20000);
      const poll = () => {
        if (log.includes('running at')) { clearTimeout(timer); resolve(); return; }
        if (child.exitCode != null) { clearTimeout(timer); reject(new Error(log)); return; }
        setTimeout(poll, 100);
      };
      poll();
    });
    browser = await puppeteer().launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    page.on('dialog', async dialog => { await dialog.dismiss(); });
    await login(page, port);
    await page.evaluate(() => document.querySelector('[data-start-day]').click());
    await page.waitForSelector('#start-day-modal[open] #start-day-members input', { timeout: 10000 });
    const crew = await page.evaluate(() => ({
      noted: Boolean(document.querySelector('[data-flag-choice="noted"]')) || /\bNoted\b/.test(document.body.innerText || ''),
      dialogs: [...document.querySelectorAll('dialog[open]')].map(el => el.id),
      people: [...document.querySelectorAll('#start-day-members input')].map(box => ({
        name: box.closest('label')?.innerText || '',
        checked: box.checked,
        id: Number(box.value)
      }))
    }));
    assert.equal(crew.noted, false, JSON.stringify(crew));
    assert.deepEqual(crew.dialogs, ['start-day-modal']);
    const checked = crew.people.filter(person => person.checked).map(person => person.name);
    assert.ok(checked.some(name => /Jordan Reed/i.test(name)), JSON.stringify(crew.people));
    assert.ok(checked.some(name => /Casey Nguyen/i.test(name)), JSON.stringify(crew.people));
    assert.ok(checked.some(name => /Alex Mora/i.test(name)), JSON.stringify(crew.people));
    assert.equal(crew.people.some(person => /Sam Ortiz|Riley Brooks|Avery Lang/i.test(person.name) && person.checked), false, JSON.stringify(crew.people));
    await page.evaluate(() => {
      const box = [...document.querySelectorAll('#start-day-members input')].find(input => /Casey Nguyen/i.test(input.closest('label')?.innerText || ''));
      if (box?.checked) box.click();
    });
    await page.click('#confirm-start-day');
    await page.waitForFunction(() => /Clock out/i.test(document.querySelector('[data-start-day]')?.textContent || '') && !document.querySelector('#start-day-modal')?.open, { timeout: 20000 });
    const started = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    const workday = started.workdays.find(row => row.status === 'active');
    assert.deepEqual((workday?.memberIds || []).map(Number).sort((a, b) => a - b), [1, 3], JSON.stringify(workday));
    await page.evaluate(() => document.querySelector('[data-start-day]').click());
    await page.waitForSelector('#report-modal[open] #field-notes', { timeout: 20000 });
    const saved = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    const closed = saved.workdays.find(row => Number(row.id) === Number(workday.id));
    const report = saved.reports.find(row => Number(row.id) === Number(closed?.reportId)) || saved.reports[0];
    const laborIds = (report?.laborEntries || []).map(row => Number(row.memberId));
    const cardIds = saved.timeCards.filter(card => Number(card.workdayId) === Number(workday.id)).map(card => Number(card.memberId));
    assert.equal(laborIds.includes(2), false, JSON.stringify({ laborIds, cardIds, members: closed?.memberIds }));
    assert.equal(cardIds.includes(2), false, JSON.stringify(cardIds));
    assert.deepEqual(cardIds.slice().sort((a, b) => a - b), [1, 3], JSON.stringify(cardIds));
    console.log('Assigned crew starts ticked, and an unticked person is off the daily.');
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
