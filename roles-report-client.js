'use strict';
(function(){
 const extracted=['summary','labor','quantity','issue','next','originalLanguage','englishTranslation','source','warning'];
 const fields=['project','projectId','sourceAssignmentId','dateIso','status','crew','foreman','notes','weather','temperature','materials','equipment','delays','safety','signature','summary','labor','quantity','issue','next','noteLanguage','englishTranslation','productionEntries','laborEntries','workSuggestions','templateId','templateVersion','customFields','reportType','safetyItems','safetyTalk','safetyTalkAttendees','safetyInspection','safetyIncident','noSafetyObservations','laborExclusions'];
 const text=value=>Object.fromEntries(extracted.filter(key=>typeof value?.[key]==='string').map(key=>[key,value[key]]));
 function body(raw,{status=null}={}){const report=Object.fromEntries(fields.filter(key=>Object.hasOwn(raw,key)).map(key=>[key,raw[key]]));if(status!==null)report.status=status;report.extracted=text(raw.extracted||raw);return report;}
 function plan(route,report,files,caption,tags){return JSON.stringify([route,report,Array.from(files||[],file=>[file.name,file.type,file.size,file.lastModified]),caption,tags]);}
 function form(root){return JSON.stringify(Array.from(root?.querySelectorAll('input,textarea,select')||[],node=>[node.id,node.name,node.type,node.value,node.checked,Array.from(node.files||[],file=>[file.name,file.type,file.size,file.lastModified])]));}
 const safety=report=>['reportType','safetyItems','safetyTalk','safetyTalkAttendees','safetyInspection','safetyIncident','noSafetyObservations'].some(name=>Object.hasOwn(report,name));
 function createIntakeClient({call,identity,journal,retire=()=>{}}){
  if(typeof call!=='function'||typeof identity!=='function'||!journal)throw Error('Original report recovery storage is required.');
  const fail=(operationId,status)=>Object.assign(Error('Review original report intake '+(operationId||'')+'. Read its original result before uploading or creating another report.'),{operationId,status,code:'PDL_ORIGINAL_REPORT_REVIEW'});
  const originalOperations=()=>journal.entries('report');
  async function scope(){const value=await identity();if(!['owner','admin','project_manager','foreman','field'].includes(value?.role))throw fail();return journal.identityDigest({companyId:value.companyId,actorId:value.actorId,role:value.role,sessionBinding:value.sessionBinding});}
  async function fresh(row,accept,readOnly=false){journal.assertOriginal(row,{readOnly});if(await scope()!==row.identityDigest||accept!==undefined&&(typeof accept!=='function'||accept()!==true))throw fail(row.operationId);journal.assertOriginal(row,{readOnly});}
  function check(row,value){
   if(!value||value.operationId!==row.operationId||typeof value.complete!=='boolean'||value.retryAllowed!==false||!['pending','complete','unknown','changed'].includes(value.state)||!Number.isSafeInteger(value.reportId)||value.reportId<=0)throw fail(row.operationId);
   if(row.target.resourceId!==null&&value.reportId!==row.target.resourceId)throw fail(row.operationId);
   if(value.complete&&(value.state!=='complete'||!value.report||value.report.id!==value.reportId||value.report.projectId!==row.target.projectId||!Array.isArray(value.files)))throw fail(row.operationId);
   return value;
  }
  async function recover(row,accept){try{await fresh(row,accept,true);const value=await call('/api/company/report-intakes/'+row.operationId);await fresh(row,accept,true);return check(row,value);}catch(error){retire();throw fail(row.operationId,error.status);}}
  async function recoverOriginal(operationId,options={}){const row=originalOperations().find(value=>value.operationId===operationId);if(!row){retire();throw fail(operationId);}return recover(row,options.accept);}
  async function reviewOriginal(operationId,options={}){if(options.confirmed!==true)throw fail(operationId);const row=originalOperations().find(value=>value.operationId===operationId);if(!row)throw fail(operationId);const value=await recover(row,options.accept);if(!value.complete)throw fail(operationId);try{journal.reviewed(row);}catch{try{await fresh(row,options.accept,true);}catch(error){retire();throw Object.assign(fail(operationId,error.status),{knownResult:true});}return {...value,originalHandleRetained:true};}return value;}
  async function submit(route,options={}){
   let row;
   try{
    options={...options,target:JSON.parse(JSON.stringify(options.target)),body:JSON.parse(JSON.stringify(options.body)),...(options.headers?{headers:{...options.headers}}:{})};
    const identityDigest=await scope(),intentDigest=await journal.intentDigest(JSON.stringify([route,options.body]));
    const pending=originalOperations();row=pending[0];
    if(pending.length>1||row&&(row.route!==route||row.identityDigest!==identityDigest||row.intentDigest!==intentDigest))throw fail(row?.operationId);
    if(row)return await recover(row,options.accept);
    if(options.accept!==undefined&&(typeof options.accept!=='function'||options.accept()!==true))throw fail();
    const current=await identity();if(current.companyId!==options.target.companyId||options.body?.report?.projectId!==options.target.projectId)throw fail();
    const arrived=originalOperations();if(arrived.length){row=arrived[0];if(arrived.length!==1||row.route!==route||row.identityDigest!==identityDigest||row.intentDigest!==intentDigest)throw fail(row.operationId);return await recover(row,options.accept);}
    row={version:1,operationId:crypto.randomUUID(),purpose:route==='/api/reports'?'report-create':'report-edit',route,target:options.target,identityDigest,intentDigest,createdAt:new Date().toISOString()};
    journal.remember(row);await fresh(row,options.accept);if(originalOperations().length!==1)throw fail(row.operationId);
    let value;
    try{value=await call(route,{method:row.purpose==='report-create'?'POST':'PATCH',body:JSON.stringify(options.body),headers:{...(options.headers||{}),'X-PDL-Operation':row.operationId}});}
    catch(error){try{return await recover(row,options.accept);}catch{throw fail(row.operationId,error.status);}}
    await fresh(row,options.accept);
    const completed=value?.intake||{},normalized={...value,...completed,state:completed.state,complete:completed.complete,retryAllowed:completed.retryAllowed,reportId:value?.report?.id};
    return check(row,normalized);
   }catch(error){retire();throw error;}
  }
  return {submit,originalOperations,recoverOriginal,reviewOriginal};
 }
 const value={body,text,plan,form,safety,createIntakeClient};if(typeof module!=='undefined'&&module.exports){module.exports=value;return;}window.PDLNormalReport=value;
})();
