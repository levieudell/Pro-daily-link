'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),{Writable}=require('node:stream');
const {canonicalHash}=require('./database/transactional-repository');
const {createService}=require('./roles-platform-authority');
const id='11111111-1111-4111-8111-111111111111',token='synthetic-platform-token';
let checks=0;
function fixture(){
 let snapshot={company:{id,name:'Generated platform'},platform:{users:[{id:1,name:'Synthetic Owner',email:'owner@example.invalid',role:'platform_owner',status:'Active'}],notes:[],sessions:[{id:crypto.randomUUID(),userId:1,tokenHash:crypto.createHash('sha256').update(token).digest('hex'),expiresAt:'2099-01-01T00:00:00.000Z'}]}},revision=0,beforeLoad=null,commits=0;
 const repository={async load(){if(beforeLoad)await beforeLoad();return {snapshot:structuredClone(snapshot),revision,contentHash:canonicalHash(snapshot)};},async commit(next,expected,guard){if(expected!==revision||Date.parse(guard.deadline)<=Date.now())throw Object.assign(Error('Conflict'),{statusCode:409,code:'PDL_REVISION_CONFLICT'});snapshot=structuredClone(next);revision++;commits++;return {revision,contentHash:canonicalHash(snapshot)};}};
 return {service:createService({repository}),another:()=>createService({repository}),read:()=>structuredClone(snapshot),commits:()=>commits,alter:task=>{task(snapshot);revision++;},hook:task=>{beforeLoad=task;},req:{url:'/api/platform/help',headers:{authorization:'Bearer '+token},platformAuth:{user:{id:1}}}};
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
async function malformedProviderLedgerRegressions(){
 const attempt=()=>({id:crypto.randomUUID(),operationId:crypto.randomUUID(),ordinal:1,kind:'email',digest:'d'.repeat(64),status:'unknown',at:'2026-10-12T12:00:00.000Z',credential:{purpose:'password-reset',userId:1,tokenHash:credentialHash}});
 const changes=[
  row=>{row.id={private:'MALFORMED_PRIVATE_ID'};},row=>{row.id='not-a-uuid';},
  row=>{row.operationId={private:'MALFORMED_PRIVATE_OPERATION'};},row=>{row.operationId='not-an-operation';},
  row=>{row.ordinal={private:'MALFORMED_PRIVATE_ORDINAL'};},row=>{row.ordinal='1';},row=>{row.ordinal=0;},row=>{row.ordinal=Number.MAX_SAFE_INTEGER+1;},
  row=>{row.kind={private:'MALFORMED_PRIVATE_KIND'};},row=>{row.kind='upload';},
  row=>{row.status={private:'MALFORMED_PRIVATE_STATUS'};},row=>{row.status='sent';},
  row=>{row.digest={private:'MALFORMED_PRIVATE_DIGEST'};},row=>{row.digest='short';},
  row=>{row.at={private:'MALFORMED_PRIVATE_TIME'};},row=>{row.at='not-a-time';},
  row=>{row.finishedAt='2026-10-12T12:00:01.000Z';},
  row=>{row.status='accepted';},row=>{row.status='rejected';row.finishedAt={private:'MALFORMED_PRIVATE_FINISH'};},
  row=>{row.status='accepted';row.finishedAt='2026-10-12T11:59:59.000Z';},
  row=>{row.credential=null;},row=>{row.credential=[];},
  row=>{row.credential.userId={private:'MALFORMED_PRIVATE_ACCOUNT'};},row=>{row.credential.userId='1';},row=>{row.credential.userId=0;},
  row=>{row.credential.purpose='temporary-password';},row=>{row.credential.tokenHash={private:'MALFORMED_PRIVATE_TOKEN'};},row=>{row.credential.tokenHash='short';},
  row=>{row.credential.extra='MALFORMED_PRIVATE_CREDENTIAL_FIELD';},row=>{row.extra='MALFORMED_PRIVATE_FIELD';},
  row=>{row.kind='ai';},row=>{row.kind='stripe-write';},
  ...['id','operationId','ordinal','kind','digest','status','at'].map(key=>row=>{delete row[key];})
 ];
 for(const change of changes){
  const f=fixture(),row=attempt(),out=captureResponse();change(row);f.alter(snapshot=>{snapshot.platform.rolesProviderAttempts=[row];});f.req.url='/api/platform/provider-operations';
  const before=canonicalHash(f.read());let entered=0;
  await f.service.handle(f.req,out.res,async capture=>{entered++;f.service.read();capture.writeHead(200,{'Content-Type':'application/json'});capture.end(JSON.stringify({private:'MALFORMED_PRIVATE_ROUTE_BYTES'}));});
  assert.equal(out.status,503);assert.equal(out.data().code,'PDL_PLATFORM_EVIDENCE');assert.equal(entered,0,'Malformed stored evidence is rejected before route/projection');
  assert.equal(JSON.stringify(out.data()).includes('MALFORMED_PRIVATE'),false,'No nested private evidence or buffered route bytes leave');assert.equal(canonicalHash(f.read()),before,'A failed read never repairs or replaces the source ledger');checks+=5;
 }
 for(const duplicate of ['id','operation']){
  const f=fixture(),row=attempt(),other=attempt(),out=captureResponse();
  if(duplicate==='id')other.id=row.id;else{other.operationId=row.operationId;other.ordinal=row.ordinal;}
  f.alter(snapshot=>{snapshot.platform.rolesProviderAttempts=[row,other];});const before=canonicalHash(f.read());
  await f.service.handle(f.req,out.res,async()=>assert.fail('Duplicate provider authority cannot enter a route'));
  assert.equal(out.status,503);assert.equal(canonicalHash(f.read()),before);checks+=2;
 }
 // A current malformed row introduced after buffering must also deny delivery,
 // including its field projection, rather than only relying on initial load.
 for(const change of [row=>{row.credential.userId={private:'MALFORMED_PRIVATE_ACCOUNT'};},row=>{row.ordinal='1';}]){
  const f=fixture(),out=captureResponse();f.req.url='/api/platform/provider-operations';let poisoned;
  await f.service.handle(f.req,out.res,async capture=>{
   f.service.read();capture.writeHead(200,{'Content-Type':'application/json'});capture.end(JSON.stringify({private:'MALFORMED_PRIVATE_BUFFERED_BYTES'}));
   f.hook(()=>{f.hook(null);const row=attempt();change(row);f.alter(snapshot=>{snapshot.platform.rolesProviderAttempts=[row];});poisoned=canonicalHash(f.read());});
  });
  assert.equal(out.status,503);assert.equal(out.data().code,'PDL_PLATFORM_EVIDENCE');assert.equal(JSON.stringify(out.data()).includes('MALFORMED_PRIVATE'),false);assert.equal(canonicalHash(f.read()),poisoned);checks+=4;
 }
 // Valid accepted/rejected history stays readable; optional credentials belong
 // only to email operations and their token hashes never reach this Owner DTO.
 const f=fixture(),rows=[attempt(),attempt(),attempt()];rows[1].status='accepted';rows[1].finishedAt='2026-10-12T12:00:01.000Z';rows[2].status='rejected';rows[2].finishedAt='2026-10-12T12:00:02.000Z';
 const ai=attempt();ai.kind='ai';delete ai.credential;rows.push(ai);const stripe=attempt();stripe.kind='stripe-write';delete stripe.credential;rows.push(stripe);f.alter(snapshot=>{snapshot.platform.rolesProviderAttempts=rows;});f.req.url='/api/platform/provider-operations';
 const before=canonicalHash(f.read()),out=captureResponse();
 await f.service.handle(f.req,out.res,async capture=>{f.service.read();const data=f.service.credentialRecovery(f.req,'GET',new URL('http://example.invalid/api/platform/provider-operations'));capture.writeHead(200,{'Content-Type':'application/json'});capture.end(JSON.stringify(data));});
 assert.equal(out.status,200);assert.equal(out.data().length,5);assert.deepEqual(out.data().map(row=>row.status),['unknown','accepted','rejected','unknown','unknown']);
 assert.equal(JSON.stringify(out.data()).includes(credentialHash),false);assert.equal(canonicalHash(f.read()),before);checks+=5;
}
async function originalProviderFinalizationRegressions(){
 const changes=[
  platform=>{platform.rolesProviderAttempts[0].credential.tokenHash='b'.repeat(64);},
  platform=>{platform.rolesProviderAttempts[0].credential.purpose='email-verification';},
  platform=>{platform.users.push({id:2,name:'Different synthetic account',email:'another@example.invalid',role:'support',status:'Active'});platform.rolesProviderAttempts[0].credential.userId=2;},
  platform=>{platform.rolesProviderAttempts[0].operationId=crypto.randomUUID();},
  platform=>{platform.rolesProviderAttempts[0].ordinal=2;},
  platform=>{platform.rolesProviderAttempts[0].digest='f'.repeat(64);},
  platform=>{platform.rolesProviderAttempts[0].at=new Date(Date.parse(platform.rolesProviderAttempts[0].at)+1).toISOString();},
  platform=>{platform.rolesProviderAttempts[0].id=crypto.randomUUID();},
  platform=>{platform.rolesProviderAttempts[0].kind='ai';delete platform.rolesProviderAttempts[0].credential;},
 ];
 for(const change of changes){
  const f=fixture();let dispatches=0,poisoned;
  await assert.rejects(()=>f.service.run(async()=>{
   const source=f.service.read();Object.assign(source.users[0],{resetTokenHash:credentialHash,resetExpiresAt:'2099-01-01T00:00:00.000Z'});await f.service.stage(source);
   await f.service.effect('email',credentialFacts,async()=>{dispatches++;assert.equal(f.commits(),1,'Only original send admission precedes dispatch');f.alter(snapshot=>change(snapshot.platform));poisoned=canonicalHash(f.read());return {ok:true};});
   assert.fail('A different descriptor must not deliver the old provider result');
  },{req:f.req}),error=>error.statusCode===503&&error.code==='PDL_PROVIDER_OUTCOME_UNKNOWN');
  assert.equal(dispatches,1);assert.equal(f.commits(),1,'No outcome CAS can reattribute an original provider result');assert.equal(f.read().platform.rolesProviderAttempts[0].status,'unknown');assert.equal(canonicalHash(f.read()),poisoned,'Changed current source is never repaired or rebased');checks+=5;
 }
 for(const change of [
  platform=>{platform.users[0].name={private:'MALFORMED_PRIVATE_ACCOUNT'};},
  platform=>{platform.sessions[0].tokenHash={private:'MALFORMED_PRIVATE_SESSION'};},
  platform=>{platform.notes=false;},
  platform=>{platform.rolesProviderAttempts[0].credential.userId={private:'MALFORMED_PRIVATE_RECIPIENT'};},
  platform=>{platform.rolesManualCredentialCustody=null;}
 ]){
  const f=fixture();let dispatches=0,poisoned;
  await assert.rejects(()=>f.service.run(async()=>{
   const source=f.service.read();Object.assign(source.users[0],{resetTokenHash:credentialHash,resetExpiresAt:'2099-01-01T00:00:00.000Z'});await f.service.stage(source);
   await f.service.effect('email',credentialFacts,async()=>{dispatches++;f.alter(snapshot=>change(snapshot.platform));poisoned=canonicalHash(f.read());return {ok:false};});
   assert.fail('Malformed latest source must not return provider evidence');
  },{req:f.req}),error=>error.statusCode===503);
  assert.equal(dispatches,1);assert.equal(f.commits(),1,'Malformed authority prevents even known-rejection outcome CAS');assert.equal(f.read().platform.rolesProviderAttempts[0].status,'unknown');assert.equal(canonicalHash(f.read()),poisoned);checks+=5;
 }
 // A descriptor that remains exactly original may journal a known outcome even
 // after an independent authority revocation. It preserves the current source
 // and withholds the original request; it cannot rebase old business/rights.
 for(const change of [platform=>{platform.users[0].status='Deactivated';},platform=>{platform.sessions=[];},platform=>{platform.notes.push({id:'newer-concurrent-note',text:'Keep newer source'});}]){
  const f=fixture();let original,updated;
  await assert.rejects(()=>f.service.run(async()=>{
   const source=f.service.read();Object.assign(source.users[0],{resetTokenHash:credentialHash,resetExpiresAt:'2099-01-01T00:00:00.000Z'});await f.service.stage(source);
   await f.service.effect('email',credentialFacts,async()=>{original=structuredClone(f.read().platform.rolesProviderAttempts[0]);f.alter(snapshot=>change(snapshot.platform));updated=f.read();return {ok:true};});
   assert.fail('A revoked or superseded request cannot consume successful provider output');
  },{req:f.req}),error=>error.statusCode===409);
  const current=f.read(),outcome=current.platform.rolesProviderAttempts[0];
  assert.equal(f.commits(),2);assert.equal(outcome.status,'accepted');assert.ok(Number.isFinite(Date.parse(outcome.finishedAt)));
  const immutable=structuredClone(outcome);delete immutable.finishedAt;immutable.status='unknown';assert.deepEqual(immutable,original);
  const business=snapshot=>{const copy=structuredClone(snapshot);delete copy.platform.rolesProviderAttempts;return copy;};assert.deepEqual(business(current),business(updated),'Known original outcome never undoes concurrent revocation or business changes');checks+=6;
 }
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
 await malformedProviderLedgerRegressions();
 await originalProviderFinalizationRegressions();
 console.log(JSON.stringify({passed:true,checks,syntheticOnly:true,externalCalls:0}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
