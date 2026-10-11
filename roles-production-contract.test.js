'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),{AsyncLocalStorage}=require('node:async_hooks'),vm=require('node:vm'),fs=require('node:fs');
const {createService}=require('./roles-production'),{canonicalHash}=require('./database/transactional-repository'),{workspaceSnapshot}=require('./compat-workspace-fixture'),{A}=require('./compat-account-fixture');
const registry=require('./capability-registry');
let checks=0;
const setPolicy=(db,id,flags,role='admin')=>{const row=registry.families.find(row=>row[0]===id);db.company[row[2]+'PolicyRequired']=true;db.company[row[2]+'RolePolicy']={version:1,revision:1,roles:Object.fromEntries(row[4].roles.map(id=>[id,row[4].ceiling(id)]))};Object.assign(db.company[row[2]+'RolePolicy'].roles[role],flags);};
function fixture(){
 let db=workspaceSnapshot(),revision=0,dispatches=0,hook=null;const context=new AsyncLocalStorage();
 const transport={configured:()=>true,request:async(path,options)=>{
  if(path.startsWith('/rest/v1/companies?'))return new Response(JSON.stringify([{data:structuredClone(db),roles_managed:true,roles_revision:revision}]));
  assert.equal(path,'/rest/v1/rpc/commit_roles_snapshot');const input=JSON.parse(options.body);if(hook)await hook();if(input.p_expected_revision!==revision||Date.parse(input.p_deadline)<=Date.now())throw Error('PDL_REVISION_CONFLICT');db=structuredClone(input.p_snapshot);return new Response(JSON.stringify([{revision:++revision}]));
 }};
 const h={transport,transactionalMode:()=> 'off',context:()=>context.getStore(),run:(ctx,task)=>context.run(ctx,task),accountAccess:()=>({locked:false}),canAccessProject:()=>true,body:async req=>req.input||{},readDb:()=>context.getStore().db,writeDb:value=>service.stage(context.getStore(),value),authenticate:()=>({status:401}),json:(res,status,data)=>{context.getStore().response={status,data};},flush:(res,ctx)=>{res.status=ctx.response.status;res.data=ctx.response.data;},api:null};
 const service=createService(h,{PDL_ROLES_COMPANIES:A,PDL_REQUIRE_AUTH:'1',PDL_ROLE_POLICY_KEY:'a'.repeat(64)});
 async function call(api,{route='/api/auth/forgot',operation=crypto.randomUUID()}={}){h.api=api;const req={method:'POST',headers:{'x-pdl-operation':operation},input:{}},res={setHeader(){},writeHead(status){this.status=status;},end(raw){this.raw=raw;}};await service.handle(req,res,new URL(route,'http://synthetic.invalid'),{db:structuredClone(db)});return res;}
 return {service,h,call,get db(){return db;},set db(value){db=value;},get revision(){return revision;},set revision(value){revision=value;},get dispatches(){return dispatches;},dispatch:async()=>{dispatches++;return {ok:true};},set hook(value){hook=value;}};
}
async function provider(){
 let f=fixture();const dispatch=()=>f.service.effect('ai',{method:'POST',path:'/v1/responses',bodyHash:'b'.repeat(64)},f.dispatch);
 const invoke=async(req,res)=>{await dispatch();f.h.json(res,200,{ok:true});};
 await f.call(invoke);await f.call(invoke);assert.equal(f.dispatches,2,'A new accepted identical AI request is a new operation');checks++;
 const op=crypto.randomUUID();await f.call(invoke,{operation:op});const repeat=await f.call(invoke,{operation:op});assert.equal(repeat.status,409);assert.equal(f.dispatches,3,'An original operation cannot dispatch twice');checks+=2;
 f=fixture();let tokens=0;const email=async(req,res)=>{const db=f.h.readDb(),user=db.users[0];user.resetTokenHash='synthetic'+(++tokens);user.resetExpiresAt='2099-01-01T00:00:00.000Z';f.h.writeDb(db);try{const result=await f.service.effect('email',{credentialScope:'c'.repeat(64),bodyHash:'random'+tokens},async()=>({ok:false}));if(!result.ok)throw Error('Rejected');}catch{delete user.resetTokenHash;delete user.resetExpiresAt;f.h.writeDb(db);f.h.json(res,502,{error:'Rejected'});}};
 assert.equal((await f.call(email)).status,502);assert.equal(f.db.users[0].resetTokenHash,undefined,'Known rejection removes only its issued credential');assert.equal(f.db.rolesProviderAttempts[0].status,'rejected');checks+=3;
 f=fixture();let sends=0;const uncertain=async(req,res)=>{const db=f.h.readDb();db.users[0].resetTokenHash='token'+(++tokens);db.users[0].resetExpiresAt='2099-01-01T00:00:00.000Z';f.h.writeDb(db);await f.service.effect('email',{credentialScope:'c'.repeat(64),bodyHash:'random'+tokens},async()=>{sends++;throw Error('Unknown transport');});f.h.json(res,200,{ok:true});};
 assert.equal((await f.call(uncertain)).status,503);const original=f.db.users[0].resetTokenHash;
 const denied=await f.call(uncertain);assert.equal(denied.status,409);assert.equal(sends,1,'Unknown credential delivery cannot rotate and resend');assert.equal(f.db.users[0].resetTokenHash,original);checks+=4;
 f=fixture();const before=canonicalHash(f.db);await f.call(async(req,res)=>{const db=f.h.readDb();db.company.name='Unsupported cleanup';f.h.writeDb(db);f.h.json(res,502,{error:'Failed'});});assert.equal(canonicalHash(f.db),before,'An arbitrary error candidate cannot commit');checks++;
}
async function client(){
 let resolve,retired=0,company='A',next=null;const sandbox={window:{addEventListener(){},PDLCompanyRoles:{retire(){}}},document:{querySelectorAll:()=>[],getElementById:()=>null,querySelector:()=>null},localStorage:{getItem:()=>company},fetch:async()=>new Promise(done=>{resolve=done}),Date,Promise,Error,Number,Object};vm.runInNewContext(fs.readFileSync(require.resolve('./roles-production-ui'),'utf8'),sandbox);const ui=sandbox.window.pdlProductionRoles;
 const configure=id=>ui.configure({rolesEditor:true},{rolesEditor:true,companyId:id,id:1,role:'owner',accountSessionBinding:id},()=>retired++);
 configure('A');const old=ui.identity();configure('B');company='B';const after=retired;resolve({ok:true,json:async()=>({companyId:'A',actorId:1,role:'owner',sessionBinding:'A',revision:1,authority:'a'.repeat(64),expiresAt:'2099-01-01T00:00:00.000Z'})});await assert.rejects(old,/earlier account/);assert.equal(retired,after,'Held old identity cannot retire a new account');checks++;
}
async function reviewRegressions(){
 const guards=require('./roles-production-guards'),registry=require('./capability-registry'),profiles=require('./role-profiles');
 let f=fixture();const large=await f.call(async(req,res)=>{res.writeHead(200);res.write('ONLY');res.end(Buffer.alloc(22000001));});assert.equal(large.status,503);assert.equal(large.raw,undefined);checks+=2;
 f=fixture();const broken=await f.call(async(req,res)=>{res.writeHead(200);res.write('ONLY');res.destroy(Error('Synthetic stream truncated'));});assert.equal(broken.status,503);assert.equal(broken.raw,undefined);checks+=2;
 let db=workspaceSnapshot();db.users.push({id:3,companyId:A,role:'admin',name:'Synthetic office',status:'Active',permissions:{manageTime:true},projectIds:[],assignedCrews:[]});const profileId=crypto.randomUUID();db=profiles.plan(db,{operation:'create',profileId,name:'Office restricted',baseRole:'admin',capabilities:Object.fromEntries(registry.families.map(row=>[row[0],row[4].ceiling('admin')]))});db=profiles.plan(db,{operation:'assign',accountId:3,profileId});
 const req={method:'PATCH',auth:{user:db.users[0]}};await assert.rejects(guards.guard(req,new URL('/api/users/3','http://fixture'),db,{body:async()=>({role:'project_manager'})}),error=>error.statusCode===409);checks++;
 db=workspaceSnapshot();const user={id:3,companyId:A,role:'admin',name:'Admin',permissions:{manageTime:true}};setPolicy(db,'notes',{view:false,create:false,edit:false,complete:false});
 for(const path of ['/api/projects/101/assistant/chat','/api/assistant/interpret'])await assert.rejects(guards.guard({method:'POST',auth:{user}},new URL(path,'http://fixture'),db,{body:async()=>({text:'Synthetic note',action:'note',draft:{action:'note'},projectId:101})}),error=>error.statusCode===403);checks+=2;
 setPolicy(db,'timeWrite',{},'project_manager');const pm={id:4,role:'project_manager',permissions:{manageTime:true,viewTime:true,viewDailies:true},projectIds:[101],assignedCrews:['Synthetic Crew']};db.projects.push({id:102,name:'Foreign project'});db.team.push({id:13,name:'Foreign',crew:'Other'});db.workdays=[{id:99,projectId:102,memberIds:[13],status:'active'}];db.company.features.timeCards=true;
 await assert.rejects(guards.guard({method:'POST',auth:{user:pm}},new URL('/api/workdays/99/end','http://fixture'),db,{body:async()=>({notes:'Foreign completion'})}),error=>error.statusCode===404);checks++;
 const visible=db.reports[0];const view=guards.readView(db,pm,{workspace:()=>({projects:[db.projects[0]],team:[],reports:[visible],workdays:[]})});assert.deepEqual(view.reports.map(row=>row.id),[visible.id]);assert.deepEqual(view.workdays,[]);checks+=2;
 db=workspaceSnapshot();setPolicy(db,'timeReview',{viewCards:false,approveCards:false,unapproveCards:false});db.company.features.timeCards=true;await assert.rejects(guards.guard({method:'POST',auth:{user}},new URL('/api/workdays/start','http://fixture'),db,{body:async()=>({projectId:101,memberIds:[12],startNote:''})}),error=>error.statusCode===403);checks++;
 db=workspaceSnapshot();setPolicy(db,'notes',{});db.timeCards=[{id:1,memberId:12,projectId:101},{id:2,memberId:13,projectId:102}];const reduced=guards.readView(db,pm,{workspace:()=>({projects:[db.projects[0]],reports:[],workdays:[],assignments:[],timeCards:[db.timeCards[0]],team:[]})});assert.deepEqual(reduced.timeCards.map(row=>row.id),[1]);checks++;
 db=workspaceSnapshot();db.company.features.timeCards=true;setPolicy(db,'daily',{runWorkdays:false},'field');const field=db.users.find(row=>row.role==='field');db.workdays=[{id:99,projectId:101,memberIds:[field.memberId],status:'active'}];db.timeCards=[{id:99,workdayId:99,projectId:101,memberId:field.memberId}];const next=structuredClone(db);next.workdays[0].status='complete';assert.throws(()=>guards.validateDelta(db,next,{method:'PATCH',auth:{user:field}},new URL('/api/time-cards/99','http://fixture'),{}),error=>error.statusCode===403);checks++;
}
async function changeCards(){
 const guards=require('./roles-production-guards');const db=workspaceSnapshot();setPolicy(db,'daily',{});
 const admin={id:3,role:'admin',companyId:db.company.id,status:'Active'};
 db.changes=[{id:77,number:'PC-077',projectId:101,reportId:db.reports[0].id,title:'Synthetic extra',status:'Pricing',reason:'Synthetic reason',hours:2,amount:120,lines:[{description:'Material',quantity:1,unit:'EA',laborHours:2,materialCost:120}],history:[{action:'Updated amount $0 → $120',by:'Synthetic owner',at:'2026-10-11T00:00:00.000Z'}]}];
 const url=new URL('/api/changes','http://fixture');const helpers={canViewPricing:()=>false};
 const safe=guards.projectResponse({method:'GET',auth:{user:admin}},url,db,db.changes,helpers)[0];
 assert.equal(safe.reason,'Synthetic reason');assert.equal(safe.hours,2);assert.equal(safe.lines[0].laborHours,2);assert.equal(safe.amount,undefined);assert.equal(safe.lines[0].materialCost,undefined);assert.equal(safe.history[0].action,'Reviewed');checks++;
 const priced=guards.projectResponse({method:'GET',auth:{user:admin}},url,db,db.changes,{canViewPricing:()=>true})[0];assert.equal(priced.lines[0].materialCost,120);assert.equal(priced.amount,120);checks++;
 setPolicy(db,'daily',{viewReports:false,createReports:false,editReports:false,approveReports:false,viewWorkdays:false,runWorkdays:false});
 assert.deepEqual(guards.projectResponse({method:'GET',auth:{user:admin}},url,db,db.changes,helpers),[]);checks++;
 await assert.rejects(guards.guard({method:'PATCH',auth:{user:admin}},new URL('/api/changes/77','http://fixture'),db,{body:async()=>({status:'Approved'})}),error=>error.statusCode===404);checks++;
 const field=db.users.find(row=>row.role==='field');db.changes[0].fieldFlag=true;db.changes[0].createdBy=field.name;
 setPolicy(db,'daily',{viewReports:false,createReports:false,editReports:false,approveReports:false,viewWorkdays:false,runWorkdays:false},'field');
 assert.deepEqual(guards.projectResponse({method:'GET',auth:{user:field}},new URL('/api/changes/mine','http://fixture'),db,[{id:77,number:'PC-077',title:'Synthetic extra',status:'Pricing'}],helpers),[]);checks++;
}
async function main(){await provider();await client();await reviewRegressions();await changeCards();console.log(JSON.stringify({passed:true,checks,externalCalls:0,syntheticOnly:true}));}
main().catch(error=>{console.error(error);process.exitCode=1;});
