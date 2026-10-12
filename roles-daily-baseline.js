'use strict';
// Fixed daily project/crew ownership remains in force before optional masks.
const daily=require('./daily-access');
const fail=(statusCode,message)=>{throw Object.assign(Error(message),{statusCode});};
const reportRoute=path=>/^\/api\/reports(?:\/([1-9]\d*)(?:\/(approve|disposition|safety|rate))?)?$/.exec(path);
const one=(rows,id,label)=>{const found=(rows||[]).filter(row=>row.id===Number(id));if(found.length!==1)fail(found.length?409:404,label+' not found');return found[0];};
function report(db,user,row,action){if(!daily.reportInScope(db,user,row,action))fail(404,'Report not found');if(action!=='viewReports'&&row.status==='Approved'&&!daily.access(db,user).approveReports)fail(403,'Current approval permission required to correct approved work');}
function details(db,user,input){const projectId=input.projectId??db.projects?.[Number(input.project)]?.id;if(!daily.projectAllowed(db,user,projectId)||(input.laborEntries||[]).some(row=>!daily.memberAllowed(db,user,row.memberId)))fail(403,'Assigned daily project and entire crew required');}
async function guard(req,url,db,h){
 const path=url.pathname,method=req.method,user=req.auth.user,match=reportRoute(path);
 if(match){
  const action=method==='GET'?'viewReports':match[2]==='approve'?'approveReports':method==='POST'&&!match[1]?'createReports':'editReports';
  if(!daily.access(db,user)[action])fail(403,'Current daily permission required');
  if(match[1])report(db,user,one(db.reports,match[1],'Report'),action);
  if(['POST','PATCH'].includes(method)){
   const input=await h.body(req);req.rolesBody=input;
   if(!match[1])details(db,user,input);
   if(input.status==='Approved'&&!daily.access(db,user).approveReports)fail(403,'Current approval permission required');
  }
 }
 const day=/^\/api\/workdays(?:\/([1-9]\d*)(?:\/(end))?|\/(start))?$/.exec(path);
 if(day){const action=method==='GET'?'viewWorkdays':'runWorkdays';if(!daily.access(db,user)[action])fail(403,'Current workday permission required');if(day[1]&&!daily.workdayInScope(db,user,one(db.workdays,day[1],'Workday'),action))fail(404,'Workday not found');if(day[3]){const input=await h.body(req);if(!daily.projectAllowed(db,user,input.projectId)||(input.memberIds||[]).some(id=>!daily.memberAllowed(db,user,id)))fail(403,'Assigned workday project and entire crew required');}}
 if(path==='/api/ai/extract'&&method==='POST'){if(!daily.access(db,user).createReports)fail(403,'Current daily creation permission required');const input=await h.body(req);if(!daily.projectAllowed(db,user,input.projectId))fail(404,'Project not found');}
 if(path==='/api/photos'&&method==='POST'||/^\/api\/photos\/[1-9]\d*$/.test(path)&&method==='PATCH'){
  const input=await h.body(req),old=method==='PATCH'?one(db.photos,path.split('/')[3],'Photo'):null;
  if(!daily.access(db,user)[method==='POST'?'createReports':'editReports'])fail(403,'Current daily photo permission required');
  for(const row of [old,{...old,...input}].filter(Boolean)){
   const projectId=row.projectId??db.projects?.[Number(row.project)]?.id;if(!daily.projectAllowed(db,user,projectId))fail(404,'Photo project not found');
   if(row.reportId!=null){const source=one(db.reports,row.reportId,'Report');if(db.projects[source.project]?.id!==projectId)fail(404,'Report not found');report(db,user,source,'editReports');}
   if(row.workdayId!=null&&!daily.workdayInScope(db,user,one(db.workdays,row.workdayId,'Workday'),'runWorkdays'))fail(404,'Workday not found');
  }
 }
}
function validate(before,after,req,url){
 const match=reportRoute(url.pathname);if(!match||req.method==='GET')return;
 const user=req.auth.user,action=match[2]==='approve'?'approveReports':req.method==='POST'&&!match[1]?'createReports':'editReports';
 for(const row of after.reports||[]){const old=(before.reports||[]).find(value=>value.id===row.id);if(require('./database/transactional-repository').canonicalHash(old??null)===require('./database/transactional-repository').canonicalHash(row))continue;
  if(old)report(before,user,old,action);report(after,user,row,action);
  if(row.status==='Approved'&&!daily.access(before,user).approveReports)fail(403,'Current approval permission required');
 }
}
module.exports={guard,validate};
