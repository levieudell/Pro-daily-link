'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-help-ui-'));
Object.assign(process.env,{PDL_DB_FILE:path.join(temp,'db.json'),PDL_PLATFORM_FILE:path.join(temp,'platform.json'),PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',PDL_REQUIRE_AUTH:'1',PDL_EMAIL_DEV_MODE:'1',PDL_FOUNDER_ENABLED:'0',PDL_HELP_DRAFT:'1'});
for(const key of ['RESEND_API_KEY','OPENAI_API_KEY','STRIPE_SECRET_KEY','SENTRY_DSN'])delete process.env[key];
fs.copyFileSync('data/db.json',process.env.PDL_DB_FILE);fs.copyFileSync('data/platform.json',process.env.PDL_PLATFORM_FILE);
const {server}=require('../server');
(async()=>{let browser;await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;try{
  browser=await chromium.launch({headless:true,...(process.env.PDL_QA_BROWSER?{executablePath:process.env.PDL_QA_BROWSER}:{})});fs.mkdirSync('docs/help-qa',{recursive:true});
  for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]){
    const context=await browser.newContext({viewport});
    const signup=await context.request.post(base+'/api/signup',{data:{companyName:'Synthetic QA',ownerName:'QA Owner',email:name+'@example.invalid',password:'Synthetic!42Password',legalAccepted:true}});assert.equal(signup.status(),201);
    const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/app');await page.locator('#help-button').click();await page.getByText('Start with one project',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Save help preferences'}).waitFor();
    assert.equal(await page.locator('#help-guidance').getByRole('button',{name:'Save help preferences'}).count(),1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.locator('#help-modal').screenshot({path:'docs/help-qa/'+name+'.png'});
    await page.getByLabel('Email setup tips (draft; delivery disabled)').check();await page.getByRole('button',{name:'Save help preferences'}).click();await page.getByText('Review draft email copy',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Dismiss this tip'}).click();await page.getByText('Start with one project',{exact:true}).waitFor({state:'hidden'});
    await page.locator('#help-modal .close-button').click();await page.locator('#help-button').click();await page.getByRole('button',{name:'Save help preferences'}).waitFor();assert.equal(await page.getByText('Start with one project',{exact:true}).count(),0);
    assert.deepEqual(errors,[]);await context.close();
  }
  fs.writeFileSync('docs/help-qa/result.json',JSON.stringify({baseCommit:'bdbdfe9a8b038d3dbc32327c58f5a529dbe71225',viewports:['1440x1000','390x844'],assertions:['real synthetic cookie signup','help opens','no horizontal page overflow','single preferences form','email opt-in previews disabled copy','dismiss survives reopen','no page exceptions'],providerCalls:0},null,2));
  console.log('Synthetic desktop/mobile help QA passed');
}finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true})}})().catch(e=>{console.error(e);process.exitCode=1;server.closeAllConnections();server.close()});
