'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const nativeFetch=globalThis.fetch;let origin,dispatches=0,unknown=true;
globalThis.fetch=(input,options)=>{const target=String(input);if(target==='https://api.resend.com/emails'){const payload=JSON.parse(options.body);assert.ok(payload.to.every(email=>email.endsWith('@example.invalid')));dispatches++;if(unknown)throw Error('Generated lost acknowledgement');return Promise.resolve(new Response(JSON.stringify({id:'generated-accepted-email'}),{status:200}));}assert.ok(origin&&target.startsWith(origin+'/'));return nativeFetch(input,options);};
const fixture=require('./roles-production-http.test');
async function main(){
 await new Promise(resolve=>fixture.server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+fixture.server.address().port;process.env.RESEND_API_KEY='synthetic-memory-only';process.env.PDL_PUBLIC_URL=origin;process.env.PDL_EMAIL_DEV_MODE='0';
 const field=fixture.read().users.find(user=>user.role==='field');let requests=0;
 async function call(path,{method='GET',body,user=1,operationId=crypto.randomUUID()}={}){requests++;const response=await fetch(origin+path,{method,headers:{'X-PDL-Company':fixture.A,...user?{Authorization:'Bearer '+fixture.tokens.get(user)}:{},'X-PDL-Operation':operationId,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,data:await response.json(),operationId};}
 const first=await call('/api/auth/forgot',{method:'POST',body:{email:field.email},user:null});assert.equal(first.status,503,JSON.stringify(first.data));assert.equal(first.data.operationId,first.operationId,JSON.stringify(first.data));assert.equal(dispatches,1);
 const original=fixture.read().rolesProviderAttempts[0];assert.deepEqual(original.credential,{purpose:'password-reset',userId:field.id,tokenHash:fixture.read().users.find(user=>user.id===field.id).resetTokenHash});
 const path='/api/company/provider-operations/'+original.id+'/invalidation';
 assert.equal((await call(path+'/preview',{method:'POST',body:{reason:'Generated invalidation'},user:3})).status,403);
 const preview=await call(path+'/preview',{method:'POST',body:{reason:'Generated original link revocation'}});assert.equal(preview.status,200,JSON.stringify(preview.data));
 const confirmation={proof:preview.data.proof,requestId:crypto.randomUUID(),confirmed:true};
 assert.equal((await call(path+'/confirm',{method:'POST',body:{...confirmation,confirmed:false}})).status,400);
 const saved=await call(path+'/confirm',{method:'POST',body:confirmation});assert.equal(saved.status,200,JSON.stringify(saved.data));assert.equal(saved.data.committed,true);
 const snapshot=fixture.read();assert.equal(snapshot.users.find(user=>user.id===field.id).resetTokenHash,undefined);assert.equal(snapshot.rolesProviderAttempts[0].status,'unknown');assert.equal(dispatches,1);
 const replay=await call(path+'/confirm',{method:'POST',body:confirmation});assert.equal(replay.status,200,JSON.stringify(replay.data));assert.equal(replay.data.replayed,true);assert.equal(fixture.read().rolesCredentialInvalidations.length,1);
 assert.equal((await call(path)).data.found,true);
 unknown=false;const next=await call('/api/auth/forgot',{method:'POST',body:{email:field.email},user:null});assert.equal(next.status,200,JSON.stringify(next.data));assert.equal(dispatches,2);assert.equal(fixture.read().rolesProviderAttempts[1].status,'accepted');assert.notEqual(fixture.read().rolesProviderAttempts[1].credential.tokenHash,original.credential.tokenHash);
 console.log(JSON.stringify({passed:true,requests,syntheticDispatches:dispatches,externalCalls:0,testInstallerUsed:false}));
}
main().then(()=>fixture.server.close()).catch(error=>{console.error(error);fixture.server.close();process.exitCode=1;});
