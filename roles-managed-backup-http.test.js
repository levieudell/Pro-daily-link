'use strict';
// Actual normal server/adapters; closed generated object storage and tenant transport.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {fixture,key}=require('./database/managed-backup-fixture');
const f=fixture(),root=fs.mkdtempSync(path.join(os.tmpdir(),'pdl-managed-backup-http-'));
for(const name of ['OPENAI_API_KEY','RESEND_API_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','SENTRY_DSN','PDL_PLATFORM_KEY','PDL_COMPAT_ACCOUNT_SYNTHETIC','PDL_COMPAT_GLOBAL_FENCE_FILE'])delete process.env[name];
Object.assign(process.env,{NODE_ENV:'test',PDL_REQUIRE_AUTH:'1',PDL_ROLES_COMPANIES:f.id,PDL_ROLE_POLICY_KEY:key.toString('hex'),PDL_TRANSACTIONAL_DB:'off',PDL_DB_FILE:path.join(root,'tenant.json'),PDL_PLATFORM_FILE:path.join(root,'platform.json'),PDL_SUPABASE_ENABLED:'1',SUPABASE_URL:'https://synthetic.invalid',SUPABASE_SECRET_KEY:'synthetic-only',PDL_WEEKLY_DIGEST:'0'});
fs.writeFileSync(process.env.PDL_DB_FILE,JSON.stringify(f.state.snapshot));fs.writeFileSync(process.env.PDL_PLATFORM_FILE,JSON.stringify({users:[],sessions:[]}));
const fetchBefore=global.fetch;global.fetch=async()=>{throw Error('External providers forbidden');};
const adapter=require('./database/supabase');adapter.loadLocalEnv=()=>{};let legacyCalls=0,dbWrites=0,reads=0,storageWrites=0;
adapter.configured=()=>true;adapter.health=async()=>({configured:true,reachable:true});adapter.createVerifiedBackup=async()=>{legacyCalls++;throw Error('Managed legacy backup forbidden');};adapter.saveCompanySnapshot=async()=>{legacyCalls++;throw Error('Managed legacy write forbidden');};
adapter.request=async(relative,options={})=>{
  if(relative.startsWith('/rest/v1/companies?')){reads++;assert.ok(relative.includes('id=eq.'+f.id),'Named managed source only');return new Response(JSON.stringify([{data:structuredClone(f.state.snapshot),roles_managed:true,roles_revision:f.state.revision}]));}
  if(relative==='/rest/v1/rpc/read_managed_backup_job'){const p=JSON.parse(options.body);return new Response(JSON.stringify(await f.admission.get(p.p_company_id,p.p_job_key)));}
  if(relative==='/rest/v1/rpc/list_managed_backup_jobs'){const p=JSON.parse(options.body);return new Response(JSON.stringify(await f.admission.list(p.p_company_id)));}
  if(relative==='/rest/v1/rpc/admit_managed_backup_job'){const p=JSON.parse(options.body);return new Response(JSON.stringify(await f.admission.admit(p.p_company_id,p.p_job_key,p.p_descriptor)));}
  if(relative.startsWith('/rest/v1/rpc/')){dbWrites++;throw Error('Backup must never commit a business snapshot');}
  if(relative==='/storage/v1/bucket/tenant-backups'){assert.equal(options.method,undefined);return new Response(JSON.stringify(f.state.bucket));}
  if(relative==='/storage/v1/object/list/tenant-backups'){const input=JSON.parse(options.body);assert.equal(options.method,'POST');assert.equal(input.prefix,f.id+'/managed-v1');return new Response(JSON.stringify((await f.storage.list(input.prefix)).map(name=>({name}))));}
  const m=/^\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(relative);assert.ok(m,'Closed storage request');const bucket=decodeURIComponent(m[1]),name=m[2].split('/').map(decodeURIComponent).join('/');
  if(options.method==='POST'){assert.equal(bucket,'tenant-backups');assert.equal(options.headers['x-upsert'],'false');assert.equal(options.headers['Content-Type'],'application/json');storageWrites++;await f.storage.write(name,options.body);return new Response('{}');}
  assert.equal(options.method,undefined);return new Response(await f.storage.read(bucket,name,160000000));
};
const platformFixture=require('./roles-production-platform-fixture').wrap(adapter.request);adapter.request=platformFixture.request;
const {server,startManagedBackupSelfHeal}=require('./server');
async function main(){
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
  const call=async()=>{const response=await fetchBefore(origin+'/api/health',{signal:AbortSignal.timeout(10000)});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;};
  assert.equal((await call()).services.backup.integrity,'not-checked');
  assert.deepEqual(await startManagedBackupSelfHeal(),{verified:1,failed:0});const health=await call();assert.equal(health.services.backup.sourceRevision,7);assert.equal(health.services.backup.integrity,'verified');assert.equal(health.services.backup.restore,'not-checked');assert.equal(health.services.backup.independentCopy,'not-checked');
  assert.equal(legacyCalls,0);assert.equal(dbWrites,0);assert.equal(f.state.revision,7);assert.deepEqual(f.state.snapshot,JSON.parse(fs.readFileSync(process.env.PDL_DB_FILE)));assert.ok(storageWrites>0);const original=storageWrites;await startManagedBackupSelfHeal();assert.equal(storageWrites,original);
  // Fresh configured authority is checked inside in-flight storage reads.
  const other=fixture();f.state.snapshot=other.state.snapshot;f.state.snapshot.company.name='Second synthetic revision';f.state.revision++;f.state.beforeRead=async(bucket,name)=>{if(bucket!=='tenant-backups')process.env.PDL_ROLES_COMPANIES='';};
  // The existing copy has no need for a new capture today; a separate engine
  // uses the same ordinary transport to exercise current cohort revocation.
  const {createEngine}=require('./database/managed-backup'),{createTransport}=require('./database/managed-backup-transport'),{createRepository}=require('./database/roles-snapshot-repository');
  const revoked=createEngine({key,repository:createRepository(adapter),storage:createTransport(adapter),admission:require('./database/managed-backup-admission').createAdmission(adapter),allowed:id=>process.env.PDL_ROLES_COMPANIES===id});
  await assert.rejects(revoked.capture(f.id),e=>e.code==='PDL_MANAGED_BACKUP_AUTHORITY');assert.equal(storageWrites,original);assert.equal(dbWrites,0);assert.equal(legacyCalls,0);
  console.log(JSON.stringify({passed:true,checks:14,backend:'normal-server-closed-storage-http',tenantReads:reads,immutableStorageWrites:storageWrites,businessSnapshotWrites:dbWrites,legacyCalls,externalCalls:0,productionWrites:0}));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await new Promise(resolve=>server.close(resolve));global.fetch=fetchBefore;assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('pdl-managed-backup-http-'));fs.rmSync(root,{recursive:true,force:true});});
