'use strict';
const {validateAccounts}=require('./account-evidence');
function validate(db){
  validateAccounts(db);
  const bad=()=>{throw Object.assign(Error('Company security records need reconciliation.'),{statusCode:503,code:'PDL_ROLES_EVIDENCE'});};
  for(const name of ['team','projects','crews','reports','workdays','assignments','timeCards','photos']){
    const rows=db[name]||[],ids=new Set();if(!Array.isArray(rows))bad();
    for(const row of rows){if(!row||!Number.isSafeInteger(row.id)||row.id<1||ids.has(row.id)||row.companyId!==undefined&&row.companyId!==db.company.id)bad();ids.add(row.id);}
  }
  for(const user of db.users){
    if(user.memberId!=null&&!(db.team||[]).some(row=>row.id===user.memberId))bad();
    if((user.projectIds||[]).some(id=>!(db.projects||[]).some(row=>row.id===id)))bad();
  }
  const text=value=>typeof value==='string'&&value.length<=500&&!/[\u0000-\u001f]/.test(value);
  const memberIds=value=>Array.isArray(value)&&value.every(id=>Number.isSafeInteger(id)&&id>0&&(db.team||[]).some(row=>row.id===id))&&new Set(value).size===value.length;
  for(const row of db.team||[])if(!text(row.name)||row.crew!=null&&!text(row.crew))bad();
  for(const row of db.crews||[])if(!text(row.name)||row.memberIds!==undefined&&!memberIds(row.memberIds))bad();
  for(const row of db.assignments||[])if(!memberIds(row.memberIds)||!Number.isSafeInteger(row.projectId)||!(db.projects||[]).some(project=>project.id===row.projectId)||row.crew!=null&&!text(row.crew))bad();
  for(const row of db.workdays||[])if(!memberIds(row.memberIds)||!Number.isSafeInteger(row.projectId)||!(db.projects||[]).some(project=>project.id===row.projectId))bad();
  return db;
}
module.exports={validate};
