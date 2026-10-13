'use strict';
// Exact newer schedule routes; no caller-selected method or capability grants.
const crypto=require('node:crypto');
const {canonicalHash}=require('./database/transactional-repository');
const {validateWorkspace}=require('./compat-workspace-evidence');
const access=require('./schedule-workflow-access');
const calendar=require('./schedule-availability');
const dto=require('./compat-workspace-projections');
const leave=require('./time-off-access');
const purpose='schedule-workflow-save-v1',previews='scheduleWorkflowPreviews',receipts='scheduleWorkflowReceipts';
const fail=(statusCode,message)=>{throw Object.assign(Error(message),{statusCode});};
const equal=(a,b)=>canonicalHash(a??null)===canonicalHash(b??null);
const object=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const id=v=>Number.isSafeInteger(v)&&v>0;
const iso=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const omit=(db,keys)=>Object.fromEntries(Object.entries(db).filter(([key])=>!keys.includes(key)));
function route(method,path){
  if(method==='POST'&&path==='/api/schedule/mark-off')return 'markOff';
  if(method==='POST'&&path==='/api/schedule/repeat-week')return 'repeatWeek';
  if(method==='POST'&&/^\/api\/assignments\/[1-9]\d*\/adopt-actual-times$/.test(path))return 'adoptActual';
  return null;
}
function parse(value){
  if(!object(value,['action','path','details'])||route('POST',value.path)!==value.action)fail(400,'Choose one supported scheduling workflow.');
  const d=value.details;
  if(value.action==='markOff'){
    if(!object(d,['memberId','date','reason','note','paid'])||!id(d.memberId)||!calendar.validDate(d.date)||!['sick','personal','no_work','other'].includes(d.reason)||typeof d.note!=='string'||d.note.length>500||typeof d.paid!=='boolean')fail(400,'Choose a person, work date, reason, bounded note and paid/unpaid status.');
  }else if(value.action==='repeatWeek'){
    if(!object(d,['targetStart','assignmentIds'])||!calendar.validDate(d.targetStart)||!Array.isArray(d.assignmentIds)||!d.assignmentIds.length||d.assignmentIds.length>200||d.assignmentIds.some(v=>!id(v))||new Set(d.assignmentIds).size!==d.assignmentIds.length)fail(400,'Choose a valid target week and unique current assignment IDs.');
  }else if(!object(d,[]))fail(400,'Actual times are derived from current authorized workdays.');
  return structuredClone(value);
}
function authorize(db,req,op,originalResult){
  const user=req.auth.user;
  if(!access.eligible(db,user)[op.action])fail(403,'This scheduling workflow is restricted by current permissions.');
  if(op.action==='markOff'){
    if(!access.memberScope(db,user,op.details.memberId))fail(404,'Scheduling person not found.');
  }else{
    const ids=op.action==='repeatWeek'?op.details.assignmentIds:[Number(op.path.split('/')[3])];
    for(const value of ids){const row=(db.assignments||[]).find(item=>item.id===value);if(!access.assignmentScope(db,user,row))fail(404,'Scheduling assignment not found.');}
    for(const row of originalResult?.createdRows||[])if(!access.assignmentScope(db,user,row))fail(404,'Saved scheduling assignment not found.');
  }
}
function projection(db,user){
  const workdays=(db.workdays||[]).filter(row=>access.sourceView(db,user,row));
  for(const row of workdays)if(!iso(row.startedAt)||row.endedAt!=null&&!iso(row.endedAt)||!['active','complete'].includes(row.status))fail(409,'Authorized workday timing needs reconciliation.');
  return {...db,assignments:(db.assignments||[]).filter(row=>access.assignmentScope(db,user,row)),workdays,timeCards:(db.timeCards||[]).filter(row=>access.memberScope(db,user,row.memberId)&&(user.role!=='project_manager'||(user.projectIds||[]).map(Number).includes(row.projectId))),timeOffRequests:(db.timeOffRequests||[]).filter(row=>access.memberScope(db,user,row.memberId))};
}
function resultDto(op,data,db,user){
  if(op.action==='markOff'){
    if(!access.memberScope(db,user,data.row?.memberId))fail(404,'Saved scheduling person not found.');
    const row=data.row;
    const overlapping=(db.assignments||[]).filter(item=>item.date===op.details.date&&item.memberIds.includes(op.details.memberId)&&access.assignmentScope(db,user,item)).length;
    return {row:leave.present(row),overlapping};
  }
  const present=row=>{if(!access.assignmentScope(db,user,row))fail(404,'Saved scheduling assignment not found.');return dto.assignment(row);};
  if(op.action==='adoptActual')return {assignment:present(data.assignment)};
  if(!Array.isArray(data.createdRows)||data.createdRows.length>100||!Array.isArray(data.skipped)||data.skipped.length>200)fail(409,'Repeated schedule result needs reconciliation.');
  return {created:data.createdRows.length,createdRows:data.createdRows.map(present),skipped:data.skipped.map(row=>{if(typeof row.reason!=='string'||row.reason.length>1000||row.date!==''&&!calendar.validDate(row.date)||typeof row.crew!=='string'||row.crew.length>500)fail(409,'Schedule skip needs reconciliation.');return {date:row.date,crew:row.crew,reason:row.reason};})};
}
function createHandler(h){
  const key=h.key;
  if(!Buffer.isBuffer(key)||key.length!==32)fail(503,'Scheduling workflow custody key required.');
  const seal=(kind,row)=>{const copy={...row};delete copy.proof;row.proof=crypto.createHmac('sha256',key).update(purpose+':'+kind+':'+canonicalHash(copy)).digest('hex');return row;};
  function ledger(db){
    for(const [name,kind]of[[previews,'preview'],[receipts,'receipt']]){
      const rows=Object.hasOwn(db,name)?db[name]:[],ids=new Set(),requests=new Set();
      if(!Array.isArray(rows)||rows.length>50000||Buffer.byteLength(JSON.stringify(rows))>8*1024*1024)fail(409,'Scheduling workflow history needs reconciliation.');
      for(const row of rows){
        const fields=['id','purpose','companyId','actorId','sessionHash','authority','operation','version','expectedRevision','createdAt','proof',...(kind==='preview'?['expiresAt','proposed']:['previewId','requestId','status','result'])];
        if(!object(row,fields)||!uuid(row.id)||ids.has(row.id)||row.purpose!==purpose||row.companyId!==db.company.id||!id(row.actorId)||![row.sessionHash,row.authority,row.version,row.proof].every(hash)||!Number.isSafeInteger(row.expectedRevision)||row.expectedRevision<1||!iso(row.createdAt))fail(409,'Scheduling workflow identity needs reconciliation.');
        const expected=seal(kind,{...row}).proof;if(!crypto.timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(row.proof,'hex')))fail(409,'Scheduling workflow custody needs reconciliation.');
        if(!equal(parse(row.operation),row.operation))fail(409,'Scheduling workflow operation needs reconciliation.');
        if(kind==='preview'){
          if(!iso(row.expiresAt)||Date.parse(row.expiresAt)<=Date.parse(row.createdAt)||Date.parse(row.expiresAt)>Date.parse(row.createdAt)+600000||!row.proposed||typeof row.proposed!=='object'||Array.isArray(row.proposed))fail(409,'Scheduling workflow preview needs reconciliation.');
        }else{
          if(!uuid(row.previewId)||!uuid(row.requestId)||requests.has(row.actorId+':'+row.requestId)||![200,201].includes(row.status)||!row.result||typeof row.result!=='object'||Array.isArray(row.result))fail(409,'Scheduling workflow receipt needs reconciliation.');
          const source=(db[previews]||[]).find(item=>item.id===row.previewId);if(!source||['companyId','actorId','sessionHash','authority','version','expectedRevision'].some(name=>source[name]!==row[name])||!equal(source.operation,row.operation))fail(409,'Scheduling workflow receipt linkage needs reconciliation.');
          requests.add(row.actorId+':'+row.requestId);
        }
        ids.add(row.id);
      }
    }
  }
  const version=(db,req)=>canonicalHash({source:omit(db,[previews,receipts]),authority:access.authority(db,req.auth)});
  async function execute(req,op){
    const before=h.readDb();authorize(before,req,op);
    let source=before;
    if(op.action==='adoptActual')source={...before,workdays:projection(before,req.auth.user).workdays};
    if(op.action==='repeatWeek')for(const value of op.details.assignmentIds){const row=before.assignments.find(item=>item.id===value),project=before.projects.find(item=>item.id===row.projectId);if(project.archived||project.archivedAt||row.memberIds.some(memberId=>{const member=before.team.find(item=>item.id===memberId);return member.archivedAt||member.archived||member.status==='Inactive';}))fail(409,'Archived projects or people cannot receive new assignments.');if(!calendar.validDate(row.date)||!calendar.validTime(row.start)||!calendar.validTime(row.end)||row.start>=row.end)fail(409,'Source schedule needs reconciliation.');}
    const ran=await h.run(req,{method:'POST',path:op.path,details:op.details},source);
    if(ran.response.status>=400)fail(ran.response.status,ran.response.data?.error||'Scheduling workflow unavailable.');
    const candidate=ran.candidate;
    if(op.action==='adoptActual'){
      if(!equal(candidate.workdays,source.workdays))fail(409,'Actual-time adoption cannot change workdays.');
      if(Object.hasOwn(before,'workdays'))candidate.workdays=before.workdays;else delete candidate.workdays;
    }
    const allowed=op.action==='markOff'?['timeOffRequests']:['assignments',...(op.action==='adoptActual'?['auditLog']:[])];
    if(!equal(omit(before,allowed),omit(candidate,allowed)))fail(409,'Unsupported compound scheduling change.');
    if(op.action==='adoptActual'){
      const target=Number(op.path.split('/')[3]);if(!equal(before.assignments.filter(row=>row.id!==target),candidate.assignments.filter(row=>row.id!==target)))fail(409,'Actual-time adoption changed another assignment.');
      const changed=!equal(before.assignments,candidate.assignments);
      if(changed){if(!equal((candidate.auditLog||[]).slice(0,-1),before.auditLog||[])||candidate.auditLog.at(-1)?.type!=='assignment_adopted_actual_times'||candidate.auditLog.at(-1)?.assignmentId!==target)fail(409,'Actual-time audit needs reconciliation.');candidate.auditLog.at(-1).actorId=req.auth.user.id;}else if(!equal(candidate.auditLog||[],before.auditLog||[]))fail(409,'Unchanged actual times cannot alter assignment history.');
    }else if(op.action==='repeatWeek'){
      if(!equal(candidate.assignments.slice(0,before.assignments.length),before.assignments))fail(409,'Repeat week changed existing assignments.');
    }else if(!equal((candidate.timeOffRequests||[]).slice(1),before.timeOffRequests||[])||candidate.timeOffRequests[0]?.memberId!==op.details.memberId||candidate.timeOffRequests[0]?.status!=='approved')fail(409,'Mark-off leave change needs reconciliation.');
    validateWorkspace(candidate);
    return {candidate,status:ran.response.status,data:resultDto(op,ran.response.data,candidate,req.auth.user)};
  }
  return {ledger,async handle(req,res,url){
    const preview=req.method==='POST'&&url.pathname==='/api/schedule/workflow-preview',action=route(req.method,url.pathname),live=req.method==='GET'&&url.pathname==='/api/schedule/today';
    if(!preview&&!action&&!live)return false;
    try{
      const db=h.readDb();ledger(db);await h.assertCurrent(req);if(url.search)fail(400,'This scheduling workflow accepts no query fields.');
      if(live){
        if(!access.eligible(db,req.auth.user).liveToday)fail(403,'Live schedule evidence is restricted by current permissions.');
        const source=projection(db,req.auth.user),ran=await h.run(req,{method:'GET',path:url.pathname},source);if(ran.dirty||ran.response.status!==200)fail(409,'Live schedule evidence needs reconciliation.');
        const data=ran.response.data;if(!object(data,['today','graceMinutes','assignments'])||!calendar.validDate(data.today)||!Number.isFinite(data.graceMinutes)||!data.assignments||typeof data.assignments!=='object'||Array.isArray(data.assignments))fail(409,'Live schedule result needs reconciliation.');
        const states={};for(const [key,row]of Object.entries(data.assignments)){
          const assignment=source.assignments.find(item=>item.id===Number(key));if(!assignment||String(assignment.id)!==key)fail(409,'Live assignment identity needs reconciliation.');
          const fields=['expected','onSite','active','done'];for(const name of fields)if(!Array.isArray(row[name])||new Set(row[name]).size!==row[name].length||row[name].some(value=>!id(value)||!assignment.memberIds.includes(value)))fail(409,'Live participant evidence needs reconciliation.');
          states[key]={...Object.fromEntries(fields.map(name=>[name,row[name]])),...dto.pick(row,['startMinutes','lateMinutes','elapsedMinutes','hours'])};
        }
        await h.assertCurrent(req);h.json(res,200,{today:data.today,graceMinutes:data.graceMinutes,assignments:states});return true;
      }
      const input=await h.body(req);
      if(preview){
        if(!object(input,['operation','expectedRevision'])||input.expectedRevision!==h.revision())fail(409,'Review current scheduling records first.');
        const op=parse(input.operation),proposed=await execute(req,op),at=Date.now();
        if(Buffer.byteLength(JSON.stringify(db[receipts]||[]))+Buffer.byteLength(JSON.stringify(proposed.data))+Buffer.byteLength(JSON.stringify(db[previews]||[]))+30000>8*1024*1024)fail(409,'Retained scheduling save capacity requires review.');
        const row=seal('preview',{id:crypto.randomUUID(),purpose,companyId:db.company.id,actorId:req.auth.user.id,sessionHash:req.auth.session.tokenHash,authority:access.authority(db,req.auth),operation:op,version:version(db,req),expectedRevision:h.revision()+1,createdAt:new Date(at).toISOString(),expiresAt:new Date(Math.min(at+600000,Date.parse(req.auth.session.expiresAt))).toISOString(),proposed:proposed.data});
        db[previews]||=[];db[previews].push(row);ledger(db);h.writeDb(db);h.json(res,200,{token:row.id,version:row.version,expiresAt:row.expiresAt,expectedRevision:row.expectedRevision,details:op.details,proposed:row.proposed});return true;
      }
      if(!object(input,['token','version','confirmed','requestId'])||!uuid(input.token)||!hash(input.version)||input.confirmed!==true||!uuid(input.requestId))fail(400,'Review a current preview and explicitly confirm this scheduling change.');
      const prior=(db[receipts]||[]).find(row=>row.actorId===req.auth.user.id&&row.requestId===input.requestId);
      if(prior){
        if(prior.previewId!==input.token||prior.version!==input.version||prior.sessionHash!==req.auth.session.tokenHash||prior.authority!==access.authority(db,req.auth)||prior.operation.path!==url.pathname)fail(409,'The original scheduling identity or permissions changed.');
        authorize(db,req,prior.operation,prior.result);if(prior.operation.action!=='markOff')resultDto(prior.operation,prior.result,db,req.auth.user);h.json(res,prior.status,{...structuredClone(prior.result),originalSaveResult:true});return true;
      }
      const row=(db[previews]||[]).find(item=>item.id===input.token);
      if(!row||row.version!==input.version||row.actorId!==req.auth.user.id||row.sessionHash!==req.auth.session.tokenHash||row.authority!==access.authority(db,req.auth)||row.operation.path!==url.pathname||row.expectedRevision!==h.revision()||row.version!==version(db,req)||Date.parse(row.expiresAt)<=Date.now()||(db[receipts]||[]).some(item=>item.previewId===row.id))fail(409,'Scheduling records changed. Review a fresh preview.');
      h.guardDeadline(row.expiresAt);const saved=await execute(req,row.operation);await h.assertCurrent(req);
      if(row.operation.action==='repeatWeek'&&saved.data.createdRows.length){h.stageAssignments?.(saved.candidate,req,saved.data.createdRows.map(item=>item.id));saved.data=resultDto(row.operation,saved.data,saved.candidate,req.auth.user);}
      saved.candidate.auditLog||=[];saved.candidate.auditLog.push({id:crypto.randomUUID(),type:'schedule_workflow_confirmed',actorId:req.auth.user.id,actor:req.auth.user.name,action:row.operation.action,requestId:input.requestId,previewId:row.id,at:new Date().toISOString()});
      saved.candidate[receipts]||=[];saved.candidate[receipts].push(seal('receipt',{id:crypto.randomUUID(),purpose,companyId:db.company.id,actorId:req.auth.user.id,sessionHash:req.auth.session.tokenHash,authority:row.authority,operation:row.operation,version:row.version,expectedRevision:row.expectedRevision,createdAt:new Date().toISOString(),previewId:row.id,requestId:input.requestId,status:saved.status,result:saved.data}));
      ledger(saved.candidate);h.writeDb(saved.candidate);h.json(res,saved.status,saved.data);return true;
    }catch(error){if(![400,401,402,403,404,409,503].includes(error.statusCode))throw error;h.json(res,error.statusCode,{error:error.message});return true;}
  }};
}
module.exports={route,parse,createHandler,previews,receipts};
