'use strict';
const assert=require('node:assert/strict');
const {inspect,initialize}=require('./assistant-budget-readiness');
const {PLATFORM_ID,emptyLedger}=require('../project-assistant-budget');
const {canonicalHash}=require('./transactional-repository');
async function main(){
  let row={id:PLATFORM_ID,tenant_revisions:[],tenant_records:[]},writes=0,failAck=false;
  const client={configured:()=>true,request:async(path,options={})=>{
    if(!options.method)return {json:async()=>[structuredClone(row)]};
    writes++;const body=JSON.parse(options.body);
    if(options.method==='POST'){assert.equal(body.company_id,PLATFORM_ID);assert.equal(options.headers.Prefer,'resolution=ignore-duplicates,return=minimal');if(!row.tenant_revisions.length)row.tenant_revisions=[body];}
    else{assert.match(path,/revision=eq.8/);assert.equal(body.scalar_data.privateSetting,'preserved');row.tenant_revisions=[body];}
    if(failAck){failAck=false;throw Error('Synthetic lost acknowledgement');}
    return {json:async()=>[{revision:body.revision}]};
  }};
  const missing=await inspect(client);assert.equal(missing.mode,'insert');assert.equal(writes,0);
  assert.equal((await initialize(missing,client)).mode,'ready');assert.equal(writes,1);
  assert.equal((await initialize(await inspect(client),client)).mode,'ready');assert.equal(writes,1);
  row.tenant_revisions=[{revision:8,scalar_data:{privateSetting:'preserved'},content_hash:canonicalHash({privateSetting:'preserved'})}];
  const append=await inspect(client);assert.equal(append.mode,'append');assert.equal(writes,1);assert.equal((await initialize(append,client)).mode,'ready');
  row.tenant_revisions=[];failAck=true;await assert.rejects(()=>initialize(awaitPlan(),client));
  function awaitPlan(){return {mode:'insert',records:[],scalar:{},revision:0};}
  assert.equal((await inspect(client)).mode,'ready','lost acknowledgement recovered by read, never a reset');
  row.tenant_revisions[0].scalar_data.assistantUsage={};row.tenant_revisions[0].content_hash=canonicalHash(row.tenant_revisions[0].scalar_data);await assert.rejects(()=>inspect(client),/corrupt/);
  row.tenant_revisions[0].scalar_data.assistantUsage={...emptyLedger(),closed:true};row.tenant_revisions[0].content_hash=canonicalHash(row.tenant_revisions[0].scalar_data);assert.equal((await inspect(client)).mode,'closed');
  await assert.rejects(()=>inspect({...client,configured:()=>false}),/unavailable/);
  console.log('Assistant ledger preparation passed: default read-only, existing namespace only, preserve private scalars, ignore duplicate insert, lost acknowledgement read recovery and no corrupt/closed reset.');
}
main().catch(error=>{console.error(error);process.exitCode=1});
