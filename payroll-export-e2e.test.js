'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const seed = require('./staging-seed');
const calendar = require('./payroll-ranges');
const { buildPayrollExport, defaultTemplate } = require('./payroll-export');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-payroll-export-'));
const dbFile = path.join(root, 'db.json');
const password = 'local-payroll-test-only';
seed.ensureStagingDatabase(dbFile, { PDL_STAGING_OWNER_PASSWORD: password, PDL_STAGING_FIELD_PASSWORD: password });
seed.ensureStagingOfficeUser(dbFile, { PDL_STAGING: '1', PDL_STAGING_OFFICE_PASSWORD: password });
const db = JSON.parse(fs.readFileSync(dbFile));
const week = calendar.range('week', calendar.today(db.company.timezone), db.company.weekStart);
// Disposable staging seed with approved/unapproved punches; never modifies the live demo.
db.timeCards = [];
for (const start of [week.from, calendar.addDays(week.from, -7)]) for (let day = 0; day < 5; day++) {
  const date = calendar.addDays(start, day), inAt = date + 'T16:00:00Z';
  db.timeCards.push({ id: start + '-' + day, memberId: 1, projectId: day % 2 ? 2 : 1, date, status: 'approved', inAt, outAt: new Date(Date.parse(inAt) + 9 * 3600000).toISOString(), hours: 9 });
}
db.timeCards.push({ id: 'unapproved', memberId: 2, projectId: 1, status: 'submitted', inAt: week.from + 'T16:00:00Z', outAt: week.from + 'T20:00:00Z', hours: 4 });
fs.writeFileSync(dbFile, JSON.stringify(db));
fs.writeFileSync(path.join(root, 'platform.json'), JSON.stringify({ users: [], sessions: [] }));
Object.assign(process.env, { PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: path.join(root, 'platform.json'), PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_PLATFORM_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1', PDL_STAGING: '0', NODE_ENV: 'test' });
for (const key of ['SENTRY_DSN','RESEND_API_KEY','OPENAI_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','DATABASE_URL','INDEXNOW_KEY']) delete process.env[key];
require('./database/supabase').loadLocalEnv = () => {};
const { server } = require('./server');
let browser, base;
const shots = process.env.PDL_PAYROLL_SCREENSHOTS;
async function login(page, email) {
  await page.goto(base + '/login.html'); await page.locator('#email').fill(email); await page.locator('#password').fill(password);
  await page.locator('form#login button.primary').click();
  await page.waitForFunction(() => typeof currentUser !== 'undefined' && currentUser && typeof showPage === 'function');
}
function parseCsv(text) {
  const rows = []; let row = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(value); value = ''; }
    else if (c === '\n' && !quoted) { row.push(value.replace(/\r$/, '')); rows.push(row); row = []; value = ''; }
    else value += c;
  }
  return rows;
}
async function download(page, preset, limit) {
  await page.evaluate(() => { window.payrollTapCount = 0; });
  const start = performance.now();
  await page.locator('#pay-period-panel [data-payroll-export-open]').click();
  assert.equal(await page.locator('[data-payroll-range="week"]').getAttribute('aria-pressed'), 'true');
  let range = calendar.range(preset === 'custom' ? 'week' : preset, calendar.today(db.company.timezone), db.company.weekStart);
  if (preset !== 'week') await page.locator(`[data-payroll-range="${preset}"]`).click();
  if (preset === 'custom') {
    range = { from: calendar.addDays(week.from, 2), to: calendar.addDays(week.from, 4) };
    for (const key of ['from', 'to']) { await page.locator('#payroll-export-' + key).click(); await page.locator('#payroll-export-' + key).fill(range[key]); }
  }
  const [file] = await Promise.all([page.waitForEvent('download'), page.locator('[data-payroll-download="csv"]').click()]);
  const csv = fs.readFileSync(await file.path(), 'utf8'), rows = parseCsv(csv);
  assert.equal(file.suggestedFilename(), defaultTemplate.filename(range));
  assert.deepEqual(rows.shift(), defaultTemplate.columns);
  const totals = rows.filter(row => row[2] === 'WORKER TOTAL');
  const expected = buildPayrollExport(db, range);
  assert.equal(Math.round(totals.reduce((n, row) => n + Number(row[8]), 0) * 100), Math.round(expected.totals.total * 100));
  assert.equal(expected.totals.total, preset === 'custom' ? 27 : 45, 'approved punch sum, excluding the submitted punch');
  assert.deepEqual(totals[0].slice(5), preset === 'custom' ? ['22.00','5.00','0.00','27.00'] : ['40.00','5.00','0.00','45.00']);
  const elapsed = performance.now() - start, taps = await page.evaluate(() => window.payrollTapCount);
  assert.equal(taps, preset === 'week' ? 2 : preset === 'last' ? 3 : 5);
  assert(taps <= limit, `${preset}: ${taps} taps exceeds ${limit}`);
  if (preset !== 'custom') assert(elapsed <= 5000, `${preset}: ${elapsed}ms exceeds 5 seconds`);
  console.log(`Payroll ${page.viewportSize().width}px ${preset}: ${taps} taps, ${Math.round(elapsed)}ms, ${expected.totals.total} approved hours`);
}
async function bounds(page) {
  const palette = await page.locator('#payroll-export-dialog').evaluate(el => ({ theme: document.documentElement.dataset.theme, background: getComputedStyle(el).backgroundColor, primary: getComputedStyle(el.querySelector('[data-payroll-download="csv"]')).backgroundColor }));
  assert.equal(palette.background, palette.theme === 'dark' ? 'rgb(0, 0, 0)' : 'rgb(247, 245, 240)');
  assert.equal(palette.primary, 'rgb(255, 102, 0)');
  const result = await page.evaluate(() => {
    const dialog = document.querySelector('#payroll-export-dialog');
    return { overflow: Math.max(document.documentElement.scrollWidth - innerWidth, dialog.scrollWidth - dialog.clientWidth), buttons: [...dialog.querySelectorAll('button')].filter(b => b.checkVisibility()).map(b => { const r = b.getBoundingClientRect(); return { text: b.textContent, height: r.height, left: r.left, right: r.right, bottom: r.bottom }; }) };
  });
  assert(result.overflow <= 1, JSON.stringify(result));
  for (const b of result.buttons) assert(b.height >= 48 && b.left >= 0 && b.right <= page.viewportSize().width && b.bottom <= page.viewportSize().height, JSON.stringify(b));
  const contrast = await page.locator('#payroll-export-dialog').evaluate(dialog => {
    const rgb = color => color.match(/[\d.]+/g).map(Number);
    const lum = color => rgb(color).slice(0, 3).map(v => (v /= 255) <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((n, v, i) => n + v * [.2126,.7152,.0722][i], 0);
    return [...dialog.querySelectorAll('h2,p,button,label,input')].filter(el => el.checkVisibility()).map(el => {
      let parent = el; while (parent && rgb(getComputedStyle(parent).backgroundColor)[3] === 0) parent = parent.parentElement;
      const css = getComputedStyle(el), a = lum(css.color), b = lum(getComputedStyle(parent).backgroundColor);
      return { text: el.textContent, ratio: (Math.max(a,b)+.05)/(Math.min(a,b)+.05), min: parseFloat(css.fontSize) >= 24 || parseFloat(css.fontSize) >= 18.66 && Number(css.fontWeight) >= 700 ? 3 : 4.5 };
    });
  });
  for (const item of contrast) assert(item.ratio >= item.min, JSON.stringify(item));
}
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;
  try {
    browser = await chromium.launch({ executablePath: process.env.PDL_TEST_CHROME || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome-stable'), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ acceptDownloads: true }), page = await context.newPage();
    await page.addInitScript(() => { localStorage.setItem('pdl-analytics-consent','declined'); document.addEventListener('click', event => { if (event.isTrusted) window.payrollTapCount = (window.payrollTapCount || 0) + 1; }, true); });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await login(page, seed.OFFICE_EMAIL);
    const response = await context.request.get(base + '/api/payroll/export?' + new URLSearchParams({ ...week, format: 'csv' }));
    assert.equal(response.status(), 200); assert.equal(response.headers()['cache-control'], 'private, no-store');
    for (const query of ['from=bad&to=2026-10-25&format=csv', `from=${week.from}&to=${week.to}&format=x`]) assert.equal((await context.request.get(base + '/api/payroll/export?' + query)).status(), 400);
    assert.equal((await context.request.post(base + '/api/payroll/export')).status(), 405);
    for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; showPage('timecards'); }, theme);
      await page.locator('#pay-period-panel [data-payroll-export-open]').waitFor({ state: 'visible' });
      await page.evaluate(() => document.fonts.ready);
      for (const preset of ['week', 'last', 'custom']) {
        await download(page, preset, preset === 'custom' ? 6 : preset === 'last' ? 3 : 2);
        await bounds(page);
        if (shots && preset === 'week') { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `payroll-${theme}-${width}.png`) }); }
        await page.locator('[data-payroll-close]').click();
      }
    }
    await page.locator('#pay-period-panel [data-payroll-export-open]').click();
    assert.match(await page.locator('#payroll-export-count').textContent(), /1 punch not approved yet/);
    const [pdf] = await Promise.all([page.waitForEvent('download'), page.locator('[data-payroll-download="pdf"]').click()]);
    const bytes = fs.readFileSync(await pdf.path()); assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    assert.equal((bytes.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 1, 'one-page PDF');
    if (shots) fs.copyFileSync(await pdf.path(), path.join(shots, 'payroll-summary.pdf'));
    await page.locator('#payroll-export-approve').click();
    assert.equal(await page.locator('#timecard-from').inputValue(), week.from); assert.equal(await page.locator('#timecard-to').inputValue(), week.to);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.PDLCompanySettings.openPayPeriods());
    await page.locator('#payroll-overtime-form').waitFor({ state: 'visible' });
    const inline = await page.locator('.payroll-rule-hours').evaluateAll(labels => labels.map(label => { const parts = [...label.children].map(el => el.getBoundingClientRect()); return { top: Math.max(...parts.map(r => r.top)), bottom: Math.min(...parts.map(r => r.bottom)), right: Math.max(...parts.map(r => r.right)), viewport: innerWidth }; }));
    for (const line of inline) assert(line.top < line.bottom && line.right <= line.viewport, 'one-line overtime sentence at 390px: ' + JSON.stringify(line));
    const field = await browser.newContext(), fieldPage = await field.newPage(); await login(fieldPage, seed.FIELD_EMAIL);
    assert.equal((await field.request.get(base + '/api/payroll/export?' + new URLSearchParams({ ...week, format: 'csv' }))).status(), 403);
    assert.equal(await fieldPage.locator('[data-payroll-export-open]:visible').count(), 0);
    assert.deepEqual(errors, []); console.log('Payroll export API, staging-seed login, range totals, two-tap downloads, themes and field denial passed.');
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
