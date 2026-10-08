'use strict';
const roles = ['admin', 'project_manager', 'foreman', 'field'];
const actions = ['view', 'create', 'edit', 'remove', 'acknowledge'];
const office = role => ['owner', 'admin', 'project_manager'].includes(role);
const known = role => role === 'owner' || roles.includes(role);
const denied = () => Object.fromEntries(actions.map(action => [action, false]));
function ceiling(role) { return { view: known(role), create: office(role), edit: office(role), remove: office(role), acknowledge: known(role) }; }
function object(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key)); }
function validatePolicy(value) {
  if (!object(value, ['version', 'revision', 'roles']) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || !object(value.roles, roles) || Object.keys(value.roles).length !== roles.length) throw Error('Invalid typed scheduling policy');
  for (const role of roles) {
    const row = value.roles[role], maximum = ceiling(role);
    if (!object(row, actions) || Object.keys(row).length !== actions.length || actions.some(action => typeof row[action] !== 'boolean' || row[action] && !maximum[action]) || !row.view && actions.slice(1).some(action => row[action])) throw Error('Invalid typed scheduling actions');
  }
  return value;
}
function required(db) { return Boolean(db.company?.schedulingPolicyRequired || db.company?.schedulingRolePolicy); }
function access(db, user) {
  if (!user || !known(user.role)) return denied();
  const baseline = ceiling(user.role);
  if (user.role === 'owner') return baseline; // Owner/security controls are immutable.
  if (user.role === 'project_manager' && user.permissions?.scheduleCrews !== true) for (const action of ['create', 'edit', 'remove']) baseline[action] = false;
  if (!required(db)) return baseline;
  try { const row = validatePolicy(db.company.schedulingRolePolicy).roles[user.role]; return Object.fromEntries(actions.map(action => [action, baseline[action] && row[action]])); }
  catch { return denied(); }
}
function actor(db, storedUser, atomic) {
  if (!storedUser) return null;
  if (required(db) && !atomic && storedUser.role !== 'owner') return null;
  if (!atomic && !required(db)) return storedUser;
  return { ...storedUser, schedulingAccess: access(db, storedUser) };
}
function inScope(db, user, assignment, action) {
  if (!access(db, user)[action] || !assignment || !(db.projects || []).some(row => Number(row.id) === Number(assignment.projectId))) return false;
  const ids = assignment.memberIds;
  if (!Array.isArray(ids) || !ids.length || ids.some(id => !Number.isSafeInteger(id) || !(db.team || []).some(member => Number(member.id) === id))) return false;
  if (action === 'acknowledge') return Number.isSafeInteger(user.memberId) && ids.includes(user.memberId);
  if (['foreman', 'field'].includes(user.role)) return action === 'view' && ids.includes(Number(user.memberId));
  if (user.role !== 'project_manager') return true;
  const crews = new Set((user.assignedCrews || []).map(name => String(name).trim().toLowerCase()).filter(Boolean));
  const permitted = new Set((db.team || []).filter(member => crews.has(String(member.crew || '').trim().toLowerCase())).map(member => Number(member.id)));
  return (user.projectIds || []).map(Number).includes(Number(assignment.projectId)) && (action === 'view' ? ids.some(id => permitted.has(id)) : ids.every(id => permitted.has(id)));
}
function visibleAssignments(db, user) {
  return (db.assignments || []).filter(row => inScope(db, user, row, 'view')).map(row => {
    const ids = ['owner', 'admin'].includes(user.role) ? row.memberIds : row.memberIds.filter(id => user.role === 'project_manager' ? inScope(db, user, { ...row, memberIds: [id] }, 'view') : id === user.memberId);
    return { id: row.id, projectId: row.projectId, memberIds: ids, date: row.date, start: row.start, end: row.end, activity: row.activity, ...(row.instructions ? { instructions: row.instructions } : {}), acknowledgements: Object.fromEntries(Object.entries(row.acknowledgements || {}).filter(([id]) => ids.includes(Number(id)))), notifications: Object.fromEntries(Object.entries(row.notifications || {}).filter(([id]) => ids.includes(Number(id))).map(([id, value]) => [id, { inAppAt: value.inAppAt, emailStatus: value.emailStatus }])) };
  });
}
module.exports = { roles, actions, ceiling, validatePolicy, required, access, actor, inScope, visibleAssignments };
