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

    // Navbar opens a permanent command center, not the old full-form modal.
    await page.locator('.nav-item[data-page="safety"]').click();
    await page.waitForURL(/#safety$/);
    const workspace = page.locator('#safety-page');
    await workspace.waitFor({ state: 'visible' });
    const tabs = workspace.getByRole('tab');
    await tabs.first().waitFor();
    assert.equal(await tabs.count(), 5, 'Safety workspace exposes exactly five primary tabs');
    assert.deepEqual(await tabs.allTextContents(), ['Overview', 'Today', 'Toolbox talks', 'Forms', 'Records']);
    assert.equal(await workspace.locator('[role="tabpanel"]').count(), 5, 'each tab owns an accessible panel');
    assert.equal(await tabs.first().getAttribute('aria-selected'), 'true', 'Overview is the calm default');

    // Keyboard navigation follows the ARIA tabs pattern.
    await tabs.first().focus();
    await page.keyboard.press('End');
    assert.equal(await page.locator('#safety-tab-records').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#safety-panel-records').isVisible(), true);
    await page.keyboard.press('Home');
    assert.equal(await page.locator('#safety-tab-overview').getAttribute('aria-selected'), 'true');
    await workspace.getByRole('tab', { name: 'Today', exact: true }).click();
    assert.equal(await page.locator('#safety-panel-today').isVisible(), true);
    await workspace.getByRole('tab', { name: 'Toolbox talks', exact: true }).click();
    assert.equal(await page.locator('#safety-panel-talks').isVisible(), true);
    await workspace.getByRole('tab', { name: 'Forms', exact: true }).click();
    assert.equal(await page.locator('#safety-panel-forms').isVisible(), true);
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
    await workspace.getByRole('tab', { name: 'Overview', exact: true }).click();

    // The overview CTA deliberately reuses the focused, proven Safety modal.
    await workspace.getByRole('button', { name: 'Complete today’s checks', exact: true }).first().click();
    const dialog = page.locator('#safety-pm-dialog');
    await dialog.waitFor({ state: 'visible' });
    const prepare = dialog.locator('[data-safety-generate]');
    await dialog.locator('[data-safety-generate], .safety-check').first().waitFor({ state: 'visible' });
    if (await prepare.first().isVisible()) await prepare.first().click();
    await dialog.locator('.safety-check').first().waitFor();
    await dialog.locator('[data-safety-close]').click();

    // Starting a toolbox talk is a direct, saveable path. Structured safety
    // content supplies the truthful report note when the general notes box is
    // intentionally left blank.
    await workspace.getByRole('tab', { name: 'Toolbox talks', exact: true }).click();
    await workspace.getByRole('button', { name: /Start toolbox talk/ }).click();
    const reportDialog = page.locator('#report-modal');
    await reportDialog.waitFor({ state: 'visible' });
    await reportDialog.locator('#safety-talk').fill('Synthetic fall-protection briefing');
    await reportDialog.locator('#safety-talk-attendees').fill('Synthetic safety crew');
    await reportDialog.locator('#save-report-step2-draft').click();
    await reportDialog.waitFor({ state: 'hidden' });
    await page.locator('#report-status-filter').selectOption('Approved');
    await page.locator('.nav-item[data-page="safety"]').click();
    await workspace.getByRole('tab', { name: 'Toolbox talks', exact: true }).click();
    await workspace.getByText('Synthetic fall-protection briefing', { exact: true }).waitFor();
    await workspace.getByRole('button', { name: 'View daily', exact: true }).click();
    assert.equal(await page.locator('#report-status-filter').inputValue(), 'all', 'record navigation clears an excluding report filter');
    await page.getByText('Safety discussion:', { exact: false }).waitFor();

    // A daily report keeps its contextual entry into the same current record.
    await page.locator('.top-actions [data-open-report]').click();
    await reportDialog.waitFor({ state: 'visible' });
    await reportDialog.locator('#report-open-safety').click();
    await dialog.waitFor({ state: 'visible' });
    await dialog.locator('.safety-check').first().waitFor();
    await dialog.locator('[data-safety-close]').click();
    await reportDialog.locator('#close-report').click();

    // Phone layout keeps the page inside the viewport while its tab strip can
    // scroll independently, and visible actions remain finger-sized.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#menu-button').click();
    await page.locator('.nav-item[data-page="safety"]').click();
    await page.waitForURL(/#safety$/);
    await workspace.getByRole('tab', { name: 'Overview', exact: true }).click();
    await page.screenshot({ path: path.join(__dirname, 'output', 'safety-workspace-integrated-mobile.png'), animations: 'disabled', fullPage: true });
    assert.equal(await workspace.evaluate(node => node.scrollWidth > node.clientWidth), false, 'Safety workspace does not overflow a 390px viewport');
    const targetHeights = await workspace.locator('[role="tab"], [data-safety-action]').evaluateAll(nodes => nodes.filter(node => {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }).map(node => Math.round(node.getBoundingClientRect().height)));
    assert.ok(targetHeights.length >= 9, 'mobile workspace exposes the tab strip and one-tap actions');
    assert.ok(targetHeights.every(height => height >= 44), `all visible Safety controls are at least 44px tall: ${targetHeights.join(', ')}`);
    await workspace.getByRole('tab', { name: 'Records', exact: true }).click();
    const recordsTabVisible = await page.locator('#safety-tab-records').evaluate(node => { const tab = node.getBoundingClientRect(), strip = node.parentElement.getBoundingClientRect(); return tab.left >= strip.left - 1 && tab.right <= strip.right + 1; });
    assert.equal(recordsTabVisible, true, 'selecting a mobile tab scrolls it fully into view');
    await workspace.getByRole('tab', { name: 'Toolbox talks', exact: true }).click();
    await workspace.getByRole('button', { name: 'View daily', exact: true }).click();
    await page.waitForFunction(() => { const detail = document.getElementById('report-detail'), rect = detail?.getBoundingClientRect(); return Boolean(rect && rect.top < innerHeight && rect.bottom > 0); });
    assert.equal(await page.locator('#report-detail').evaluate(node => node === document.activeElement), true, 'mobile View daily moves focus to the exact report');
    await page.evaluate(() => { currentUser = { ...currentUser, role: 'project_manager', permissions: {} }; PDLSafetyWorkspace.render(); showPage('safety'); });
    assert.equal(await page.locator('.nav-item[data-page="safety"]').isHidden(), true, 'a PM without daily access does not get a dead Safety navigation link');
    assert.equal(await page.locator('#dashboard-page').isVisible(), true, 'a direct Safety route safely returns an unauthorized PM to their normal start page');
    assert.deepEqual(errors, [], 'real app Safety navigation raises no browser errors');
    console.log('Integrated Safety workspace passed: route, five accessible tabs, focused and report entry points, mobile fit/touch targets, and browser runtime.');
  } finally {
    await browser?.close();
    if (child?.exitCode == null) child.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
