'use strict';
// Actual current server auth assembly plus the assistant handler. The synthetic
// restriction callback below is a contract test, not a live role-policy module.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const {fixture,companyA,companyB,token}=require('./fixtures/project-assistant');
const {createProjectAssistantHandler}=require('./project-assistant');
const source=fs.readFileSync('server.js','utf8'),start=source.indexOf('function authenticateRequestAccount('),end=source.indexOf('function projectNotesUser(',start);
assert.ok(start>=0&&end>start);
const context={crypto,bearer:req=>req.token,cookie:()=>null,schedulingAccess:require('./scheduling-access'),dbContext:new(require('node:async_hooks').AsyncLocalStorage)()};vm.createContext(context);vm.runInContext(source.slice(start,end),context);
const authenticate=context.authenticateRequestAccount;
const single={action:'schedule',memberId:11,date:'2098-10-12',start:'08:00',end:'16:00',timezone:'America/Los_Angeles',activity:'Frame',instructions:'Check layout'};
const batch={action:'schedule_batch',memberIds:[11,12],startDate:'2098-10-12',endDate:'2098-10-13',weekdays:[0,1,2,3,4,5,6],start:'08:00',end:'16:00',timezone:'America/Los_Angeles',activity:'Frame',instructions:'Check layout each day'};
const note={action:'note',text:'Synthetic gate instructions',deadline:'none',dueDate:'',timezone:'America/Los_Angeles'},todo={...note,action:'todo'};
async function main(){
  let db=fixture(),writes=0,restrict=user=>user;
  const handle=createProjectAssistantHandler({readDb:()=>db,writeDb:()=>writes++,body:async req=>req.input,now:()=>new Date('2098-10-07T16:00:00Z'),json:(res,status,data)=>Object.assign(res,{status,data}),authenticatedUser(req,currentDb){const result=authenticate(req,currentDb);if(!result.auth)return null;const effective=restrict(result.auth.user);req.auth={...result.auth,user:effective};return req.auth.user;}});
  async function call(action,input,project=101){const req={method:action==='context'?'GET':'POST',input,token:token(companyA,2),auth:{user:{id:1,role:'owner',permissions:{scheduleCrews:true}}}},res={};await handle(req,res,new URL(`http://localhost/api/projects/${project}/assistant/${action}`));return{...res,req};}
  const stale={token:token(companyA,2),auth:{user:{role:'owner'}}};assert.equal(authenticate(stale,db).auth.user.role,'project_manager');assert.equal(stale.auth.user.id,2,'fresh authenticated actor replaces inherited authority');
  for(const change of [current=>current.users.find(row=>row.id===2).status='Inactive',current=>current.sessions.find(row=>row.userId===2).expiresAt='2000-01-01']){const current=fixture();change(current);const req={token:token(companyA,2),auth:{user:{role:'owner'}}};assert.equal(authenticate(req,current).status,401);assert.equal(req.auth,null);}
  const foreign=fixture();foreign.sessions.find(row=>row.userId===2).companyId=companyB;const foreignReq={token:token(companyA,2),auth:{user:{role:'owner'}}};assert.equal(authenticate(foreignReq,foreign).status,404);assert.equal(foreignReq.auth,null);
  const legacy=fixture();legacy.users.find(row=>row.id===2).role='office';assert.equal(authenticate({token:token(companyA,2)},legacy).auth.user.role,'admin');
  for(const proposal of [single,batch]){
    db=fixture();writes=0;restrict=user=>user;const preview=(await call('preview',proposal)).data,confirmation={token:preview.token,version:preview.version,confirmed:true};assert.ok(preview.token);
    restrict=user=>({...user,permissions:{...user.permissions,scheduleCrews:false}});assert.equal(db.users.find(row=>row.id===2).permissions.scheduleCrews,true,'stored grant retained');const limited=await call('context');assert.equal(limited.data.capabilities.schedule,false);assert.equal(limited.req.auth.user.permissions.scheduleCrews,false);assert.equal((await call('preview',proposal)).status,403);assert.equal((await call('confirm',confirmation)).status,403);assert.equal(writes,0);
    restrict=user=>user;const saved=await call('confirm',confirmation);assert.equal(saved.status,201);assert.equal(writes,1);restrict=user=>({...user,permissions:{scheduleCrews:false}});assert.equal((await call('confirm',confirmation)).status,403,'effective restriction applies to durable replay');assert.equal(writes,1);
    restrict=user=>({...user,projectIds:[]});assert.equal((await call('confirm',confirmation)).status,404,'effective project scope applies before receipt lookup');assert.equal(writes,1);
  }
  for(const proposal of [note,todo]){
    db=fixture();writes=0;restrict=user=>({...user,permissions:{scheduleCrews:false}});const preview=(await call('preview',proposal)).data;assert.ok(preview.token,'existing project-note authority does not require scheduling permission');const confirmation={token:preview.token,version:preview.version,confirmed:true};restrict=user=>({...user,role:'field'});assert.equal((await call('confirm',confirmation)).status,403);assert.equal(writes,0);restrict=user=>({...user,permissions:{scheduleCrews:false}});assert.equal((await call('confirm',confirmation)).status,201);assert.equal(writes,1);restrict=user=>({...user,projectIds:[]});assert.equal((await call('confirm',confirmation)).status,404);assert.equal(writes,1);
  }
  db=fixture();writes=0;restrict=user=>user;const pending=(await call('preview',batch)).data;restrict=user=>({...user,permissions:{...user.permissions,viewDailies:false}});assert.equal((await call('confirm',{token:pending.token,version:pending.version,confirmed:true})).status,409,'any effective permission version change requires a fresh reviewed proposal');assert.equal(writes,0);
  console.log('Current-main assistant auth contract passed: actual fresh session/tenant assembly, stale actor clearing, normalization, returned effective restrictions for single/batch/notes/to-do/replay, and changed-permission proposal invalidation. No runtime role overlay imported.');
}
main().catch(error=>{console.error(error);process.exitCode=1});
