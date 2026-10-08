'use strict';
const review = require('./time-review-access');
const roles = Object.freeze(['admin', 'project_manager', 'foreman', 'field']);
const actions = Object.freeze(['createCards', 'correctCards', 'removeCards', 'submitCards', 'clockCards', 'downloadCards', 'viewPayroll', 'configurePeriods', 'captureExports', 'downloadExports', 'viewActivities']);
const office = role => ['owner', 'admin', 'project_manager'].includes(role);
const own = role => ['field', 'foreman'].includes(role);
const known = role => role === 'owner' || roles.includes(role);
const denied = () => Object.fromEntries(actions.map(action => [action, false]));
function ceiling(role) {
  return { createCards: office(role), correctCards: known(role), removeCards: office(role), submitCards: known(role), clockCards: own(role), downloadCards: office(role), viewPayroll: office(role), configurePeriods: ['owner', 'admin'].includes(role), captureExports: ['owner', 'admin'].includes(role), downloadExports: ['owner', 'admin'].includes(role), viewActivities: known(role) };
}
const object = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
function validatePolicy(value) {
  if (!object(value, ['version', 'revision', 'roles']) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || !object(value.roles, roles) || Object.keys(value.roles).length !== roles.length) throw Error('Invalid typed time-writer policy');
  for (const role of roles) {
    const row = value.roles[role], maximum = ceiling(role);
    if (!object(row, actions) || Object.keys(row).length !== actions.length || actions.some(action => typeof row[action] !== 'boolean' || row[action] && !maximum[action]) || ['configurePeriods', 'captureExports', 'downloadExports'].some(action => row[action] && !row.viewPayroll)) throw Error('Invalid time-writer actions');
  }
  return value;
}
function required(db) { return Boolean(db.company?.timeWritePolicyRequired || db.company?.timeWriteRolePolicy); }
function access(db, user) {
  if (!user || !known(user.role) || db.company?.features?.timeCards !== true) return denied();
  const maximum = ceiling(user.role), manage = user.role === 'owner' || office(user.role) && user.permissions?.manageTime === true, view = review.access(db, user).viewCards;
  const result = { ...maximum, createCards: manage && view, correctCards: (manage || own(user.role)) && view, removeCards: manage && view, submitCards: (manage || own(user.role)) && view, clockCards: own(user.role) && view, downloadCards: office(user.role) && view, viewPayroll: office(user.role) && view, configurePeriods: maximum.configurePeriods && manage && view, captureExports: maximum.captureExports && manage && view, downloadExports: maximum.downloadExports && manage && view };
  if (user.role !== 'owner' && required(db)) {
    try { const row = validatePolicy(db.company.timeWriteRolePolicy).roles[user.role]; for (const action of actions) result[action] = result[action] && row[action]; }
    catch { return denied(); }
  }
  return result;
}
function actor(db, user, atomic) {
  if (!user || required(db) && !atomic && user.role !== 'owner') return null;
  return !atomic && !required(db) ? user : { ...user, timeWriteAccess: access(db, user) };
}
function inScope(db, user, row, action) {
  if (!access(db, user)[action]) return false;
  if (own(user.role)) return Number(user.memberId) === Number(row?.memberId) && (db.team || []).some(member => Number(member.id) === Number(user.memberId));
  return review.cardInScope(db, user, row);
}
module.exports = { roles, actions, ceiling, validatePolicy, required, access, actor, inScope };
