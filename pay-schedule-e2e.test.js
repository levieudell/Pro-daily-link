'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const seed = require('./staging-seed');
const calendar = require('./payroll-ranges');
const schedule = require('./pay-schedule');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-pay-schedule-'));
const dbFile = path.join(root, 'db.json');
const password = 'local-pay-schedule-only';
seed.ensureStagingDatabase(dbFile, { PDL_STAGING_OWNER_PASSWORD: password, PDL_STAGING_FIELD_PASSWORD: password });
seed.ensureStagingOfficeUser(dbFile, { PDL_STAGING: '1', PDL_STAGING_OFFICE_PASSWORD: password });
fs.writeFileSync(path.join(root, 'platform.json'), JSON.stringify({ users: [], sessions: [] }));
Object.assign(process.env, { PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: path.join(root, 'platform.json'), PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_PLATFORM_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1', PDL_STAGING: '0', NODE_ENV: 'test' });
for (const key of ['SENTRY_DSN', 'RESEND_API_KEY', 'OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'DATABASE_URL', 'INDEXNOW_KEY']) delete process.env[key];
require('./database/supabase').loadLocalEnv = () => {};
const { server } = require('./server');
async function login(page, email) {
  await page.goto(base + '/login.html');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.locator('form#login button.primary').click();
  await page.waitForFunction(() => typeof currentUser !== 'undefined' && currentUser && typeof showPage === 'function');
}
async function tap(page, locator) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  assert(box && box.y >= 56 && box.y + box.height <= viewport.height + 0.5 && box.x >= 0 && box.x + box.width <= viewport.width + 0.5, 'target on screen: ' + JSON.stringify(box));
  const hit = await locator.evaluate(el => { const r = el.getBoundingClientRect(); const node = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return node === el || el.contains(node); });
  assert(hit, 'target receives the tap');
  await locator.click();
}
let base;
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.PDL_TEST_CHROME || '/usr/bin/google-chrome-stable', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(() => document.addEventListener('click', event => { if (event.isTrusted) window.payScheduleTaps = (window.payScheduleTaps || 0) + 1; }, true));
    await page.setViewportSize({ width: 390, height: 1400 });
    await login(page, seed.OFFICE_EMAIL);
    await page.waitForFunction(() => company?.features?.timeCards === true);
    await page.evaluate(() => window.PDLCompanySettings.openPayPeriods());
    await page.locator('#pay-schedule-form').waitFor();
    const tab = await page.locator('#settings-tab-periods').evaluate(el => { const s = getComputedStyle(el); return { bg: s.backgroundColor, color: s.color }; });
    assert.deepEqual(tab, { bg: 'rgb(0, 0, 0)', color: 'rgb(255, 255, 255)' });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    const dark = await page.locator('#settings-tab-periods').evaluate(el => { const s = getComputedStyle(el); return { bg: s.backgroundColor, color: s.color }; });
    assert.deepEqual(dark, { bg: 'rgb(255, 255, 255)', color: 'rgb(0, 0, 0)' });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; window.payScheduleTaps = 0; });
    const started = performance.now();
    await tap(page, page.locator('[data-pay-frequency="weekly"]'));
    await tap(page, page.locator('[data-end-weekday="2"]'));
    await tap(page, page.locator('[data-due-weekday="3"]'));
    await tap(page, page.locator('[data-pay-weekday="5"]'));
    await tap(page, page.locator('[data-pay-schedule-save]'));
    await page.locator('[data-pay-schedule-error]').filter({ hasText: 'saved' }).waitFor();
    const taps = await page.evaluate(() => window.payScheduleTaps);
    const elapsed = performance.now() - started;
    assert(taps <= 6, `weekly setup took ${taps} taps`);
    assert(elapsed < 10000, `${elapsed}ms`);
    console.log(`Weekly Tue-end schedule: ${taps} taps, ${Math.round(elapsed)}ms`);
    await page.evaluate(() => { window.payScheduleTaps = 0; });
    await tap(page, page.locator('[data-pay-frequency="biweekly"]'));
    await tap(page, page.locator('[data-anchor]').first());
    assert.equal(await page.evaluate(() => window.payScheduleTaps), 2);
    const bad = await context.request.patch(base + '/api/company', { data: { payroll: { pay_schedule: { frequency: 'weekly' } } }, headers: { 'X-PDL-Company': seed.COMPANY_ID } });
    assert.equal(bad.status(), 400);
    const today = calendar.today('America/Los_Angeles');
    const expected = schedule.lastEndedBefore({ ...schedule.emptySchedule(), frequency: 'weekly', period_end_weekday: 2, cards_due_offset_days: 1, payday_offset_days: 3 }, today);
    await page.evaluate(() => showPage('dashboard'));
    await page.locator('#payroll-landing [data-payroll-range="period"]').click();
    assert.equal(await page.locator('#payroll-landing [data-payroll-range-label]').innerText(), calendar.label(expected.start, expected.end, today.slice(0, 4)));
    const field = await browser.newContext();
    const fieldPage = await field.newPage();
    await login(fieldPage, seed.FIELD_EMAIL);
    const denied = await field.request.patch(base + '/api/company', { data: { payroll: { pay_schedule: { frequency: 'weekly', period_end_weekday: 2 } } }, headers: { 'X-PDL-Company': seed.COMPANY_ID } });
    assert.equal(denied.status(), 403);
    await field.close();
    console.log('Pay schedule taps, last period, validation and field 403 passed.');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
