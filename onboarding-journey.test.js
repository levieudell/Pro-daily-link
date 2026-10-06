'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-onboarding-journey-'));
process.env.PDL_DB_FILE=path.join(temp,'db.json');process.env.PDL_PLATFORM_FILE=path.join(temp,'platform.json');
process.env.PDL_SUPABASE_ENABLED='0';process.env.PDL_TRANSACTIONAL_DB='off';process.env.PDL_REQUIRE_AUTH='1';process.env.PDL_EMAIL_DEV_MODE='1';process.env.PDL_FOUNDER_ENABLED='0';
for(const key of ['SENTRY_DSN','RESEND_API_KEY','OPENAI_API_KEY','STRIPE_SECRET_KEY'])delete process.env[key];
fs.copyFileSync('data/db.json',process.env.PDL_DB_FILE);fs.copyFileSync('data/platform.json',process.env.PDL_PLATFORM_FILE);
const {server}=require('./server');
let base;
function client(){const jar=new Map();return async(route,method='GET',input)=>{
  const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',Cookie:[...jar].map(([key,value])=>key+'='+value).join('; ')},...(input===undefined?{}:{body:JSON.stringify(input)})});
  for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0],index=pair.indexOf('=');jar.set(pair.slice(0,index),pair.slice(index+1))}
  return{status:response.status,data:await response.json()};
}}
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
  const owner=client(),other=client(),email='synthetic-owner@example.invalid',password='SyntheticPassword!42';
  try{
    const signup=await owner('/api/signup','POST',{companyName:'Synthetic PDL journey',ownerName:'QA Owner',email,password,legalAccepted:true,onboardingPreference:'self'});assert.equal(signup.status,201);
    assert.ok(signup.data.company.trialEndsAt);assert.equal(signup.data.company.founder,false);
    const me=await owner('/api/auth/me');assert.equal(me.status,200);assert.equal(me.data.companyId,signup.data.company.id);
    const verification=await owner('/api/auth/email-verification/resend','POST',{});assert.equal(verification.status,200);assert.ok(verification.data.previewToken);
    assert.equal((await owner('/api/auth/email-verification/confirm','POST',{token:verification.data.previewToken})).status,200);
    assert.equal((await owner('/api/auth/email-verification/confirm','POST',{token:verification.data.previewToken})).status,401,'verification is single use');
    const crew=await owner('/api/team-with-account','POST',{name:'Synthetic Crew',role:'Installer',crew:'QA Crew',email:'synthetic-crew@example.invalid',accountRole:'field'});assert.equal(crew.status,201);assert.ok(crew.data.id);assert.equal(crew.data.user.memberId,crew.data.id);
    const billing=await owner('/api/billing');assert.equal(billing.status,200);assert.equal(billing.data.status,'Trial');assert.equal(billing.data.daysRemaining,14);assert.equal(billing.data.configured,false);
    const customer=await owner('/api/customers','POST',{name:'Synthetic customer'});assert.equal(customer.status,201);
    const project=await owner('/api/projects','POST',{name:'Synthetic project',code:'QA',customerId:customer.data.id,estimateItems:[],contractType:'estimated'});assert.equal(project.status,201);
    const item=await owner('/api/projects/'+project.data.id+'/estimate-items','POST',{name:'Synthetic scope',unit:'SF',plannedQuantity:100,budgetHours:40,cost:0});assert.equal(item.status,201);
    const report=await owner('/api/reports','POST',{projectId:project.data.id,dateIso:'2026-10-04',status:'Draft',notes:'Synthetic saved draft',signature:'QA',laborEntries:[{memberId:crew.data.id,name:'Synthetic Crew',hours:8}],productionEntries:[{estimateItemId:item.data.id,description:'Synthetic scope',unit:'SF',quantity:10,laborHours:8}],extracted:{summary:'Synthetic work'}});assert.equal(report.status,201);
    const draftAgain=await owner('/api/reports','POST',{projectId:project.data.id,dateIso:'2026-10-04',status:'Draft',notes:'Synthetic saved draft',signature:'QA',laborEntries:[{memberId:crew.data.id,name:'Synthetic Crew',hours:8}],productionEntries:[{estimateItemId:item.data.id,description:'Synthetic scope',unit:'SF',quantity:10,laborHours:8}],extracted:{summary:'Synthetic work'}});assert.equal(draftAgain.status,200);assert.equal(draftAgain.data.id,report.data.id,'server draft upsert preserves identity');
    assert.equal((await owner('/api/reports/'+report.data.id,'PATCH',{status:'Needs review',notes:'Synthetic submitted work',productionEntries:[{estimateItemId:item.data.id,description:'Synthetic scope',unit:'SF',quantity:10,laborHours:8}],laborEntries:[{memberId:crew.data.id,name:'Synthetic Crew',hours:8}]})).status,200);
    assert.equal((await owner('/api/reports/'+report.data.id+'/approve','PATCH',{})).status,200);
    const totals=await owner('/api/production');assert.equal(totals.status,200);assert.equal(totals.data.projects[0].items[0].actualQuantity,10);assert.equal(totals.data.projects[0].items[0].actualLaborHours,8,'approved production preserves crew labor');
    const captured=await owner('/api/reporting-exports','POST',{projectId:project.data.id,from:'2026-10-01',to:'2026-10-31'});assert.equal(captured.status,201);
    await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
    const restored=await owner('/api/state');assert.equal(restored.status,200);assert.equal(restored.data.reports.length,1);assert.equal(restored.data.reports[0].status,'Approved');assert.deepEqual(restored.data.reports[0].laborEntries.map(entry=>({memberId:entry.memberId,hours:entry.hours})),[{memberId:crew.data.id,hours:8}],'listener reopen preserves saved crew labor');assert.equal(restored.data.reports[0].productionEntries[0].laborHours,8);
    assert.deepEqual((await owner('/api/reporting-exports/'+captured.data.id)).data,captured.data,'capture survives HTTP listener reopen');
    const foreign=await other('/api/signup','POST',{companyName:'Other synthetic tenant',ownerName:'Other Owner',email:'other-owner@example.invalid',password,legalAccepted:true,onboardingPreference:'self'});assert.equal(foreign.status,201);
    assert.equal((await other('/api/state')).data.projects.length,0);assert.equal((await other('/api/reporting-exports/'+captured.data.id)).status,404);
    const reset=await owner('/api/auth/forgot','POST',{email});assert.equal(reset.status,200);assert.ok(reset.data.previewToken);
    const replacement='SyntheticReplacement!42';assert.equal((await owner('/api/auth/reset','POST',{email,token:reset.data.previewToken,password:replacement})).status,200);
    assert.equal((await owner('/api/auth/me')).status,401,'password reset invalidates prior session');
    assert.equal((await owner('/api/auth/reset','POST',{email,token:reset.data.previewToken,password:replacement})).status,401,'reset token is single use');
    assert.equal((await owner('/api/auth/login','POST',{email,password})).status,401,'old password denied');
    assert.equal((await owner('/api/auth/login','POST',{email,password:replacement})).status,200);
    assert.equal((await owner('/api/state')).data.team.some(member=>member.id===crew.data.id),true,'crew remains after password recovery and login');
    assert.equal((await owner('/api/auth/logout','POST',{})).status,200);assert.equal((await owner('/api/auth/me')).status,401);
    console.log('Local onboarding journey passed: cookie signup, DEV token verification/reset, team account, no-card trial, project/scope, draft upsert, approval/totals/export, HTTP listener reopen and second-tenant denial. No provider delivery or browser UX certified.');
  }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1;server.close()});
