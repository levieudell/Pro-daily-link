'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-help-'));
Object.assign(process.env,{PDL_DB_FILE:path.join(temp,'db.json'),PDL_PLATFORM_FILE:path.join(temp,'platform.json'),PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',PDL_REQUIRE_AUTH:'1',PDL_EMAIL_DEV_MODE:'1',PDL_FOUNDER_ENABLED:'0',PDL_HELP_DRAFT:'1'});
for(const key of ['RESEND_API_KEY','OPENAI_API_KEY','STRIPE_SECRET_KEY','SENTRY_DSN'])delete process.env[key];
fs.copyFileSync('data/db.json',process.env.PDL_DB_FILE);fs.copyFileSync('data/platform.json',process.env.PDL_PLATFORM_FILE);
const {server}=require('./server');let base;
function client(){const jar=new Map();return async(route,method='GET',input)=>{const res=await fetch(base+route,{method,headers:{'Content-Type':'application/json',Cookie:[...jar].map(([k,v])=>k+'='+v).join('; ')},...(input===undefined?{}:{body:JSON.stringify(input)})});for(const c of res.headers.getSetCookie()){const [k,v]=c.split(';')[0].split('=');jar.set(k,v)}return {status:res.status,data:await res.json()}}}
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;try{
  const owner=client(),other=client(),anonymous=client();
  for(const [request,email] of [[owner,'help-owner@example.invalid'],[other,'help-other@example.invalid']])assert.equal((await request('/api/signup','POST',{companyName:'Synthetic help',ownerName:'QA',email,password:'Synthetic!42Password',legalAccepted:true})).status,201);
  assert.equal((await anonymous('/api/help-guidance')).status,401);
  assert.equal((await owner('/api/help-guidance')).data.tip.id,'project');
  assert.equal((await owner('/api/help-guidance','PATCH',{emailTips:true})).data.emailPreview.deliveryEnabled,false);
  assert.equal((await other('/api/help-guidance')).data.preferences.emailTips,false,'another tenant is not enrolled');
  assert.equal((await owner('/api/help-guidance','PATCH',{userId:1})).status,400);
  assert.equal((await owner('/api/help-guidance','PATCH',{seen:'project'})).status,200);
  assert.equal((await owner('/api/help-guidance','PATCH',{dismiss:'project'})).data.tip,null);
  assert.equal((await other('/api/help-guidance')).data.tip.id,'project');
  assert.equal((await owner('/api/help-guidance','PATCH',{emailTips:false})).data.emailPreview,null);
  process.env.PDL_HELP_DRAFT='0';assert.equal((await owner('/api/help-guidance')).status,404);
  console.log('Help API tests passed: real cookie sessions, tenant isolation, opt-in/unsubscribe preference, idempotent dismissal and disabled flag; no providers');
}finally{await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true})}})().catch(e=>{console.error(e);process.exitCode=1;server.close()});
