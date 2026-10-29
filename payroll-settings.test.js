'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { fixture, companyA, companyB, token } = require('./fixtures/project-assistant');
const { DEFAULT_OVERTIME } = require('./payroll-overtime');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-payroll-p1a-'));
const dbFile = path.join(temp, 'db.json');
const tenantFile = path.join(temp, 'tenants', companyA + '.json');
const db = fixture(companyA);
Object.assign(db.company, { name: 'Synthetic Payroll Company', weekStart: 'sunday', overtimeRule: 'daily8', features: { timeCards: true }, pricingAccess: { enabled: true, officeMode: 'all', userIds: [] } });
db.users.find(user => user.id === 7).permissions = { manageTime: true };
db.users.push({ ...db.users.find(user => user.id === 7), id: 8, name: 'Admin without time access', permissions: {} });
db.sessions.push({ userId: 8, companyId: companyA, tokenHash: crypto.createHash('sha256').update(token(companyA, 8)).digest('hex'), expiresAt: '2099-01-01T00:00:00Z' });
db.payPeriods = [{ id: 'period-fixture', label: 'Saved period', from: '2026-10-01', to: '2026-10-15', timeZone: 'America/Los_Angeles', status: 'open' }];
db.payPeriodExports = [];
fs.mkdirSync(path.dirname(tenantFile), { recursive: true });
fs.writeFileSync(dbFile, JSON.stringify(fixture(companyB)));
fs.writeFileSync(tenantFile, JSON.stringify(db));
fs.writeFileSync(path.join(temp, 'platform.json'), JSON.stringify({ users: [], sessions: [] }));
Object.assign(process.env, { PDL_DB_FILE: dbFile, PDL_PLATFORM_FILE: path.join(temp, 'platform.json'), PDL_REQUIRE_AUTH: '1', PDL_SUPABASE_ENABLED: '0', PDL_TRANSACTIONAL_DB: 'off', PDL_PLATFORM_TRANSACTIONAL_DB: 'off', PDL_EMAIL_DEV_MODE: '1', PDL_STAGING: '0', NODE_ENV: 'test' });
for (const key of ['SENTRY_DSN', 'RESEND_API_KEY', 'OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'DATABASE_URL', 'INDEXNOW_KEY']) delete process.env[key];
require('./database/supabase').loadLocalEnv = () => {};
const { server } = require('./server');
let base, browser;
async function call(route, input, user = 1, companyId = companyA) {
  const response = await fetch(base + route, { method: input ? 'PATCH' : 'GET', headers: { 'Content-Type': 'application/json', 'X-PDL-Company': companyId, Authorization: 'Bearer ' + token(companyId, user) }, ...(input ? { body: JSON.stringify(input) } : {}) });
  return { status: response.status, data: await response.json() };
}
async function openSettings(page) {
  await page.goto(base + '/app?tenant=' + companyA, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.PDLCompanySettings) && typeof currentUser !== 'undefined' && currentUser?.role === 'owner' && company?.features?.timeCards === true);
  await page.evaluate(() => window.PDLCompanySettings.openPayPeriods());
  await page.waitForSelector('#payroll-overtime-form', { visible: true });
}
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  try {
    const initial = (await call('/api/state')).data.company;
    assert.deepEqual(initial.payroll, { overtime: DEFAULT_OVERTIME });
    assert.equal(initial.weekStart, 'sunday');
    const overtime = { weeklyOver: 37.5, dailyOver: 8, dailyDoubleOver: 12 };
    for (const user of [2, 4, 5, 6, 8]) assert.equal((await call('/api/company', { payroll: { overtime } }, user)).status, 403);
    assert.equal((await call('/api/company', { payroll: { overtime } }, 1, companyB)).status, 403, 'feature-disabled company cannot save payroll rules');
    const beforeSave = JSON.parse(fs.readFileSync(tenantFile));
    const save = await call('/api/company', { payroll: { overtime } }, 7);
    assert.equal(save.status, 200, JSON.stringify(save.data));
    assert.deepEqual(save.data.payroll.overtime, overtime);
    const saved = JSON.parse(fs.readFileSync(tenantFile));
    assert.deepEqual(saved.company.payroll.overtime, overtime, 'stored in the existing tenant company settings');
    for (const key of ['weekStart', 'timezone', 'overtimeRule', 'pricingAccess', 'name']) assert.deepEqual(saved.company[key], initial[key]);
    for (const key of ['payPeriods', 'payPeriodExports', 'projects', 'team', 'reports', 'workdays']) assert.deepEqual(saved[key], beforeSave[key], key + ' unchanged');
    assert.deepEqual((await call('/api/state')).data.company.payroll.overtime, overtime);
    for (const user of [4, 5]) {
      const fieldState = await call('/api/state', undefined, user);
      assert.equal(fieldState.status, 200);
      assert.equal(Object.hasOwn(fieldState.data.company, 'payroll'), false, 'field company payload excludes payroll rules');
    }
    assert.deepEqual((await call('/api/state', undefined, 1, companyB)).data.company.payroll.overtime, DEFAULT_OVERTIME, 'other tenant isolated');
    const beforeInvalid = fs.readFileSync(tenantFile, 'utf8');
    for (const invalid of [null, {}, [], { overtime: {} }, { overtime: { ...overtime, weeklyOver: -1 } }, { overtime: { ...overtime, dailyOver: '8' } }, { overtime: { ...overtime, dailyDoubleOver: 8 } }, { overtime: { ...overtime, dailyDoubleOver: 7 } }, { overtime: { ...overtime, dailyOver: 0 } }, { overtime: { ...overtime, weeklyOver: true } }, { overtime, weekStart: 'mon' }]) {
      const result = await call('/api/company', { payroll: invalid });
      assert.equal(result.status, 400, JSON.stringify(result));
      assert.equal(typeof result.data.error, 'string');
      assert.ok(result.data.error.length > 10);
      assert.doesNotMatch(result.data.error, /weeklyOver|dailyOver|dailyDoubleOver|null/);
    }
    for (const [key, label] of [['weeklyOver', 'Weekly overtime'], ['dailyOver', 'Daily overtime'], ['dailyDoubleOver', 'Double time']]) {
      const result = await call('/api/company', { payroll: { overtime: { ...overtime, [key]: 0 } } });
      assert.equal(result.status, 400);
      assert.equal(result.data.error, `${label} must be more than 0 hours, or turn it off.`);
      const max = key === 'weeklyOver' ? 168 : 24;
      for (const value of [max + 1, max + 0.5]) {
        const rejected = await call('/api/company', { payroll: { overtime: { ...overtime, [key]: value } } });
        assert.equal(rejected.status, 400);
        assert.equal(rejected.data.error, `${label} can't be more than ${max} hours.`);
        assert.doesNotMatch(rejected.data.error, /weeklyOver|dailyOver|dailyDoubleOver/);
      }
    }
    const invalidDouble = await call('/api/company', { payroll: { overtime: { ...overtime, dailyDoubleOver: 6 } } });
    assert.equal(invalidDouble.status, 400);
    assert.equal(invalidDouble.data.error, 'Double time must start after daily overtime.');
    assert.equal(fs.readFileSync(tenantFile, 'utf8'), beforeInvalid, 'invalid requests never write');
    const profile = await call('/api/company', { name: initial.name, weekStart: 'sunday' });
    assert.equal(profile.status, 200);
    assert.deepEqual(profile.data.payroll.overtime, overtime, 'normal profile save retains payroll rules');
    for (const limits of [{ weeklyOver: 168, dailyOver: 24, dailyDoubleOver: null }, { weeklyOver: 168, dailyOver: 8, dailyDoubleOver: 24 }]) {
      const accepted = await call('/api/company', { payroll: { overtime: limits } });
      assert.equal(accepted.status, 200, 'exact 24-hour/168-hour limits are accepted');
      assert.deepEqual(accepted.data.payroll.overtime, limits);
    }
    assert.equal((await call('/api/company', { payroll: { overtime: { weeklyOver: null, dailyOver: null, dailyDoubleOver: null } } })).status, 200);
    assert.deepEqual((await call('/api/state')).data.company.payroll.overtime, { weeklyOver: null, dailyOver: null, dailyDoubleOver: null });
    await call('/api/company', { payroll: { overtime: DEFAULT_OVERTIME } });
    // A fresh request context must re-read the persisted tenant, not a UI cache.
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
    assert.deepEqual((await call('/api/state')).data.company.payroll.overtime, DEFAULT_OVERTIME);

    const puppeteer = require('puppeteer-core');
    browser = await puppeteer.launch({ executablePath: process.env.PDL_TEST_CHROME || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome-stable'), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', request => request.url().startsWith(base + '/') || request.url().startsWith('data:') ? request.continue() : request.abort());
    const errors = [];
    let payrollRequests = 0;
    page.on('request', request => { if (request.url() === base + '/api/company' && request.method() === 'PATCH') payrollRequests++; });
    page.on('pageerror', error => { errors.push(error.message); console.error('Synthetic browser error:', error.message); });
    await page.setCookie({ name: 'pdl_session', value: token(companyA, 1), url: base }, { name: 'pdl_company', value: companyA, url: base });
    for (const theme of ['light', 'dark']) for (const { width, height } of [{ width: 390, height: 844 }, { width: 390, height: 500 }, { width: 1280, height: 800 }]) {
      const weekStart = theme === 'light' ? 'sunday' : 'monday', day = weekStart === 'sunday' ? 'Sunday' : 'Monday';
      assert.equal((await call('/api/company', { name: initial.name, weekStart })).status, 200);
      await page.setViewport({ width, height });
      await openSettings(page);
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      assert.equal(await page.$eval('#payroll-overtime-form', el => el.noValidate), true);
      assert.deepEqual(await page.$$eval('.payroll-rule-hours', els => els.map(el => { const label = el.cloneNode(true); label.querySelector('input').replaceWith('[input]'); return label.textContent.replace(/\s+/g, ' ').trim(); })), ['Overtime after [input] hours a week', 'Overtime after [input] hours a day', 'Double time after [input] hours a day']);
      assert.deepEqual(await page.$$eval('.payroll-rule-hours input', els => els.map(el => el.max)), ['168', '24', '24']);
      const intro = await page.$$eval('#payroll-overtime-form > p', els => els.map(el => el.textContent));
      assert.equal(intro[0], "Only approved punches count. Extra-work flags don't change pay.");
      assert.equal(intro[1], `Workweek starts ${day} (from your company settings).`);
      await page.evaluate(() => window.PDLLocale.set('es'));
      assert.deepEqual(await page.$$eval('.payroll-rule-hours', els => els.map(el => { const label = el.cloneNode(true); label.querySelector('input').replaceWith('[input]'); return label.textContent.replace(/\s+/g, ' ').trim(); })), ['Horas extra después de [input] horas a la semana', 'Horas extra después de [input] horas al día', 'Tiempo doble después de [input] horas al día']);
      assert.equal(await page.$eval('#payroll-overtime-form h3', el => el.textContent), 'REGLAS DE HORAS EXTRA');
      assert.equal(await page.$eval('#payroll-overtime-form button', el => el.textContent), 'Guardar reglas de horas extra');
      assert.deepEqual(await page.$$eval('.payroll-rule p', els => els.map(el => el.textContent)), [
        'Las horas regulares por encima de este límite pasan a ser horas extra cada semana laboral. Las horas extra diarias y el tiempo doble no se cuentan dos veces.',
        'Las horas por encima de este límite pasan a ser horas extra cada día, hasta el límite de tiempo doble.',
        'Las horas por encima de este límite pasan a ser tiempo doble cada día.'
      ]);
      const translated = await page.evaluate(() => ['hours', 'Overtime rules saved.', "Weekly overtime can't be more than 168 hours.", "Daily overtime can't be more than 24 hours.", "Double time can't be more than 24 hours."].map(window.PDLLocale.translate));
      assert.deepEqual(translated, ['horas', 'Reglas de horas extra guardadas.', 'Las horas extra semanales no pueden empezar después de 168 horas.', 'Las horas extra diarias no pueden empezar después de 24 horas.', 'El tiempo doble no puede empezar después de 24 horas.']);
      assert.equal(await page.evaluate(() => [
        'Weekly overtime must be more than 0 hours, or turn it off.', 'Daily overtime must be more than 0 hours, or turn it off.', 'Double time must be more than 0 hours, or turn it off.',
        'Double time must start after daily overtime.', 'Save overtime rules here. Change the workweek start in company settings.', 'Set weekly overtime, daily overtime and double time, or turn each one off.'
      ].every(text => window.PDLLocale.translate(text) !== text)), true, 'every payroll validation message has a Spanish translation');
      const spanishIntro = await page.$$eval('#payroll-overtime-form > p', els => els.map(el => el.textContent));
      assert.equal(spanishIntro[0], 'Solo cuentan los registros de asistencia aprobados. Las marcas de trabajo extra no cambian el pago.');
      assert.equal(spanishIntro[1], `La semana laboral empieza el ${weekStart === 'sunday' ? 'domingo' : 'lunes'} (según la configuración de su empresa).`);
      assert.deepEqual(await page.$$eval('.payroll-rule-hours input', els => els.map(el => el.getAttribute('aria-label'))), ['Umbral de horas extra semanales en horas', 'Umbral de horas extra diarias en horas', 'Umbral de tiempo doble en horas']);
      await page.evaluate(() => window.PDLLocale.set('en'));
      assert.equal(await page.$eval('#payroll-weeklyOver-enabled', el => el.checked), true);
      assert.equal(await page.$eval('#payroll-dailyOver', el => el.disabled), true);
      await page.click('#payroll-dailyOver-enabled');
      await page.click('#payroll-dailyDoubleOver-enabled');
      await page.$eval('#payroll-weeklyOver', el => { el.value = '37.5'; el.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.click('#payroll-overtime-form button[type="submit"]');
      await page.waitForFunction(() => document.querySelector('#payroll-overtime-message')?.textContent === 'Overtime rules saved.');
      assert.deepEqual((await call('/api/state')).data.company.payroll.overtime, overtime);
      await openSettings(page);
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      assert.equal(await page.$eval('#payroll-weeklyOver', el => el.value), '37.5');
      assert.equal(await page.$eval('#payroll-dailyOver-enabled', el => el.checked), true);
      assert.equal(await page.$eval('#payroll-dailyDoubleOver', el => el.value), '12');
      await page.$eval('#payroll-overtime-settings', el => el.scrollIntoView({ block: 'center' }));
      const layout = await page.evaluate(() => {
        const host = document.querySelector('#payroll-overtime-settings'), style = getComputedStyle(host), box = host.getBoundingClientRect();
        const targets = [...host.querySelectorAll('.payroll-rule-toggle, input[type="number"], button')].map(el => ({ height: el.getBoundingClientRect().height, width: el.getBoundingClientRect().width }));
        return { overflow: document.documentElement.scrollWidth > innerWidth, left: box.left, right: box.right, background: style.backgroundColor, color: style.color, targets, checkboxBackground: getComputedStyle(host.querySelector('input[type="checkbox"]')).backgroundColor, inputBackground: getComputedStyle(host.querySelector('input[type="number"]')).backgroundColor, buttonBackground: getComputedStyle(host.querySelector('button')).backgroundColor, buttonColor: getComputedStyle(host.querySelector('button')).color };
      });
      assert.equal(layout.overflow, false, JSON.stringify(layout));
      assert.ok(layout.left >= 0 && layout.right <= width);
      assert.ok(layout.targets.every(target => target.height >= 44 && target.width >= 44));
      assert.equal(layout.background, theme === 'dark' ? 'rgb(0, 0, 0)' : 'rgb(247, 245, 240)');
      assert.equal(layout.color, theme === 'dark' ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)');
      assert.equal(layout.buttonBackground, 'rgb(255, 102, 0)');
      assert.equal(layout.buttonColor, 'rgb(0, 0, 0)');
      assert.equal(layout.checkboxBackground, 'rgb(255, 102, 0)');
      assert.equal(layout.inputBackground, layout.background);
      const inlineInputs = await page.$$eval('.payroll-rule-hours', els => els.map(el => {
        const prefix = el.querySelector('span').getBoundingClientRect(), input = el.querySelector('input').getBoundingClientRect();
        return input.left >= prefix.right && prefix.top >= input.top && prefix.bottom <= input.bottom;
      }));
      assert.ok(inlineInputs.every(Boolean), 'each number input is inline after its sentence prefix');
      if (theme === 'dark') {
        const helpColors = await page.$$eval('#payroll-overtime-settings p', els => els.map(el => getComputedStyle(el).color));
        assert(helpColors.length >= 5 && helpColors.every(color => color === 'rgb(255, 255, 255)'), JSON.stringify(helpColors));
      }
      if (process.env.PDL_PAYROLL_SCREENSHOTS && width === 390 && height === 844) {
        await page.$eval('#payroll-overtime-settings', el => {
          el.scrollIntoView({ block: 'start' });
          const offset = Math.max(0, document.querySelector('.topbar').getBoundingClientRect().bottom + 12 - el.getBoundingClientRect().top);
          let scroller = el.parentElement;
          while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
          if (scroller) scroller.scrollTop -= offset; else window.scrollBy(0, -offset);
        });
        const heading = await page.evaluate(() => ({ top: document.querySelector('#payroll-overtime-settings h3').getBoundingClientRect().top, headerBottom: document.querySelector('.topbar').getBoundingClientRect().bottom }));
        assert.ok(heading.top >= heading.headerBottom + 8 && heading.top < 200, JSON.stringify(heading));
        fs.mkdirSync(process.env.PDL_PAYROLL_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.PDL_PAYROLL_SCREENSHOTS, `overtime-top-${theme}-390.png`) });
      }
      async function setInput(name, value) {
        await page.$eval('#payroll-' + name, (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); }, value);
        assert.equal(await page.$eval('#payroll-overtime-message', el => el.textContent), '', 'input clears stale feedback');
        assert.equal(await page.$('#payroll-overtime-settings [aria-invalid="true"]'), null, 'input clears field error state');
      }
      async function showServerError(name, expected, submit = 'click') {
        const rejected = page.waitForResponse(response => response.url() === base + '/api/company' && response.request().method() === 'PATCH');
        const requestsBefore = payrollRequests;
        if (submit === 'click') await page.click('#payroll-overtime-form button[type="submit"]');
        else await page.$eval('#payroll-overtime-form', form => form.requestSubmit());
        assert.equal((await rejected).status(), 400);
        assert.equal(payrollRequests, requestsBefore + 1, 'in-app validation uses the existing server route, including blanks and negatives');
        await page.waitForFunction(expected => document.querySelector('#payroll-overtime-message')?.textContent === expected, {}, expected);
        assert.deepEqual(await page.$$eval('#payroll-overtime-settings [aria-invalid="true"]', els => els.map(el => el.name)), [name]);
        assert.equal(await page.$eval('#payroll-' + name, el => el.getAttribute('aria-errormessage')), 'payroll-overtime-message');
        await page.waitForFunction(() => {
          const box = document.querySelector('#payroll-overtime-message').getBoundingClientRect(), header = document.querySelector('.topbar').getBoundingClientRect();
          return box.top >= header.bottom && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth;
        });
        const style = await page.$eval('#payroll-overtime-message', el => { const css = getComputedStyle(el); return { error: el.classList.contains('is-error'), border: css.borderLeftWidth, accent: css.borderLeftColor, color: css.color }; });
        assert.deepEqual(style, { error: true, border: '2px', accent: 'rgb(255, 46, 138)', color: theme === 'dark' ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)' });
      }
      await setInput('dailyDoubleOver', '6');
      await showServerError('dailyDoubleOver', 'Double time must start after daily overtime.');
      assert.deepEqual((await call('/api/state')).data.company.payroll.overtime, overtime, 'bad input leaves saved rules intact');
      if (process.env.PDL_PAYROLL_SCREENSHOTS && width === 390) {
        fs.mkdirSync(process.env.PDL_PAYROLL_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.PDL_PAYROLL_SCREENSHOTS, `overtime-error-${theme}-390${height === 500 ? 'x500' : ''}.png`) });
      }
      await page.click('#payroll-dailyDoubleOver-enabled');
      assert.equal(await page.$eval('#payroll-overtime-message', el => el.textContent), '', 'toggle change clears stale feedback');
      await page.click('#payroll-dailyDoubleOver-enabled');
      await setInput('dailyDoubleOver', '12');
      for (const [name, title, max, reset] of [['weeklyOver', 'Weekly overtime', 168, '37.5'], ['dailyOver', 'Daily overtime', 24, '8'], ['dailyDoubleOver', 'Double time', 24, '12']]) {
        for (const value of ['', '-1', String(max + 0.5)]) {
          await setInput(name, value);
          await showServerError(name, Number(value) > max ? `${title} can't be more than ${max} hours.` : `${title} must be more than 0 hours, or turn it off.`, value === '-1' ? 'requestSubmit' : 'click');
        }
        await setInput(name, reset);
      }
      // A valid retry clears the error decoration and field state on submit,
      // even when a value changes without an input event (e.g. autofill).
      await setInput('dailyDoubleOver', '6');
      await showServerError('dailyDoubleOver', 'Double time must start after daily overtime.');
      await page.$eval('#payroll-dailyDoubleOver', el => { el.value = '12'; });
      await page.evaluate(() => window.PDLLocale.set('es'));
      const retry = await page.$eval('#payroll-overtime-form', form => { form.requestSubmit(); return { error: form.querySelector('#payroll-overtime-message').classList.contains('is-error'), invalid: form.querySelectorAll('[aria-invalid="true"]').length }; });
      assert.deepEqual(retry, { error: false, invalid: 0 }, 'submit clears the previous error before the response');
      await page.waitForFunction(() => document.querySelector('#payroll-overtime-message')?.textContent === 'Reglas de horas extra guardadas.');
      assert.equal(await page.$('#payroll-overtime-settings [aria-invalid="true"]'), null);
      assert.equal(await page.$eval('#payroll-overtime-message', el => el.classList.contains('is-error')), false);
      await setInput('dailyDoubleOver', '25');
      await showServerError('dailyDoubleOver', 'El tiempo doble no puede empezar después de 24 horas.');
      await page.evaluate(() => window.PDLLocale.set('en'));
      await call('/api/company', { payroll: { overtime: DEFAULT_OVERTIME } });
    }
    assert.deepEqual(errors, []);
    console.log('Payroll settings passed: HTTP bounds/validation/RBAC/tenant isolation/persistence, English/Spanish inline copy, in-app errors/aria-invalid/visible feedback and valid retry, real-browser save/reload and brand/tap targets at 390x844, 390x500 and 1280x800 in both themes.');
  } finally {
    if (browser) await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
