'use strict';

// Shared daily details popup regression. The demo runner creates disposable data and
// disables every external provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

let chromium;
for (const dependency of [
  'playwright',
  'playwright-core',
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
  '/usr/bin/google-chrome-stable',
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
    page.on('pageerror', error => {errors.push(error.message);console.error(error.message);});
    await page.route('**/*', route => route.request().url().startsWith(new URL(url).origin) ? route.continue() : route.abort());

    await page.route('**/api/state*',async route=>{const response=await route.fetch();const state=await response.json();if(!state.projects.length)state.projects.push({id:98765,name:'Popup test project',code:'POP',estimateItems:[]});state.reports.push({id:987654,project:0,dateIso:'2026-11-02',foreman:'Popup tester',status:'Needs review',summary:'Popup regression report',laborEntries:[],productionEntries:[],history:[]});await route.fulfill({response,json:state});});
    await page.goto(url);
    await page.locator('#email').fill('pm@example.invalid');
    await page.locator('#password').fill(password);
    await page.locator('#login button[type=submit]').click();
    await page.waitForURL('**/app?**', { timeout: 20000 });


    await page.waitForLoadState('load');
    await page.waitForFunction(()=>typeof currentUser!=='undefined'&&currentUser?.role==='owner');



    for(const width of [390,1280])for(const theme of ['light','dark']){
      await page.setViewportSize({width,height:width===390?844:800});
      await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;setNavigationOpen(false);showPage('reports');renderReports(987654);},theme);
      const hash=await page.evaluate(()=>location.hash);
      await page.locator('[data-report="987654"]').click();
      const popup=page.locator('#daily-details-modal');
      assert.equal(await popup.evaluate(el=>el.open),true);
      assert.match(await popup.innerText(),/Popup regression report/);
      assert.ok(await popup.evaluate(el=>el.scrollWidth<=el.clientWidth),'popup has no horizontal overflow');
      assert.equal(await page.evaluate(()=>location.hash),hash);
      await page.evaluate(()=>document.fonts.ready);
      await page.waitForTimeout(250);
      fs.mkdirSync('docs/report-popup',{recursive:true});
      assert.equal(await popup.locator('.modal-header').evaluate(el=>getComputedStyle(el).borderBottomColor),'rgb(255, 102, 0)');
      assert.equal(await popup.locator('.report-status-review').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(255, 102, 0)');
      await page.screenshot({path:`docs/report-popup/${theme}-${width}.png`,animations:'disabled'});
      await page.locator('#close-daily-details').click();
      await page.waitForFunction(()=>document.activeElement?.dataset.report==='987654');
      await page.evaluate(()=>{showPage('projects');openProject(projects[0].id);});
      await page.locator('[data-project-detail-tab="dailies"]').click();
      const before=await page.evaluate(()=>({hash:location.hash,scroll:document.querySelector('#project-detail-modal').scrollTop}));
      await page.locator('[data-open-project-report="987654"]').click();
      assert.equal(await popup.evaluate(el=>el.open),true);
      assert.match(await popup.innerText(),/Popup regression report/);
      assert.equal(await page.locator('#project-detail-modal').evaluate(el=>el.open),true);
      await page.keyboard.press('Escape');
      assert.equal(await popup.evaluate(el=>el.open),false);
      assert.deepEqual(await page.evaluate(()=>({hash:location.hash,scroll:document.querySelector('#project-detail-modal').scrollTop})),before);
      await page.locator('#project-detail-modal').evaluate(el=>el.close());
    }
    assert.deepEqual(errors,[]);
    console.log('Daily report shared popup passed in both themes at phone and desktop widths.');
  } finally {await browser?.close();if(child)child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1});
