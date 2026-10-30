'use strict';
const assert = require('node:assert/strict');

// Runs inside the authenticated payroll browser test, against the actual settings UI.
module.exports = async function checkScheduleUi(page) {
  async function open(theme, size) {
    await page.setViewportSize(size);
    await page.evaluate(async theme => {
      document.documentElement.dataset.theme = theme;
      company = await api('/api/company', { method: 'PATCH', body: JSON.stringify({ payroll: { pay_schedule: { frequency: null } } }) });
      window.PDLCompanySettings.openPayPeriods();
    }, theme);
    await page.waitForFunction(() => document.querySelector('[data-pay-schedule-save]')?.hidden && !document.querySelector('[data-end-weekday]'));
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
      window.scrollTo(0, 0); document.querySelector('main')?.scrollTo(0, 0);
    });
  }
  async function enter(selector, value) {
    const input = page.locator(selector);
    await input.click(); await input.press('ControlOrMeta+A'); await input.pressSequentially(value);
  }
  async function clearOfSave(selector) {
    await page.waitForFunction(selector => {
      const input = document.querySelector(selector), save = document.querySelector('[data-pay-schedule-save]');
      const r = input.getBoundingClientRect(), s = save.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return document.activeElement === input && r.top >= 56 && r.bottom <= Math.min(innerHeight, s.top) - 16 && hit === input;
    }, selector);
  }
  for (const theme of ['light', 'dark']) {
    await open(theme, { width: 390, height: 667 });
    for (const frequency of ['semimonthly', 'monthly']) {
      await page.locator(`[data-pay-frequency="${frequency}"]`).click();
      const pairs = frequency === 'monthly' ? [['[data-month-end]', '[data-month-last]']] : [[ '[data-end-index="0"]', '[data-end-last="0"]' ], [ '[data-end-index="1"]', '[data-end-last="1"]' ]];
      for (const [input, button] of pairs) {
        await page.locator(button).click();
        assert.equal(await page.locator(input).inputValue(), '');
        await page.locator(input).evaluate(el => { window.scheduleInputNode = el; });
        await enter(input, '21');
        assert.equal(await page.locator(button).getAttribute('aria-pressed'), 'false', 'typing turns Last day off');
        assert.equal(await page.locator(button).evaluate(el => getComputedStyle(el).backgroundColor), theme === 'dark' ? 'rgb(0, 0, 0)' : 'rgb(247, 245, 240)');
        assert(await page.locator(input).evaluate(el => el === window.scheduleInputNode && document.activeElement === el), 'input node and focus survive typing');
        await page.locator(button).click();
        assert.equal(await page.locator(button).getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator(input).inputValue(), '');
      }
    }
    await page.locator('[data-pay-frequency="semimonthly"]').click();
    const payday = '[data-offset="payday_offset_days"]';
    assert(await page.locator(payday).evaluate(el => parseFloat(getComputedStyle(el).scrollMarginBottom) >= 72));
    await page.locator(payday).focus();
    // Chromium headless has no OS keyboard: reduce its viewport to the visible keyboard area.
    await page.setViewportSize({ width: 390, height: 367 });
    await clearOfSave(payday);
    await page.locator(payday).blur(); await page.locator(payday).focus();
    await clearOfSave(payday);
    await open(theme, { width: 1280, height: 800 });
    for (const frequency of ['weekly', 'biweekly', 'semimonthly', 'monthly']) {
      await page.locator(`[data-pay-frequency="${frequency}"]`).click();
      if (frequency === 'weekly' || frequency === 'biweekly') {
        await page.locator('[data-end-weekday="2"]').click();
        if (frequency === 'biweekly') await page.locator('[data-anchor]').first().click();
        await page.locator('[data-due-weekday="3"]').click();
        await page.locator('[data-pay-weekday="5"]').click();
      } else {
        await page.locator('[data-offset="cards_due_offset_days"]').fill('1');
        await page.locator(payday).fill('3');
      }
      await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); document.querySelector('main')?.scrollTo(0, 0); });
      const bounds = await page.locator('[data-pay-schedule-save]').evaluate(el => {
        const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el };
      });
      assert(bounds.top >= 56 && bounds.bottom <= 800 && bounds.height >= 48 && bounds.hit, `${frequency} ${theme}: ${JSON.stringify(bounds)}`);
    }
    await open(theme, { width: 390, height: 667 });
    await page.evaluate(() => { window.payrollTapCount = 0; });
    const started = performance.now();
    await page.locator('[data-pay-frequency="semimonthly"]').click();
    await enter('[data-offset="cards_due_offset_days"]', '1');
    await enter(payday, '3');
    await page.locator('[data-pay-schedule-save]').click();
    await page.locator('[data-pay-schedule-status]').filter({ hasText: 'saved' }).waitFor();
    const taps = await page.evaluate(() => window.payrollTapCount), elapsed = performance.now() - started;
    assert(taps <= 6 && elapsed < 20000, `${theme}: ${taps} taps, ${elapsed}ms`);
    console.log(`Twice-monthly settings 390x667 ${theme}: ${taps} taps, ${Math.round(elapsed)}ms; Last day state, keyboard clearance and all desktop frequencies passed.`);
  }
};
