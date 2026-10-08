'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-delay-facts-')),dbFile=path.join(temp,'db.json'),platformFile=path.join(temp,'platform.json');
const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'data/db.json'),'utf8'));fixture.reports=[];fixture.workdays=[];fixture.timeCards=[];fixture.company.features={...fixture.company.features,templates:false};
fs.writeFileSync(dbFile,JSON.stringify(fixture));fs.copyFileSync(path.join(__dirname,'data/platform.json'),platformFile);Object.assign(process.env,{PDL_DB_FILE:dbFile,PDL_PLATFORM_FILE:platformFile,PDL_SUPABASE_ENABLED:'0',PDL_EMAIL_DEV_MODE:'1',PDL_REQUIRE_AUTH:'0'});
for(const key of ['OPENAI_API_KEY','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','DATABASE_URL','SENTRY_DSN','RESEND_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET'])delete process.env[key];
const realFetch=global.fetch;global.fetch=(url,options)=>{const target=new URL(typeof url==='string'?url:url.url||url.href);assert.ok(['127.0.0.1','localhost','[::1]'].includes(target.hostname));return realFetch(url,options)};
const {server}=require('./server');server.listen(0,'127.0.0.1',async()=>{
 const base='http://127.0.0.1:'+server.address().port;async function request(route,method='GET',body){const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()}}
 try{
  const payload={projectId:fixture.projects[0].id,dateIso:'2026-10-08',notes:'Synthetic work. No delays today.',summary:'Field work recorded: No delays today.',signature:'Synthetic signer',foreman:'Synthetic author',status:'Draft',delays:'No delays today.',issue:'No issues',productionEntries:[{estimateItemId:null,description:'Synthetic custom work',quantity:1,unit:'EA',laborHours:2}],laborEntries:[{memberId:fixture.team[0].id,hours:2}]};
  let created=await request('/api/reports','POST',payload);assert.equal(created.status,201);const id=created.body.id;assert.equal(created.body.delays,payload.delays);assert.equal(created.body.issue,payload.issue);assert.match(created.body.summary,/No delays today\./);assert.match(created.body.summary,/office decision/);
  const submitted=await request('/api/reports/'+id,'PATCH',{...payload,status:'Needs review'});assert.equal(submitted.status,200);assert.equal(submitted.body.delays,payload.delays);assert.equal(submitted.body.signature,payload.signature);
  const omitted=await request('/api/reports/'+id,'PATCH',{summary:'Synthetic office edit'});assert.equal(omitted.status,200);assert.equal(omitted.body.delays,payload.delays);
  const spanish=await request('/api/reports/'+id,'PATCH',{delays:'Sin retrasos.',issue:'Sin problemas.'});assert.equal(spanish.status,200);assert.equal(spanish.body.delays,'Sin retrasos.');
  const held=await request('/api/reports/'+id+'/approve','PATCH');assert.equal(held.status,409,'unplanned work still requires an office decision');
  const disposition=await request('/api/reports/'+id+'/disposition','PATCH',{resolution:'non_billable',note:'Synthetic office decision'});assert.equal(disposition.status,200);
  const approved=await request('/api/reports/'+id+'/approve','PATCH');assert.equal(approved.status,200);assert.equal(approved.body.delays,'Sin retrasos.');
  let state=await request('/api/state');assert.equal(state.body.reports.find(row=>row.id===id).delays,'Sin retrasos.');
  const unknown=await request('/api/reports','POST',{...payload,dateIso:'2026-10-09',delays:'',issue:'',summary:'Synthetic missing answer',notes:'Synthetic work.'});assert.equal(unknown.status,201);
  state=await request('/api/state');assert.equal(state.body.reports.find(row=>row.id===unknown.body.id).delays,'');assert.equal(state.body.reports.find(row=>row.id===unknown.body.id).issue,'');
  const disk=JSON.parse(fs.readFileSync(dbFile,'utf8'));assert.equal(disk.reports.find(row=>row.id===id).delays,'Sin retrasos.');assert.equal(disk.reports.find(row=>row.id===unknown.body.id).delays,'');
  const asset=await fetch(base+'/schedule-approved-labor.js');assert.equal(asset.status,200);assert.match(asset.headers.get('content-type'),/javascript/);assert.match(await asset.text(),/PDLScheduleApprovedLabor/);
  console.log('Delay facts local HTTP passed: Draft/submission/omitted-field correction/Spanish correction/office disposition/approval/state reload/persisted disk, served schedule helper, retained unplanned approval guard and unchanged missing values. Synthetic records only.');
 }catch(error){console.error(error);process.exitCode=1}
 finally{server.close(()=>{const resolved=path.resolve(temp);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(resolved,{recursive:true,force:true})})}
});
