'use strict';

// Full-app Safety smoke test. The demo runner creates disposable data and
// disables every external provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

let chromium;
for (const dependency of [
  'playwright',
  process.env.PDL_PLAYWRIGHT_MODULE,
  path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright')
].filter(Boolean)) {
  try { chromium = require(dependency).chromium; break; } catch { /* Try the next installed runtime. */ }
}
if (!chromium) throw new Error('Configure PDL_PLAYWRIGHT_MODULE with an available Playwright runtime.');
const browserPath = process.env.PDL_BROWSER_PATH || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].find(file => fs.existsSync(file));
fs.mkdirSync(path.join(__dirname, 'output'), { recursive: true });

(async () => {
  let child, browser;
  try {
    child = spawn(process.execPath, ['scripts/safety-demo.cjs', '--port=0'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Demo startup timed out: ' + log)), 15000);
      child.stdout.on('data', chunk => {
        log += chunk;
        if (log.includes('Temporary demo password:')) { clearTimeout(timer); resolve(); }
      });
      child.stderr.on('data', chunk => { log += chunk; });
      child.on('exit', code => reject(new Error(`Demo exited ${code}: ${log}`)));
    });
    const url = log.match(/Safety demo: (http[^\s]+)/)?.[1];
    const password = log.match(/Temporary demo password: ([^\s]+)/)?.[1];
    assert.ok(url && password, 'demo runner returns its local URL and disposable password');

    browser = await chromium.launch({ headless: true, ...(browserPath ? { executablePath: browserPath } : {}) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(new URL(url).origin) ? route.continue() : route.abort());

    await page.goto(url);
    await page.locator('#email').fill('pm@example.invalid');
    await page.locator('#password').fill(password);
    await page.locator('#login button[type=submit]').click();
    await page.waitForURL('**/app?**', { timeout: 20000 });

    // Navbar opens the three-destination Safety v3 command center.
    await page.locator('.nav-item[data-page="safety"]').click();
    await page.waitForURL(/#safety$/);
    const workspace = page.locator('#safety-page');
    await workspace.waitFor({ state: 'visible' });
    const tabs = workspace.getByRole('tab');
    await tabs.first().waitFor();
    assert.equal(await tabs.count(), 3, 'Safety workspace exposes exactly three primary destinations');
    assert.deepEqual((await tabs.allTextContents()).map(text => text.trim()), ['Today', 'Follow-up', 'Records']);
    assert.equal(await workspace.locator('[role="tabpanel"]').count(), 3, 'each destination owns an accessible panel');
    assert.equal(await tabs.first().getAttribute('aria-selected'), 'true', 'Today is the useful default');

    // Keyboard navigation follows the ARIA tabs pattern.
    await tabs.first().focus();
    await page.keyboard.press('End');
    assert.equal(await page.locator('#safety-tab-records').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#safety-panel-records').isVisible(), true);
    await page.keyboard.press('Home');
    assert.equal(await page.locator('#safety-tab-today').getAttribute('aria-selected'), 'true');
    await workspace.getByRole('tab', { name: /Follow-up/ }).click();
    assert.equal(await page.locator('#safety-panel-followup').isVisible(), true);
    await workspace.getByRole('tab', { name: 'Today', exact: true }).click();
    assert.equal(await page.locator('#safety-panel-today').isVisible(), true);
    await workspace.getByRole('button', { name: /Forms/ }).click();
    const inspectionCard = workspace.getByText('Synthetic pre-start inspection', { exact: true }).locator('xpath=ancestor::article[1]');
    await inspectionCard.getByRole('button', { name: 'Open form', exact: true }).click();
    const formReportDialog = page.locator('#report-modal');
    await formReportDialog.waitFor({ state: 'visible' });
    assert.equal(await formReportDialog.locator('#report-type').inputValue(), 'superintendent', 'Safety forms use the streamlined non-production report mode');
    assert.equal(await formReportDialog.locator('#report-form').getAttribute('data-current-step'), '2', 'Open form moves directly to the verification step');
    assert.equal(await formReportDialog.locator('#report-more').getAttribute('open'), '', 'the selected form questions are expanded immediately');
    await formReportDialog.locator('[data-custom-field="access-condition"]').waitFor({ state: 'visible' });
    await formReportDialog.locator('#close-report').click();
    await formReportDialog.waitFor({ state: 'hidden' });
    // The Today CTA opens the focused check runner.
    await workspace.locator('[data-safety-action="checks"]').first().click();
    const dialog = page.locator('#safety-pm-dialog');
    await dialog.waitFor({ state: 'visible' });
    await dialog.locator('[data-safety-profile], [data-safety-generate], .safety-v3-check').first().waitFor({ state: 'visible' });
    const enableSafety = dialog.getByRole('button', { name: 'Turn on Safety', exact: true });
    if (await enableSafety.isVisible()) await enableSafety.click();
    const prepare = dialog.locator('[data-safety-generate]');
    await dialog.locator('[data-safety-generate], .safety-v3-check').first().waitFor({ state: 'visible' });
    if (await prepare.first().isVisible()) await prepare.first().click();
    await dialog.locator('.safety-v3-check').first().waitFor();
    await dialog.locator('[data-safety-close]').click();

    // Toolbox talks stay inside Safety v3 instead of jumping to the generic
    // daily-report editor.
    await workspace.getByRole('button', { name: /Toolbox talk/ }).click();
    await dialog.waitFor({ state: 'visible' });
    await dialog.locator('[data-safety-talk-create], [data-safety-talk]').first().waitFor({ state: 'visible' });
    assert.equal(await page.locator('#report-modal').isVisible(), false, 'toolbox talk does not open the generic daily editor');
    await dialog.locator('[data-safety-close]').click();

    // A daily report keeps its contextual entry into the same current record.
    const reportDialog = page.locator('#report-modal');
    await page.locator('.top-actions [data-open-report]').click();
    await reportDialog.waitFor({ state: 'visible' });
    await reportDialog.locator('#report-open-safety').click();
    await dialog.waitFor({ state: 'visible' });
    await dialog.locator('.safety-v3-check').first().waitFor();
    await dialog.locator('[data-safety-close]').click();
    await reportDialog.locator('#close-report').click();

    // Phone layout keeps all three destinations visible and actions finger-sized.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#menu-button').click();
    await page.locator('.nav-item[data-page="safety"]').click();
    await page.waitForURL(/#safety$/);
    await workspace.getByRole('tab', { name: 'Today', exact: true }).click();
    await page.screenshot({ path: path.join(__dirname, 'output', 'safety-workspace-integrated-mobile.png'), animations: 'disabled', fullPage: true });
    assert.equal(await workspace.evaluate(node => node.scrollWidth > node.clientWidth), false, 'Safety workspace does not overflow a 390px viewport');
    const targetHeights = await workspace.locator('[role="tab"], [data-safety-action]').evaluateAll(nodes => nodes.filter(node => {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }).map(node => Math.round(node.getBoundingClientRect().height)));
    assert.ok(targetHeights.length >= 7, 'mobile workspace exposes three destinations and focused actions');
    assert.ok(targetHeights.every(height => height >= 44), `all visible Safety controls are at least 44px tall: ${targetHeights.join(', ')}`);
    await workspace.getByRole('tab', { name: 'Records', exact: true }).click();
    const recordsTabVisible = await page.locator('#safety-tab-records').evaluate(node => { const tab = node.getBoundingClientRect(), strip = node.parentElement.getBoundingClientRect(); return tab.left >= strip.left - 1 && tab.right <= strip.right + 1; });
    assert.equal(recordsTabVisible, true, 'all three mobile destinations fit the tab control');
    assert.equal(await workspace.locator('[data-record-filter]').count(), 5, 'records expose useful type filters');
    assert.equal(await workspace.getByRole('button', { name: 'Print safety record', exact: true }).isVisible(), true, 'selected-day record is printable');
    await page.evaluate(() => { currentUser = { ...currentUser, role: 'project_manager', permissions: { manageSafety: true } }; PDLSafetyWorkspace.render(); showPage('safety'); });
    assert.equal(await page.locator('.nav-item[data-page="safety"]').isVisible(), true, 'a PM with manageSafety can open the workspace without daily permissions');
    assert.equal(await workspace.isVisible(), true, 'manageSafety opens the same scoped command center');
    await page.evaluate(() => { currentUser = { ...currentUser, permissions: { verifySafety: true } }; PDLSafetyWorkspace.render(); showPage('safety'); });
    assert.equal(await page.locator('.nav-item[data-page="safety"]').isVisible(), true, 'a PM with verifySafety can open the workspace without daily permissions');
    await page.evaluate(() => { currentUser = { ...currentUser, role: 'project_manager', permissions: {} }; PDLSafetyWorkspace.render(); showPage('safety'); });
    assert.equal(await page.locator('.nav-item[data-page="safety"]').isHidden(), true, 'a PM without daily access does not get a dead Safety navigation link');
    assert.equal(await page.locator('#dashboard-page').isVisible(), true, 'a direct Safety route safely returns an unauthorized PM to their normal start page');
    assert.deepEqual(errors, [], 'real app Safety navigation raises no browser errors');
    console.log('Integrated Safety v3 workspace passed: three accessible destinations, focused actions, records, mobile fit/touch targets, and browser runtime.');
  } finally {
    await browser?.close();
    if (child?.exitCode == null) child.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
