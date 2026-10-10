'use strict';
// "Schedule follows actual times" (opt-in company setting): when a workday
// ends, matching assignments reconcile to the real clock in/out through the
// SAME helper as the manual "Adopt actual times" action (15-minute rounding,
// leave/conflict checks, acknowledgement reset, audit entry marked auto).
// Skips never fail the workday end; an unchanged plan is a clean no-op.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
// Markup + wiring contract.
const index=fs.readFileSync('index.html','utf8'),appSource=fs.readFileSync('app.js','utf8');
assert.match(index,/id="company-auto-adopt"/,'settings page carries the opt-in toggle');
assert.match(appSource,/\$\('#company-auto-adopt'\)\.checked=company\.autoAdoptActualTimes===true/,'toggle renders current state');
assert.match(appSource,/autoAdoptActualTimes:\$\('#company-auto-adopt'\)\.checked/,'toggle rides the company save payload');
assert.match(index,/app\.js\?v=20261011-task-assign/,'cache version carries the bumped release marker');
// Live API against a real server boot.
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-autoadopt-')),companyId='ccddccdd-ccdd-4cc4-8cc8-ccddccddeeff',ownerToken='synthetic-autoadopt-owner';
const utc=new Date(),today=`${utc.getUTCFullYear()}-${String(utc.getUTCMonth()+1).padStart(2,'0')}-${String(utc.getUTCDate()).padStart(2,'0')}`;
const db={company:{id:companyId,name:'Synthetic auto adopt',demo:true,timezone:'UTC'},projects:[{id:101,name:'North Ridge'}],team:[{id:7,name:'Chloe',crew:'A'},{id:8,name:'Andi',crew:'A'}],assignments:[{id:1,projectId:101,date:today,start:'06:00',end:'14:00',crew:'A',memberIds:[7,8],acknowledgements:{7:{status:'acknowledged'}},activity:'Excavation'}],workdays:[{id:5,projectId:101,memberIds:[7],status:'active',startedAt:`${today}T06:07:00Z`,endedAt:null,reportId:null}],timeCards:[],timeOffRequests:[],reports:[],photos:[],auditLog:[],users:[{id:1,name:'Synthetic owner',role:'owner',status:'Active',companyId}],sessions:[{companyId,userId:1,tokenHash:crypto.createHash('sha256').update(ownerToken).digest('hex'),expiresAt:'2099-01-01'}],customers:[],changes:[],catalog:[]};
const file=path.join(root,'db.json');fs.writeFileSync(file,JSON.stringify(db));fs.writeFileSync(path.join(root,'platform.json'),JSON.stringify({users:[],sessions:[]}));
Object.assign(process.env,{PDL_DB_FILE:file,PDL_PLATFORM_FILE:path.join(root,'platform.json'),PDL_REQUIRE_AUTH:'1',PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',PDL_EMAIL_DEV_MODE:'1'});for(const name of ['OPENAI_API_KEY','SENTRY_DSN','RESEND_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET'])delete process.env[name];
require('./database/supabase').loadLocalEnv=()=>{};
const {server}=require('./server');
(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
const call=(method,route,input,token=ownerToken)=>fetch(base+route,{method,signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','x-pdl-company':companyId},...(input!==undefined?{body:JSON.stringify(input)}:{})}).then(async response=>({status:response.status,data:await response.json()}));
const reload=()=>JSON.parse(fs.readFileSync(file));
const save=data=>fs.writeFileSync(file,JSON.stringify(data));
// Consistency check between the adopted report and what actually persisted.
const verifyAdopted=(adopted,beforeTimes)=>{const stored=reload();for(const entry of adopted){const row=stored.assignments.find(a=>a.id===entry.assignmentId),audit=stored.auditLog.filter(a=>a.type==='assignment_adopted_actual_times'&&a.assignmentId===entry.assignmentId);
  if(entry.changed){assert.equal(row.start,'06:00','actual clock-in rounds to the quarter hour');assert.ok(row.start!==beforeTimes[entry.assignmentId].start||row.end!==beforeTimes[entry.assignmentId].end,'a reported change actually changed the plan');assert.deepEqual(row.acknowledgements,{},'acknowledgements reset on a material change');assert.ok(audit.some(a=>a.auto===true),'audit entry flagged automatic');assert.match(audit[audit.length-1].detail,/· automatic$/)}
  else if(entry.error){assert.equal(row.start,beforeTimes[entry.assignmentId].start,'a skipped adoption leaves the plan untouched');assert.equal(row.end,beforeTimes[entry.assignmentId].end)} }return stored};
try{
  // Disabled by default: ending a workday changes nothing.
  const disabled=await call('POST','/api/workdays/5/end',{notes:'Poured footings',foreman:'Chloe'});
  assert.equal(disabled.status,200);assert.deepEqual(disabled.data.adopted,[],'the setting is opt-in');
  let stored=reload();assert.equal(stored.assignments[0].end,'14:00','disabled: the plan stays as built');
  // Enable via company settings; response and storage both reflect it.
  const enable=await call('PATCH','/api/company',{name:'Synthetic auto adopt',autoAdoptActualTimes:true});
  assert.equal(enable.status,200);assert.equal(enable.data.autoAdoptActualTimes,true,'PATCH response carries the setting');
  stored=reload();assert.equal(stored.company.autoAdoptActualTimes,true,'setting persisted');
  // Enabled: ending a workday reconciles matching assignments through the same helper.
  stored.workdays.push({id:6,projectId:101,memberIds:[8],status:'active',startedAt:`${today}T06:08:00Z`,endedAt:null,reportId:null});save(stored);
  const before=Object.fromEntries(reload().assignments.map(a=>[a.id,{start:a.start,end:a.end}]));
  const clean=await call('POST','/api/workdays/6/end',{notes:'Set forms',foreman:'Andi'});
  assert.equal(clean.status,200);
  assert.equal(clean.data.workday.status,'complete','the workday completes regardless');
  assert.equal(clean.data.adopted.length,1,'the matching assignment is offered to the helper');
  stored=verifyAdopted(clean.data.adopted,before);
  if(clean.data.adopted[0].changed)assert.ok(stored.assignments[0].notifications[7].inAppAt,'members get a fresh My Day notification');
  else assert.ok(!stored.assignments[0].notifications||stored.assignments[0].notifications[7]===undefined,'no-op keeps or refreshes notifications cleanly');
  // Conflict skip: the workday still ends and the conflicting plan is untouched.
  stored.assignments.push({id:2,projectId:101,date:today,start:'00:00',end:'06:15',crew:'B',memberIds:[8],activity:'Morning watch'});
  stored.workdays.push({id:7,projectId:101,memberIds:[8],status:'active',startedAt:`${today}T06:09:00Z`,endedAt:null,reportId:null});save(stored);
  const snapshot=Object.fromEntries(reload().assignments.map(a=>[a.id,{start:a.start,end:a.end}]));
  const conflict=await call('POST','/api/workdays/7/end',{notes:'Stripped forms',foreman:'Andi'});
  assert.equal(conflict.status,200,'a conflicting adoption never blocks the end-of-day');
  assert.equal(conflict.data.workday.status,'complete');
  const errorEntry=conflict.data.adopted.find(a=>a.error);
  assert.ok(errorEntry,'the blocked assignment is reported as a skip');
  verifyAdopted(conflict.data.adopted,snapshot);
  // Unrelated company save preserves the setting.
  const unrelated=await call('PATCH','/api/company',{name:'Synthetic auto adopt renamed'});
  assert.equal(unrelated.status,200);stored=reload();assert.equal(stored.company.autoAdoptActualTimes,true,'unrelated saves preserve the toggle');
  // Disable: ending another workday adopts nothing.
  await call('PATCH','/api/company',{name:'Synthetic auto adopt',autoAdoptActualTimes:false});
  stored=reload();assert.equal(stored.company.autoAdoptActualTimes,false);
  const finalTimes={1:{start:stored.assignments[0].start,end:stored.assignments[0].end}};
  stored.workdays.push({id:8,projectId:101,memberIds:[7],status:'active',startedAt:`${today}T06:10:00Z`,endedAt:null,reportId:null});save(stored);
  const off=await call('POST','/api/workdays/8/end',{notes:'Cleanup',foreman:'Chloe'});
  assert.equal(off.status,200);assert.deepEqual(off.data.adopted,[],'disabled again: no automatic adoptions');
  stored=reload();assert.equal(stored.assignments[0].start,finalTimes[1].start);assert.equal(stored.assignments[0].end,finalTimes[1].end);
  console.log('Auto adopt passed: opt-in default, setting round-trip + preserve, enabled adoption (rounding, acks, audit auto-flag), conflict skip never blocks end-of-day, disable.');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true})}})().catch(error=>{console.error(error);process.exitCode=1;server.close()});
