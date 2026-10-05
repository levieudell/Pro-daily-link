'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createSalesDemoHandler}=require('./sales-demo-route');
const {COMPANY_ID}=require('./sales-demo-data');
function emptyTenant(id=COMPANY_ID){return {company:{id,name:'DEMO | Alder Ridge Builders',createdAt:new Date().toISOString(),persistence:{revision:1}},users:[{id:1,companyId:id,name:'DEMO Existing Owner',email:'owner@example.invalid',role:'owner',status:'Active',projectIds:[],memberId:null}],sessions:[],customers:[],projects:[],team:[],reports:[],assignments:[]};}
(async()=>{
 // Injected asynchronous persistence proves that success cannot precede durable
 // confirmation, and a backup failure prevents any tenant write.
 let stored=emptyTenant(),writes=0,backups=0,sent=[],release,delay=false,backupFailure=false,rejectSave=false,active;
 const handler=createSalesDemoHandler({platformAllowed:()=>true,withTenantQueue:async(_id,task)=>task(),requestDatabase:async()=>({file:'synthetic-test',db:stored}),freshestTenantSnapshot:x=>x.db,primaryCompanyId:()=> 'northstar',readBody:async req=>req.input,reply:(_res,status,data)=>sent.push({status,data}),companyToday:()=> '2026-10-05',contextRun:async(ctx,task)=>{active=ctx;return task();},writeDb:next=>{writes++;stored=next;stored.company.persistence={revision:2};if(delay)active.pending.push(new Promise(resolve=>{release=resolve;}));if(rejectSave)active.pending.push(Promise.reject(Error('Synthetic durable write failure')));},backup:async()=>{backups++;if(backupFailure)throw Error('backup failed');return {snapshotSha256:'a'.repeat(64),createdAt:new Date().toISOString()};}});
 const req={method:'POST',platformAuth:{user:{id:1,name:'DEMO Platform Owner',role:'platform_owner'},session:{}},input:{expectedRevision:1,confirmCompanyName:stored.company.name,asOf:'2026-10-05'}};
 const url=new URL('http://localhost/api/platform/companies/'+COMPANY_ID+'/sales-demo');
 backupFailure=true;await handler(req,{},url);assert.equal(writes,0);assert.equal(sent.at(-1).status,503);
 backupFailure=false;sent=[];delay=true;const running=handler(req,{},url);await new Promise(resolve=>setImmediate(resolve));assert.equal(writes,1);assert.equal(sent.length,0);release();await running;assert.equal(sent[0].status,201);assert.equal(stored.reports.length,60);assert.deepEqual(stored.users,emptyTenant().users);
 stored=emptyTenant();sent=[];rejectSave=true;const failing=handler(req,{},url);await new Promise(resolve=>setImmediate(resolve));assert.equal(sent.length,0,'A failed write must retain queue ownership until every initiated durable write settles');release();await failing;assert.equal(sent[0].status,503);
 sent=[];await handler({...req,method:'GET',platformAuth:{user:{role:'platform_support'},session:{}}},{},url);assert.equal(sent[0].status,403);
 sent=[];await handler({...req,method:'GET',platformAuth:undefined},{},url);assert.equal(sent[0].status,403);
 console.log('Sales demo route: backup-first, awaited durable writes and actual platform-owner session checks passed.');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-sales-demo-route-'));
 const primary={company:{id:'primary-test',name:'Untouched primary'},users:[],sessions:[],projects:[],team:[],reports:[],assignments:[],photos:[],customers:[]};
 const primaryFile=path.join(dir,'db.json');fs.writeFileSync(primaryFile,JSON.stringify(primary));fs.mkdirSync(path.join(dir,'tenants'));
 const token='local-platform-owner-session',staffToken='local-platform-staff-session';
 const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
 const platform={users:[{id:1,name:'DEMO Platform Owner',role:'platform_owner',status:'Active'},{id:2,name:'DEMO Platform Staff',role:'support',status:'Active'}],sessions:[{userId:1,tokenHash:hash(token),expiresAt:'2099-01-01T00:00:00Z'},{userId:2,tokenHash:hash(staffToken),expiresAt:'2099-01-01T00:00:00Z'}]};
 fs.writeFileSync(path.join(dir,'platform.json'),JSON.stringify(platform));const target=emptyTenant(),targetFile=path.join(dir,'tenants',COMPANY_ID+'.json');fs.writeFileSync(targetFile,JSON.stringify(target));
 Object.assign(process.env,{PDL_DB_FILE:primaryFile,PDL_PLATFORM_FILE:path.join(dir,'platform.json'),PDL_REQUIRE_AUTH:'1',PDL_SUPABASE_ENABLED:'0',PDL_TRANSACTIONAL_DB:'off',PDL_PLATFORM_KEY:'local-test-platform-key-at-least-32-characters',RESEND_API_KEY:'',STRIPE_SECRET_KEY:'',STRIPE_WEBHOOK_SECRET:'',OPENAI_API_KEY:'',SENTRY_DSN:''});
 const {server}=require('./server');await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`,route='/api/platform/companies/'+COMPANY_ID+'/sales-demo';
 const request=async(route,options={})=>{const res=await fetch(base+route,{...options,headers:{cookie:`pdl_platform=${token}`,'Content-Type':'application/json',...options.headers}});return {status:res.status,data:await res.json()};};
 try{
  assert.equal((await request(route,{headers:{cookie:''}})).status,403);
  assert.equal((await request(route,{headers:{cookie:`pdl_platform=${staffToken}`}})).status,403);
  assert.equal((await request(route,{headers:{cookie:'','x-pdl-platform-key':process.env.PDL_PLATFORM_KEY}})).status,403);
  const preview=await request(route);assert.equal(preview.status,200);assert.equal(preview.data.readyToPrepare,true);assert.deepEqual(preview.data.plannedCounts,{projects:3,team:8,reports:60,timeCards:160,assignments:75});assert.deepEqual(JSON.parse(fs.readFileSync(targetFile)),target);
  const input={expectedRevision:preview.data.expectedRevision,confirmCompanyName:preview.data.companyName,asOf:preview.data.asOf};
  assert.equal((await request(route,{method:'POST',body:JSON.stringify({...input,expectedRevision:0})})).status,409);
  assert.equal((await request(route,{method:'POST',body:JSON.stringify({...input,companyId:'other'})})).status,409);
  const saved=await request(route,{method:'POST',body:JSON.stringify(input)});assert.equal(saved.status,201);assert.equal(saved.data.prepared,true);assert.equal(saved.data.url,'/app?tenant='+COMPANY_ID);
  let seeded=JSON.parse(fs.readFileSync(targetFile));assert.deepEqual(seeded.users,target.users);assert.deepEqual(seeded.sessions,target.sessions);assert.equal(seeded.company.billingExempt,true);assert.equal(seeded.company.demo,true);assert.equal(seeded.company.features.timeCards,true);
  const overview=await request('/api/platform/overview');assert.equal(overview.data.companies.find(c=>c.id===COMPANY_ID).demoResetAvailable,false);
  const files=fs.readdirSync(path.join(dir,'.demo-recovery'));assert.equal(files.length,1);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'.demo-recovery',files[0]))),target);assert.equal(fs.statSync(path.join(dir,'.demo-recovery',files[0])).mode&0o777,0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(primaryFile)),primary);const livePlatform=JSON.parse(fs.readFileSync(path.join(dir,'platform.json')));assert.deepEqual(livePlatform.users,platform.users);assert.deepEqual(livePlatform.sessions,platform.sessions);
  assert.equal((await fetch(base+'/.demo-recovery/'+files[0])).status,404);
  // A retry must preserve edits and the established owner, not reinstall seed.
  seeded.reports[0].notes='DEMO presenter change retained';fs.writeFileSync(targetFile,JSON.stringify(seeded));
  const retryPreview=await request(route);const retry=await request(route,{method:'POST',body:JSON.stringify({expectedRevision:retryPreview.data.expectedRevision,confirmCompanyName:retryPreview.data.companyName,asOf:retryPreview.data.asOf})});assert.equal(retry.status,200);seeded=JSON.parse(fs.readFileSync(targetFile));assert.equal(seeded.reports[0].notes,'DEMO presenter change retained');assert.equal(fs.readdirSync(path.join(dir,'.demo-recovery')).length,1);assert.equal(seeded.auditLog.filter(r=>r.type==='sales_demo_prepared').length,1);
  // New tenant guards are checked server-side, even for a platform owner.
  for(const change of [t=>t.projects.push({id:1}),t=>t.company.name='Real business',t=>t.company.stripeCustomerId='cus_synthetic',t=>t.company.createdAt='2025-01-01T00:00:00Z',t=>t.users.push({id:2}),t=>t.company.features={timeCards:false},t=>t.company.logo={url:'real-logo'}]){const invalid=emptyTenant();change(invalid);fs.writeFileSync(targetFile,JSON.stringify(invalid));assert.equal((await request(route)).status,409);assert.deepEqual(JSON.parse(fs.readFileSync(targetFile)),invalid);}
  assert.equal((await request(route,{method:'DELETE'})).status,405);
  console.log('Sales demo integration: anonymous/staff/key denial, read-only preview, revision guard, safe seed, private recovery, idempotent persistence, unchanged primary/auth records and invalid-tenant denial passed.');
 }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
