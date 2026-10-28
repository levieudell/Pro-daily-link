'use strict';
const assert = require('node:assert/strict');

async function navigateOffice(page, name) {
  if (await page.$eval('#project-detail-modal', el => el.open)) {
    await page.locator('#project-detail-modal .close-button').click();
    await page.waitForFunction(() => !document.querySelector('#project-detail-modal').open);
  }
  await page.waitForFunction(() => Date.now() >= suppressReportOpenUntil);
  if (page.viewport().width < 760 && !await page.$eval('#sidebar', el => el.classList.contains('open'))) await page.click('#menu-button');
  await page.waitForFunction(name => {
    const r = document.querySelector('.nav-item[data-page="' + name + '"]').getBoundingClientRect();
    return r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1;
  }, {}, name);
  await page.locator(`.nav-item[data-page="${name}"]`).click();
  await page.waitForSelector(`#${name}-page.active`);
  if (page.viewport().width < 760) await page.waitForFunction(() => document.querySelector('#sidebar').getBoundingClientRect().right <= 1);
}

async function assertNoGlobalOfficeDaily(page) {
  assert.equal(await page.$$eval('.top-actions [data-open-report], #reports-page [data-open-report]', buttons => buttons.some(button => {
    const r = button.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  })), false, 'office daily creation belongs inside a project');
}

async function openOfficeProjectDaily(page, projectId) {
  await assertNoGlobalOfficeDaily(page);
  await navigateOffice(page, 'projects');
  const ids = await page.$$eval('#project-cards [data-open-project]', buttons => buttons.map(button => button.dataset.openProject));
  const selected = String(projectId ?? ids[0]);
  assert.ok(ids.includes(selected), 'the requested project has a rendered entry point');
  await page.locator(`#project-cards [data-open-project="${selected}"]`).click();
  await page.waitForSelector('#project-detail-modal[open]');
  await page.locator('#project-detail-modal [data-project-detail-tab="dailies"]').click();
  await page.locator(`#project-detail-modal [data-office-new-daily="${selected}"]`).click();
  await page.waitForSelector('#report-modal[open]');
  assert.equal(await page.evaluate(() => String(projects[Number(document.querySelector('#report-project').value)]?.id)), selected, 'new daily preselects the project the user opened');
  return selected;
}

module.exports = { navigateOffice, assertNoGlobalOfficeDaily, openOfficeProjectDaily };
