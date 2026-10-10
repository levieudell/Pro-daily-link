'use strict';
// The newer scheduling workflows have their own inherited route baselines.
// Typed masks restrict those baselines; they never grant manageTime/viewTime
// or replace the existing controllers used by cards, leave review and dailies.
const registry = require('./capability-registry');
const profiles = require('./role-profiles');
const scheduling = require('./scheduling-access');
const { canonicalHash } = require('./database/transactional-repository');
const actions = Object.freeze(['liveToday', 'markOff', 'repeatWeek', 'adoptActual']);
function restriction(db, original, family, action) {
  const user=registry.normalize(original), entry=registry.families.find(row=>row[0]===family);
  if(!entry || !entry[4].actions.includes(action))return false;
  const [, , prefix, , controller]=entry;
  if(!user || user.status!=='Active' || user.companyId!=null&&user.companyId!==db.company.id || !['owner',...registry.roles].includes(user.role))return false;
  if(user.role==='owner')return true;
  try {
    return profiles.evaluate(db,()=>{
      let row=controller.ceiling(user.role);
      if(controller.required(db)) {
        const policy=controller.validatePolicy(db.company[prefix+'RolePolicy']).roles[user.role];
        row=Object.fromEntries(controller.actions.map(key=>[key,row[key]&&policy[key]]));
      }
      return profiles.restrict(db,user,family,row)[action]===true;
    });
  } catch { return false; }
}
function eligible(db, original) {
  const user=registry.normalize(original), office=user?.status==='Active'&&['owner','admin','project_manager'].includes(user.role)&&!(user.companyId!=null&&user.companyId!==db.company.id);
  const schedule=office&&(user.role!=='project_manager'||user.permissions?.scheduleCrews===true);
  const allows=(family,action)=>office&&restriction(db,user,family,action);
  const masks=allows('scheduling','view');
  return {
    liveToday:Boolean(masks&&allows('daily','viewWorkdays')&&allows('timeReview','viewCards')&&allows('timeOff','viewRequests')),
    markOff:Boolean(schedule&&masks&&allows('timeOff','viewRequests')&&allows('timeReview','reviewLeave')),
    repeatWeek:Boolean(schedule&&masks&&scheduling.access(db,user).create),
    adoptActual:Boolean(schedule&&masks&&scheduling.access(db,user).edit&&allows('daily','viewWorkdays'))
  };
}
function assignmentScope(db, user, row) {
  if(!row || !(db.projects||[]).some(project=>project.id===row.projectId) || !Array.isArray(row.memberIds)||!row.memberIds.length || new Set(row.memberIds).size!==row.memberIds.length || row.memberIds.some(id=>!Number.isSafeInteger(id)||!(db.team||[]).some(member=>member.id===id)))return false;
  if(!['owner','admin','project_manager'].includes(user?.role))return false;
  if(user.role!=='project_manager')return true;
  const crews=new Set((user.assignedCrews||[]).map(name=>String(name).trim().toLowerCase()));
  return Array.isArray(user.projectIds||[])&&(user.projectIds||[]).every(require('./notes-access').numericId)&&(user.projectIds||[]).map(Number).includes(row.projectId)&&row.memberIds.every(id=>crews.has(String(db.team.find(member=>member.id===id).crew||'').trim().toLowerCase()));
}
function memberScope(db,user,memberId) {
  const member=(db.team||[]).find(row=>row.id===memberId);
  return Boolean(member&&['owner','admin','project_manager'].includes(user?.role)&&(user.role!=='project_manager'||(user.assignedCrews||[]).some(name=>String(name).trim().toLowerCase()===String(member.crew||'').trim().toLowerCase())));
}
function sourceView(db,user,workday) {
  // A shared workday's times are evidence for each participating person. PM
  // source views retain the existing any-assigned-member read ceiling.
  return Boolean(workday&&(db.projects||[]).some(row=>row.id===workday.projectId)&&Array.isArray(workday.memberIds)&&workday.memberIds.length&&workday.memberIds.every(id=>Number.isSafeInteger(id)&&(db.team||[]).some(row=>row.id===id))&&['owner','admin','project_manager'].includes(user?.role)&&(user.role!=='project_manager'||Array.isArray(user.projectIds||[])&&(user.projectIds||[]).every(require('./notes-access').numericId)&&(user.projectIds||[]).map(Number).includes(workday.projectId)&&workday.memberIds.some(id=>memberScope(db,user,id))));
}
function authority(db,auth) {
  return canonicalHash({actor:require('./compat-workspace-delivery').actorBinding(db,auth),workflows:eligible(db,auth.user),restrictions:Object.fromEntries(registry.families.map(([id,,, ,module])=>[id,Object.fromEntries(module.actions.map(action=>[action,restriction(db,auth.user,id,action)]))]))});
}
module.exports={actions,restriction,eligible,assignmentScope,memberScope,sourceView,authority};
