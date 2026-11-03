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



    await page.route(url=>url.pathname==='/api/reports',async route=>route.fulfill({json:[]}));
    await page.evaluate(()=>showPage('reports'));await page.waitForLoadState('networkidle');
    for(const width of [390,768,1024,1280])for(const theme of ['light','dark']){
      await page.setViewportSize({width,height:width===390?844:800});
      await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;setNavigationOpen(false);reports=['Needs review','Draft','Approved','Missing data'].map((status,i)=>({id:900+i,project:0,dateIso:'2026-11-0'+(4-i),foreman:['Jordan Reed','Alex Martinez','Sam Parker','Taylor Lane'][i],status,summary:'Daily list fixture',laborEntries:[],productionEntries:[],history:[]}));$('#report-status-filter').value='all';renderReports();},theme);
      assert.equal(await page.locator('#report-detail').isVisible(),false,'no inline preview');
      const list=page.locator('#report-list'),layout=page.locator('.report-layout');
      assert.ok(Math.abs((await list.boundingBox()).width-(await layout.boundingBox()).width)<2,'list uses the available width');
      assert.equal(await page.locator('#report-list [data-report]').count(),4);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal scroll');
      await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(250);fs.mkdirSync('docs/daily-list',{recursive:true});
      await page.screenshot({path:`docs/daily-list/${theme}-${width}.png`,animations:'disabled'});
      await page.locator('[data-report="901"]').click();await page.locator('#daily-details-modal').waitFor();
      assert.match(await page.locator('#report-detail').innerText(),/Alex Martinez/);
      await page.locator('#close-daily-details').click();await page.waitForFunction(()=>!$('#daily-details-modal').open&&$('#report-detail').parentElement.classList.contains('report-layout'));
      assert.equal(await page.locator('#report-detail').isVisible(),false,'closing leaves only the list');
      await page.locator('#report-status-filter').selectOption('Approved');assert.equal(await page.locator('#report-list [data-report]').count(),1);
      await page.locator('#report-status-filter').selectOption('all');await page.locator('#report-sort').selectOption('oldest');
      assert.equal(await page.locator('#report-list [data-report]').first().getAttribute('data-report'),'903');
      await page.locator('#report-sort').selectOption('newest');
    }
    await page.evaluate(()=>{actionCenter={counts:{total:1},items:[{id:'daily-list-action',reportId:901,title:'Review daily',detail:'Regression fixture',severity:'high'}]};showPage('actions');renderActionCenter();});
    await page.locator('[data-action-id="daily-list-action"]').click();
    await page.locator('#daily-details-modal').waitFor();
    assert.match(await page.locator('#report-detail').innerText(),/Alex Martinez/,'Action center opens the requested report popup');
    assert.deepEqual(errors,[]);
    console.log('Daily list passed: full-width rows, no inline preview, filtering, sorting, exact popup, responsive themes and no overflow.');
  } finally {await browser?.close();if(child)child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1});
