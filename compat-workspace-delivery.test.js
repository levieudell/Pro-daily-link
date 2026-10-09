'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {A,B,memory}=require('./compat-account-fixture'),{workspaceSnapshot}=require('./compat-workspace-fixture'),{createCompliance,jobs}=require('./compat-workspace-delivery');
const registry=require('./capability-registry');
function fixture(provider=async()=>({status:'accepted'})){
 const db=workspaceSnapshot(),session={id:crypto.randomUUID(),companyId:A,userId:1,tokenHash:'a'.repeat(64),expiresAt:new Date(Date.now()+60000).toISOString(),createdAt:new Date().toISOString()};db.sessions=[session];db.subcontractors=[{id:51,companyId:A,name:'Synthetic Subcontractor',contact:'Synthetic Contact',email:'synthetic@example.invalid',autoComplianceReminders:true}];
 const store=memory(db),key=crypto.randomBytes(32);let calls=0;
 const authenticateSession=(snapshot,hash)=>{const selected=snapshot.sessions.find(row=>row.tokenHash===hash&&Date.parse(row.expiresAt)>Date.now()),user=selected&&snapshot.users.find(row=>row.id===selected.userId&&row.status==='Active');return user?{session:selected,user:registry.actor(snapshot,user),companyId:A}:null;};
 const service=createCompliance({repository:store,companyId:A,key,requirements:()=>[{key:'w9',label:'W-9 status',state:'missing',stage:'missing'}],authenticateSession,accountAccess:()=>({locked:false,status:'Active'}),send:async(...args)=>{calls++;return provider(store,...args);}});
 const request={auth:authenticateSession(db,session.tokenHash)};
 async function stage(){const loaded=await store.load(A);if(service.stage(loaded.snapshot,request))await store.commit(loaded.snapshot,loaded.revision);return store.current()[jobs].at(-1).id;}
 async function mutate(change){const loaded=await store.load(A);change(loaded.snapshot);await store.commit(loaded.snapshot,loaded.revision);}
 return {store,service,stage,mutate,calls:()=>calls};
}
async function main(){
 let f=fixture(),id=await f.stage(),result=await f.service.dispatch(id);assert.equal(result.status,'sent');assert.equal(f.calls(),1);assert.equal(f.store.current().subcontractors[0].complianceReminderStages.w9,'missing');assert.equal((await f.service.dispatch(id)).status,'sent');assert.equal(f.calls(),1);
 for(const receipt of [{status:'unknown'},{status:'accepted',rejected:true},null]){f=fixture(async()=>receipt);id=await f.stage();assert.equal((await f.service.dispatch(id)).status,'uncertain');assert.equal(f.calls(),1);assert.equal(await f.stage(),id);await f.service.dispatch(id);assert.equal(f.calls(),1);assert.equal(f.store.current().subcontractors[0].complianceReminderStages,undefined);}
 f=fixture(async()=>({status:'rejected'}));id=await f.stage();assert.equal((await f.service.dispatch(id)).status,'rejected');const retry=await f.stage();assert.notEqual(retry,id);assert.equal((await f.service.dispatch(retry)).status,'rejected');assert.equal(f.calls(),2);
 for(const poison of [db=>{db.users[0].companyId=B;},db=>{db.users.push({...db.users[0]});},db=>{db.sessions[0].companyId=B;},db=>{db.subcontractors[0].companyId=B;},db=>{db.team[1].crew=['Synthetic Crew'];},db=>{db[jobs][0].source.email='other@example.invalid';}]){f=fixture();id=await f.stage();await f.mutate(poison);await assert.rejects(f.service.dispatch(id));assert.equal(f.calls(),0);}
 f=fixture();id=await f.stage();await f.mutate(db=>{db.users[0].status='Deactivated';});assert.equal((await f.service.dispatch(id)).status,'cancelled');assert.equal(f.calls(),0);
 f=fixture();id=await f.stage();f.store.loseCommitAck=true;await assert.rejects(f.service.dispatch(id),error=>error.code==='PDL_COMMIT_OUTCOME_UNKNOWN');assert.equal(f.calls(),0);assert.equal((await f.service.dispatch(id)).status,'uncertain');assert.equal(f.calls(),0);
 f=fixture(async store=>{store.loseCommitAck=true;return {status:'accepted'};});id=await f.stage();await assert.rejects(f.service.dispatch(id),error=>error.code==='PDL_COMMIT_OUTCOME_UNKNOWN');assert.equal((await f.service.dispatch(id)).status,'sent');assert.equal(f.calls(),1);
 f=fixture(async store=>{const current=await store.load(A);current.snapshot.subcontractors[0].email='changed@example.invalid';await store.commit(current.snapshot,current.revision);return {status:'accepted'};});id=await f.stage();await assert.rejects(f.service.dispatch(id));assert.equal((await f.service.dispatch(id)).status,'uncertain');assert.equal(f.calls(),1);assert.equal(f.store.current().subcontractors[0].complianceReminderStages,undefined);
 console.log('workspace compliance: accepted/rejected/unknown, canonical source poisons, revocation, claim/final ACK loss and no ambiguous resend passed');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
