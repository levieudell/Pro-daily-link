'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),{Writable}=require('node:stream');
const {canonicalHash}=require('./database/transactional-repository');
const {createService}=require('./roles-platform-authority');
const id='11111111-1111-4111-8111-111111111111',token='synthetic-platform-token';
let checks=0;
function fixture(){
 let snapshot={company:{id,name:'Generated platform'},platform:{users:[{id:1,name:'Synthetic Owner',email:'owner@example.invalid',role:'platform_owner',status:'Active'}],notes:[],sessions:[{id:crypto.randomUUID(),userId:1,tokenHash:crypto.createHash('sha256').update(token).digest('hex'),expiresAt:'2099-01-01T00:00:00.000Z'}]}},revision=0,beforeLoad=null;
 const repository={async load(){if(beforeLoad)await beforeLoad();return {snapshot:structuredClone(snapshot),revision,contentHash:canonicalHash(snapshot)};},async commit(next,expected,guard){if(expected!==revision||Date.parse(guard.deadline)<=Date.now())throw Object.assign(Error('Conflict'),{statusCode:409,code:'PDL_REVISION_CONFLICT'});snapshot=structuredClone(next);revision++;return {revision,contentHash:canonicalHash(snapshot)};}};
 return {service:createService({repository}),another:()=>createService({repository}),read:()=>structuredClone(snapshot),alter:task=>{task(snapshot);revision++;},hook:task=>{beforeLoad=task;},req:{url:'/api/platform/help',headers:{authorization:'Bearer '+token},platformAuth:{user:{id:1}}}};
}
async function rejects(task,status){await assert.rejects(Promise.resolve().then(task),error=>error.statusCode===status);checks++;}
function captureResponse(){
 let bytes='',status;
 const res=new Writable({write(chunk,encoding,done){bytes+=chunk.toString();done();}});
 res.headersSent=false;res.writeHead=code=>{status=code;res.headersSent=true;return res;};
 return {res,get status(){return status;},data:()=>JSON.parse(bytes)};
}
const credentialHash='a'.repeat(64);
const credentialFacts={credentialScope:'b'.repeat(64),credentialPurpose:'password-reset',credentialRecipientHash:crypto.createHash('sha256').update('owner@example.invalid').digest('hex')};
async function issueRejected(f){
 const p=f.service.read();Object.assign(p.users[0],{resetTokenHash:credentialHash,resetExpiresAt:'2099-01-01T00:00:00.000Z',resetRequestedAt:'2026-10-12T00:00:00.000Z'});
 await f.service.stage(p);
 const result=await f.service.effect('email',credentialFacts,async()=>({ok:false}));
 assert.equal(result.ok,false);
}
async function rejectedCleanupRegressions(){
 // Known rejection permits only cleanup of this request's exact admitted
 // generation. It must not become a general commit-on-error escape hatch.
 let f=fixture(),out=captureResponse();f.req.url='/api/platform/auth/forgot';
 await f.service.handle(f.req,out.res,async capture=>{
   await issueRejected(f);const p=f.service.read();for(const name of ['resetTokenHash','resetExpiresAt','resetRequestedAt'])delete p.users[0][name];
   await f.service.stage(p);capture.writeHead(502,{'Content-Type':'application/json'});capture.end(JSON.stringify({error:'Generated rejection'}));
 });
 assert.equal(out.status,502);assert.equal(f.read().platform.rolesProviderAttempts[0].status,'rejected');
 for(const name of ['resetTokenHash','resetExpiresAt','resetRequestedAt'])assert.equal(f.read().platform.users[0][name],undefined);
 assert.equal(f.read().platform.sessions.length,1);checks+=6;

 {
   const status=502;
   f=fixture();out=captureResponse();f.req.url='/api/platform/auth/forgot';
   await f.service.handle(f.req,out.res,async capture=>{
     await issueRejected(f);const p=f.service.read();for(const name of ['resetTokenHash','resetExpiresAt','resetRequestedAt'])delete p.users[0][name];
     p.notes.push({id:'unrelated-error-write'});
     await f.service.stage(p);capture.writeHead(status,{'Content-Type':'application/json'});capture.end(JSON.stringify({error:'Generated denied cleanup'}));
   });
   assert.equal(out.status,status);assert.equal(f.read().platform.users[0].resetTokenHash,credentialHash);
   assert.deepEqual(f.read().platform.notes,[]);assert.equal(f.read().platform.rolesProviderAttempts[0].status,'rejected');checks+=4;
 }

 // A rejected receipt from an earlier request cannot authorize this request's cleanup.
 f=fixture();f.req.url='/api/platform/auth/forgot';await f.service.run(()=>issueRejected(f),{req:f.req});
 const previous=canonicalHash(f.read());out=captureResponse();
 await f.service.handle(f.req,out.res,async capture=>{const p=f.service.read();for(const name of ['resetTokenHash','resetExpiresAt','resetRequestedAt'])delete p.users[0][name];await f.service.stage(p);capture.writeHead(502,{'Content-Type':'application/json'});capture.end(JSON.stringify({error:'Different request'}));});
 assert.equal(out.status,502);assert.equal(canonicalHash(f.read()),previous);checks+=2;

 // Revocation/generation rotation during cleanup rejects stale writeback rather than deleting the new link.
 f=fixture();out=captureResponse();f.req.url='/api/platform/auth/forgot';
 await f.service.handle(f.req,out.res,async capture=>{await issueRejected(f);const p=f.service.read();for(const name of ['resetTokenHash','resetExpiresAt','resetRequestedAt'])delete p.users[0][name];await f.service.stage(p);f.alter(s=>{s.platform.users[0].resetTokenHash='c'.repeat(64);});capture.writeHead(502,{'Content-Type':'application/json'});capture.end(JSON.stringify({error:'Generated rejection'}));});
 assert.equal(out.status,409);assert.equal(f.read().platform.users[0].resetTokenHash,'c'.repeat(64));checks+=2;

 // An unknown acknowledgement retains the original generation and exact operation reference.
 f=fixture();out=captureResponse();f.req.url='/api/platform/auth/forgot';f.req.headers['x-pdl-operation']=crypto.randomUUID();
 await f.service.handle(f.req,out.res,async capture=>{
   const p=f.service.read();Object.assign(p.users[0],{resetTokenHash:credentialHash,resetExpiresAt:'2099-01-01T00:00:00.000Z'});await f.service.stage(p);
   try{await f.service.effect('email',credentialFacts,async()=>{throw Error('Generated lost acknowledgement');});}
   catch{const cleanup=f.service.read();delete cleanup.users[0].resetTokenHash;delete cleanup.users[0].resetExpiresAt;await f.service.stage(cleanup);capture.writeHead(502,{'Content-Type':'application/json'});capture.end(JSON.stringify({error:'Unknown cannot clean up'}));}
 });
 assert.equal(out.status,503);assert.equal(out.data().code,'PDL_PROVIDER_OUTCOME_UNKNOWN');assert.equal(out.data().operationId,f.req.headers['x-pdl-operation']);
 assert.equal(f.read().platform.users[0].resetTokenHash,credentialHash);assert.equal(f.read().platform.rolesProviderAttempts[0].status,'unknown');checks+=5;
}
async function main(){
 let f=fixture();
 await f.service.run(async()=>{const p=f.service.read();p.notes.push({id:'generated-note',text:'Saved'});await f.service.stage(p);},{req:f.req});assert.equal(f.read().platform.notes.length,1);checks++;
 await rejects(()=>f.service.run(async()=>{const p=f.service.read();p.notes.push({id:'never-saved'});await f.service.stage(p);f.alter(s=>{s.platform.users[0].status='Deactivated';});},{req:f.req}),409);assert.equal(f.read().platform.notes.length,1);checks++;
 f=fixture();const other=f.another();let admit,release;const admitted=new Promise(r=>admit=r),blocked=new Promise(r=>release=r);
 const first=f.service.run(async()=>{const p=f.service.read();p.notes.push({id:'old-worker'});await f.service.stage(p);admit();await blocked;},{req:f.req});
 await admitted;await other.run(async()=>{const p=other.read();p.users[0].status='Deactivated';await other.stage(p);});release();await rejects(()=>first,409);assert.equal(f.read().platform.notes.length,0);checks++;
 f=fixture();await f.service.run(async()=>{const stale=f.service.read(),fresh=f.service.read();fresh.notes.push({id:'fresh'});await f.service.stage(fresh);stale.notes.push({id:'stale'});await rejects(()=>f.service.stage(stale),409);});
 await rejects(()=>Promise.resolve().then(()=>f.service.read()),503);
 f=fixture();let outside;await f.service.run(async()=>{const p=f.service.read();outside=()=>f.service.stage(p);});await rejects(outside,503);
 f=fixture();let dispatches=0;
 await assert.rejects(()=>f.service.run(async()=>{const p=f.service.read();p.notes.push({id:'admitted-before-unknown'});await f.service.stage(p);await f.service.effect('email',{credentialScope:'generated-reset-purpose'},()=>{dispatches++;throw Error('Generated lost acknowledgement');});}),/lost acknowledgement/);checks++;
 assert.equal(f.read().platform.rolesProviderAttempts[0].status,'unknown');checks++;
 await rejects(()=>f.service.run(async()=>{const p=f.service.read();p.notes.push({id:'must-not-save'});await f.service.stage(p);await f.service.effect('email',{credentialScope:'generated-reset-purpose'},()=>{dispatches++;});}),409);
 assert.equal(dispatches,1);assert.equal(f.read().platform.notes.length,1);checks+=2;
 await f.service.run(async()=>{const p=f.service.read();p.rolesProviderAttempts=[];p.notes.push({id:'cannot-erase-receipt'});await f.service.stage(p);});assert.equal(f.read().platform.rolesProviderAttempts.length,1);checks++;
 f=fixture();let bytes='',status;const res=new Writable({write(chunk,encoding,done){bytes+=chunk.toString();done();}});res.headersSent=false;res.writeHead=code=>{status=code;res.headersSent=true;return res;};
 await f.service.handle(f.req,res,async capture=>{f.service.read();capture.writeHead(200,{'Content-Type':'application/json'});capture.end('SECRET RESPONSE');f.hook(()=>{f.hook(null);f.alter(s=>{s.platform.sessions=[];});});});
 assert.equal(status,409);assert.ok(!bytes.includes('SECRET'));checks+=2;
 f=fixture();await f.service.run(async()=>{f.service.read();const g=f.service.guard();assert.equal(g.platformId,id);assert.equal(g.platformRevision,0);checks+=2;},{req:f.req});
 f=fixture();f.req.url='/api/platform/auth/logout';await f.service.run(async()=>{const p=f.service.read();p.sessions=[];await f.service.stage(p);},{req:f.req});assert.deepEqual(f.read().platform.sessions,[]);checks++;
 await rejectedCleanupRegressions();
 // Absent optional collections retain defaults. A present malformed collection
 // must not be replaced with an empty one by login, support or a later writer.
 for(const name of ['users','sessions','supportGrants','notes','rolesProviderAttempts'])for(const value of [null,false,0,'']){
   f=fixture();f.alter(snapshot=>{snapshot.platform[name]=value;});
   const before=canonicalHash(f.read());
   await rejects(()=>f.service.run(()=>f.service.read()),503);
   assert.equal(canonicalHash(f.read()),before,'Malformed source denial never repairs or erases authority');checks++;
 }
 console.log(JSON.stringify({passed:true,checks,syntheticOnly:true,externalCalls:0}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
