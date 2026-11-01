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


    await page.setViewportSize({width:390,height:844});
    await page.evaluate(async()=>{await openProject(projects[0].id);});
    assert(await page.locator('#project-modal').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'project forms must fit phone width');
    await page.evaluate(()=>document.querySelector('#project-modal').close());
    const note='Worked on the Lock+Load Wall for 30 hours by myself. Forgot to clock in last two days. I got 300 linear feet of Lock+Load Wall installed, and ran the excavator for 12 hours.';
    await page.route('**/api/ai/extract',async route=>{const data=route.request().postDataJSON();delete data.projectId;data.estimateItems=[{id:991,name:'Lock+Load Wall',unit:'LF',plannedQuantity:500}];const response=await route.fetch({postData:JSON.stringify(data)});await route.fulfill({response});});
    await page.evaluate(async note=>{projects[0].estimateItems=[{id:991,name:'Lock+Load Wall',unit:'LF',plannedQuantity:500}];const draft=await api('/api/reports',{method:'POST',body:JSON.stringify({project:0,dateIso:companyTodayIso(),status:'Draft',notes:note,summary:'No production or labor recorded.',productionEntries:[],laborEntries:[]})});reports.unshift(draft);openReport(draft);showReportStep(1);},note);
    await page.locator('#report-next-step').click();
    await page.waitForFunction(()=>!document.querySelector('#report-next-step').disabled);
    assert.equal(await page.locator('.production-entry .production-quantity').inputValue(),'300','saved empty daily must re-extract notes');
    assert.match(await page.locator('#report-equipment').inputValue(),/excavator.*12 hours/i);
    assert(!/No production or labor recorded/i.test(await page.locator('#report-summary').inputValue()));
    assert.match(await page.locator('#field-review-cards').innerText(),/30.*hours.*days/i);
    fs.mkdirSync('docs/daily-notes-repair',{recursive:true});
    for(const [width,height] of [[390,500],[390,844],[1280,800]])for(const theme of ['light','dark']){
      await page.setViewportSize({width,height});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      assert.equal(await page.locator('#report-review-summary').evaluate(el=>getComputedStyle(el).position),'static');
      assert(await page.locator('#report-modal').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
      for(const selector of ['#field-edit-hours','#field-add-line']){assert.equal(await page.locator(selector).evaluate(el=>getComputedStyle(el).color),theme==='dark'?'rgb(255, 255, 255)':'rgb(0, 0, 0)');}
      await page.locator('.report-step.active .report-step-scroll').evaluate(el=>el.scrollTop=0);
      await page.screenshot({path:`docs/daily-notes-repair/review-${theme}-${width}x${height}.png`});
      for(const selector of ['#field-edit-hours','#field-add-line']){
        await page.locator(selector).evaluate(el=>el.scrollIntoView({block:'center'}));
        assert(await page.locator(selector).evaluate(el=>{const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return hit===el||el.contains(hit);}),selector+' is reachable above the footer');
      }
      await page.screenshot({path:`docs/daily-notes-repair/hours-${theme}-${width}x${height}.png`});

    }

    await page.evaluate(async()=>{await saveDailyReport('Needs review',{keepOpen:true});});
    assert.match(await page.locator('#report-submit-status').innerText(),/Enter the hours worked on this report date/);
    const beforeCards=await page.evaluate(()=>JSON.stringify(timeCards));
    await page.evaluate(()=>{editingReportId=null;document.querySelector('.production-quantity').value='287';document.querySelector('#report-signature').value='Synthetic reviewer';});
    await page.evaluate(async()=>{await saveDailyReport('Draft',{keepOpen:true});});
    const saved=await page.evaluate(note=>reports.find(r=>r.notes===note&&r.productionEntries?.some(p=>p.quantity===287)),note);
    assert(saved?.id,'corrected quantity saves through real report API');assert.match(saved.equipment,/excavator.*12 hours/i);assert.equal(saved.notes,note);
    await page.evaluate(id=>{document.querySelector('#report-modal').close();openReport(reports.find(r=>r.id===id));showReportStep(1);},saved.id);
    await page.locator('#report-next-step').click();await page.waitForFunction(()=>!document.querySelector('#report-next-step').disabled);
    assert.equal(await page.locator('.production-quantity').inputValue(),'287','manual correction survives reopen and Done');
    assert.equal(await page.evaluate(()=>JSON.stringify(timeCards)),beforeCards,'review never creates or changes clock punches');

    // The same note in the field flow must not clamp a multi-day total to 24 hours.
    await page.evaluate(note=>{document.querySelector('#report-modal').close();currentRole='field';currentUser={...currentUser,memberId:team[0].id};timeCards=[];workdays=[];openReport(null,{projectIndex:0,dateIso:companyTodayIso()});document.querySelector('#field-notes').value=note;showReportStep(1);},note);
    await page.locator('#report-next-step').click();await page.waitForFunction(()=>!document.querySelector('#report-next-step').disabled);
    assert.equal(await page.locator('.production-quantity').inputValue(),'300');
    assert(!(await page.locator('[data-labor-member]').evaluateAll(els=>els.some(el=>Number(el.value)===24))),'multi-day notes cannot silently become a 24-hour shift');
    assert.match(await page.locator('#report-equipment').inputValue(),/excavator.*12 hours/i);
    assert.deepEqual(errors,[]);console.log('Daily note repair: saved empty draft re-extracts quantity, retains equipment and multi-day labor, responsive office review branding.');
  }finally{await browser?.close();if(child?.exitCode==null)child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
