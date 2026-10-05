'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const availability=require('./schedule-availability');
const leave=(id,memberId,startDate,endDate=startDate,status='approved')=>({id,memberId,startDate,endDate,status,type:'sick',note:'Private absence detail',reviewNote:'Private review',history:[]});
const requests=[leave('one',1,'2026-10-10'),leave('range',2,'2026-10-30','2026-11-03'),leave('pending',1,'2026-10-11','2026-10-11','pending'),leave('declined',1,'2026-10-12','2026-10-12','declined')];
const rows=availability.approved(requests,[1,2]);
assert.deepEqual(rows,[{memberId:1,startDate:'2026-10-10',endDate:'2026-10-10'},{memberId:2,startDate:'2026-10-30',endDate:'2026-11-03'}]);
assert.equal(availability.onDate(rows,'1','2026-10-10'),true,'numeric/string member IDs match');
for(const day of ['2026-10-09','2026-10-11','2026-10-12'])assert.equal(availability.onDate(rows,1,day),false);
for(const day of ['2026-10-30','2026-10-31','2026-11-01','2026-11-02','2026-11-03'])assert.equal(availability.onDate(rows,2,day),true,'inclusive range through weekend/DST');
assert.equal(availability.onDate(rows,2,'2026-11-04'),false);
assert.deepEqual(availability.approved([leave('bad',1,'2026-02-30'),leave('back',1,'2026-11-02','2026-10-30')],[1]),[]);
assert.equal(availability.validDate('2028-02-29'),true);
assert.deepEqual(availability.conflicts(rows,[1,2],['2026-10-10','2026-11-01']),{conflictMemberIds:[1,2],conflictDates:['2026-10-10','2026-11-01']});
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-leave-test-'));
process.env.PDL_DB_FILE=path.join(root,'db.json');process.env.PDL_PLATFORM_FILE=path.join(root,'platform.json');process.env.PDL_REQUIRE_AUTH='1';process.env.PDL_SUPABASE_ENABLED='0';process.env.PDL_EMAIL_DEV_MODE='1';delete process.env.RESEND_API_KEY;delete process.env.SENTRY_DSN;
function fixture(id){
 const users=[{id:11,name:'Synthetic Owner',role:'owner',memberId:9},{id:12,name:'Synthetic Scheduler',role:'project_manager',projectIds:[1],assignedCrews:['QA crew'],permissions:{scheduleCrews:true,viewTime:false,manageTime:false}},{id:13,name:'Synthetic Worker',role:'field',memberId:1},{id:14,name:'Synthetic Foreman',role:'foreman',memberId:2}].map(user=>({...user,companyId:id,email:`qa-${user.id}@example.test`,status:'Active',emailVerifiedAt:'2026-01-01T00:00:00Z'}));
 const tokens=new Map(users.map(user=>[user.role,crypto.randomBytes(24).toString('hex')]));
 const db={company:{id,name:'Synthetic availability workspace',timezone:'America/Los_Angeles',demo:true,features:{timeCards:true}},users,team:[{id:1,name:'Synthetic Worker',initials:'SW',role:'Crew lead',crew:'QA crew'},{id:2,name:'Other Worker',initials:'OW',role:'Laborer',crew:'Other crew'},{id:9,name:'Synthetic Owner',initials:'SO',role:'Office',crew:'Office'}],projects:[{id:1,name:'Synthetic project',code:'QA',site:'Test site',estimateItems:[]}],reports:[],assignments:[],customers:[],subcontractors:[],photos:[],workdays:[],changes:[],auditLog:[],timeOffRequests:structuredClone(requests),sessions:users.map(user=>({id:crypto.randomUUID(),userId:user.id,companyId:id,tokenHash:crypto.createHash('sha256').update(tokens.get(user.role)).digest('hex'),expiresAt:'2099-01-01T00:00:00Z'}))};
 return {db,tokens};
}
const primary=fixture('11111111-1111-4111-8111-111111111111'),other=fixture('22222222-2222-4222-8222-222222222222');other.db.timeOffRequests=[];
fs.writeFileSync(process.env.PDL_DB_FILE,JSON.stringify(primary.db));fs.mkdirSync(path.join(root,'tenants'));fs.writeFileSync(path.join(root,'tenants',other.db.company.id+'.json'),JSON.stringify(other.db));
const {server}=require('./server');
(async()=>{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 async function request(route,body,options={}){const tenant=options.tenant||primary,role=options.role||'owner',method=options.method||(body?'POST':'GET'),headers={'Content-Type':'application/json','X-PDL-Company':options.companyId||tenant.db.company.id,Authorization:`Bearer ${tenant.tokens.get(role)}`};const response=await fetch(base+route,{method,headers,...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()}}
 const read=()=>JSON.parse(fs.readFileSync(process.env.PDL_DB_FILE,'utf8'));
 const assignment=(date,memberIds=[1],extra={})=>({projectId:1,memberIds,date,start:'07:00',end:'15:00',activity:'Synthetic work',...extra});
 try{
  for(const role of ['owner','project_manager','field']){const result=await request('/api/schedule-availability',null,{role});assert.equal(result.status,200);assert.equal(result.data.length,role==='owner'?2:1);assert.doesNotMatch(JSON.stringify(result.data),/Private|sick|note|history|status/)}
  let result=await request('/api/state',null,{role:'project_manager'});assert.equal(result.status,200);assert.deepEqual(result.data.scheduleAvailability,[rows[0]]);assert.equal(result.data.timeOffRequests,undefined);
  result=await request('/api/time-off-requests',null,{role:'project_manager'});assert.equal(result.status,403,'schedule permission does not expose private leave details');
  result=await request('/api/schedule-availability',null,{tenant:other});assert.deepEqual(result.data,[],'same member IDs in another tenant do not inherit leave');
  result=await request('/api/schedule-availability',null,{companyId:other.db.company.id});assert.equal(result.status,401,'stale tenant hint cannot switch the authenticated account');
  for(const shift of [{start:'07:00',end:'15:00'},{start:'12:00',end:'12:30'},{start:'00:00',end:'00:15'},{start:'23:30',end:'23:59'}]){result=await request('/api/assignments',assignment('2026-10-10',[1],shift));assert.equal(result.status,409);assert.equal(result.data.code,'approved_time_off_conflict');assert.deepEqual(result.data.conflictDates,['2026-10-10'])}
  assert.equal(read().assignments.length,0,'rejected leave conflicts do not persist');
  result=await request('/api/assignments',assignment('2026-10-09',[1],{endDate:'2026-10-12',includeWeekends:true}));assert.equal(result.status,409);assert.equal(read().assignments.length,0,'range including leave is rejected atomically');
  result=await request('/api/assignments',assignment('2026-10-09',[1],{endDate:'2026-10-12',includeWeekends:false}));assert.equal(result.status,201,'excluded Saturday leave does not reject Friday/Monday');assert.deepEqual(result.data.assignments.map(a=>a.date),['2026-10-09','2026-10-12']);
  const source=result.data.assignments[0];
  for(const role of ['field','foreman']){
   for(const [route,payload,method] of [
    ['/api/assignments',assignment('2026-11-01',[2]),'POST'],
    [`/api/assignments/${source.id}`,{...assignment('2026-11-01',[2]),edit:true},'PATCH'],
    [`/api/assignments/${source.id}`,{memberId:1,targetMemberId:2,date:'2026-11-01'},'PATCH'],
    [`/api/assignments/${source.id}`,{},'DELETE']
   ]){result=await request(route,payload,{role,method});assert.equal(result.status,403);assert.doesNotMatch(JSON.stringify(result.data),/Other Worker|2026-11-01|approved_time_off|conflictDates/,'field mutation cannot act as a private leave oracle')}
  }
  result=await request(`/api/assignments/${source.id}/acknowledge`,{memberId:1},{role:'field'});assert.equal(result.status,200,'field users can still acknowledge their own assignments');
  for(const payload of [{...assignment('2026-11-01',[2]),edit:true},{memberId:1,targetMemberId:2,date:'2026-11-01'}]){result=await request(`/api/assignments/${source.id}`,payload,{role:'project_manager',method:'PATCH'});assert.equal(result.status,403);assert.doesNotMatch(JSON.stringify(result.data),/Other Worker|2026-11-01|approved_time_off/,'PM edit/drag stays inside assigned crews')}

  result=await request(`/api/assignments/${source.id}`,{...assignment('2026-10-10'),edit:true},{method:'PATCH'});assert.equal(result.status,409);assert.equal(read().assignments.find(a=>a.id===source.id).date,'2026-10-09');
  result=await request(`/api/assignments/${source.id}`,{memberId:1,targetMemberId:1,date:'2026-10-10'},{method:'PATCH'});assert.equal(result.status,409);assert.equal(read().assignments.find(a=>a.id===source.id).date,'2026-10-09');
  result=await request(`/api/assignments/${source.id}`,{memberId:1,targetMemberId:2,date:'2026-11-01'},{method:'PATCH'});assert.equal(result.status,409);assert.equal(read().assignments.find(a=>a.id===source.id).memberIds[0],1);
  result=await request('/api/assignments',assignment('2026-10-10',[1]),{role:'project_manager'});assert.equal(result.status,409);
  result=await request('/api/assignments',assignment('2026-11-01',[2]),{role:'project_manager'});assert.equal(result.status,403,'outside-crew scope stays denied');
  result=await request('/api/assignments',assignment('2026-10-11'));assert.equal(result.status,201,'pending leave does not block work');
  result=await request('/api/assignments',assignment('2026-10-10'),{tenant:other});assert.equal(result.status,201,'other tenant is still available');
  result=await request('/api/assignments',assignment('2026-11-02',[2]));assert.equal(result.status,409,'cross-month, DST and week bounds remain inclusive');
  result=await request('/api/time-off-requests/pending/approve',{});assert.equal(result.status,200);assert.ok(read().assignments.some(a=>a.date==='2026-10-11'),'approving leave preserves existing work for explicit reassignment');
  result=await request('/api/schedule-availability');assert.equal(availability.onDate(result.data,1,'2026-10-11'),true,'approval is visible in next schedule refresh');
  result=await request('/api/time-off-requests/one/decline',{});assert.equal(result.status,200);
  result=await request('/api/assignments',assignment('2026-10-10'));assert.equal(result.status,201,'declining leave restores availability');
  result=await request('/api/state');assert.equal(result.status,200);assert.equal(availability.onDate(result.data.scheduleAvailability,1,'2026-10-10'),false);
  const response=await fetch(base+'/schedule-availability.js');assert.equal(response.status,200,'shared browser helper is served by explicit public allowlist');
  console.log('Schedule availability API passed: approved dates, short/full shifts, weekends/ranges/DST, atomic create/edit/drag, pending/declined, existing work preservation, role privacy and tenant isolation.');
 }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});
