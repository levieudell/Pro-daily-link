'use strict';
const time = require('./time-write-access');
const roles = Object.freeze(['admin', 'project_manager', 'foreman', 'field']);
const actions = Object.freeze(['viewReports', 'createReports', 'editReports', 'approveReports', 'viewWorkdays', 'runWorkdays']);
const known = role => role === 'owner' || roles.includes(role);
const field = user => ['field', 'foreman'].includes(user?.role);
const object = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
function ceiling(role) { return { viewReports: known(role), createReports: known(role), editReports: known(role), approveReports: ['owner', 'admin', 'project_manager'].includes(role), viewWorkdays: known(role), runWorkdays: known(role) }; }
function validatePolicy(policy) {
  if (!object(policy, ['version', 'revision', 'roles']) || policy.version !== 1 || !Number.isSafeInteger(policy.revision) || policy.revision < 1 || !object(policy.roles, roles) || Object.keys(policy.roles).length !== roles.length) throw Error('Invalid typed daily policy');
  for (const role of roles) { const row = policy.roles[role], maximum = ceiling(role); if (!object(row, actions) || Object.keys(row).length !== actions.length || actions.some(action => typeof row[action] !== 'boolean' || row[action] && !maximum[action]) || (row.createReports || row.editReports || row.approveReports) && !row.viewReports || row.runWorkdays && (!row.viewWorkdays || !row.createReports)) throw Error('Invalid daily actions'); }
  return policy;
}
const required = db => Boolean(db.company?.dailyPolicyRequired || Object.hasOwn(db.company || {}, 'dailyRolePolicy'));
function access(db, user) {
  const denied = () => Object.fromEntries(actions.map(action => [action, false]));
  if (!user || !known(user.role)) return denied();
  const view = user.role !== 'project_manager' || user.permissions?.viewDailies === true || user.permissions?.approveDailies === true;
  const result = { ...ceiling(user.role), viewReports: view, createReports: view, editReports: view, approveReports: user.role === 'owner' || user.role === 'admin' || user.role === 'project_manager' && user.permissions?.approveDailies === true, viewWorkdays: view, runWorkdays: view };
  if (db.company?.features?.timeCards === true) { const cards = time.access(db, user); result.runWorkdays &&= field(user) ? cards.clockCards : cards.createCards && cards.correctCards; }
  if (user.role !== 'owner' && required(db)) {
    try { const row = validatePolicy(db.company.dailyRolePolicy).roles[user.role]; for (const action of actions) result[action] &&= row[action]; } catch { return denied(); }
  }
  return result;
}
function actor(db, user, atomic) { return !user || required(db) && !atomic && user.role !== 'owner' ? null : !atomic && !required(db) ? user : { ...user, dailyAccess: access(db, user) }; }
function memberAllowed(db, user, id) {
  const member = (db.team || []).find(row => Number(row.id) === Number(id)); if (!member) return false;
  if (['owner', 'admin'].includes(user.role)) return true;
  if (user.role === 'project_manager') return (user.assignedCrews || []).some(crew => String(crew).trim().toLowerCase() === String(member.crew || '').trim().toLowerCase());
  const self = field(user) && (db.team || []).find(row => Number(row.id) === Number(user.memberId)); return Boolean(self && self.crew === member.crew);
}
function projectAllowed(db, user, id) {
  if (!(db.projects || []).some(project => Number(project.id) === Number(id))) return false;
  if (['owner', 'admin'].includes(user.role)) return true;
  if (user.role === 'project_manager') return (user.projectIds || []).map(Number).includes(Number(id));
  if (!field(user) || !(db.team || []).some(member => Number(member.id) === Number(user.memberId))) return false;
  return (db.assignments || []).some(row => Number(row.projectId) === Number(id) && (row.memberIds || []).map(Number).includes(Number(user.memberId))) || (db.workdays || []).some(row => Number(row.projectId) === Number(id) && (row.memberIds || []).map(Number).includes(Number(user.memberId))) || (db.reports || []).some(row => Number(db.projects?.[Number(row.project)]?.id) === Number(id) && ((row.laborEntries || []).some(entry => Number(entry.memberId) === Number(user.memberId)) || row.foreman === user.name));
}
function reportInScope(db, user, report, action = 'viewReports') {
  if (!access(db, user)[action] || !report || !projectAllowed(db, user, db.projects?.[report.project]?.id) || !(report.laborEntries || []).every(entry => memberAllowed(db, user, entry.memberId))) return false;
  if (field(user)) return (report.laborEntries || []).some(entry => Number(entry.memberId) === Number(user.memberId)) || report.foreman === user.name;
  return true;
}
function workdayInScope(db, user, row, action = 'viewWorkdays') { return Boolean(access(db, user)[action] && row && projectAllowed(db, user, row.projectId) && Array.isArray(row.memberIds) && row.memberIds.length && row.memberIds.every(id => memberAllowed(db, user, id)) && (!field(user) || row.memberIds.map(Number).includes(Number(user.memberId)))); }
module.exports = { roles, actions, field, ceiling, validatePolicy, required, access, actor, memberAllowed, projectAllowed, reportInScope, workdayInScope };
