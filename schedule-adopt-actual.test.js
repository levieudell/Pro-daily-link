'use strict';
// "Adopt actual times": an office action copies a completed workday's real
// in/out into the scheduled shift (server-authoritative, 15-minute rounding,
// leave/conflict checks, acknowledgement reset, audit entry).
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
// Client helpers (pure): rounding, workday matching, preview window.
const source=fs.readFileSync('app.js','utf8'),lines=source.split('\n');
function code(name){const start=lines.findIndex(l=>l.startsWith(`function ${name}(`));assert.ok(start>=0,name);assert.ok(lines[start].trimEnd().endsWith('}'),name+' must be single-line for extraction');return lines[start]}
const context={workdays:[],company:{timezone:'UTC'},companyTodayIso:(date)=>date.toISOString().slice(0,10)};vm.createContext(context);
vm.runInContext([code('roundShiftTime'),code('adoptableWorkdaysFor'),code('companyLocalTimeValue'),code('adoptActualPreview')].join('\n'),context);
assert.equal(context.roundShiftTime('06:07'),'06:00','7 minutes rounds down to the quarter hour');
assert.equal(context.roundShiftTime('06:08'),'06:15','8 minutes rounds up to the quarter hour');
assert.equal(context.roundShiftTime('bad'),null,'malformed times are rejected');
const assignment={id:1,projectId:101,date:'2026-10-09',start:'06:00',end:'14:00',memberIds:[7,8]};
context.workdays=[{id:5,projectId:101,memberIds:[7],status:'complete',startedAt:'2026-10-09T06:07:00Z',endedAt:'2026-10-09T14:22:00Z'}];
const hits=context.adoptableWorkdaysFor(assignment);
assert.equal(hits.length,1,'completed same-project workday overlapping the crew matches');
const preview=context.adoptActualPreview(hits);
assert.equal(preview.start,'06:00');assert.equal(preview.end,'14:15','preview rounds actual in/out to 15 minutes');
context.workdays=[{id:5,projectId:101,memberIds:[7],status:'active',startedAt:'2026-10-09T06:07:00Z',endedAt:null}];
assert.equal(context.adoptableWorkdaysFor(assignment).length,0,'an active (unfinished) workday is not adoptable');
context.workdays=[{id:5,projectId:101,memberIds:[9],status:'complete',startedAt:'2026-10-09T06:07:00Z',endedAt:'2026-10-09T14:22:00Z'}];
assert.equal(context.adoptableWorkdaysFor(assignment).length,0,'a workday with no overlapping crew members is not adoptable');
context.workdays=[{id:5,projectId:101,memberIds:[7],status:'complete',startedAt:'2026-10-08T06:07:00Z',endedAt:'2026-10-08T14:22:00Z'}];
assert.equal(context.adoptableWorkdaysFor(assignment).length,0,'a workday from another date is not adoptable');
// Live API against a real server boot.
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-adopt-')),companyId='ccddccdd-ccdd-4cc4-8cc8-ccddccddeeff',ownerToken='synthetic-adopt-owner';
const date=new Date().toISOString().slice(0,10);
const db={company:{id:companyId,name:'Synthetic adopt',demo:true,timezone:'UTC'},projects:[{id:101,name:'North Ridge'}],team:[{id:7,name:'Chloe',crew:'A'},{id:8,name:'Andi',crew:'A'}],assignments:[{id:1,projectId:101,date,start:'06:00',end:'14:00',crew:'A',memberIds:[7,8],acknowledgements:{7:{status:'acknowledged'}},activity:'Excavation'},{id:2,projectId:101,date,start:'15:00',end:'16:00',crew:'B',memberIds:[8],activity:'Grading'}],workdays:[{id:5,projectId:101,memberIds:[7],status:'complete',startedAt:`${date}T06:07:00Z`,endedAt:`${date}T14:22:00Z`,reportId:9}],timeCards:[],timeOffRequests:[],reports:[],photos:[],auditLog:[],users:[{id:1,name:'Synthetic owner',role:'owner',status:'Active',companyId},{id:2,name:'Synthetic field',role:'field',status:'Active',companyId,memberId:7}],sessions:[{companyId,userId:1,tokenHash:crypto.createHash('sha256').update(ownerToken).digest('hex'),expiresAt:'2099-01-01'},{companyId,userId:2,tokenHash:crypto.createHash('sha256').update('synthetic-adopt-field').digest('hex'),expiresAt:'2099-01-01'}],customers:[],changes:[],catalog:[]};
const file=path.join(root,'db.json');fs.writeFileSync(file,JSON.stringify(db));fs.writeFileSync(path.join(root,'platform.json'),JSON.stringify({users:[],sessions:[]}));
Object.assign(process.env,{PDL_DB_FILE:file,PDL_PLATFORM_FILE:path.join(root,'platform.json'),PDL_REQUIRE_AUTH:'1',PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',PDL_EMAIL_DEV_MODE:'1'});for(const name of ['OPENAI_API_KEY','SENTRY_DSN','RESEND_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET'])delete process.env[name];
require('./database/supabase').loadLocalEnv=()=>{};
const {server}=require('./server');
(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
const call=(method,route,input,token=ownerToken)=>fetch(base+route,{method,signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','x-pdl-company':companyId},...(input!==undefined?{body:JSON.stringify(input)}:{})}).then(async response=>({status:response.status,data:await response.json()}));
try{
  assert.equal((await call('POST','/api/assignments/1/adopt-actual-times',{},'synthetic-adopt-field')).status,403,'field accounts cannot adopt');
  const missing=await call('POST','/api/assignments/99/adopt-actual-times',{});assert.equal(missing.status,404);
  const empty=await call('POST','/api/assignments/2/adopt-actual-times',{});assert.equal(empty.status,409,'an assignment without a completed crew workday is rejected');
  const result=await call('POST','/api/assignments/1/adopt-actual-times',{});assert.equal(result.status,200);
  assert.equal(result.data.assignment.start,'06:00');assert.equal(result.data.assignment.end,'14:15','actual 06:07–14:22 rounds to 06:00–14:15');
  assert.deepEqual(result.data.assignment.acknowledgements,{},'acknowledgements reset like any material schedule change');
  const stored=JSON.parse(fs.readFileSync(file));
  const audit=stored.auditLog.find(row=>row.type==='assignment_adopted_actual_times');
  assert.ok(audit,'audit entry recorded');assert.match(audit.detail,/06:00–14:00 adopted.*06:00–14:15/);
  const again=await call('POST','/api/assignments/1/adopt-actual-times',{});assert.equal(again.status,200);assert.equal(again.data.assignment.start,'06:00','repeating the adoption is idempotent');
  const storedMiddle=JSON.parse(fs.readFileSync(file));storedMiddle.assignments.push({id:3,projectId:101,date,start:'06:30',end:'07:00',crew:'B',memberIds:[8],activity:'Grading'});fs.writeFileSync(file,JSON.stringify(storedMiddle));
  const conflict=await call('POST','/api/assignments/1/adopt-actual-times',{});assert.equal(conflict.status,409,'adoption that would overlap another assignment is rejected');
  const storedAfter=JSON.parse(fs.readFileSync(file));assert.equal(storedAfter.assignments[0].end,'14:15','a rejected adoption leaves the schedule untouched');
  console.log('Adopt actual times passed: rounding, matching rules, preview, 403/404/409 gates, adoption, acknowledgement reset, audit, idempotence.');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true})}})().catch(error=>{console.error(error);process.exitCode=1;server.close()});
