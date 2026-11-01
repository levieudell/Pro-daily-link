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
    await page.waitForTimeout(800); // Let startup render wrappers settle before installing synthetic data.
    await page.evaluate(()=>{
      projects[0].estimateItems=[{id:991,name:'Lock+Load Wall',unit:'LF',plannedQuantity:275}];
      reports=[{id:99001,project:0,status:'Needs review',productionEntries:[{estimateItemId:991,quantity:300,unit:'LF',extra_work:false}]}];
      showPage('projects');renderProjectCards();
    });
    const card=page.locator('[data-project-card]').first();
    assert.equal(await card.locator('.project-card-actions .status').innerText(),'At risk');
    assert.match(await card.locator('.project-health-reason').innerText(),/25 LF over estimate/);
    await page.evaluate(()=>{
      const project=projects[0];project.estimateItems=[{id:991,name:'Wall',unit:'LF',plannedQuantity:100,budgetHours:100}];
      reports=[];projectTasks=[];assignments=Array.from({length:4},(_,index)=>{const day=new Date(companyTodayIso()+'T12:00:00Z');day.setUTCDate(day.getUTCDate()+index+1);return{projectId:project.id,date:day.toISOString().slice(0,10)};});
      productionData.projects=[{projectId:project.id,items:[{estimateItemId:991,plannedQuantity:100,actualQuantity:60,budgetHours:100,actualLaborHours:85}]}];
      renderProjectCards();
    });
    assert.match(await card.locator('.project-health-reason').innerText(),/85%.*approved.*4 scheduled workdays/);
    await card.locator('[data-open-health]').click();
    await page.locator('#project-detail-modal').waitFor({state:'visible'});
    await page.locator('[data-health-tab="schedule"]').click();
    await page.locator('[data-project-detail-pane="schedule"].active').waitFor({state:'visible'});
    await page.locator('[data-health-tab="estimate"]').click();
    await page.locator('[data-project-detail-pane="estimate"].active').waitFor({state:'visible'});
    await page.locator('#project-detail-modal .close-button').click();
    await page.locator('#project-detail-modal').waitFor({state:'hidden'});
    fs.mkdirSync('docs/project-health-warning',{recursive:true});
    // Simulate mobile Safari: a formerly focused control is off-screen when a card is tapped.
    for(const viewport of [{width:390,height:844},{width:1280,height:800}]){
    await page.setViewportSize(viewport);
    for(const theme of ['light','dark']){
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
      const colors=await card.locator('.status.warning').evaluate(node=>({background:getComputedStyle(node).backgroundColor,color:getComputedStyle(node).color}));
      assert.deepEqual(colors,{background:'rgb(255, 102, 0)',color:'rgb(0, 0, 0)'});
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({path:`docs/project-health-warning/${theme}-${viewport.width}.png`});
      const target=page.locator('[data-project-card]').last().locator('[data-open-project]');
      await page.locator('#project-search').focus();
      await target.scrollIntoViewIfNeeded();
      const before=await page.evaluate(()=>({y:scrollY,hash:location.hash}));
      await target.dispatchEvent('click');
      await page.locator('#project-detail-modal').waitFor({state:'visible'});
      await page.locator('#project-detail-modal .close-button').click();
      await page.locator('#project-detail-modal').waitFor({state:'hidden'});
      await page.waitForTimeout(100);
      const after=await page.evaluate(()=>({y:scrollY,hash:location.hash}));
      assert.equal(after.hash,before.hash);
      assert.ok(Math.abs(after.y-before.y)<=2,`close restores list position: ${JSON.stringify({before,after})}`);
      assert.equal(await target.evaluate(el=>el===document.activeElement),true);
      await target.dispatchEvent('click');
      await page.locator('#project-detail-modal').waitFor({state:'visible'});
      await page.keyboard.press('Escape');
      await page.locator('#project-detail-modal').waitFor({state:'hidden'});
      assert.ok(Math.abs((await page.evaluate(()=>scrollY))-before.y)<=2,'Escape restores list position');
    }
    }
    await page.evaluate(async()=>{await openProject(projects[0].id);showPage('dashboard');window.scrollTo(0,0);});
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>document.querySelector('.page.active').id),'dashboard-page','intentional navigation is not undone');
    assert.equal(await page.evaluate(()=>scrollY),0);
    assert.deepEqual(errors,[]);
    console.log('Project overrun and stable close browser checks passed');
  } finally {if(browser)await browser.close();if(child)child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
