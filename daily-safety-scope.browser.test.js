'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
let chromium;
for (const name of ['playwright','playwright-core',process.env.PDL_PLAYWRIGHT_MODULE,path.join(os.homedir(),'.cache','codex-runtimes','codex-primary-runtime','dependencies','node','node_modules','playwright')].filter(Boolean)) {
  try { chromium = require(name).chromium; break; } catch {}
}
assert(chromium,'Playwright must be installed');
const executablePath = process.env.PDL_BROWSER_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].find(fs.existsSync);
(async()=>{
  let child,browser;
  try {
    child=spawn(process.execPath,['scripts/safety-demo.cjs','--port=0'],{cwd:__dirname,stdio:['ignore','pipe','pipe']});
    let log='';
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Demo startup timeout')),15000);
      child.stdout.on('data',chunk=>{log+=chunk;if(log.includes('Temporary demo password:')){clearTimeout(timer);resolve();}});
      child.stderr.on('data',()=>{});
      child.on('exit',code=>{clearTimeout(timer);reject(Error('Demo exited '+code));});
    });
    const url=log.match(/Safety demo: (http[^\s]+)/)[1],password=log.match(/Temporary demo password: ([^\s]+)/)[1];
    browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
    const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.request().url().startsWith(new URL(url).origin)?route.continue():route.abort());
    await page.goto(url);await page.locator('#email').fill('pm@example.invalid');await page.locator('#password').fill(password);
    await page.locator('#login button[type=submit]').click();await page.waitForURL('**/app?**');
    await page.waitForFunction(()=>window.pdlWorkspaceStateReady&&projects.length>1);
    fs.mkdirSync('docs/daily-safety-scope',{recursive:true});
    await page.evaluate(()=>{
      projects[0].estimateItems=[{id:991,name:'Lock+Load Wall',unit:'LF',plannedQuantity:275}];
      const report={id:99001,project:0,dateIso:'2026-11-01',status:'Submitted',foreman:'Test worker',summary:'Installed 300 LF of wall.',productionEntries:[{estimateItemId:991,description:'Lock+Load Wall',quantity:300,unit:'LF',laborHours:8,extra_work:false}],laborEntries:[],scopeFlags:[{decision:'estimate'}]};
      reports.push(report);showPage('reports');renderReports(report.id);
    });
    await page.locator('.report-work-detail summary').click();
    assert.match(await page.locator('.report-work-detail').innerText(),/25 LF over estimate/);
    assert.match(await page.locator('.report-work-detail').innerText(),/275 LF/);
    assert.match(await page.locator('#report-detail').innerText(),/11\/01\/2026/);
    for(const viewport of [{width:390,height:844},{width:390,height:500},{width:1280,height:800}]){
    await page.setViewportSize(viewport);
    for(const theme of ['light','dark']){
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      await page.locator('.report-work-detail').evaluate(el=>el.scrollIntoView({block:'center'}));
      await page.screenshot({path:`docs/daily-safety-scope/production-${theme}-${viewport.width}x${viewport.height}.png`});
    }
    }
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>{
      openReport(reports.find(row=>row.id===99001));showReportStep(2);updateReportGaps();
    });
    assert.match(await page.locator('[data-quantity-overrun]').innerText(),/25 LF over/);
    await page.evaluate(()=>document.querySelector('#report-modal').close());
    // A new project's selected work types are persisted on the existing safety profile.
    const result=await page.evaluate(async()=>{
      const response=await fetch('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Excavation scope test',site:'Portland, OR',workActivities:['excavation']})});
      return {status:response.status,project:await response.json()};
    });
    assert.equal(result.status,201);
    assert.deepEqual(result.project.safetyProfile.activities,['excavation']);
    assert.equal(result.project.safetyProfile.activitySelection,'explicit');
    assert.equal(result.project.safetyProfile.enabled,false,'choosing work does not claim safety is complete');
    const setup=await page.evaluate(async project=>{
      async function request(suffix,method,body){const response=await fetch(`/api/projects/${project.id}/safety${suffix}`,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw Error(await response.text());return response.json();}
      projects.push(project);
      await request('/profile','PUT',{revision:project.safetyProfile.revision,enabled:true,activities:['excavation']});
      const date=companyTodayIso(),day=await request('/days','POST',{date,revision:0});
      const withHazard=await request(`/days/${date}/hazards`,'POST',{revision:day.revision,observation:'Synthetic wrong roof record',location:'Synthetic excavation site',action:'Original action',owner:'Synthetic owner',dueDate:date,workStopped:true});
      await PDLSafetyPM.open({projectId:project.id,date,mode:'followup'});
      return {date,id:withHazard.hazards[0].id};
    },result.project);
    await page.locator('#safety-pm-dialog').getByText('Recorded in error',{exact:true}).click();
    await page.locator('[data-safety-hazard-void] [name=reason]').fill('Wrong work type. No roof work was reported.');
    await page.locator('[data-safety-hazard-void] button[type=submit]').click();
    await page.waitForFunction(()=>document.querySelector('#safety-pm-dialog')?.textContent.includes('Follow-up is clear'));
    const evidence=await page.evaluate(async ({projectId,date})=>(await fetch(`/api/projects/${projectId}/safety?date=${date}`)).json(),{projectId:result.project.id,date:setup.date});
    assert.equal(evidence.day.hazards[0].status,'voided');
    assert.equal(evidence.day.hazards[0].observation,'Synthetic wrong roof record');
    assert.match(evidence.day.hazards[0].voidReason,/Wrong work type/);
    assert.equal(evidence.openHazards.length,0);
    assert.deepEqual(errors,[]);
    console.log('Daily details browser checks passed: expandable line, persistent 25 LF overrun, numeric date, explicit work selection.');
  } finally {if(browser)await browser.close();if(child)child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
