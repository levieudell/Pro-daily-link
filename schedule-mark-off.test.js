'use strict';
// "Mark off": the office clicks a day cell on the crew schedule and records
// that a person is out (sick / personal / no work / other), paid or unpaid.
// The record is an APPROVED time-off row, so the schedule greys the person
// out, no-show alerts excuse the day, repeat-week respects it, and the Time
// off page keeps the full history with the office as the reviewer.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
// Markup + wiring contract.
const index=fs.readFileSync('index.html','utf8'),appSource=fs.readFileSync('app.js','utf8');
assert.match(index,/id="day-action-modal"/,'day chooser dialog exists');
assert.match(index,/id="mark-off-modal"/,'mark-off dialog exists');
assert.match(index,/id="mark-off-reason"/,'reason select exists');
assert.match(index,/name="mark-off-paid"/,'paid/unpaid choice exists');
assert.match(appSource,/\$\('#mark-off-save'\)\.onclick=saveMarkOff/,'save wired');
assert.match(appSource,/canManageSchedule\(\)\?openDayAction\(\+cell\.dataset\.scheduleMember/,'week cells route through the day chooser');
assert.match(index,/app\.js\?v=20261008-saved-zone-mark-off/,'cache version bumped');
// Live API against a real server boot.
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-markoff-')),companyId='ccddccdd-ccdd-4cc4-8cc8-ccddccddeeff',ownerToken='synthetic-markoff-owner';
const utc=new Date(),today=`${utc.getUTCFullYear()}-${String(utc.getUTCMonth()+1).padStart(2,'0')}-${String(utc.getUTCDate()).padStart(2,'0')}`;
const plusDays=n=>{const d=new Date(`${today}T12:00:00Z`);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
const db={company:{id:companyId,name:'Synthetic mark off',demo:true,timezone:'UTC'},projects:[{id:101,name:'North Ridge'}],team:[{id:7,name:'Chloe',crew:'A'},{id:8,name:'Andi',crew:'A'},{id:9,name:'Ben',crew:'B'}],assignments:[{id:1,projectId:101,date:today,start:'06:00',end:'14:00',crew:'A',memberIds:[7,8],activity:'Excavation'}],workdays:[],timeCards:[],timeOffRequests:[],reports:[],photos:[],auditLog:[],users:[
  {id:1,name:'Synthetic owner',role:'owner',status:'Active',companyId},
  {id:2,name:'Synthetic field',role:'field',status:'Active',companyId,memberId:7},
  {id:3,name:'Synthetic pm plain',role:'project_manager',status:'Active',companyId},
  {id:4,name:'Synthetic pm scoped',role:'project_manager',status:'Active',companyId,permissions:{scheduleCrews:true},projectIds:[101],assignedCrews:['A']}],
  sessions:[{companyId,userId:1,tokenHash:crypto.createHash('sha256').update(ownerToken).digest('hex'),expiresAt:'2099-01-01'},
  {companyId,userId:2,tokenHash:crypto.createHash('sha256').update('synthetic-markoff-field').digest('hex'),expiresAt:'2099-01-01'},
  {companyId,userId:3,tokenHash:crypto.createHash('sha256').update('synthetic-markoff-pm').digest('hex'),expiresAt:'2099-01-01'},
  {companyId,userId:4,tokenHash:crypto.createHash('sha256').update('synthetic-markoff-pm-scoped').digest('hex'),expiresAt:'2099-01-01'}],customers:[],changes:[],catalog:[]};
const file=path.join(root,'db.json');fs.writeFileSync(file,JSON.stringify(db));fs.writeFileSync(path.join(root,'platform.json'),JSON.stringify({users:[],sessions:[]}));
Object.assign(process.env,{PDL_DB_FILE:file,PDL_PLATFORM_FILE:path.join(root,'platform.json'),PDL_REQUIRE_AUTH:'1',PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',PDL_EMAIL_DEV_MODE:'1'});for(const name of ['OPENAI_API_KEY','SENTRY_DSN','RESEND_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET'])delete process.env[name];
require('./database/supabase').loadLocalEnv=()=>{};
const {server}=require('./server');
(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
const call=(method,route,input,token=ownerToken)=>fetch(base+route,{method,signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','x-pdl-company':companyId},...(input!==undefined?{body:JSON.stringify(input)}:{})}).then(async response=>({status:response.status,data:await response.json()}));
try{
  assert.equal((await call('POST','/api/schedule/mark-off',{memberId:7,date:today,reason:'sick',paid:true},'synthetic-markoff-field')).status,403,'field accounts cannot mark off');
  assert.equal((await call('POST','/api/schedule/mark-off',{memberId:7,date:today,reason:'sick',paid:true},'synthetic-markoff-pm')).status,403,'project managers need the schedule permission');
  assert.equal((await call('POST','/api/schedule/mark-off',{memberId:99,date:today,reason:'sick',paid:true})).status,400,'unknown person rejected');
  assert.equal((await call('POST','/api/schedule/mark-off',{memberId:7,date:'bad-date',reason:'sick',paid:true})).status,400,'invalid date rejected');
  assert.equal((await call('POST','/api/schedule/mark-off',{memberId:9,date:today,reason:'sick',paid:true},'synthetic-markoff-pm-scoped')).status,403,'scoped managers cannot mark off crew B');
  const sick=await call('POST','/api/schedule/mark-off',{memberId:7,date:today,reason:'sick',paid:true,note:'Fever'});
  assert.equal(sick.status,201);
  assert.equal(sick.data.row.type,'sick','paid sick day keeps the sick type');
  assert.equal(sick.data.row.note,'Called in sick — Fever','reason label and detail combine into the note');
  assert.equal(sick.data.row.status,'approved','the office decision is recorded as approved immediately');
  assert.equal(sick.data.row.startDate,today);assert.equal(sick.data.row.endDate,today);assert.equal(sick.data.row.allDay,true);
  assert.equal(sick.data.row.reviewedBy,'Synthetic owner');
  assert.equal(sick.data.row.history[0].action,'Marked off','history shows who recorded it');
  assert.equal(sick.data.overlapping,1,'the scheduled shift is counted for the office');
  const duplicate=await call('POST','/api/schedule/mark-off',{memberId:7,date:today,reason:'other',paid:false});
  assert.equal(duplicate.status,409,'a second mark-off on the same day is rejected');
  const unpaid=await call('POST','/api/schedule/mark-off',{memberId:8,date:today,reason:'no_work',paid:false});
  assert.equal(unpaid.status,201);assert.equal(unpaid.data.row.type,'unpaid','unpaid always maps to the unpaid type');
  assert.equal(unpaid.data.row.note,'No work');
  const personal=await call('POST','/api/schedule/mark-off',{memberId:8,date:plusDays(2),reason:'personal',paid:true});
  assert.equal(personal.data.row.type,'vacation','a paid personal day maps to vacation');
  const other=await call('POST','/api/schedule/mark-off',{memberId:9,date:plusDays(3),reason:'other',paid:true,note:'Jury duty'});
  assert.equal(other.data.row.type,'other');assert.equal(other.data.row.note,'Other — Jury duty');
  const availability=await call('GET','/api/schedule-availability');
  assert.equal(availability.status,200);
  const chloeRow=(availability.data||[]).find(row=>Number(row.memberId)===7);
  assert.ok(chloeRow,'schedule availability lists Chloe');
  assert.ok(chloeRow.startDate<=today&&chloeRow.endDate>=today,'the marked-off day is visible to the schedule grid');
  const offRequests=await call('GET','/api/time-off-requests');
  assert.equal(offRequests.status,200,'office can list time-off records');
  const found=(offRequests.data||[]).find(row=>String(row.id)===String(sick.data.row.id));
  assert.ok(found,'the mark-off appears on the Time off page with the office as reviewer');
  console.log('Mark off passed: markup contract, 400/403 gates, type mapping (sick/vacation/unpaid/other), note format, approval + history, availability visibility, duplicate guard, PM scope.');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true})}})().catch(error=>{console.error(error);process.exitCode=1;server.close()});
