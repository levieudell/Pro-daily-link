'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const rates=require('./report-rate-policy');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-rate-policy-'));
process.env.PDL_DB_FILE=path.join(temp,'db.json');process.env.PDL_PLATFORM_FILE=path.join(temp,'platform.json');
process.env.PDL_SUPABASE_ENABLED='0';process.env.PDL_TRANSACTIONAL_DB='off';process.env.PDL_REQUIRE_AUTH='1';process.env.PDL_EMAIL_DEV_MODE='1';
for(const key of ['SENTRY_DSN','RESEND_API_KEY','OPENAI_API_KEY','STRIPE_SECRET_KEY'])delete process.env[key];
const db=JSON.parse(fs.readFileSync('data/db.json','utf8'));db.company.demo=true;
const projectId=db.projects[0].id,memberId=db.team[0].id;
db.projects[0].contractType='tm';db.projects[0].tmSettings={defaultLaborRate:100,materialMarkup:15,equipmentMarkup:20};
db.company.pricingAccess={enabled:true,officeMode:'selected',userIds:[4]};
db.users=[{id:1,role:'owner'},{id:2,role:'field',memberId},{id:3,role:'project_manager',projectIds:[projectId],assignedCrews:[db.team[0].crew],permissions:{viewDailies:true,approveDailies:true}},{id:4,role:'project_manager',projectIds:[projectId],assignedCrews:[db.team[0].crew],permissions:{viewDailies:true,approveDailies:true}},{id:5,role:'admin'}].map(user=>({...user,name:'QA '+user.role,status:'Active',companyId:db.company.id}));
db.sessions=db.users.map(user=>({userId:user.id,companyId:db.company.id,tokenHash:crypto.createHash('sha256').update('rate-qa-'+user.id).digest('hex'),expiresAt:'2099-01-01T00:00:00Z'}));
db.reports=[{id:1,status:'Needs review',hours:8},{id:2,status:'Approved',hours:4},{id:3,status:'Needs review',hours:1,history:[{action:'Approved',by:'Historical Office',at:'2026-09-01T00:00:00Z'}]},{id:4,status:'Needs review',hours:2}].map(row=>({...row,project:0,dateIso:'2026-10-04',notes:'Synthetic work',signature:'QA',foreman:db.team[0].name,flags:[],history:row.history||[],laborEntries:[{memberId,hours:row.hours}],productionEntries:[]}));
db.assignments=[{id:1,projectId,memberIds:[memberId],date:'2026-10-04'}];
const invalidReport={status:'Needs review',history:[]};rates.captureFirstApproval(invalidReport,{contractType:'tm',tmSettings:{}},db.users[0],'2026-10-04T00:00:00Z');assert.equal(invalidReport.rateReview.status,'Required');assert.equal(invalidReport.rateSnapshot,undefined,'missing configured rate is never zero-guessed');
assert.equal(rates.amount(false),null,'boolean is not an explicit rate');assert.equal(rates.amount(0),0,'explicit zero remains valid');
fs.writeFileSync(process.env.PDL_DB_FILE,JSON.stringify(db));fs.copyFileSync('data/platform.json',process.env.PDL_PLATFORM_FILE);
const {server}=require('./server');
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  const req=async(route,method='GET',input,user=1)=>{const response=await fetch(base+route,{method,headers:{Authorization:'Bearer rate-qa-'+user,'Content-Type':'application/json'},...(input===undefined?{}:{body:JSON.stringify(input)})});return{status:response.status,data:await response.json()}};
  try{
    const first=await req('/api/reports/1/approve','PATCH',{},3);assert.equal(first.status,200);assert.equal(Object.hasOwn(first.data,'rateSnapshot'),false,'unpriced approving manager does not receive rates');
    let stored=JSON.parse(fs.readFileSync(process.env.PDL_DB_FILE,'utf8'));assert.equal(stored.reports.find(r=>r.id===1).rateSnapshot.laborRate,100);assert.equal(stored.reports.find(r=>r.id===1).rateSnapshot.capturedBy.id,3);
    let summary=await req(`/api/projects/${projectId}/tm-summary`);assert.equal(summary.data.complete,false);assert.equal(summary.data.laborAmount,null);assert.equal(summary.data.knownLaborAmount,800);assert.deepEqual(summary.data.missingRateReports.map(row=>row.reportId),[2]);
    const filters={projectId,from:'2026-10-01',to:'2026-10-31'};const capture=await req('/api/reporting-exports','POST',filters);assert.equal(capture.status,201);assert.equal(capture.data.version,1);const fixed=capture.data;
    assert.equal((await req('/api/reports/2/rate','PATCH',{laborRate:75,reason:'Historical contract confirmed'})).status,400,'legacy evidence is mandatory');
    const legacy=await req('/api/reports/2/rate','PATCH',{laborRate:75,reason:'Historical contract confirmed',evidenceReference:'Synthetic schedule rev 1'});assert.equal(legacy.status,200);assert.equal(legacy.data.rateSnapshot.source,'legacy-review');assert.equal(legacy.data.rateSnapshot.materialMarkup,null,'legacy markups are not guessed from current defaults');
    assert.equal((await req(`/api/projects/${projectId}/rate-settings`,'PATCH',{defaultLaborRate:200})).status,400);
    assert.equal((await req(`/api/projects/${projectId}/rate-settings`,'PATCH',{defaultLaborRate:200,reason:'Synthetic new schedule'})).status,200);
    assert.equal((await req('/api/reports/4/approve','PATCH',{})).data.rateSnapshot.laborRate,200);
    const corrected=await req('/api/reports/1','PATCH',{notes:'Corrected work',status:'Needs review',laborEntries:[{memberId,hours:10}],productionEntries:[{estimateItemId:1,description:'Synthetic allocated labor',quantity:0,unit:'HR',laborHours:10}]});assert.equal(corrected.status,200);assert.equal(corrected.data.rateSnapshot.laborRate,100);
    assert.equal((await req('/api/reports/1/approve','PATCH',{})).data.rateSnapshot.laborRate,100,'reapproval never adopts new project rate');
    assert.equal((await req('/api/reports/1/rate','PATCH',{laborRate:125,reason:''})).status,400);
    const adjusted=await req('/api/reports/1/rate','PATCH',{laborRate:125,reason:'Corrected agreed rate'},5);assert.equal(adjusted.status,200);assert.equal(adjusted.data.rateHistory[0].previous.laborRate,100);assert.equal(adjusted.data.rateHistory[0].next.laborRate,125);assert.equal(adjusted.data.rateHistory[0].actor.id,5);
    assert.equal((await req(`/api/projects/${projectId}/tm-summary`)).data.laborAmount,1950);
    const prior=await req('/api/reports/3/approve','PATCH',{});assert.equal(prior.data.rateSnapshot,undefined,'legacy reapproval cannot manufacture a rate');assert.equal(prior.data.rateReview.status,'Required');
    assert.equal((await req('/api/reports/3/rate','PATCH',{laborRate:50,reason:'Legacy source reviewed',evidenceReference:'Synthetic old invoice'})).status,200);
    for(const user of [2,3,4])assert.equal((await req(`/api/projects/${projectId}/archive`,'PATCH',{archived:false},user)).status,403,'archive cannot reveal rates to field or managers');
    for(const user of [1,5])assert.equal((await req(`/api/projects/${projectId}/archive`,'PATCH',{archived:false},user)).status,200,'owner/admin retain archive access');
    for(const user of [2,3,4]){
      assert.equal((await req('/api/reports/1/rate','PATCH',{laborRate:999,reason:'Denied'},user)).status,403);
      assert.equal((await req(`/api/projects/${projectId}/rate-settings`,'PATCH',{defaultLaborRate:999,reason:'Denied'},user)).status,403);
      assert.equal((await req('/api/reporting-exports/'+fixed.id,'GET',undefined,user)).status,403);
    }
    for(const user of [2,3]){const state=await req('/api/state','GET',undefined,user);assert.equal(state.status,200);assert.ok(state.data.reports.length);for(const report of state.data.reports)for(const key of ['rateSnapshot','rateHistory','rateReview'])assert.equal(Object.hasOwn(report,key),false,`${user}: ${key} redacted`);assert.ok(state.data.projects.every(project=>!Object.hasOwn(project,'rateSettingsHistory')))}
    const fieldEdit=await req('/api/reports/1','PATCH',{notes:'Synthetic notes',status:'Needs review',laborEntries:[{memberId,hours:10}],productionEntries:[{estimateItemId:1,description:'Synthetic allocated labor',quantity:0,unit:'HR',laborHours:10}]},2);assert.equal(fieldEdit.status,200);assert.equal(Object.hasOwn(fieldEdit.data,'rateSnapshot'),false);
    const bad=await req('/api/reports','POST',{projectId,dateIso:'2026-10-04',notes:'Forgery test',laborEntries:[],productionEntries:[],extracted:{rateSnapshot:{schemaVersion:1,laborRate:9999,capturedAt:'fake',capturedBy:{id:2}}}});assert.equal(bad.status,201);assert.equal(bad.data.rateSnapshot,undefined,'field extraction cannot forge a captured rate');
    assert.equal((await req('/api/reports/'+bad.data.id,'PATCH',{status:'Approved',notes:'Forgery test',laborEntries:[],productionEntries:[]})).status,409,'generic correction cannot bypass first-office-approval');
    assert.deepEqual((await req('/api/reporting-exports/'+fixed.id)).data,fixed,'rate reviews/source corrections do not rewrite fixed export');
    assert.equal((await req('/api/reporting-exports','POST',filters)).status,409,'new version must identify latest export');
    assert.equal((await req('/api/reporting-exports','POST',{...filters,supersedesId:fixed.id})).status,400,'new version needs reason');
    const second=await req('/api/reporting-exports','POST',{...filters,supersedesId:fixed.id,reason:'Corrected approved handoff'});assert.equal(second.status,201);assert.equal(second.data.version,2);assert.equal(second.data.seriesId,fixed.seriesId);assert.equal(second.data.supersedesId,fixed.id);
    assert.equal((await req('/api/reporting-exports','POST',{...filters,supersedesId:fixed.id,reason:'Stale retry'})).status,409,'stale version retry cannot create duplicate replacement');
    assert.equal((await req('/api/reporting-exports')).data.length,2);
    const csv=await fetch(base+'/api/reporting-exports/'+fixed.id+'.csv',{headers:{Authorization:'Bearer rate-qa-1'}});assert.equal(csv.status,200);const csvBefore=await csv.text();assert.ok(csvBefore.includes('Review required'));assert.equal(await (await fetch(base+'/api/reporting-exports/'+fixed.id+'.csv',{headers:{Authorization:'Bearer rate-qa-1'}})).text(),csvBefore,'CSV regenerated from stored version is identical');
    assert.equal((await fetch(base+'/reporting-controls.js')).status,200,'new workspace controller remains public under the explicit asset policy');
    stored=JSON.parse(fs.readFileSync(process.env.PDL_DB_FILE,'utf8'));assert.ok(stored.auditLog.some(row=>row.type==='report_rate_reviewed'));assert.ok(stored.auditLog.some(row=>row.type==='project_default_rate_changed'));assert.ok(stored.auditLog.some(row=>row.type==='reporting_export_created'));
    console.log('Rate/version policy passed: first approval, retained rates, audited changes/evidence, incomplete legacy totals, financial redaction, forgery denial and immutable versioned handoff (local synthetic HTTP).');
  }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(temp,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1;server.close()});
