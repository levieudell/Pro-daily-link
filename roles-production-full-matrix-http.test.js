'use strict';
// All 32 typed controls through the normal server. Generated current sessions,
// a closed memory repository, no compatibility installer or provider transport.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {canonicalHash}=require('./database/transactional-repository');
const registry=require('./capability-registry'),profiles=require('./role-profiles');
const nativeFetch=globalThis.fetch;let origin,externalCalls=0,providerCalls=0,commits=0,requests=0,beforeCommit=null;
globalThis.fetch=async(input,options)=>{const target=String(input?.url||input);if(!origin||!target.startsWith(origin+'/')){externalCalls++;throw Error('Only the owned generated loopback server is allowed');}return nativeFetch(input,options);};
const supabase=require('./database/supabase');supabase.loadLocalEnv=()=>{};
for(const name of ['upload','download','remove'])supabase[name]=async()=>{providerCalls++;throw Error('No provider or file operation is authorized in this fixture');};
const fixture=require('./roles-production-http.test'),{server,A,B}=fixture;
const transport=supabase.request;supabase.request=async(route,options)=>{const committing=/^\/rest\/v1\/rpc\/commit_roles_snapshot(?:_with_platform)?$/.test(route);if(committing&&beforeCommit){const hook=beforeCommit;beforeCommit=null;await hook();}const result=await transport(route,options);if(committing)commits++;return result;};
const ownedDirectory=path.resolve(path.dirname(process.env.PDL_DB_FILE));
assert.ok(ownedDirectory.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(ownedDirectory).startsWith('pdl-roles-production-http-'));
const policyNames={scheduling:'scheduling',timeOff:'timeOff',timeReview:'timeReview',timeWrite:'timeWrite',daily:'daily',notes:'notes'};
const PERIOD='72000000-0000-4000-8000-000000000001',NOTE='72000000-0000-4000-8000-000000000002',LEAVE='72000000-0000-4000-8000-000000000003';
const epoch='2026-10-01T00:00:00.000Z',today=new Date().toISOString().slice(0,10);
const baseline=fixture.read();baseline.company.timezone='UTC';baseline.company.features={timeCards:true,templates:false};
baseline.team.push({id:13,name:'Synthetic Foreman',crew:'Synthetic Crew',role:'Foreman',email:'foreman@example.invalid',hours:0},{id:14,name:'Synthetic Coworker',crew:'Synthetic Crew',role:'Field',hours:0},{id:15,name:'Synthetic Foreign Crew',crew:'Other Crew',role:'Field',hours:0});
for(const [id,role,memberId]of [[4,'project_manager',null],[5,'foreman',13]]){const user={...baseline.users.find(row=>row.id===3),id,role,memberId,name:'Synthetic '+role,email:role+'@example.invalid',projectIds:role==='project_manager'?[101]:[],assignedCrews:role==='project_manager'?['Synthetic Crew']:[],permissions:{scheduleCrews:true,viewTime:true,manageTime:true,viewDailies:true,approveDailies:true}};baseline.users.push(user);const token=crypto.randomBytes(32).toString('base64url');fixture.tokens.set(id,token);baseline.sessions.push({id:crypto.randomUUID(),companyId:A,userId:id,tokenHash:crypto.createHash('sha256').update(token).digest('hex'),createdAt:epoch,expiresAt:'2099-01-01T00:00:00.000Z'});}
baseline.users.find(row=>row.id===3).permissions={manageTime:true,viewTime:true};
baseline.projects[0].customerId=21;baseline.projects[0].templateId=null;
baseline.projects.push({id:102,name:'Synthetic Foreign Project',customerId:21,customer:0,status:'Active',estimateItems:[]});
baseline.assignments=[{id:1,projectId:101,memberIds:[12],crew:'Synthetic Crew',date:today,start:'08:00',end:'10:00',activity:'Synthetic own shift',acknowledgements:{},notifications:{}}];
baseline.reports=[{...baseline.reports[0],status:'Draft',rateSnapshot:undefined,workdayId:null,history:[],dateIso:'2026-10-01'}];delete baseline.reports[0].rateSnapshot;
baseline.workdays=[{id:1,projectId:101,memberIds:[12],crew:'Synthetic Crew',date:'2026-09-30',status:'ended',startedAt:'2026-09-30T08:00:00.000Z',endedAt:'2026-09-30T10:00:00.000Z',reportId:null}];
baseline.timeCards=[{id:1,companyId:A,memberId:12,projectId:101,date:'2026-10-02',inAt:'2026-10-02T08:00:00.000Z',outAt:'2026-10-02T10:00:00.000Z',hours:2,status:'draft',workdayId:null,reportId:null,history:[]}];
baseline.timeOffRequests=[{id:LEAVE,companyId:A,memberId:12,startDate:'2098-12-20',endDate:'2098-12-20',allDay:true,type:'vacation',note:'Synthetic own leave',status:'pending',requestedAt:epoch,history:[]}];
baseline.payPeriods=[{id:PERIOD,companyId:A,label:'Synthetic empty period',from:'2026-09-01',to:'2026-09-02',timeZone:'UTC',status:'open',createdAt:epoch,updatedAt:epoch}];baseline.payPeriodExports=[];
const content={text:'Synthetic shared todo',completed:false,dueDate:null,revision:1};
baseline.projectNotesTodos=[{id:NOTE,companyId:A,projectId:101,kind:'todo',...content,createdByUserId:1,updatedByUserId:1,createdBy:baseline.users[0].name,updatedBy:baseline.users[0].name,createdAt:epoch,updatedAt:epoch,requestId:'synthetic-note-seed',history:[{userId:1,action:'create',by:baseline.users[0].name,at:epoch,before:null,after:structuredClone(content)}]}];
baseline.companyActivities=[{id:'company-1',name:'Synthetic company time',active:true}];
function reset(change=()=>{}){fixture.alter(db=>{for(const key of Object.keys(db))delete db[key];Object.assign(db,structuredClone(baseline));change(db);});}
function defaults(db){for(const[family,,,,controller]of registry.families){db.company[policyNames[family]+'RolePolicy']={version:1,revision:1,roles:Object.fromEntries(registry.roles.map(role=>[role,controller.ceiling(role)]))};db.company[policyNames[family]+'PolicyRequired']=true;}return db;}
function disable(flags,family,action){flags[action]=false;if((family==='scheduling'||family==='notes')&&action==='view')for(const name of Object.keys(flags))flags[name]=false;if(family==='timeOff'&&action==='viewRequests')flags.createRequest=false;if(family==='timeReview'&&action==='viewCards'){flags.approveCards=false;flags.unapproveCards=false;}if(family==='timeWrite'&&action==='viewPayroll')for(const name of ['configurePeriods','captureExports','downloadExports'])flags[name]=false;if(family==='daily'&&action==='viewReports')for(const name of ['createReports','editReports','approveReports','runWorkdays'])flags[name]=false;if(family==='daily'&&['createReports','viewWorkdays'].includes(action))flags.runWorkdays=false;}
function restricted(db,family,action,userId,profile){const user=db.users.find(row=>row.id===userId);if(profile){const capabilities=profiles.defaults(user.role);disable(capabilities[family],family,action);const id=crypto.randomUUID(),created=profiles.plan(db,{operation:'create',profileId:id,name:'Synthetic current limits',baseRole:user.role,capabilities}),assigned=profiles.plan(created,{operation:'assign',accountId:user.id,profileId:id});Object.assign(db,assigned);}else{defaults(db);const controller=registry.families.find(row=>row[0]===family)[4];disable(db.company[policyNames[family]+'RolePolicy'].roles[user.role],family,action);controller.validatePolicy(db.company[policyNames[family]+'RolePolicy']);}}
const cases=[
 ['scheduling.view','GET','/api/state',null,3,'assignments'],
 ['scheduling.create','POST','/api/assignments',{projectId:101,memberIds:[12],crew:'Synthetic Crew',date:'2098-11-03',start:'08:00',end:'10:00',activity:'Synthetic new shift'},3],
 ['scheduling.edit','PATCH','/api/assignments/1',{edit:true,projectId:101,memberIds:[12],crew:'Synthetic Crew',date:today,start:'09:00',end:'11:00',activity:'Synthetic correction'},3],
 ['scheduling.remove','DELETE','/api/assignments/1',{},3],
 ['scheduling.acknowledge','POST','/api/assignments/1/acknowledge',{},2],
 ['timeOff.viewRequests','GET','/api/time-off-requests',null,2],
 ['timeOff.createRequest','POST','/api/time-off-requests',{startDate:'2098-11-10',endDate:'2098-11-10',allDay:true,type:'vacation',note:'Synthetic own request',requestId:crypto.randomUUID()},2],
 ['timeReview.viewCards','GET','/api/time-cards',null,3],
 ['timeReview.reviewLeave','POST','/api/time-off-requests/'+LEAVE+'/approve',{note:'Synthetic current decision'},3],
 ['timeReview.approveCards','POST','/api/time-cards/1/approve',{},3],
 ['timeReview.unapproveCards','POST','/api/time-cards/1/unapprove',{},3],
 ['timeWrite.createCards','POST','/api/time-cards',{memberId:12,projectId:101,inAt:'2098-11-03T08:00:00.000Z',outAt:'2098-11-03T10:00:00.000Z',reason:'Synthetic manual entry'},3],
 ['timeWrite.correctCards','PATCH','/api/time-cards/1',{inAt:'2026-10-02T08:15:00.000Z',outAt:'2026-10-02T10:00:00.000Z',reason:'Synthetic correction'},3],
 ['timeWrite.removeCards','DELETE','/api/time-cards/1',{reason:'Synthetic duplicate'},3],
 ['timeWrite.submitCards','POST','/api/time-cards/1/submit',{},3],
 ['timeWrite.clockCards','POST','/api/time-cards/company-clock',{activityCodeId:'company-1'},2],
 ['timeWrite.downloadCards','GET','/api/time-cards.csv',null,3],
 ['timeWrite.viewPayroll','GET','/api/pay-periods',null,3],
 ['timeWrite.configurePeriods','POST','/api/pay-periods',{label:'Synthetic new period',from:'2098-11-01',to:'2098-11-02'},3],
 ['timeWrite.captureExports','POST','/api/pay-periods/'+PERIOD+'/exports',{},3],
 ['timeWrite.downloadExports','GET','/api/pay-periods/'+PERIOD+'/exports',null,3],
 ['timeWrite.viewActivities','GET','/api/company-activities',null,3],
 ['daily.viewReports','GET','/api/state',null,3,'reports'],
 ['daily.createReports','POST','/api/reports',{projectId:101,dateIso:'2098-11-03',status:'Draft',notes:'Synthetic current work',foreman:'Synthetic Field',signature:'Synthetic Field',crew:'Synthetic Crew',productionEntries:[],laborEntries:[]},3],
 ['daily.editReports','PATCH','/api/reports/1',{status:'Draft',notes:'Synthetic correction'},3],
 ['daily.approveReports','PATCH','/api/reports/1/approve',{},3],
 ['daily.viewWorkdays','GET','/api/state',null,3,'workdays'],
 ['daily.runWorkdays','POST','/api/workdays/start',{projectId:101,memberIds:[12],startNote:'Synthetic start'},3],
 ['notes.view','GET','/api/projects/101/notes-todos',null,3],
 ['notes.create','POST','/api/projects/101/notes-todos',{kind:'todo',text:'Synthetic new todo',dueDate:'2098-11-03',requestId:crypto.randomUUID()},3],
 ['notes.edit','PATCH','/api/projects/101/notes-todos/'+NOTE,{revision:1,text:'Synthetic corrected todo'},3],
 ['notes.complete','PATCH','/api/projects/101/notes-todos/'+NOTE,{revision:1,completed:true},3]
];
assert.deepEqual(cases.map(row=>row[0]),registry.families.flatMap(([id,,,,controller])=>controller.actions.map(action=>id+'.'+action)));
function prepare(db,name){if(name==='timeReview.approveCards')db.timeCards[0].status='submitted';if(name==='timeReview.unapproveCards'){db.timeCards[0].status='approved';db.timeCards[0].approvedAt=epoch;db.timeCards[0].approvedBy='Synthetic Owner';}}
const outcomes=[];
async function call(method,route,data,userId=3,tenant=A){requests++;const before=canonicalHash(fixture.read()),writes=commits,effects=providerCalls;const response=await fetch(origin+route,{method,signal:AbortSignal.timeout(12000),headers:{'X-PDL-Company':tenant,'X-PDL-Operation':crypto.randomUUID(),Authorization:'Bearer '+fixture.tokens.get(userId),'Content-Type':'application/json'},...(data===null||data===undefined?{}:{body:JSON.stringify(data)})});const raw=await response.text();let value;try{value=JSON.parse(raw);}catch{value=raw;}const result={status:response.status,value,unchanged:canonicalHash(fixture.read())===before,commits:commits-writes,providerCalls:providerCalls-effects};outcomes.push({method,route,userId,status:result.status,commits:result.commits,providerCalls:result.providerCalls,unchanged:result.unchanged});return result;}
function noEffects(result,label){assert.equal(result.unchanged,true,label+' changed tenant');assert.equal(result.commits,0,label+' committed');assert.equal(result.providerCalls,0,label+' reached provider');}
async function main(){
 let actionChecks=0,maskChecks=0,scopeChecks=0,profileLifecycleChecks=0,financialBoundaryChecks=0;const failures=[];
 const watched=['server.js','roles-production.js','roles-production-guards.js','roles-daily-baseline.js','role-profiles.js','roles-production-full-matrix-http.test.js'],hashes=()=>Object.fromEntries(watched.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,f))).digest('hex')])),opening=hashes();
 try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin='http://127.0.0.1:'+server.address().port;
  if(process.argv.includes('--probe-time-scope')){reset();const own=await call('POST','/api/time-cards',cases[11][3],4);reset();const foreign=await call('POST','/api/time-cards',{...cases[11][3],memberId:15},4);console.log(JSON.stringify({probe:'no-policy PM manual time-card scope',own,foreign,actor:{role:'project_manager',storedManageTime:true,projectIds:[101],assignedCrews:['Synthetic Crew']},normalServer:true,testInstallerUsed:false,providerCalls,externalCalls,sourceStable:canonicalHash(opening)===canonicalHash(hashes()),sourceHashes:hashes(),outcomes},null,2));assert.equal(own.status,201);assert.equal(foreign.status,403,'No-policy PM creation must retain the original assigned-crew floor');noEffects(foreign,'No-policy PM foreign crew');return;}
  if(process.argv.includes('--probe-contract-feature')){const responses=[];for(const method of ['PATCH','PUT']){reset(db=>{db.company.contractValueTracking=false;});responses.push({method,result:await call(method,'/api/projects/101',{contractValue:123},1)});}console.log(JSON.stringify({probe:'contract-value feature disabled method parity',responses,normalServer:true,testInstallerUsed:false,providerCalls,externalCalls,sourceStable:canonicalHash(opening)===canonicalHash(hashes()),sourceHashes:hashes()},null,2));for(const response of responses){assert.equal(response.result.status,409,'Feature-off '+response.method+' must retain the same fixed boundary');noEffects(response.result,'Feature-off '+response.method);}return;}
  for(const phase of ['no-policy','default-policy','role-mask','custom-profile'])for(const [name,method,route,data,userId,list]of cases){
   const[family,action]=name.split('.'),blocked=phase==='role-mask'||phase==='custom-profile';
   reset(db=>{prepare(db,name);if(phase==='default-policy')defaults(db);if(blocked)restricted(db,family,action,userId,phase==='custom-profile');});
   const originalGrants=structuredClone(fixture.read().users.map(({id,role,memberId,projectIds,assignedCrews,permissions})=>({id,role,memberId,projectIds,assignedCrews,permissions})));
   const result=await call(method,route,data,userId),label=phase+' '+name;
   try{
    if(blocked){if(list){assert.equal(result.status,200,label+': '+JSON.stringify(result.value));assert.deepEqual(result.value[list],[],label+' projection');}else assert.ok([403,404].includes(result.status),label+': '+JSON.stringify(result.value));noEffects(result,label);maskChecks++;}
    else{assert.ok([200,201].includes(result.status),label+': '+JSON.stringify(result.value));if(list)assert.ok(result.value[list].length>0,label+' must prove a visible positive source');if(method==='GET')noEffects(result,label);else assert.equal(result.commits,1,label+' must execute exactly one business CAS');actionChecks++;}
    assert.deepEqual(fixture.read().users.map(({id,role,memberId,projectIds,assignedCrews,permissions})=>({id,role,memberId,projectIds,assignedCrews,permissions})),originalGrants,label+' rewrote stored authority');
   }catch(error){failures.push({phase,control:name,method,route,userId,status:result.status,response:result.value,error:error.message});}
   outcomes[outcomes.length-1].phase=phase;outcomes[outcomes.length-1].control=name;
  }
  // Persisted original grants and exact scope remain floors with defaults on.
  for(const [label,alter,method,route,data,user,status]of[
   ['PM missing stored schedule grant',db=>{defaults(db);db.users.find(u=>u.id===4).permissions.scheduleCrews=false;},'POST','/api/assignments',cases[1][3],4,403],
   ['PM foreign scheduling project',defaults,'POST','/api/assignments',{...cases[1][3],projectId:102},4,403],
   ['PM foreign scheduling crew',defaults,'POST','/api/assignments',{...cases[1][3],memberIds:[15]},4,403],
   ['PM foreign time-card project',defaults,'POST','/api/time-cards',{...cases[11][3],projectId:102},4,403],
   ['PM foreign time-card member',defaults,'POST','/api/time-cards',{...cases[11][3],memberId:15},4,403],
   ['no-policy PM foreign time-card member',()=>{},'POST','/api/time-cards',{...cases[11][3],memberId:15},4,403],
   ['time feature cannot be granted by default policy',db=>{defaults(db);db.company.features.timeCards=false;},'POST','/api/time-cards',cases[11][3],3,403],
   ['fresh role change blocks Office schedule',db=>{defaults(db);const u=db.users.find(u=>u.id===3);u.role='field';u.memberId=12;},'POST','/api/assignments',cases[1][3],3,403],
   ['current inactive actor loses session',db=>{db.users.find(u=>u.id===3).status='Inactive';},'GET','/api/state',null,3,401],
   ['cross-tenant hint',()=>{},'GET','/api/state',null,3,404]
  ]){reset(alter);const result=await call(method,route,data,user,label==='cross-tenant hint'?B:A);assert.equal(result.status,status,label+': '+JSON.stringify(result.value));noEffects(result,label);outcomes[outcomes.length-1].boundary=label;scopeChecks++;}
  reset(db=>{defaults(db);db.company.schedulingRolePolicy.roles.admin.create='true';});
  const invalid=await call('POST','/api/assignments',cases[1][3]);assert.equal(invalid.status,403);noEffects(invalid,'invalid policy');
  const owner=await call('POST','/api/assignments',cases[1][3],1);assert.equal(owner.status,201,'Immutable Owner retains recovery/work authority');scopeChecks+=2;
  // The actual leave decision remains usable for Owner/Admin and a scoped PM.
  for(const userId of [1,3,4]){reset(defaults);const result=await call('POST','/api/time-off-requests/'+LEAVE+'/approve',{note:'Synthetic scoped review'},userId);assert.equal(result.status,200,'Current leave-review positive '+userId+': '+JSON.stringify(result.value));assert.equal(result.commits,1);assert.equal(fixture.read().timeOffRequests[0].status,'approved');outcomes[outcomes.length-1].boundary='Owner/Admin/scoped PM current leave-review positive';scopeChecks++;}
  reset(db=>{defaults(db);db.timeOffRequests[0].memberId=15;});const foreignLeave=await call('POST','/api/time-off-requests/'+LEAVE+'/approve',{note:'Synthetic foreign crew'},4);assert.equal(foreignLeave.status,404);noEffects(foreignLeave,'PM foreign leave crew');outcomes[outcomes.length-1].boundary='PM foreign leave crew';scopeChecks++;
  reset(defaults);let currentAfterRevoke;beforeCommit=async()=>{fixture.alter(db=>{const actor=db.users.find(row=>row.id===3);actor.role='field';actor.memberId=12;});currentAfterRevoke=fixture.read();};
  const stale=await call('POST','/api/assignments',cases[1][3],3);assert.equal(stale.status,409,'Real normal request reaching memory CAS must reject concurrent role revocation');assert.equal(stale.commits,0);assert.equal(stale.providerCalls,0);assert.equal(canonicalHash(fixture.read()),canonicalHash(currentAfterRevoke),'Stale business candidate must not restore actor or add an assignment');outcomes[outcomes.length-1].boundary='Persisted current role revocation at actual normal memory CAS';scopeChecks++;
  // Profile management itself must use the real current Owner review routes,
  // separately from earlier valid persisted-profile enforcement fixtures.
  reset();const originalUsers=structuredClone(fixture.read().users),profileId=crypto.randomUUID(),limits=profiles.defaults('admin');limits.notes.create=false;
  const adminDenied=await call('POST','/api/company/role-policy/profiles/preview',{requestId:crypto.randomUUID(),expectedRevision:0,reason:'Synthetic forbidden policy change',profileChange:{operation:'create',profileId,name:'Forbidden profile',baseRole:'admin',capabilities:limits}},3);assert.equal(adminDenied.status,403);noEffects(adminDenied,'Admin profile management');profileLifecycleChecks++;
  async function profilePreview(profileChange){const current=await call('GET','/api/company/role-policy',null,1);assert.equal(current.status,200);const preview=await call('POST','/api/company/role-policy/profiles/preview',{requestId:crypto.randomUUID(),expectedRevision:current.value.tenantRevision,reason:'Synthetic finite profile review',profileChange},1);assert.equal(preview.status,200,JSON.stringify(preview.value));assert.equal(preview.commits,1);return {previewId:preview.value.previewId,version:preview.value.version,requestId:crypto.randomUUID(),confirmed:true};}
  async function profileConfirm(envelope){const result=await call('POST','/api/company/role-policy/confirm',envelope,1);assert.equal(result.status,200,JSON.stringify(result.value));assert.equal(result.value.committed,true);return result;}
  const created=await profilePreview({operation:'create',profileId,name:'Synthetic finite profile',baseRole:'admin',capabilities:limits});
  assert.equal(fixture.read().company.roleProfiles,undefined,'Preview cannot create a profile or assign an account');
  const unchecked=await call('POST','/api/company/role-policy/confirm',{...created,confirmed:false},1);assert.equal(unchecked.status,400);noEffects(unchecked,'Unchecked current Owner profile confirmation');profileLifecycleChecks++;
  const first=await profileConfirm(created);assert.equal(first.commits,1);assert.equal(fixture.read().company.roleProfiles.profiles.length,1);assert.deepEqual(fixture.read().company.roleProfiles.assignments,[]);assert.deepEqual(fixture.read().users,originalUsers,'Profile creation assigns nobody and retains original grants/scopes');profileLifecycleChecks++;
  const originalReplay=await profileConfirm(created);for(const field of ['requestId','previewId','version','policyRevision'])assert.equal(originalReplay.value[field],first.value[field],'Replay must return the exact original technical '+field);noEffects(originalReplay,'Original confirmed profile receipt replay');profileLifecycleChecks++;
  const assignment=await profilePreview({operation:'assign',accountId:3,profileId});await profileConfirm(assignment);assert.deepEqual(fixture.read().users,originalUsers,'Assignment cannot rewrite the base role or stored grants');
  const deniedCreate=await call('POST','/api/projects/101/notes-todos',cases[29][3],3);assert.equal(deniedCreate.status,403);noEffects(deniedCreate,'Current assigned profile notes-create restriction');profileLifecycleChecks++;
  const incompatible=await call('PATCH','/api/users/3',{role:'project_manager'},1);assert.equal(incompatible.status,409,'Assigned profile blocks an incompatible base-role change');noEffects(incompatible,'Current assigned profile base-role change');profileLifecycleChecks++;
  const edited=structuredClone(limits);edited.notes.complete=false;const change=await profilePreview({operation:'edit',profileId,expectedProfileRevision:1,name:'Synthetic revised limits',capabilities:edited});await profileConfirm(change);
  const deniedComplete=await call('PATCH','/api/projects/101/notes-todos/'+NOTE,{revision:1,completed:true},3);assert.equal(deniedComplete.status,403);noEffects(deniedComplete,'Fresh assigned profile edit restricts completion');profileLifecycleChecks++;
  const assignedDelete=await call('POST','/api/company/role-policy/profiles/preview',{requestId:crypto.randomUUID(),expectedRevision:(await call('GET','/api/company/role-policy',null,1)).value.tenantRevision,reason:'Synthetic invalid assigned retirement',profileChange:{operation:'delete',profileId,expectedProfileRevision:2}},1);assert.equal(assignedDelete.status,409);noEffects(assignedDelete,'Assigned profile cannot be retired');profileLifecycleChecks++;
  const unassign=await profilePreview({operation:'assign',accountId:3,profileId:null});await profileConfirm(unassign);assert.deepEqual(fixture.read().users,originalUsers,'Unassignment retains original role/grants');
  const restored=await call('POST','/api/projects/101/notes-todos',cases[29][3],3);assert.equal(restored.status,201,'Unassignment restores existing notes authority');assert.equal(restored.commits,1);profileLifecycleChecks++;
  const retirement=await profilePreview({operation:'delete',profileId,expectedProfileRevision:2});await profileConfirm(retirement);assert.deepEqual(fixture.read().company.roleProfiles.profiles,[]);assert.deepEqual(fixture.read().company.roleProfiles.assignments,[]);profileLifecycleChecks++;
  for(const method of ['PATCH','PUT']){
   for(const userId of [1,3]){reset(db=>{db.company.contractValueTracking=false;});const disabled=await call(method,'/api/projects/101',{contractValue:123},userId);assert.equal(disabled.status,409,'Feature-off '+method+' actor'+userId);noEffects(disabled,'Fixed contract-value feature floor');outcomes[outcomes.length-1].boundary='Contract-value disabled '+method;financialBoundaryChecks++;
    reset(db=>{db.company.contractValueTracking=true;});const enabled=await call(method,'/api/projects/101',{contractValue:123},userId);assert.equal(enabled.status,200,'Enabled fixed-authority '+method+' actor'+userId+': '+JSON.stringify(enabled.value));assert.equal(enabled.commits,1);assert.equal(fixture.read().projects[0].contractValue,123);outcomes[outcomes.length-1].boundary='Contract-value enabled '+method;financialBoundaryChecks++;}
   for(const userId of [2,4]){reset(db=>{defaults(db);db.company.contractValueTracking=true;});const denied=await call(method,'/api/projects/101',{contractValue:123},userId);assert.equal(denied.status,403,'Typed defaults and PM pricing cannot grant financial '+method);noEffects(denied,'Fixed financial role floor');outcomes[outcomes.length-1].boundary='Field/PM immutable financial '+method;financialBoundaryChecks++;}
  }
  assert.equal(externalCalls,0);assert.equal(providerCalls,0);const closing=hashes(),sourceStable=canonicalHash(opening)===canonicalHash(closing);assert.equal(sourceStable,true,'Watched source changed during this run');
  console.log(JSON.stringify({passed:failures.length===0,controls:cases.length,phases:['no-policy','default-policy','role-mask','custom-profile'],actionChecks,maskChecks,scopeChecks,profileLifecycleChecks,financialBoundaryChecks,requests,commits,providerCalls,externalCalls,normalServer:true,testInstallerUsed:false,realDatabaseConnections:0,sourceStable,sourceHashes:closing,failures,outcomes},null,2));
  assert.deepEqual(failures,[],'Every actual normal positive/restriction case must pass; collected failures stay fatal.');
 }finally{beforeCommit=null;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));globalThis.fetch=nativeFetch;assert.ok(fs.realpathSync(ownedDirectory)===ownedDirectory);fs.rmSync(ownedDirectory,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
