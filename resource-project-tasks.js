'use strict';
// Existing linked-task routes, intersected with the current scheduling controller.
const engine = require('./project-schedule');
const scheduling = require('./scheduling-access');
const dto = require('./compat-workspace-projections');
const availability = require('./schedule-availability');
const {createAssignmentRows} = require('./assignment-records');
const { canonicalHash } = require('./database/transactional-repository');
const equal = (a,b) => canonicalHash(a ?? null) === canonicalHash(b ?? null);
const omit = (row,keys) => Object.fromEntries(Object.entries(row).filter(([key])=>!keys.includes(key)));
const iso = value => typeof value==='string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value;
function route(method,path) {
  if (/^\/api\/projects\/[1-9]\d*\/tasks$/.test(path)) return method==='GET'?'projectTasksView':method==='POST'?'projectTaskCreate':null;
  if (/^\/api\/project-tasks\/[1-9]\d*$/.test(path)) return method==='PATCH'?'projectTaskEdit':method==='DELETE'?'projectTaskRemove':null;
  if (method==='PATCH' && /^\/api\/projects\/[1-9]\d*$/.test(path)) return 'projectDates';
  if (method==='POST' && /^\/api\/project-tasks\/[1-9]\d*\/assign$/.test(path)) return 'projectTaskAssign';
  return null;
}
function parse(op,input) {
  const d=op.details,out={};
  if (['projectTaskCreate','projectTaskEdit'].includes(op.kind)) {
    if(!input.object(d,['name','durationDays','predecessorIds','memberIds','crew','status']) || !Object.keys(d).length)input.fail(400,'Enter supported task details.');
    for(const [key,limit]of [['name',160],['crew',80]])if(Object.hasOwn(d,key))out[key]=input.text(d[key],limit,key==='name');
    if(Object.hasOwn(d,'durationDays')){if(!Number.isSafeInteger(d.durationDays)||d.durationDays<1||d.durationDays>365)input.fail(400,'Choose one to 365 working days.');out.durationDays=d.durationDays;}
    for(const key of ['predecessorIds','memberIds'])if(Object.hasOwn(d,key)){if(!Array.isArray(d[key])||d[key].length>1000||d[key].some(id=>!input.id(id))||new Set(d[key]).size!==d[key].length)input.fail(400,'Choose unique current task or employee IDs.');out[key]=[...d[key]];}
    if(Object.hasOwn(d,'status')){if(!engine.STATUS.includes(d.status))input.fail(400,'Choose a supported task status.');out.status=d.status;}
    if(op.kind==='projectTaskCreate'&&(!out.name||!out.durationDays))input.fail(400,'Task name and duration are required.');
  } else if(op.kind==='projectDates') {
    if(!input.object(d,['startDate','endDate'])||!Object.keys(d).length)input.fail(400,'Change only the project start and end dates.');
    for(const key of Object.keys(d)){if(d[key]!==''&&!input.date(d[key]))input.fail(400,'Enter a real project date.');out[key]=d[key];}
    if(out.startDate&&out.endDate&&out.endDate<out.startDate)input.fail(400,'Project end cannot precede its start.');
  } else if(op.kind==='projectTaskAssign') {
    if(!input.object(d,['memberId','fromDate'])||!input.id(d.memberId)||Object.hasOwn(d,'fromDate')&&!input.date(d.fromDate))input.fail(400,'Choose a current employee and a real starting date.');
    out.memberId=d.memberId;if(Object.hasOwn(d,'fromDate'))out.fromDate=d.fromDate;
  } else if(!input.object(d,[])||Object.keys(d).length)input.fail(400,'This task action accepts no arbitrary fields.');
  return {...op,details:out};
}
function projectId(db,op) {
  if(['projectTasksView','projectTaskCreate','projectDates'].includes(op.kind))return Number(op.path.split('/')[3]);
  return Number((db.projectTasks||[]).find(row=>Number(row.id)===Number(op.path.split('/')[3]))?.projectId);
}
function actorScope(db,user,project,action,input) {
  if(!scheduling.access(db,user)[action])input.fail(403,'Current scheduling permission required.');
  if(user.role==='project_manager'&&!(user.projectIds||[]).map(Number).includes(Number(project.id)))input.fail(404,'Project not found.');
  if(['field','foreman'].includes(user.role)){
    if(action!=='view'||![...(db.assignments||[]),...(db.workdays||[])].some(row=>Number(row.projectId)===Number(project.id)&&(row.memberIds||[]).map(Number).includes(Number(user.memberId))))input.fail(404,'Project not found.');
  }
}
function authorizeActor(auth,op,input) {
  if(!auth?.user||auth.user.status!=='Active'||!['owner','admin','project_manager','foreman','field'].includes(auth.user.role))input.fail(403,'Current company account required.');
  if(op.kind!=='projectTasksView'&&!['owner','admin','project_manager'].includes(auth.user.role))input.fail(403,'Current office scheduling permission required.');
}
function graph(db,input) {
  const rows=db.projectTasks||[],ids=new Set();
  if(!Array.isArray(rows)||rows.length>10000)input.fail(409,'Task graph requires reconciliation.');
  for(const row of rows){
    if(!row||typeof row.name!=='string'||!row.name.trim()||row.name.length>160||!Number.isSafeInteger(row.durationDays)||row.durationDays<1||row.durationDays>365||typeof row.crew!=='string'||row.crew.length>80||!engine.STATUS.includes(row.status)||!input.id(row.id)||ids.has(row.id)||row.companyId!=null&&row.companyId!==db.company.id||!(db.projects||[]).some(p=>Number(p.id)===Number(row.projectId))||!Array.isArray(row.predecessorIds)||!Array.isArray(row.memberIds)||new Set(row.predecessorIds).size!==row.predecessorIds.length||new Set(row.memberIds).size!==row.memberIds.length||row.memberIds.some(id=>!input.id(id)||!(db.team||[]).some(member=>Number(member.id)===id)))input.fail(409,'Task graph requires reconciliation.');
    ids.add(row.id);
  }
  for(const row of rows)if(row.predecessorIds.some(id=>!input.id(id)||id===row.id||!rows.some(other=>other.id===id&&Number(other.projectId)===Number(row.projectId))))input.fail(409,'Task dependencies require reconciliation.');
  for(const project of db.projects||[]){const tasks=rows.filter(row=>Number(row.projectId)===Number(project.id));if(tasks.length&&engine.scheduleTasks(tasks,project.startDate).error)input.fail(409,'Task dependencies require reconciliation.');}
  return rows;
}
function membersAllowed(db,user,projectId,ids,action,input){
  for(const id of ids){const member=db.team.find(row=>Number(row.id)===id);if(!member||member.archivedAt||member.archived||member.status==='Inactive')input.fail(409,'Choose active current employees.');}
  if(user.role==='project_manager'&&ids.length&&!scheduling.inScope(db,user,{projectId,memberIds:ids},action))input.fail(403,'You can only schedule your assigned crews on your assigned projects.');
}
function crewAllowed(user,row,input){if(user.role==='project_manager'&&row.crew&&!(user.assignedCrews||[]).some(crew=>String(crew).trim().toLowerCase()===String(row.crew).trim().toLowerCase()))input.fail(403,'You can only change tasks for your assigned crews.');}
function authorize(db,auth,op,h,input) {
  authorizeActor(auth,op,input);graph(db,input);const id=projectId(db,op),project=db.projects.find(row=>Number(row.id)===id);
  if(!project)input.fail(404,'Project not found.');
  const action={projectTasksView:'view',projectTaskCreate:'create',projectTaskEdit:'edit',projectTaskRemove:'remove',projectDates:'edit',projectTaskAssign:'create'}[op.kind];
  actorScope(db,auth.user,project,action,input);
  if(op.kind==='projectTasksView')return;
  const old=(db.projectTasks||[]).find(row=>Number(row.id)===Number(op.path.split('/')[3]));
  if(!['projectTaskCreate','projectDates'].includes(op.kind)&&!old)input.fail(404,'Task not found.');
  if(old){crewAllowed(auth.user,old,input);membersAllowed(db,auth.user,id,old.memberIds,action,input);}
  membersAllowed(db,auth.user,id,op.kind==='projectTaskAssign'?[op.details.memberId]:op.details.memberIds||[],action,input);
  if(op.details.crew&&auth.user.role==='project_manager'&&!(auth.user.assignedCrews||[]).some(name=>name.trim().toLowerCase()===op.details.crew.toLowerCase()))input.fail(403,'Choose one of your assigned crews.');
  if(op.kind==='projectDates'){
    const start=op.details.startDate??project.startDate??'',end=op.details.endDate??project.endDate??'';
    if(start&&end&&end<start)input.fail(400,'Project end cannot precede its start.');
  }
  const preds=op.details.predecessorIds||old?.predecessorIds||[];
  if(preds.some(pred=>pred===old?.id||!db.projectTasks.some(row=>row.id===pred&&Number(row.projectId)===id)))input.fail(400,'Link current tasks from this project only.');
}
function task(row){return {...dto.pick(row,['id','projectId','name','durationDays','crew','status','startDate','endDate','createdAt','createdBy','updatedAt','updatedBy','assignedAt','assignedBy']),predecessorIds:[...(row.predecessorIds||[])],memberIds:[...(row.memberIds||[])]};}
function visible(db,user,id,input){
  const project=db.projects.find(row=>Number(row.id)===Number(id));if(!project)input.fail(404,'Project not found.');actorScope(db,user,project,'view',input);graph(db,input);
  const scheduled=engine.scheduleTasks((db.projectTasks||[]).filter(row=>Number(row.projectId)===Number(id)),project.startDate);if(scheduled.error)input.fail(409,'Task graph requires reconciliation.');
  return scheduled.tasks.map(row=>{const out=task(row);out.readOnly=['field','foreman'].includes(user.role)||(user.role==='project_manager'&&((row.crew&&!(user.assignedCrews||[]).some(crew=>String(crew).trim().toLowerCase()===String(row.crew).trim().toLowerCase()))||(row.memberIds||[]).some(id=>!db.team.some(member=>Number(member.id)===id&&(user.assignedCrews||[]).some(crew=>String(crew).trim().toLowerCase()===String(member.crew||'').trim().toLowerCase())))));if(user.role==='project_manager'){const crews=new Set((user.assignedCrews||[]).map(name=>name.trim().toLowerCase()));out.memberIds=out.memberIds.filter(id=>db.team.some(member=>Number(member.id)===id&&crews.has(String(member.crew||'').trim().toLowerCase())));if(out.crew&&!crews.has(out.crew.toLowerCase()))out.crew='';}else if(['field','foreman'].includes(user.role)){out.memberIds=out.memberIds.filter(id=>id===Number(user.memberId));out.crew='';}return out;});
}
function assignmentEffects(before,op,auth,input,actual){
  const id=projectId(before,op),expected=structuredClone(before.assignments||[]),old=(before.projectTasks||[]).find(row=>row.id===Number(op.path.split('/')[3])),member=before.team.find(row=>Number(row.id)===op.details.memberId);
  const memberId=op.details.memberId,from=op.details.fromDate||old.startDate;
  if(!input.date(from)||!input.date(old.endDate)||old.endDate<from||(Date.parse(old.endDate+'T12:00:00Z')-Date.parse(from+'T12:00:00Z'))/86400000>90)input.fail(400,'Choose a valid task range of up to 90 days.');
  const dates=[];for(let cursor=new Date(from+'T12:00:00Z'),last=new Date(old.endDate+'T12:00:00Z');cursor<=last;cursor.setUTCDate(cursor.getUTCDate()+1)){const date=cursor.toISOString().slice(0,10);if(engine.isBusinessDay(new Date(date+'T12:00:00')))dates.push(date);}
  if(!dates.length)input.fail(400,'This task range has no workdays.');
  const touched=[],approved=availability.approved(before.timeOffRequests,[memberId]);let created=0,merged=0,skipped=0,at=null;
  for(const date of dates){
    if(availability.onDate(approved,memberId,date)||expected.some(row=>row.date===date&&row.projectId!==id&&row.memberIds.includes(memberId)&&'07:00'<row.end&&'15:30'>row.start)||expected.some(row=>row.date===date&&row.projectId===id&&row.memberIds.includes(memberId)&&'07:00'<row.end&&'15:30'>row.start)){skipped++;continue;}
    const row=expected.find(row=>row.date===date&&row.projectId===id&&'07:00'<row.end&&'15:30'>row.start),nextId=Math.max(0,...expected.map(row=>Number(row.id)||0))+1,changed=(actual.assignments||[]).find(value=>value.id===(row?.id||nextId));
    const stamp=changed?.notifications?.[memberId]?.inAppAt;
    if(!iso(stamp)||at&&at!==stamp)input.fail(409,'Task assignment effects require reconciliation.');at=stamp;
    if(row){row.memberIds=[...row.memberIds,memberId];row.notifications||={};row.notifications[memberId]={inAppAt:at,emailStatus:'not_available'};touched.push(row);merged++;}
    else {const added=createAssignmentRows({...before,assignments:expected},{projectId:id,memberIds:[memberId],crew:member.crew||null,start:'07:00',end:'15:30',activity:old.name},[date],at);expected.push(...added);touched.push(...added);created++;}
  }
  for(const row of touched)if(!scheduling.inScope(before,auth.user,row,'create'))input.fail(403,'You can only schedule whole shifts within your current project and crew scope.');
  return {expected,touched,created,merged,skipped,at,member};
}
function prepareCandidate(before,after,op,auth,h,input){
  if(op.kind!=='projectTaskAssign')return;
  const ids=(after.assignments||[]).filter(row=>!equal(row,(before.assignments||[]).find(old=>old.id===row.id))).map(row=>row.id);
  if(typeof h.cancelTaskAssignments!=='function'||typeof h.validateAssignment!=='function')input.fail(503,'Reviewed task delivery custody is required.');
  h.validateAssignment(before);h.cancelTaskAssignments(after,ids);h.validateAssignment(after);
}
function assignmentLedger(before,after,ids,h,input){
  const old=h.validateAssignment(before),current=h.validateAssignment(after);
  const expected=old.map(row=>row.status==='queued'&&row.source.assignments.some(value=>ids.includes(value.id))?omit({...row,status:'cancelled'},['proof']):omit(row,['proof']));
  if(!equal(current.map(row=>omit(row,['proof'])),expected))input.fail(409,'Task delivery cancellation requires reconciliation.');
}
function validate(before,after,op,auth,h,input){
  graph(before,input);graph(after,input);const id=projectId(before,op),target=Number(op.path.split('/')[3]),oldRows=before.projectTasks||[],expected=structuredClone(oldRows),project=before.projects.find(row=>Number(row.id)===id),actor=auth.user;
  const fail=()=>input.fail(409,'Task effects require reconciliation.');let expectedProjects=before.projects,changedTarget;
  if(op.kind==='projectTaskCreate'){
    if((after.projectTasks||[]).length!==oldRows.length+1)fail();const actual=after.projectTasks.at(-1),check=engine.validate(op.details,null,new Set(before.team.map(row=>Number(row.id))));if(check.error)fail();
    const created={id:Math.max(0,...oldRows.map(row=>row.id))+1,projectId:id,...check.value,createdAt:actual.createdAt,createdBy:actor.name};if(!iso(actual.createdAt))fail();expected.push(created);changedTarget=created.id;
  }else if(op.kind==='projectTaskEdit'){
    const row=expected.find(row=>row.id===target),actual=after.projectTasks.find(row=>row.id===target),check=engine.validate(op.details,row,new Set(before.team.map(row=>Number(row.id))));if(!row||!actual||check.error||!iso(actual.updatedAt))fail();Object.assign(row,check.value,{updatedAt:actual.updatedAt,updatedBy:actor.name});changedTarget=target;
  }else if(op.kind==='projectTaskRemove'){
    const index=expected.findIndex(row=>row.id===target);if(index<0)fail();const [removed]=expected.splice(index,1);
    for(const row of expected)if(Number(row.projectId)===id&&row.predecessorIds.includes(target))row.predecessorIds=[...new Set([...row.predecessorIds.filter(pred=>pred!==target),...removed.predecessorIds])].filter(pred=>pred!==row.id);
  }else if(op.kind==='projectTaskAssign'){
    const effect=assignmentEffects(before,op,auth,input,after),row=expected.find(row=>row.id===target);
    if(!row)fail();if(effect.created+effect.merged>0)Object.assign(row,{memberIds:[op.details.memberId],assignedAt:effect.at,assignedBy:actor.name});
    if(!equal(after.projectTasks,expected)||!equal(after.assignments||[],effect.expected)||!equal(omit(before,['projectTasks','assignments','workspaceAssignmentJobs']),omit(after,['projectTasks','assignments','workspaceAssignmentJobs'])))fail();
    assignmentLedger(before,after,effect.touched.map(row=>row.id),h,input);
    return {data:{tasks:visible(after,actor,id,input),changed:[],created:effect.created,merged:effect.merged,skipped:effect.skipped,memberId:op.details.memberId,memberName:effect.member.name},retained:{assignmentIds:effect.touched.map(row=>row.id),projectTasks:structuredClone(oldRows.filter(row=>Number(row.projectId)===id)),assignments:structuredClone((before.assignments||[]).filter(row=>effect.touched.some(value=>value.id===row.id)))}};
  }else if(op.kind==='projectDates'){
    expectedProjects=before.projects.map(row=>Number(row.id)===id?{...row,startDate:op.details.startDate??row.startDate??'',endDate:op.details.endDate??row.endDate??''}:row);
  }else fail();
  const anchor=expectedProjects.find(row=>Number(row.id)===id).startDate,schedule=engine.scheduleTasks(expected.filter(row=>Number(row.projectId)===id),anchor);if(schedule.error)fail();
  for(const row of expected){const computed=schedule.tasks.find(task=>task.id===row.id);if(computed){row.startDate=computed.startDate;row.endDate=computed.endDate;}}
  if(!equal(after.projectTasks||[],expected)||!equal(after.projects,expectedProjects)||!equal(omit(before,['projectTasks','projects']),omit(after,['projectTasks','projects'])))fail();
  const affected=expected.filter(row=>!equal(row,oldRows.find(old=>old.id===row.id)));for(const row of affected){const original=oldRows.find(old=>old.id===row.id);if(original)crewAllowed(actor,original,input);crewAllowed(actor,row,input);membersAllowed(before,actor,id,row.memberIds,op.kind==='projectTaskCreate'?'create':op.kind==='projectTaskRemove'?'remove':'edit',input);}
  const tasks=visible(after,actor,id,input),changed=engine.changedDateIds(oldRows.filter(row=>Number(row.projectId)===id).map(row=>({id:row.id,startDate:row.startDate,endDate:row.endDate})),schedule.tasks);
  const data=op.kind==='projectDates'?{id:project.id,startDate:expectedProjects.find(row=>Number(row.id)===id).startDate,endDate:expectedProjects.find(row=>Number(row.id)===id).endDate,tasks,changed}:{tasks,changed,...(op.kind==='projectTaskRemove'?{deleted:target}:{})};
  return {data,retained:{projectTasks:structuredClone(oldRows.filter(row=>Number(row.projectId)===id)),...(op.kind==='projectDates'?{project:structuredClone(project)}:{}),...(changedTarget?{createdOrEditedTaskId:changedTarget}:{})}};
}
function currentResult(db,auth,row,first,h,input){const id=row.retained?.projectTasks?.[0]?.projectId||row.retained?.project?.id||projectId(db,row.operation);const tasks=visible(db,auth.user,id,input),member=row.operation.kind==='projectTaskAssign'?(h.workspace(db,auth.user).team||[]).find(value=>Number(value.id)===row.operation.details.memberId):null;return {tasks,changed:[],receiptId:row.id,...(row.operation.kind==='projectTaskRemove'?{deleted:Number(row.operation.path.split('/')[3])}:{}),...(row.operation.kind==='projectDates'?dto.pick(db.projects.find(p=>Number(p.id)===Number(id)),['id','startDate','endDate']):{}),...(row.operation.kind==='projectTaskAssign'?{memberId:row.operation.details.memberId,...(first?dto.pick(row.result,['created','merged','skipped']):{}),...(member?{memberName:member.name}:{})}:{})};}
module.exports={route,parse,authorizeActor,authorize,validate,currentResult,prepareCandidate,graph,visible,task,projectId};
