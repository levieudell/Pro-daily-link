'use strict';
// Fixed project communication: no editable grant, assistant flag or generic
// permission dictionary. Broadcasts reach the project team; private PM threads
// additionally require the PM's current crew and recipient project scope.
const {canonicalHash}=require('./database/transactional-repository');
const fields=Object.freeze(['id','projectId','memberId','sender','senderName','senderId','text','createdAt','readBy']);
const id=value=>Number.isSafeInteger(value)&&value>0;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value,limit)=>typeof value==='string'&&value.length<=limit&&Boolean(value.trim())&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const same=(a,b)=>canonicalHash(a??null)===canonicalHash(b??null);
const fail=(statusCode,message)=>{throw Object.assign(Error(message),{statusCode,code:'PDL_PROJECT_MESSAGE'});};
function route(method,path){
  if(method!=='POST')return null;
  const match=/^\/api\/projects\/([1-9]\d*)\/messages(\/read)?$/.exec(path);if(!match)return null;
  if(!id(Number(match[1])))fail(400,'Use the current canonical project ID.');
  return {action:match[2]?'read':'create',projectId:Number(match[1])};
}
function parse(operation,input={}){
  if(!operation||!object(input))fail(400,'Use the message form fields.');
  if(operation.action==='read'){if(Object.keys(input).length)fail(400,'Use only the current project for reading messages.');return {...operation};}
  if(operation.action!=='create'||Object.keys(input).some(key=>!['text','memberId'].includes(key))||!text(input.text,1000))fail(400,'Write a message up to 1000 characters.');
  let memberId=input.memberId;if(memberId===undefined||memberId===null||memberId==='')memberId=null;
  else if(typeof memberId==='string'&&/^[1-9]\d*$/.test(memberId))memberId=Number(memberId);
  if(memberId!==null&&!id(memberId))fail(400,'Pick a valid team member.');
  return {...operation,details:{text:input.text.trim(),memberId}};
}
function index(db){
  const projects=new Map(),members=new Map();
  for(const [rows,map] of [[db.projects||[],projects],[db.team||[],members]]){
    if(!Array.isArray(rows)||rows.length>50000)fail(409,'Message scope records need reconciliation.');
    // Admit canonical, unique current-tenant references only. Unrelated legacy
    // rows are not a new global directory migration. No string ID is coerced;
    // every message reference to an omitted or ambiguous node still fails.
    const seen=new Set(),ambiguous=new Set();
    for(const row of rows){
      if(!object(row)||!id(row.id))continue;
      if(seen.has(row.id)){ambiguous.add(row.id);map.delete(row.id);}seen.add(row.id);
      if(ambiguous.has(row.id)||row.companyId!==undefined&&row.companyId!==db.company?.id)continue;
      map.set(row.id,row);
    }
  }
  return {projects,members};
}
function graph(db){
  const rows=db.projectMessages===undefined?[]:db.projectMessages,ids=new Set(),scope=index(db);
  if(!Array.isArray(rows)||rows.length>50000)fail(409,'Project message records need reconciliation.');
  for(const row of rows){
    if(!object(row)||Object.keys(row).some(key=>!fields.includes(key))||fields.some(key=>!Object.hasOwn(row,key))||!id(row.id)||ids.has(row.id)||!scope.projects.has(row.projectId)||row.memberId!==null&&!scope.members.has(row.memberId)||!['office','field'].includes(row.sender)||!text(row.senderName,1000)||!text(row.text,1000)||typeof row.createdAt!=='string'||!Number.isFinite(Date.parse(row.createdAt))||new Date(row.createdAt).toISOString()!==row.createdAt||row.sender==='office'&&(row.senderId!==null&&!id(row.senderId))||row.sender==='field'&&(!id(row.memberId)||row.senderId!==row.memberId)||!Array.isArray(row.readBy)||row.readBy.length>50000||new Set(row.readBy).size!==row.readBy.length)fail(409,'Project message records need reconciliation.');
    for(const tag of row.readBy){
      if(row.sender==='field'){if(tag!=='office')fail(409,'Message reader records need reconciliation.');}
      else if(typeof tag!=='string'||!/^m:[1-9]\d*$/.test(tag)||!scope.members.has(Number(tag.slice(2)))||row.memberId!==null&&Number(tag.slice(2))!==row.memberId)fail(409,'Message reader records need reconciliation.');
    }
    // Historical attribution and receipts are evidence. A later rename, role,
    // status, crew or assignment change does not rewrite an earlier message.
    ids.add(row.id);
  }
  return rows;
}
function access(db,user){return Boolean(user&&['owner','admin','project_manager','field','foreman'].includes(user.role)&&(user.companyId===undefined||user.companyId===db.company?.id)&&(user.status===undefined||user.status==='Active'));}
function memberProjects(db,scope=index(db)){
  const result=new Map([...scope.members.keys()].map(value=>[value,new Set()])),reportDays=new Map(),names=new Map();
  const add=(memberId,projectId)=>{if(result.has(memberId)&&scope.projects.has(projectId))result.get(memberId).add(projectId);};
  for(const member of scope.members.values()){const list=names.get(member.name)||[];list.push(member.id);names.set(member.name,list);}
  for(const row of db.assignments||[])for(const memberId of row.memberIds||[])add(memberId,row.projectId);
  for(const row of db.workdays||[]){for(const memberId of row.memberIds||[])add(memberId,row.projectId);if(row.reportId!=null){const list=reportDays.get(row.reportId)||[];list.push(...(row.memberIds||[]));reportDays.set(row.reportId,list);}}
  // Match the existing Field readable-project floor, including legacy reports
  // whose foreman is stored by name. This inherited project evidence is not
  // message sender attribution; migrating it to numeric identity is separate.
  for(const row of db.reports||[]){const projectId=db.projects[row.project]?.id;for(const memberId of [...(names.get(row.foreman)||[]),...(reportDays.get(row.id)||[])])add(memberId,projectId);for(const entry of row.laborEntries||[])add(Number(entry.memberId),projectId);}
  return result;
}
function scopeFor(db,user){
  const scope=index(db),readable=memberProjects(db,scope),crews=new Set((user?.assignedCrews||[]).map(value=>String(value).trim().toLowerCase()).filter(Boolean));
  let projects=new Set();if(access(db,user)){
    if(['owner','admin'].includes(user.role))projects=new Set(scope.projects.keys());
    else if(user.role==='project_manager')projects=new Set((user.projectIds||[]).filter(value=>scope.projects.has(value)));
    else projects=readable.get(user.memberId)||new Set();
  }
  const memberAllowed=(memberId,projectId)=>scope.members.has(memberId)&&(user?.role!=='project_manager'||crews.has(String(scope.members.get(memberId).crew||'').trim().toLowerCase())&&readable.get(memberId)?.has(projectId));
  return {...scope,readable,projects,memberAllowed};
}
function authorize(db,user,operation){
  graph(db);if(!access(db,user))fail(403,'Sign in with a current project communication role.');
  const scope=scopeFor(db,user);if(!scope.projects.has(operation.projectId))fail(['owner','admin','project_manager'].includes(user.role)?404:403,'This project is outside your current message scope.');
  if(operation.action==='create'&&['owner','admin','project_manager'].includes(user.role)&&operation.details.memberId!==null){
    if(!scope.members.has(operation.details.memberId))fail(400,'Pick a valid team member.');
    if(!scope.memberAllowed(operation.details.memberId,operation.projectId))fail(403,'Private messages require your assigned crew and the recipient project.');
  }
  if(!['create','read'].includes(operation.action))fail(400,'Use a supported message action.');
  return scope;
}
function visibleSource(db,user){
  const rows=graph(db),scope=scopeFor(db,user);if(!access(db,user))return [];
  return rows.filter(row=>scope.projects.has(row.projectId)&&(['owner','admin'].includes(user.role)||user.role==='project_manager'&&(row.memberId===null||scope.memberAllowed(row.memberId,row.projectId))||['field','foreman'].includes(user.role)&&(row.memberId===null||row.memberId===user.memberId)));
}
function project(db,user,row,scope=scopeFor(db,user)){
  const result=Object.fromEntries(fields.map(key=>[key,row[key]]));
  result.readBy=row.readBy.filter(tag=>['owner','admin'].includes(user.role)||user.role==='project_manager'&&(tag==='office'||scope.memberAllowed(Number(tag.slice(2)),row.projectId))||['field','foreman'].includes(user.role)&&(tag==='office'||tag==='m:'+user.memberId));
  return result;
}
function visible(db,user){const scope=scopeFor(db,user);return visibleSource(db,user).map(row=>project(db,user,row,scope));}
function audiences(db,user){
  graph(db);if(!access(db,user))return [];const scope=scopeFor(db,user),office=['owner','admin','project_manager'].includes(user.role);
  return [...scope.projects].map(projectId=>({projectId,memberIds:office?[...scope.members.keys()].filter(memberId=>scope.memberAllowed(memberId,projectId)):[user.memberId],allowBroadcast:office}));
}
function create(db,user,operation,createdAt=new Date().toISOString()){
  const scope=authorize(db,user,operation),field=['field','foreman'].includes(user.role),member=field?scope.members.get(user.memberId):null,rows=graph(db),nextId=rows.reduce((maximum,row)=>Math.max(maximum,row.id),0)+1;
  if(!id(nextId))fail(409,'Message IDs need reconciliation.');
  return {id:nextId,projectId:operation.projectId,memberId:field?member.id:operation.details.memberId,sender:field?'field':'office',senderName:user.name||member?.name||(field?'Field':'Office user'),senderId:field?member.id:user.id??null,text:operation.details.text,createdAt,readBy:[]};
}
function readChanges(db,user,operation){
  authorize(db,user,operation);const office=['owner','admin','project_manager'].includes(user.role),tag=office?'office':'m:'+user.memberId;
  return visibleSource(db,user).filter(row=>row.projectId===operation.projectId&&row.sender===(office?'field':'office')&&!row.readBy.includes(tag)).map(row=>({id:row.id,tag}));
}
function validateDelta(before,after,user,operation){
  const old=graph(before),next=graph(after);if(!operation){if(!same(old,next))fail(403,'Only an admitted message route can change messages.');return;}
  authorize(before,user,operation);const expected=structuredClone(before);
  if(operation.action==='create'){
    const oldIds=new Set(old.map(row=>row.id)),added=next.filter(row=>!oldIds.has(row.id));if(added.length!==1)fail(409,'Only the new project message can change.');
    const row=added[0],admitted=create(before,user,operation,row.createdAt);if(!same(admitted,row))fail(409,'The message does not match its admitted author and audience.');
    authorize(after,user,operation);expected.projectMessages=[...old,row];
  }else{
    const changes=readChanges(before,user,operation);if(changes.length){expected.projectMessages=structuredClone(old);const byId=new Map(expected.projectMessages.map(row=>[row.id,row]));for(const change of changes)byId.get(change.id).readBy.push(change.tag);}
    authorize(after,user,operation);
  }
  if(!same(expected,after))fail(403,'The message action changed unrelated company records or readers.');
}
module.exports={fields,route,parse,index,graph,access,memberProjects,scopeFor,authorize,visibleSource,project,visible,audiences,create,readChanges,validateDelta};
