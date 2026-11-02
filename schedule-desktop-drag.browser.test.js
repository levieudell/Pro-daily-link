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
    page.setDefaultTimeout(15000);
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>route.request().url().startsWith(new URL(url).origin)?route.continue():route.abort());
    await page.goto(url);await page.locator('#email').fill('pm@example.invalid');await page.locator('#password').fill(password);
    await page.locator('#login button[type=submit]').click();await page.waitForURL('**/app?**');
    await page.waitForFunction(()=>window.pdlWorkspaceStateReady&&projects.length>1);


    await page.setViewportSize({width:1280,height:800});
    const taskId=await page.evaluate(async()=>{const project=projects[0];const date=companyTodayIso();await api(`/api/projects/${project.id}`,{method:'PATCH',body:JSON.stringify({startDate:date})});const task=await api(`/api/projects/${project.id}/tasks`,{method:'POST',body:JSON.stringify({name:'Drag test excavation',durationDays:3,predecessorIds:[],memberIds:[]})});scheduleAnchorDate=date;showPage('schedule');return task.tasks.find(t=>t.name==='Drag test excavation').id;});
    await page.waitForTimeout(1000);await page.reload();await page.waitForFunction(()=>window.pdlWorkspaceStateReady);await page.evaluate(()=>{scheduleView='week';scheduleAnchorDate=companyTodayIso();showPage('schedule');});
    const chip=page.locator(`[data-schedule-task="${taskId}"]`);
    await chip.waitFor();
    const sidebar=page.locator('.schedule-unassigned');
    const placement=await sidebar.evaluate(el=>({left:el.getBoundingClientRect().left,boardRight:document.querySelector('#schedule-board').getBoundingClientRect().right}));
    assert.ok(placement.left>=placement.boardRight,'unassigned work sits to the right');
    await sidebar.locator(':scope > summary').click();
    assert.equal(await chip.isVisible(),false,'collapse hides the task list');
    await page.evaluate(()=>renderSchedule());
    assert.equal(await sidebar.getAttribute('open'),null,'collapse survives board refresh');
    await sidebar.locator(':scope > summary').click();
    await chip.waitFor();
    fs.mkdirSync('docs/schedule-sidebar',{recursive:true});
    for(const theme of ['light','dark']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.screenshot({path:`docs/schedule-sidebar/${theme}-1280.png`});}
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>setNavigationOpen(false));await page.waitForTimeout(300);
    fs.mkdirSync('docs/compact-unassigned',{recursive:true});
    for(const theme of ['light','dark']){
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      const toggle=chip.locator('.schedule-task-expand'),select=chip.locator('[data-task-assign-target]');
      assert.equal(await select.isVisible(),false,'phone controls start tucked away');
      assert.ok(await chip.evaluate(el=>el.getBoundingClientRect().height)<=210,'phone task card is compact');
      await chip.scrollIntoViewIfNeeded();await page.screenshot({path:`docs/compact-unassigned/${theme}-390.png`});
      await toggle.click();assert.equal(await select.isVisible(),true);
      const value=await select.locator('option').nth(1).getAttribute('value');await select.selectOption(value);
      await toggle.click();assert.equal(await select.isVisible(),false);await toggle.click();assert.equal(await select.inputValue(),value,'collapse preserves selected person or crew');
      await select.selectOption('');await toggle.click();
    }
    await page.setViewportSize({width:1280,height:800});
    await page.evaluate(()=>window.scrollTo(0,0));await page.waitForTimeout(300);
    assert.equal(await chip.locator('[data-task-assign-target]').isVisible(),false,'desktop cards stay compact');
    await chip.locator('.schedule-task-chip-main').click();assert.equal(await chip.locator('[data-task-assign-target]').isVisible(),true,'one tap opens assignment');
    await chip.locator('[data-mode=member]').click();assert.ok((await chip.locator('select option').allTextContents()).some(text=>text.includes('Choose a team member')));
    await page.evaluate(()=>renderSchedule());assert.equal(await chip.locator('[data-mode=member]').getAttribute('aria-pressed'),'true','refresh preserves assignment mode');
    await chip.locator('.schedule-task-expand').click();
    await page.evaluate(()=>window.scrollTo(0,0));await page.waitForTimeout(500);
    const crew=page.locator('[data-schedule-crew-drop]').first();
    assert.equal(await crew.evaluate(el=>typeof el.ondragover),'function','new crew rows have drop handlers');
    const assigned=page.waitForResponse(r=>r.url().includes(`/project-tasks/${taskId}/assign`)&&r.request().method()==='POST');
    await chip.dragTo(crew,{sourcePosition:{x:20,y:20}});
    assert.ok((await assigned).ok(),'dropping on crew persists task assignment');
    
    await page.waitForFunction(()=>assignments.some(a=>a.activity==='Drag test excavation'));
    await sidebar.locator(':scope > summary').click();
    const source=page.locator('.schedule-grid [data-assignment]').filter({hasText:'Drag test excavation'}).first();
    const id=await source.getAttribute('data-assignment'),member=await source.getAttribute('data-member');
    const oldDate=await source.evaluate(el=>el.closest('[data-schedule-date]').dataset.scheduleDate);
    const target=page.locator(`.schedule-grid [data-schedule-member="${member}"]:not([data-schedule-date="${oldDate}"])`).nth(2);
    const newDate=await target.getAttribute('data-schedule-date');
    const moved=page.waitForResponse(r=>r.url().endsWith(`/api/assignments/${id}`)&&r.request().method()==='PATCH');
    await source.dragTo(target);assert.ok((await moved).ok(),'moving assignment persists');
    await page.waitForFunction(({date,member})=>assignments.some(a=>a.date===date&&a.memberIds.includes(Number(member))&&a.activity==='Drag test excavation'),{date:newDate,member});
    await page.locator('#schedule-move-feedback button').filter({hasText:'Undo'}).click();
    await page.waitForFunction(({date,member})=>assignments.some(a=>a.date===date&&a.memberIds.includes(Number(member))&&a.activity==='Drag test excavation'),{date:oldDate,member});
    assert.match(await page.locator('#schedule-move-feedback').textContent(),/Move undone/);
    const staleStatus=await page.evaluate(async(id)=>{const response=await fetch(`/api/assignments/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedUpdatedAt:'stale'})});return response.status;},id);
    assert.equal(staleStatus,409,'stale undo cannot overwrite a later edit');
    await page.locator('#schedule-today').click();assert.equal(await page.evaluate(()=>scheduleAnchorDate),await page.evaluate(()=>companyTodayIso()));
    const empty=page.locator('.schedule-grid .schedule-drop-zone').filter({has:page.locator('.schedule-empty')}).first();const emptyDate=await empty.getAttribute('data-schedule-date');await empty.click();assert.equal(await page.locator('#assignment-date').inputValue(),emptyDate);await page.locator('#assignment-modal .close-button').click();
    fs.mkdirSync('docs/schedule-board-brand',{recursive:true});
    for(const theme of ['light','dark']){
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      const colors=await page.locator('#new-assignment').evaluate(el=>({bg:getComputedStyle(el).backgroundColor,text:getComputedStyle(el).color}));
      assert.deepEqual(colors,{bg:'rgb(255, 102, 0)',text:'rgb(0, 0, 0)'});
      await page.waitForTimeout(250);
      const boardColors=await page.locator('.schedule-grid .schedule-drop-zone').first().evaluate(el=>({bg:getComputedStyle(el).backgroundColor,text:getComputedStyle(el).color}));
      assert.deepEqual(boardColors,theme==='dark'?{bg:'rgb(0, 0, 0)',text:'rgb(255, 255, 255)'}:{bg:'rgb(255, 255, 255)',text:'rgb(0, 0, 0)'});
      await page.evaluate(()=>window.scrollTo(0,0));
      await page.screenshot({path:`docs/schedule-board-brand/${theme}-1280.png`});
    }
    await page.setViewportSize({width:390,height:844});
    for(const theme of ['light','dark']){
      await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;window.scrollTo(0,0);},theme);
      const mobile=await sidebar.evaluate(el=>({width:document.documentElement.scrollWidth,viewport:innerWidth,top:el.getBoundingClientRect().top,boardTop:document.querySelector('#schedule-board').getBoundingClientRect().top}));
      assert.ok(mobile.width<=mobile.viewport+1,'phone has no sideways overflow');assert.ok(mobile.top<mobile.boardTop,'phone unassigned section precedes the schedule');
      await page.screenshot({path:`docs/schedule-sidebar/${theme}-390.png`});
    }
    assert.deepEqual(errors,[]);console.log('Schedule desktop drag and brand: passed');
  }finally{if(browser)await browser.close();if(child)child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
