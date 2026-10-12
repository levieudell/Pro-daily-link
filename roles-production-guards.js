'use strict';
// A finite map to existing typed controllers. Route names and policy keys are
// code, never supplied by the client or interpreted as generic grant flags.
const registry=require('./capability-registry');
const profiles=require('./role-profiles');
const scheduling=require('./scheduling-access');
const workflows=require('./schedule-workflow-access');
const daily=require('./daily-access');
const review=require('./time-review-access');
const time=require('./time-write-access');
const leave=require('./time-off-access');
const notes=require('./notes-access');
const {canonicalHash}=require('./database/transactional-repository');
const fail=(statusCode,message)=>{throw Object.assign(Error(message),{statusCode});};
const family=id=>registry.families.find(row=>row[0]===id)[4];
const restricted=(db,id)=>family(id).required(db)||profiles.required(db);
const anyPolicy=db=>registry.families.some(([id])=>restricted(db,id));
function controlled(db,id,action){return restricted(db,id)||id==='timeWrite'&&action!=='viewActivities'&&restricted(db,'timeReview')||id==='timeReview'&&action==='reviewLeave'&&restricted(db,'timeOff')||id==='daily'&&action==='runWorkdays'&&db.company.features?.timeCards===true&&(restricted(db,'timeWrite')||restricted(db,'timeReview'));}
function permit(db,user,id,action){if(controlled(db,id,action)&&family(id).access(db,user)[action]!==true)fail(403,'This action is restricted for your role.');}
function one(rows,id,name){const matches=(rows||[]).filter(row=>String(row.id)===String(id));if(matches.length!==1)fail(matches.length?409:404,name+' not found');return matches[0];}
function noteRoute(path){return /^\/api\/projects\/([1-9]\d*)\/notes-todos(?:\/([^/]+))?$/.exec(path);}
async function guard(req,url,db,h){
  const user=req.auth.user,path=url.pathname,method=req.method;
  await require('./roles-daily-baseline').guard(req,url,db,h);
  const event=require('./project-events-access').route(method,path);
  if(event){
    const operation=require('./project-events-access').parse(event,await h.body(req),req.headers?.['x-pdl-event-version']);
    require('./project-events-access').authorize(db,user,operation);
    req.rolesProjectEvent=operation;
  }
  const plainAssignment=/^\/api\/assignments(?:\/([1-9]\d*)(?:\/(acknowledge))?)?$/.exec(path);
  if(plainAssignment&&['GET','POST','PATCH','DELETE'].includes(method)){
    const input=method==='GET'?{}:await h.body(req);
    if(method==='POST'&&!plainAssignment[1]&&input&&input.requestId===undefined)input.requestId=req.headers?.['x-pdl-operation']||h.context?.()?.rolesOperationId||require('node:crypto').randomUUID();
    const result=require('./scheduling-route-guard').guard(db,user,method,url,input||{});
    if(result)fail(result.status,result.error);
    if(method!=='GET')req.rolesPlainScheduling={action:plainAssignment[2]?'acknowledge':method==='POST'?'create':method==='PATCH'?'edit':'remove',id:plainAssignment[1]?Number(plainAssignment[1]):null,input:input||{}};
  }
  if(method==='POST'&&/^\/api\/projects\/[1-9]\d*\/assistant\/confirm$/.test(path))assistantReplay(db,user,await h.body(req),Number(path.split('/')[3]));
  if(method==='POST'&&/^\/api\/projects\/[1-9]\d*\/assistant\/chat$/.test(path)){
    const input=await h.body(req),kind=input?.action||'schedule';
    if(['schedule','schedule_batch','note','todo'].includes(kind)&&!require('./project-assistant').allowed(db,user,Number(path.split('/')[3]),null,kind))fail(403,'Current assistant action permission required');
  }
  if(method==='POST'&&path==='/api/assistant/interpret'){
    const input=await h.body(req);let prior=null;
    // Untrusted state may only reduce admission here. The intent service still
    // verifies its signature, actor, expiry and schema before using it.
    if(typeof input?.state==='string'&&input.state.length<=24000)try{prior=JSON.parse(Buffer.from(input.state.split('.')[0],'base64url'));}catch{}
    const kind=input?.draft?.action||prior?.draft?.action,projectId=prior?.projectId??input?.projectId;
    if(['schedule','schedule_batch','note','todo'].includes(kind)){
      const candidates=projectId==null?(db.projects||[]).map(row=>row.id):[projectId];
      if(!candidates.some(id=>require('./project-assistant').allowed(db,user,id,null,kind)))fail(403,'Current assistant action permission required');
    }
  }
  const submit=/^\/api\/changes\/([1-9]\d*)\/submit$/.exec(path);
  if(method==='POST'&&submit){
    if(!['owner','admin','project_manager'].includes(user.role)||typeof h.canViewPricing!=='function'||!h.canViewPricing(db,user))fail(403,'Existing pricing permission is required to share a change document.');
    const change=one(db.changes,submit[1],'Change');if(!changeVisible(db,user,change))fail(404,'Change not found');
    for(const row of (db.photos||[]).filter(photo=>Number(photo.changeId)===change.id))if(!require('./protected-assets-admission').authorized(db,user,{kind:'photo',row,projectId:db.projects[row.project]?.id??row.projectId},h))fail(404,'Change photo not found');
  }
  if(['POST','PATCH'].includes(method)&&(path==='/api/reports'||/^\/api\/reports\/[1-9]\d*$/.test(path))){
    const reportBody=await h.body(req);if(Object.hasOwn(reportBody||{},'extracted'))require('./roles-report-intake').validateExtracted(reportBody.extracted);
  }
  if(!anyPolicy(db))return;
  const data=['POST','PATCH','PUT','DELETE'].includes(method)?await h.body(req):null;
  if(data!==null)req.rolesBody=data;
  const change=/^\/api\/changes\/([1-9]\d*)$/.exec(path);
  if(change&&!changeVisible(db,user,one(db.changes,change[1],'Change')))fail(404,'Change not found');
  if(method==='PATCH'&&/^\/api\/users\/[1-9]\d*$/.test(path)&&Object.hasOwn(data,'role')&&profiles.required(db)){
    const target=one(db.users,path.split('/')[3],'Account'),model=profiles.validateModel(db.company.roleProfiles);
    if(model.assignments.some(row=>row.accountId===target.id)&&(data.role==='office'?'admin':data.role)!==(target.role==='office'?'admin':target.role))fail(409,'Remove the assigned profile before changing its base role');
  }
  const schedule=/^\/api\/assignments(?:\/([1-9]\d*)(?:\/(acknowledge))?)?$/.exec(path);
  if(schedule&&restricted(db,'scheduling')){
    const action=method==='GET'?'view':schedule[2]?'acknowledge':method==='POST'?'create':method==='PATCH'?'edit':'remove';
    permit(db,user,'scheduling',action);
    if(schedule[1]&&!scheduling.inScope(db,user,one(db.assignments,schedule[1],'Assignment'),action))fail(404,'Assignment not found');
    if(method==='POST'&&!schedule[1]&&!scheduling.inScope(db,user,data,action))fail(403,'Assigned project and entire crew scope required');
    if(method==='PATCH'){
      const original=one(db.assignments,schedule[1],'Assignment');
      const target=data.edit===true?{projectId:data.projectId,memberIds:data.memberIds}:{projectId:original.projectId,memberIds:[data.targetMemberId]};
      if(!scheduling.inScope(db,user,target,action))fail(403,'Assigned destination project and crew required');
    }
  }
  if(method==='GET'&&path==='/api/schedule-availability')permit(db,user,'scheduling','view');
  const workflow={'/api/schedule/today':'liveToday','/api/schedule/mark-off':'markOff','/api/schedule/repeat-week':'repeatWeek'}[path]||(/^\/api\/assignments\/[1-9]\d*\/adopt-actual-times$/.test(path)?'adoptActual':null);
  if(workflow&&!workflows.eligible(db,user)[workflow])fail(403,'This scheduling workflow is restricted for your role.');
  const task=require('./resource-project-tasks').route(method,path);
  if(task&&restricted(db,'scheduling')){
    const action={projectTasksView:'view',projectTaskCreate:'create',projectTaskEdit:'edit',projectTaskRemove:'remove',projectDates:'edit',projectTaskAssign:'view'}[task];
    if(task!=='projectDates'||Object.hasOwn(data||{},'startDate')||Object.hasOwn(data||{},'endDate'))permit(db,user,'scheduling',action);
    if(task!=='projectDates'||Object.hasOwn(data||{},'startDate')||Object.hasOwn(data||{},'endDate')){
      const module=require('./resource-project-tasks'),input=require('./resource-inputs'),details=task==='projectDates'?Object.fromEntries(['startDate','endDate'].filter(key=>Object.hasOwn(data,key)).map(key=>[key,data[key]])):data||{};
      const op=module.parse({kind:task,method,path,details},input);req.rolesTask=op;
      if(task==='projectTaskAssign'){
        module.authorizeActor(req.auth,op,input);module.graph(db,input);const id=module.projectId(db,op),row=one(db.projectTasks,path.split('/')[3],'Task');
        if(!hProject(db,user,id)||!taskScope(db,user,row)||!taskScope(db,user,{projectId:id,memberIds:[op.details.memberId],crew:''}))fail(403,'Assigned task project and entire crew scope required');
      }else module.authorize(db,req.auth,op,h,input);
    }
  }
  if(/^\/api\/time-off-requests(?:\/[^/]+)?$/.test(path))permit(db,user,'timeOff',method==='GET'?'viewRequests':'createRequest');
  if(/^\/api\/time-off-requests\/[^/]+\/(approve|decline)$/.test(path)){
    permit(db,user,'timeOff','viewRequests');permit(db,user,'timeReview','reviewLeave');
    const row=one(db.timeOffRequests,path.split('/')[3],'Time off request');
    if(restricted(db,'timeReview')&&!review.leaveInScope(db,user,row))fail(404,'Time off request not found');
  }
  if(path==='/api/time-cards.csv')permit(db,user,'timeWrite','downloadCards');
  const card=/^\/api\/time-cards(?:\/([1-9]\d*)(?:\/(submit|approve|unapprove|clock-out))?)?$/.exec(path);
  if(card){
    const permission=method==='GET'?['timeReview','viewCards']:card[2]==='approve'?['timeReview','approveCards']:card[2]==='unapprove'?['timeReview','unapproveCards']:card[2]==='submit'?['timeWrite','submitCards']:card[2]==='clock-out'?['timeWrite','clockCards']:method==='POST'?['timeWrite','createCards']:method==='DELETE'?['timeWrite','removeCards']:['timeWrite','correctCards'];
    permit(db,user,...permission);
    if(card[1]&&restricted(db,permission[0])){const row=one(db.timeCards,card[1],'Time card');if(!(permission[0]==='timeWrite'?time.inScope(db,user,row,permission[1]):review.cardInScope(db,user,row,permission[1])))fail(404,'Time card not found');}
  }
  if(path==='/api/time-cards/approve'){permit(db,user,'timeReview','approveCards');if(restricted(db,'timeReview'))for(const id of data.ids||[])if(!review.cardInScope(db,user,one(db.timeCards,id,'Time card'),'approveCards'))fail(404,'Time card not found');}
  if(path==='/api/time-cards/company-clock')permit(db,user,'timeWrite','clockCards');
  if(path==='/api/company-activities'&&method==='GET')permit(db,user,'timeWrite','viewActivities');
  if(path.startsWith('/api/pay-periods')){
    permit(db,user,'timeWrite','viewPayroll');
    if(method==='POST'&&/\/exports$/.test(path))permit(db,user,'timeWrite','captureExports');
    else if(method==='POST'||method==='PATCH')permit(db,user,'timeWrite','configurePeriods');
    if(method==='GET'&&/\/exports(?:\/[^/]+)?(?:\.csv)?$/.test(path))permit(db,user,'timeWrite','downloadExports');
  }
  const report=/^\/api\/reports(?:\/([1-9]\d*)(?:\/(approve|disposition|safety|rate))?)?$/.exec(path);
  if(report){
    const action=method==='GET'?'viewReports':report[2]==='approve'?'approveReports':method==='POST'&&!report[1]?'createReports':'editReports';
    permit(db,user,'daily',action);
    if(report[1]&&restricted(db,'daily')){
      const row=one(db.reports,report[1],'Report');if(!daily.reportInScope(db,user,row,action))fail(404,'Report not found');
      if(method!=='GET'&&(row.status==='Approved'||report[2]==='rate'&&(row.rateSnapshot||row.rateReview||(row.history||[]).some(item=>item.action==='Approved'))))permit(db,user,'daily','approveReports');
    }
    if(method==='POST'&&!report[1]&&restricted(db,'daily')){
      const projectId=data.projectId??db.projects?.[Number(data.project)]?.id;
      if(!daily.projectAllowed(db,user,projectId)||(data.laborEntries||[]).some(row=>!daily.memberAllowed(db,user,row.memberId)))fail(403,'Assigned project and entire crew scope required');
    }
    if(['POST','PATCH'].includes(method)&&!report[2]&&data.extracted){
      require('./roles-report-intake').validateExtracted(data.extracted);
    }
  }
  const day=/^\/api\/workdays(?:\/([1-9]\d*)(?:\/(end))?|\/(start))?$/.exec(path);
  if(day){
    const action=method==='GET'?'viewWorkdays':'runWorkdays';permit(db,user,'daily',action);
    // daily.runWorkdays already retains the existing field clock and office
    // create/correct dependencies. Owner's office ceiling has no clock grant.
    if(day[1]&&controlled(db,'daily',action)&&!daily.workdayInScope(db,user,one(db.workdays,day[1],'Workday'),action))fail(404,'Workday not found');
    if(day[3]&&controlled(db,'daily',action)&&(!daily.projectAllowed(db,user,data.projectId)||(data.memberIds||[]).some(id=>!daily.memberAllowed(db,user,id))))fail(403,'Assigned project and entire crew scope required');
    if(method==='POST'&&(controlled(db,'daily','runWorkdays')||day[2]&&db.company.autoAdoptActualTimes===true&&restricted(db,'scheduling'))){req.rolesDay=require('./daily-admission').parse({action:day[3]?'startWorkday':'endWorkday',...(day[1]?{id:day[1]}:{}),details:data});require('./daily-admission').authorize(db,user,req.rolesDay);}
    if(day[2]&&db.company.autoAdoptActualTimes===true&&!workflows.derivedRestriction(db,user,'scheduling','edit'))fail(403,'Automatic schedule adoption is restricted for your role.');
  }
  const note=noteRoute(path);
  if(note){
    permit(db,user,'notes','view');if(method==='POST')permit(db,user,'notes','create');
    if(method==='PATCH'){if(Object.hasOwn(data,'text')||Object.hasOwn(data,'dueDate'))permit(db,user,'notes','edit');if(Object.hasOwn(data,'completed'))permit(db,user,'notes','complete');}
    if(restricted(db,'notes')&&!notes.projectAllowed(db,user,Number(note[1]),h.canAccessProject))fail(404,'Project not found');
  }
  if(path==='/api/photos'&&method==='POST'||/^\/api\/photos\/\d+$/.test(path)&&method==='PATCH'){
    permit(db,user,'daily',method==='POST'?'createReports':'editReports');
    if(restricted(db,'daily')){
      const original=method==='PATCH'?one(db.photos,path.split('/')[3],'Photo'):null;
      const target={...original,...data};
      for(const row of [original,target].filter(Boolean)){
        const projectId=row.projectId??db.projects?.[Number(row.project)]?.id;if(!daily.projectAllowed(db,user,projectId))fail(404,'Photo project not found');
        if(row.reportId!=null){permit(db,user,'daily','editReports');const source=one(db.reports,row.reportId,'Report');if(db.projects[source.project]?.id!==projectId||!daily.reportInScope(db,user,source,'editReports'))fail(404,'Report not found');if(source.status==='Approved')permit(db,user,'daily','approveReports');}
        if(row.changeId!=null){const change=one(db.changes,row.changeId,'Change');if(change.projectId!==projectId||!changeVisible(db,user,change))fail(404,'Change not found');}
        if(row.workdayId!=null){const source=one(db.workdays,row.workdayId,'Workday');if(source.projectId!==projectId||!daily.workdayInScope(db,user,source,'runWorkdays')||row.reportId!=null&&(source.reportId!=null&&Number(source.reportId)!==Number(row.reportId)||one(db.reports,row.reportId,'Report').workdayId!=null&&Number(one(db.reports,row.reportId,'Report').workdayId)!==Number(source.id)))fail(404,'Workday not found');}
      }
      if(method==='POST')validatePhotoFiles(data.files);
    }
  }
  if(path==='/api/ai/extract'){
    permit(db,user,'daily','createReports');
    if(restricted(db,'daily')){const project=one(db.projects,data.projectId,'Project');if(!daily.projectAllowed(db,user,project.id))fail(404,'Project not found');if(data.reportId!=null&&!daily.reportInScope(db,user,one(db.reports,data.reportId,'Report'),'editReports'))fail(404,'Report not found');const expected=(project.estimateItems||[]).map(({id,name,unit})=>({id,name,unit}));if(canonicalHash(expected)!==canonicalHash(data.estimateItems||[]))fail(400,'Use the current selected project scope');}
  }
  if(['/api/production','/api/insights','/api/exceptions'].includes(path)||/^\/api\/projects\/\d+\/tm-summary$/.test(path)||path==='/api/report-labor-suggestions')permit(db,user,'daily','viewReports');
  if(path==='/api/report-labor-suggestions')permit(db,user,'timeReview','viewCards');
  if(require('./protected-assets-admission').route(method,path)){
    const where=require('./protected-assets-admission').location(url,db.company.id),refs=require('./protected-assets-admission').references(db,where);
    // Every live reference must authorize the same bytes. An allowed alias
    // cannot expose a denied report, workday or project alias.
    if(refs.length&&refs.some(ref=>!require('./protected-assets-admission').authorized(db,user,ref,h)))fail(404,'File not found');
    if(refs.some(ref=>ref.kind==='photo'&&ref.row.changeId!=null&&!changeVisible(db,user,one(db.changes,ref.row.changeId,'Change'))))fail(404,'File not found');
  }
}
function validatePhotoFiles(files){
  if(!Array.isArray(files)||files.length<1||files.length>8)fail(400,'Choose one to eight photos');
  const types={'image/jpeg':bytes=>bytes[0]===255&&bytes[1]===216&&bytes[2]===255,'image/png':bytes=>bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'image/webp':bytes=>bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'};
  for(const file of files){const match=typeof file?.data==='string'&&/^data:([^;]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(file.data);if(!match||!types[file.type]||match[1]!==file.type||match[2].length>8000000)fail(400,'Choose valid bounded image bytes');const bytes=Buffer.from(match[2],'base64');if(bytes.length<12||bytes.length>6000000||bytes.toString('base64')!==match[2]||!types[file.type](bytes))fail(400,'Photo content does not match its declared type');}
}
function assistantReplay(db,user,input,projectId){
  if(typeof input?.token!=='string'||input.token.length>32768)return;
  let token;try{token=JSON.parse(Buffer.from(input.token.split('.')[0],'base64url'));}catch{return;}
  if(!token||Object.keys(token).sort().join(',')!=='companyId,expiresAt,id,input,projectId,userId,version'||token.companyId!==db.company.id||token.userId!==user.id||token.projectId!==projectId||token.version!==input.version||!Number.isFinite(token.expiresAt)||!token.input||typeof token.input!=='object'||Array.isArray(token.input))fail(409,'Original assistant proof binding needs reconciliation');
  const hash=require('node:crypto').createHash('sha256').update(JSON.stringify(input.token)).digest('hex'),kind=token.input.action||'schedule';
  const matches=(db.assistantConfirmations||[]).filter(row=>row?.id===token.id||row?.tokenHash===hash);if(matches.length>1)fail(409,'Original assistant receipt identity is ambiguous');
  for(const receipt of db.assistantConfirmations||[]){if(receipt?.id!==token?.id&&receipt?.tokenHash!==hash)continue;
    if(receipt.companyId!==db.company.id||receipt.userId!==user.id||receipt.projectId!==projectId||receipt.version!==input.version||receipt.tokenHash!==hash||(receipt.resourceKind||'schedule')!==kind)fail(409,'Original assistant receipt needs reconciliation');
    if(['note','todo'].includes(kind)){notes.validateReceipt(db,receipt,user,projectId,{tokenHash:hash,version:input.version});if(!require('./project-assistant').allowed(db,user,projectId,null,kind))fail(403,'Current assistant note permission required');}
    else if(kind==='schedule'||kind==='schedule_batch'){
      const ids=kind==='schedule'?[receipt.assignmentId]:receipt.assignmentIds,members=kind==='schedule'?[receipt.memberId]:receipt.memberIds;
      if(!Array.isArray(ids)||!ids.length||ids.some(id=>!Number.isSafeInteger(id)||id<1)||new Set(ids).size!==ids.length||!Array.isArray(members)||!members.length||members.some(id=>!Number.isSafeInteger(id)||id<1))fail(409,'Original assistant assignment receipt needs reconciliation');
      const originalMembers=kind==='schedule'?[token.input.memberId]:token.input.memberIds;
      if(canonicalHash(members)!==canonicalHash(originalMembers))fail(409,'Original assistant crew binding changed');
      const expanded=kind==='schedule_batch'?require('./project-assistant-batch').expandBatch(token.input):{dates:[token.input.date]};if(expanded.error||ids.length!==expanded.dates.length)fail(409,'Original assistant date binding changed');const seen=new Set();
      for(const id of ids){const row=one(db.assignments,id,'Assignment');if(row.projectId!==projectId||canonicalHash(row.memberIds)!==canonicalHash(members)||!row.memberIds.every(id=>require('./project-assistant').allowed(db,user,projectId,id,kind))||row.source!=='project_assistant'||row.createdByUserId!==user.id||row.start!==token.input.start||row.end!==token.input.end||row.activity!==token.input.activity||String(row.instructions||'')!==String(token.input.instructions||'')||!expanded.dates.includes(row.date)||seen.has(row.date))fail(409,'Original assistant target changed');seen.add(row.date);}
    }else fail(409,'Unsupported assistant receipt kind');
  }
}
function projectResponse(req,url,db,data,h){
  if(data===undefined||data===null||!req.auth)return data;
  const user=req.auth.user,path=url.pathname;
  if(path==='/api/auth/me')return {...data,permissions:user.permissions||{},schedulingAccess:scheduling.access(db,user)};
  if(path==='/api/state')data={...data,projectEvents:require('./project-events-access').visible(db,user),currentUser:{...data.currentUser,schedulingAccess:scheduling.access(db,user)}};
  if(!anyPolicy(db))return data;
  const gates=registry.effective(db,user),copy=structuredClone(data);
  if(path==='/api/action-center'&&restricted(db,'daily')&&!gates.daily.viewReports){if(Array.isArray(copy))return copy.filter(row=>row.type!=='project_risk');if(Array.isArray(copy.items))copy.items=copy.items.filter(row=>row.type!=='project_risk');return copy;}
  if(path==='/api/state'){
    const dto=require('./compat-workspace-projections'),result=dto.bootstrap(db,user,h),view=readView(db,user,h),pricing=h.canViewPricing(db,user);
    // Keep the product's existing immutable modules through finite projections.
    result.crews=(copy.crews||[]).map(row=>({...dto.pick(row,['id','name','status','createdAt','updatedAt']),memberIds:(row.memberIds||[]).filter(id=>view.team.some(member=>member.id===id))}));
    result.catalog=(copy.catalog||[]).map(row=>dto.pick(row,['id','name','category','unit','targetHoursPerUnit','productionRate','notes']));
    // Main ships finite summaries, not raw change records. Recompute over the
    // same current source scope as change reads; precomputed totals can expose
    // hidden report-derived facts even when all money is null.
    result.projectChanges=changeSummaries(db,user,h);delete result.changes;
    result.photos=result.photos.filter(row=>view.photos.some(photo=>photo.id===row.id)).map(row=>{const source=view.photos.find(photo=>photo.id===row.id);return source?.changeId!=null?{...row,changeId:source.changeId}:row;});
    if(gates.timeReview.viewCards)result.timeCards=view.timeCards.map(row=>require('./time-review-admission').cardProjection(row));
    if(gates.timeOff.viewRequests&&copy.timeOffRequests)result.timeOffRequests=copy.timeOffRequests.filter(row=>leave.inScope(db,user,row)).map(leave.present);
    result.projects=result.projects.map(row=>{const source=view.projects.find(project=>project.id===row.id);if(restricted(db,'daily')){if(!gates.daily.viewReports){delete row.progress;delete row.production;}else if(source){Object.assign(row,metrics(view,source));}}return row;});
    result.team=result.team.map(row=>{if(restricted(db,'timeReview')){if(!gates.timeReview.viewCards)delete row.hours;else row.hours=view.timeCards.filter(card=>card.memberId===row.id).reduce((sum,card)=>sum+(Number(card.hours)||0),0);}return row;});
    result.projectEvents=require('./project-events-access').visible(db,user);
    result.currentUser={...result.currentUser,accessRole:user.role};return result;
  }
  const dto=require('./compat-workspace-projections');
  if(path==='/api/users'&&Array.isArray(copy))return copy.map(row=>dto.account(row));
  if(path==='/api/audit-log')return dto.auditRows(db,user,h).reverse();
  if(path==='/api/schedule-availability'&&restricted(db,'timeOff')&&!gates.timeOff.viewRequests)return [];
  const task=require('./resource-project-tasks').route(req.method,path);
  if(task&&restricted(db,'scheduling')&&(task!=='projectDates'||req.rolesTask)){
    const tasks=require('./resource-project-tasks'),id=tasks.projectId(db,{kind:task,path});
    const visible=tasks.visible(db,user,id,require('./resource-inputs'));
    return Array.isArray(copy)?visible:{...copy,tasks:visible};
  }
  if((path==='/api/changes'||path==='/api/changes/mine')&&Array.isArray(copy))return copy.filter(row=>changeVisible(db,user,one(db.changes,row.id,'Change'))).map(row=>path.endsWith('/mine')?dto.pick(row,['id','number','title','status','flagDate','createdAt']):changeProjection(db,user,row,h));
  if(/^\/api\/changes\/[1-9]\d*$/.test(path)&&copy.id!=null)return changeProjection(db,user,copy,h);
  if(path.startsWith('/api/pay-periods')){
    const payroll=require('./time-write-admission');
    if(/\/exports/.test(path))return Array.isArray(copy)?copy.map(payroll.exportProjection):payroll.exportProjection(copy);
    if(/\/summary$/.test(path))return payroll.summaryProjection(copy);
    if(Array.isArray(copy.periods))return {canConfigure:gates.timeWrite.configurePeriods,periods:copy.periods.map(payroll.periodProjection)};
    return payroll.periodProjection(copy);
  }
  if(path==='/api/assignments'&&Array.isArray(copy)&&restricted(db,'scheduling'))return copy.filter(row=>scheduling.inScope(db,user,row,'view'));
  if(/^\/api\/reports(?:\/|$)/.test(path)){
    const present=row=>require('./daily-admission').reportProjection(db,user,one(db.reports,row.id,'Report'),h.presentReport,false);
    if(Array.isArray(copy))return copy.filter(row=>daily.reportInScope(db,user,(db.reports||[]).find(value=>Number(value.id)===Number(row.id)))).map(present);
    if(copy.id!=null)return present(copy);
  }
  if(path==='/api/workdays'&&Array.isArray(copy)&&restricted(db,'daily'))return copy.filter(row=>daily.workdayInScope(db,user,row));
  if(path==='/api/time-cards'&&Array.isArray(copy)&&restricted(db,'timeReview'))return copy.filter(row=>review.cardInScope(db,user,row));
  return copy;
}
function changeVisible(db,user,row){
  if(!row||row.companyId!==undefined&&row.companyId!==db.company.id||!Number.isSafeInteger(row.projectId)||!(db.projects||[]).some(project=>project.id===row.projectId))fail(409,'Change project source needs reconciliation');
  if(!hProject(db,user,row.projectId))return false;
  if(row.reportId!=null&&(!Number.isSafeInteger(Number(row.reportId))||Number(row.reportId)<1))fail(409,'Change report source needs reconciliation');
  const references=(db.reports||[]).filter(report=>Number(report.id)===Number(row.reportId)||(report.flags||[]).some(flag=>Number(flag.resolution?.changeId)===Number(row.id)));
  if(references.some(report=>db.projects[report.project]?.id!==row.projectId))fail(409,'Change report/project binding needs reconciliation');
  if(restricted(db,'daily')&&(row.reportId!=null||references.length)){
    if(!daily.access(db,user).viewReports)return false;
    // Legacy report/change IDs have no immutable lifecycle identity. Under a
    // restriction, current numeric-ID equality cannot prove a PM's original
    // source crew after deletion/reuse. Office archival authority stays fixed.
    if(user.role==='project_manager')return false;
  }
  return references.every(report=>!restricted(db,'daily')||daily.reportInScope(db,user,report));
}
function changeSummaries(db,user,h){
  if(!['owner','admin','project_manager'].includes(user.role))return [];
  if(typeof h.canViewPricing!=='function')fail(503,'Existing pricing helper required');
  const groups=new Map(),pricing=h.canViewPricing(db,user);
  for(const change of db.changes||[]){
    if(!changeVisible(db,user,change))continue;
    if(!['Potential','Pricing','Submitted','Approved','Rejected','Void','T&M'].includes(change.status))fail(409,'Change summary status needs reconciliation');
    const id=change.projectId,amount=change.amount==null?0:Number(change.amount);
    if(!Number.isFinite(amount)||amount<0||amount>1e12)fail(409,'Change summary amount needs reconciliation');
    const row=groups.get(id)||{projectId:id,awaitingDecision:0,openItems:0,approvedCount:0,openExposure:pricing?0:null,approvedTotal:pricing?0:null};
    if(change.status==='Submitted')row.awaitingDecision++;
    if(['Potential','Pricing','Submitted','T&M'].includes(change.status)){row.openItems++;if(pricing)row.openExposure+=amount;}
    if(change.status==='Approved'){row.approvedCount++;if(pricing)row.approvedTotal+=amount;}
    if(pricing&&(!Number.isFinite(row.openExposure)||!Number.isFinite(row.approvedTotal)||row.openExposure>1e12||row.approvedTotal>1e12))fail(409,'Change summary total needs reconciliation');
    groups.set(id,row);
  }
  return [...groups.values()];
}
function changeProjection(db,user,row,h){
  const dto=require('./compat-workspace-projections'),pricing=h.canViewPricing(db,user);
  const result=dto.pick(row,['id','number','projectId','reportId','title','description','detail','reason','status','fieldFlag','flagDate','quantity','unit','hours','createdAt','updatedAt','createdBy','date','submittedAt','decidedAt','decidedBy']);
  if(pricing)Object.assign(result,dto.pick(row,['amount','rate','pricingType']));
  result.lines=(row.lines||[]).map(line=>({...dto.pick(line,['description','quantity','unit','laborHours']),...(pricing?dto.pick(line,['materialCost']):{})}));
  result.history=(row.history||[]).map(entry=>({...dto.pick(entry,['by','at']),action:pricing?String(entry.action||'Reviewed'):'Reviewed'}));
  result.photoIds=(row.photoIds||[]).filter(id=>(db.photos||[]).some(photo=>photo.id===id&&require('./protected-assets-admission').authorized(db,user,{kind:'photo',row:photo,projectId:db.projects[photo.project]?.id??photo.projectId},h)));
  return result;
}
function hProject(db,user,id){return ['owner','admin'].includes(user.role)||daily.projectAllowed(db,user,id);}
function taskScope(db,user,row){
  if(!row||!hProject(db,user,row.projectId))return false;if(user.role!=='project_manager')return true;
  const crews=new Set((user.assignedCrews||[]).map(name=>String(name).trim().toLowerCase()));
  return (!row.crew||crews.has(String(row.crew).trim().toLowerCase()))&&(row.memberIds||[]).every(id=>crews.has(String(db.team.find(member=>member.id===id)?.crew||'').trim().toLowerCase()));
}
function metrics(db,project){
  const index=db.projects.findIndex(row=>row.id===project.id),approved=(db.reports||[]).filter(row=>row.project===index&&row.status==='Approved');let weighted=0,total=0;
  for(const item of project.estimateItems||[]){const planned=Number(item.plannedQuantity)||0,weight=Number(item.cost)||Number(item.budgetHours)||1;if(planned>0){const actual=approved.flatMap(row=>row.productionEntries||[]).filter(row=>row.estimateItemId===item.id).reduce((sum,row)=>sum+(Number(row.quantity)||0),0);weighted+=actual/planned*100*weight;total+=weight;}}
  const production=total?Math.round(weighted/total*10)/10:0;return {production,progress:Math.min(100,Math.round(production))};
}
function readView(db,user,h){
  if(!anyPolicy(db))return db;
  const result=structuredClone(db),workspace=h.workspace(db,user),ids=new Set(workspace.projects.map(row=>row.id)),indexMap=new Map();
  result.projects=(db.projects||[]).filter((row,index)=>{if(!ids.has(row.id))return false;indexMap.set(index,indexMap.size);return true;}).map(row=>structuredClone(row));
  const reports=new Set((workspace.reports||[]).map(row=>row.id)),days=new Set((workspace.workdays||[]).map(row=>row.id));
  result.reports=(db.reports||[]).filter(row=>reports.has(row.id)&&indexMap.has(row.project)&&(!restricted(db,'daily')||daily.reportInScope(db,user,row))).map(row=>({...structuredClone(row),project:indexMap.get(row.project)}));
  if(restricted(db,'daily'))for(const row of result.projects){if(!daily.access(db,user).viewReports){delete row.progress;delete row.production;}else Object.assign(row,metrics(result,row));}
  result.workdays=(db.workdays||[]).filter(row=>days.has(row.id)&&ids.has(row.projectId)&&(!restricted(db,'daily')||daily.workdayInScope(db,user,row)));
  const assignments=new Set((workspace.assignments||[]).map(row=>row.id)),cards=new Set((workspace.timeCards||[]).map(row=>row.id));
  result.assignments=(db.assignments||[]).filter(row=>assignments.has(row.id)&&ids.has(row.projectId)&&(!restricted(db,'scheduling')||scheduling.inScope(db,user,row,'view')));
  result.projectEvents=require('./project-events-access').visible(db,user);
  result.timeCards=(db.timeCards||[]).filter(row=>cards.has(row.id)&&(!restricted(db,'timeReview')||review.cardInScope(db,user,row)));
  result.timeOffRequests=(db.timeOffRequests||[]).filter(row=>!restricted(db,'timeOff')||leave.inScope(db,user,row));
  result.team=workspace.team||[];result.changes=(db.changes||[]).filter(row=>changeVisible(db,user,row));
  const reportIds=new Set(result.reports.map(row=>row.id));result.photos=(db.photos||[]).filter(row=>indexMap.has(row.project)&&(row.reportId==null||reportIds.has(row.reportId))&&(row.changeId==null||changeVisible(db,user,one(db.changes,row.changeId,'Change')))).map(row=>({...row,project:indexMap.get(row.project)}));
  return result;
}
function validateDelta(before,after,req,url,h){
  if(!req.auth)return;
  const path=url.pathname,user=req.auth.user;
  const clean=value=>{const row={...value};delete row.rolesProviderAttempts;return row;};before=clean(before);after=clean(after);
  if(req.rolesPlainScheduling)require('./roles-scheduling-consequences').validate(before,after,user,url,req.rolesPlainScheduling);
  require('./roles-daily-baseline').validate(before,after,req,url);
  require('./project-events-access').validateDelta(before,after,user,req.rolesProjectEvent);
  if(!anyPolicy(before))return;
  const timeOperation=require('./time-write-admission').routeOperation(req.method,path);
  if(timeOperation?.kind==='cards'&&controlled(before,'daily','runWorkdays'))for(const row of after.workdays||[]){
    const prior=(before.workdays||[]).find(old=>old.id===row.id);if(canonicalHash(prior??null)===canonicalHash(row))continue;
    permit(before,user,'daily','runWorkdays');const card=one(before.timeCards,timeOperation.id,'Time card');
    if(timeOperation.action!=='correct'||card.workdayId!==row.id||!prior||!daily.workdayInScope(before,user,prior,'runWorkdays')||!daily.workdayInScope(after,user,row,'runWorkdays'))fail(403,'Current workday completion scope required');
  }
  if(timeOperation&&(controlled(before,'timeWrite',timeOperation.permission)||['correct','remove'].includes(timeOperation.action)&&restricted(before,'daily'))){
    const details=req.rolesBody||{};
    const operation={...timeOperation,details};
    require('./time-write-admission').authorize(before,user,operation,h.companyActivities);
    if(canonicalHash(before)!==canonicalHash(after)){
      require('./time-write-admission').validateDelta(before,after,user,operation);
      const changed=(after.reports||[]).filter(row=>canonicalHash(row)!==canonicalHash((before.reports||[]).find(old=>old.id===row.id)??null));
      if(changed.length){
        const sample=structuredClone(after),card=one(sample.timeCards,operation.id,'Time card'),target=h.timeCardReport(sample,card);
        if(changed.length!==1||changed[0].id!==target?.id)fail(409,'Only the original time card daily can change');
        if(restricted(before,'daily')){permit(before,user,'daily','editReports');if(!daily.reportInScope(before,user,one(before.reports,target.id,'Report'),'editReports'))fail(404,'Report not found');if(target.status==='Approved')permit(before,user,'daily','approveReports');}
      }
    }
    return;
  }
  if(req.rolesDay&&canonicalHash(before)!==canonicalHash(after))require('./daily-admission').validateDelta(before,after,user,req.rolesDay);
  const task=require('./resource-project-tasks').route(req.method,path);
  if(req.rolesTask&&task&&restricted(before,'scheduling')&&task!=='projectTasksView'&&task!=='projectTaskAssign')require('./resource-project-tasks').validate(before,after,req.rolesTask,req.auth,h,require('./resource-inputs'));
  if(req.rolesTask&&task==='projectTaskAssign'&&restricted(before,'scheduling')){
    const target=Number(path.split('/')[3]),source=one(before.projectTasks,target,'Task'),actual=one(after.projectTasks,target,'Task'),expected=structuredClone(before.projectTasks||[]);
    const changed=(after.assignments||[]).some(row=>canonicalHash(row)!==canonicalHash((before.assignments||[]).find(old=>old.id===row.id)??null));
    if(changed){if(!Number.isFinite(Date.parse(actual.assignedAt))||actual.assignedBy!==user.name)fail(409,'Task assignment metadata needs reconciliation');Object.assign(expected.find(row=>row.id===target),{memberIds:[req.rolesTask.details.memberId],assignedAt:actual.assignedAt,assignedBy:user.name});}
    if(canonicalHash(expected)!==canonicalHash(after.projectTasks)||!taskScope(before,user,source)||!taskScope(after,user,actual))fail(409,'Task assignment changed unrelated task data');
  }
  if(task&&restricted(before,'scheduling')&&before.assignments&&after.assignments){
    const old=new Map(before.assignments.map(row=>[row.id,row]));
    for(const row of after.assignments)if(!old.has(row.id)||canonicalHash(old.get(row.id))!==canonicalHash(row)){
      const action=old.has(row.id)?'edit':'create';permit(before,user,'scheduling',action);
      if(!scheduling.inScope(after,user,row,action)||old.has(row.id)&&!scheduling.inScope(before,user,old.get(row.id),action))fail(403,'Assigned source and destination project/crew required');
    }
    for(const row of before.assignments)if(!after.assignments.some(value=>value.id===row.id)){permit(before,user,'scheduling','remove');if(!scheduling.inScope(before,user,row,'remove'))fail(404,'Assignment not found');}
  }
  if(restricted(before,'scheduling')&&(path.startsWith('/api/schedule/')||/^\/api\/assignments\/[1-9]\d*\/adopt-actual-times$/.test(path))){
    const old=new Map((before.assignments||[]).map(row=>[row.id,row]));
    for(const row of after.assignments||[])if(!old.has(row.id)||canonicalHash(old.get(row.id))!==canonicalHash(row)){
      const action=old.has(row.id)?'edit':'create';permit(before,user,'scheduling',action);
      if(!workflows.assignmentScope(after,user,row)||old.has(row.id)&&!workflows.assignmentScope(before,user,old.get(row.id)))fail(403,'Assigned source and entire crew scope required');
    }
  }
  if(restricted(before,'daily')||req.rolesDay){
    const old=new Map((before.reports||[]).map(row=>[row.id,row]));
    for(const row of after.reports||[])if(!old.has(row.id)||canonicalHash(old.get(row.id))!==canonicalHash(row)){
      const action=path.startsWith('/api/workdays')||!old.has(row.id)?'createReports':path.endsWith('/approve')?'approveReports':'editReports';
      permit(before,user,'daily',action);if(old.has(row.id)&&!daily.reportInScope(before,user,old.get(row.id),action)||!daily.reportInScope(after,user,row,action))fail(403,'Resulting daily and entire crew must remain in scope');
      if(old.get(row.id)?.status==='Approved')permit(before,user,'daily','approveReports');
    }
    if(req.method==='DELETE')for(const row of before.reports||[])if(!(after.reports||[]).some(value=>value.id===row.id)){permit(before,user,'daily','editReports');if(row.status==='Approved')permit(before,user,'daily','approveReports');if(!daily.reportInScope(before,user,row,'editReports'))fail(404,'Report not found');}
    for(const row of after.workdays||[]){const prior=(before.workdays||[]).find(value=>value.id===row.id);if(!prior||canonicalHash(prior)!==canonicalHash(row)){if(path.startsWith('/api/workdays')&&!daily.workdayInScope(after,user,row,'runWorkdays'))fail(403,'Workday must remain in entire project and crew scope');}}
  }
}
module.exports={guard,projectResponse,validateDelta,readView,restricted,anyPolicy,permit,changeVisible,changeSummaries};
