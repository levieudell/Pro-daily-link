'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),m=require('./roles-credential-invalidation'),{canonicalHash}=require('./database/transactional-repository');
const key=crypto.randomBytes(32),companyId=crypto.randomUUID(),hash=crypto.createHash('sha256').update('synthetic-original-generation').digest('hex');
const identity={companyId,actorId:1,role:'owner',sessionBinding:'synthetic-session-binding',authority:'synthetic-owner-authority',revision:7,expiresAt:'2099-01-01T00:00:00.000Z'};
const record={id:crypto.randomUUID(),companyId,operationId:crypto.randomUUID(),ordinal:1,kind:'email',digest:'generated-private-purpose',status:'unknown',credential:{purpose:'password-reset',userId:2,tokenHash:hash}};
const db={company:{id:companyId},users:[{id:1,companyId,role:'owner',status:'Active'},{id:2,companyId,role:'field',status:'Active',resetTokenHash:hash,resetExpiresAt:'2099-01-01T00:00:00.000Z'}],sessions:[{userId:2}],rolesProviderAttempts:[record]};
let checks=0;const deny=(task,status)=>{assert.throws(task,error=>error.statusCode===status);checks++;};
const original=canonicalHash(db),preview=m.preview(db,identity,key,{attemptId:record.id,reason:'Synthetic original-generation invalidation'});assert.equal(canonicalHash(db),original);checks++;
deny(()=>m.preview(db,{...identity,role:'admin'},key,{attemptId:record.id,reason:'No authority'}),403);
deny(()=>m.preview({...db,rolesProviderAttempts:[{...record,credential:undefined}]},identity,key,{attemptId:record.id,reason:'Missing generation'}),409);
deny(()=>m.preview({...db,users:db.users.map(row=>row.id===2?{...row,resetTokenHash:'f'.repeat(64)}:row)},identity,key,{attemptId:record.id,reason:'Different generation'}),409);
const input={proof:preview.proof,requestId:crypto.randomUUID(),confirmed:true};
deny(()=>m.confirm(db,identity,key,{...input,confirmed:false}),400);
deny(()=>m.confirm(db,identity,key,{...input,proof:preview.proof.slice(0,-1)+'x'}),403);
deny(()=>m.confirm(db,{...identity,actorId:9},key,input),403);
deny(()=>m.confirm(db,{...identity,revision:8},key,input),409);
const saved=m.confirm(db,identity,key,input);m.validateDelta(db,saved.snapshot,saved);checks++;
assert.equal(saved.snapshot.users[1].resetTokenHash,undefined);assert.equal(saved.snapshot.users[1].resetExpiresAt,undefined);assert.deepEqual(saved.snapshot.sessions,db.sessions);assert.deepEqual(saved.snapshot.rolesProviderAttempts,db.rolesProviderAttempts);checks+=4;
assert.equal(m.invalidated(saved.snapshot,record,key),true);checks++;
const replay=m.confirm(saved.snapshot,{...identity,revision:8},key,input);assert.equal(replay.result.replayed,true);assert.equal(canonicalHash(replay.snapshot),canonicalHash(saved.snapshot));checks+=2;
deny(()=>m.confirm(saved.snapshot,{...identity,revision:8},key,{...input,requestId:crypto.randomUUID()}),409);
const malicious=structuredClone(saved.snapshot);malicious[m.collection][0].credential.tokenHash='f'.repeat(64);deny(()=>m.invalidated(malicious,record,key),409);
const crossed=structuredClone(saved.snapshot);crossed.users[0].role='admin';deny(()=>m.validateDelta(db,crossed,saved),409);

// A valid MAC does not make a copied receipt authoritative in another tenant.
// Copy the original receipt and attempt intact; only current company/account
// evidence changes, so this discriminates namespace binding from MAC tampering.
const foreignCompanyId=crypto.randomUUID(),foreign=structuredClone(saved.snapshot);
foreign.company.id=foreignCompanyId;foreign.users.forEach(user=>{user.companyId=foreignCompanyId;});
const foreignBefore=canonicalHash(foreign);
deny(()=>m.invalidated(foreign,foreign.rolesProviderAttempts[0],key),409);
assert.equal(canonicalHash(foreign),foreignBefore,'Denied foreign receipt validation is read-only');checks++;
const foreignAttempt={...record,companyId:foreignCompanyId};
deny(()=>m.invalidated(saved.snapshot,foreignAttempt,key),409);
const missingAccount=structuredClone(saved.snapshot);missingAccount.users=missingAccount.users.filter(user=>user.id!==2);
deny(()=>m.invalidated(missingAccount,record,key),409);
const foreignAccount=structuredClone(saved.snapshot);foreignAccount.users.find(user=>user.id===2).companyId=foreignCompanyId;
deny(()=>m.invalidated(foreignAccount,record,key),409);
const duplicateReceipt=structuredClone(saved.snapshot);duplicateReceipt[m.collection].push(structuredClone(duplicateReceipt[m.collection][0]));
deny(()=>m.invalidated(duplicateReceipt,record,key),409);
deny(()=>m.confirm(saved.snapshot,{...identity,sessionBinding:'different-valid-session',revision:8},key,input),403);
deny(()=>m.confirm(foreign,{...identity,companyId:foreignCompanyId,revision:8},key,input),403);

// Original-result replay must never revoke a subsequently issued generation.
const newerGeneration=structuredClone(saved.snapshot);
newerGeneration.users[1].resetTokenHash='f'.repeat(64);newerGeneration.users[1].resetExpiresAt='2099-02-01T00:00:00.000Z';
const newerBefore=canonicalHash(newerGeneration),oldResult=m.confirm(newerGeneration,{...identity,revision:9},key,input);
assert.equal(oldResult.result.replayed,true);assert.equal(canonicalHash(oldResult.snapshot),newerBefore);
assert.equal(oldResult.snapshot.users[1].resetTokenHash,'f'.repeat(64));checks+=3;
for(const value of [null,false,0,'']){
  const malformed=structuredClone(saved.snapshot);malformed[m.collection]=value;
  const before=canonicalHash(malformed);
  deny(()=>m.invalidated(malformed,record,key),409);
  assert.equal(canonicalHash(malformed),before,'Malformed receipt ledger cannot be silently emptied');checks++;
}
console.log(JSON.stringify({passed:true,checks,syntheticOnly:true,credentialsCreated:0,providerCalls:0}));
