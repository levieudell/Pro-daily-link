'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-signature-api-'));
const dbFile=path.join(temp,'db.json'),platformFile=path.join(temp,'platform.json');
const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'data/db.json'),'utf8'));
fixture.company.features={...fixture.company.features,templates:false};fixture.reports=[];fixture.workdays=[];fixture.timeCards=[];
fixture.projects[0].contractType='estimate';fixture.projects[0].estimateItems=[{id:101,name:'Synthetic work',unit:'EA',plannedQuantity:1}];
fs.writeFileSync(dbFile,JSON.stringify(fixture));fs.copyFileSync(path.join(__dirname,'data/platform.json'),platformFile);
Object.assign(process.env,{PDL_DB_FILE:dbFile,PDL_PLATFORM_FILE:platformFile,PDL_SUPABASE_ENABLED:'0',PDL_EMAIL_DEV_MODE:'1',PDL_REQUIRE_AUTH:'0'});
for(const key of ['OPENAI_API_KEY','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','DATABASE_URL','SENTRY_DSN','RESEND_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET'])delete process.env[key];
const realFetch=global.fetch;
global.fetch=(url,options)=>{const target=new URL(typeof url==='string'?url:url.url||url.href);assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname),'Test must not call external services');return realFetch(url,options)};
const {server}=require('./server');
const {createReportingExport}=require('./reporting-exports');
server.listen(0,'127.0.0.1',async()=>{
 const base='http://127.0.0.1:'+server.address().port;
 async function request(route,method='GET',body){const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()}}
 try{
  const payload={projectId:fixture.projects[0].id,dateIso:'2026-10-01',notes:'Synthetic performed work',status:'Draft',
   foreman:'Synthetic author',signature:'Synthetic signer',productionEntries:[{estimateItemId:101,description:'Synthetic work',quantity:1,unit:'EA',laborHours:2}],laborEntries:[{memberId:fixture.team[0].id,hours:2}]};
  const draft=await request('/api/reports','POST',payload);assert.equal(draft.status,201);assert.equal(draft.body.signature,payload.signature);
  const id=draft.body.id;let state=await request('/api/state');assert.equal(state.body.reports.find(row=>row.id===id).signature,payload.signature);
  const submitted=await request('/api/reports/'+id,'PATCH',{...payload,status:'Needs review',signature:'Revised synthetic signer'});
  assert.equal(submitted.status,200);assert.equal(submitted.body.signature,'Revised synthetic signer');
  const omitted=await request('/api/reports/'+id,'PATCH',{summary:'Synthetic office note'});assert.equal(omitted.status,200);assert.equal(omitted.body.signature,'Revised synthetic signer');
  state=await request('/api/state');assert.equal(state.body.reports.find(row=>row.id===id).signature,'Revised synthetic signer');
  const approved=await request('/api/reports/'+id+'/approve','PATCH');assert.equal(approved.status,200);assert.equal(approved.body.signature,'Revised synthetic signer');
  const saved=JSON.parse(fs.readFileSync(dbFile,'utf8'));assert.equal(saved.reports.find(row=>row.id===id).signature,'Revised synthetic signer');
  const snapshot=createReportingExport(saved,{projectId:fixture.projects[0].id,from:'2026-10-01',to:'2026-10-01'},{id:1,name:'Synthetic owner',role:'owner'});
  assert.equal(snapshot.snapshot.reports.find(row=>row.id===id).signature,'Revised synthetic signer');
  saved.reports.find(row=>row.id===id).signature='Later change';assert.equal(snapshot.snapshot.reports.find(row=>row.id===id).signature,'Revised synthetic signer','fixed JSON snapshot keeps its own saved name');
  console.log('Report signature API passed: Draft, submission, edit with signature omitted, reload, approval, persisted disk and immutable JSON export; synthetic local data and external services disabled.');
 }catch(error){console.error(error);process.exitCode=1}
 finally{server.close(()=>{const resolved=path.resolve(temp);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(resolved,{recursive:true,force:true})})}
});
