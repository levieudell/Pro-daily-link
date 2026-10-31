'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const seed = require('./staging-seed');
const calendar = require('./payroll-ranges');
const paySchedule = require('./pay-schedule');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-quick-actions-'));
const dbFile = path.join(root, 'db.json');
const password = 'local-payroll-test-only';
seed.ensureStagingDatabase(dbFile, { PDL_STAGING_OWNER_PASSWORD: password, PDL_STAGING_FIELD_PASSWORD: password });
seed.ensureStagingOfficeUser(dbFile, { PDL_STAGING: '1', PDL_STAGING_OFFICE_PASSWORD: password });
const db = JSON.parse(fs.readFileSync(dbFile));
const foremanEmail = 'payroll-test-foreman@example.test';
db.users.push({...db.users.find(user=>user.email===seed.FIELD_EMAIL),id:Math.max(...db.users.map(user=>user.id))+1,email:foremanEmail,role:'foreman'});

for(const user of db.users)if(!user.memberId)user.memberId=db.team[0].id;
fs.writeFileSync(dbFile,JSON.stringify(db));
fs.writeFileSync(path.join(root,'platform.json'),JSON.stringify({users:[],sessions:[]}));
Object.assign(process.env,{PDL_DB_FILE:dbFile,PDL_PLATFORM_FILE:path.join(root,'platform.json'),PDL_REQUIRE_AUTH:'1',PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',PDL_PLATFORM_TRANSACTIONAL_DB:'off',PDL_EMAIL_DEV_MODE:'1',PDL_STAGING:'0',NODE_ENV:'test'});
for(const key of ['SENTRY_DSN','RESEND_API_KEY','OPENAI_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','DATABASE_URL','INDEXNOW_KEY'])delete process.env[key];
require('./database/supabase').loadLocalEnv=()=>{};
const {server}=require('./server');
(async()=>{
 let browser;
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 try{
  browser=await chromium.launch({executablePath:process.env.PDL_TEST_CHROME||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/google-chrome-stable'),headless:true,args:['--no-sandbox']});
  for(const email of [seed.OWNER_EMAIL,seed.OFFICE_EMAIL||'office-demo@prodailylink.com',seed.FIELD_EMAIL,foremanEmail]){
   const context=await browser.newContext({viewport:{width:390,height:667}}),page=await context.newPage();page.setDefaultTimeout(10000);console.log('Checking '+email);page.on('pageerror',e=>console.error('Browser:',e.message));
   await page.addInitScript(()=>localStorage.setItem('pdl-analytics-consent','declined'));
   await page.goto(base+'/login.html');await page.locator('#email').fill(email);await page.locator('#password').fill(password);await page.locator('form#login button.primary').click();
   await page.waitForFunction(()=>typeof currentUser!=='undefined' && currentUser?.id, null, {timeout:15000});
   await page.locator('#project-assistant-launcher').waitFor({state:'visible',timeout:15000});
   for(const theme of ['light','dark'])for(const viewport of [{width:390,height:500},{width:390,height:844},{width:1280,height:800}]){
    await page.setViewportSize(viewport);
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await page.locator('#project-assistant-launcher').click();
    await page.waitForTimeout(300);
    const menu=page.locator('#project-quick-actions');assert(await menu.isVisible());
    assert.equal(await menu.getByRole('button',{name:'Assistant',exact:true}).isVisible(),false);
    const clock=menu.getByRole('button',{name:'Clock in',exact:true});assert(await clock.isVisible());
    await page.waitForFunction(()=>document.querySelector('#project-quick-actions button').getBoundingClientRect().height>=48,null,{timeout:5000});
    const styles=await clock.evaluate(el=>{const s=getComputedStyle(el);return {bg:s.backgroundColor,color:s.color,height:el.getBoundingClientRect().height};});
    assert.equal(styles.bg,'rgb(255, 102, 0)');assert.equal(styles.color,'rgb(0, 0, 0)');assert(styles.height>=48);
    await clock.click();await page.locator('#start-day-modal').waitFor({state:'visible'});assert(await page.locator('#start-day-modal').isVisible(),'existing clock-in dialog opens for '+email);
    assert.equal(await menu.isVisible(),false);
    assert.equal(await page.locator('#start-day-note').isVisible(),false,'note stays tucked away');
    assert.equal(await page.locator('#start-day-photos').isVisible(),false,'native file input stays tucked away');
    assert.equal(await page.locator('#start-day-modal .labor-fieldset').isVisible(),false);
    assert.equal(await page.locator('#start-day-modal .modal-actions .secondary').isVisible(),false);
    await page.locator('#start-day-modal').getByRole('button',{name:'Add note',exact:true}).click();assert(await page.locator('#start-day-note').isVisible());
    assert.equal(await page.locator('#start-day-project').inputValue(),'','personal shortcut starts with no job');
    assert.equal(await page.locator('#start-day-members input').count(),0,'no crew selectors');
    let submitted;
    await page.route('**/api/workdays/start',async route=>{submitted=route.request().postDataJSON();await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Synthetic no-write confirmation'})});});
    await page.locator('#confirm-start-day').click();assert.equal(submitted,undefined,'must choose a job explicitly');
    const job=await page.locator('#start-day-project option').evaluateAll(options=>options.find(o=>o.value)?.value);assert(job);
    await page.locator('#start-day-project').selectOption(job);
    // Inject another checked member to prove submission does not trust crew DOM in personal mode.
    await page.evaluate(()=>{const el=document.createElement('input');el.type='checkbox';el.checked=true;el.value='999';document.querySelector('#start-day-members').append(el);});
    await page.locator('#confirm-start-day').click();await page.waitForFunction(()=>document.querySelector('#start-day-message').textContent==='Synthetic no-write confirmation',null,{timeout:5000}).catch(async error=>{throw new Error(await page.locator('#start-day-message').textContent());});
    assert.deepEqual(submitted.memberIds,[db.users.find(u=>u.email===email).memberId]);
    await page.unroute('**/api/workdays/start');
    const brand=await page.locator('#start-day-modal').evaluate(el=>{const h=getComputedStyle(el.querySelector('.modal-header')),b=el.querySelector('#confirm-start-day'),r=b.getBoundingClientRect(),s=getComputedStyle(b);return {header:h.backgroundColor,rule:h.borderBottomColor,button:s.backgroundColor,text:s.color,bottom:r.bottom,height:innerHeight,overflow:el.scrollWidth-el.clientWidth};});
    assert.equal(brand.header,'rgb(0, 0, 0)');assert.equal(brand.rule,'rgb(255, 102, 0)');assert.equal(brand.button,'rgb(255, 102, 0)');assert.equal(brand.text,'rgb(0, 0, 0)');assert(brand.bottom<=brand.height && brand.overflow<=1,JSON.stringify(brand));
    await page.evaluate(()=>document.querySelector('#start-day-modal').close());
   }
   await page.evaluate(()=>{workdays.push({id:987654,projectId:projects[0].id,memberIds:[Number(currentUser.memberId)],status:'active',startedAt:new Date(Date.now()-65000).toISOString()});});
   let ends=0;await page.route('**/api/workdays/987654/end',async route=>{ends++;await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Synthetic clock-out refusal'})});});
   await page.locator('#project-assistant-launcher').click();await page.locator('#project-quick-actions').getByRole('button',{name:'Clock out',exact:true}).click();
   await page.locator('#personal-clock-modal').waitFor({state:'visible'});assert(await page.locator('#personal-clock-modal').isVisible());assert.equal(ends,0,'viewing running timer must not clock out');
   const elapsed=await page.locator('[data-clock-elapsed]').textContent();await page.waitForTimeout(1100);assert.notEqual(await page.locator('[data-clock-elapsed]').textContent(),elapsed,'timer ticks');
   assert(await page.locator('[data-clock-note]').isVisible());assert(await page.locator('[data-clock-photo]').isVisible());
   await Promise.all([page.waitForResponse(response=>response.url().endsWith('/api/workdays/987654/end')),page.locator('[data-clock-out]').click()]);assert.equal(ends,1,'explicit Clock out uses the existing end route once');
   await page.evaluate(()=>{workdays=workdays.filter(row=>row.id!==987654);});
   await page.locator('#project-assistant-launcher').click();await page.locator('#project-quick-actions button').first().click();await page.locator('#start-day-modal').waitFor({state:'visible'});
   await page.locator('[data-clock-mode="company"]').click();await page.waitForFunction(()=>document.querySelector('#personal-company-activity').options.length>1);
   assert.equal(await page.locator('#start-day-project').isVisible(),false);
   await page.locator('#confirm-start-day').click();assert.match(await page.locator('#start-day-message').textContent(),/Choose a company activity/);
   const activity=await page.locator('#personal-company-activity option').nth(1).getAttribute('value');await page.locator('#personal-company-activity').selectOption(activity);
   const [createdResponse]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/time-cards/company-clock')&&r.request().method()==='POST'),page.locator('#confirm-start-day').click()]);
   assert.equal(createdResponse.status(),201,await createdResponse.text());const card=await createdResponse.json();assert.equal(card.projectId,null);assert.equal(card.memberId,db.users.find(u=>u.email===email).memberId);
   await page.locator('#personal-clock-modal').waitFor({state:'visible'});assert.equal(await page.locator('[data-clock-job]').textContent(),card.activityName);
   const duplicate=await page.request.post(base+'/api/time-cards/company-clock',{data:{activityCodeId:activity,memberId:999,projectId:1}});assert.equal(duplicate.status(),409);
   const own=await page.request.get(base+'/api/time-cards/company-clock');assert.equal((await own.json()).id,card.id);
   const [closedResponse]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/time-cards/'+card.id+'/clock-out')),page.locator('[data-clock-out]').click()]);assert.equal(closedResponse.status(),200);assert((await closedResponse.json()).outAt);
   await context.close();
  }
  console.log('Quick actions: plus and existing clock-in flow available to owner, office, field and foreman in both themes.');
 }finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1});
