const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

process.env.NODE_ENV='test';
process.env.PDL_REQUIRE_AUTH='0';
process.env.PDL_PLATFORM_DEV_BYPASS='1';
process.env.PDL_SUPABASE_ENABLED='0';
process.env.PDL_TRANSACTIONAL_DB='off';
process.env.PDL_PLATFORM_TRANSACTIONAL_DB='off';

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-lifecycle-'));
const primary=JSON.parse(fs.readFileSync(path.join(__dirname,'data','db.json'),'utf8'));
const tenant=structuredClone(primary),tenantId='33333333-3333-4333-8333-333333333333';
primary.company.id='11111111-1111-4111-8111-111111111111';primary.company.name='Operational primary';
tenant.company.id=tenantId;tenant.company.name='Lifecycle Test Co';tenant.company.archivedDuplicate=false;
tenant.sessions=[{tokenHash:'session-secret',expiresAt:'2099-01-01T00:00:00.000Z'}];
tenant.subcontractorLinks=[{id:1,status:'Active',tokenHash:'guest-secret'}];
tenant.changes=[{id:1,customerTokenHash:'change-secret'}];
tenant.users=[{id:1,name:'Owner One',email:'owner@example.test',role:'owner',status:'Active',resetTokenHash:'reset-secret'}];
fs.mkdirSync(path.join(temp,'tenants'),{recursive:true});
fs.writeFileSync(path.join(temp,'db.json'),JSON.stringify(primary));
fs.writeFileSync(path.join(temp,'tenants',`${tenantId}.json`),JSON.stringify(tenant));
fs.writeFileSync(path.join(temp,'platform.json'),JSON.stringify({users:[],sessions:[],auditEvents:[]}));
process.env.PDL_DB_FILE=path.join(temp,'db.json');process.env.PDL_PLATFORM_FILE=path.join(temp,'platform.json');

const {server,purgeExpiredTicketFiles,sweepTenantRetention,removeTenantStoredObjects}=require('./server');

async function retentionTests(){
  const due='2020-01-01T00:00:00.000Z',deleted='2019-01-01T00:00:00.000Z';
  const unavailable={projectTickets:[{id:1,deletedAt:deleted,retainedUntil:due,bucket:'project-tickets',objectKey:'tenant/file.pdf',url:'/api/files/project-tickets/tenant/file.pdf'}]};
  assert.equal(await purgeExpiredTicketFiles(unavailable,new Date('2021-01-01'),{storage:{configured:()=>false},root:temp}),true);
  assert.equal(unavailable.projectTickets[0].objectKey,'tenant/file.pdf','missing provider must preserve the storage pointer');
  assert.equal(unavailable.projectTickets[0].purgedAt,undefined);
  assert.equal(unavailable.projectTickets[0].purgeRetry.status,'Retry required');

  const unconfirmed={projectTickets:[{id:2,deletedAt:deleted,retainedUntil:due,bucket:'project-tickets',objectKey:'tenant/file.pdf'}]};
  await purgeExpiredTicketFiles(unconfirmed,new Date('2021-01-01'),{storage:{configured:()=>true,remove:async()=>false},root:temp});
  assert.equal(unconfirmed.projectTickets[0].objectKey,'tenant/file.pdf','unconfirmed provider deletion must preserve the pointer');

  const confirmed={projectTickets:[{id:3,deletedAt:deleted,retainedUntil:due,bucket:'project-tickets',objectKey:'tenant/file.pdf'}]};
  await purgeExpiredTicketFiles(confirmed,new Date('2021-01-01'),{storage:{configured:()=>true,remove:async()=>true},root:temp});
  assert.equal(confirmed.projectTickets[0].objectKey,null);assert.ok(confirmed.projectTickets[0].purgedAt);

  const localDir=path.join(temp,'uploads','project-tickets');fs.mkdirSync(localDir,{recursive:true});const localFile=path.join(localDir,'old.pdf');fs.writeFileSync(localFile,'old');
  const local={projectTickets:[{id:4,deletedAt:deleted,retainedUntil:due,url:'/uploads/project-tickets/old.pdf'}]};
  await purgeExpiredTicketFiles(local,new Date('2021-01-01'),{storage:{configured:()=>false},root:temp});assert.equal(fs.existsSync(localFile),false);assert.equal(local.projectTickets[0].url,null);

  const inactive={company:{id:'inactive-tenant'},projectTickets:[{id:5,deletedAt:deleted,retainedUntil:due,bucket:'project-tickets',objectKey:'tenant/inactive.pdf'}]};let mutations=0;
  const results=await sweepTenantRetention(new Date('2021-01-01'),{listTenants:async()=>[inactive],mutateTenant:async(id,mutator)=>{mutations++;assert.equal(id,'inactive-tenant');return{outcome:await mutator(inactive)}},storage:{configured:()=>true,remove:async()=>true},root:temp});
  assert.equal(mutations,1,'the scheduled sweep must process tenants with no active request traffic');assert.equal(results[0].status,'processed');assert.ok(inactive.projectTickets[0].purgedAt);

  const storedDir=path.join(temp,'uploads','logos');fs.mkdirSync(storedDir,{recursive:true});const storedFile=path.join(storedDir,'tenant.png');fs.writeFileSync(storedFile,'logo');
  const objectId='44444444-4444-4444-8444-444444444444',storageSnapshot={company:{id:objectId,logo:{url:'/uploads/logos/tenant.png'}},photos:[{id:1,storageBucket:'project-photos',storageKey:`${objectId}/photo.jpg`}],projectPlans:[],projectTickets:[]};
  const objects=new Map([['project-photos',new Set([`${objectId}/photo.jpg`,`${objectId}/orphan.jpg`])]]),removedObjects=[];
  const storage={configured:()=>true,listByPrefix:async bucket=>[...(objects.get(bucket)||[])].map(objectKey=>({bucket,objectKey})),remove:async(bucket,key)=>{removedObjects.push(`${bucket}/${key}`);objects.get(bucket)?.delete(key);return true}};
  const removed=await removeTenantStoredObjects(storageSnapshot,{storage,root:temp});
  assert.deepEqual(removedObjects.sort(),[`project-photos/${objectId}/orphan.jpg`,`project-photos/${objectId}/photo.jpg`]);assert.equal(removed.removed,3);assert.equal(fs.existsSync(storedFile),false);
  await assert.rejects(()=>removeTenantStoredObjects(storageSnapshot,{storage:{configured:()=>false},root:temp}),/Cloud storage is not configured/);
}

async function apiTests(){
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`,headers={'content-type':'application/json','x-pdl-company':tenantId};
  const call=async(route,options={})=>{const response=await fetch(origin+route,{...options,headers:{...headers,...options.headers}});let body={};try{body=await response.json()}catch{}return{response,body}};
  try{
    let result=await call('/api/company/deletion-request',{method:'POST',body:JSON.stringify({confirmation:'DELETE Lifecycle Test Co'})});assert.equal(result.response.status,202);assert.equal(result.body.status,'Awaiting operator review');assert.equal(result.body.scheduledFor,undefined);assert.match(result.body.message,/billing stay active/i);
    result=await call('/api/platform/overview');const listed=result.body.companies.find(row=>row.id===tenantId);assert.equal(listed.deletionRequest.status,'Awaiting operator review');
    result=await call(`/api/platform/companies/${tenantId}/deletion-hold`,{method:'POST',body:JSON.stringify({confirmation:'BEGIN DELETE Lifecycle Test Co',billingDisposition:'no_subscription',exportDisposition:'downloaded',notes:'Verified owner and downloaded export'})});assert.equal(result.response.status,200);assert.equal(result.body.status,'Recovery hold');
    let saved=JSON.parse(fs.readFileSync(path.join(temp,'tenants',`${tenantId}.json`),'utf8'));assert.equal(saved.company.archivedDuplicate,true);assert.equal(saved.sessions.length,0);assert.equal(saved.subcontractorLinks[0].tokenHash,undefined);assert.equal(saved.changes[0].customerTokenHash,undefined);assert.equal(saved.users[0].resetTokenHash,undefined);
    result=await call('/api/state');assert.equal(result.response.status,404,'a tenant in recovery hold must not remain interactively accessible');
    result=await call(`/api/platform/companies/${tenantId}/deletion-complete`,{method:'POST',body:JSON.stringify({confirmation:'PERMANENTLY DELETE Lifecycle Test Co'})});assert.equal(result.response.status,503,'permanent deletion must fail closed without the transactional authority');
    result=await call(`/api/platform/companies/${tenantId}/deletion-cancel`,{method:'POST',body:JSON.stringify({confirmation:'CANCEL DELETE Lifecycle Test Co',reason:'Owner reversed the request'})});assert.equal(result.response.status,200);assert.equal(result.body.status,'Cancelled');
    saved=JSON.parse(fs.readFileSync(path.join(temp,'tenants',`${tenantId}.json`),'utf8'));assert.equal(saved.company.archivedDuplicate,false);assert.equal(saved.sessions.length,0,'cancelling a hold must not resurrect revoked credentials');
  }finally{await new Promise(resolve=>server.close(resolve))}
}

async function staticTests(){
  const migration=fs.readFileSync(path.join(__dirname,'database','012_operator_reviewed_tenant_deletion.sql'),'utf8');assert.match(migration,/FOR UPDATE/);assert.match(migration,/Recovery hold/);assert.match(migration,/hold_ends_at > deleted_at/);assert.match(migration,/deletion request identity mismatch/i);assert.match(migration,/REVOKE ALL ON FUNCTION[\s\S]+anon, authenticated/);
  const ui=fs.readFileSync(path.join(__dirname,'platform.js'),'utf8');assert.match(ui,/Review closure request/);assert.match(ui,/PERMANENTLY DELETE/);
}

(async()=>{try{await retentionTests();await apiTests();await staticTests();console.log('Data retention and operator-reviewed deletion workflow tests passed')}finally{fs.rmSync(temp,{recursive:true,force:true})}})().catch(error=>{console.error(error);process.exitCode=1});
