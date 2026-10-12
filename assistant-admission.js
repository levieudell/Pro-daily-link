'use strict';
// Admission only: reuse the existing fixed eligibility and action validators.
const crypto=require('node:crypto');
const {canonicalHash}=require('./database/transactional-repository');
const assistant=require('./project-assistant');
const {createAssignmentRows}=require('./assignment-records');
const {createProjectNoteRecord}=require('./project-notes');
const {createAIHandler,legacyFallback}=require('./project-assistant-ai');
const {validateWorkspace}=require('./compat-workspace-evidence');
const {validateAccounts}=require('./account-evidence');
const previews='workspaceAssistantPreviews',receipts='workspaceAssistantReceipts',purpose='workspace-assistant-admission-v1';
const equal=(a,b)=>canonicalHash(a??null)===canonicalHash(b??null);
const omit=(row,keys)=>Object.fromEntries(Object.entries(row).filter(([key])=>!keys.includes(key)));
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(statusCode,message)=>{throw Object.assign(Error(message),{statusCode});};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
function route(method,path){return method==='GET'&&(path==='/api/assistant/context'||/^\/api\/projects\/[1-9]\d*\/assistant\/context$/.test(path))||method==='POST'&&(path==='/api/assistant/interpret'||/^\/api\/projects\/[1-9]\d*\/assistant\/(?:chat|preview|confirm)$/.test(path));}
function createHandler(h){
  const key=crypto.createHmac('sha256',h.key).update(purpose).digest();
  const sign=row=>({...row,proof:crypto.createHmac('sha256',key).update(canonicalHash(omit(row,['proof']))).digest('hex')});
  function valid(db){
    for(const name of [previews,receipts]){
      const rows=db[name]===undefined?[]:db[name],ids=new Set();if(!Array.isArray(rows)||rows.length>50000||Buffer.byteLength(JSON.stringify(rows))>8000000)fail(409,'Assistant custody capacity needs review.');
      for(const row of rows){const fields=['id','purpose','companyId','actorId','role','sessionHash','authority','projectId','token','tokenHash','version','input','reviewRevision','expiresAt','proof',...(name===receipts?['previewId','committedRevision','result','resources']:[])];
        if(!row||!equal(Object.keys(row).sort(),fields.sort())||!uuid(row.id)||ids.has(row.id)||row.purpose!==purpose||row.companyId!==db.company.id||!Number.isSafeInteger(row.actorId)||row.actorId<1||!['owner','admin','project_manager'].includes(row.role)||![row.sessionHash,row.authority,row.version,row.tokenHash,row.proof].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value))||typeof row.token!=='string'||row.token.length>32768||row.tokenHash!==hash(row.token)||row.proof!==sign(row).proof||!Number.isSafeInteger(row.reviewRevision)||row.reviewRevision<1||!Number.isFinite(Date.parse(row.expiresAt)))fail(409,'Assistant custody proof needs reconciliation.');
        if(name===receipts){const preview=(db[previews]||[]).find(value=>value.id===row.previewId);if(!preview||!equal(omit(row,['id','proof','previewId','committedRevision','result','resources']),omit(preview,['id','proof']))||row.committedRevision!==row.reviewRevision+1||!row.result?.saved||!Array.isArray(row.resources))fail(409,'Original Assistant save proof needs reconciliation.');}ids.add(row.id);
      }
    }
    if(db.assistantConfirmations!==undefined&&(!Array.isArray(db.assistantConfirmations)||db.assistantConfirmations.length>50000||db.assistantConfirmations.some(row=>!row||typeof row!=='object'||Array.isArray(row)||!uuid(row.id)||row.companyId!==db.company.id||!Number.isSafeInteger(row.userId)||row.userId<1||!Number.isSafeInteger(row.projectId)||row.projectId<1||typeof row.tokenHash!=='string'||!/^[a-f0-9]{64}$/.test(row.tokenHash)||typeof row.version!=='string'||!/^[a-f0-9]{64}$/.test(row.version)||!Number.isFinite(Date.parse(row.at)))))fail(409,'Legacy Assistant receipt source needs reconciliation.');
  }
  async function fresh(req,db=h.readDb()){
    validateAccounts(db);validateWorkspace(db);valid(db);const auth=h.authenticate(req,db).auth;
    if(!auth||Date.parse(auth.session.expiresAt)<=Date.now())fail(401,'Authentication required.');
    if(auth.user.status!=='Active'||!['owner','admin','project_manager'].includes(auth.user.role)||auth.companyId!==db.company.id)fail(403,'Current Owner, Admin or Project Manager required.');
    if(h.accountAccess(db.company).locked)fail(402,'Company access is unavailable.');return auth;
  }
  async function run(req,url,db,input){
    let response=null,dirty=false;const candidate=structuredClone(db),request={method:req.method,headers:req.headers,auth:req.auth,parsedBodyPromise:Promise.resolve(input)};
    const handler=assistant.createProjectAssistantHandler({readDb:()=>candidate,writeDb:value=>{if(value!==candidate)fail(409,'Unexpected Assistant write.');dirty=true;},body:async()=>input,json:(_res,status,data)=>{response={status,data};},authenticatedUser:(request,value)=>h.authenticate(request,value).auth?.user,accountAccess:h.accountAccess,signingKey:key,propose:legacyFallback,proposeBatch:legacyFallback,aiFirst:()=>Boolean(h.ai?.enabled)});
    await handler(request,{},url);if(!response)fail(503,'Assistant response unavailable.');return {candidate,response,dirty};
  }
  function checkAccess(db,auth,row){
    const kind=row.input.action||'schedule',ids=kind==='schedule_batch'?row.input.memberIds:kind==='schedule'?[row.input.memberId]:[null];
    if(!require('./project-assistant-access').permittedCompany(db.company.id)||!assistant.activeProject(db,row.projectId)||!ids.every(id=>assistant.allowed(db,auth.user,row.projectId,id,kind))||ids[0]!=null&&ids.some(id=>!assistant.membersFor(db,auth.user,row.projectId).some(member=>Number(member.id)===id)))fail(403,'Current Assistant project, action and crew permission required.');
  }
  async function readFresh(req){const loaded=await h.repository.load(h.companyId);await h.assertCurrent(req);await fresh(req,loaded.snapshot);return loaded.snapshot;}
  const unavailableStore={load:async()=>{throw Error('Explicit synthetic usage accounting required.');},compareAndSwap:async()=>false};
  if(h.ai?.enabled&&(!h.ai.adapter||!h.ai.store))fail(503,'Explicit synthetic Assistant provider and durable usage store required.');
  const ai=createAIHandler({readDb:h.readDb,readFreshDb:readFresh,authenticatedUser:(req,db)=>h.authenticate(req,db).auth?.user,accountAccess:h.accountAccess,body:h.body,json:h.json,store:h.ai?.store||unavailableStore,adapter:h.ai?.adapter,enabled:()=>h.ai?.enabled===true,signingKey:()=>key.toString('hex'),actorBinding:(req,db)=>h.authority(db,req.auth).sessionBinding});
  async function handle(req,res,url){
    if(!route(req.method,url.pathname))return false;
    try{
      if(url.search)fail(400,'Assistant routes accept no query overrides.');const db=h.readDb(),auth=await fresh(req,db);await h.assertCurrent(req);
      if(url.pathname.startsWith('/api/assistant/'))return await ai(req,res,url);
      const action=url.pathname.split('/').at(-1),projectId=Number(url.pathname.split('/')[3]),input=req.method==='POST'?await h.body(req):{};
      if(action==='confirm'){
        if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!=='confirmed,token,version'||input.confirmed!==true||typeof input.token!=='string'||input.token.length>32768)fail(400,'Confirm the exact current preview.');
        const row=(db[previews]||[]).find(row=>row.tokenHash===hash(input.token)&&row.version===input.version);
        if(!row||row.projectId!==projectId||row.actorId!==auth.user.id||row.role!==auth.user.role||row.sessionHash!==auth.session.tokenHash||row.authority!==h.authority(db,auth).authority)fail(409,'Use the originating session and current Assistant preview.');checkAccess(db,auth,row);
        const prior=(db[receipts]||[]).find(value=>value.previewId===row.id);
        if(prior){h.context().assistantReturn=prior.id;h.json(res,200,{...prior.result,repeated:true});return true;}
        if(row.reviewRevision!==h.revision()||Date.parse(row.expiresAt)<=Date.now())fail(409,'Assistant preview changed or expired.');h.guardDeadline(row.expiresAt);
        const checked=assistant.validate(db,auth.user,projectId,row.input,new Date());if(checked.error||checked.conflicts.length)fail(409,'Assistant consequences changed. Review again.');
        if((db.assistantConfirmations||[]).some(value=>value.tokenHash===row.tokenHash||value.id===row.id))fail(409,'Unproven legacy Assistant receipt needs reconciliation.');
        const result=await run(req,url,db,input);if(result.response.status>=400)fail(result.response.status,result.response.data?.error||'Assistant save unavailable.');
        const candidate=result.candidate,legacy=candidate.assistantConfirmations?.at(-1),token=JSON.parse(Buffer.from(row.token.split('.')[0],'base64url')),kind=row.input.action||'schedule',expected=structuredClone(db);
        if(!result.dirty||!legacy||legacy.id!==token.id||!Number.isFinite(Date.parse(legacy.at)))fail(409,'Assistant write proof unavailable.');
        const receipt={id:token.id,tokenHash:row.tokenHash,version:row.version,companyId:db.company.id,userId:auth.user.id,projectId,resourceKind:kind,at:legacy.at};let resources;
        if(['schedule','schedule_batch'].includes(kind)){
          const ids=kind==='schedule_batch'?row.input.memberIds:[row.input.memberId],dates=kind==='schedule_batch'?checked.dates:[row.input.date],rows=createAssignmentRows(db,{...checked.input,projectId,memberIds:ids},dates,legacy.at);rows.forEach(value=>{value.createdByUserId=auth.user.id;value.source='project_assistant';});expected.assignments||=[];expected.assignments.push(...rows);resources=rows.map(value=>({collection:'assignments',id:value.id,hash:canonicalHash(value)}));Object.assign(receipt,kind==='schedule_batch'?{memberIds:ids,assignmentIds:rows.map(value=>value.id)}:{memberId:ids[0],assignmentId:rows[0].id});
        }else{
          const actual=candidate.projectNotesTodos?.[0],note=createProjectNoteRecord({companyId:db.company.id,projectId,user:auth.user,requestId:'assistant-'+token.id,kind,text:checked.input.text,...(kind==='todo'&&checked.input.dueDate?{dueDate:checked.input.dueDate}:{}),at:legacy.at});if(!uuid(actual?.id))fail(409,'Assistant note identity unavailable.');note.id=actual.id;expected.projectNotesTodos||=[];expected.projectNotesTodos.unshift(note);resources=[{collection:'projectNotesTodos',id:note.id,hash:canonicalHash(note)}];receipt.itemId=note.id;
        }
        expected.assistantConfirmations||=[];expected.assistantConfirmations.push(receipt);if(!equal(expected,candidate))fail(409,'Assistant effects need reconciliation.');
        await h.assertCurrent(req);candidate[receipts]||=[];const proof=sign({...omit(row,['id','proof']),id:crypto.randomUUID(),previewId:row.id,committedRevision:h.revision()+1,result:{...result.response.data,repeated:false},resources});candidate[receipts].push(proof);valid(candidate);h.writeDb(candidate);h.context().assistantReturn=proof.id;h.json(res,201,proof.result);return true;
      }
      const result=await run(req,url,db,input);if(result.dirty)fail(409,'Unexpected Assistant preview write.');
      if(action==='preview'&&result.response.status===200&&result.response.data.token){
        const token=result.response.data.token,value=JSON.parse(Buffer.from(token.split('.')[0],'base64url'));
        if(!uuid(value.id)||value.companyId!==db.company.id||value.userId!==auth.user.id||value.projectId!==projectId||value.version!==result.response.data.version||value.expiresAt<=Date.now()||value.expiresAt>Date.now()+600000)fail(409,'Assistant preview proof unavailable.');
        const row=sign({id:value.id,purpose,companyId:db.company.id,actorId:auth.user.id,role:auth.user.role,sessionHash:auth.session.tokenHash,authority:h.authority(db,auth).authority,projectId,token,tokenHash:hash(token),version:value.version,input:value.input,reviewRevision:h.revision()+1,expiresAt:new Date(Math.min(value.expiresAt,Date.parse(auth.session.expiresAt))).toISOString()});db[previews]||=[];db[previews].push(row);valid(db);h.writeDb(db);
      }
      await h.assertCurrent(req);h.json(res,result.response.status,result.response.data);return true;
    }catch(error){if(![400,401,402,403,404,409,503].includes(error.statusCode))throw error;h.json(res,error.statusCode,{error:error.message});return true;}
  }
  function deliver(db,auth,context){
    if(!context.assistantReturn)return;valid(db);const row=(db[receipts]||[]).find(row=>row.id===context.assistantReturn);
    if(!row||row.actorId!==auth.user.id||row.role!==auth.user.role||row.sessionHash!==auth.session.tokenHash||row.authority!==h.authority(db,auth).authority)fail(409,'Original Assistant custody changed.');checkAccess(db,auth,row);
    context.response.data={...row.result,repeated:context.response.data.repeated===true};
  }
  return {handle,deliver,valid};
}
module.exports={route,createHandler,previews,receipts};
