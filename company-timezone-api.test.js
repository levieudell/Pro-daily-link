'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {fixture,companyA,companyB,token}=require('./fixtures/project-assistant');
const {splitSnapshot,assembleSnapshot}=require('./database/transactional-repository');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-timezone-cloud-')),dbFile=path.join(temp,'db.json'),tenantFile=path.join(temp,'tenants',companyA+'.json');
fs.writeFileSync(dbFile,JSON.stringify(fixture(companyB)));fs.writeFileSync(path.join(temp,'platform.json'),JSON.stringify({users:[],sessions:[]}));
Object.assign(process.env,{PDL_DB_FILE:dbFile,PDL_PLATFORM_FILE:path.join(temp,'platform.json'),PDL_REQUIRE_AUTH:'1',PDL_SUPABASE_ENABLED:'1',SUPABASE_URL:'https://timezone-fixture.invalid',SUPABASE_SECRET_KEY:'synthetic-not-a-real-key',PDL_TRANSACTIONAL_DB:'off',PDL_ASSISTANT_AI_ENABLED:'0',OPENAI_API_KEY:'',PDL_EMAIL_DEV_MODE:'1'});
for(const key of ['SENTRY_DSN','RESEND_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','SUPABASE_SERVICE_ROLE_KEY','DATABASE_URL'])delete process.env[key];
let cloud,revision=0,cloudWrites=0;const realFetch=global.fetch;
global.fetch=async(url,options={})=>{
  const parsed=new URL(url);assert.equal(parsed.origin,'https://timezone-fixture.invalid','unexpected external request forbidden');
  assert.equal(options.headers.Authorization,'Bearer synthetic-not-a-real-key');
  if(parsed.pathname==='/rest/v1/companies'&&options.method==='POST'){const [row]=JSON.parse(options.body);assert.equal(row.id,companyA);cloud=structuredClone(row.data);cloudWrites++;return new Response('',{status:200});}
  if(parsed.pathname==='/rest/v1/companies')return Response.json([{id:companyA,data:structuredClone(cloud)}]);
  if(parsed.pathname==='/rest/v1/tenant_revisions')return Response.json([{revision,scalar_data:splitSnapshot(cloud).scalarData,content_hash:'synthetic'}]);
  if(parsed.pathname==='/rest/v1/tenant_records')return Response.json(splitSnapshot(cloud).records.map(row=>({collection:row.collection,data:row.data})));
  if(parsed.pathname==='/rest/v1/rpc/replace_tenant_records'){const input=JSON.parse(options.body);assert.equal(input.p_company_id,companyA);assert.equal(input.p_expected_revision,revision);cloud=assembleSnapshot(input.p_scalar_data,input.p_records);cloudWrites++;return Response.json([{revision:++revision,record_count:input.p_records.length}]);}
  throw Error('Unexpected mock cloud path '+parsed.pathname);
};
require('./database/backup-verification').backupDue=()=>false;
const {server}=require('./server');
async function main(){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
async function call(route,input,user=1){const response=await realFetch(base+route,{method:input?'PATCH':'GET',headers:{'X-PDL-Company':companyA,Authorization:'Bearer '+token(companyA,user),'Content-Type':'application/json'},...(input?{body:JSON.stringify(input)}:{})});return{status:response.status,data:await response.json()};}
function reset(zone){cloud=fixture();if(zone===undefined)delete cloud.company.timezone;else cloud.company.timezone=zone;revision=0;if(fs.existsSync(tenantFile))fs.unlinkSync(tenantFile);}
try{
  for(const mode of ['off','primary']){
    process.env.PDL_TRANSACTIONAL_DB=mode;reset();assert.equal(fs.existsSync(tenantFile),false,'start cloud-only, with no local tenant JSON');
    let saved=await call('/api/company',{name:'Synthetic renamed company'});assert.equal(saved.status,200);assert.equal(Object.hasOwn(saved.data,'timezone'),false);assert.equal(Object.hasOwn(cloud.company,'timezone'),false,'unrelated Save never chooses Pacific');
    saved=await call('/api/company',{name:'Synthetic renamed company',timezone:''});assert.equal(saved.status,200);assert.equal(Object.hasOwn(cloud.company,'timezone'),false,'blank displayed choice is not persisted as a default');
    saved=await call('/api/company',{name:'Old page unrelated edit',timezone:'America/Los_Angeles'});assert.equal(saved.status,200);assert.equal(Object.hasOwn(cloud.company,'timezone'),false,'old bundles cannot save the Pacific display fallback');
    for(const zone of ['America/Los_Angeles','America/Denver','America/Chicago','America/New_York','UTC','America/Phoenix']){
      reset(zone==='UTC'||zone==='America/Phoenix'?zone:undefined);
      const data={name:'Synthetic company',timezone:zone,timezoneSelected:true,trade:'Construction',email:'owner@example.invalid',phone:'',weekStart:'monday',overtimeRule:'weekly40',pricingAccess:{enabled:true,officeMode:'all',userIds:[]}};
      saved=await call('/api/company',data);assert.equal(saved.status,200);assert.equal(saved.data.timezone,zone);assert.equal(cloud.company.timezone,zone);
      assert.equal((await call('/api/company/contract-value-tracking',{enabled:false})).data.timezone,zone,'second request from normal settings Save preserves timezone');
      if(fs.existsSync(tenantFile))fs.unlinkSync(tenantFile); // Reload through the real cloud adapter/projection.
      const state=await call('/api/state'),context=await call('/api/projects/101/assistant/context');assert.equal(state.status,200);assert.equal(state.data.company.timezone,zone);assert.equal(context.data.timezone,zone);
      const before=JSON.stringify(cloud),count=cloudWrites;
      for(const user of [2,4])assert.equal((await call('/api/company',{name:'Unauthorized timezone edit',timezone:'America/Los_Angeles'},user)).status,403);
      assert.equal(cloudWrites,count);assert.equal(JSON.stringify(cloud),before);
      saved=await call('/api/company',{name:'Unrelated profile edit',timezone:''});assert.equal(saved.status,200);assert.equal(cloud.company.timezone,zone);
      saved=await call('/api/company',{name:'Another unrelated edit'});assert.equal(saved.status,200);assert.equal(cloud.company.timezone,zone);
      saved=await call('/api/company',{name:'Old client unrelated edit',timezone:'America/Los_Angeles'});assert.equal(saved.status,200);assert.equal(cloud.company.timezone,zone,'unmarked stale/default timezone never overwrites the current zone');
      const invalidBefore=JSON.stringify(cloud),invalidCount=cloudWrites;assert.equal((await call('/api/company',{name:'Invalid edit',timezone:'not/a-zone',timezoneSelected:true})).status,400);assert.equal(cloudWrites,invalidCount);assert.equal(JSON.stringify(cloud),invalidBefore);
      assert.equal((cloud.assignments||[]).length,0);assert.equal((cloud.reports||[]).length,0);
    }
  }
  assert.equal(JSON.parse(fs.readFileSync(dbFile)).company.timezone,'America/Los_Angeles','other tenant stays unchanged');
  console.log('Company timezone cloud-only API tests passed: explicit normal settings Save, second Save request, real snapshot/transactional adapters, cold reload, assistant projection, no defaults on unrelated saves, legacy zones and RBAC.');
}finally{global.fetch=realFetch;await new Promise(resolve=>server.close(resolve));}}
main().catch(error=>{console.error(error);process.exitCode=1;});
