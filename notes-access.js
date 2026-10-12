'use strict';
const profiles = require('./role-profiles');
const { validDate } = require('./schedule-availability');
const roles = Object.freeze(['admin', 'project_manager', 'foreman', 'field']);
const actions = Object.freeze(['view', 'create', 'edit', 'complete']);
const known = role => role === 'owner' || roles.includes(role);
const ceiling = role => Object.fromEntries(actions.map(action => [action, known(role)]));
const object = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const fail = (statusCode, message) => { throw Object.assign(Error(message), { statusCode }); };
const identity = id => String(id ?? '').trim();
function unique(rows, id, name) {
  const matches = (rows || []).filter(row => identity(row.id) === identity(id));
  if (!identity(id) || matches.length !== 1) fail(matches.length ? 409 : 404, name + ' identity needs reconciliation');
  return matches[0];
}
const numericId = id => typeof id === 'number' ? Number.isSafeInteger(id) && id > 0 : typeof id === 'string' && /^[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id)) && String(Number(id)) === id;
function uniqueNumeric(rows, id, name, companyId) {
  if (!numericId(id)) fail(409, name + ' identity needs reconciliation');
  const matches = (rows || []).filter(row => Number(row.id) === Number(id));
  if (matches.length !== 1 || matches.some(row => !numericId(row.id) || row.companyId != null && row.companyId !== companyId)) fail(matches.length ? 409 : 404, name + ' identity needs reconciliation');
  return matches[0];
}
function validatePolicy(policy) {
  if (!object(policy, ['version', 'revision', 'roles']) || policy.version !== 1 || !Number.isSafeInteger(policy.revision) || policy.revision < 1 || !object(policy.roles, roles) || Object.keys(policy.roles).length !== roles.length) throw Error('Invalid typed notes policy');
  for (const role of roles) {
    const row = policy.roles[role];
    if (!object(row, actions) || Object.keys(row).length !== actions.length || actions.some(action => typeof row[action] !== 'boolean') || !row.view && actions.slice(1).some(action => row[action])) throw Error('Invalid notes actions');
  }
  return policy;
}
const required = db => Boolean(db.company?.notesPolicyRequired || Object.hasOwn(db.company || {}, 'notesRolePolicy') || (db.users || []).some(user => user.notesPolicyRequired || user.notesCustomRoleId != null));
function roleAccess(db, user) {
  const baseline = ceiling(user?.role);
  if (!known(user?.role) || user.role === 'owner' || !required(db)) return baseline;
  try { if (user.notesCustomRoleId != null) throw Error('Unreconciled profile'); const row = validatePolicy(db.company.notesRolePolicy).roles[user.role]; return Object.fromEntries(actions.map(action => [action, baseline[action] && row[action]])); }
  catch { return ceiling(null); }
}
function access(db, user) { return profiles.restrict(db, user, 'notes', roleAccess(db, user)); }
function actor(db, user, atomic) {
  if (!user || (required(db) || profiles.required(db)) && !atomic && user.role !== 'owner') return null;
  if (!atomic && !required(db) && !profiles.required(db)) return user;
  let revision = 0; try { if (required(db)) revision = validatePolicy(db.company.notesRolePolicy).revision; } catch { revision = -1; }
  return { ...user, notesPermissions: access(db, user), notesPolicyRevision: revision };
}
function projectAllowed(db, user, projectId, baselineProjectAllowed) {
  uniqueNumeric(db.projects, projectId, 'Project', db.company.id);
  if (!known(user?.role)) return false;
  if (['owner', 'admin'].includes(user.role)) return true;
  if (user.role === 'project_manager') return (user.projectIds || []).map(Number).includes(Number(projectId)) && baselineProjectAllowed(db, user, Number(projectId));
  const member = uniqueNumeric(db.team, user.memberId, 'Linked member', db.company.id);
  for (const [rows, projectFor, members] of [[db.assignments || [], row => row.projectId, row => row.memberIds || []], [db.workdays || [], row => row.projectId, row => row.memberIds || []], [db.reports || [], row => db.projects?.[row.project]?.id, row => (row.laborEntries || []).map(entry => entry.memberId)]]) {
    for (const row of rows.filter(row => Number(projectFor(row)) === Number(projectId))) {
      uniqueNumeric(rows, row.id, 'Project scope record', db.company.id);
      if (!numericId(projectFor(row))) fail(409, 'Project scope binding needs reconciliation');
      for (const memberId of members(row)) uniqueNumeric(db.team, memberId, 'Project scope member', db.company.id);
    }
  }
  // No-policy behavior uses the original field project projection, including
  // existing crew/team visibility. Policy-on scope must be supported by IDs.
  if (!baselineProjectAllowed(db, user, Number(projectId))) return false;
  if (!required(db)) return true;
  const eligible = (rows, members, projectFor) => rows.some(row => {
    if (Number(projectFor(row)) !== Number(projectId) || !members(row).map(Number).includes(Number(user.memberId))) return false;
    uniqueNumeric(rows, row.id, 'Project scope record', db.company.id);
    for (const memberId of members(row)) uniqueNumeric(db.team, memberId, 'Project scope member', db.company.id);
    return true;
  });
  return eligible(db.assignments || [], row => row.memberIds || [], row => row.projectId) || eligible(db.workdays || [], row => row.memberIds || [], row => row.projectId) || eligible(db.reports || [], row => (row.laborEntries || []).map(entry => entry.memberId), row => db.projects?.[row.project]?.id);
}
function validateAssistantProject(db, projectId) {
  const project = uniqueNumeric(db.projects, projectId, 'Project', db.company.id);
  if (typeof project.name !== 'string' || project.name.length > 5000) fail(409, 'Assistant project needs reconciliation');
  return project;
}
function validateActor(user) {
  if (!numericId(user?.id) || typeof user.name !== 'string' || !user.name.trim() || user.name.length > 5000 || /[\u0000-\u001f\u007f]/.test(user.name)) fail(409, 'Note actor needs reconciliation');
}
function validateRows(db, projectId) {
  const stringId = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
  const actorId = value => numericId(value);
  const content = value => value && typeof value.text === 'string' && value.text.length <= 5000 && typeof value.completed === 'boolean' && Number.isSafeInteger(value.revision) && value.revision >= 1 && (!Object.hasOwn(value, 'dueDate') || value.dueDate === null || validDate(value.dueDate));
  for (const row of (db.projectNotesTodos || []).filter(row => row.companyId === db.company.id && Number(row.projectId) === Number(projectId))) {
    unique(db.projectNotesTodos, row.id, 'Note');
    if (!stringId(row.id) || !numericId(row.projectId) || row.companyId !== db.company.id || !actorId(row.createdByUserId) || !actorId(row.updatedByUserId) || typeof row.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(row.requestId) || !['note', 'todo'].includes(row.kind) || !content(row) || row.revision >= Number.MAX_SAFE_INTEGER || ['createdBy', 'updatedBy', 'createdAt', 'updatedAt'].some(key => typeof row[key] !== 'string') || !Array.isArray(row.history) || row.history.some(entry => !entry || !actorId(entry.userId) || typeof entry.action !== 'string' || typeof entry.by !== 'string' || typeof entry.at !== 'string' || entry.before !== null && !content(entry.before) || !content(entry.after))) fail(409, 'Note state needs reconciliation');
  }
}
function validateReceipt(db, receipt, user, projectId, proof) {
  unique(db.assistantConfirmations, receipt.id, 'Assistant receipt');
  const row = unique(db.projectNotesTodos, receipt.itemId, 'Assistant note');
  if (typeof receipt.id !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(receipt.id) || receipt.companyId !== db.company.id || receipt.userId !== user.id || receipt.projectId !== projectId || receipt.tokenHash !== proof.tokenHash || receipt.version !== proof.version || !['note', 'todo'].includes(receipt.resourceKind) || row.companyId !== db.company.id || row.projectId !== projectId || row.kind !== receipt.resourceKind || row.createdByUserId !== user.id || row.requestId !== 'assistant-' + receipt.id || typeof receipt.itemId !== 'string') fail(409, 'Assistant note receipt needs reconciliation');
  validateRows(db, projectId);
}
module.exports = { roles, actions, ceiling, validatePolicy, required, access, actor, unique, uniqueNumeric, numericId, validateAssistantProject, validateActor, validateReceipt, projectAllowed, validateRows };
