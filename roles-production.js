'use strict';
const crypto=require('node:crypto');
const {Writable}=require('node:stream');
const registry=require('./capability-registry');
const profiles=require('./role-profiles');
const policy=require('./role-policy-api');
const {canonicalHash}=require('./database/transactional-repository');
const {stripPrivate}=require('./account-credential-delivery');
const {createRepository,uuid}=require('./database/roles-snapshot-repository');
const fail=(statusCode,message,code='PDL_ROLES_AUTHORITY')=>{throw Object.assign(Error(message),{statusCode,code});};
const publicPaths=new Set(['/api/config','/api/auth/login','/api/auth/forgot','/api/auth/reset','/api/auth/claim','/api/auth/logout','/api/auth/email-verification/confirm','/api/health','/api/help','/api/blog','/api/founder-offer']);
function configured(env=process.env){return Boolean(env.PDL_ROLES_COMPANIES);}
function createService(h,env=process.env){
  const companies=String(env.PDL_ROLES_COMPANIES||'').split(',');
  if(!companies.length||companies.some(id=>!uuid(id))||new Set(companies).size!==companies.length||env.PDL_REQUIRE_AUTH!=='1'||!h.transport.configured()||h.transactionalMode()!=='off'||!/^[a-f0-9]{64}$/.test(env.PDL_ROLE_POLICY_KEY||''))fail(503,'Permission editor configuration needs review.');
  const key=Buffer.from(env.PDL_ROLE_POLICY_KEY,'hex'),transportRepository=createRepository(h.transport);
  const repository={...transportRepository,async load(id){const row=await transportRepository.load(id);require('./roles-production-evidence').validate(row.snapshot);return row;},async commit(db,revision,guard){require('./roles-production-evidence').validate(db);return transportRepository.commit(db,revision,guard);}};
  const has=id=>companies.includes(String(id));
  function guest(db,url){
    const match=/^\/api\/guest\/([a-f0-9]{48})(?:\/ticket-scan)?$/.exec(url.pathname);if(!match)return null;
    const digest=crypto.createHash('sha256').update(match[1]).digest('hex');
    const links=(db.subcontractorLinks||[]).filter(row=>row.tokenHash===digest&&row.status==='Active'&&Date.parse(row.expiresAt)>Date.now());
    const link=links.length===1?links[0]:null;
    if(!link||!(db.projects||[]).some(row=>row.id===link.projectId)||!(db.subcontractors||[]).some(row=>row.id===link.subcontractorId))fail(404,'This guest link is invalid or expired');
    return link;
  }
  function deadline(context){if(!Number.isFinite(context.rolesDeadline)||Date.now()>=context.rolesDeadline)fail(409,'Current authorization expired. Refresh before continuing.','PDL_ROLES_DEADLINE');}
  function authority(context,db){
    deadline(context);
    if(context.rolesSystem){context.rolesSystemAuthority?.();return;}
    if(context.rolesGuest){const current=guest(db,context.url);if(canonicalHash(current)!==context.rolesGuest)fail(404,'This guest link is invalid or expired');return;}
    if(publicPaths.has(context.url.pathname))return;
    const {auth}=h.authenticate(context.req,db);if(!auth)fail(401,'Authentication required');
    if(h.accountAccess(db.company).locked&&!context.rolesBilling)fail(402,'Account access requires owner billing review');
    if(context.rolesAuthority!==identity(db,auth,context.rolesRevision).authority)fail(409,'Your current access changed. Refresh before continuing.');
  }
  async function assertContext(context){
    const row=await repository.load(context.companyId);
    if(row.revision!==context.rolesRevision||row.contentHash!==context.rolesOpeningHash)fail(409,'Company changed. Refresh current records.','PDL_REVISION_CONFLICT');
    authority(context,row.snapshot);return row;
  }
  async function commitContext(context){
    if(!context.rolesCandidate)return;
    await assertContext(context);
    if(!context.rolesSystem&&!context.rolesGuest)require('./roles-production-guards').validateDelta(context.rolesOpeningSnapshot,context.rolesCandidate,context.req,context.url,h);
    const result=await repository.commit(context.rolesCandidate,context.rolesRevision,{deadline:new Date(context.rolesDeadline).toISOString()});
    context.rolesRevision=result.revision;context.rolesOpeningHash=result.contentHash;context.rolesOpeningSnapshot=structuredClone(context.rolesCandidate);context.rolesCandidate=null;
    // An action can deliberately renew a session or change its own immutable
    // account preferences. The original deadline is never extended.
    if(!context.rolesSystem&&!context.rolesGuest&&!publicPaths.has(context.url.pathname)){
      const {auth}=h.authenticate(context.req,context.db);if(!auth)fail(401,'Authentication required');
      context.rolesAuthority=identity(context.db,auth,context.rolesRevision).authority;
    }
  }
  const effectKinds=new Set(['email','stripe-write','storage-upload','storage-delete','local-upload','local-delete','ai','founder-alert','platform-onboarding','billing-analytics','public-count']);
  function effect(kind,facts,dispatch){
    const context=h.context();if(!context?.rolesProduction||context.rolesEffectActive)return dispatch();
    const run=(context.rolesEffectQueue||Promise.resolve()).then(()=>performEffect(context,kind,facts,dispatch));
    context.rolesEffectQueue=run.catch(()=>{});return run;
  }
  async function performEffect(context,kind,facts,dispatch){
    if(context.rolesClosed||!effectKinds.has(kind)||typeof dispatch!=='function')fail(503,'Unsupported company effect.');
    await assertContext(context);
    const scope=kind==='email'&&facts.credentialScope?{credentialScope:facts.credentialScope}:['storage-upload','local-upload'].includes(kind)?{route:context.url?.pathname,bucket:facts.bucket||'local',contentHash:facts.hash,type:facts.type}:facts;
    const digest=crypto.createHmac('sha256',key).update(canonicalHash({kind,scope})).digest('hex');
    const operationId=context.rolesOperationId||=crypto.randomUUID(),ordinal=(context.rolesEffectOrdinal||0)+1;context.rolesEffectOrdinal=ordinal;
    const rows=context.db.rolesProviderAttempts||[];
    if(!Array.isArray(rows)||rows.some(row=>row?.kind===kind&&(row.operationId===operationId&&row.ordinal===ordinal||row.status==='unknown'&&row.digest===digest)))fail(409,'Review the original provider operation before retrying.','PDL_PROVIDER_RECONCILIATION');
    if(!context.rolesSystem&&!context.rolesGuest)require('./roles-production-guards').validateDelta(context.rolesOpeningSnapshot,context.db,context.req,context.url,h);
    const record={id:crypto.randomUUID(),companyId:context.companyId,actorId:context.req?.auth?.user?.id??null,operationId,ordinal,kind,digest,status:'unknown',at:new Date().toISOString()};
    context.db.rolesProviderAttempts=[...rows,record];stage(context,context.db);await commitContext(context);
    await assertContext(context); // Immediate admission check before dispatch; no lease takeover.
    let result,outcome='accepted';
    try{result=await h.run({...context,rolesEffectActive:true},dispatch);if(result&&typeof result.ok==='boolean'&&!result.ok)outcome='rejected';if(kind==='founder-alert'&&result?.sent===false)outcome='suppressed';}
    catch(error){context.rolesProviderUnknown=true;error.code ||= 'PDL_PROVIDER_OUTCOME_UNKNOWN';throw error;}
    const latest=await repository.load(context.companyId),same=latest.revision===context.rolesRevision&&latest.contentHash===context.rolesOpeningHash;
    const target=latest.snapshot.rolesProviderAttempts?.find(row=>row.id===record.id&&row.digest===digest&&row.status==='unknown');
    if(!target)fail(503,'Provider outcome needs reconciliation.','PDL_PROVIDER_OUTCOME_UNKNOWN');
    target.status=outcome;target.finishedAt=new Date().toISOString();
    // Outcome evidence may be recorded after a revocation. It confers no
    // authority and changes only this admitted attempt; business data is not rebased.
    const saved=await repository.commit(latest.snapshot,latest.revision,{deadline:new Date(Date.now()+5000).toISOString()});
    if(!same)fail(409,'Company access changed during the provider operation. Review the original result.');
    Object.assign(record,target);context.db.rolesProviderAttempts=latest.snapshot.rolesProviderAttempts;
    context.rolesRevision=saved.revision;context.rolesOpeningHash=saved.contentHash;context.rolesOpeningSnapshot=structuredClone(latest.snapshot);context.rolesCandidate=null;
    authority(context,latest.snapshot);return result;
  }
  function actor(db,user){
    let result=user;
    // Existing flags retain their exact no-policy behavior. Controllers attach
    // only their typed restrictions; none supplies a new stored grant.
    for(const [,,, ,controller]of registry.families)if(controller.required(db)||profiles.required(db))result=controller.actor(db,result,true);
    return result;
  }
  function identity(db,auth,revision){
    const user=actor(db,auth.user),gates=registry.effective(db,user);
    const sessionBinding=crypto.createHmac('sha256',key).update('production-role-session-v1:'+canonicalHash({companyId:db.company.id,actorId:user.id,sessionHash:auth.session.tokenHash})).digest('hex');
    const value={companyId:db.company.id,actorId:user.id,role:user.role,sessionBinding,revision,expiresAt:auth.session.expiresAt,locked:Boolean(h.accountAccess(db.company).locked),policyActive:require('./roles-production-guards').anyPolicy(db),effectiveCapabilities:gates,scheduleWorkflows:require('./schedule-workflow-access').eligible(db,user)};
    value.authority=canonicalHash({companyId:value.companyId,actorId:value.actorId,role:value.role,sessionBinding,permissions:user.permissions||{},memberId:user.memberId??null,projectIds:user.projectIds||[],assignedCrews:user.assignedCrews||[],gates,scheduleWorkflows:value.scheduleWorkflows,features:db.company.features||{},pricingAccess:db.company.pricingAccess||null,policyRevision:db.company.rolePolicyRevision||0,policyState:registry.policyState(db),profiles:db.company.roleProfiles||null});
    return value;
  }
  async function assertCurrent(req){
    const context=h.context(),current=await repository.load(context.db.company.id);
    if(current.revision!==context.rolesRevision||current.contentHash!==context.rolesOpeningHash)fail(409,'Company changed. Refresh current records.','PDL_REVISION_CONFLICT');
    const {auth}=h.authenticate(req,current.snapshot);
    if(!auth)fail(401,'Authentication required');
    if(h.accountAccess(current.snapshot.company).locked&&!context.rolesBilling)fail(402,'Account access requires owner billing review');
    return auth;
  }
  const handler=policy.createHandler({readDb:h.readDb,writeDb:h.writeDb,body:h.body,json:h.json,revision:()=>h.context().rolesRevision,assertCurrent,
    baselineProjectAllowed:h.canAccessProject,accountAccess:h.accountAccess,key,queuedEligible:()=>false,
    workspaceAuthority:(db,req)=>identity(db,req.auth,h.context().rolesRevision).authority,policyTransition:(db,proof)=>{h.context().rolesPolicyFrom=proof.workspaceAuthorityBefore;},
    guardCommit:guard=>{const context=h.context();context.rolesDeadline=Math.min(context.rolesDeadline,Date.parse(guard.authorizedUntil));}});
  async function preHandle(req,res,url){
    const context=h.context();if(!context?.rolesProduction)return false;
    const db=context.db;
    const link=guest(db,url);if(link){context.rolesGuest=canonicalHash(link);context.rolesDeadline=Math.min(context.rolesDeadline,Date.parse(link.expiresAt));return false;}
    if(context.rolesSystem)return false;
    if(publicPaths.has(url.pathname))return false;
    const {auth,status}=h.authenticate(req,db);if(!auth){h.json(res,status,{error:'Authentication required'});return true;}
    context.rolesDeadline=Math.min(context.rolesDeadline,Date.parse(auth.session.expiresAt));
    context.rolesBilling=url.pathname.startsWith('/api/billing')||url.pathname==='/api/account-access'||url.pathname==='/api/auth/me'||url.pathname==='/api/workspace-identity';
    const access=h.accountAccess(db.company);
    if(access.locked&&!context.rolesBilling){h.json(res,402,{error:access.reason});return true;}
    if(access.status==='Trial'&&!context.rolesBilling)context.rolesDeadline=Math.min(context.rolesDeadline,Date.parse(db.company.trialEndsAt));
    context.rolesAuthority=identity(db,auth,context.rolesRevision).authority;
    if(url.pathname==='/api/workspace-identity'&&req.method==='GET'){
      await assertCurrent(req);h.json(res,200,identity(db,req.auth,context.rolesRevision));return true;
    }
    if(url.pathname==='/api/company/role-capabilities'&&req.method==='GET'){
      if(auth.user.role!=='owner')fail(403,'Account owner permission required');
      await assertCurrent(req);h.json(res,200,{...registry.describe(db),unavailable:[]});return true;
    }
    if(url.pathname==='/api/company/provider-operations'&&req.method==='GET'){
      if(auth.user.role!=='owner')fail(403,'Account owner permission required');
      await assertCurrent(req);h.json(res,200,(db.rolesProviderAttempts||[]).map(({id,operationId,ordinal,kind,status,at,finishedAt})=>({id,operationId,ordinal,kind,status,at,...finishedAt?{finishedAt}:{}})));return true;
    }
    if(await handler(req,res,url))return true;
    await require('./roles-production-guards').guard(req,url,db,h);
    return false;
  }
  function stage(context,db){
    if(!context.rolesProduction||context.rolesClosed||db.company?.id!==context.companyId)fail(503,'Company snapshot authority is unavailable.');
    context.db=db;context.rolesCandidate=structuredClone(db);
  }
  function rejectedCredentialCleanup(context){
    // Only this closed cleanup may commit on an error response. Arbitrary
    // mutations produced by a failed route are discarded.
    const fields=context.url.pathname==='/api/auth/forgot'?['resetTokenHash','resetExpiresAt']:context.url.pathname==='/api/auth/email-verification/resend'?['emailVerificationTokenHash','emailVerificationExpiresAt']:null;
    if(!fields||!context.rolesCandidate||context.response.status!==502)return false;
    const opening=context.rolesOpeningSnapshot,expected=structuredClone(opening),candidate=context.rolesCandidate;
    const attempt=opening.rolesProviderAttempts?.at(-1);
    if(attempt?.kind!=='email'||attempt.status!=='rejected'||attempt.operationId!==context.rolesOperationId)return false;
    const changed=expected.users.filter(user=>canonicalHash(user)!==canonicalHash(candidate.users?.find(row=>row.id===user.id)));
    if(changed.length!==1||fields.some(key=>!changed[0][key]))return false;
    for(const key of fields)delete changed[0][key];
    return canonicalHash(expected)===canonicalHash(candidate);
  }
  async function handle(req,res,url,database){
    let loaded=await repository.load(database.db.company.id);
    const operation=req.headers['x-pdl-operation'];if(operation!==undefined&&!uuid(operation))fail(400,'Use a valid operation identity.');
    const context={...database,req,url,db:structuredClone(loaded.snapshot),companyId:loaded.snapshot.company.id,pending:[],effects:[],deferResponse:true,rolesProduction:true,rolesOperationId:operation||crypto.randomUUID(),rolesRevision:loaded.revision,rolesOpeningHash:loaded.contentHash,rolesOpeningSnapshot:structuredClone(loaded.snapshot),rolesDeadline:Date.now()+120000,rolesClosed:false};
    if(['/api/auth/reset','/api/auth/claim','/api/auth/email-verification/confirm'].includes(url.pathname)){
      const input=await h.body(req),hash=crypto.createHash('sha256').update(String(input.token||'')).digest('hex');
      const user=url.pathname.endsWith('/confirm')?context.db.users?.find(row=>row.emailVerificationTokenHash===hash):context.db.users?.find(row=>String(row.email).toLowerCase()===String(input.email||'').trim().toLowerCase());
      const expiry=user?.[url.pathname.endsWith('/confirm')?'emailVerificationExpiresAt':url.pathname.endsWith('/claim')?'setupExpiresAt':'resetExpiresAt'];
      if(expiry)context.rolesDeadline=Math.min(context.rolesDeadline,Date.parse(expiry));
    }
    const headers={},chunks=[];let bytes=0,status=200,rawStarted=false,rawFailed=false;
    const capture=new Writable({write(chunk,encoding,done){bytes+=chunk.length;if(bytes>22_000_000)return done(Object.assign(Error('Response too large'),{statusCode:503}));chunks.push(Buffer.from(chunk));done();}});
    capture.statusCode=200;capture.headersSent=false;
    capture.setHeader=(name,value)=>{headers[name]=value;};capture.getHeader=name=>headers[name];
    capture.writeHead=(code,extra={})=>{status=code;capture.statusCode=code;Object.assign(headers,extra);capture.headersSent=true;rawStarted=true;return capture;};
    const finished=new Promise((resolve,reject)=>{capture.once('finish',resolve);capture.once('error',reject);});
    await h.run(context,async()=>{try{if(!await preHandle(req,capture,url)){context.rolesPreHandled=true;await h.api(req,capture,url);}if(rawStarted)await finished;}catch(error){if(context.rolesProviderUnknown){context.response={status:503,data:{error:'The original provider operation needs reconciliation before retrying.',code:'PDL_PROVIDER_OUTCOME_UNKNOWN',operationId:context.rolesOperationId}};if(rawStarted){rawFailed=true;chunks.length=0;}return;}if(rawStarted){rawFailed=true;chunks.length=0;context.response={status:503,data:{error:'The complete file could not be delivered. Refresh current records before retrying.'}};return;}if(![400,401,402,403,404,409,503].includes(error.statusCode))throw error;h.json(capture,error.statusCode,{error:error.message,...error.code?{code:error.code}:{}});}});
    if(rawStarted&&!rawFailed)context.response={status,headers,raw:Buffer.concat(chunks)};
    if(!context.response)fail(503,'Company response is unavailable.');
    if(context.rolesProviderUnknown&&context.response.status>=400)context.response={status:503,data:{error:'The original provider operation needs reconciliation before retrying.',code:'PDL_PROVIDER_OUTCOME_UNKNOWN',operationId:context.rolesOperationId}};
    if(context.response.status>=400&&!rejectedCredentialCleanup(context))context.rolesCandidate=null;
    await h.run(context,()=>commitContext(context));
    const revision=context.rolesRevision,hash=context.rolesOpeningHash;
    const current=await repository.load(context.companyId);
    if(current.revision!==revision||current.contentHash!==hash)fail(409,'Company changed before delivery. Refresh current records.','PDL_REVISION_CONFLICT');
    if(context.response.status<400)authority(context,current.snapshot);
    if(!context.rolesGuest&&!publicPaths.has(url.pathname)&&context.response.status<400){
      const {auth}=h.authenticate(req,current.snapshot);if(!auth)fail(401,'Authentication required');
      if(h.accountAccess(current.snapshot.company).locked&&!context.rolesBilling)fail(402,'Account access requires owner billing review');
      context.response.data=require('./roles-production-guards').projectResponse(req,url,current.snapshot,context.response.data,h);
      const currentIdentity=identity(current.snapshot,auth,revision);
      res.setHeader('X-PDL-Tenant-Revision',String(revision));
      res.setHeader('X-PDL-Workspace-Revision',String(revision));
      if(['/api/auth/me','/api/workspace-identity'].includes(url.pathname)&&context.response.data){
        context.response.data={...context.response.data,...url.pathname==='/api/auth/me'?{rolesEditor:true,effectiveCapabilities:currentIdentity.effectiveCapabilities,scheduleWorkflows:currentIdentity.scheduleWorkflows,accountSessionBinding:currentIdentity.sessionBinding}:currentIdentity};
      }
    }
    if(!Object.hasOwn(context.response,'raw'))context.response.data=stripPrivate(context.response.data);
    if(context.response.status>=400&&context.response.data)context.response.data={error:String(context.response.data.error||'This operation is unavailable.'),...(typeof context.response.data.code==='string'?{code:context.response.data.code}:{}),...(uuid(context.response.data.operationId)?{operationId:context.response.data.operationId}:{})};
    for(const task of context.effects)await h.run(context,task);
    const delivered=await assertContext(context);context.rolesClosed=true;
    res.setHeader('X-PDL-Tenant-Revision',String(context.rolesRevision));res.setHeader('X-PDL-Workspace-Revision',String(context.rolesRevision));
    if(req.auth&&!context.rolesGuest){res.setHeader('X-PDL-Workspace-Authority',identity(delivered.snapshot,req.auth,context.rolesRevision).authority);if(context.rolesPolicyFrom)res.setHeader('X-PDL-Workspace-Policy-From',context.rolesPolicyFrom);}
    if(Object.hasOwn(context.response,'raw')){res.writeHead(context.response.status,{...headers,...context.response.headers,'Cache-Control':'private, no-store'});res.end(context.response.raw);}else h.flush(res,context);
    return true;
  }
  async function system(companyId,kind,task,guard={}){
    if(!has(companyId)||!['stripe-webhook','platform-features','platform-owner-reset','platform-commercial','platform-demo-reset'].includes(kind))fail(503,'Unsupported company system writer');
    const loaded=await repository.load(companyId);
    if(kind!=='stripe-webhook'&&(!Number.isSafeInteger(guard.expectedRevision)||guard.expectedRevision!==loaded.revision||typeof guard.authority!=='function'||!Number.isFinite(Date.parse(guard.authorizedUntil))))fail(409,'Refresh current platform authority and company revision');
    const context={companyId,db:structuredClone(loaded.snapshot),rolesProduction:true,rolesSystem:kind,rolesSystemAuthority:guard.authority,pending:[],effects:[],rolesRevision:loaded.revision,rolesOpeningHash:loaded.contentHash,rolesOpeningSnapshot:structuredClone(loaded.snapshot),rolesDeadline:Math.min(Date.now()+120000,guard.authorizedUntil?Date.parse(guard.authorizedUntil):Infinity),rolesClosed:false};
    authority(context,loaded.snapshot);
    const result=await h.run(context,()=>task(context.db));await h.run(context,()=>commitContext(context));
    for(const task of context.effects)await h.run(context,task);await assertContext(context);context.rolesClosed=true;return result;
  }
  return {has,actor,identity,assertCurrent,preHandle,stage,handle,repository,effect,system};
}
module.exports={configured,createService,publicPaths};
