'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
let chromium;
for (const name of ['playwright','playwright-core',process.env.PDL_PLAYWRIGHT_MODULE,path.join(os.homedir(),'.cache','codex-runtimes','codex-primary-runtime','dependencies','node','node_modules','playwright')].filter(Boolean)) {
  try { chromium = require(name)[process.env.PDL_SCHEDULE_BROWSER === 'webkit' ? 'webkit' : 'chromium']; break; } catch {}
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
    browser=await chromium.launch({headless:true,...(executablePath && process.env.PDL_SCHEDULE_BROWSER !== 'webkit'?{executablePath}:{})});
    const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.request().url().startsWith(new URL(url).origin)?route.continue():route.abort());
    await page.goto(url);await page.locator('#email').fill('pm@example.invalid');await page.locator('#password').fill(password);
    await page.locator('#login button[type=submit]').click();await page.waitForURL('**/app?**');
    await page.waitForFunction(()=>window.pdlWorkspaceStateReady&&projects.length>1);

    const shortSchedule=process.env.PDL_SCHEDULE_SHORT === '1';
    const pid=await page.evaluate(()=>projects[0].id);
    await page.evaluate(async ({pid,shortSchedule})=>{await api(`/api/projects/${pid}/tasks`,{method:'POST',body:JSON.stringify({name:'Excavate footing',durationDays:shortSchedule?1:80,predecessorIds:[],memberIds:[]})});showPage('projects');await openProject(pid);},{pid,shortSchedule});
    fs.mkdirSync('docs/project-schedule-brand',{recursive:true});
    for(const size of [{width:1280,height:800},{width:390,height:844},{width:390,height:500}]){
      await page.setViewportSize(size);
      for(const theme of ['light','dark']){
        await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
        await page.locator('[data-project-detail-tab="overview"]').click();
        await page.locator('[data-overview-card="milestone"]').click();
        await page.locator('[data-schedule-task-row]').first().waitFor({state:'attached'}).catch(()=>{});
        await page.locator('[data-schedule-view="table"]').click();
        const pane=page.locator('[data-project-detail-pane="schedule"]');
        assert.equal(await page.locator('[data-new-task-name]').isVisible(),false);
        assert.equal(await page.locator('[data-project-start-date]').isVisible(),false);
        const tools=pane.locator('.job-schedule-editor');
        await tools.nth(0).locator('summary').click();
        assert.equal(await page.locator('[data-project-start-date]').getAttribute('type'),'hidden');
        await tools.nth(0).locator('.job-date-trigger').first().click();
        const calendar=tools.nth(0).locator('.job-date-calendar').first();
        await page.screenshot({path:`docs/project-schedule-brand/calendar-${theme}-${size.width}x${size.height}.png`});
        await calendar.locator('[data-calendar-date]').nth(10).click();
        const chosen=await page.locator('[data-project-start-date]').inputValue();
        assert.match(chosen,/^\d{4}-\d{2}-11$/);
        await tools.nth(0).locator('summary').click();

        await tools.nth(1).locator('summary').click();await page.locator('[data-new-task-name]').fill('Keep this draft');
        const picker=tools.nth(1).locator('.job-assignment-picker');
        await picker.locator('[data-assignment-mode="crew"]').click();
        assert.equal(await picker.locator('[data-new-task-members]').isVisible(),false);
        await picker.locator('[data-assignment-mode="individual"]').click();
        assert.equal(await picker.locator('input[type="search"]').isVisible(),true);
        await picker.locator('.schedule-chip').first().click();
        assert.match(await picker.locator('.job-assignment-status').innerText(),/1 selected/);
        const listRow=picker.locator('.schedule-chip').first();
        const listWidth=await listRow.evaluate(el=>({row:el.getBoundingClientRect().width,list:el.parentElement.clientWidth,height:el.getBoundingClientRect().height}));
        assert.ok(Math.abs(listWidth.row-listWidth.list)<3&&listWidth.height>=48,'members use full-width tappable rows');
        await picker.locator('input[type="search"]').fill('no-match-xyz');
        assert.equal(await picker.locator('.job-member-empty').isVisible(),true);
        await picker.locator('input[type="search"]').fill('');
        assert.equal(await listRow.getAttribute('aria-pressed'),'true','search retains selection');
        const selected=await picker.locator('.schedule-chip.is-on').first().evaluate(el=>({bg:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color}));assert.deepEqual(selected,{bg:'rgb(255, 102, 0)',color:'rgb(0, 0, 0)'});
        await page.screenshot({path:`docs/project-schedule-brand/people-${theme}-${size.width}x${size.height}.png`});

        await page.locator('[data-schedule-view="timeline"]').click();
        assert.equal(await page.locator('[data-schedule-gantt]').isVisible(),true);
        assert.equal(await page.locator('[data-schedule-view="timeline"]').getAttribute('aria-selected'),'true');
        const style=await page.locator('[data-schedule-view="timeline"]').evaluate(el=>({bg:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color}));
        assert.deepEqual(style,{bg:'rgb(255, 102, 0)',color:'rgb(0, 0, 0)'});
        const layout=await pane.evaluate(el=>{const body=document.querySelector('#project-detail-content'),r=el.querySelector('#project-schedule-view-panel').getBoundingClientRect();return{overflow:body.scrollWidth>body.clientWidth+1,top:r.top,bottom:body.getBoundingClientRect().bottom};});
        assert.equal(layout.overflow,false);assert.ok(layout.top<layout.bottom-30,'schedule view is visible: '+JSON.stringify(layout));
        if(!shortSchedule)assert.ok(await pane.locator('.gantt-days .gantt-day').count()>62,'full schedule is shown');
        assert.equal(await pane.locator('.gantt-row-track .gantt-day').count(),0,'dates appear only in the header');
        const chart=pane.locator('[data-schedule-gantt]');
        assert.ok(await chart.evaluate(el=>parseFloat(el.style.getPropertyValue('--timeline-track-width'))>0),'timeline uses an explicit compatible pixel width');
        assert.ok(await pane.locator('.gantt-days').evaluate(el=>el.getBoundingClientRect().width>300),'date header has width');
        const before=await chart.evaluate(el=>({label:el.querySelector('.gantt-row-label').getBoundingClientRect().left,width:el.scrollWidth}));
        await pane.locator('[data-timeline-zoom="in"]').click();
        assert.equal(await chart.evaluate(el=>el.style.getPropertyValue('--timeline-day-width')),'80px','zoom increases day width');
        await pane.locator('[data-timeline-scroll="1"]').click();
        if(await chart.evaluate(el=>el.scrollWidth>el.clientWidth))await page.waitForFunction(()=>document.querySelector('[data-schedule-gantt]').scrollLeft>0);
        const after=await chart.evaluate(el=>({label:el.querySelector('.gantt-row-label').getBoundingClientRect().left,scroll:el.scrollLeft}));
        assert.ok(Math.abs(after.label-before.label)<2,'task labels remain pinned');
        await chart.evaluate(el=>el.scrollLeft=0);
        await page.screenshot({path:`docs/project-schedule-brand/timeline-${theme}-${size.width}x${size.height}.png`});
        await tools.nth(1).locator('summary').click();assert.equal(await page.locator('[data-new-task-name]').inputValue(),'Keep this draft');
        await tools.nth(1).locator('summary').click();
        await page.locator('[data-schedule-view="table"]').click();assert.equal(await page.locator('.project-schedule-table').isVisible(),true);
        if(size.width===390){const card=await pane.locator('[data-schedule-task-row]').first().evaluate(el=>({display:getComputedStyle(el).display,width:el.getBoundingClientRect().width,cell:el.children[3].getBoundingClientRect().width}));assert.equal(card.display,'block');assert.ok(card.cell>250,'date text has a readable card width');}

        await page.screenshot({path:`docs/project-schedule-brand/table-${theme}-${size.width}x${size.height}.png`});
      }
    }
    await page.setViewportSize({width:390,height:844});
    await page.locator('.job-schedule-editor').nth(0).locator('summary').click();
    const chosenDate=await page.locator('[data-project-start-date]').inputValue();
    const dateSaved=page.waitForResponse(r=>r.url().endsWith(`/api/projects/${pid}`)&&r.request().method()==='PATCH');
    await page.locator('[data-save-project-dates]').click();assert.equal((await dateSaved).ok(),true);
    await page.waitForFunction(value=>projects[0].startDate===value,chosenDate);
    await page.locator('.job-schedule-editor').nth(1).locator('summary').click();
    await page.locator('[data-new-task-name]').fill('Backfill');
    const saved=page.waitForResponse(r=>r.url().endsWith('/tasks')&&r.request().method()==='POST');
    await page.locator('[data-add-task]').click();assert.equal((await saved).ok(),true);
    await page.locator('.project-schedule-table').getByText('Backfill',{exact:true}).waitFor();
    assert.deepEqual(errors,[]);
    console.log('Schedule brand browser passed: immediate table/timeline, preserved drafts, real task save, brand toggle, contained scrolling, phone/desktop themes.');
  }finally{if(browser)await browser.close();if(child)child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});

