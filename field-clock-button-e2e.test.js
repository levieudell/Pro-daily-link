'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

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
  await page.$eval('#email', element => { element.value = 'levi+field@prodailylink.com'; });
  await page.$eval('#password', element => { element.value = 'staging-field-pass'; });
  await page.click('form#login button.primary');
  await page.waitForFunction(() => location.pathname.includes('/app'), { timeout: 20000 });
  await page.waitForSelector('#field-start-card .hero-start-button', { timeout: 20000 });
  await page.evaluate(() => {
    document.body.classList.add('field-mode');
    document.documentElement.classList.add('workspace-ready');
    const shell = document.querySelector('.app-shell');
    if (shell) shell.hidden = false;
    document.querySelectorAll('.page').forEach(pageNode => pageNode.classList.toggle('active', pageNode.id === 'myday-page'));
  });
}

(async () => {
  const chrome = process.env.PDL_TEST_CHROME || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome-stable');
  assert.ok(fs.existsSync(chrome), 'Chrome is required for the mobile Clock in test');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-clock-button-'));
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    PDL_STAGING: '1',
    PDL_STAGING_OWNER_PASSWORD: 'staging-owner-pass',
    PDL_STAGING_FIELD_PASSWORD: 'staging-field-pass',
    PDL_DB_FILE: path.join(root, 'db.json'),
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
    browser = await puppeteer().launch({ executablePath: chrome, headless: true, userDataDir: path.join(root, 'chrome-profile'), args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`staging server did not start\n${log}`)), 20000);
      const poll = () => {
        if (log.includes('running at')) { clearTimeout(timer); resolve(); return; }
        if (child.exitCode != null) { clearTimeout(timer); reject(new Error(`server exited\n${log}`)); return; }
        setTimeout(poll, 100);
      };
      poll();
    });
    const page = await browser.newPage();
    const browserErrors = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    await page.evaluateOnNewDocument(() => localStorage.setItem('pdl-analytics-consent', 'declined'));
    try { await login(page, port); } catch (error) { throw new Error(`${error.message}\nBrowser errors: ${browserErrors.join(' | ')}\nServer log: ${log}`); }
    const layout = await page.$eval('#field-start-card', card => {
      const button = card.querySelector('.hero-start-button');
      const cardBox = card.getBoundingClientRect();
      const buttonBox = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return {
        cardWidth: cardBox.width,
        buttonWidth: buttonBox.width,
        buttonHeight: buttonBox.height,
        whiteSpace: style.whiteSpace,
        textFits: button.scrollWidth <= button.clientWidth
      };
    });
    assert.ok(layout.buttonWidth >= layout.cardWidth - 45, JSON.stringify(layout));
    assert.ok(layout.buttonHeight >= 56, JSON.stringify(layout));
    assert.equal(layout.whiteSpace, 'nowrap', JSON.stringify(layout));
    assert.equal(layout.textFits, true, JSON.stringify(layout));
    console.log('Mobile field Clock in passed: the primary action is full width, thumb-sized, and never wraps.');
  } finally {
    if (browser) await browser.close();
    child.kill();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
