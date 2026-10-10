'use strict';
// "Repeat last week": the office copies selected assignments from the 7 days
// before the viewed week into the viewed week (server-authoritative, per-row
// validation, skip-with-reason instead of failing the batch, My Day
// notifications identical to a manual add).
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
// Markup + wiring contract.
const index=fs.readFileSync('index.html','utf8'),appSource=fs.readFileSync('app.js','utf8');
assert.match(index,/id="repeat-week"/,'schedule heading carries the Repeat last week button');
assert.match(index,/id="repeat-week-modal"/,'selection dialog exists');
assert.match(index,/id="repeat-week-result"/,'result dialog exists');
assert.match(index,/id="repeat-week-list"/,'checkbox list exists');
assert.match(appSource,/\$\('#repeat-week'\)\.onclick=openRepeatWeek/,'button wired');
assert.match(appSource,/\$\('#repeat-week-confirm'\)\.onclick=confirmRepeatWeek/,'confirm wired');
assert.match(appSource,/repeatWeekButton\.hidden=!canManageSchedule\(\)\|\|scheduleView==='month'/,'button hidden for field users and month view');
assert.match(index,/app\.js\?v=20261008-saved-zone-/,'cache version carries the bumped saved-zone marker (suffix changes per release)');
// Client helper (pure): the source window is the 7 days before the viewed week.
const lines=appSource.split('\n');
function code(name){const start=lines.findIndex(l=>l.startsWith(`function ${name}(`));assert.ok(start>=0,name);assert.ok(lines[start].trimEnd().endsWith('}'),name+' must be single-line for extraction');return lines[start]}
const context={scheduleWeekStart:()=>new Date(2026,9,11,12),localDateIso:(d)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`,assignments:[
  {id:1,date:'2026-10-05',start:'06:00'},
  {id:2,date:'2026-10-10',start:'07:00'},
  {id:3,date:'2026-10-12',start:'06:00'},
  {id:4,date:'2026-10-04',start:'15:00'}]};
vm.createContext(context);
vm.runInContext(code('repeatWeekSourceRows'),context);
const sourceWindow=context.repeatWeekSourceRows();
assert.equal(sourceWindow.dates.join(','),'2026-10-04,2026-10-05,2026-10-06,2026-10-07,2026-10-08,2026-10-09,2026-10-10','source window is the week before the viewed Sunday');
assert.equal(sourceWindow.rows.map(row=>row.id).join(','),'4,1,2','only source-week rows are offered, sorted by day then start time');
// Live API against a real server boot.
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-repeat-')),companyId='ccddccdd-ccdd-4cc4-8cc8-ccddccddeeff',ownerToken='synthetic-repeat-owner';
const utc=new Date(),today=`${utc.getUTCFullYear()}-${String(utc.getUTCMonth()+1).padStart(2,'0')}-${String(utc.getUTCDate()).padStart(2,'0')}`;
const anchor=new Date(`${today}T12:00:00Z`),sunday=new Date(anchor);sunday.setUTCDate(anchor.getUTCDate()-anchor.getUTCDay());
const isoUTC=d=>d.toISOString().slice(0,10);
const targetDates=[...Array(7)].map((_,i)=>{const d=new Date(sunday);d.setUTCDate(sunday.getUTCDate()+i);return isoUTC(d)});
const sourceDates=[...Array(7)].map((_,i)=>{const d=new Date(sunday);d.setUTCDate(sunday.getUTCDate()-7+i);return isoUTC(d)});
const db={company:{id:companyId,name:'Synthetic repeat',demo:true,timezone:'UTC'},projects:[{id:101,name:'North Ridge'},{id:102,name:'South Yard'}],team:[{id:7,name:'Chloe',crew:'A'},{id:8,name:'Andi',crew:'A'},{id:9,name:'Ben',crew:'B'}],assignments:[
  {id:1,projectId:101,date:sourceDates[1],start:'06:00',end:'14:00',crew:'A',memberIds:[7,8],activity:'Excavation'},
  {id:2,projectId:102,date:sourceDates[2],start:'07:00',end:'15:00',crew:'B',memberIds:[9],activity:'Grading'},
  {id:3,projectId:101,date:sourceDates[1],start:'15:00',end:'16:00',crew:'A',memberIds:[8],activity:'Site prep'},
  {id:4,projectId:101,date:targetDates[1],start:'06:00',end:'14:00',crew:'A',memberIds:[8],activity:'Excavation'},
  {id:5,projectId:101,date:sourceDates[3],start:'06:00',end:'14:00',crew:'A',memberIds:[8],activity:'Formwork'}],
  workdays:[],timeCards:[],timeOffRequests:[],reports:[],photos:[],auditLog:[],users:[
  {id:1,name:'Synthetic owner',role:'owner',status:'Active',companyId},
  {id:2,name:'Synthetic field',role:'field',status:'Active',companyId,memberId:7},
  {id:3,name:'Synthetic pm plain',role:'project_manager',status:'Active',companyId},
  {id:4,name:'Synthetic pm scoped',role:'project_manager',status:'Active',companyId,permissions:{scheduleCrews:true},projectIds:[101],assignedCrews:['A']}],
  sessions:[{companyId,userId:1,tokenHash:crypto.createHash('sha256').update(ownerToken).digest('hex'),expiresAt:'2099-01-01'},
  {companyId,userId:2,tokenHash:crypto.createHash('sha256').update('synthetic-repeat-field').digest('hex'),expiresAt:'2099-01-01'},
  {companyId,userId:3,tokenHash:crypto.createHash('sha256').update('synthetic-repeat-pm').digest('hex'),expiresAt:'2099-01-01'},
  {companyId,userId:4,tokenHash:crypto.createHash('sha256').update('synthetic-repeat-pm-scoped').digest('hex'),expiresAt:'2099-01-01'}],customers:[],changes:[],catalog:[]};
const file=path.join(root,'db.json');fs.writeFileSync(file,JSON.stringify(db));fs.writeFileSync(path.join(root,'platform.json'),JSON.stringify({users:[],sessions:[]}));
Object.assign(process.env,{PDL_DB_FILE:file,PDL_PLATFORM_FILE:path.join(root,'platform.json'),PDL_REQUIRE_AUTH:'1',PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',PDL_EMAIL_DEV_MODE:'1'});for(const name of ['OPENAI_API_KEY','SENTRY_DSN','RESEND_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET'])delete process.env[name];
require('./database/supabase').loadLocalEnv=()=>{};
const {server}=require('./server');
(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
const call=(method,route,input,token=ownerToken)=>fetch(base+route,{method,signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','x-pdl-company':companyId},...(input!==undefined?{body:JSON.stringify(input)}:{})}).then(async response=>({status:response.status,data:await response.json()}));
const reload=()=>JSON.parse(fs.readFileSync(file));
const save=data=>fs.writeFileSync(file,JSON.stringify(data));
try{
  assert.equal((await call('POST','/api/schedule/repeat-week',{targetStart:today,assignmentIds:[1]},'synthetic-repeat-field')).status,403,'field accounts cannot repeat a week');
  assert.equal((await call('POST','/api/schedule/repeat-week',{targetStart:today,assignmentIds:[1]},'synthetic-repeat-pm')).status,403,'project managers need the schedule permission');
  assert.equal((await call('POST','/api/schedule/repeat-week',{targetStart:'not-a-date',assignmentIds:[1]})).status,400,'target week must be a real date');
  assert.equal((await call('POST','/api/schedule/repeat-week',{targetStart:today,assignmentIds:[]})).status,400,'at least one assignment is required');
  assert.equal((await call('POST','/api/schedule/repeat-week',{targetStart:today,assignmentIds:[...Array(202).keys()]})).status,400,'selection is capped at 200 rows');
  const first=await call('POST','/api/schedule/repeat-week',{targetStart:today,assignmentIds:[1,2,3]});
  assert.equal(first.status,200);assert.equal(first.data.created,2,'two clean rows copy');assert.equal(first.data.skipped.length,1);
  assert.equal(first.data.skipped[0].reason,'Already scheduled on that day','the partial duplicate lands as a skip with a plain reason');
  assert.equal(first.data.skipped[0].date,targetDates[1]);
  const copiedIds=first.data.createdRows.map(row=>row.id).sort();
  const copiedBen=first.data.createdRows.find(row=>(row.memberIds||[]).includes(9)),copiedAndi=first.data.createdRows.find(row=>(row.memberIds||[]).includes(8));
  assert.equal(copiedBen.date,targetDates[2]);assert.equal(copiedBen.projectId,102);assert.equal(copiedBen.start,'07:00');assert.equal(copiedBen.end,'15:00');assert.equal(copiedBen.activity,'Grading');
  assert.equal(copiedAndi.date,targetDates[1]);assert.equal(copiedAndi.start,'15:00');assert.equal(copiedAndi.end,'16:00');
  assert.ok(copiedBen.notifications&&copiedBen.notifications[9]&&copiedBen.notifications[9].inAppAt,'My Day notification created like a manual add');
  assert.deepEqual(copiedBen.acknowledgements,{},'acknowledgements start empty');
  let stored=reload();assert.equal(stored.assignments.length,7,'both rows persisted');
  const storedBen=stored.assignments.find(row=>row.id===copiedBen.id);
  assert.equal(storedBen.crew,'B');assert.equal(storedBen.notifications[9].emailStatus,'not_available','dev mode leaves email status not_available');
  const second=await call('POST','/api/schedule/repeat-week',{targetStart:today,assignmentIds:[1,2,3]});
  assert.equal(second.data.created,0,'repeating the same selection creates nothing');assert.equal(second.data.skipped.length,3,'every already-copied row skips cleanly');
  stored=reload();assert.equal(stored.assignments.length,7,'skipped batches leave the schedule untouched');
  stored.timeOffRequests.push({id:1,memberId:8,status:'approved',startDate:targetDates[3],endDate:targetDates[3]});save(stored);
  const leave=await call('POST','/api/schedule/repeat-week',{targetStart:today,assignmentIds:[5]});
  assert.equal(leave.data.created,0);assert.equal(leave.data.skipped.length,1);assert.match(leave.data.skipped[0].reason,/Andi/,'approved time-off names the held-up person');
  stored=reload();stored.timeOffRequests=[];save(stored);
  const midWeek=await call('POST','/api/schedule/repeat-week',{targetStart:targetDates[3],assignmentIds:[5]});
  assert.equal(midWeek.data.created,1,'a mid-week target date is re-anchored to its Sunday');
  assert.equal(midWeek.data.createdRows[0].date,targetDates[3],'the copied row lands on the matching weekday');
  const scoped=await call('POST','/api/schedule/repeat-week',{targetStart:today,assignmentIds:[2]},'synthetic-repeat-pm-scoped');
  assert.equal(scoped.data.created,0);assert.equal(scoped.data.skipped.length,1);assert.equal(scoped.data.skipped[0].reason,'Outside your assigned projects and crews','scoped managers only copy inside their scope');
  const inScope=await call('POST','/api/schedule/repeat-week',{targetStart:today,assignmentIds:[1,5]},'synthetic-repeat-pm-scoped');
  assert.equal(inScope.data.created,0,'in-scope selections still respect duplicate and leave checks');
  assert.ok(inScope.data.skipped.length>=1);
  console.log('Repeat week passed: source window, markup contract, 400/403 gates, copy, duplicate skip, leave skip, re-anchor, PM scope, idempotence.');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true})}})().catch(error=>{console.error(error);process.exitCode=1;server.close()});
