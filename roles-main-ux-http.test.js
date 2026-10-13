'use strict';
// Actual normal managed HTTP + closed synthetic CAS. No compatibility installer
// or external provider; the upstream UX relaxation retains immutable authority.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs');
let origin,requests=0;const nativeFetch=globalThis.fetch;
globalThis.fetch=(target,options)=>{assert.ok(origin&&String(target).startsWith(origin+'/'),'Only the fixture loopback server may use a socket');return nativeFetch(target,options)};
require('./database/supabase').loadLocalEnv=()=>{};
const fixture=require('./roles-production-http.test'),{server}=fixture;
const legacy=fs.readFileSync(process.env.PDL_DB_FILE);
const registry=require('./capability-registry');
function policy(role,flags){fixture.alter(db=>{const family=registry.families.find(row=>row[0]==='daily')[4];db.company.dailyPolicyRequired=true;db.company.dailyRolePolicy||={version:1,revision:1,roles:Object.fromEntries(family.roles.map(role=>[role,family.ceiling(role)]))};Object.assign(db.company.dailyRolePolicy.roles[role],flags)});}
async function call(method,route,data,user=1,company=fixture.A){requests++;const response=await fetch(origin+route,{method,signal:AbortSignal.timeout(15000),headers:{'X-PDL-Company':company,Authorization:'Bearer '+fixture.tokens.get(user),'Content-Type':'application/json',...(method==='GET'?{}:{'X-PDL-Operation':crypto.randomUUID()})},...(data===undefined?{}:{body:JSON.stringify(data)})});return {status:response.status,data:await response.json()};}
const okay=(r,status=200)=>{assert.equal(r.status,status,JSON.stringify(r.data));return r.data};
const project=extra=>({kind:'projectCreate',method:'POST',path:'/api/projects',details:{customerId:null,customer:'',name:'Synthetic project without customer',contractType:'estimated',tmSettings:null,budget:'$0',...extra}});
const daily=extra=>({projectId:101,sourceAssignmentId:null,dateIso:'2098-10-12',status:'Needs review',notes:'Synthetic first daily without an estimate',foreman:'Synthetic Owner',summary:'Synthetic recorded work',productionEntries:[{estimateItemId:null,description:'Synthetic site observation',quantity:0,unit:'EA',laborHours:0}],laborEntries:[],...extra});
async function main(){
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
 fixture.alter(db=>{db.company.features={...db.company.features,templates:false};db.projects[0].estimateItems=[];db.reports=[];db.projects[0].templateId=undefined;db.projects[0].templateVersion=undefined;});
 try{
  const count=fixture.read().projects.length,created=okay(await call('POST','/api/projects',project().details),201);assert.equal(created.customerId,null);assert.equal(created.customer,'');assert.equal(fixture.read().projects.length,count+1);
  for(const extra of [{customerId:null,customer:'Foreign name'},{customerId:0,customer:''},{customerId:1,customer:''}])assert.equal((await call('POST','/api/projects',project(extra).details)).status,400);
  assert.equal((await call('POST','/api/projects',project({customerId:999,customer:'Foreign customer'}).details)).status,404);
  assert.equal((await call('POST','/api/projects',project().details,2)).status,403,'Field cannot gain project management from optional customer');
  assert.equal((await call('POST','/api/projects',project().details,1,fixture.B)).status,404);
  fixture.alter(db=>{db.users.find(row=>row.id===3).status='Deactivated'});assert.ok([401,403,409].includes((await call('POST','/api/projects',project({name:'Synthetic revoked create'}).details,3)).status));assert.ok(!fixture.read().projects.some(row=>row.name==='Synthetic revoked create'));
  const first=okay(await call('POST','/api/reports',daily()),201);assert.deepEqual(first.flags,[]);assert.ok(!first.summary.includes('Unplanned work needs'));
  const changed=okay(await call('PATCH','/api/reports/'+first.id,{notes:'Synthetic corrected zero estimate daily',status:'Needs review',productionEntries:daily().productionEntries,laborEntries:[]}));assert.deepEqual(changed.flags,[]);
  okay(await call('PATCH','/api/reports/'+first.id+'/approve',{}));assert.equal(fixture.read().reports.find(row=>row.id===first.id).status,'Approved');
  policy('field',{createReports:true});
  const field=okay(await call('POST','/api/reports',daily({foreman:'Synthetic Field',laborEntries:[{memberId:12,hours:0}]}),2),201);assert.deepEqual(field.flags,[]);
  const narrative=okay(await call('POST','/api/reports',daily({notes:'Synthetic current-actor observation with no hours'}),2),201);assert.equal(narrative.foreman,'Synthetic Field');assert.deepEqual(narrative.flags,[],'Existing own zero-hour narrative path remains available');
  fixture.alter(db=>{db.team.push({id:99,name:'Foreign synthetic worker',crew:'Foreign'});db.projects.push({id:999,name:'Foreign project',estimateItems:[]})});
  assert.ok([403,404].includes((await call('POST','/api/reports',daily({laborEntries:[{memberId:99,hours:0}]}),2)).status));
  assert.ok([403,404].includes((await call('POST','/api/reports',daily({projectId:999,laborEntries:[{memberId:12,hours:0}]}),2)).status));
  assert.ok([403,404].includes((await call('POST','/api/reports',daily(),1,fixture.B)).status));
  policy('field',{createReports:false});assert.equal((await call('POST','/api/reports',daily({laborEntries:[{memberId:12,hours:0}]}),2)).status,403,'No-estimate UX cannot bypass current policy');
  fixture.alter(db=>{db.projects[0].estimateItems=[{id:1,name:'Synthetic existing scope',unit:'EA',plannedQuantity:1,budgetHours:1,cost:0}]});
  const estimated=okay(await call('POST','/api/reports',daily({dateIso:'2098-10-13'})),201);assert.equal(estimated.flags[0].type,'unplanned_work');assert.equal((await call('PATCH','/api/reports/'+estimated.id+'/approve',{})).status,409,'Existing estimate retains office exception decision');
  assert.deepEqual(fs.readFileSync(process.env.PDL_DB_FILE),legacy,'Managed checks leave local legacy bytes unchanged');
  console.log(JSON.stringify({passed:true,requests,syntheticTransport:true,testInstallerUsed:false,externalCalls:0,checks:'typed normal optional project creation; contradictory/foreign/Field/stale denial; no-estimate create/edit/approval; existing Field own narrative path and current-policy/project/referenced-crew/tenant floors; estimated exception approval denial'}));
 }finally{await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);server.close();process.exitCode=1});
