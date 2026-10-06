'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {buildSalesDemo,summarizeSalesDemo}=require('./sales-demo-data');
const payPeriods=require('./pay-periods');
const d=buildSalesDemo(),summary=summarizeSalesDemo(d);
assert.deepEqual(buildSalesDemo(),d,'The fixture must be reproducible');
assert.equal(d.users.length,0);assert.equal(d.sessions.length,0);
assert.equal(d.company.demo,true);assert.equal(d.company.billingExempt,true);assert.equal(d.company.planPrice,0);
assert.doesNotMatch(JSON.stringify(d),/password|tokenHash|stripeCustomerId|stripeSubscriptionId|https?:\/\//i,'No credentials, live billing IDs, photos, or remote links');
assert.deepEqual(summary.time,{approved:{cards:155,hours:1240},submitted:{cards:4,hours:32},draft:{cards:1,hours:8}});
assert.equal(summary.approvedReports,58);assert.equal(summary.reviewReports,2);
assert.deepEqual(summary.projects.map(p=>[p.quantity,p.hours,p.efficiency]),[[13200,480,110],[11340,456,89.53],[8025,304,105.59]]);
for(const key of ['customers','projects','team','crews','catalog','reports','assignments','timeCards','workdays','payPeriods','payPeriodExports','reportingExports','projectNotesTodos'])assert.equal(new Set(d[key].map(x=>x.id)).size,d[key].length,`${key}: unique IDs`);
for(const key of ['customers','projects','team','crews'])for(const row of d[key])assert.match(row.name,/^DEMO\b/);
for(const row of d.team)assert.match(row.email,/@alder-ridge\.example$/);
for(const assignment of d.assignments){assert.ok(d.projects.some(p=>p.id===assignment.projectId));for(const memberId of assignment.memberIds)assert.ok(d.team.some(m=>m.id===memberId));}
for(const report of d.reports){
 const project=d.projects[report.project];assert.ok(project);assert.ok(d.workdays.some(w=>w.id===report.workdayId&&w.reportId===report.id&&w.projectId===project.id));
 const labor=report.laborEntries.reduce((n,e)=>n+e.hours,0),allocated=report.productionEntries.reduce((n,e)=>n+e.laborHours,0);assert.equal(labor,allocated);
 for(const entry of report.productionEntries)assert.ok(project.estimateItems.some(i=>i.id===entry.estimateItemId));
 for(const entry of report.laborEntries){assert.ok(d.team.some(m=>m.id===entry.memberId));const cards=d.timeCards.filter(c=>c.reportId===report.id&&c.memberId===entry.memberId);assert.equal(cards.length,1);assert.equal(cards[0].hours,entry.hours);}
 assert.ok(report.dateIso<'2026-10-05');
}
for(const card of d.timeCards){
 assert.equal(payPeriods.dateAt(card.inAt,d.company.timezone),card.date);assert.equal((Date.parse(card.outAt)-Date.parse(card.inAt))/3600000-.5,card.hours);
 assert.ok(d.workdays.some(w=>w.id===card.workdayId&&w.status==='complete'&&w.memberIds.includes(card.memberId)));
 const same=d.timeCards.filter(c=>c.memberId===card.memberId&&c.id!==card.id);assert.ok(same.every(c=>Date.parse(c.outAt)<=Date.parse(card.inAt)||Date.parse(c.inAt)>=Date.parse(card.outAt)));
 if(card.status==='approved'){assert.ok(card.approvedAt);assert.equal(card.history.at(-1).action,'Approved');}
}
for(const p of d.payPeriods){const s=payPeriods.summary(d,p),exp=d.payPeriodExports.find(e=>e.periodId===p.id);assert.equal(s.missingEntries.length,0);if(p.status==='closed'){assert.equal(s.ready,true);assert.equal(s.approvedHours,320);assert.equal(payPeriods.hash(s),exp.sourceHash);assert.deepEqual(exp.summary,s);}else{assert.equal(s.ready,false);assert.equal(s.review.submitted,4);assert.equal(s.review.draft,1);assert.throws(()=>payPeriods.capture(d,p,{}, {name:'test'}),/Resolve/);}}
for(const e of d.reportingExports){assert.equal(e.companyId,d.company.id);assert.equal(e.snapshotSha256,crypto.createHash('sha256').update(JSON.stringify(e.snapshot)).digest('hex'));assert.equal(e.snapshot.totals.approvedReports,15);}
for(const e of d.reportingExports){const quantity=e.snapshot.totals.production[0].quantity,planned=e.snapshot.project.estimateItems[0].plannedQuantity;assert.equal(e.snapshot.project.production,Math.round(quantity/planned*1000)/10,'Historical export progress must not include future reports');}
for(const note of d.projectNotesTodos){assert.deepEqual(note.history.at(-1).after,{text:note.text,completed:note.completed,revision:note.revision});if(note.completed){assert.equal(note.revision,2);assert.equal(note.history.at(-1).action,'Completed');assert.equal(note.history[0].after.completed,false);}}
for(const asOf of ['2026-11-09','2027-01-04','2027-03-15'])for(const card of buildSalesDemo({asOf}).timeCards){const clock=new Intl.DateTimeFormat('en-GB',{timeZone:'America/Los_Angeles',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(card.inAt));assert.equal(clock,'07:00');}
assert.throws(()=>buildSalesDemo({asOf:'2026-02-30'}),/ISO/);
assert.throws(()=>buildSalesDemo({companyId:'northstar'}),/UUID/);
console.log('Synthetic demo: deterministic data, privacy, referential integrity, non-overlap, DST and arithmetic checks passed.');
(async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-sales-demo-'));
 const db=structuredClone(d),session='synthetic-local-test-session';
 db.users=[{id:1,companyId:db.company.id,name:'DEMO Local API Tester',email:'api-test@example.invalid',role:'owner',status:'Active',projectIds:[],memberId:null}];
 db.sessions=[{id:'test-session',userId:1,companyId:db.company.id,tokenHash:crypto.createHash('sha256').update(session).digest('hex'),expiresAt:'2099-01-01T00:00:00.000Z'}];
 const file=path.join(directory,'db.json');fs.writeFileSync(file,JSON.stringify(db));fs.writeFileSync(path.join(directory,'platform.json'),JSON.stringify({users:[],sessions:[]}));
 Object.assign(process.env,{PDL_DB_FILE:file,PDL_PLATFORM_FILE:path.join(directory,'platform.json'),PDL_REQUIRE_AUTH:'1',PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',PDL_EMAIL_DEV_MODE:'0',RESEND_API_KEY:'',STRIPE_SECRET_KEY:'',STRIPE_WEBHOOK_SECRET:'',OPENAI_API_KEY:'',SENTRY_DSN:''});
 const {server}=require('./server');await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 const request=async(route,options={})=>{const res=await fetch(base+route,{...options,headers:{cookie:`pdl_session=${session}; pdl_company=${db.company.id}`,'Content-Type':'application/json',...options.headers}});return{status:res.status,data:await res.json()};};
 try{
  const state=await request('/api/state');assert.equal(state.status,200);assert.equal(state.data.projects.length,3);assert.equal(state.data.reports.length,60);
  const prod=await request('/api/production');assert.equal(prod.status,200);assert.equal(prod.data.approvedReports,58);assert.deepEqual(prod.data.projects.map(p=>[p.items[0].actualQuantity,p.items[0].actualLaborHours]),[[13200,480],[11340,456],[8025,304]]);
  const insights=await request('/api/insights?from=2026-09-07&to=2026-10-02');assert.equal(insights.status,200);assert.equal(insights.data.records.length,58);
  const periods=await request('/api/pay-periods');assert.equal(periods.status,200);assert.equal(periods.data.periods.length,4);
  const notes=await request('/api/projects/2/notes-todos');assert.equal(notes.status,200);assert.equal(notes.data.items.length,2);
  const open=await request(`/api/pay-periods/${db.payPeriods[3].id}/summary`);assert.equal(open.status,200);assert.equal(open.data.ready,false);assert.equal(open.data.approvedHours,280);
  const historical=await request(`/api/pay-periods/${db.payPeriods[0].id}/summary`);assert.equal(historical.data.latestExport.changed,false);
  const draft=db.timeCards.find(c=>c.status==='draft');assert.equal((await request(`/api/time-cards/${draft.id}/submit`,{method:'POST',body:'{}'})).status,200);
  const ids=db.timeCards.filter(c=>c.status!=='approved').map(c=>c.id);assert.equal((await request('/api/time-cards/approve',{method:'POST',body:JSON.stringify({ids})})).status,200);
  const ready=await request(`/api/pay-periods/${db.payPeriods[3].id}/summary`);assert.equal(ready.data.ready,true);assert.equal(ready.data.approvedHours,320);
  assert.equal((await request(`/api/pay-periods/${db.payPeriods[3].id}/exports`,{method:'POST',body:'{}'})).status,201);
  for(const report of db.reports.filter(r=>r.status==='Needs review'))assert.equal((await request(`/api/reports/${report.id}/approve`,{method:'PATCH',body:'{}'})).status,200);
  const after=await request('/api/production');assert.equal(after.data.approvedReports,60);assert.deepEqual(after.data.projects.map(p=>[p.items[0].actualQuantity,p.items[0].actualLaborHours]),[[13200,480],[12000,480],[8500,320]]);
  const denied=await fetch(base+'/api/state');assert.equal(denied.status,401);
  console.log('Synthetic demo: real authenticated local API verifies state, production, insights, notes, review → approvals → fixed export, and anonymous denial.');
 }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
const {prepareEmptyDemoTenant}=require('./sales-demo-install');
const target={company:{id:d.company.id,name:d.company.name,createdAt:'2026-10-05T00:00:00.000Z',persistence:{revision:2}},users:[{id:1,companyId:d.company.id,name:'Existing Owner',role:'owner',status:'Active',memberId:null,projectIds:[]}],sessions:[],projects:[]};
const saved=structuredClone(target),prepared=prepareEmptyDemoTenant(target,{expectedCompanyId:d.company.id});assert.deepEqual(target,saved);assert.deepEqual(prepared.users,target.users);assert.deepEqual(prepared.sessions,target.sessions);assert.equal(prepared.company.persistence.revision,2);assert.equal(prepared.projects.length,3);
for(const changed of [{...target,projects:[{id:1}]},{...target,company:{...target.company,stripeCustomerId:'cus_example'}},{...target,company:{...target.company,name:'Real Builder'}},{...target,company:{...target.company,demoFixture:'already-seeded'}},{...target,users:[...target.users,{id:2,role:'field'}]},{...target,projectNotesTodos:[{text:'real work'}]}])assert.throws(()=>prepareEmptyDemoTenant(changed,{expectedCompanyId:d.company.id}));
assert.throws(()=>prepareEmptyDemoTenant(target,{expectedCompanyId:'wrong'}));
console.log('Synthetic demo: empty-tenant installation guards preserve existing owner/session data and reject populated, payment-linked, mismatched and previously seeded tenants.');
