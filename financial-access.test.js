'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {PUBLIC_FILES} = require('./public-file-policy');
assert.ok(PUBLIC_FILES.has('enterprise-pricing.css'),'retain the public stylesheet added by latest main');
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'pdl-financial-acceptance-'));
process.env.PDL_DB_FILE = path.join(temp,'db.json');
process.env.PDL_PLATFORM_FILE = path.join(temp,'platform.json');
process.env.PDL_SUPABASE_ENABLED = '0';
process.env.PDL_TRANSACTIONAL_DB = 'off';
process.env.PDL_REQUIRE_AUTH = '1';
process.env.PDL_EMAIL_DEV_MODE = '1';
for(const key of ['SENTRY_DSN','RESEND_API_KEY','OPENAI_API_KEY','STRIPE_SECRET_KEY']) delete process.env[key];
const seed = JSON.parse(fs.readFileSync(path.join(__dirname,'data/db.json'),'utf8'));
const projectId = seed.projects[0].id, secondId = seed.projects[1].id, memberId = seed.team[0].id;
const uploadedNames = [0,1,2].map(()=>`qa-security-${crypto.randomUUID()}.jpg`);
for(const name of uploadedNames)fs.writeFileSync(path.join(__dirname,'uploads',name),'synthetic-private-file');
seed.photos = [0,1].map(index=>({id:index+1,project:index,url:'/uploads/'+uploadedNames[index]}));
seed.company.demo = true;
seed.company.pricingAccess = { enabled:true,officeMode:'selected',userIds:[4] };
seed.projects[0].contractValue = 12345;
seed.projects[0].contractType = 'tm';
seed.projects[0].budget = '$12,345';
seed.projects[0].tmSettings = { defaultLaborRate:100,materialMarkup:15,equipmentMarkup:20 };
seed.projects[0].estimateItems = [{id:101,name:'QA production',plannedQuantity:100,budgetHours:40,unit:'SF',cost:999}];
seed.projects[1].contractValue = 99999;
seed.reports = [
  {id:1,status:'Approved',dateIso:'2026-10-01',quantity:10,hours:8},
  {id:2,status:'Approved',dateIso:'2026-10-02',quantity:20,hours:4},
  {id:3,status:'Draft',dateIso:'2026-10-03',quantity:999,hours:99}
].map(row=>({...row,project:0,foreman:seed.team[0].name,notes:'Synthetic acceptance',signature:'QA',flags:[],laborEntries:[{memberId,hours:row.hours}],productionEntries:[{estimateItemId:101,description:'QA production',quantity:row.quantity,unit:'SF',laborHours:row.hours}]}));
for(const report of seed.reports.filter(row=>row.status==='Approved'))report.rateSnapshot={schemaVersion:1,laborRate:100,capturedAt:'2026-10-02T00:00:00Z',capturedBy:{id:1,name:'QA',role:'owner'},source:'synthetic-fixture'};
seed.assignments = [{id:1,projectId,memberIds:[memberId],date:'2026-10-01',start:'07:00',end:'15:00'}];
seed.workdays = [];
seed.users = [
  {id:1,role:'owner'}, {id:2,role:'field',memberId},
  {id:3,role:'project_manager',projectIds:[projectId],assignedCrews:[seed.team[0].crew],permissions:{viewDailies:true,viewTime:true}},
  {id:4,role:'project_manager',projectIds:[projectId],assignedCrews:[seed.team[0].crew],permissions:{viewDailies:true,viewTime:true}},
  {id:5,role:'foreman',memberId}
].map(user=>({...user,name:'Synthetic '+user.role,email:`qa${user.id}@example.invalid`,status:'Active',companyId:seed.company.id,emailVerifiedAt:'2026-10-01T00:00:00Z'}));
seed.sessions = seed.users.map(user=>({userId:user.id,companyId:seed.company.id,tokenHash:crypto.createHash('sha256').update('synthetic-token-'+user.id).digest('hex'),expiresAt:'2099-01-01T00:00:00Z'}));
fs.writeFileSync(process.env.PDL_DB_FILE,JSON.stringify(seed));
fs.copyFileSync(path.join(__dirname,'data/platform.json'),process.env.PDL_PLATFORM_FILE);
const {server,canReadStoredAsset} = require('./server');
const cloudFixture={...seed,photos:[{project:0,bucket:'project-photos',objectKey:'synthetic-tenant/photo.jpg'}]};
const cloudAsset={bucket:'project-photos',objectKey:'synthetic-tenant/photo.jpg'};
assert.equal(canReadStoredAsset(cloudFixture,seed.users[1],cloudAsset),true,'assigned cloud reference');
assert.equal(canReadStoredAsset({...cloudFixture,photos:[{project:1,...cloudAsset}]},seed.users[1],cloudAsset),false,'unassigned cloud reference');
assert.equal(canReadStoredAsset(cloudFixture,seed.users[0],{...cloudAsset,objectKey:'orphan.jpg'}),false,'orphan cloud reference');

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const get=async(route,user)=>{const response=await fetch(base+route,{headers:{Authorization:'Bearer synthetic-token-'+user}});return{status:response.status,data:await response.json()}};
  try {
    const owner=await get(`/api/projects/${projectId}/tm-summary`,1);
    assert.equal(owner.status,200);assert.equal(owner.data.approvedDailies,2);
    assert.equal(owner.data.laborHours,12);assert.equal(owner.data.laborAmount,1200);
    for(const user of [2,3,5]) assert.equal((await get(`/api/projects/${projectId}/tm-summary`,user)).status,403,'unauthorized pricing role '+user);
    assert.equal((await get(`/api/projects/${projectId}/tm-summary`,4)).status,200);
    assert.equal((await get(`/api/projects/${secondId}/tm-summary`,4)).status,404,'priced manager cannot read unassigned project');
    for(const user of [2,3]) {
      const state=await get('/api/state',user);assert.equal(state.status,200);
      assert.ok(state.data.projects.length>0);
      for(const project of state.data.projects){
        for(const key of ['budget','contractValue','tmSettings']) assert.equal(Object.hasOwn(project,key),false,`${user}: ${key} must be absent`);
        assert.ok(project.estimateItems.every(item=>!Object.hasOwn(item,'cost')));
      }
    }
    const production=await get('/api/production',1);assert.equal(production.status,200);
    const item=production.data.projects.find(project=>project.projectId===projectId).items[0];
    assert.equal(item.actualQuantity,30);assert.equal(item.actualLaborHours,12);
    assert.equal(item.quantityPercent,30);assert.equal(item.laborPercent,30);
    assert.equal((await get('/api/production',2)).status,403);
    assert.equal((await get('/api/production',3)).status,403);
    // Repeat reads must not count approved work twice.
    assert.deepEqual((await get('/api/production',1)).data,production.data);
    for(const route of ['/data/db.json','/data/platform.json','/.env.example','/.git/HEAD','/server.js','/package.json','/test.js','/database/supabase.js','/node_modules/stripe/package.json']){
      assert.equal((await fetch(base+route)).status,404,'private static file denied: '+route);
    }
    for(const route of ['/','/app','/signup.html','/login.html','/csv-cell.js','/app.js','/assets/pro-daily-link-logo.png']){
      assert.equal((await fetch(base+route)).status,200,'public asset preserved: '+route);
    }
    for(const user of [1,2,4]){
      const response=await fetch(base+'/uploads/'+uploadedNames[0],{headers:{Authorization:'Bearer synthetic-token-'+user}});
      assert.equal(response.status,200,'assigned private file remains available to user '+user);
      assert.equal(await response.text(),'synthetic-private-file');
      assert.match(response.headers.get('cache-control'),/private/);
    }
    assert.equal((await fetch(base+'/uploads/'+uploadedNames[0])).status,401,'anonymous upload denied after protected redirect');
    for(const user of [2,3,4])assert.equal((await fetch(base+'/uploads/'+uploadedNames[1],{headers:{Authorization:'Bearer synthetic-token-'+user}})).status,404,'unassigned upload denied');
    assert.equal((await fetch(base+'/uploads/'+uploadedNames[2],{headers:{Authorization:'Bearer synthetic-token-1'}})).status,404,'orphan file denied even to owner');
    console.log('Financial/static acceptance passed: approved-only totals, pricing/project scope, contract redaction, private-file denial and scoped attachment access.');
  } finally {
    await new Promise(resolve=>server.close(resolve));
    for(const name of uploadedNames)fs.unlinkSync(path.join(__dirname,'uploads',name));
    fs.rmSync(temp,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
