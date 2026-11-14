'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-report-day-flags-')),dbFile=path.join(temp,'db.json'),platformFile=path.join(temp,'platform.json');
const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'data/db.json'),'utf8'));
fixture.company.features={...fixture.company.features,templates:false};fixture.workdays=[];fixture.timeCards=[];
fixture.reports=[{id:9001,project:0,dateIso:'2026-11-12',date:'Nov 12',foreman:'Legacy field user',status:'Approved',notes:'Legacy report without day flags.',productionEntries:[],laborEntries:[],history:[]}];
fs.writeFileSync(dbFile,JSON.stringify(fixture));fs.copyFileSync(path.join(__dirname,'data/platform.json'),platformFile);
Object.assign(process.env,{PDL_DB_FILE:dbFile,PDL_PLATFORM_FILE:platformFile,PDL_SUPABASE_ENABLED:'0',PDL_EMAIL_DEV_MODE:'1',PDL_REQUIRE_AUTH:'0'});
for(const key of ['OPENAI_API_KEY','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','DATABASE_URL','SENTRY_DSN','RESEND_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET'])delete process.env[key];
const realFetch=global.fetch;global.fetch=(url,options)=>{const target=new URL(typeof url==='string'?url:url.url||url.href);assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname));return realFetch(url,options)};
const {server}=require('./server');server.listen(0,'127.0.0.1',async()=>{
 const base='http://127.0.0.1:'+server.address().port;
 async function request(route,method='GET',body){const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()}}
 try{
  let state=await request('/api/state'),legacy=state.body.reports.find(row=>row.id===9001);
  assert.equal(legacy.weatherDay,false);assert.equal(legacy.delayDay,false);
  const payload={projectId:fixture.projects[0].id,dateIso:'2026-11-13',notes:'Synthetic flag test.',status:'Draft',weatherDay:true,delayDay:'true',productionEntries:[],laborEntries:[]};
  const created=await request('/api/reports','POST',payload);assert.equal(created.status,201);assert.equal(created.body.weatherDay,true);assert.equal(created.body.delayDay,false,'only literal true is accepted');
  const patched=await request('/api/reports/'+created.body.id,'PATCH',{weatherDay:false,delayDay:true});assert.equal(patched.status,200);assert.equal(patched.body.weatherDay,false);assert.equal(patched.body.delayDay,true);
  const ignored=await request('/api/reports/'+created.body.id,'PATCH',{weatherDay:1,delayDay:'false'});assert.equal(ignored.status,200);assert.equal(ignored.body.weatherDay,false);assert.equal(ignored.body.delayDay,false);
  const disk=JSON.parse(fs.readFileSync(dbFile,'utf8'));const saved=disk.reports.find(row=>row.id===created.body.id),old=disk.reports.find(row=>row.id===9001);
  assert.equal(saved.weatherDay,false);assert.equal(saved.delayDay,false);assert.equal(Object.hasOwn(old,'weatherDay'),false);assert.equal(Object.hasOwn(old,'delayDay'),false);
  console.log('Daily weather/delay flag API passed: create, strict boolean coercion, patch, old-report false projection, and no legacy backfill.');
 }catch(error){console.error(error);process.exitCode=1}
 finally{server.close(()=>{const resolved=path.resolve(temp);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(resolved,{recursive:true,force:true})})}
});
