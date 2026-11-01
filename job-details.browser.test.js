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

    await page.evaluate(async()=>{showPage('projects');await openProject(projects[0].id);});
    const dialog=page.locator('#project-detail-modal');
    await page.waitForFunction(()=>!document.querySelector('#project-detail-modal').classList.contains('job-details-loading'));
    fs.mkdirSync('docs/job-details',{recursive:true});
    for(const size of [{width:390,height:844},{width:390,height:500},{width:1280,height:800}]){
      await page.setViewportSize(size);
      for(const theme of ['light','dark']){
        await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
        await page.locator('[data-project-detail-tab="overview"]').click();
        const primary=await dialog.locator('.project-detail-tabs > button').allTextContents();
        assert.equal(primary.length,4);assert.match(primary.join(' '),/Overview.*Dailies.*Estimate.*More/);
        assert.equal(await page.locator('#project-template-pin').isVisible(),false);
        await page.locator('[data-job-more]').click();
        assert.equal(await page.locator('[data-project-detail-tab="overview"]').evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)','only More is highlighted while open');
        await page.locator('[data-job-more]').click();

        assert.equal(await dialog.locator('.job-overview-summary').isVisible(),true);
        const layout=await dialog.evaluate(el=>{const header=el.querySelector('.modal-header'),close=el.querySelector('.close-button'),body=el.querySelector('#project-detail-content');return{overflow:el.scrollWidth>el.clientWidth+1||body.scrollWidth>body.clientWidth+1,bottom:el.getBoundingClientRect().bottom,height:innerHeight,headerLeft:header.getBoundingClientRect().left-el.getBoundingClientRect().left,headerBorder:getComputedStyle(header).borderBottomColor,headerBg:getComputedStyle(header).backgroundColor,headerColor:getComputedStyle(header).color,closeWidth:close.getBoundingClientRect().width,closeHeight:close.getBoundingClientRect().height};});
        assert.equal(layout.overflow,false);assert.ok(layout.bottom<=layout.height);assert.ok(layout.headerLeft<=2,JSON.stringify(layout));assert.equal(layout.headerBorder,'rgb(255, 102, 0)');assert.equal(layout.headerBg,'rgb(0, 0, 0)');assert.equal(layout.headerColor,'rgb(255, 255, 255)');assert.ok(layout.closeWidth>=48&&layout.closeHeight>=48);
        await dialog.locator('#project-detail-content').evaluate(el=>el.scrollTop=0);
        await page.screenshot({path:`docs/job-details/overview-${theme}-${size.width}x${size.height}.png`});
        await page.locator('[data-project-detail-tab="dailies"]').click();
        assert.equal(await page.locator('[data-project-detail-pane="dailies"]').isVisible(),true);
        assert.equal(await page.locator('.job-overview-summary').isVisible(),false);
        await page.locator('[data-project-detail-tab="estimate"]').click();
        assert.equal(await page.locator('[data-project-detail-pane="estimate"]').isVisible(),true);
        await page.screenshot({path:`docs/job-details/estimate-${theme}-${size.width}x${size.height}.png`});
        for(const key of ['photos','plans','changes','tickets','notes','schedule']){
          await page.locator('[data-job-more]').click();
          await page.locator(`[data-project-detail-tab="${key}"]`).click();
          assert.equal(await page.locator(`[data-project-detail-pane="${key}"]`).isVisible(),true,key);
          assert.equal(await page.locator('[data-job-more]').getAttribute('aria-expanded'),'false');
        }
        await page.locator('[data-job-more]').click();
        assert.equal(await page.locator('.job-forms').getAttribute('open'),null);
        await page.locator('.job-forms > summary').click();
        assert.equal(await page.locator('#project-template-pin').isVisible(),true);
        assert.equal(await page.locator('#save-project-templates').isVisible(),true);
        await page.screenshot({path:`docs/job-details/more-${theme}-${size.width}x${size.height}.png`});
        await page.locator('.job-forms > summary').click();
        await page.locator('[data-job-more]').focus();await page.keyboard.press('Escape');
        assert.equal(await dialog.isVisible(),true,'Escape closes More before dialog');
        assert.equal(await page.locator('#job-more-panel').isVisible(),false);
      }
    }

    await page.setViewportSize({width:390,height:500});
    await page.locator('[data-job-more]').click();await page.locator('.job-forms > summary').click();
    const choice=page.locator('[data-project-template-choice]').nth(1);await choice.uncheck();
    const saved=page.waitForResponse(response=>response.url().endsWith('/template')&&response.request().method()==='PATCH');
    await page.locator('#save-project-templates').scrollIntoViewIfNeeded();
    const hit=await page.locator('#save-project-templates').evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));});assert.ok(hit,'forms save remains reachable');
    await page.locator('#save-project-templates').click();assert.equal((await saved).ok(),true);
    await page.locator('#project-detail-modal .close-button').click();
    await page.evaluate(async()=>{await openProject(projects[0].id);});
    await page.locator('[data-job-more]').click();await page.locator('.job-forms > summary').click();
    assert.equal(await page.locator('[data-project-template-choice]').nth(1).isChecked(),false,'saved form choice survives reopening');
    await page.locator('[data-project-detail-tab="dailies"]').click();
    await page.locator('[data-office-new-daily]').click();await page.locator('#report-modal').waitFor({state:'visible'});
    await page.locator('#close-report').click();await page.locator('#report-modal').waitFor({state:'hidden'});
    await page.locator('[data-project-detail-tab="overview"]').click();
    await page.locator('#project-detail-modal .close-button').click();
    assert.equal(await page.evaluate(()=>document.querySelector('.page.active').id),'projects-page');
    assert.deepEqual(errors,[]);
    console.log('Job details passed: four main tabs, all secondary panes, collapsed forms, preserved actions, phone/desktop and both themes.');
  }finally{if(browser)await browser.close();if(child)child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});

