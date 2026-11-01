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
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(new URL(url).origin) ? route.continue() : route.abort());

    await page.goto(url);
    await page.locator('#email').fill('pm@example.invalid');
    await page.locator('#password').fill(password);
    await page.locator('#login button[type=submit]').click();
    await page.waitForURL('**/app?**', { timeout: 20000 });


    await page.waitForLoadState('load');
    await page.waitForFunction(()=>typeof currentUser!=='undefined'&&currentUser?.role==='owner');
    await page.evaluate(async()=>{crews=await api('/api/crews');teamTab='crews';showPage('team');renderTeamDirectory();});
    const concrete=await page.evaluate(()=>crews.find(row=>row.name==='Concrete'));
    const card=page.locator(`[data-crew-open="${concrete.id}"]`),dialog=page.locator('#crew-details-modal');
    await card.click();await dialog.waitFor();
    assert.match(await dialog.innerText(),/No work history recorded/);
    assert(await dialog.locator('[data-crew-project]').count()>0,'real seeded upcoming assignments are displayed');
    await dialog.locator('[data-crew-close]').click();
    // Historical fixtures are injected into the already authorized, local workspace.
    await page.evaluate(()=>{
      const projectIndex=projects.findIndex(row=>row.id===3);
      reports.push({id:9901,crew:'Concrete',project:projectIndex,dateIso:'2026-10-20',status:'Approved',laborEntries:[{memberId:1,hours:8}]},{id:9902,crew:'Concrete',project:projectIndex,dateIso:'2026-10-21',status:'Needs review',laborEntries:[{memberId:1,hours:2}]},{id:9903,crew:'Pipe',project:projectIndex,dateIso:'2026-10-22',status:'Approved',laborEntries:[{memberId:1,hours:20}]});
      renderTeamDirectory();
    });
    fs.mkdirSync(path.join(__dirname,'docs','crew-details'),{recursive:true});
    for(const width of [390,1280])for(const theme of ['light','dark']){
      await page.setViewportSize({width,height:width===390?667:800});
      await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;setNavigationOpen(false);window.scrollTo(0,0);},theme);
      await page.screenshot({path:`docs/crew-details/cards-${theme}-${width}.png`,animations:'disabled'});
      await card.focus();await page.keyboard.press('Enter');
      await dialog.evaluate(async el=>{await Promise.all(el.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})));});
      assert.equal(await dialog.locator('[data-crew-jobs] button').count(),1);
      assert.match(await dialog.locator('.crew-overview').innerText(),/8.0/);
      assert.equal(await dialog.locator('[data-crew-report]').count(),2);
      await dialog.locator('[data-crew-review]').click();assert.equal(await dialog.locator('[data-crew-report]:visible').count(),1);
      await dialog.locator('[data-crew-daily-filter]').selectOption('all');
      await dialog.locator('.crew-details-scroll').evaluate(el=>el.scrollTop=0);
      assert(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
      for(const selector of ['#crew-details-title','[data-crew-close]'])assert.equal(await dialog.locator(selector).evaluate(el=>getComputedStyle(el).color),'rgb(255, 255, 255)',selector);
      const color=await dialog.evaluate(el=>getComputedStyle(el).color);assert.equal(color,theme==='dark'?'rgb(255, 255, 255)':'rgb(0, 0, 0)');
      await page.screenshot({path:`docs/crew-details/overview-${theme}-${width}.png`,animations:'disabled'});
      await dialog.locator('[data-crew-search]').fill('not a job');assert(await dialog.locator('[data-crew-no-jobs]').isVisible());
      await dialog.locator('[data-crew-search]').fill('');
      await dialog.locator('[data-crew-jobs]').scrollIntoViewIfNeeded();
      await page.screenshot({path:`docs/crew-details/history-${theme}-${width}.png`,animations:'disabled'});
      await dialog.locator('[data-crew-close]').click();
    }
    await card.click();await dialog.locator('[data-crew-jobs] button').click();
    await page.locator('#project-detail-modal').waitFor();assert.equal(await page.locator('#project-detail-modal').getAttribute('data-project-id'),'3');
    await page.locator('#project-detail-modal').evaluate(el=>el.close());
    await card.click();await dialog.locator('[data-crew-report="9902"]').click();
    await page.locator('#reports-page.active').waitFor();assert.equal(await page.locator('#report-list .active').getAttribute('data-report'),'9902');
    await page.evaluate(()=>{showPage('team');teamTab='crews';renderTeamDirectory();});
    await card.click();await dialog.locator('[data-crew-member="1"]').click();
    await page.locator('#team-details-modal').waitFor();assert.match(await page.locator('#team-details-title').innerText(),/Jordan/i);await page.locator('#team-details-modal').evaluate(el=>el.close());
    await page.evaluate(()=>{teamTab='crews';renderTeamDirectory();});await card.click();await dialog.locator('[data-crew-edit]').click();
    await page.locator('#crew-modal').waitFor();assert.equal(await page.locator('#crew-name').inputValue(),'Concrete');await page.locator('#crew-modal').evaluate(el=>el.close());
    await card.click();await dialog.locator('[data-crew-schedule]').click();await page.locator('#schedule-page.active').waitFor();assert.equal(await page.locator('#schedule-crew-filter').inputValue(),'Concrete');
    await page.evaluate(()=>{showPage('team');teamTab='crews';renderTeamDirectory();});
    await page.evaluate(()=>{currentUser={...currentUser,role:'project_manager',assignedCrews:['Concrete'],permissions:{}};renderTeamDirectory();});
    assert.equal(await page.locator('[data-crew-open]').count(),1);await card.click();assert.equal(await dialog.locator('[data-crew-edit]').count(),0);assert(!/Approved daily hours/.test(await dialog.innerText()));
    await page.evaluate(()=>{currentRole='field';renderTeamDirectory();});assert(!(await dialog.isVisible()));assert.equal(await page.locator('[data-crew-open]').count(),0);
    assert.deepEqual(errors,[]);
    console.log('Crew details browser passed: cards, keyboard, history, job search, approved hours, job/member drill-down, existing edit flow, role scope and responsive themes.');
  }finally{await browser?.close();if(child?.exitCode==null)child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
