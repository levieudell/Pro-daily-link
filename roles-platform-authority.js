'use strict';
const crypto=require('node:crypto');
const {AsyncLocalStorage}=require('node:async_hooks');
const {Writable}=require('node:stream');
const {canonicalHash}=require('./database/transactional-repository');
const fail=(statusCode,message,code='PDL_PLATFORM_AUTHORITY')=>{throw Object.assign(Error(message),{statusCode,code});};
const internal='rolesProviderAttempts';
const business=platform=>{const copy=structuredClone(platform);delete copy[internal];return copy;};
function createService(h){
 const repository=h.repository,contexts=new AsyncLocalStorage(),bindings=new WeakMap();
 const evidence=require('./roles-platform-evidence');
 const manual=h.credentialKey?require('./roles-manual-credential-custody').createCustody({key:h.credentialKey}):null;
 function validateManual(envelope){if(Object.hasOwn(envelope.platform,'rolesManualCredentialCustody')){if(!manual)fail(503,'Original manual credential key custody required.');manual.validate({...envelope.platform,company:envelope.company});}}
 function context(){return contexts.getStore();}
 function open(){const value=context();if(!value||value.closed)fail(503,'Current platform storage is unavailable.');return value;}
 function identity(platform,req){
  const cookie=String(req?.headers?.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('pdl_platform='))?.slice(13);
  const token=/^Bearer (.+)$/.exec(String(req?.headers?.authorization||''))?.[1]||cookie;
  const hash=token&&crypto.createHash('sha256').update(token).digest('hex');
  const matches=(platform.sessions||[]).filter(row=>row.tokenHash===hash&&Date.parse(row.expiresAt)>Date.now());
  const session=matches.length===1?matches[0]:null,users=session&&(platform.users||[]).filter(row=>row.id===session.userId&&row.status==='Active');
  const user=users?.length===1&&users[0].mustSetPassword!==true?users[0]:null;
  return user?{actorId:user.id,role:user.role,name:user.name,email:user.email,sessionHash:hash,expiresAt:session.expiresAt}:null;
 }
 function bindAuthority(c){
  if(['/api/platform/auth/bootstrap','/api/platform/auth/login','/api/platform/auth/forgot','/api/platform/auth/reset','/api/platform/auth/claim'].includes(String(c.req?.url||'').split('?')[0])||c.postLogout)return;
  const value=identity(c.envelope.platform,c.req);
  if(!c.req?.platformAuth&&!c.authority&&!value)return;
  if(!value)fail(403,'Current platform session required.');
  if(!c.authority)c.authority=value;
  if(canonicalHash(c.authority)!==canonicalHash(value))fail(403,'Current platform access changed.');
  c.deadline=Math.min(c.deadline,Date.parse(value.expiresAt));
 }
 function read(){const c=open();c.used=true;const value=structuredClone(c.platform);bindings.set(value,{context:c,baseline:business(value)});return value;}
 function stage(value){
  const c=open(),bound=bindings.get(value);c.used=true;bindAuthority(c);
  if(!bound||bound.context!==c||canonicalHash(bound.baseline)!==canonicalHash(business(c.platform)))fail(409,'Refresh the current platform result before saving.','PDL_REVISION_CONFLICT');
  if(!value||!Array.isArray(value.users)||!Array.isArray(value.notes)||Buffer.byteLength(JSON.stringify(value))>22_000_000)fail(503,'Platform records need review.');
  const next=structuredClone(value);next[internal]=structuredClone(c.platform[internal]||[]);
  evidence.validate(next);
  validateManual({...c.envelope,platform:next});
  if(String(c.req?.url||'').split('?')[0]==='/api/platform/auth/logout'){
    const expected=business(c.platform),boundIdentity=identity(c.envelope.platform,c.req);
    if(boundIdentity){expected.sessions=(expected.sessions||[]).filter(row=>row.tokenHash!==boundIdentity.sessionHash);if(canonicalHash(expected)!==canonicalHash(business(next)))fail(409,'Logout may remove only its current session.');c.endsSession=true;}
  }
  c.platform=next;c.dirty=true;bound.baseline=business(next);return Promise.resolve();
 }
 async function assertCurrent(c){
  if(c.closed||Date.now()>=c.deadline)fail(409,'Original platform authorization expired.');
  const current=await repository.load();
  evidence.validate(current.snapshot.platform);
  validateManual(current.snapshot);
  if(current.revision!==c.revision||current.contentHash!==c.hash)fail(409,'Platform changed. Refresh current records.','PDL_REVISION_CONFLICT');
  bindAuthority(c);
  if(c.authority&&!c.postLogout&&canonicalHash(identity(current.snapshot.platform,c.req))!==canonicalHash(c.authority))fail(403,'Current platform access changed.');
  if(c.deliveryGuard)await c.deliveryGuard(current.snapshot.platform);
  return current;
 }
 async function flush(c){
  if(!c.dirty)return;await assertCurrent(c);
  const snapshot={...c.envelope,platform:structuredClone(c.platform)},saved=await repository.commit(snapshot,c.revision,{deadline:new Date(c.deadline).toISOString()});
  c.revision=saved.revision;c.hash=saved.contentHash;c.envelope=snapshot;c.dirty=false;
  if(c.endsSession)c.postLogout=true;
 }
 function rejectedCredentialCleanup(c){
  if(!c.dirty)return false;
  const before=c.envelope.platform,after=structuredClone(c.platform),attempts=before[internal]||[];
  const rejected=attempts.filter(row=>row.kind==='email'&&row.status==='rejected'&&row.operationId===c.operationId&&row.credential);
  if(rejected.length!==1)return false;
  const row=rejected[0],fields=require('./roles-credential-invalidation').fields[row.credential.purpose],user=before.users?.find(value=>value.id===row.credential.userId),candidate=after.users?.find(value=>value.id===row.credential.userId);
  if(!fields||!user||!candidate||user[fields[0]]!==row.credential.tokenHash||fields.some(name=>Object.hasOwn(candidate,name)))return false;
  const expected=structuredClone(before),original=expected.users.find(value=>value.id===user.id);
  for(const name of fields)delete original[name];
  return canonicalHash(expected)===canonicalHash(after);
 }
 function guard(){const c=open();c.used=true;bindAuthority(c);return {platformId:c.envelope.company.id,platformRevision:c.revision};}
 function setDeliveryGuard(task){const c=open();c.used=true;c.deliveryGuard=task;}
 function clampDeadline(value){const c=open();if(!Number.isFinite(value))fail(503,'Original authorization expiry needs review.');c.deadline=Math.min(c.deadline,value);}
 function defer(promise){const c=open();c.pending.push(Promise.resolve(promise));return promise;}
 function credentialDb(c){return {...c.platform,company:c.envelope.company};}
 function credentialIdentity(c,req){const actor=identity(c.envelope.platform,req);if(!actor||actor.role!=='platform_owner')fail(403,'Current platform Owner authority is required.');return {...actor,companyId:c.envelope.company.id,revision:c.revision,sessionBinding:actor.sessionHash,authority:canonicalHash(actor)};}
 function credentialRecovery(req,method,url,input){
  const match=/^\/api\/platform\/provider-operations(?:\/([a-f0-9-]{36})\/invalidation(?:\/(preview|confirm))?)?$/.exec(url.pathname);if(!match)return null;
  const c=open(),actor=credentialIdentity(c,req),module=require('./roles-credential-invalidation'),db=credentialDb(c),key=h.credentialKey;c.used=true;
  if(method==='GET'&&!match[1])return (c.platform[internal]||[]).map(row=>({id:row.id,operationId:row.operationId,ordinal:row.ordinal,kind:row.kind,status:row.status,at:row.at,...row.finishedAt?{finishedAt:row.finishedAt}:{},...row.credential?{purpose:row.credential.purpose,accountId:row.credential.userId,invalidated:key?module.invalidated(db,row,key):false}:{}}));
  if(method==='GET'&&!match[2]){const original=(db.rolesProviderAttempts||[]).find(row=>row.id===match[1]),receipt=(db[module.collection]||[]).find(row=>row.attemptId===match[1]);if(receipt&&(!original||!module.invalidated(db,original,key)))fail(409,'Original invalidation receipt needs review.');return {found:Boolean(receipt),...receipt?{requestId:receipt.requestId,previewId:receipt.previewId,attemptId:receipt.attemptId,purpose:receipt.credential.purpose,invalidatedAt:receipt.invalidatedAt,reason:receipt.reason,actorId:receipt.scope.actorId}:{}};}
  if(method!=='POST'||!match[1]||!match[2])fail(404,'Credential recovery route not found.');
  if(match[2]==='preview'){if(!input||Object.keys(input).some(name=>name!=='reason'))fail(400,'Provide only an invalidation reason.');return module.preview(db,actor,key,{attemptId:match[1],reason:input.reason});}
  const confirmed=module.confirm(db,actor,key,input);if(confirmed.result.attemptId!==match[1])fail(403,'Preview belongs to a different original operation.');
  if(!confirmed.result.replayed){module.validateDelta(db,confirmed.snapshot,confirmed);const next=read();for(const name of ['users',module.collection])next[name]=confirmed.snapshot[name];stage(next);}
  return confirmed.result;
 }
 const kinds=new Set(['email','ai','stripe-write']);
 function effect(kind,facts,dispatch){
  const c=context();if(!c||!c.used||c.effectActive)return dispatch();
  const work=(c.queue||Promise.resolve()).then(()=>perform(c,kind,facts,dispatch));c.queue=work.catch(()=>{});defer(work);return work;
 }
 async function perform(c,kind,facts,dispatch){
  if(!kinds.has(kind)||c.closed)fail(503,'Platform provider admission is unavailable.');
  bindAuthority(c);await assertCurrent(c);
  const scope=facts.credentialScope?{credentialScope:facts.credentialScope}:facts;
  const digest=crypto.createHash('sha256').update(canonicalHash({kind,scope})).digest('hex');
  const rows=c.platform[internal]||[],operationId=c.operationId,ordinal=(c.ordinal||0)+1;c.ordinal=ordinal;
  if(rows.some(row=>row.kind===kind&&(row.status==='unknown'&&row.digest===digest&&!(row.credential&&h.credentialKey&&require('./roles-credential-invalidation').invalidated(credentialDb(c),row,h.credentialKey))||row.operationId===operationId&&row.ordinal===ordinal)))fail(409,'Review the original provider operation before retrying.','PDL_PROVIDER_RECONCILIATION');
  const record={id:crypto.randomUUID(),operationId,ordinal,kind,digest,status:'unknown',at:new Date().toISOString()};
  if(kind==='email'&&facts.credentialPurpose){const purpose=facts.credentialPurpose,field=require('./roles-credential-invalidation').fields[purpose]?.[0],users=c.platform.users.filter(user=>user.status==='Active'&&crypto.createHash('sha256').update(user.email.trim().toLowerCase()).digest('hex')===facts.credentialRecipientHash);if(!field||users.length!==1||!/^[a-f0-9]{64}$/.test(users[0][field]||''))fail(503,'Original platform credential generation needs review.');record.credential={purpose,userId:users[0].id,tokenHash:users[0][field]};}
  c.platform[internal]=[...rows,record];c.dirty=true;await flush(c);await assertCurrent(c);
  let result;
  try{result=await contexts.run({...c,effectActive:true},dispatch);}catch(error){c.unknown=true;throw Object.assign(error,{code:'PDL_PROVIDER_OUTCOME_UNKNOWN'});}
  const latest=await repository.load();evidence.validate(latest.snapshot.platform);validateManual(latest.snapshot);
  const same=latest.revision===c.revision&&latest.contentHash===c.hash;
  const matches=(latest.snapshot.platform[internal]||[]).filter(row=>row.id===record.id);
  if(matches.length!==1||canonicalHash(matches[0])!==canonicalHash(record))fail(503,'Original provider outcome needs reconciliation.','PDL_PROVIDER_OUTCOME_UNKNOWN');
  Object.assign(matches[0],{status:result?.ok===false?'rejected':'accepted',finishedAt:new Date().toISOString()});
  const saved=await repository.commit(latest.snapshot,latest.revision,{deadline:new Date(Date.now()+5000).toISOString()});
  if(!same)fail(409,'Platform changed during provider delivery. Review the original result.');
  c.envelope=latest.snapshot;c.platform=structuredClone(latest.snapshot.platform);c.revision=saved.revision;c.hash=saved.contentHash;
  await assertCurrent(c);return result;
 }
 async function run(task,{req=null,deliveryGuard=null}={}){
  const loaded=await repository.load();evidence.validate(loaded.snapshot.platform);validateManual(loaded.snapshot);
  const operationId=req?.headers?.['x-pdl-operation']||crypto.randomUUID();if(typeof operationId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationId))fail(400,'Use a canonical original operation ID.');
  const c={req,envelope:loaded.snapshot,platform:structuredClone(loaded.snapshot.platform),revision:loaded.revision,hash:loaded.contentHash,deadline:Date.now()+120000,operationId,closed:false,dirty:false,used:false,pending:[],deliveryGuard};
  return contexts.run(c,async()=>{try{const result=await task(c);for(let count=0;c.pending.length;count++){if(count>100)fail(503,'Platform work needs review.');const pending=c.pending.splice(0);const outcomes=await Promise.allSettled(pending);const rejected=outcomes.find(row=>row.status==='rejected');if(rejected)throw rejected.reason;}if(!c.finalized){await flush(c);if(c.used)await assertCurrent(c);}return result;}catch(error){error.operationId=c.operationId;throw error;}finally{c.closed=true;}});
 }
 async function handle(req,res,task){
  if(!String(req.url).startsWith('/api/'))return task(res);
  return run(async c=>{
   const chunks=[],headers={};let length=0,status=200,failed=false;
   const capture=new Writable({write(bytes,encoding,done){length+=bytes.length;if(length>22_000_000)return done(Object.assign(Error('Complete response exceeds limit'),{statusCode:503}));chunks.push(Buffer.from(bytes));done();}});
   capture.statusCode=200;capture.headersSent=false;capture.setHeader=(name,value)=>{headers[name]=value;};capture.getHeader=name=>headers[name];
   capture.writeHead=(code,extra={})=>{status=code;capture.statusCode=code;capture.headersSent=true;Object.assign(headers,extra);return capture;};
   const finished=new Promise((resolve,reject)=>{capture.once('finish',resolve);capture.once('error',reject);});
   // A catch is attached immediately because a stream can fail before the route returns.
   finished.catch(()=>{});
   try{await task(capture);await finished;}catch(error){failed=true;throw error;}
   if(failed)return;
   for(let count=0;c.pending.length;count++){if(count>100)fail(503,'Platform work needs review.');const rows=await Promise.allSettled(c.pending.splice(0));const rejected=rows.find(row=>row.status==='rejected');if(rejected)throw rejected.reason;}
   if(status>=400&&!rejectedCredentialCleanup(c))c.dirty=false;
   await flush(c);if(c.used)await assertCurrent(c);
   let output=Buffer.concat(chunks);
   const type=Object.entries(headers).find(([name])=>name.toLowerCase()==='content-type')?.[1];
   if(String(type).includes('application/json')){let value;try{value=JSON.parse(output.toString('utf8'));}catch{fail(503,'Complete JSON response is unavailable.');}output=Buffer.from(JSON.stringify(require('./account-credential-delivery').stripPrivate(value)));for(const name of Object.keys(headers))if(name.toLowerCase()==='content-length')headers[name]=output.length;}
   c.finalized=true;res.writeHead(status,headers);res.end(output);
  },{req}).catch(error=>{if(!res.headersSent){res.writeHead(error.statusCode||(error.code==='PDL_REVISION_CONFLICT'?409:503),{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:error.code==='PDL_PROVIDER_OUTCOME_UNKNOWN'?'Review the original provider operation before retrying.':'Refresh current platform records before continuing.',code:error.code||'PDL_PLATFORM_AUTHORITY',...(error.operationId?{operationId:error.operationId}:{})}));}});
 }
 return {read,stage,run,handle,effect,defer,context,guard,setDeliveryGuard,clampDeadline,identity,credentialRecovery};
}
module.exports={createService};
