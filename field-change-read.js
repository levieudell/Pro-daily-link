'use strict';
// Fixed Field/Foreman flagged-work read. This is not an editable capability.
// Existing name-attributed history is retained only for an unambiguous current
// account name; it is not immutable historical author custody.
const fail=(statusCode,message)=>{throw Object.assign(Error(message),{statusCode});};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const statuses=new Set(['Potential','Pricing','Submitted','Approved','Rejected','Void','T&M']);
function mine(db,user,helpers){
  if(!object(user)||!positive(user.id)||user.status!=='Active'||!['field','foreman'].includes(user.role))fail(403,'A current field account is required.');
  if(!object(db?.company)||user.companyId!==undefined&&user.companyId!==db.company.id)fail(404,'Company workspace not found.');
  const current=(db.users||[]).filter(row=>row.id===user.id);
  if(current.length!==1||current[0].status!=='Active'||current[0].role!==user.role||current[0].name!==user.name||current[0].memberId!==user.memberId)fail(403,'Current field account changed.');
  if(!positive(user.memberId)||(db.team||[]).filter(row=>row.id===user.memberId).length!==1||typeof user.name!=='string'||!user.name.trim()||user.name.length>500)fail(409,'Field account identity needs reconciliation.');
  if(typeof helpers?.canAccessProject!=='function')fail(503,'Current project scope is required.');
  const rows=db.changes===undefined?[]:db.changes;
  if(!Array.isArray(rows)||rows.length>50000)fail(409,'Flagged work source needs reconciliation.');
  const ids=new Set(),out=[];
  for(const row of rows){
    if(!object(row)||!positive(row.id)||ids.has(row.id)||!positive(row.projectId)||row.companyId!==undefined&&row.companyId!==db.company.id||(db.projects||[]).filter(project=>project.id===row.projectId).length!==1)fail(409,'Flagged work identity needs reconciliation.');
    ids.add(row.id);
    if(row.fieldFlag!==undefined&&typeof row.fieldFlag!=='boolean')fail(409,'Flagged work source needs reconciliation.');
    if(row.fieldFlag!==true)continue;
    if(typeof row.createdBy!=='string'||!row.createdBy.trim()||row.createdBy.length>500)fail(409,'Flagged work author needs reconciliation.');
    if(Object.hasOwn(row,'createdById')&&!positive(row.createdById))fail(409,'Flagged work author needs reconciliation.');
    if(row.createdBy!==user.name||Object.hasOwn(row,'createdById')&&row.createdById!==user.id)continue;
    if((db.users||[]).filter(account=>account.name===user.name).length!==1)fail(409,'Legacy flagged work author is ambiguous.');
    if(!helpers.canAccessProject(db,user,row.projectId)||!require('./roles-production-guards').changeVisible(db,user,row))continue;
    if(typeof row.number!=='string'||row.number.length>80||typeof row.title!=='string'||row.title.length>300||!statuses.has(row.status)||typeof row.createdAt!=='string'||row.createdAt.length>80||row.flagDate!=null&&(typeof row.flagDate!=='string'||row.flagDate.length>80))fail(409,'Flagged work summary needs reconciliation.');
    out.push({id:row.id,number:row.number,title:row.title,status:row.status,flagDate:row.flagDate||null,createdAt:row.createdAt});
  }
  return out;
}
module.exports={mine};
