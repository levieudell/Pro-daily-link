'use strict';
const profiles = require('./role-profiles');
const roles = Object.freeze(['admin', 'project_manager', 'foreman', 'field']);
const actions = Object.freeze(['viewRequests', 'createRequest']);
const known = role => role === 'owner' || roles.includes(role);
const own = role => ['field', 'foreman'].includes(role);
const denied = () => ({ viewRequests: false, createRequest: false });
function ceiling(role) { return { viewRequests: known(role), createRequest: own(role) }; }
const object = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
function validatePolicy(value) {
  if (!object(value, ['version', 'revision', 'roles']) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || !object(value.roles, roles) || Object.keys(value.roles).length !== roles.length) throw Error('Invalid typed private time-off policy');
  for (const role of roles) {
    const row = value.roles[role], maximum = ceiling(role);
    if (!object(row, actions) || Object.keys(row).length !== actions.length || actions.some(action => typeof row[action] !== 'boolean' || row[action] && !maximum[action]) || row.createRequest && !row.viewRequests) throw Error('Invalid time-off request actions');
  }
  return value;
}
function required(db) { return Boolean(db.company?.timeOffPolicyRequired || Object.hasOwn(db.company || {}, 'timeOffRolePolicy')); }
function roleAccess(db, user) {
  if (!user || !known(user.role)) return denied();
  const baseline = ceiling(user.role);
  if (user.role === 'owner') return baseline;
  if (user.role === 'admin') baseline.viewRequests = user.permissions?.manageTime === true;
  if (user.role === 'project_manager') baseline.viewRequests = user.permissions?.manageTime === true || user.permissions?.viewTime === true;
  if (!required(db)) return baseline;
  try { const row = validatePolicy(db.company.timeOffRolePolicy).roles[user.role]; return Object.fromEntries(actions.map(action => [action, baseline[action] && row[action]])); }
  catch { return denied(); }
}
function access(db, user) { return profiles.restrict(db, user, 'timeOff', roleAccess(db, user)); }
function actor(db, user, atomic) {
  if (!user || (required(db) || profiles.required(db)) && !atomic && user.role !== 'owner') return null;
  return !atomic && !required(db) && !profiles.required(db) ? user : { ...user, timeOffAccess: access(db, user) };
}
function inScope(db, user, row, action = 'viewRequests') {
  if (!access(db, user)[action] || !row || !Number.isSafeInteger(row.memberId) || !(db.team || []).some(member => member.id === row.memberId)) return false;
  if (own(user.role)) return Number.isSafeInteger(user.memberId) && user.memberId === row.memberId;
  if (action !== 'viewRequests') return false;
  if (user.role !== 'project_manager') return ['owner', 'admin'].includes(user.role);
  const crews = new Set((user.assignedCrews || []).map(name => String(name).trim().toLowerCase()).filter(Boolean));
  return (db.team || []).some(member => member.id === row.memberId && crews.has(String(member.crew || '').trim().toLowerCase()));
}
function present(row) {
  const keys = ['id', 'memberId', 'startDate', 'endDate', 'allDay', 'startTime', 'endTime', 'type', 'note', 'status', 'requestedAt', 'reviewNote', 'reviewedAt', 'reviewedBy'];
  return { ...Object.fromEntries(keys.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])), history: (Array.isArray(row.history) ? row.history : []).filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry)).map(entry => Object.fromEntries(['action', 'by', 'at', 'note'].filter(key => Object.hasOwn(entry, key)).map(key => [key, entry[key]]))) };
}
function visible(db, user) { return (db.timeOffRequests || []).filter(row => inScope(db, user, row)).map(present); }
module.exports = { roles, actions, ceiling, validatePolicy, required, access, actor, inScope, present, visible };
