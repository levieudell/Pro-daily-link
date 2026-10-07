'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {buildSalesDemo} = require('./sales-demo-data');
const supabase = require('./database/supabase');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-estimate-auth-'));
const dbFile = path.join(temp, 'db.json');
const uploadsDir = path.join(__dirname, 'uploads', 'estimates');
const writtenUploads = new Set();
const nativeWrite = fs.writeFileSync;
fs.writeFileSync = function(filename,...args){const result=nativeWrite.call(this,filename,...args);if(typeof filename==='string'&&path.resolve(filename).startsWith(uploadsDir+path.sep))writtenUploads.add(path.resolve(filename));return result};
Object.assign(process.env, {PDL_DB_FILE:dbFile,PDL_PLATFORM_FILE:path.join(temp,'platform.json'),PDL_REQUIRE_AUTH:'1',PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',SENTRY_DSN:'',RESEND_API_KEY:'',OPENAI_API_KEY:'',STRIPE_SECRET_KEY:''});
supabase.loadLocalEnv = () => {};
const db = buildSalesDemo({companyId:'e5711000-0000-4000-8000-000000000001'});
db.company.demo = true;
db.company.pricingAccess = {enabled:true,officeMode:'selected',userIds:[3,8]};
db.projects = db.projects.slice(0,2).map(p=>({...p,estimateItems:[],estimateProposals:[{id:1,name:'Synthetic proposal',plannedQuantity:2,unit:'EA'}]}));
const [p1,p2] = db.projects.map(p=>p.id), memberId=db.team[0].id;
for(const key of ['reports','workdays','photos','projectPlans','projectTickets','changes','estimateImports'])db[key]=[];
db.assignments=[{id:1,projectId:p1,memberIds:[memberId],date:'2026-10-06'}];
db.catalog=[{id:1,name:'Synthetic item',unit:'EA',targetHoursPerUnit:2}];
db.users=[{id:1,role:'owner'},{id:2,role:'admin'},{id:3,role:'project_manager',projectIds:[p1]},{id:4,role:'project_manager',projectIds:[p1]},{id:5,role:'field',memberId},{id:6,role:'foreman',memberId},{id:7,role:'field',memberId:db.team[1].id},{id:8,role:'project_manager',projectIds:[p1,p2]}].map(u=>({...u,companyId:db.company.id,name:'Synthetic '+u.id,email:`synthetic-${u.id}@example.invalid`,status:'Active'}));
const token=id=>'synthetic-estimate-auth-'+id;
db.sessions=db.users.map(u=>({userId:u.id,companyId:db.company.id,tokenHash:crypto.createHash('sha256').update(token(u.id)).digest('hex'),expiresAt:'2099-01-01T00:00:00Z'}));
fs.writeFileSync(dbFile,JSON.stringify(db));fs.writeFileSync(process.env.PDL_PLATFORM_FILE,JSON.stringify({users:[],sessions:[]}));
const realFetch=global.fetch;let base='',providerCalls=0;
global.fetch=(url,options)=>{if(!base||!String(url).startsWith(base+'/')){providerCalls++;throw Error('External provider calls forbidden in authorization tests')}return realFetch(url,options)};
const {server}=require('./server');
const {makePdf}=require('./estimate-pdf.test');
const pdf='data:application/pdf;base64,'+makePdf(['Description Quantity Unit Amount','Synthetic scope 10 SF $100.00','Total $100.00']).toString('base64');
const scan='data:application/pdf;base64,'+Buffer.from('%PDF-1.4\n%%EOF').toString('base64');
const line={description:'Synthetic item',quantity:10,unit:'EA',amount:100,budgetHours:20};
const proposal={name:'Synthetic submitted scope',plannedQuantity:2,unit:'EA'};
const item={name:'Synthetic item',plannedQuantity:10,unit:'EA',budgetHours:20,cost:100};
const read=()=>JSON.parse(fs.readFileSync(dbFile,'utf8'));
const alter=fn=>{const current=read();fn(current);fs.writeFileSync(dbFile,JSON.stringify(current))};
const files=()=>fs.existsSync(uploadsDir)?fs.readdirSync(uploadsDir).sort():[];
const call=async(route,user,input={},method='POST')=>{const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+token(user)},...(method==='GET'?{}:{body:JSON.stringify(input)})});return {status:response.status,data:await response.json()}};
const denied=async(route,user,input,status=403,method='POST')=>{const before=fs.readFileSync(dbFile,'utf8'),assets=files(),calls=providerCalls,result=await call(route,user,input,method);assert.equal(result.status,status,`${user} ${method} ${route}: ${JSON.stringify(result.data)}`);assert.equal(fs.readFileSync(dbFile,'utf8'),before,'denial cannot mutate snapshot');assert.deepEqual(files(),assets,'denial cannot save uploads');assert.equal(providerCalls,calls,'denial cannot invoke OCR/storage provider');return result};
const analyze=async(user=1,input={})=>{const result=await call('/api/estimate-imports/analyze',user,{filename:'synthetic.pdf',data:pdf,...input});assert.equal(result.status,201,JSON.stringify(result.data));return result.data};
const approve=(id,user,projectId=p1,extra={})=>call(`/api/estimate-imports/${id}/approve`,user,{projectId,lines:[line],...extra});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
try{
 await call('/api/state',1,{},'GET');
 if(process.argv.includes('--reproduce')){
  const draft=await analyze(1),checks=[
   ['unpriced manager analyze','/api/estimate-imports/analyze',4,{data:pdf}],
   ['manager import other project',`/api/estimate-imports/${draft.id}/approve`,3,{projectId:p2,lines:[line]}],
   ['manager proposal other project',`/api/projects/${p2}/estimate-proposals`,3,proposal],
   ['manager approve other project',`/api/projects/${p2}/estimate-proposals/1/approve`,3,{}],
   ['field direct estimate other project',`/api/projects/${p2}/estimate-items`,5,item],
   ['manager catalog other project','/api/catalog/1/apply',3,{projectId:p2,plannedQuantity:2}]
  ];for(const [label,route,user,input] of checks){const r=await call(route,user,input);assert.ok(r.status<300,label+' reproduction');console.log('REPRODUCED:',label,r.status)}return;
 }
 // No pricing or financial mutations for field/foreman/unpriced manager.
 for(const user of [4,5,6,7]){
  process.env.OPENAI_API_KEY='synthetic-denial-sentinel';
  await denied('/api/estimate-imports/analyze',user,{data:scan});
  process.env.OPENAI_API_KEY='';
  await denied(`/api/projects/${p1}/estimate-items`,user,item);
  await denied('/api/catalog/1/apply',user,{projectId:p1,plannedQuantity:2});
  await denied(`/api/projects/${p1}/estimate-proposals/1/approve`,user,{});
 }
 for(const route of [`/api/projects/${p2}/estimate-items`,`/api/projects/${p2}/estimate-proposals`,`/api/projects/${p2}/estimate-proposals/1/approve`])await denied(route,3,{...item,...proposal},404);
 await denied('/api/catalog/1/apply',3,{projectId:p2,plannedQuantity:2},404);
 process.env.OPENAI_API_KEY='synthetic-denial-sentinel';
 await denied(`/api/projects/${p2}/estimate-proposals`,3,{data:scan},404);
 await denied('/api/estimate-imports/analyze',3,{data:scan,projectId:p2},404);
 process.env.OPENAI_API_KEY='';
 for(const user of [3,4,5,6])assert.equal((await call(`/api/projects/${p1}/estimate-proposals`,user,proposal)).status,201);
 for(const user of [5,6])assert.equal((await call(`/api/projects/${p1}/estimate-proposals`,user,{data:pdf,filename:'field-scope.pdf'})).status,201,'assigned field PDF scope remains supported');
 for(const user of [5,6,7])await denied(`/api/projects/${p2}/estimate-proposals`,user,proposal,403);
 // Owner/admin bypass pricing policy; manager selected pricing is honored.
 alter(d=>{d.company.pricingAccess.enabled=false});
 for(const user of [1,2]){const draft=await analyze(user);assert.equal((await approve(draft.id,user)).status,200)}
 await denied('/api/estimate-imports/analyze',3,{data:pdf});
 alter(d=>{d.company.pricingAccess.enabled=true});
 const own=await analyze(3,{createdByUserId:1});assert.equal(own.createdByUserId,3,'creator is server-derived');
 const other=await analyze(8);
 await denied(`/api/estimate-imports/${other.id}/approve`,3,{projectId:p1,lines:[line]},404);
 assert.equal((await approve(own.id,3)).status,200);
 await denied(`/api/estimate-imports/${own.id}/approve`,3,{projectId:p1,lines:[line]},409);
 const bound=await analyze(8,{projectId:p2});assert.equal(bound.projectId,p2);
 await denied(`/api/estimate-imports/${bound.id}/approve`,3,{projectId:p1,lines:[line]},404);
 for(const user of [1,8])await denied(`/api/estimate-imports/${bound.id}/approve`,user,{projectId:p1,lines:[line]},409);
 assert.equal((await approve(bound.id,8,p2)).status,200);
 const scoped=await analyze(3,{projectId:p1});assert.equal((await approve(scoped.id,3)).status,200);
 const ownerBound=await analyze(1,{projectId:p1});assert.equal((await approve(ownerBound.id,3)).status,200,'bound accessible project draft can be collaboratively approved');
 const legacyId=read().estimateImports.reduce((n,r)=>Math.max(n,r.id),0)+1;
 alter(d=>d.estimateImports.push({id:legacyId,status:'Draft',lines:[line]}));
 await denied(`/api/estimate-imports/${legacyId}/approve`,3,{projectId:p1,lines:[line]},404);
 assert.equal((await approve(legacyId,2)).status,200);
 const revoke=await analyze(3,{projectId:p1});
 alter(d=>{d.company.pricingAccess.userIds=[8]});
 await denied(`/api/estimate-imports/${revoke.id}/approve`,3,{projectId:p1,lines:[line]});
 alter(d=>{d.company.pricingAccess.userIds=[3,8];d.users.find(u=>u.id===3).projectIds=[]});
 await denied(`/api/estimate-imports/${revoke.id}/approve`,3,{projectId:p1,lines:[line]},404);
 alter(d=>{d.users.find(u=>u.id===3).projectIds=[p1]});
 for(const user of [4,5,6])await denied(`/api/estimate-imports/${revoke.id}/approve`,user,{projectId:p1,lines:[line]});
 for(const user of [1,2,3]){
  assert.equal((await call(`/api/projects/${p1}/estimate-items`,user,item)).status,201);
  assert.equal((await call('/api/catalog/1/apply',user,{projectId:p1,plannedQuantity:2})).status,201);
  const pending=await call(`/api/projects/${p1}/estimate-proposals`,user,proposal),id=pending.data.proposals.at(-1).id;
  assert.equal((await call(`/api/projects/${p1}/estimate-proposals/${id}/approve`,user)).status,200);
 }
 const estimateId=read().projects[0].estimateItems[0].id;
 for(const method of ['PATCH','PUT','DELETE'])await denied(`/api/projects/${p1}/estimate-items/${estimateId}`,3,item,403,method);
 const repeated=await analyze(3,{projectId:p1}),beforeCount=read().projects[0].estimateItems.length;
 const concurrent=await Promise.all([approve(repeated.id,3),approve(repeated.id,3)]);
 assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409],'tenant queue makes repeated approvals single-use');
 assert.equal(read().projects[0].estimateItems.length,beforeCount+1);
 await denied('/api/estimate-imports/analyze','missing',{data:pdf},401);
 const unrelated=structuredClone(read()),otherCompanyId='e5711000-0000-4000-8000-000000000002';
 unrelated.company.id=otherCompanyId;unrelated.sessions=[];unrelated.users=[];
 const otherFile=path.join(temp,'tenants',otherCompanyId+'.json');fs.mkdirSync(path.dirname(otherFile),{recursive:true});fs.writeFileSync(otherFile,JSON.stringify(unrelated));
 const ownBefore=fs.readFileSync(dbFile,'utf8'),otherBefore=fs.readFileSync(otherFile,'utf8'),beforeFiles=files();
 const crossTenant=await fetch(base+`/api/estimate-imports/${repeated.id}/approve`,{method:'POST',headers:{'Content-Type':'application/json','X-PDL-Company':otherCompanyId,Authorization:'Bearer '+token(1)},body:JSON.stringify({projectId:p1,lines:[line]})});
 assert.ok([401,404].includes(crossTenant.status),'cross-tenant token cannot approve another tenant import');
 assert.equal(fs.readFileSync(dbFile,'utf8'),ownBefore);assert.equal(fs.readFileSync(otherFile,'utf8'),otherBefore);assert.deepEqual(files(),beforeFiles);
 assert.equal(providerCalls,0);
 console.log('Estimate authorization passed: role, pricing, project scope, trusted import provenance, retarget/repeat denial, revocation, field proposals, and no denied-request side effects.');
}finally{await new Promise(r=>server.close(r));global.fetch=realFetch;fs.writeFileSync=nativeWrite;for(const file of writtenUploads)if(fs.existsSync(file))fs.unlinkSync(file);fs.rmSync(temp,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1;server.close()});
