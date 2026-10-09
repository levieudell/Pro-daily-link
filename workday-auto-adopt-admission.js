'use strict';
// A company-authorized consequence of ending a workday. This never supplies
// manual scheduling permissions and reuses the existing scheduling helper.
const daily=require('./daily-access');
const scheduling=require('./scheduling-access');
const calendar=require('./schedule-availability');
const {canonicalHash}=require('./database/transactional-repository');
const equal=(a,b)=>canonicalHash(a??null)===canonicalHash(b??null);
const omit=(row,keys)=>Object.fromEntries(Object.entries(row||{}).filter(([key])=>!keys.includes(key)));
const fail=()=>{throw Object.assign(Error('Automatic schedule consequence needs reconciliation.'),{statusCode:409});};
function dateIso(company,value){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:company.timezone||'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));
  const part=type=>parts.find(row=>row.type===type)?.value;
  return part('year')+'-'+part('month')+'-'+part('day');
}
function targets(db,user,operation){
  if(operation.action!=='endWorkday'||db.company.autoAdoptActualTimes!==true)return [];
  const day=(db.workdays||[]).find(row=>String(row.id)===String(operation.id));
  if(!day||!daily.workdayInScope(db,user,day,'runWorkdays'))fail();
  const date=dateIso(db.company,day.startedAt);
  return (db.assignments||[]).filter(row=>row.projectId===day.projectId&&row.date===date&&row.memberIds.some(id=>day.memberIds.includes(id))&&daily.projectAllowed(db,user,row.projectId)&&row.memberIds.every(id=>daily.memberAllowed(db,user,id))&&(db.workdays||[]).filter(hit=>hit.projectId===row.projectId&&hit.status==='complete'&&hit.endedAt&&hit.memberIds.some(id=>row.memberIds.includes(id))&&dateIso(db.company,hit.startedAt)===date).every(hit=>daily.workdayInScope(db,user,hit,'viewWorkdays')));
}
function apply(db,user,operation,adopt){
  if(typeof adopt!=='function')fail();
  const selected=targets(db,user,operation),results=[];
  for(const assignment of selected){
    const result=adopt(db,assignment,{actor:user.name,auto:true});
    const last=db.auditLog?.at(-1);
    if(result.changed===true){if(last?.type!=='assignment_adopted_actual_times'||last.assignmentId!==assignment.id||last.auto!==true)fail();last.actorId=user.id;}
    results.push({assignmentId:assignment.id,date:assignment.date,changed:result.changed===true,error:result.error||null});
  }
  return results;
}
function validate(before,after,user,operation){
  const ids=new Set(targets(after,user,operation).map(row=>row.id));
  if(!Array.isArray(after.assignments)||after.assignments.length!==before.assignments.length)fail();
  const changed=[];
  for(let index=0;index<before.assignments.length;index++){
    const old=before.assignments[index],row=after.assignments[index];
    if(equal(old,row))continue;
    if(!ids.has(old.id)||row.id!==old.id||!equal(omit(old,['start','end','updatedAt','acknowledgements','notifications']),omit(row,['start','end','updatedAt','acknowledgements','notifications']))||!calendar.validTime(row.start)||!calendar.validTime(row.end)||row.start>=row.end||!Number.isFinite(Date.parse(row.updatedAt))||!equal(row.acknowledgements,{}))fail();
    if(!row.notifications||Object.keys(row.notifications).length!==row.memberIds.length||row.memberIds.some(id=>!equal(row.notifications[id],{inAppAt:row.updatedAt,emailStatus:'not_available'})))fail();
    changed.push(row);
  }
  const tail=(after.auditLog||[]).slice((before.auditLog||[]).length);
  if(tail.length!==changed.length||changed.some(row=>tail.filter(entry=>entry.type==='assignment_adopted_actual_times'&&entry.assignmentId===row.id&&entry.projectId===row.projectId&&entry.auto===true&&entry.actorId===user.id&&entry.actor===user.name&&entry.at===row.updatedAt).length!==1))fail();
}
function present(db,user,operation,rows){
  if(!Array.isArray(rows))fail();
  const ids=new Set(targets(db,user,operation).map(row=>row.id)),seen=new Set();
  return rows.map(row=>{if(!row||Object.keys(row).sort().join(',')!=='assignmentId,changed,date,error'||!ids.has(row.assignmentId)||seen.has(row.assignmentId)||!calendar.validDate(row.date)||typeof row.changed!=='boolean'||row.error!==null&&(typeof row.error!=='string'||row.error.length>1000))fail();seen.add(row.assignmentId);return {...row,error:row.error===null?null:'Automatic update skipped. Review the schedule and workday times.'};}).filter(row=>scheduling.inScope(db,user,db.assignments.find(item=>item.id===row.assignmentId),'view'));
}
module.exports={targets,apply,validate,present};
