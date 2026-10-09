'use strict';
// Native regression for the independent synthetic sink's commit boundary.
const assert=require('node:assert/strict');
const {A}=require('./compat-account-fixture');
const {workspaceSnapshot}=require('./compat-workspace-fixture');
const {nativeFixture}=require('./compat-lifecycle-native-fixture');
const {createSink,nativeStorage}=require('./compat-workspace-platform-sink');
const {canonicalHash}=require('./database/transactional-repository');
Object.assign(process.env,{NODE_ENV:'test',PDL_COMPAT_ACCOUNT_SYNTHETIC:'1'});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const bounded=p=>Promise.race([p,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Synthetic platform lock test timed out')),10000);timer.unref();})]);
async function main(){const fixture=await nativeFixture(),checks=[];let pause,loseAck=false;
  function arm(stage){let held,release;const ready=new Promise(r=>{held=r;}),wait=new Promise(r=>{release=r;});pause={stage,held,wait,release,used:false};return {ready,release};}
  const pool={query:(...args)=>fixture.repository.pool.query(...args),async connect(){const client=await fixture.repository.pool.connect();return {release:()=>client.release(),async query(sql,args){const selected=pause&&!pause.used&&((pause.stage==='beforeTenantLock'&&sql.includes('FOR SHARE'))||(pause.stage==='beforeInsert'&&sql.startsWith('INSERT INTO public.compat_assisted_setup_receipts'))||(pause.stage==='beforeCommit'&&sql==='COMMIT'));if(selected){pause.used=true;pause.held();await pause.wait;}const result=await client.query(sql,args);if(sql==='COMMIT'&&loseAck){loseAck=false;throw Object.assign(Error('Synthetic independent platform COMMIT acknowledgement lost'),{statusCode:503});}return result;}};}};
  const sink=createSink(nativeStorage(pool));
  const descriptor={companyId:A,companyName:'Synthetic Company',subscriptionId:'sub_platform_native',id:'assisted-setup-sub_platform_native',package:'Assisted Setup'};
  async function origin(deadline=Date.now()+10000){const initial=await fixture.repository.load(A);return {deadline:new Date(deadline).toISOString(),idempotencyKey:descriptor.id,assertCurrent:async()=>{const current=await fixture.repository.load(A);assert.equal(current.revision,initial.revision,'Original tenant revision required');assert.equal(current.contentHash,initial.contentHash,'Original tenant source required');assert.equal(current.snapshot.users[0].status,'Active','Current owner required');}};}
  async function revoke(){const current=await fixture.repository.load(A);current.snapshot.users[0].status='Inactive';return fixture.repository.commit(current.snapshot,current.revision);}
  const count=async()=>Number((await fixture.admin.query('SELECT count(*)::int AS n FROM public.compat_assisted_setup_receipts WHERE company_id=$1',[A])).rows[0].n);
  try{
    await fixture.reset(workspaceSnapshot());let gate=arm('beforeTenantLock'),guard=await origin(),write=sink.ensure(descriptor,guard).then(value=>({value}),error=>({error}));await bounded(gate.ready);await revoke();gate.release();assert.ok((await bounded(write)).error);assert.equal(await count(),0);checks.push('revocation committed before tenant SHARE lock produces no platform order');
    await fixture.reset(workspaceSnapshot());gate=arm('beforeInsert');guard=await origin();write=sink.ensure(descriptor,guard).then(value=>({value}),error=>({error}));await bounded(gate.ready);let revoked=false;const revoking=revoke().then(()=>{revoked=true;});await delay(80);assert.equal(revoked,false,'Tenant revocation must wait for sink commit');gate.release();await bounded(write);await bounded(revoking);assert.equal(await count(),1);assert.equal((await fixture.repository.load(A)).snapshot.users[0].status,'Inactive');checks.push('tenant revocation waits while the authorized platform insertion holds SHARE until commit');
    await fixture.reset(workspaceSnapshot());gate=arm('beforeCommit');guard=await origin(Date.now()+2500);write=sink.ensure(descriptor,guard).then(value=>({value}),error=>({error}));await bounded(gate.ready);await delay(2700);gate.release();const expired=await bounded(write);assert.equal(expired.error?.statusCode,409);assert.equal(await count(),0);checks.push('deferred database deadline at actual COMMIT rolls back a fully staged order after natural expiry');
    await fixture.reset(workspaceSnapshot());pause=null;guard=await origin();const receipts=await Promise.all([sink.ensure(descriptor,guard),sink.ensure(descriptor,guard)]);assert.deepEqual(receipts[0],receipts[1]);assert.equal(await count(),1);assert.equal(receipts[0].sourceHash,canonicalHash(descriptor));checks.push('concurrent independent sink attempts retain one exactly bound order receipt');
    const other={...descriptor,companyName:'Changed tenant name'};await assert.rejects(sink.ensure(other,{...guard,idempotencyKey:other.id}));assert.equal(await count(),1);checks.push('same setup identity cannot be retargeted to a changed source descriptor');
    await fixture.reset(workspaceSnapshot());pause=null;guard=await origin();loseAck=true;await assert.rejects(sink.ensure(descriptor,guard),error=>error.statusCode===503);assert.equal(await count(),1);const observed=await createSink(nativeStorage(pool)).read(descriptor);assert.equal(observed.status,'accepted');assert.equal(observed.sourceHash,canonicalHash(descriptor));assert.equal(await count(),1);await assert.rejects(sink.read(other));checks.push('restarted independent observer recovers the exact committed receipt after lost COMMIT acknowledgement without inserting or retargeting');
    console.log(JSON.stringify({nativePlatformSink:checks,passed:checks.length,allowedExternalCalls:0,productionReady:false}));
  }finally{pause?.release();pause=null;await fixture.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
