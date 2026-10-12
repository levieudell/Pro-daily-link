'use strict';
// Compound latest-main behavior through the actual synthetic HTTP adapter.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {A,B,initial,snapshot,memory,credential}=require('./compat-account-fixture');
const {workspaceSnapshot}=require('./compat-workspace-fixture'),{services}=require('./compat-lifecycle-fixture');
const registry=require('./capability-registry'),profiles=require('./role-profiles'),labor=require('./report-labor-review');
const NativeDate=Date,fixed=NativeDate.parse('2026-10-09T14:00:00Z');
global.Date=class extends NativeDate { constructor(...args){super(...(args.length?args:[fixed]));} static now(){return fixed;} };
const PRIVATE='synthetic-private-presence-never-in-response';
async function main(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-compat-main-parity-')),file=path.join(directory,'legacy.json'),legacy=snapshot();legacy.company.id=B;legacy.users[0].companyId=B;fs.writeFileSync(file,JSON.stringify(legacy));const original=fs.readFileSync(file),key=crypto.randomBytes(32);
  Object.assign(process.env,{NODE_ENV:'test',PDL_COMPAT_ACCOUNT_SYNTHETIC:'1',PDL_REQUIRE_AUTH:'1',PDL_DB_FILE:file,PDL_PLATFORM_FILE:path.join(directory,'platform.json'),PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off'});
  for(const name of ['OPENAI_API_KEY','RESEND_API_KEY','STRIPE_SECRET_KEY','SENTRY_DSN','SUPABASE_SECRET_KEY','PDL_PLATFORM_KEY'])process.env[name]='';
  const mod=require('./server');await new Promise(resolve=>mod.server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+mod.server.address().port;let uninstall,cases=0;
  function seed(enabled=true){const db=workspaceSnapshot();db.company.features.timeCards=enabled;db.team[0].crew='Office';db.projects.push({id:202,name:'Synthetic unassigned project',status:'Active',estimateItems:[]});db.team.push({id:13,name:'Synthetic Coworker',crew:'Synthetic Crew',role:'Crew'},{id:14,name:'Synthetic Hidden Member',crew:'Other Crew',role:'Crew'});db.users.push({id:3,companyId:A,name:'Synthetic PM',email:'pm@example.invalid',role:'project_manager',status:'Active',emailVerifiedAt:'2026-10-01T00:00:00Z',...credential(initial),projectIds:[101],assignedCrews:['Synthetic Crew'],permissions:{scheduleCrews:true,viewTime:true,manageTime:true,viewDailies:true,approveDailies:true}});return db;}
  async function scenario(db,email='owner@example.invalid'){
    uninstall?.();const store=memory(db),fixture=services(store,origin,{key});uninstall=mod.installCompatibilityAccountTests({synthetic:true,companyId:A,origin,globalOrigin:'http://localhost:4999',repository:store,...fixture,workspace:true,workspaceKey:key});let token;
    const request=async(route,method='GET',data)=>{const res=await fetch(origin+route,{method,signal:AbortSignal.timeout(10000),headers:{'X-PDL-Company':A,...(token?{Authorization:'Bearer '+token}:{}),...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});return {status:res.status,data:await res.json()};};
    const login=await request('/api/auth/login','POST',{email,password:initial});assert.equal(login.status,200,JSON.stringify(login));token=login.data.token;return {store,request};
  }
  async function noShow(db,email,expected){const s=await scenario(db,email),before=JSON.stringify(db),response=await s.request('/api/action-center');assert.equal(response.status,200,JSON.stringify(response));assert.equal(response.data.items.filter(row=>row.type==='scheduled_no_show').length,expected);assert.equal(response.data.counts.total,response.data.items.length);assert.ok(!JSON.stringify(response).includes(PRIVATE));assert.equal(JSON.stringify(db),before);cases++;return s;}
  function deny(db,family,action){const controller=registry.families.find(row=>row[0]===family)[4],prefix=registry.families.find(row=>row[0]===family)[2],value={version:1,revision:1,roles:Object.fromEntries(registry.roles.map(role=>[role,{...controller.ceiling(role)}]))},row=value.roles.project_manager;row[action]=false;if(family==='scheduling')for(const key of Object.keys(row))row[key]=false;if(family==='daily')row.runWorkdays=false;if(family==='timeReview')row.approveCards=row.unapproveCards=false;if(family==='timeOff')row.createRequest=false;controller.validatePolicy(value);db.company[prefix+'RolePolicy']=value;db.company[prefix+'PolicyRequired']=true;return db;}
  try{
    for(const role of ['field','foreman']){
      const db=seed();db.users[1].role=role;db.assignments[0].date='2026-10-01';db.reports[0].laborEntries.push({memberId:13,hours:2,crew:'Synthetic Crew'});db.workdays.push({id:99,projectId:101,memberIds:[14],status:'complete'});db.reports.push({...structuredClone(db.reports[0]),id:2,foreman:'Synthetic Coworker',notes:PRIVATE,summary:PRIVATE,rateSnapshot:{laborRate:98765},workdayId:99,laborEntries:[{memberId:13,hours:2,crew:'Synthetic Crew'},{memberId:14,hours:2,crew:'Other Crew'}],laborExclusions:[{memberId:13,hours:2,sourceReportId:1,by:'Synthetic Owner',at:'2026-10-09T13:00:00Z'},{memberId:14,hours:2,sourceReportId:1,by:PRIVATE,at:'2026-10-09T13:00:00Z'}]});
      const s=await scenario(db,'field@example.invalid'),response=await s.request('/api/state');assert.equal(response.status,200,JSON.stringify(response));const warning=response.data.laborReviewReports.find(row=>row.id===2);assert.ok(warning);assert.deepEqual(warning.laborEntries.map(row=>row.memberId),[13]);assert.deepEqual(warning.laborExclusions.map(row=>row.memberId),[13]);assert.equal(warning.workdayId,null);assert.ok(!JSON.stringify(response).includes(PRIVATE));assert.equal(labor.review(response.data.reports[0],{reports:[...response.data.reports,...response.data.laborReviewReports],team:response.data.team,workdays:response.data.workdays}).length,0,'resolved coworker labor must not reappear as a warning');cases++;
    }
    for(const enabled of [true,false])for(const email of ['owner@example.invalid','pm@example.invalid']){
      await noShow(seed(enabled),email,1);
      const present=seed(enabled);present.timeCards.push({id:1,memberId:12,projectId:101,date:'2026-10-09',status:'approved',notes:PRIVATE});const s=await noShow(present,email,0);
      if(!enabled){const state=await s.request('/api/state'),cards=await s.request('/api/time-cards');assert.equal(state.status,200);assert.ok(!JSON.stringify(state).includes(PRIVATE));assert.notEqual(cards.status,200);assert.ok(!JSON.stringify(cards).includes(PRIVATE));}
      for(const change of [{projectId:202},{memberId:14},{date:'2026-10-08'},{deletedAt:'2026-10-09T13:00:00Z'}]){const wrong=seed(enabled);wrong.timeCards.push({...present.timeCards[0],...change});await noShow(wrong,email,1);}
    }
    for(const enabled of [true,false]){
      for(const [family,action] of [['scheduling','view'],['daily','viewWorkdays'],['timeReview','viewCards'],['timeOff','viewRequests']])await noShow(deny(seed(enabled),family,action),'pm@example.invalid',0);
      const db=seed(enabled),capabilities=Object.fromEntries(registry.families.map(([id,,,,controller])=>[id,controller.ceiling('project_manager')]));capabilities.timeReview.viewCards=capabilities.timeReview.approveCards=capabilities.timeReview.unapproveCards=false;const id=crypto.randomUUID(),created=profiles.plan(db,{operation:'create',profileId:id,name:'Synthetic restricted presence',baseRole:'project_manager',capabilities});await noShow(profiles.plan(created,{operation:'assign',accountId:3,profileId:id}),'pm@example.invalid',0);
    }
    assert.deepEqual(fs.readFileSync(file),original);assert.equal(fs.existsSync(path.join(directory,'platform.json')),false);console.log(JSON.stringify({mainParity:cases,laborWarningRoles:2,noShowFeatures:[true,false],privateSourceFieldsReturned:0,productionReady:false}));
  }finally{uninstall?.();mod.server.closeAllConnections();await new Promise(resolve=>mod.server.close(resolve));global.Date=NativeDate;}
}
main().catch(error=>{global.Date=NativeDate;console.error(error);process.exitCode=1;});
