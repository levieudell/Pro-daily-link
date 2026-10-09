'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
process.env.NODE_ENV='test';process.env.PDL_COMPAT_ACCOUNT_SYNTHETIC='1';
const {A}=require('./compat-account-fixture'),{workspaceSnapshot}=require('./compat-workspace-fixture'),{nativeFixture}=require('./compat-lifecycle-native-fixture');
const {canonicalHash}=require('./database/transactional-repository');
const bounded=p=>Promise.race([p,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Synthetic COMMIT pause timed out')),10000);timer.unref();})]);
async function main(){
  const fixture=await nativeFixture(),repo=fixture.repository,checks=[];let release;
  const sql=fs.readFileSync(path.join(__dirname,'database','compat-synthetic-deadlines.sql'),'utf8');
  const restore=async()=>{await fixture.admin.query(sql);};
  try{
    await fixture.reset(workspaceSnapshot());let loaded=await repo.load(A),candidate=structuredClone(loaded.snapshot);candidate.company.name='Synthetic guarded save';const success=await repo.commit(candidate,loaded.revision,{deadline:new Date(Date.now()+10000).toISOString()});assert.equal(success.revision,loaded.revision+1);checks.push('current deadline permits one guarded tenant commit');
    for(const mode of ['missing','disabled']){
      if(mode==='missing')await fixture.admin.query('DROP TRIGGER compat_tenant_deadline ON public.tenant_revisions');else await fixture.admin.query('ALTER TABLE public.tenant_revisions DISABLE TRIGGER compat_tenant_deadline');
      loaded=await repo.load(A);candidate=structuredClone(loaded.snapshot);candidate.company.name='Synthetic must not save';await assert.rejects(repo.commit(candidate,loaded.revision,{deadline:new Date(Date.now()+10000).toISOString()}),error=>error.code==='PDL_COMPAT_STORAGE');assert.deepEqual(await repo.load(A),loaded);await restore();checks.push(mode+' actual-COMMIT guard fails closed without a tenant write');
    }
    loaded=await repo.load(A);candidate=structuredClone(loaded.snapshot);candidate.company.name='Synthetic expired before commit';await assert.rejects(repo.commit(candidate,loaded.revision,{deadline:new Date(Date.now()-1000).toISOString()}),error=>error.code==='PDL_REVISION_CONFLICT');assert.deepEqual(await repo.load(A),loaded);checks.push('already expired authority leaves exact source revision/hash intact');
    let signal;const paused=new Promise(resolve=>signal=resolve),gate=new Promise(resolve=>release=resolve),connect=repo.pool.connect.bind(repo.pool),originals=new Map();let armed=true;
    repo.pool.connect=async(...args)=>{const client=await connect(...args);if(!originals.has(client))originals.set(client,client.query.bind(client));const query=originals.get(client);client.query=async(text,...rest)=>{if(armed&&text==='COMMIT'){armed=false;signal();await gate;}return query(text,...rest);};return client;};
    const saving=repo.commit(candidate,loaded.revision,{deadline:new Date(Date.now()+600).toISOString()});saving.catch(()=>{});await bounded(paused);await new Promise(resolve=>setTimeout(resolve,800));release();await assert.rejects(bounded(saving),error=>error.code==='PDL_REVISION_CONFLICT');repo.pool.connect=connect;for(const [client,query] of originals)client.query=query;
    const after=await repo.load(A);assert.equal(after.revision,loaded.revision);assert.equal(after.contentHash,loaded.contentHash);assert.equal(canonicalHash(after.snapshot),canonicalHash(loaded.snapshot));checks.push('held actual COMMIT past natural deadline rolls back all records and revision');
    console.log(JSON.stringify({nativeTenantDeadline:checks,passed:checks.length,productionReady:false}));
  }finally{release?.();await restore();await fixture.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
