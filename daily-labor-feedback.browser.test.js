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

    let saved=[],fail=true,patches=0;
    const fixture=()=>({id:987654,project:0,dateIso:'2026-11-02',foreman:'Popup tester',status:'Needs review',summary:'Popup regression report',laborEntries:[{memberId:987,hours:0.38}],laborExclusions:saved,productionEntries:[],history:[]});
    await page.route('**/api/state*',async route=>{const response=await route.fetch(),state=await response.json();state.team.push({id:987,name:'Synthetic Chloe'});state.reports=[fixture(),{...fixture(),id:987655,foreman:'Other worker',laborExclusions:[]}];await route.fulfill({response,json:state});});
    await page.route('**/api/reports/987654',async route=>{
      if(route.request().method()!=='PATCH')return route.continue();
      patches++;await new Promise(resolve=>setTimeout(resolve,350));
      if(fail)return route.fulfill({status:400,json:{error:'Could not save this correction. Please retry.'}});
      saved=route.request().postDataJSON().laborExclusions;
      await route.fulfill({status:200,json:fixture()});
    });
    await page.route(url=>url.pathname==='/api/reports',route=>route.request().method()==='GET'?route.fulfill({json:[fixture(),{...fixture(),id:987655,foreman:'Other worker',laborExclusions:[]}]}):route.continue());
    await page.goto(url);
    await page.locator('#email').fill('pm@example.invalid');
    await page.locator('#password').fill(password);
    await page.locator('#login button[type=submit]').click();
    await page.waitForURL('**/app?**', { timeout: 20000 });


    await page.waitForLoadState('load');
    await page.waitForFunction(()=>typeof currentUser!=='undefined'&&currentUser?.role==='owner');



    await page.evaluate(()=>showPage('reports'));await page.waitForLoadState('networkidle');
    for(const theme of ['light','dark']){
      saved=[];fail=true;patches=0;
      await page.setViewportSize({width:390,height:500});
      await page.evaluate(({theme,report})=>{document.documentElement.dataset.theme=theme;reports=[report,{...report,id:987655,foreman:'Other worker',laborExclusions:[]}];openDailyReportDetails(report.id);},{theme,report:fixture()});
      await page.evaluate(()=>{document.querySelector('#daily-details-modal').close();openDailyReportDetails(987654);});
      await page.waitForTimeout(50);
      assert.equal(await page.locator('#daily-details-modal .labor-resolve-button').count(),1,'queued close must not move reopened report behind the modal');
      const button=page.locator('.labor-resolve-button');
      await button.click();
      await page.waitForFunction(()=>document.querySelector('.labor-resolve-button')?.disabled);
      assert.equal(await button.innerText(),'Saving…');
      const notice=page.locator('.report-action-feedback');
      await notice.filter({hasText:'Could not save'}).waitFor();
      assert.equal(await notice.getAttribute('role'),'alert');
      assert.equal(await button.isDisabled(),false);
      assert.equal(await page.evaluate(()=>reports.find(r=>r.id===987654).laborExclusions.length),0);
      assert.equal(await notice.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true,'error is in front and visible');
      assert.equal(await notice.evaluate(el=>getComputedStyle(el).borderLeftColor),'rgb(255, 46, 138)');
      fs.mkdirSync('docs/daily-feedback',{recursive:true});await page.screenshot({path:`docs/daily-feedback/error-${theme}-390.png`,animations:'disabled'});
      fail=false;await button.click();await notice.filter({hasText:'now count on report #987655'}).waitFor();
      await page.screenshot({path:`docs/daily-feedback/saved-${theme}-390.png`,animations:'disabled'});
      assert.equal(patches,2);assert.equal(await page.locator('.labor-resolve-button').count(),0);
      assert.equal(await page.evaluate(()=>window.PDLReportLaborReview.countedHours(reports.find(r=>r.id===987654),987)),0);
      assert.equal(await page.evaluate(()=>reports.find(r=>r.id===987654).laborEntries[0].hours),0.38);
      assert.equal(await page.evaluate(()=>reports.find(r=>r.id===987655).laborEntries[0].hours),0.38);
      await page.evaluate(()=>notify('Synthetic report action completed.'));
      const toast=page.locator('#daily-details-modal .daily-action-notice');await toast.waitFor();
      assert.equal(await toast.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true,'notice is above the backdrop');
      await page.locator('#close-daily-details').click();
    }
    assert.deepEqual(errors,[]);
    console.log('Daily labor action: saving, visible error/retry, saved counted totals, preserved original hours and foreground notification passed.');
  } finally {await browser?.close();if(child)child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1});
