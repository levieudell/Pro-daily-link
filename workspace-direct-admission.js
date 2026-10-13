'use strict';
// Finite G2 save proofs for the existing scheduling, private leave, and project
// note forms. This module admits no caller-selected route or permission name.
const crypto = require('node:crypto');
const { canonicalHash } = require('./database/transactional-repository');
const { validateWorkspace } = require('./compat-workspace-evidence');
const dto = require('./compat-workspace-projections');
const noteAccess = require('./notes-access');
const leaveAccess = require('./time-off-access');
const leave = require('./time-off-admission');
const { actorBinding } = require('./compat-workspace-delivery');
const previews = 'workspaceDirectPreviews', receipts = 'workspaceDirectReceipts';
const purpose = 'workspace-direct-save-v1';
const fail = (statusCode, message) => { throw Object.assign(Error(message), { statusCode }); };
const equal = (a,b) => canonicalHash(a ?? null) === canonicalHash(b ?? null);
const closed = (v,keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k=>keys.includes(k));
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const omit = (db,keys) => Object.fromEntries(Object.entries(db).filter(([k])=>!keys.includes(k)));
function route(method,path) {
  const u = new URL(path,'http://localhost');
  if (method === 'POST' && u.pathname === '/api/assignments') return {family:'scheduling',action:'create'};
  if (/^\/api\/assignments\/[1-9]\d*$/.test(u.pathname) && ['PATCH','DELETE'].includes(method)) return {family:'scheduling',action:method==='PATCH'?'edit':'remove'};
  if (method === 'POST' && /^\/api\/assignments\/[1-9]\d*\/acknowledge$/.test(u.pathname)) return {family:'scheduling',action:'acknowledge'};
  if (method === 'POST' && u.pathname === '/api/time-off-requests') return {family:'timeOff',action:'createRequest'};
  if (method === 'POST' && /^\/api\/projects\/[1-9]\d*\/notes-todos$/.test(u.pathname)) return {family:'notes',action:'create'};
  if (method === 'PATCH' && /^\/api\/projects\/[1-9]\d*\/notes-todos\/[a-f0-9-]{36}$/.test(u.pathname)) return {family:'notes',action:'change'};
  return null;
}
function parse(input) {
  if (!closed(input,['family','action','method','path','details']) || typeof input.path !== 'string' || input.path.length>200 || !input.path.startsWith('/api/') || /[#\\]/.test(input.path)) fail(400,'Choose a supported workspace change.');
  const operation=route(input.method,input.path), url=new URL(input.path,'http://localhost');
  if (!operation || operation.family!==input.family || Object.hasOwn(input,'action')&&input.action!==operation.action || !closed(input.details,Object.keys(input.details||{})) || [...url.searchParams.keys()].some(k=>operation.family!=='scheduling'||operation.action!=='remove'||k!=='memberId') || url.searchParams.getAll('memberId').length>1) fail(400,'Choose a supported workspace change.');
  return {...operation,method:input.method,path:input.path,details:structuredClone(input.details)};
}
function authorize(db,req,op,projectAllowed,removedRecord) {
  const user=req.auth.user, url=new URL(op.path,'http://localhost');
  if (op.family==='scheduling') {
    // A successful removal may be checked again using its original, immutable
    // record. Current project/member ceilings must still authorize that record.
    const scopeDb=removedRecord ? {...db,assignments:[...(db.assignments||[]).filter(r=>r.id!==removedRecord.id),removedRecord]} : db;
    const denial=require('./scheduling-route-guard').guard(scopeDb,user,op.method,url,op.details);
    if (denial) fail(denial.status,denial.error);
  } else if (op.family==='timeOff') {
    if (!leaveAccess.inScope(db,user,{memberId:user.memberId},'createRequest')) fail(403,'A permitted linked field account is required.');
    if (!leave.parse(op.details)) fail(400,'Enter valid typed time-off details and a save request ID.');
  } else {
    const projectId=Number(url.pathname.split('/')[3]), p=noteAccess.access(db,user);
    noteAccess.validateActor(user); noteAccess.validateRows(db,projectId);
    if (!p.view || !noteAccess.projectAllowed(db,user,projectId,projectAllowed)) fail(404,'Project not found.');
    const keys=op.action==='create'?['kind','text','dueDate','requestId']:['revision','text','dueDate','completed'];
    if (!closed(op.details,keys)) fail(400,'Only supported note details can be changed.');
    if (op.action==='create' && !p.create || op.action==='change' && ((Object.hasOwn(op.details,'text')||Object.hasOwn(op.details,'dueDate'))&&!p.edit||Object.hasOwn(op.details,'completed')&&!p.complete)) fail(403,'This note change is disabled for your role.');
    if (op.action==='change') { const row=noteAccess.unique(db.projectNotesTodos,url.pathname.split('/')[5],'Note');if(row.companyId!==db.company.id||Number(row.projectId)!==projectId)fail(404,'Note not found.'); }
  }
}
function schedulingResponse(data,db,user) {
  const project=row=>{const visible=require('./scheduling-access').visibleAssignments({...db,assignments:[row]},user)[0];if(!visible)fail(403,'Current assignment view access required.');return dto.assignment({...row,...visible});};
  return data.assignments?{assignments:data.assignments.map(project)}:data.assignment?{assignment:project(data.assignment),...(data.sourceAssignment!==undefined?{sourceAssignment:data.sourceAssignment?project(data.sourceAssignment):null}:{})}:data.id?project(data):{ok:true};
}
function createHandler(h) {
  const key=h.key;
  if (!Buffer.isBuffer(key)||key.length!==32)fail(503,'Workspace proof key required.');
  const sign=row=>{const value={...row};delete value.proof;row.proof=crypto.createHmac('sha256',key).update(purpose+':'+canonicalHash(value)).digest('hex');return row;};
  function valid(db) {
    for(const name of [previews,receipts]) {
      const rows=db[name]===undefined?[]:db[name], ids=new Set(), requestIds=new Set();if(!Array.isArray(rows)||rows.length>50000||Buffer.byteLength(JSON.stringify(rows))>5000000)fail(409,'Workspace save records need reconciliation.');
      for(const row of rows) {
        const fields=['id','purpose','companyId','actorId','sessionHash','authority','operation','version','createdAt','proof',...(name===previews?['expiresAt']:['requestId','previewId','status','result','removedRecord'])];
        if(!closed(row,fields)||Object.keys(row).length!==fields.length||!uuid(row.id)||ids.has(row.id)||row.purpose!==purpose||row.companyId!==db.company.id||!Number.isSafeInteger(row.actorId)||row.actorId<1||![row.sessionHash,row.authority,row.version,row.proof].every(hash)||!Number.isFinite(Date.parse(row.createdAt)))fail(409,'Workspace save records need reconciliation.');
        const copy={...row};delete copy.proof;const proof=crypto.createHmac('sha256',key).update(purpose+':'+canonicalHash(copy)).digest('hex');if(!crypto.timingSafeEqual(Buffer.from(proof,'hex'),Buffer.from(row.proof,'hex')))fail(409,'Workspace save proof could not be verified.');
        const op=parse(row.operation);if(!equal(op,row.operation))fail(409,'Workspace save operation needs reconciliation.');
        if(name===previews){if(!Number.isFinite(Date.parse(row.expiresAt))||Date.parse(row.expiresAt)<=Date.parse(row.createdAt)||Date.parse(row.expiresAt)>Date.parse(row.createdAt)+600000)fail(409,'Workspace preview needs reconciliation.');}
        else {const identity=row.actorId+':'+row.requestId;if(typeof row.requestId!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(row.requestId)||requestIds.has(identity)||!uuid(row.previewId)||![200,201].includes(row.status)||!row.result||typeof row.result!=='object'||Array.isArray(row.result))fail(409,'Workspace receipt needs reconciliation.');requestIds.add(identity);}
        ids.add(row.id);
      }
    }
  }
  // Only these named private custody collections are excluded. Business data,
  // session/account state, and all typed policies remain in the version.
  const version=(db,req)=>canonicalHash({source:omit(db,[previews,receipts]),authority:actorBinding(db,req.auth)});
  async function execute(req,op) {
    const before=h.readDb();authorize(before,req,op,h.projectAllowed);
    if(op.family==='timeOff') {
      const input=leave.parse(op.details), details=leave.business({...input,memberId:req.auth.user.memberId});
      if((before.timeOffActionReceipts||[]).some(r=>r.actorId===req.auth.user.id&&r.requestId===input.requestId))fail(409,'Use the original server save proof to check this request.');
      if((before.timeOffRequests||[]).some(r=>r.memberId===req.auth.user.memberId&&r.requestId===input.requestId))fail(409,'This existing request needs review; its originating receipt is unavailable.');
      const candidate=structuredClone(before), at=new Date().toISOString(), row={id:crypto.randomUUID(),...details,status:'pending',requestedAt:at,history:[{action:'Requested',by:req.auth.user.name,at}]};
      candidate.timeOffRequests||=[];candidate.timeOffRequests.unshift(row);
      candidate.timeOffActionReceipts||=[];candidate.timeOffActionReceipts.push({id:crypto.randomUUID(),actorId:req.auth.user.id,sessionHash:req.auth.session.tokenHash,requestId:input.requestId,inputHash:canonicalHash(details),recordId:row.id});
      candidate.auditLog||=[];candidate.auditLog.push({id:crypto.randomUUID(),type:'time_off_requested',actorId:req.auth.user.id,actor:req.auth.user.name,recordId:row.id,memberId:row.memberId,at});
      return {candidate,status:201,data:leaveAccess.present(row)};
    }
    const result=await h.run(req,op);if(result.response.status>=400)fail(result.response.status,result.response.data?.error||'Workspace change unavailable.');
    const candidate=result.candidate;
    if(op.family==='scheduling') {
      if(!equal(omit(before,['assignments']),omit(candidate,['assignments'])))fail(409,'Unsupported scheduling change.');
      validateWorkspace(candidate);
    } else require('./notes-admission').validateDelta(before,candidate,req.auth.user,op.method,Number(op.path.split('/')[3]),op.path.split('/')[5]);
    candidate.auditLog||=[];candidate.auditLog.push({id:crypto.randomUUID(),type:op.family==='scheduling'?'schedule_changed':'project_note_changed',actorId:req.auth.user.id,actor:req.auth.user.name,at:new Date().toISOString()});
    return {candidate,status:result.response.status,data:op.family==='scheduling'?schedulingResponse(result.response.data,candidate,req.auth.user):result.response.data};
  }
  return async function handle(req,res,url) {
    const preview=req.method==='POST'&&url.pathname==='/api/workspace-direct-preview', selected=route(req.method,url.pathname+url.search);
    if(!preview&&!selected)return false;
    try {
      const db=h.readDb();valid(db);await h.assertCurrent(req);const input=await h.body(req);
      if(preview) {
        const op=parse(input), proposed=await execute(req,op);
        if(Buffer.byteLength(JSON.stringify(db[receipts]||[]))+Buffer.byteLength(JSON.stringify(proposed.data))+Buffer.byteLength(JSON.stringify(op))+20000>5000000)fail(409,'Workspace save capacity requires review before another preview.');
        const at=Date.now(), row=sign({id:crypto.randomUUID(),purpose,companyId:db.company.id,actorId:req.auth.user.id,sessionHash:req.auth.session.tokenHash,authority:actorBinding(db,req.auth),operation:op,version:version(db,req),createdAt:new Date(at).toISOString(),expiresAt:new Date(Math.min(at+600000,Date.parse(req.auth.session.expiresAt))).toISOString()});
        db[previews]||=[];db[previews].push(row);valid(db);h.writeDb(db);h.json(res,200,{token:row.id,version:row.version,details:op.details});return true;
      }
      if(!closed(input,['token','version','confirmed','requestId'])||Object.keys(input).length!==4||!uuid(input.token)||!hash(input.version)||input.confirmed!==true||typeof input.requestId!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(input.requestId))fail(400,'Review a current server preview and explicitly confirm this change.');
      const prior=(db[receipts]||[]).find(r=>r.actorId===req.auth.user.id&&r.requestId===input.requestId);
      if(prior) {
        if(prior.previewId!==input.token||prior.version!==input.version||prior.sessionHash!==req.auth.session.tokenHash||prior.authority!==actorBinding(db,req.auth)||prior.operation.method!==req.method||prior.operation.path!==url.pathname+url.search)fail(409,'The original save identity or authority changed.');
        authorize(db,req,prior.operation,h.projectAllowed,prior.removedRecord);
        if(prior.operation.family==='scheduling'&&prior.operation.action==='create')h.resumeAssignmentDelivery?.(db,prior.result);
        const currentRow=prior.operation.family==='timeOff'?(db.timeOffRequests||[]).find(r=>r.id===prior.result.id):null;if(prior.operation.family==='timeOff'&&!currentRow)fail(409,'The saved request needs reconciliation.');
        const current=prior.operation.family==='notes'?require('./project-notes').presentItem(noteAccess.unique(db.projectNotesTodos,prior.result.id,'Saved note')):currentRow?leaveAccess.present(currentRow):null;
        const saved=prior.operation.family==='scheduling'?schedulingResponse(prior.result,db,req.auth.user):prior.result;
        h.json(res,prior.status,{...saved,originalSaveResult:true,...(current?{currentItem:current}:{})});return true;
      }
      const row=(db[previews]||[]).find(r=>r.id===input.token);
      if(!row||row.version!==input.version||row.actorId!==req.auth.user.id||row.sessionHash!==req.auth.session.tokenHash||row.authority!==actorBinding(db,req.auth)||row.operation.method!==req.method||row.operation.path!==url.pathname+url.search||Date.parse(row.expiresAt)<=Date.now()||row.version!==version(db,req)||(db[receipts]||[]).some(r=>r.previewId===row.id))fail(409,'Workspace changed. Review a new preview.');
      h.guardDeadline(row.expiresAt);const result=await execute(req,row.operation);await h.assertCurrent(req);
      if(row.operation.family==='scheduling'&&row.operation.action==='create')h.stageAssignmentDelivery?.(result.candidate,req,result.data);
      result.candidate[receipts]||=[];result.candidate[receipts].push(sign({id:crypto.randomUUID(),purpose,companyId:db.company.id,actorId:req.auth.user.id,sessionHash:req.auth.session.tokenHash,authority:row.authority,operation:row.operation,version:row.version,createdAt:new Date().toISOString(),requestId:input.requestId,previewId:row.id,status:result.status,result:result.data,removedRecord:row.operation.family==='scheduling'&&row.operation.action==='remove'?(db.assignments||[]).find(r=>r.id===Number(url.pathname.split('/')[3])):null}));
      valid(result.candidate);
      h.writeDb(result.candidate);h.json(res,result.status,result.data);return true;
    } catch(error) {if(![400,401,402,403,404,409,503].includes(error.statusCode))throw error;h.json(res,error.statusCode,{error:error.message});return true;}
  };
}
module.exports={createHandler,route,parse,previews,receipts};
