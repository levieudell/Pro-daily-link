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

    await page.waitForFunction(()=>window.pdlWorkspaceStateReady&&projects.length>1);



    const fixture=await page.evaluate(()=>{
      const first=team[0],other=team.find(p=>p.crew!==first.crew);if(!other)throw Error('Fixture needs two crews');
      openReport(null,{projectIndex:0,dateIso:companyTodayIso()});
      document.querySelector('#report-crew').value=first.crew;
      populateReportLabor([{memberId:first.id,hours:0.05}]);
      document.querySelector('#field-notes').value='Manual daily member correction.';showReportStep(2);
      return {first:first.id,other:other.id,team:JSON.stringify(team),cards:JSON.stringify(timeCards)};
    });
    await page.waitForFunction(()=>reportLaborLoadedKey===reportLaborSelectionKey());
    await page.evaluate(id=>{document.querySelector('#report-crew').value=team.find(m=>m.id===id).crew;populateReportLabor([{memberId:id,hours:0.05}]);document.querySelector(`[data-labor-member="${id}"]`).dataset.manualHours='true';},fixture.first);
    fs.mkdirSync('docs/daily-remove-member',{recursive:true});
    for(const width of [390,1280])for(const theme of ['light','dark']){
      await page.setViewportSize({width,height:width===390?667:800});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      await page.locator('#report-add-labor-member').selectOption(String(fixture.other));
      assert.equal(await page.locator(`[data-labor-member="${fixture.first}"]`).inputValue(),'0.05','adding a person preserves existing entered hours');
      assert.equal(await page.locator(`[data-labor-member="${fixture.first}"]`).getAttribute('data-manual-hours'),'true');
      const remove=page.locator(`[data-remove-report-member="${fixture.other}"]`);
      await remove.evaluate(el=>el.scrollIntoView({block:'center'}));
      assert(await remove.evaluate(el=>{const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return el===hit||el.contains(hit);}));
      await page.screenshot({path:`docs/daily-remove-member/remove-${theme}-${width}.png`});
      await remove.click();assert.equal(await page.locator(`[data-labor-member="${fixture.other}"]`).count(),0);
      assert.equal(await page.locator(`[data-labor-member="${fixture.first}"]`).inputValue(),'0.05');
      assert(await page.locator(`#report-add-labor-member option[value="${fixture.other}"]`).count());
    }

    // A re-render must not strip the provenance guard from approved card hours.
    await page.evaluate(id=>{document.querySelector(`[data-labor-member="${id}"]`).dataset.timecardDerived='true';},fixture.first);
    await page.locator('#report-add-labor-member').selectOption(String(fixture.other));
    await page.locator(`[data-remove-report-member="${fixture.first}"]`).click();
    assert.equal(await page.locator(`[data-labor-member="${fixture.first}"]`).inputValue(),'0.05');
    assert.match(await page.locator('#report-submit-status').innerText(),/come from time cards/);
    await page.locator(`[data-remove-report-member="${fixture.other}"]`).click();
    await page.evaluate(id=>{delete document.querySelector(`[data-labor-member="${id}"]`).dataset.timecardDerived;},fixture.first);
    // Saved manual hours for the accidental person are removed from the actual draft payload.
    await page.locator('#report-add-labor-member').selectOption(String(fixture.other));
    await page.locator(`[data-labor-member="${fixture.other}"]`).fill('2');
    await page.evaluate(async()=>{await saveDailyReport('Draft',{keepOpen:true});});
    const id=await page.evaluate(()=>editingReportId);assert(id);
    await page.locator(`[data-remove-report-member="${fixture.other}"]`).click();
    await page.evaluate(async()=>{await saveDailyReport('Draft',{keepOpen:true});});
    const saved=await page.evaluate(id=>reports.find(r=>r.id===id),id);
    assert(!saved.laborEntries.some(r=>Number(r.memberId)===fixture.other));
    await page.evaluate(id=>{document.querySelector('#report-modal').close();openReport(reports.find(r=>r.id===id));showReportStep(2);},id);
    assert.equal(await page.locator(`[data-labor-member="${fixture.other}"]`).count(),0,'removed added member stays absent after save/reopen');
    assert.equal(await page.evaluate(()=>JSON.stringify(team)),fixture.team);
    assert.equal(await page.evaluate(()=>JSON.stringify(timeCards)),fixture.cards);
    assert.deepEqual(errors,[]);console.log('Daily member removal passed: add/remove/re-add, unchanged hours and metadata, real save/reopen, no team or clock mutations, responsive themes.');
  }finally{await browser?.close();if(child?.exitCode==null)child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
