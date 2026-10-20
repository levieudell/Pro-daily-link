'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn}=require('node:child_process');

const chrome=process.env.PDL_TEST_CHROME||(process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':'/usr/bin/google-chrome-stable');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-schedule-workflow-'));
const dbFile=path.join(root,'db.json');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function waitForBoot(page){
  await page.waitForFunction(()=>typeof currentUser!=='undefined'&&currentUser?.id&&typeof assignments!=='undefined'&&document.documentElement.classList.contains('workspace-ready'));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}

function contrast(rgb1,rgb2){
  const channel=value=>{value/=255;return value<=.03928?value/12.92:Math.pow((value+.055)/1.055,2.4)};
  const parse=value=>(String(value).match(/[\d.]+/g)||[]).slice(0,3).map(Number);
  const luminance=value=>{const [r=0,g=0,b=0]=parse(value).map(channel);return .2126*r+.7152*g+.0722*b};
  const a=luminance(rgb1),b=luminance(rgb2);return(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
}

(async()=>{
  const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value))})});
  const env={...process.env,PORT:String(port),PDL_STAGING:'1',PDL_STAGING_OWNER_PASSWORD:'synthetic-owner-pass',PDL_STAGING_FIELD_PASSWORD:'synthetic-field-pass',PDL_DB_FILE:dbFile,PDL_PLATFORM_FILE:path.join(root,'platform.json'),PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',PDL_EMAIL_DEV_MODE:'1',OPENAI_API_KEY:''};
  for(const key of ['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','RESEND_API_KEY','INDEXNOW_KEY','SENTRY_DSN'])delete env[key];
  const child=spawn(process.execPath,['--require',require.resolve('./scripts/test-analytics-isolation.cjs'),'server.js'],{cwd:__dirname,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let log='',browser;child.stdout.on('data',chunk=>log+=chunk);child.stderr.on('data',chunk=>log+=chunk);
  try{
    for(let attempt=0;attempt<200&&!log.includes('running at');attempt++)await sleep(100);
    assert.ok(log.includes('running at'),'synthetic schedule server started: '+log);
    const seed=JSON.parse(fs.readFileSync(dbFile));
    browser=await require('puppeteer-core').launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
    const page=await browser.newPage(),pageErrors=[],dialogMessages=[];let dialogDecision='accept';page.on('pageerror',error=>pageErrors.push(error.message));page.on('dialog',dialog=>{dialogMessages.push(dialog.message());return dialogDecision==='dismiss'?dialog.dismiss():dialog.accept()});
    await page.setViewport({width:1280,height:900});
    await page.evaluateOnNewDocument(()=>localStorage.setItem('pdl-analytics-consent','declined'));
    await page.goto(`http://127.0.0.1:${port}/login.html`);
    await page.type('#email',seed.users.find(user=>user.role==='owner').email);
    await page.type('#password','synthetic-owner-pass');
    await page.click('form#login button.primary');
    await waitForBoot(page);
    await page.evaluate(()=>showPage('schedule'));
    await page.waitForSelector('#schedule-page.active');

    const initial=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth-innerWidth,command:!!document.querySelector('.schedule-command-bar'),filtersHidden:document.querySelector('#schedule-filters').hidden}));
    assert.ok(initial.overflow<=1,'desktop schedule has no horizontal overflow');
    assert.equal(initial.command,true,'schedule has one compact command bar');
    assert.equal(initial.filtersHidden,true,'secondary filters start collapsed');

    await page.click('#schedule-next-week');
    const viewedDate=await page.evaluate(()=>scheduleAnchorDate);
    await page.click('#new-assignment');
    await page.waitForSelector('#assignment-modal[open]');
    const defaults=await page.evaluate(()=>({target:document.querySelector('#assignment-target').value,project:document.querySelector('#assignment-project').value,date:document.querySelector('#assignment-date').value,rangeHidden:document.querySelector('#assignment-range-fields').hidden}));
    assert.equal(defaults.target,'','assignment never silently chooses people');
    assert.equal(defaults.project,'','assignment never silently chooses a project');
    assert.equal(defaults.date,viewedDate,'global Add assignment uses the date currently in view');
    assert.equal(defaults.rangeHidden,true,'multi-day controls stay out of the way by default');

    await page.$eval('#assignment-activity',element=>{element.value='Unsaved field direction';element.dispatchEvent(new Event('input',{bubbles:true}))});
    dialogDecision='dismiss';
    await page.click('#assignment-modal .assignment-save-actions .secondary');
    assert.equal(await page.$eval('#assignment-modal',element=>element.open),true,'Cancel cannot silently discard a changed composer');
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('#assignment-modal',element=>element.open),true,'Escape cannot silently discard a changed composer');
    await page.click('#assignment-modal .close-button');
    assert.equal(await page.$eval('#assignment-modal',element=>element.open),true,'the close control cannot silently discard a changed composer');
    dialogDecision='accept';
    await page.$eval('#assignment-modal',element=>element.dispatchEvent(new MouseEvent('click',{bubbles:true})));
    await page.waitForFunction(()=>!document.querySelector('#assignment-modal').open);
    assert.ok(dialogMessages.filter(message=>/Discard your unsaved assignment changes/i.test(message)).length>=4,'Cancel, Escape, close, and backdrop all explain that assignment changes will be discarded');

    await page.click('#new-assignment');
    await page.waitForSelector('#assignment-modal[open]');

    await page.select('#assignment-target','member:1');
    await page.select('#assignment-project','1');
    await page.$eval('#assignment-activity',element=>{element.value='E2E layout and excavation';element.dispatchEvent(new Event('input',{bubbles:true}))});
    await page.$eval('#assignment-start',element=>{element.value='15:00';element.dispatchEvent(new Event('change',{bubbles:true}))});
    await page.$eval('#assignment-end',element=>{element.value='14:00';element.dispatchEvent(new Event('change',{bubbles:true}))});
    await page.click('#save-assignment');
    await page.waitForFunction(()=>document.querySelector('#assignment-warning').classList.contains('visible'));
    assert.match(await page.$eval('#assignment-warning',element=>element.textContent),/after start time/i,'bad shifts explain the exact problem');
    assert.equal(await page.evaluate(()=>document.activeElement?.id),'assignment-end','invalid field receives focus');
    assert.equal(await page.$eval('#assignment-modal',element=>element.open),true,'validation keeps the editor open');

    await page.$eval('#assignment-end',element=>{element.value='16:30';element.dispatchEvent(new Event('change',{bubbles:true}))});
    assert.match(await page.$eval('#assignment-preview',element=>element.textContent),/Ready to schedule/i,'preview confirms who, where, and when before save');
    const before=await page.evaluate(()=>assignments.length);
    await page.click('#save-assignment');
    await page.waitForFunction(count=>!document.querySelector('#assignment-modal').open&&assignments.length===count+1,{},before);
    const createdId=await page.evaluate(()=>Math.max(...assignments.map(row=>Number(row.id))));
    await page.waitForSelector(`[data-assignment="${createdId}"]`);

    const eventId=await page.evaluate(async assignmentId=>{const assignment=assignments.find(row=>Number(row.id)===Number(assignmentId)),created=await api(`/api/projects/${assignment.projectId}/events`,{method:'POST',body:JSON.stringify({date:assignment.date,type:'delivery',title:'E2E rebar delivery',notes:'Stage beside the east gate'})});projectEvents.push(created);renderSchedule();return Number(created.id)},createdId);
    await page.click(`.schedule-event[data-event="${eventId}"]`);
    await page.waitForSelector('#event-detail-modal[open]');
    assert.match(await page.$eval('#event-detail-content',element=>element.textContent),/E2E rebar delivery|Stage beside the east gate|Delivery/i,'event chips open useful project, date, type, and crew-note details');
    assert.equal(await page.evaluate(id=>projectEvents.some(event=>Number(event.id)===id),eventId),true,'viewing an event never deletes it');
    await page.click('#remove-project-event');
    await page.waitForFunction(id=>!document.querySelector('#event-detail-modal').open&&!projectEvents.some(event=>Number(event.id)===id),{},eventId);

    await page.click(`[data-assignment="${createdId}"]`);
    await page.waitForSelector('#assignment-detail-modal[open]');
    assert.match(await page.$eval('#scheduled-work-detail',element=>element.textContent),/Field acknowledgement/i,'details show the full acknowledgement roster');
    await page.click('#edit-assignment');
    await page.waitForSelector('#assignment-modal[open]');
    await page.$eval('#assignment-activity',element=>{element.value='E2E updated assignment';element.dispatchEvent(new Event('input',{bubbles:true}))});
    await page.click('#save-assignment');
    await page.waitForFunction(id=>!document.querySelector('#assignment-modal').open&&assignments.find(row=>Number(row.id)===id)?.activity==='E2E updated assignment',{},createdId);

    const rosterId=await page.evaluate(async()=>{
      const response=await api('/api/assignments',{method:'POST',body:JSON.stringify({projectId:1,memberIds:[1,2],crew:'Preserved crew',date:'2099-12-15',start:'06:00',end:'07:00',activity:'Roster preservation check'})});
      const assignment=(response.assignments||[response])[0];assignments.push(assignment);
      const changedMember=team.find(member=>Number(member.id)===2);if(changedMember)changedMember.crew='Changed after assignment';
      openAssignment({assignment});return Number(assignment.id);
    });
    await page.waitForSelector('#assignment-modal[open]');
    assert.equal(await page.$eval('#assignment-target',element=>element.value),'members:1,2','editing preserves the exact stored roster after crew membership changes');
    await page.$eval('#assignment-activity',element=>{element.value='Roster preserved after edit';element.dispatchEvent(new Event('input',{bubbles:true}))});
    await page.click('#save-assignment');
    await page.waitForFunction(id=>!document.querySelector('#assignment-modal').open&&assignments.find(row=>Number(row.id)===id)?.activity==='Roster preserved after edit',{},rosterId);

    await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
    await page.evaluate(()=>document.querySelector('[data-schedule-view="month"]').click());
    await page.waitForFunction(()=>document.querySelector('[data-schedule-view="month"]').classList.contains('active'));
    const mobile=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth-innerWidth,agendaDays:document.querySelectorAll('.schedule-mobile-agenda .schedule-agenda-day').length,meaningfulDays:new Set(assignments.map(row=>row.date).concat([companyTodayIso()])).size,summary:document.querySelector('.schedule-mobile-month')?.textContent||''}));
    assert.ok(mobile.overflow<=1,'phone month schedule has no horizontal overflow');
    assert.ok(mobile.agendaDays<=mobile.meaningfulDays,'phone month omits empty calendar days');
    assert.match(mobile.summary,/Only days with work, time off, or today are shown/i,'phone explains its compact month view');

    await page.evaluate(()=>{currentUser.preferences={...(currentUser.preferences||{}),theme:'dark'};applyProfile();document.querySelector('#new-assignment').click()});
    await page.waitForSelector('#assignment-modal[open]');
    const colors=await page.evaluate(()=>{const nodes=['.schedule-command-bar','.assignment-step','#assignment-preview'].map(selector=>document.querySelector(selector));return nodes.map(element=>{const style=getComputedStyle(element);return{color:style.color,background:style.backgroundColor}})});
    for(const pair of colors)assert.ok(contrast(pair.color,pair.background)>=4.5,`dark schedule surface remains readable: ${JSON.stringify(pair)}`);
    assert.deepEqual(pageErrors,[],'schedule workflow has no browser runtime errors');

    const persisted=JSON.parse(fs.readFileSync(dbFile)).assignments.find(row=>Number(row.id)===createdId);
    assert.equal(persisted.activity,'E2E updated assignment','assignment edits persist through the server');
    const rosterPersisted=JSON.parse(fs.readFileSync(dbFile)).assignments.find(row=>Number(row.id)===rosterId);
    assert.deepEqual(rosterPersisted.memberIds,[1,2],'editing non-roster fields cannot silently change assigned people');
    console.log('Schedule E2E passed: desktop and phone layout, safe defaults, exact validation, roster-safe editing, create/edit persistence, compact month, and dark-mode contrast.');
  }finally{
    await browser?.close();child.kill();await new Promise(resolve=>child.exitCode!=null?resolve():child.once('exit',resolve));fs.rmSync(root,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1});
