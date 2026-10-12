'use strict';
// Project/day events are scheduling resources. They have no assignment crew
// target and never supply an independent editable grant or assistant flag.
const scheduling=require('./scheduling-access');
const {canonicalHash}=require('./database/transactional-repository');
const types=Object.freeze(['delivery','inspection','trade','safety','other']);
const fields=Object.freeze(['id','projectId','date','type','title','notes','createdAt','createdBy']);
const id=value=>Number.isSafeInteger(value)&&value>0;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(statusCode,message)=>{throw Object.assign(Error(message),{statusCode,code:'PDL_PROJECT_EVENT'});};
const same=(a,b)=>canonicalHash(a??null)===canonicalHash(b??null);
function date(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T12:00:00.000Z'))&&new Date(value+'T12:00:00.000Z').toISOString().slice(0,10)===value;}
function text(value,limit,empty=false){return typeof value==='string'&&value.length<=limit&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)&&(empty||Boolean(value.trim()));}
function route(method,path){
  const create=method==='POST'&&/^\/api\/projects\/([1-9]\d*)\/events$/.exec(path);
  const remove=method==='DELETE'&&/^\/api\/project-events\/([1-9]\d*)$/.exec(path);
  if(create){if(!id(Number(create[1])))fail(400,'Use the current canonical project ID.');return {action:'create',projectId:Number(create[1])};}
  if(remove){if(!id(Number(remove[1])))fail(400,'Use the current canonical event ID.');return {action:'remove',id:Number(remove[1])};}
  return null;
}
function parse(operation,input={},version){
  if(!operation||!object(input))fail(400,'Use the event form fields.');
  if(operation.action==='remove'){
    if(Object.keys(input).length)fail(400,'Use only the current event ID.');
    if(version!==undefined&&(typeof version!=='string'||!/^[a-f0-9]{64}$/.test(version)))fail(400,'Use the current event version.');
    return {...operation,...version===undefined?{}:{expectedVersion:version}};
  }
  if(operation.action!=='create'||Object.keys(input).some(key=>!['date','type','title','notes'].includes(key)))fail(400,'Use only the event form fields.');
  const type=input.type===undefined?'other':input.type,notes=input.notes===undefined?'':input.notes;
  if(!date(input.date))fail(400,'Pick a valid event date.');
  if(!types.includes(type))fail(400,'Choose an event type.');
  if(!text(input.title,140))fail(400,'Give the event a short title (up to 140 characters).');
  if(!text(notes,500,true))fail(400,'Use event notes up to 500 characters.');
  return {...operation,details:{date:input.date,type,title:input.title.trim(),notes:notes.trim()}};
}
function graph(db){
  const rows=db.projectEvents===undefined?[]:db.projectEvents,ids=new Set(),projects=new Map();
  for(const row of db.projects||[])projects.set(row.id,(projects.get(row.id)||0)+1);
  if(!Array.isArray(rows)||rows.length>50000)fail(409,'Project event records need reconciliation.');
  for(const row of rows){
    if(!object(row)||Object.keys(row).some(key=>!fields.includes(key))||fields.some(key=>!Object.hasOwn(row,key))||!id(row.id)||ids.has(row.id)||!id(row.projectId)||projects.get(row.projectId)!==1||!date(row.date)||!types.includes(row.type)||!text(row.title,140)||!text(row.notes,500,true)||typeof row.createdAt!=='string'||!Number.isFinite(Date.parse(row.createdAt))||new Date(row.createdAt).toISOString()!==row.createdAt||!text(row.createdBy,1000))fail(409,'Project event records need reconciliation.');
    ids.add(row.id);
  }
  return rows;
}
function access(db,user,action){
  if(!['view','create','remove'].includes(action)||!user||user.companyId!==undefined&&user.companyId!==db.company?.id)return false;
  if(action!=='view'&&!['owner','admin','project_manager'].includes(user.role))return false;
  return scheduling.access(db,user)[action]===true;
}
function projectAllowed(db,user,projectId,action){
  if(!access(db,user,action)||!id(projectId)||(db.projects||[]).filter(project=>project.id===projectId).length!==1)return false;
  if(['owner','admin'].includes(user.role))return true;
  if(user.role==='project_manager')return Array.isArray(user.projectIds)&&user.projectIds.includes(projectId);
  if(action!=='view'||!['field','foreman'].includes(user.role)||!id(user.memberId))return false;
  const member=(db.team||[]).find(row=>row.id===user.memberId);if(!member)return false;
  const days=(db.workdays||[]).filter(row=>(row.memberIds||[]).includes(user.memberId));
  return (db.assignments||[]).some(row=>row.projectId===projectId&&(row.memberIds||[]).includes(user.memberId))||days.some(row=>row.projectId===projectId)||(db.reports||[]).some(row=>db.projects[row.project]?.id===projectId&&(row.foreman===member.name||(row.laborEntries||[]).some(entry=>Number(entry.memberId)===user.memberId)||days.some(day=>day.reportId===row.id)));
}
function authorize(db,user,operation){
  const rows=graph(db);
  if(!access(db,user,operation.action))fail(403,'Current scheduling permission is required for events.');
  const target=operation.action==='remove'?rows.find(row=>row.id===operation.id):null;
  const projectId=operation.action==='remove'?target?.projectId:operation.projectId;
  if(!id(projectId)||!(db.projects||[]).some(row=>row.id===projectId)||!projectAllowed(db,user,projectId,operation.action))fail(404,operation.action==='remove'?'Event not found.':'Project not found.');
  if(operation.action==='remove'&&operation.expectedVersion!==canonicalHash(target))fail(409,'This event changed. Refresh current events before removing it.');
  return target;
}
function project(row){return {...Object.fromEntries(fields.map(key=>[key,row[key]])),version:canonicalHash(row)};}
function visible(db,user){
  const rows=graph(db);if(!access(db,user,'view'))return [];
  let allowed;
  if(['owner','admin'].includes(user.role))allowed=new Set((db.projects||[]).map(row=>row.id));
  else if(user.role==='project_manager')allowed=new Set(user.projectIds||[]);
  else{
    const member=(db.team||[]).find(row=>row.id===user.memberId);if(!member)return [];
    const days=(db.workdays||[]).filter(row=>(row.memberIds||[]).includes(user.memberId)),reportIds=new Set(days.map(row=>row.reportId));
    allowed=new Set([...(db.assignments||[]).filter(row=>(row.memberIds||[]).includes(user.memberId)).map(row=>row.projectId),...days.map(row=>row.projectId),...(db.reports||[]).filter(row=>row.foreman===member.name||(row.laborEntries||[]).some(entry=>Number(entry.memberId)===user.memberId)||reportIds.has(row.id)).map(row=>db.projects[row.project]?.id)]);
  }
  return rows.filter(row=>allowed.has(row.projectId)).map(project);
}
function validateDelta(before,after,user,operation){
  const old=graph(before),next=graph(after);
  if(!operation){if(!same(old,next))fail(403,'Only an admitted event route can change events.');return;}
  authorize(before,user,operation);
  const expected=structuredClone(before);
  if(operation.action==='remove')expected.projectEvents=old.filter(row=>row.id!==operation.id);
  else{
    const added=next.filter(row=>!old.some(prior=>prior.id===row.id));
    if(added.length!==1)fail(409,'Only the new project event can change.');
    const row=added[0],nextId=old.reduce((maximum,item)=>Math.max(maximum,item.id),0)+1;
    if(!id(nextId)||row.id!==nextId||row.projectId!==operation.projectId||!same(Object.fromEntries(['date','type','title','notes'].map(key=>[key,row[key]])),operation.details)||row.createdBy!==(user.name||'Office user')||!projectAllowed(after,user,row.projectId,'create'))fail(409,'The event does not match its admitted project and form.');
    expected.projectEvents=[...old,row];
  }
  if(!same(expected,after))fail(403,'The event action changed unrelated company records.');
}
module.exports={types,fields,date,route,parse,graph,access,projectAllowed,authorize,project,visible,validateDelta};
