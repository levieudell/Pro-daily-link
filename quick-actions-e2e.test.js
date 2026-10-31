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
   for(const theme of ['light','dark']){
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await page.locator('#project-assistant-launcher').click();
    await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});
    const menu=page.locator('#project-quick-actions');assert(await menu.isVisible());
    const clock=menu.getByRole('button',{name:'Clock in',exact:true});assert(await clock.isVisible());
    const styles=await clock.evaluate(el=>{const s=getComputedStyle(el);return {bg:s.backgroundColor,color:s.color,height:el.getBoundingClientRect().height};});
    assert.equal(styles.bg,'rgb(255, 102, 0)');assert.equal(styles.color,'rgb(0, 0, 0)');assert(styles.height>=48);
    await clock.click();assert(await page.locator('#start-day-modal').isVisible(),'existing clock-in dialog opens for '+email);
    assert.equal(await menu.isVisible(),false);await page.evaluate(()=>document.querySelector('#start-day-modal').close());
   }
   await context.close();
  }
  console.log('Quick actions: plus and existing clock-in flow available to owner, office, field and foreman in both themes.');
 }finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1});
