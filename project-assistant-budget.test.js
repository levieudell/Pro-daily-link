'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),http=require('node:http'),{fork}=require('node:child_process');
const {createBudget,createSharedStore,emptyLedger,PLATFORM_ID,LIMITS}=require('./project-assistant-budget');
const {canonicalHash}=require('./database/transactional-repository');
const {memoryStore}=require('./fixtures/assistant-ai');
const args=(companyId='a',userId=1,cost=306300)=>({companyId,userId,cost,sessionId:crypto.randomUUID(),turnId:crypto.randomUUID(),fingerprint:crypto.randomUUID()});
const remote=base=>createSharedStore({configured:()=>true,request:async(path,options)=>{const response=await fetch(base+path,options);if(!response.ok)throw Error('Synthetic store error '+response.status);return response;}});
if(process.argv[2]==='--worker'){
  const budget=createBudget(remote(process.argv[3]),()=>new Date('2026-10-07T16:00:00Z'));
  budget.reserve(JSON.parse(process.argv[4])).then(value=>process.send({ok:true,value})).catch(error=>process.send({ok:false,code:error.code})).finally(()=>process.disconnect());
}else main().catch(error=>{console.error(error);process.exitCode=1});
async function main(){
  let time=new Date('2026-10-07T16:00:00Z');const store=memoryStore(),budget=createBudget(store,()=>time),first=args();
  const receipt=await budget.reserve(first);assert.equal((await budget.reserve(first)).duplicate,true);assert.equal(store.read().days['2026-10-07'].total,306300);
  await assert.rejects(()=>budget.reserve({...first,fingerprint:'changed'}),{code:'ASSISTANT_TURN_CHANGED'});
  await assert.rejects(()=>budget.reserve(args('a',1)),{code:'ASSISTANT_IN_FLIGHT'});
  await assert.rejects(()=>budget.reserve(args('a',2)),{code:'ASSISTANT_DAILY_LIMIT'});
  time=new Date('2026-10-08T00:00:01Z');await budget.settle(receipt,2850,{source:'synthetic'});assert.equal(store.read().days['2026-10-07'].total,2850);assert.equal(store.read().days['2026-10-08'],undefined);await budget.settle(receipt,0,{});assert.equal(store.read().days['2026-10-07'].total,2850);
  const uncertain=await budget.reserve(args('a',2));await budget.settle(uncertain,null,{});assert.equal(store.read().days['2026-10-08'].total,306300);
  const session=args('b',7,1);for(let n=0;n<8;n++){const row=await budget.reserve({...session,turnId:crypto.randomUUID()});await budget.settle(row,1,{});}await assert.rejects(()=>budget.reserve({...session,turnId:crypto.randomUUID()}),{code:'ASSISTANT_SESSION_LIMIT'});
  for(let n=0;n<2;n++){const row=await budget.reserve(args('b',7,1));await budget.settle(row,1,{});}await assert.rejects(()=>budget.reserve(args('b',7,1)),{code:'ASSISTANT_RATE_LIMIT'});
  for(let n=0;n<50;n++){const row=await budget.reserve(args('rate',n,1));await budget.settle(row,1,{});}await assert.rejects(()=>budget.reserve(args('rate',51,1)),{code:'ASSISTANT_DAILY_LIMIT'});
  const globalStore=memoryStore(),globalBudget=createBudget(globalStore,()=>time);for(let n=0;n<10;n++)await globalBudget.reserve(args('global'+n,1,500000));await assert.rejects(()=>globalBudget.reserve(args('global11',1,1)),{code:'ASSISTANT_DAILY_LIMIT'});
  const broken=memoryStore(),corrupt=emptyLedger();corrupt.days.x={total:0,companies:{a:{total:0,calls:null}}};broken.set(corrupt);await assert.rejects(()=>createBudget(broken).reserve(args()),{code:'ASSISTANT_LEDGER_UNINITIALIZED'});
  for (const damage of [ledger=>{ledger.days['2026-10-08'].companies=[];},ledger=>{delete Object.values(ledger.receipts)[0].userId;},ledger=>{ledger.sessions.x=[];}]) {
    const damaged=structuredClone(store.read());damage(damaged);const invalid=memoryStore();invalid.set(damaged);await assert.rejects(()=>createBudget(invalid).reserve(args()),{code:'ASSISTANT_LEDGER_UNINITIALIZED'});
  }
  const concurrentStore=memoryStore(),concurrentBudget=createBudget(concurrentStore,()=>time),same=args('same');
  const duplicates=await Promise.all(Array.from({length:8},()=>concurrentBudget.reserve(same)));assert.equal(duplicates.filter(row=>!row.duplicate).length,1);
  await Promise.all(duplicates.map(row=>concurrentBudget.settle(row,2850,{})));assert.equal(concurrentStore.read().days['2026-10-08'].total,2850);
  const understated=concurrentStore.read();understated.days['2026-10-08'].companies.same.total=0;understated.days['2026-10-08'].total=0;const unsafe=memoryStore();unsafe.set(understated);await assert.rejects(()=>createBudget(unsafe).reserve(args()),{code:'ASSISTANT_LEDGER_UNINITIALIZED'});
  const model=memoryStore(),modelBudget=createBudget(model,()=>time),modelReceipt=await modelBudget.reserve(args('model',1));await modelBudget.settle(modelReceipt,306301,{});await assert.rejects(()=>modelBudget.reserve(args('model',2,1)),{code:'ASSISTANT_LEDGER_CLOSED'});
  // Real child processes share a synthetic HTTP implementation of PostgreSQL CAS.
  // This proves the production adapter's conditional-update protocol; live DB permissions remain a release check.
  let revision=0,scalar={unrelatedAdministrativeSetting:'preserve',assistantUsage:emptyLedger()},patches=0,loseAck=false;
  const records=[{collection:'privateRecords',position:0,data:{id:'synthetic-preserved'}}];
  const server=http.createServer(async(req,res)=>{const url=new URL(req.url,'http://synthetic');res.setHeader('Content-Type','application/json');
    if(req.method==='GET'){res.end(JSON.stringify([{id:PLATFORM_ID,tenant_revisions:[{revision,scalar_data:scalar,content_hash:canonicalHash({...scalar,privateRecords:records.map(row=>row.data)})}],tenant_records:records}]));return;}
    let text='';for await(const part of req)text+=part;const body=JSON.parse(text),expected=Number(url.searchParams.get('revision').slice(3));
    assert.equal(url.searchParams.get('company_id'),'eq.'+PLATFORM_ID);assert.equal(req.method,'PATCH');assert.equal(req.headers.prefer,'return=representation');
    if(expected!==revision){res.end('[]');return;}assert.equal(body.revision,revision+1);assert.equal(body.scalar_data.unrelatedAdministrativeSetting,'preserve');assert.equal(body.content_hash,canonicalHash({...body.scalar_data,privateRecords:records.map(row=>row.data)}));revision++;scalar=body.scalar_data;patches++;
    if(loseAck){loseAck=false;res.destroy();return;}res.end(JSON.stringify([{revision}]));
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  try{
    const outcomes=await Promise.all(Array.from({length:24},(_,n)=>new Promise((resolve,reject)=>{const child=fork(__filename,['--worker',base,JSON.stringify(args('process'+n,1))],{silent:true,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot}});child.once('message',resolve);child.once('error',reject);child.once('exit',code=>{if(code)reject(Error('Worker failed '+code));});})));
    const successful=outcomes.filter(row=>row.ok);assert.ok(successful.length>0&&successful.length<=16);assert.equal(scalar.assistantUsage.days['2026-10-07'].total,successful.length*306300);assert.ok(scalar.assistantUsage.days['2026-10-07'].total<=LIMITS.global);
    revision++;scalar.assistantUsage=emptyLedger();const replayBudget=createBudget(remote(base),()=>new Date('2026-10-07T16:00:00Z')),lost=args('lost');loseAck=true;
    await assert.rejects(()=>replayBudget.reserve(lost));const patchCount=patches;assert.equal((await replayBudget.reserve(lost)).duplicate,true);assert.equal(patches,patchCount);assert.equal(scalar.assistantUsage.days['2026-10-07'].total,306300);
  }finally{await new Promise(resolve=>server.close(resolve));}
  console.log('Shared assistant budget passed: atomic company/global ceilings, one in flight, bounded sessions/rates, uncertain accounting, midnight settlement, replay/circuit breaking and '+patches+' cross-process conditional updates with unrelated administrative data preserved.');
}
