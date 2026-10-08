'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-help-conversation-'));
Object.assign(process.env,{PDL_DB_FILE:path.join(temp,'db.json'),PDL_PLATFORM_FILE:path.join(temp,'platform.json'),PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',PDL_REQUIRE_AUTH:'1',PDL_EMAIL_DEV_MODE:'1',PDL_FOUNDER_ENABLED:'0',PDL_HELP_DRAFT:'1',PDL_HELP_UNSUBSCRIBE_KEY:'SyntheticLocalUnsubscribeKeyOnlyForQA42'});
for(const key of ['RESEND_API_KEY','OPENAI_API_KEY','STRIPE_SECRET_KEY','SENTRY_DSN','PDL_HELP_AI_APPROVED'])delete process.env[key];
fs.copyFileSync('data/db.json',process.env.PDL_DB_FILE);fs.copyFileSync('data/platform.json',process.env.PDL_PLATFORM_FILE);
let calls=0,payloads=[];
require('./help-conversation').openAIHelp=async payload=>{calls++;payloads.push(payload);const value=JSON.parse(payload.input),text=value.conversation.at(-1).content,field=value.role==='field';return {answer:{answer:text==='And then?'?'Check job, date, quantities and labor, then Submit to office.':'Choose an accessible job and save a draft or submit to office.',sourceIds:[field?'field-scope':'daily-review'],clarification:null,escalate:false},usage:{input_tokens:1000,output_tokens:100}}};
const {server}=require('./server');let base;
function client(){const jar=new Map();return async(route,method='GET',input)=>{const res=await fetch(base+route,{method,headers:{'Content-Type':'application/json',Cookie:[...jar].map(([k,v])=>k+'='+v).join('; ')},...(input===undefined?{}:{body:JSON.stringify(input)})});for(const c of res.headers.getSetCookie()){const pair=c.split(';')[0],i=pair.indexOf('=');jar.set(pair.slice(0,i),pair.slice(i+1))}return {status:res.status,data:await res.json()}}}
const turn=text=>({text,turnId:crypto.randomUUID(),consent:true});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;try{
  const owner=client(),other=client(),anonymous=client();let companyId;
  for(const [request,email] of [[owner,'conversation-owner@example.invalid'],[other,'conversation-other@example.invalid']]){const signup=await request('/api/signup','POST',{companyName:'Synthetic Help',ownerName:'QA Owner',email,password:'Synthetic!42Password',legalAccepted:true});assert.equal(signup.status,201);if(request===owner)companyId=signup.data.company.id}
  const body=turn('How do I file a daily?');assert.equal((await owner('/api/help/conversation','POST',body)).status,503);assert.equal(calls,0);
  // Mocked evaluation adapter only, no API key; configured scope is this synthetic tenant.
  process.env.PDL_HELP_AI_APPROVED='synthetic-evaluation-v1';process.env.PDL_HELP_EVAL_COMPANY=companyId;
  assert.equal((await anonymous('/api/help/conversation','POST',body)).status,503,'non-evaluation tenant never reaches provider');
  const first=await owner('/api/help/conversation','POST',body);assert.equal(first.status,200);assert.equal((await owner('/api/help/conversation','POST',body)).status,200);assert.equal(calls,1);
  assert.equal((await owner('/api/help/conversation','POST',{...turn('And then?'),state:first.data.state})).status,200);assert.equal(JSON.parse(payloads[1].input).conversation.length,3);
  assert.equal((await other('/api/help/conversation','POST',{...turn('And then?'),state:first.data.state})).status,503);assert.equal(calls,2);
  assert.equal((await owner('/api/help/conversation','POST',{...turn('hello'),role:'owner'})).status,400);
  const verify=await owner('/api/auth/email-verification/resend','POST',{});assert.equal((await owner('/api/auth/email-verification/confirm','POST',{token:verify.data.previewToken})).status,200);
  await owner('/api/help-guidance','PATCH',{emailTips:true});await other('/api/help-guidance','PATCH',{emailTips:true});
  const reservations=await Promise.all([owner('/api/help/email-draft','POST',{tipId:'project'}),owner('/api/help/email-draft','POST',{tipId:'project'})]);assert.ok(reservations.every(r=>r.status===200));assert.equal(reservations.filter(r=>r.data.duplicate).length,1);
  const file=path.join(temp,'tenants',companyId+'.json');assert.equal(JSON.parse(fs.readFileSync(file)).helpEmailReceipts.length,1,'serialized durable unique reservation');
  const unsubscribe=reservations[0].data.unsubscribePath;assert.equal((await fetch(base+unsubscribe)).status,200);assert.equal((await owner('/api/help-guidance')).data.preferences.emailTips,true,'GET does not unsubscribe');
  const post=await fetch(base+unsubscribe,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'List-Unsubscribe=One-Click'});assert.equal(post.status,200);assert.equal((await owner('/api/help-guidance')).data.preferences.emailTips,false);assert.equal((await other('/api/help-guidance')).data.preferences.emailTips,true,'unsubscribe follows signed tenant, not caller cookie');
  assert.equal((await fetch(base+unsubscribe,{method:'POST',body:'List-Unsubscribe=One-Click'})).status,200,'idempotent one-click');assert.equal(JSON.parse(fs.readFileSync(file)).helpEmailReceipts[0].status,'cancelled');
  const changed=JSON.parse(fs.readFileSync(file));changed.users[0].role='field';fs.writeFileSync(file,JSON.stringify(changed));assert.equal((await owner('/api/help/conversation','POST',{...turn('And then?'),state:first.data.state})).status,400);
  assert.equal((await owner('/api/help/conversation','POST',turn('Where is my work?'))).status,200);assert.ok(!JSON.parse(payloads.at(-1).input).knowledge.some(k=>k.id==='crew-access'));assert.equal((await owner('/api/help/email-draft','POST',{tipId:'daily'})).status,403);
  console.log('Real HTTP Help tests passed with mocked provider: cookie sessions, signed follow-ups, scope/role isolation, disabled default, durable concurrent email dedupe, safe GET and anonymous one-click unsubscribe. No paid provider or email delivery.');
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true})}})().catch(e=>{console.error(e);process.exitCode=1;server.closeAllConnections();server.close()});
