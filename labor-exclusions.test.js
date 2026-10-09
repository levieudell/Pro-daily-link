'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-labor-exclusions-')),companyId='33443344-3344-4344-8344-334433443344',ownerToken='synthetic-exclusion-owner',fieldToken='synthetic-exclusion-field',date='2026-10-09';
const db={company:{id:companyId,name:'Synthetic exclusions',demo:true,timezone:'UTC'},projects:[{id:101,name:'Synthetic Job',estimateItems:[{id:'item-1',name:'Trench',unit:'LF',plannedQuantity:100,budgetHours:40}]}],team:[{id:7,name:'Chloe',crew:'A'},{id:8,name:'Andi',crew:'A'}],assignments:[],reports:[
  {id:41,project:0,date:'Oct 9',dateIso:date,foreman:'Chloe',status:'Approved',notes:'Crew daily with both people',laborEntries:[{memberId:7,hours:12.5,crew:'A'},{memberId:8,hours:12.5,crew:'A'}],productionEntries:[{estimateItemId:'item-1',description:'Trench',unit:'LF',quantity:60,laborHours:25}],history:[]},
  {id:42,project:0,date:'Oct 9',dateIso:date,foreman:'Andi',status:'Approved',notes:'Andi daily notes',laborEntries:[{memberId:8,hours:12.5,crew:'A'}],productionEntries:[{estimateItemId:'item-1',description:'Trench',unit:'LF',quantity:10,laborHours:12.5}],history:[]}
],photos:[],workdays:[],timeCards:[],users:[{id:1,name:'Synthetic owner',email:'owner@example.com',role:'owner',status:'Active',companyId},{id:2,name:'Andi',memberId:8,role:'field',status:'Active',companyId}],sessions:[{companyId,userId:1,tokenHash:crypto.createHash('sha256').update(ownerToken).digest('hex'),expiresAt:'2099-01-01'},{companyId,userId:2,tokenHash:crypto.createHash('sha256').update(fieldToken).digest('hex'),expiresAt:'2099-01-01'}],customers:[],changes:[],catalog:[]};
const file=path.join(root,'db.json');fs.writeFileSync(file,JSON.stringify(db));fs.writeFileSync(path.join(root,'platform.json'),JSON.stringify({users:[],sessions:[]}));
Object.assign(process.env,{PDL_DB_FILE:file,PDL_PLATFORM_FILE:path.join(root,'platform.json'),PDL_REQUIRE_AUTH:'1',PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',PDL_EMAIL_DEV_MODE:'1'});for(const name of ['OPENAI_API_KEY','SENTRY_DSN','RESEND_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET'])delete process.env[name];require('./database/supabase').loadLocalEnv=()=>{};
const {server}=require('./server'),nativeFetch=global.fetch;let base;
global.fetch=(url,options)=>{assert.ok(String(url).startsWith(base+'/'),'only synthetic localhost requests permitted');return nativeFetch(url,options);};
async function call(method,route,body,auth){const response=await fetch(base+route,{method,signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json','x-pdl-company':companyId,Authorization:'Bearer '+auth},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()}};
(async()=>{try{await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 const denied=await call('PATCH','/api/reports/42',{laborExclusions:[{memberId:8,hours:12.5,sourceReportId:41}]},fieldToken);
 assert.equal(denied.status,403,'field users cannot decide where hours count');
 const before=await call('GET','/api/production',null,ownerToken);
 assert.equal(before.status,200);
 const itemBefore=before.data.projects.find(row=>row.projectId===101).items.find(row=>row.estimateItemId==='item-1');
 assert.equal(itemBefore.actualLaborHours,37.5,'both reports count Andi before the exclusion');
 const patched=await call('PATCH','/api/reports/42',{laborExclusions:[{memberId:8,hours:12.5,sourceReportId:41,by:'Synthetic owner'}]},ownerToken);
 assert.equal(patched.status,200);
 assert.equal(patched.data.laborExclusions.length,1);
 assert.equal(Number(patched.data.laborExclusions[0].memberId),8);
 assert.equal(patched.data.laborExclusions[0].sourceReportId,41);
 assert.ok(patched.data.history.some(entry=>/counted on another daily/.test(entry.action)),'the resolution is audit-trailed');
 const after=await call('GET','/api/production',null,ownerToken);
 const itemAfter=after.data.projects.find(row=>row.projectId===101).items.find(row=>row.estimateItemId==='item-1');
 assert.equal(itemAfter.actualLaborHours,25,'Andi counts once — 25 crew hours total, not 37.5');
 const unbalanced=await call('PATCH','/api/reports/42',{status:'Needs review',notes:'Unbalanced edit attempt',laborEntries:[{memberId:8,hours:12.5}],productionEntries:[{estimateItemId:'item-1',description:'Trench',unit:'LF',quantity:10,laborHours:5}]},ownerToken);
 assert.equal(unbalanced.status,400,'labor must still balance across work lines when editing');
 const cleared=await call('PATCH','/api/reports/42',{laborExclusions:[]},ownerToken);
 assert.equal(cleared.status,200);
 assert.equal(cleared.data.laborExclusions.length,0,'an empty exclusion list clears the resolution');
 const restored=await call('GET','/api/production',null,ownerToken);
 const itemRestored=restored.data.projects.find(row=>row.projectId===101).items.find(row=>row.estimateItemId==='item-1');
 assert.equal(itemRestored.actualLaborHours,37.5,'clearing the exclusion restores the entered hours');
 console.log('Labor exclusion API passed: office-only resolution, single-count production totals, balance enforcement, audit trail and reversible clearing.');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));global.fetch=nativeFetch;fs.rmSync(root,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
