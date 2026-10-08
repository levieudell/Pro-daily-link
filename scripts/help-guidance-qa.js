'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-help-ui-'));
Object.assign(process.env,{PDL_DB_FILE:path.join(temp,'db.json'),PDL_PLATFORM_FILE:path.join(temp,'platform.json'),PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',PDL_REQUIRE_AUTH:'1',PDL_EMAIL_DEV_MODE:'1',PDL_FOUNDER_ENABLED:'0',PDL_HELP_DRAFT:'1'});
for(const key of ['RESEND_API_KEY','OPENAI_API_KEY','STRIPE_SECRET_KEY','SENTRY_DSN'])delete process.env[key];
fs.copyFileSync('data/db.json',process.env.PDL_DB_FILE);fs.copyFileSync('data/platform.json',process.env.PDL_PLATFORM_FILE);
let mockedCalls=0;
require('../help-conversation').openAIHelp=async payload=>{mockedCalls++;const text=JSON.parse(payload.input).conversation.at(-1).content;return {answer:{answer:text==='And then?'?'Add estimate scope, quantity, unit and budget hours to track production.':'Open Customers to add a customer, then Projects to add the job.',sourceIds:['project-setup'],clarification:null,escalate:false},usage:{input_tokens:1000,output_tokens:100}}};
const {server}=require('../server');
(async()=>{let browser;await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;try{
  browser=await chromium.launch({headless:true,...(process.env.PDL_QA_BROWSER?{executablePath:process.env.PDL_QA_BROWSER}:{})});fs.mkdirSync('docs/help-qa',{recursive:true});
  for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]){
    const context=await browser.newContext({viewport});
    const signup=await context.request.post(base+'/api/signup',{data:{companyName:'Synthetic QA',ownerName:'QA Owner',email:name+'@example.invalid',password:'Synthetic!42Password',legalAccepted:true}});assert.equal(signup.status(),201);
    process.env.PDL_HELP_AI_APPROVED='synthetic-evaluation-v1';process.env.PDL_HELP_EVAL_COMPANY=(await signup.json()).company.id;
    const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/app');await page.locator('#help-button').click();await page.getByText('Start with one project',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Save help preferences'}).waitFor();
    assert.equal(await page.locator('#help-guidance').getByRole('button',{name:'Save help preferences'}).count(),1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.locator('#help-modal').screenshot({path:'docs/help-qa/'+name+'.png'});
    await page.getByLabel('Your product question').fill('I just signed up. What first?');await page.getByLabel('I agree to send this general question and conversation to OpenAI.').check();await page.getByRole('button',{name:'Ask Help',exact:true}).click();await page.getByText('Answer ready. Review it before taking any action.',{exact:true}).waitFor();
    await page.getByLabel('Your product question').fill('And then?');await page.getByRole('button',{name:'Ask Help',exact:true}).click();await page.getByText('PDL Help: Add estimate scope',{exact:false}).waitFor();
    assert.equal(await page.locator('#help-modal').evaluate(el=>el.scrollWidth<=el.clientWidth),true,'no internal modal horizontal overflow');
    await page.locator('#help-conversation-panel').evaluate(el=>el.scrollIntoView({block:'start'}));await page.screenshot({path:'docs/help-qa/'+name+'-conversation.png'});
    await page.getByLabel('Email setup tips (draft; delivery disabled)').check();await page.getByRole('button',{name:'Save help preferences'}).click();await page.getByText('Review draft email copy',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Dismiss this tip'}).click();await page.getByText('Start with one project',{exact:true}).waitFor({state:'hidden'});
    await page.locator('#help-modal .close-button').click();await page.locator('#help-button').click();await page.getByRole('button',{name:'Save help preferences'}).waitFor();assert.equal(await page.getByText('Start with one project',{exact:true}).count(),0);
    assert.deepEqual(errors,[]);await context.close();
  }
  fs.writeFileSync('docs/help-qa/result.json',JSON.stringify({baseCommit:'1d20a12ee267ea025a725431d1b3b67e373dc398',viewports:['1440x1000','390x844'],assertions:['real synthetic cookie signup','help opens','no horizontal page overflow','single preferences form','consent and conversational follow-up via real HTTP with mocked provider','email opt-in previews disabled copy','dismiss survives reopen','no page exceptions'],paidProviderCalls:0,mockedProviderCalls:mockedCalls},null,2));
  console.log('Synthetic desktop/mobile help QA passed');
}finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true})}})().catch(e=>{console.error(e);process.exitCode=1;server.closeAllConnections();server.close()});
