'use strict';
// The actual normal server and managed snapshot transport, with a closed
// synthetic Resend response. No network provider, credentials or test installer.
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const nativeFetch=globalThis.fetch;let outcome='accepted',deliveries=0,origin;
globalThis.fetch=(input,options)=>{
 const target=String(input);
 if(target==='https://api.resend.com/emails'){
   deliveries++;const payload=JSON.parse(options.body);
   assert.ok(payload.to.every(value=>value.endsWith('@example.invalid')));
   if(outcome==='unknown')throw Error('Synthetic delivery acknowledgement lost');
   return Promise.resolve(new Response(JSON.stringify({id:'synthetic-message'}),{status:200}));
 }
 assert.ok(origin&&target.startsWith(origin+'/'),'Only the owned loopback HTTP transport is permitted');
 return nativeFetch(input,options);
};
const fixture=require('./roles-production-http.test');
async function main(){
 await new Promise(resolve=>fixture.server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+fixture.server.address().port;
 const field=fixture.read().users.find(user=>user.role==='field');
 fixture.alter(db=>{db.changes=[{id:77,projectId:101,number:'PC-077',title:'Synthetic extra',status:'Potential',fieldFlag:true,createdBy:field.name,createdAt:new Date().toISOString(),history:[]}];});
 process.env.RESEND_API_KEY='synthetic-memory-provider-only';
 async function patch(status){const operationId=crypto.randomUUID();const response=await fetch(origin+'/api/changes/77',{method:'PATCH',signal:AbortSignal.timeout(10000),headers:{'X-PDL-Company':fixture.A,Authorization:'Bearer '+fixture.tokens.get(1),'X-PDL-Operation':operationId,'Content-Type':'application/json'},body:JSON.stringify({status})});return {status:response.status,data:await response.json(),operationId};}
 const accepted=await patch('Approved');assert.equal(accepted.status,200,JSON.stringify(accepted.data));assert.equal(deliveries,1);
 assert.equal(fixture.read().rolesProviderAttempts.length,1);assert.equal(fixture.read().rolesProviderAttempts[0].status,'accepted');
 outcome='unknown';const unknown=await patch('Rejected');assert.equal(unknown.status,503,JSON.stringify(unknown.data));assert.equal(deliveries,2);
 assert.equal(unknown.data.operationId,unknown.operationId);assert.equal(unknown.data.code,'PDL_PROVIDER_OUTCOME_UNKNOWN');
 const db=fixture.read();assert.equal(db.changes[0].status,'Rejected','Business state was admitted before the attempted delivery');assert.equal(db.rolesProviderAttempts.length,2);assert.equal(db.rolesProviderAttempts[1].status,'unknown','Original attempt is retained rather than resent');
 console.log(JSON.stringify({passed:true,checks:10,syntheticProviderDispatches:deliveries,externalProviderCalls:0,testInstallerUsed:false}));
}
main().then(()=>fixture.server.close()).catch(error=>{console.error(error);fixture.server.close();process.exitCode=1;});
