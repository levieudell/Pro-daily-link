'use strict';
const leave = require('./time-off-access');
const roles = Object.freeze(['admin', 'project_manager', 'foreman', 'field']);
const actions = Object.freeze(['viewCards', 'reviewLeave', 'approveCards', 'unapproveCards']);
const office = role => ['owner', 'admin', 'project_manager'].includes(role);
const known = role => role === 'owner' || roles.includes(role);
const denied = () => Object.fromEntries(actions.map(action => [action, false]));
function ceiling(role) { return { viewCards: known(role), reviewLeave: office(role), approveCards: office(role), unapproveCards: office(role) }; }
const object = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
function validatePolicy(value) {
  if (!object(value, ['version', 'revision', 'roles']) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || !object(value.roles, roles) || Object.keys(value.roles).length !== roles.length) throw Error('Invalid typed time-review policy');
  for (const role of roles) {
    const row = value.roles[role], maximum = ceiling(role);
    if (!object(row, actions) || Object.keys(row).length !== actions.length || actions.some(action => typeof row[action] !== 'boolean' || row[action] && !maximum[action]) || (row.approveCards || row.unapproveCards) && !row.viewCards) throw Error('Invalid time-review actions');
  }
  return value;
}
function required(db) { return Boolean(db.company?.timeReviewPolicyRequired || db.company?.timeReviewRolePolicy); }
function access(db, user) {
  if (!user || !known(user.role)) return denied();
  const maximum = ceiling(user.role), manage = user.role === 'owner' || office(user.role) && user.permissions?.manageTime === true;
  const baseline = { viewCards: user.role === 'owner' || ['field', 'foreman'].includes(user.role) || manage || user.role === 'project_manager' && user.permissions?.viewTime === true, reviewLeave: manage && leave.access(db, user).viewRequests, approveCards: manage, unapproveCards: manage };
  if (user.role !== 'owner' && required(db)) {
    try { const row = validatePolicy(db.company.timeReviewRolePolicy).roles[user.role]; for (const action of actions) baseline[action] = baseline[action] && maximum[action] && row[action]; }
    catch { return denied(); }
  }
  if (db.company?.features?.timeCards !== true) for (const action of ['viewCards', 'approveCards', 'unapproveCards']) baseline[action] = false;
  return baseline;
}
function actor(db, user, atomic) {
  if (!user || required(db) && !atomic && user.role !== 'owner') return null;
  return !atomic && !required(db) ? user : { ...user, timeReviewAccess: access(db, user) };
}
function crewAllowed(db, user, memberId) {
  const member = (db.team || []).find(row => Number(row.id) === Number(memberId));
  if (!member) return false;
  const crews = new Set((user.assignedCrews || []).map(name => String(name).trim().toLowerCase()).filter(Boolean));
  return crews.has(String(member.crew || '').trim().toLowerCase());
}
function cardInScope(db, user, card, action = 'viewCards') {
  if (!access(db, user)[action] || !card || card.deletedAt || !(db.team || []).some(row => Number(row.id) === Number(card.memberId))) return false;
  if (['owner', 'admin'].includes(user.role)) return true;
  if (user.role === 'project_manager') return (user.projectIds || []).map(Number).includes(Number(card.projectId)) && (db.projects || []).some(row => Number(row.id) === Number(card.projectId)) && crewAllowed(db, user, card.memberId);
  if (action !== 'viewCards') return false;
  const self = (db.team || []).find(row => Number(row.id) === Number(user.memberId));
  if (!self) return false;
  return user.role === 'field' ? Number(card.memberId) === Number(self.id) : user.role === 'foreman' && (db.team || []).some(row => Number(row.id) === Number(card.memberId) && row.crew === self.crew);
}
function leaveInScope(db, user, row) { return access(db, user).reviewLeave && leave.inScope(db, user, row); }
module.exports = { roles, actions, ceiling, validatePolicy, required, access, actor, cardInScope, leaveInScope };
